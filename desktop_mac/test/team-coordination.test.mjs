import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';
import {shouldDispatchRemoteAgentMessage,shouldDispatchRemoteUserMessage} from '../dist/orchestration/message-delivery.js';
import {TEAM_RELAY_PREFIX} from '../dist/orchestration/team.js';
import {isTeamRelayMessage} from '../dist/ui/message-visibility.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,what='condition'){for(let i=0;i<1500;i++){if(await fn())return;await sleep(5);}throw Error('timeout: '+what);}
const ok=message=>({ok:true,message,steps:[],metrics:{iterations:1,sideEffects:false}});
const ctl=c=>JSON.stringify({control:c});

/** One computer: its own store, its own Agents, its own scheduler. */
async function computer(name,kinds,handler){
 const dir=await mkdtemp(path.join(os.tmpdir(),`ading-team-${name}-`));
 const store=new LocalStore(path.join(dir,'data'));await store.init();
 const discovered=kinds.map(kind=>({kind,localUuid:`${name}-${kind}`,executablePath:'/mock'}));
 const found=await store.syncDiscoveredAgents(discovered);
 const agents=discovered.map(d=>found.find(a=>a.kind===d.kind));
 const calls=[],events=[];
 const node={name,dir,store,agents,calls,events};
 const registry={adapterFor:()=>({supportsParallelWork:true}),runTurn:async(d,input)=>{const phase=input.prompt.match(/当前是分工前共同讨论阶段：(\w+)/)?.[1];const call={d,input,phase};calls.push(call);return handler(call,node);},cancel:()=>true};
 node.scheduler=new ConversationScheduler({store,registry,idleRetryLimit:0,teamMonitorIntervalMs:0,concurrentInbox:true,brainstormTimeoutMs:2000,relayCheckMs:20,strandedWorkGraceMs:40,
  resolveDiscovered:id=>discovered.find(d=>found.find(a=>a.kind===d.kind)?.userId===id),
  isAgentReady:a=>a.remote?a.remote.online&&a.remote.readiness==='ready':true,
  syncer:{ensureSynced:async()=>[]},
  resolveWorkspace:async conversation=>{const workspacePath=path.join(dir,conversation.conversationId);await mkdir(workspacePath,{recursive:true});return{workspacePath,sharesKnowledge:false};},
  broadcast:()=>{},log:async(event,details)=>events.push({event,...details}),requestPermission:async()=>true});
 node.close=async()=>{await node.scheduler.shutdown();await store.close();await rm(dir,{recursive:true,force:true});};
 return node;
}
/** Make each computer know the other's Agents as remote, as the cloud does. */
async function link(a,b,online={a:true,b:true}){
 const remote=(node,isOnline)=>node.agents.map(agent=>({...agent,remote:{computerId:node.name,computerName:node.name,online:isOnline,readiness:'ready'}}));
 await a.store.syncRemoteAgents(remote(b,online.b));await b.store.syncRemoteAgents(remote(a,online.a));
}
/** A tiny cloud: copies messages both ways, delivers them like main.ts, and copies the coordinator's shared task state. */
function bridge(a,b,conversationId,coordinator){
 const seen=new Set();let stopped=false;
 const copy=async(from,to)=>{
  for(const m of await from.store.listMessages(conversationId,{limit:1000})){
   if(seen.has(m.messageId))continue;seen.add(m.messageId);
   if(await to.store.hasMessage(conversationId,m.messageId))continue;
   const copied=await to.store.appendMessage({conversationId,clientMessageId:m.messageId,senderId:m.senderId,content:m.content,type:m.type,mentions:m.mentions,internal:m.internal,agentReply:m.agentReply,coordination:m.coordination,steps:m.steps,report:m.report,failed:m.failed});
   const sender=await to.store.getUser(m.senderId);
   if(shouldDispatchRemoteUserMessage(copied,sender))await to.scheduler.receiveRemoteUserMessage(copied);
   else if(shouldDispatchRemoteAgentMessage(copied,sender))await to.scheduler.receiveRemoteAgentMessage(copied);
  }
 };
 const loop=(async()=>{while(!stopped){
  const lead=coordinator(),other=lead===a?b:a;
  const c=await lead.store.getConversation(conversationId);
  if(c)await other.store.updateConversation(conversationId,{brainstorm:c.brainstorm,workPlan:c.workPlan,charter:c.charter});
  await copy(a,b);await copy(b,a);await sleep(5);
 }})();
 return async()=>{stopped=true;await loop;};
}
const latestFor=async(node,conversationId,agentId)=>(await node.store.listMessages(conversationId,{limit:1000})).filter(m=>m.coordination?.assigneeId===agentId).at(-1)?.coordination;

// 1. Leader online: the Leader's computer coordinates every online Agent, including those on the other computer.
{
 let workerId;
 const A=await computer('A',['codex','claude-code'],async(c,node)=>{
  if(c.phase==='synthesize')return ok(ctl({action:'plan',work:[{id:'W1',assignment:'按讨论的方法算出结果并汇报',candidates:[workerId],dependsOn:[],outputs:[],acceptance:'结果写在回复里',readOnly:true}]}));
  if(c.phase)return ok(`${c.d.kind} 的独立意见：先核对输入。`);
  return ok(ctl({action:'stop',reason:'已收到结果'}));
 });
 const B=await computer('B',['qoder-cn'],async(c,node)=>{
  if(c.phase)return ok('B 的独立意见：用方法X，首个验证是小样。');
  const current=await latestFor(node,c.input.workspacePath.split(path.sep).at(-1),workerId);
  if(current?.phase==='proposal')return ok(ctl({action:'accept',assignmentId:current.id,reason:'按方法X执行'}));
  return ok('W1 已完成，结果是 42。');
 });
 workerId=B.agents[0].userId;
 let stop;
 try{
  await link(A,B);
  const t=await A.scheduler.createConversation({name:'跨电脑',memberIds:[...A.agents.map(a=>a.userId),workerId],leaderId:A.agents[0].userId,initialMessage:'算出结果并汇报'});
  await B.store.importConversation(await A.store.getConversation(t.conversationId));
  stop=bridge(A,B,t.conversationId,()=>A);
  await until(()=>B.calls.some(c=>c.phase==='ideas'),'remote Agent takes part in the discussion');
  assert.ok(!A.calls.some(c=>c.d.kind==='qoder-cn'),'the coordinating computer never runs the other computer\'s Agent');
  await until(async()=>(await A.store.getConversation(t.conversationId)).workPlan?.[0]?.status==='review','remote result reaches the shared queue');
  const a=await A.store.getConversation(t.conversationId);
  assert.equal(a.workPlan[0].assigneeId,workerId,'work is assigned to the online Agent on the other computer');
  assert.ok(B.calls.some(c=>!c.phase&&c.input.prompt.includes('W1')),'the other computer runs the work');
  await until(()=>A.calls.some(c=>!c.phase&&c.d.kind==='codex'),'Leader reviews the remote result');
  assert.ok([...A.calls,...B.calls].every(c=>!c.input.prompt.includes(TEAM_RELAY_PREFIX)),'relay messages never reach prompts');
  assert.ok(A.calls.find(c=>c.phase==='synthesize').input.prompt.includes('在另一台电脑「B」上'),'the Leader knows which members are on another computer');
  const relays=(await A.store.listMessages(t.conversationId,{limit:1000})).filter(m=>m.content.startsWith(TEAM_RELAY_PREFIX));
  assert.ok(relays.length>=2&&relays.every(m=>m.internal&&isTeamRelayMessage(m)),'discussion requests and answers are hidden');
  assert.ok(!(await A.store.listMessages(t.conversationId,{limit:1000})).some(m=>m.content.includes('Leader当前不可用')));
 }finally{await stop?.();await A.close();await B.close();}
}

// 2. Leader offline: the remaining Agents carry on, coordinated by the first available one, instead of waiting.
{
 const A=await computer('A',['codex'],async()=>ok('不应调用'));
 const B=await computer('B',['qoder-cn','claude-code'],async c=>{
  if(c.phase==='synthesize')return ok('结论已汇总。'+ctl({action:'stop',reason:'讨论完成'}));
  return ok(`${c.d.kind} 的意见。`);
 });
 try{
  await link(A,B);
  const t=await B.scheduler.createConversation({name:'Leader离线',memberIds:[A.agents[0].userId,...B.agents.map(a=>a.userId)],leaderId:A.agents[0].userId,initialMessage:'讨论一下方案'});
  await sleep(60);
  assert.equal(B.calls.length,0,'while the Leader is online its computer coordinates');
  assert.equal((await B.store.getConversation(t.conversationId)).brainstorm,undefined);
  await link(A,B,{a:false,b:true});
  await B.scheduler.teamAvailabilityChanged();
  await until(async()=>(await B.store.getConversation(t.conversationId)).status!=='ACTIVE'||(await B.store.getConversation(t.conversationId)).brainstorm?.phase==='ready','stand-in Leader finishes the discussion');
  const acting=[...B.agents.map(a=>a.userId)].sort()[0];
  const synth=B.calls.find(c=>c.phase==='synthesize');
  assert.equal(B.agents.find(a=>a.userId===acting).kind,synth.d.kind,'the first available member by id stands in');
  assert.ok(!(await B.store.listMessages(t.conversationId)).some(m=>m.content.includes('Leader当前不可用')),'no waiting for the offline Leader');
  assert.equal(A.calls.length,0);
  const stored=await B.store.getConversation(t.conversationId);
  assert.equal(stored.members.find(m=>m.userId===A.agents[0].userId).role,'LEADER','the Leader setting itself is unchanged');
 }finally{await A.close();await B.close();}
}

// 3. Work held by an Agent whose computer goes offline is released so the team can reassign it.
{
 const A=await computer('A',['codex'],async()=>ok('收到，重新安排。'));
 const B=await computer('B',['qoder-cn'],async()=>ok('ok'));
 try{
  await link(A,B);
  const worker=B.agents[0].userId,leader=A.agents[0].userId;
  const t=await A.store.createConversation({name:'收回',memberIds:[leader,worker],leaderId:leader});
  await A.store.updateConversation(t.conversationId,{brainstorm:{phase:'ready',round:1,revision:1,probes:0,attempts:0,leaderId:leader,inputSeq:0,participants:[],responses:{},turnDurationsMs:{},evidenceReady:true},
   workPlan:[{id:'W1',assignment:'做',candidates:[worker],dependsOn:[],outputs:[],acceptance:'回复',readOnly:true,status:'active',assigneeId:worker,assignmentId:'as1',startedAt:new Date().toISOString()}]});
  await A.store.appendMessage({conversationId:t.conversationId,clientMessageId:'as1-msg',senderId:leader,type:'TASK',mentions:[worker],content:'开始 W1',coordination:{id:'as1',workId:'W1',assigneeId:worker,phase:'accepted',brief:'做'}});
  await A.scheduler.teamAvailabilityChanged();
  await sleep(80);
  assert.equal((await A.store.getConversation(t.conversationId)).workPlan[0].status,'active','an online worker keeps its work');
  await link(A,B,{a:true,b:false});
  await A.scheduler.teamAvailabilityChanged();
  await until(async()=>(await A.store.getConversation(t.conversationId)).workPlan[0].status==='blocked','stranded work is released after the grace period');
  await until(async()=>(await A.store.listMessages(t.conversationId)).some(m=>m.coordination?.phase==='rejected'),'release notice');const notice=(await A.store.listMessages(t.conversationId)).find(m=>m.coordination?.phase==='rejected');
  assert.equal(notice.coordination.phase,'rejected');assert.deepEqual(notice.mentions,[leader]);
  // The worker's computer, on receiving the release, does not change the shared queue itself.
  assert.equal(shouldDispatchRemoteAgentMessage(notice,{...A.agents[0],remote:{computerId:'A',computerName:'A',online:true,readiness:'ready'}}),true);
 }finally{await A.close();await B.close();}
}

// Ordinary chatter from another computer's Agent is shown, not handed to local Agents.
const remoteAgent={userId:'x',isAgent:true,remote:{computerId:'c',computerName:'c',online:true,readiness:'ready'}};
assert.equal(shouldDispatchRemoteAgentMessage({type:'USER',content:'hi',mentions:[]},remoteAgent),false);
assert.equal(shouldDispatchRemoteAgentMessage({type:'USER',content:'hi',mentions:['y']},remoteAgent),true);
assert.equal(shouldDispatchRemoteAgentMessage({type:'USER',content:'hi',mentions:['y']},{...remoteAgent,remote:undefined}),false);
console.log('team coordination: cross-computer discussion and work, stand-in Leader, stranded work release passed');
