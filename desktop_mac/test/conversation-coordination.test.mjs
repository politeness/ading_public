import {readyGroup} from './ready-group.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStore } from '../dist/store/local.js';
import { LocalScheduler } from '../dist/orchestration/local-scheduler.js';

const directory = await mkdtemp(path.join(tmpdir(), 'ading-coordination-'));
const store = new LocalStore(directory);
await store.init();
const discovered = ['codex','claude-code','qoder','qoder-cn'].map((kind, i) => ({kind,localUuid:`mock-${i}`,executablePath:'/mock/unused',version:'test'}));
const agents = await store.syncDiscoveredAgents(discovered);
const [leader,worker,unavailable,reviewer] = discovered.map(d => agents.find(a=>a.localUuid===d.localUuid));
const me = await store.currentUser();
const offline = new Set([unavailable.userId]);
const calls = [];
let conversation;
let completed = false;
let workerExecuting = false;
let overlap = false;
let leaderTurns = 0;
let deliver;
const workGate = new Promise(resolve=>{deliver=resolve});
const scheduler = new LocalScheduler({idleRetryLimit:0,
  store, syncer:{ensureSynced:async()=>[]}, resolveWorkspace:async()=>({workspacePath:directory,sharesKnowledge:false}),
  resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.localUuid===d.localUuid)?.userId===id),
  isAgentReady:agent=>!offline.has(agent.userId), broadcast:()=>{}, log:async()=>{},
  registry:{cancel:()=>true, runTurn:async(d,input)=>{
    const agent = agents.find(a=>a.localUuid===d.localUuid);
    calls.push({id:agent.userId,fullAccess:input.fullAccess,prompt:input.prompt});
    assert.ok(calls.length<25,'Scheduling must not loop unboundedly');
    let message='SKIP';
    if(agent.userId===leader.userId){
      leaderTurns++;
      if(leaderTurns===1) message=JSON.stringify({control:{action:'assign',assignments:[{to:worker.userId,assignment:'产出独立文件，并验证格式'},{to:unavailable.userId,assignment:'不应派发'}]}});
      else if(!completed){
        for(let i=0;i<200&&!workerExecuting;i++)await new Promise(r=>setTimeout(r,5));
        overlap=workerExecuting;
        deliver();
        message='我已完成自己负责的检查，等待产物复核。';
      }
    } else if(agent.userId===worker.userId){
      const messages=await store.listMessages(conversation.conversationId,{limit:100});
      const assignment=messages.filter(m=>m.coordination?.assigneeId===worker.userId).at(-1)?.coordination;
      if(assignment?.phase==='proposal'){
        assert.equal(input.fullAccess,false,'No execution permission before agreement');
        message=JSON.stringify({control:{action:'accept',assignmentId:assignment.id}});
      } else {
        assert.equal(assignment?.phase,'accepted');
        assert.equal(input.fullAccess,true);
        workerExecuting=true;
        await workGate;
        completed=true;
        message='产物已写入 output.txt，格式检查通过，请 review。';
      }
    }
    return {ok:true,message,steps:['模拟验证'],metrics:{iterations:1,sideEffects:false}};
  }}
});
try {
  conversation=await readyGroup(store,{name:'执行验证',memberIds:agents.map(a=>a.userId),leaderId:leader.userId,charter:{goal:'交付'}});
  assert.equal(conversation.members.find(m=>m.role==='LEADER').userId,leader.userId);
  const incoming=await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'start',senderId:me.userId,content:'开始'});
  assert.deepEqual(new Set((await scheduler.pickTargets(conversation,incoming)).map(a=>a.userId)),new Set([leader.userId,worker.userId,reviewer.userId]),'human input reaches every available group member');
  assert.equal((await scheduler.pickTargets(conversation,incoming)).length,3);
  await scheduler.runAgentTurn(conversation,leader);
  for(let i=0;i<1000;i++){
    if(completed&&scheduler.runtimeSnapshot().agents.length===0)break;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.ok(completed,'Executes after accepting and returns a result');
  assert.ok(overlap,'leader\'s own work overlaps with worker execution');
  assert.ok(!calls.some(c=>c.id===unavailable.userId),'Unavailable Agent never starts');
  assert.ok(!calls.some(c=>c.id===reviewer.userId&&c.fullAccess),'Unassigned members can read the conversation but cannot execute work');
  const messages=await store.listMessages(conversation.conversationId,{limit:100});
  assert.deepEqual(messages.filter(m=>m.coordination?.assigneeId===worker.userId).map(m=>m.coordination.phase),['proposal','accepted','result']);
  assert.ok(messages.some(m=>m.content.includes('分工未派发')));
  assert.ok(messages.filter(m=>m.coordination).every(m=>m.type==='TASK'));
  assert.ok(messages.some(m=>m.coordination?.phase==='result'&&m.steps?.includes('模拟验证')));
  assert.ok(calls[0].prompt.includes('剩余配额：未知'));
  const before=calls.length;
  await scheduler.stopConversation(conversation.conversationId);
  await store.setConversationPaused(conversation.conversationId,true);
  await scheduler.updateConversation(conversation.conversationId,{charter:{...conversation.charter,instructions:'优先节约 token'}});
  assert.equal(calls.length,before,'Editing instructions of a paused task must not start work automatically');
  assert.ok((await store.listMessages(conversation.conversationId,{limit:1}))[0].content.includes('优先节约 token'));
  const negotiationConversation=await readyGroup(store,{name:'异议与新方案',memberIds:[leader.userId,reviewer.userId],leaderId:leader.userId});
  const negotiation=new LocalScheduler({idleRetryLimit:0,store,registry:{cancel:()=>true},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:directory,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.localUuid===d.localUuid)?.userId===id),isAgentReady:a=>!offline.has(a.userId),broadcast:()=>{},log:async()=>{}});
  const delivered=[];
  negotiation.dispatch=async(t,m)=>{delivered.push(...(await negotiation.pickTargets(t,m)).map(a=>a.userId));};
  await negotiation.applyLeaderControl(negotiationConversation,leader,JSON.stringify({control:{action:'assign',to:reviewer.userId,assignment:'原方案'}}),null);
  let plan=(await store.listMessages(negotiationConversation.conversationId)).at(-1).coordination;
  assert.equal(plan.phase,'proposal');
  await negotiation.applyLeaderControl(negotiationConversation,reviewer,JSON.stringify({control:{action:'revise',assignmentId:plan.id,reason:'先验证样张再批量处理'}}),null);
  assert.equal((await store.listMessages(negotiationConversation.conversationId)).at(-1).coordination.phase,'revision');
  assert.equal(delivered.at(-1),leader.userId,'Objection delivered to leader');
  await negotiation.applyLeaderControl(negotiationConversation,leader,JSON.stringify({control:{action:'assign',to:reviewer.userId,assignment:'同意，先验证样张'}}),null);
  const revised=(await store.listMessages(negotiationConversation.conversationId)).at(-1).coordination;
  assert.notEqual(revised.id,plan.id);
  const deliveriesBeforeStale=delivered.length;
  assert.equal(await negotiation.applyLeaderControl(negotiationConversation,reviewer,JSON.stringify({control:{action:'accept',assignmentId:plan.id}}),null),'');
  assert.equal((await negotiation.assignmentFor(negotiationConversation.conversationId,reviewer.userId)).phase,'proposal','A late confirmation of the old plan must not start the new plan');
  assert.equal(delivered.length,deliveriesBeforeStale,'Stale acceptance only leaves an audit record and must not wake the Leader');
  assert.ok((await store.listMessages(negotiationConversation.conversationId)).some(m=>m.internal&&m.content.includes('接单未生效')&&!m.coordination));
  offline.add(reviewer.userId);
  await negotiation.pauseUnavailableAgents('qoder-cn');
  assert.equal((await negotiation.assignmentFor(negotiationConversation.conversationId,reviewer.userId)).phase,'rejected','Becoming unavailable while awaiting acceptance also revokes the assignment and notifies');
  offline.delete(reviewer.userId);
  await assert.rejects(()=>scheduler.createConversation({name:'错误 leader',memberIds:[leader.userId,unavailable.userId],leaderId:unavailable.userId}),/当前不可用/);
  const autoConversation=await readyGroup(store,{name:'讨论产品创意',memberIds:[leader.userId,worker.userId,reviewer.userId],leaderId:leader.userId,charter:{goal:'一起讨论产品创意'}});
  const autoMessage=await store.appendMessage({conversationId:autoConversation.conversationId,clientMessageId:'automatic-routing',senderId:me.userId,content:'一起想想更好的方案'});
  assert.equal((await negotiation.pickTargets(autoConversation,autoMessage)).length,3,'human input is available to every member');
  const charterBefore=(await store.getConversation(autoConversation.conversationId)).charter;
  for(const speaker of [worker,leader])for(const mode of ['discussion','execution']) {
    await negotiation.applyLeaderControl(autoConversation,speaker,JSON.stringify({control:{action:'organize',mode}}),null);
    assert.deepEqual((await store.getConversation(autoConversation.conversationId)).charter,charterBefore,'obsolete organize controls cannot change the conversation');
  }
  await negotiation.updateConversation(autoConversation.conversationId,{charter:{...charterBefore,instructions:'请继续'}});
  assert.equal((await store.getConversation(autoConversation.conversationId)).charter.instructions,'请继续','supported user instructions still update');
  await store.setMemberPaused(conversation.conversationId,reviewer.userId,true);
  const beforeShutdown=JSON.stringify(await store.listConversations());
  await scheduler.shutdown();
  assert.equal(JSON.stringify(await store.listConversations()),beforeShutdown,'Exiting only cancels execution and does not modify tasks or member toggles');
  console.log('conversation-coordination: routing, negotiation, overlap, rejection, updates and shutdown passed');
} finally {deliver();await store.close();await rm(directory,{recursive:true,force:true});}
