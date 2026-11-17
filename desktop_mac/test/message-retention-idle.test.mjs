import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-retention-idle-'));
const store=new LocalStore(dir);await store.init();
const discovered=['codex','claude-code','qoder-cn'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
const agents=await store.syncDiscoveredAgents(discovered),[leader,a,b]=discovered.map(d=>agents.find(a=>a.kind===d.kind));
const me=await store.currentUser();
const base={store,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}};
const ok=message=>({ok:true,message,steps:[],metrics:{iterations:1,sideEffects:false}}),ctl=c=>ok(JSON.stringify({control:c}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(s){for(let i=0;i<1200;i++){if(!s.runtimeSnapshot().agents.length&&!s.idleChecks.size){await sleep(20);if(!s.runtimeSnapshot().agents.length&&!s.idleChecks.size)return;}await sleep(5);}throw Error('did not settle');}
async function conversation(name){return store.createConversation({name,memberIds:agents.map(a=>a.userId),leaderId:leader.userId,charter:{mode:'execution'}});}
const work={id:'inspect',assignment:'读取输入并交报告',candidates:[a.userId],dependsOn:[],outputs:[],acceptance:'对照输入的证据',readOnly:true};
try {
 // Reproduce the real dropped question and dropped review, with a peer result arriving during generation.
 for(const kind of ['question','review','stale-review','plan']) {
  const t=await conversation(kind);let calls=0;
  await store.appendMessage({conversationId:t.conversationId,clientMessageId:'start-'+kind,senderId:me.userId,content:'开始'});
  if(kind.includes('review'))await store.updateConversation(t.conversationId,{workPlan:[{...work,status:'review',assignmentId:'old',completedAt:'before'}]});
  const reply=kind==='question'?'样张没有通过。是否允许改用程序处理？':kind==='plan'?'我准备按旧要求派工。\n'+JSON.stringify({control:{action:'plan',work:[work]}}):'报告不通过，保留此复核意见。\n'+JSON.stringify({control:{action:'review',workId:'inspect',verdict:'retry',evidence:'坐标切入题干'}});
  const s=new LocalScheduler({...base,idleRetryLimit:0,registry:{runTurn:async()=>{
   if(++calls===1){
    if(kind==='stale-review')await store.updateConversation(t.conversationId,{workPlan:[{...work,status:'review',assignmentId:'new',completedAt:'after'}]});
    await store.appendMessage({conversationId:t.conversationId,clientMessageId:'peer-'+kind,senderId:b.userId,content:'另一个独立核查结果'});
    return ok(reply);
   }
   assert.ok((await store.listMessages(t.conversationId)).some(m=>m.agentReply?.raw===reply),'original reply is persisted before rethinking');
   return ok('已结合最新结果核对。');
  }}});
  await s.runAgentTurn(t,leader);await settle(s);assert.equal(calls,2);
  const messages=await store.listMessages(t.conversationId),retained=messages.find(m=>m.agentReply?.raw===reply);
  assert.ok(retained&&retained.agentReply.newerInput);assert.equal(retained.agentReply.inputSeq,1);
  const current=await store.getConversation(t.conversationId);
  if(kind==='review')assert.equal(current.workPlan[0].status,'blocked','an independent review must not be swallowed by other new messages');
  if(kind==='stale-review')assert.equal(current.workPlan[0].status,'review','a stale review must not affect a new delivery');
  if(kind==='plan')assert.ok(!current.workPlan?.length,'old plan not executed but its body is kept');
 }
 // Failure to apply control must not remove the actual question/answer.
 const invalid=await conversation('控制拒绝保留正文');
 const bad=new LocalScheduler({...base,idleRetryLimit:0,registry:{runTurn:async()=>ok('请确认这个问题。\n'+JSON.stringify({control:{action:'review',workId:'missing',verdict:'retry',evidence:'不存在的项'}}))}});
  await bad.runAgentTurn(invalid,leader);assert.ok((await store.listMessages(invalid.conversationId)).some(m=>m.content==='请确认这个问题。'));
 // Control-only replies stay durable without fabricating participant speech.
 for (const prose of ['', '招呼已回复，我们先聊到这里。']) {
  const t=await conversation('控制与正文分离');
  const raw=prose+'\n'+JSON.stringify({control:{action:'stop',reason:'暂无新需求'}});
  const scheduler=new LocalScheduler({...base,idleRetryLimit:0,registry:{cancel:()=>true,runTurn:async()=>ok(raw)}});
  await scheduler.runAgentTurn(t,leader);await settle(scheduler);
  const receipt=(await store.listMessages(t.conversationId)).find(m=>m.agentReply?.raw===raw);
  assert.ok(receipt,'raw control is still persisted');
  assert.equal(!!receipt.internal,!prose,'only a pure control block is an internal record; real body text goes straight into chat');
  if(prose)assert.ok((await store.listMessages(t.conversationId)).some(m=>!m.internal&&m.content===prose),'real body text is published after a successful stop');
  if(prose)assert.equal(receipt.content,prose,'real body text is kept verbatim');
  if(prose)assert.equal((await store.listMessages(t.conversationId)).filter(m=>!m.internal&&m.content===prose).length,1,'final body text is published only once');
 }
 // Persisted group stop survives readiness changes and unresolved work after a restart.
 {
  const t=await conversation('停止后重启');
  await store.updateConversation(t.conversationId,{workPlan:[{...work,status:'blocked'}]});
  const root=new LocalScheduler({...base,registry:{cancel:()=>true,runTurn:async()=>ok('SKIP')}});
  await root.stopConversation(t.conversationId);
  const reopened=new LocalStore(dir);await reopened.init();
  const list=reopened.listConversations.bind(reopened);
  reopened.listConversations=async()=> (await list()).filter(c=>c.conversationId===t.conversationId);
  let calls=0,ready=false;
  const restarted=new LocalScheduler({...base,store:reopened,isAgentReady:()=>ready,registry:{cancel:()=>true,runTurn:async()=>{calls++;return ctl({action:'stop',reason:'完成'});}}});
  try {
   await restarted.teamAvailabilityChanged(true);ready=true;
   await restarted.teamAvailabilityChanged();
   await restarted.followUpIdleConversation(t.conversationId);await settle(restarted);
   assert.equal(calls,0,'an Agent becoming available after startup must not revive a stopped work plan');
   assert.equal((await reopened.getConversation(t.conversationId)).paused,true);
   await restarted.resumeConversation(t.conversationId);await settle(restarted);
   assert.ok(calls>0,'an explicit continue can resume the task');
  } finally {await restarted.shutdown();await reopened.close();}
 }
 // Cancelling an assignment only cancels that lane, without pausing or settling its parent.
 {
  const t=await conversation('子任务取消');
  await store.oweMessage(t.conversationId,'parent-input');
  const lane=new LocalScheduler({...base,workAssignmentId:'assignment',registry:{cancel:()=>true,runTurn:async()=>ok('SKIP')}});
  await lane.stopConversation(t.conversationId);
  assert.equal((await store.getConversation(t.conversationId)).paused,false);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'owed-messages.json'),'utf8'))[t.conversationId],['parent-input'],'cancelling a subtask does not clear the parent task pending messages');
  await store.settleOwed(t.conversationId);
 }
 // A failed persistence operation still cancels the running execution.
 {
  const t=await conversation('停止写入失败');let cancelled=false;
  const failing=Object.create(store);
  failing.setConversationPaused=async()=>{throw Error('injected pause write failure');};
  const scheduler=new LocalScheduler({...base,store:failing,registry:{cancel:()=>true,runTurn:async()=>ok('SKIP')}});
  scheduler.cancelRunningTurns=async()=>{cancelled=true;return 1;};
  await assert.rejects(scheduler.stopConversation(t.conversationId),/injected pause write failure/);
  assert.equal(cancelled,true,'persistence failure still cancels execution and reports the failure to the caller');
 }
 // Simulate metadata failure AFTER fsync: retry with the same id, one durable message, UI notified.
 const io=await conversation('日志已写入但元数据失败');const writeJson=store.writeJson.bind(store);let failOnce=true,delivered=0;
 const unsub=store.subscribe(e=>{if(e.type==='message'&&e.conversationId===io.conversationId)delivered++;});
 store.writeJson=async(file,value)=>{if(file==='conversations.json'&&failOnce&&(await store.listMessages(io.conversationId)).length){failOnce=false;throw Error('injected metadata write failure');}return writeJson(file,value);};
 const durable=new LocalScheduler({...base,idleRetryLimit:0,registry:{runTurn:async()=>ok('不能丢失的确认问题？')}});
 await durable.runAgentTurn(io,leader);store.writeJson=writeJson;unsub();
 assert.equal((await store.listMessages(io.conversationId)).length,1);assert.equal(delivered,1);
 // Default: no follow-up cap. The leader keeps being followed up past three idle rounds until the task is stopped.
 {
  const endless=await conversation('默认一直跟进');let calls=0;
  const unlimited=new LocalScheduler({...base,registry:{cancel:()=>true,runTurn:async()=>{calls++;return ok('SKIP');}}});
  await unlimited.runAgentTurn(endless,leader);
  for(let i=0;i<200&&calls<7;i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(calls>=7,`no default "stop after 3 follow-ups"; actually followed up ${calls-1} times`);
  assert.notEqual((await store.getConversation(endless.conversationId)).followUp?.state,'blocked');
  assert.ok(!(await store.listMessages(endless.conversationId)).some(m=>m.content.includes('主人')),'follow-up messages do not say "master"');
  await unlimited.stopConversation(endless.conversationId);await settle(unlimited);
  const after=calls;await unlimited.followUpIdleConversation(endless.conversationId);assert.equal(calls,after,'no more follow-ups after stop');
 }
 // An explicit cap (idleRetryLimit) still works: exactly three additional attempts and a persistent visible reason.
 const idle=await conversation('未完成不得静默');let idleCalls=0;const logs=[];
 const s=new LocalScheduler({...base,idleRetryLimit:3,log:async(e)=>logs.push(e),registry:{runTurn:async()=>{idleCalls++;return ok('SKIP');}}});
 await s.runAgentTurn(idle,leader);await settle(s);
 assert.equal(idleCalls,4);assert.equal(logs.filter(e=>e==='conversation-idle-follow-up').length,3);
 assert.equal((await store.getConversation(idle.conversationId)).followUp.state,'blocked');
 assert.ok((await store.listMessages(idle.conversationId)).some(m=>m.type==='SYSTEM'&&m.content.includes('连续跟进 3 次')));
 await s.followUpIdleConversation(idle.conversationId);assert.equal(idleCalls,4);
 const reopened=new LocalStore(dir);await reopened.init();
 assert.equal((await reopened.getConversation(idle.conversationId)).followUp.attempts,3);
 assert.ok((await reopened.listMessages(invalid.conversationId)).some(m=>m.agentReply?.raw.includes('请确认这个问题')));await reopened.close();
 await s.sendUserMessage({conversationId:idle.conversationId,clientMessageId:'new-input',content:'补充了新的素材'});await settle(s);assert.equal(idleCalls,8,'bounded follow-up restarts after new user input');
 await s.stopConversation(idle.conversationId);await s.followUpIdleConversation(idle.conversationId);assert.equal(idleCalls,8);
 await s.resumeConversation(idle.conversationId);await settle(s);assert.equal(idleCalls,11,'three retries allowed after an explicit continue');
 // A retry can restore concrete work, including leader work; actual success ends follow-up via stop.
 const recover=await conversation('跟进后恢复执行');let leaderCalls=0,executed=0;
 const live=new LocalScheduler({...base,registry:{cancel:()=>true,runTurn:async(d)=>{
  const t=await store.getConversation(recover.conversationId);
  const c=(await store.listMessages(t.conversationId,{limit:1000})).filter(m=>m.coordination?.assigneeId===a.userId).at(-1)?.coordination;
  if(d.kind===a.kind){if(c?.phase==='proposal')return ctl({action:'accept',assignmentId:c.id});executed++;return ok('读取结果与证据');}
  leaderCalls++;
  if(!t.workPlan?.length)return leaderCalls===1?ok('SKIP'):ctl({action:'plan',work:[work]});
  if(t.workPlan[0].status==='review')return ctl({action:'review',workId:'inspect',verdict:'pass',evidence:'实际内容核对一致'});
  if(t.workPlan[0].status==='done')return ctl({action:'stop',reason:'交付完成'});
  return ok('SKIP');
 }}});
 await live.runAgentTurn(recover,leader);await settle(live);assert.equal(executed,1);assert.equal(live.runtimeSnapshot().agents.length,0);assert.equal(live.engagedConversations.has(recover.conversationId),false);
 const direct=await store.createConversation({name:'单聊',memberIds:[a.userId]});let directCalls=0;
 const plain=new LocalScheduler({...base,registry:{runTurn:async()=>{directCalls++;return ok('你好');}}});await plain.runAgentTurn(direct,a);await settle(plain);assert.equal(directCalls,1);
 // Running work (including approval waits) must not trigger idle follow-up or duplicate dispatch.
 const busy=await conversation('审批等待不算停滞');let release;const wait=new Promise(r=>release=r);let calls=0;
 const occupied=new LocalScheduler({...base,registry:{runTurn:async()=>{calls++;await wait;return ok('已处理');}}});
 const running=occupied.runAgentTurn(busy,a);await sleep(10);await occupied.followUpIdleConversation(busy.conversationId);assert.equal(calls,1);
 await store.setConversationPaused(busy.conversationId,true);release();await running;await settle(occupied);assert.equal(calls,1);assert.ok(!(await store.getConversation(busy.conversationId)).followUp);
 console.log('message-retention-idle: durable questions/reviews, stale controls, restart persistence, three retries, input/resume reset, stop and direct isolation passed');
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
