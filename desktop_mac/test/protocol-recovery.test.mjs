import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {WorkPlanner} from '../dist/orchestration/work-plan.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-protocol-'));const store=new LocalStore(dir);await store.init();
const discovered=['codex','qoder-cn','claude-code'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
const agents=await store.syncDiscoveredAgents(discovered);const [leader,q,cc]=discovered.map(d=>agents.find(a=>a.kind===d.kind));
const base={store,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}};
const ok=message=>({ok:true,threadId:'session',message,steps:[],metrics:{iterations:1,sideEffects:false}});
const control=c=>ok(JSON.stringify({control:c}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(s){for(let i=0;i<300;i++){if(!s.runtimeSnapshot().agents.length){await sleep(10);if(!s.runtimeSnapshot().agents.length)return;}await sleep(5);}throw Error('did not settle');}
const work={id:'inspect',assignment:'检查输入',candidates:[q.userId],dependsOn:[],outputs:[],acceptance:'提供核对证据',readOnly:true};
try {
 for(const recover of [false,true]) {
  const conversation=await store.createConversation({name:'接单恢复',memberIds:agents.map(a=>a.userId),leaderId:leader.userId});
  let qTurns=0,executions=0,reassigned=false,leaderSawBlocked=false;
  const s=new LocalScheduler({idleRetryLimit:0,...base,registry:{cancel:()=>true,runTurn:async(d,input)=>{
   const t=await store.getConversation(conversation.conversationId);const user=agents.find(a=>a.kind===d.kind);
   const c=(await store.listMessages(conversation.conversationId,{limit:1000})).filter(m=>m.coordination?.assigneeId===user.userId).at(-1)?.coordination;
   if(user===leader){
    if(!t.workPlan?.length)return control({action:'plan',work:[work]});
    if(t.workPlan[0].status==='blocked'&&!reassigned){leaderSawBlocked=true;reassigned=true;return control({action:'plan',work:[{...work,candidates:[cc.userId]}]});}
    if(t.workPlan[0].status==='review')return control({action:'review',workId:'inspect',verdict:'pass',evidence:'实际证据已确认'});
    return ok('SKIP');
   }
   if(user===q)qTurns++;
   if(c?.phase==='proposal'){
    assert.equal(input.discussionOnly,true);assert.equal(input.timeoutMs,undefined,'assignment proposal has no time limit');
    if(user===q&&(!recover||qTurns===1))return ok('<image><path>/fixture/input.jpg</path></image>');
    return control({action:'accept',assignmentId:c.id});
   }
   if(c?.phase==='accepted'){executions++;assert.equal(input.discussionOnly,false);return ok('报告：输入已核对，附证据');}
   return ok('SKIP');
  }}});
  await s.runAgentTurn(conversation,leader);await settle(s);
  assert.equal(executions,1,'executes only once after truly accepting the assignment');assert.equal(qTurns,recover?3:2);
  assert.equal(leaderSawBlocked,!recover);assert.equal((await store.getConversation(conversation.conversationId)).workPlan[0].status,'done');
  const messages=await store.listMessages(conversation.conversationId,{limit:1000});assert.ok(messages.some(m=>m.content.includes('<image>')),'keeps the raw reply for clarification but must not treat it as a tool call');
 }
 const conversation=await store.createConversation({name:'业务受阻不验收',memberIds:[leader.userId,cc.userId],leaderId:leader.userId});
 const s=new LocalScheduler({idleRetryLimit:0,...base,registry:{runTurn:async(d)=>{
  const t=await store.getConversation(conversation.conversationId);if(d.kind==='codex')return !t.workPlan?.length?control({action:'plan',work:[{...work,candidates:[cc.userId]}]}):ok('SKIP');
  const c=(await store.listMessages(conversation.conversationId,{limit:1000})).filter(m=>m.coordination?.assigneeId===cc.userId).at(-1).coordination;
  return control(c.phase==='proposal'?{action:'accept',assignmentId:c.id}:{action:'blocked',assignmentId:c.id,reason:'输入文件不存在'});
 }}});
 await s.runAgentTurn(conversation,leader);await settle(s);assert.equal((await store.getConversation(conversation.conversationId)).workPlan[0].status,'blocked');
 // Review retry must be followed by an explicit updated plan, never unchanged re-execution.
 const planner=new WorkPlanner({store,available:()=>true,busy:()=>false,deliver:async()=>{},log:async()=>{}});
 const t=await store.getConversation(conversation.conversationId);await store.updateConversation(t.conversationId,{workPlan:[{...t.workPlan[0],status:'review'}]});
 await planner.review(t.conversationId,'inspect','retry','需要换人接手');await planner.fill(t.conversationId);
 assert.equal((await store.getConversation(t.conversationId)).workPlan[0].status,'blocked');
 // Natural assent executes once; a real question reaches the leader immediately, who revises and asks again.
 for (const question of [false,true]) {
  const conversation=await store.createConversation({name:'自然语言协商',memberIds:agents.map(a=>a.userId),leaderId:leader.userId});
  let workerTurns=0,executions=0,discussed=false;
  const raw='我需要先确认一个关键能力问题再决定。\n<tool-_calls><tool><tool_name>file</tool_name></tool></tool-_calls>';
  const s=new LocalScheduler({idleRetryLimit:0,...base,registry:{runTurn:async(d,input)=>{
   const t=await store.getConversation(conversation.conversationId);
   if(d.kind===leader.kind){
    if(!t.workPlan?.length)return control({action:'plan',work:[work]});
    if(t.workPlan[0].status==='blocked'&&!discussed){
     discussed=true;assert.ok(input.prompt.includes(raw),'leader receives the original question');
     return control({action:'plan',work:[{...work,assignment:'先做一次有工具的只读输入检查，确认能力后报告'}]});
    }
    if(t.workPlan[0].status==='review')return control({action:'review',workId:'inspect',verdict:'pass',evidence:'检查证据'});
    return ok('SKIP');
   }
   workerTurns++;
   const c=(await store.listMessages(conversation.conversationId,{limit:1000})).filter(m=>m.coordination?.assigneeId===q.userId).at(-1)?.coordination;
   if(c?.phase==='proposal')return ok(question&&workerTurns===1?raw:'同意，我按这个方案执行。');
   if(c?.phase==='accepted'){executions++;assert.equal(input.discussionOnly,false);return ok('输入检查报告及证据');}
   return ok('SKIP');
  }}});
  await s.runAgentTurn(conversation,leader);await settle(s);
  assert.equal(executions,1);assert.equal(workerTurns,question?3:2);assert.equal(discussed,question);
  assert.equal((await store.getConversation(conversation.conversationId)).workPlan[0].status,'done');
  const ms=await store.listMessages(conversation.conversationId,{limit:1000});assert.ok(!ms.some(m=>m.content.includes('协议失败')));
 }
 console.log('protocol-recovery: bounded repair, missing accept blocks/notifies/reassigns, successful repair, blocked receipt, review retry passed');
}catch(error){console.error("protocol assertion",error);throw error;}finally{await store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
