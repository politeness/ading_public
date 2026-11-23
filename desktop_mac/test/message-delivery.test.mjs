import {readyGroup} from './ready-group.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';
import {MessageDelivery,DELIVERY_RETRY_MS} from '../dist/orchestration/message-delivery.js';

// A user message is cleared from the ledger only once "processed": crashing mid-processing, or after writing locally but before reaching the scheduler, both re-trigger from the ledger after restart;
// already-replied ones do not rerun, and ones the user paused do not rerun
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-message-delivery-'));
// When simulating a crash the old scheduler and old store cannot exit cleanly; record them all, and at teardown stop the scheduler first (cancel the pending turn), then close the store, and finally delete the directory
const schedulers=[],stores=[];
const opened=async s=>{stores.push(s);await s.init();return s;};
const waitFor=async(fn,what)=>{for(let i=0;i<400&&!(await fn());i++)await new Promise(r=>setTimeout(r,5));assert.ok(await fn(),what);};
const schedulerFor=(store,runTurn,resolveDiscovered=()=>({kind:'codex',localUuid:'c'}))=>{
  const scheduler=new ConversationScheduler({idleRetryLimit:0,teamMonitorIntervalMs:0,store,registry:{runTurn,cancel:()=>true},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered,isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
  schedulers.push(scheduler);return scheduler;
};
const ok=message=>({ok:true,threadId:'t',message,steps:[],metrics:{iterations:0,sideEffects:false}});
const hang=(_d,input)=>new Promise(resolve=>input.signal?.addEventListener('abort',()=>resolve({ok:false,cancelled:true,error:'cancelled',steps:[],metrics:{iterations:0,sideEffects:false}})));
try {
  // ---- First run: the first message replies normally; the second "crashes" mid-execution (this turn never returns) ----
  let store=await opened(new LocalStore(dir));
  const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'c',executablePath:'/mock'}]);
  const conversation=await store.createConversation({name:'处理中崩溃',memberIds:[agent.userId]});
  const id=conversation.conversationId;
  const prompts=[];
  let stall=false;
  const first=schedulerFor(store,async(d,input)=>{prompts.push(input);return stall?hang(d,input):ok('第一条看过了');});
  const done=await first.sendUserMessage({conversationId:id,clientMessageId:'m_done',content:'先看报表'});
  const processed=async s=>(await s.getConversation(id)).members.find(m=>m.userId===agent.userId).lastProcessedSeq??0;
  await waitFor(async()=>(await processed(store))>=done.seq,'First message processed');
  await waitFor(async()=>(await store.listOwedMessages()).length===0,'Cleared from the ledger once processed (watermark passed)');
  stall=true;
  const crashed=await first.sendUserMessage({conversationId:id,clientMessageId:'m_crash',content:'再看利润表'});
  await waitFor(async()=>prompts.length===2,'Second message has started executing');
  assert.deepEqual((await store.listOwedMessages()).map(m=>m.messageId),['m_crash'],'Taken over but not finished, still on the ledger');
  // Crash after writing locally but before reaching the scheduler: like the first half of sendUserMessage, record the ledger before writing the message
  await store.oweMessage(id,'m_lost');
  const lost=await store.appendMessage({conversationId:id,clientMessageId:'m_lost',senderId:(await store.currentUser()).userId,content:'顺便看现金流'});
  // Entries recorded in the ledger whose message was never written before the crash are dropped on restart
  await store.oweMessage(id,'m_never_written');
  const raw=JSON.parse(await readFile(path.join(dir,'owed-messages.json'),'utf8'));
  assert.deepEqual(raw[id],['m_crash','m_lost','m_never_written'],'Ledger persisted before the message');

  // ---- Restart: new store, new scheduler, re-trigger from the ledger ----
  store=await opened(new LocalStore(dir));
  const owed=await store.listOwedMessages();
  assert.deepEqual(owed.map(m=>m.messageId),['m_crash','m_lost'],'Replied m_done is not on the ledger; entries never written are cleared');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'owed-messages.json'),'utf8'))[id],['m_crash','m_lost']);
  const again=[];
  const restarted=schedulerFor(store,async(_d,input)=>{again.push(input);return ok('都看完了');});
  for (const message of owed) assert.equal(await restarted.redeliverUserMessage(message),true);
  await waitFor(async()=>(await processed(store))>=lost.seq,'Processed after re-triggering');
  assert.ok(again.length>=1,'Re-executes after restart');
  const resumed=again[0];
  assert.equal(resumed.threadId,'t','Resumes the original vendor session');
  assert.match(resumed.prompt,/连接恢复第 1 次|Connection recovery #1/,'Continues as a connection recovery without blindly redoing');
  assert.ok(again.some(input=>input.prompt.includes('再看利润表'))&&again.some(input=>input.prompt.includes('顺便看现金流')),'Both messages are handed to the Agent');
  assert.ok(!again.some(input=>input.prompt.includes('先看报表')&&!input.prompt.includes('再看利润表')),'Replied old message is not rerun on its own');
  assert.equal((await store.getAgentSession(id,agent.userId)).recovery,undefined,'Recovery marker cleared after successful recovery');
  await waitFor(async()=>(await store.listOwedMessages()).length===0,'Cleared from the ledger once processed');
  // Handed over again (e.g. leftover catch-up and the ledger at the same time): the watermark has passed, so it does not run
  const count=again.length;
  assert.equal(await restarted.redeliverUserMessage(crashed),true);
  await new Promise(r=>setTimeout(r,50));
  assert.equal(again.length,count,'Already processed messages do not rerun');

  // ---- User pause: both the pause and ledger clearing persist; no automatic rerun after restart ----
  const pausing=schedulerFor(store,hang);
  await pausing.sendUserMessage({conversationId:id,clientMessageId:'m_paused',content:'跑个大任务'});
  assert.deepEqual((await store.listOwedMessages()).map(m=>m.messageId),['m_paused']);
  await pausing.stopConversation(id);
  assert.deepEqual(await store.listOwedMessages(),[],'No ledger entries after pausing');
  store=await opened(new LocalStore(dir));
  assert.deepEqual(await store.listOwedMessages(),[],'Paused messages are not rerun after restart');
  assert.equal((await store.getConversation(id)).paused,true,'Still paused after restart');
  let stoppedRuns=0;
  const stopped=schedulerFor(store,async()=>{stoppedRuns++;return ok('继续');});
  const pausedMessage=(await store.listMessages(id)).find(m=>m.messageId==='m_paused');
  await store.oweMessage(id,pausedMessage.messageId);
  await stopped.redeliverUserMessage(pausedMessage);
  await stopped.teamAvailabilityChanged();
  assert.equal(stoppedRuns,0,'Neither old message redelivery nor availability changes can resume a stopped task');
  assert.equal((await store.getConversation(id)).paused,true);
  assert.deepEqual(await store.listOwedMessages(),[]);
  await stopped.sendUserMessage({conversationId:id,clientMessageId:'m_continue',content:'现在继续'});
  await waitFor(async()=>stoppedRuns===1,'New instructions can continue');
  assert.equal((await store.getConversation(id)).paused,false);


  // ---- Group: A finishes first, B crashes while executing; A must not clear the ledger; only B re-triggers after restart ----
  const groupDir=path.join(dir,'group');
  let groupStore=await opened(new LocalStore(groupDir));
  const [alpha,beta]=await groupStore.syncDiscoveredAgents([{kind:'codex',localUuid:'a',executablePath:'/mock'},{kind:'claude',localUuid:'b',executablePath:'/mock'}]);
  const byAgent=userId=>({kind:userId===alpha.userId?'codex':'claude',localUuid:userId===alpha.userId?'a':'b'});
  const group=await readyGroup(groupStore,{name:'群组崩溃',memberIds:[alpha.userId,beta.userId],leaderId:alpha.userId});
  const groupRuns=[];
  // The scheduler adds a task suffix to localUuid, so identify the Agent by prefix
  const who=d=>d.localUuid.split('::')[0];
  const crashing=schedulerFor(groupStore,async(d,input)=>{groupRuns.push(who(d));return who(d)==='a'?ok('A 看完了'):hang(d,input);},byAgent);
  const asked=await crashing.sendUserMessage({conversationId:group.conversationId,clientMessageId:'m_group',content:'两位都看一下'});
  const groupProcessed=async(s,userId)=>(await s.getConversation(group.conversationId)).members.find(m=>m.userId===userId).lastProcessedSeq??0;
  // Wait for A's whole turn to end (watermark persisted, ledger-clearing decided), leaving only B executing
  await waitFor(async()=>(await groupProcessed(groupStore,alpha.userId))>=asked.seq&&groupRuns.includes('b')
    &&crashing.runtimeSnapshot().agents.length===1,'A finished, B executing');
  assert.deepEqual((await groupStore.listOwedMessages(group.conversationId)).map(m=>m.messageId),['m_group'],'B not finished, so A finishing must not clear the ledger');
  groupStore=await opened(new LocalStore(groupDir));
  const groupOwed=await groupStore.listOwedMessages();
  assert.deepEqual(groupOwed.map(m=>m.messageId),['m_group'],'Ledger survives restart');
  const rerun=[];
  const groupRestarted=schedulerFor(groupStore,async d=>{rerun.push(who(d));return ok(who(d)+' 看完了');},byAgent);
  assert.equal(await groupRestarted.redeliverUserMessage(groupOwed[0]),true);
  await waitFor(async()=>(await groupProcessed(groupStore,beta.userId))>=asked.seq,'B finishes after restart');
  await waitFor(async()=>(await groupStore.listOwedMessages()).length===0,'Ledger cleared only once everyone has processed');
  assert.equal(rerun[0],'b','The re-triggered one is the unfinished B');
  const rerunA=rerun.filter(x=>x==='a').length;
  // A reruns only due to B's new reply (others speaking in discussion mode), never on its own due to the re-triggered user message
  assert.ok(rerunA<=1,'Already processed A does not rerun for the same re-triggered user message');

  // ---- Dispatch failure retries: 5, 10, 20, 40 seconds; after four failures it stays on the ledger; exit cancels timers ----
  assert.deepEqual(DELIVERY_RETRY_MS,[5000,10000,20000,40000]);
  const timers=[];const logs=[];let calls=0;
  const failing=new MessageDelivery({deliver:async()=>{calls++;throw new Error('store busy');},stillOwed:async()=>true,log:(event,data)=>logs.push([event,data]),
    setTimer:(run,ms)=>{const timer={run,ms};timers.push(timer);return timer;},clearTimer:timer=>{timer.cleared=true;}});
  const message={conversationId:'c1',messageId:'m1',seq:1};
  await failing.deliver(message);
  for (let i=0;i<4;i++) { const timer=timers[i]; assert.ok(timer,`Retry ${i+1} scheduled`); timer.run(); await new Promise(r=>setTimeout(r,0)); }
  assert.deepEqual(timers.map(t=>t.ms),[5000,10000,20000,40000],'Backs off at 5/10/20/40 seconds');
  assert.equal(calls,5,'First attempt + 4 retries');
  assert.equal(timers.length,4,'No more retries after four failures');
  assert.equal(logs.at(-1)[0],'message-delivery-abandoned','Logs when giving up');
  await failing.deliver(message);
  assert.equal(calls,5,'Not handed over twice within the same process');
  // Stops on the second success
  let flaky=0;const timers2=[];
  const recovering=new MessageDelivery({deliver:async()=>{if(++flaky===1)throw new Error('once');return true;},stillOwed:async()=>true,log:()=>{},setTimer:(run,ms)=>{timers2.push({run,ms});return {};},clearTimer:()=>{}});
  await recovering.deliver({conversationId:'c2',messageId:'m2',seq:1});
  timers2[0].run();await new Promise(r=>setTimeout(r,0));
  assert.equal(flaky,2);assert.equal(timers2.length,1,'No more retries after success');
  // Ones no longer on the ledger (user paused, already processed) are not handed over when the time comes
  let owedCalls=0;const timers3=[];
  const settled=new MessageDelivery({deliver:async()=>{owedCalls++;throw new Error('x');},stillOwed:async()=>false,log:()=>{},setTimer:(run,ms)=>{timers3.push({run,ms});return {};},clearTimer:()=>{}});
  await settled.deliver({conversationId:'c3',messageId:'m3',seq:1});
  timers3[0].run();await new Promise(r=>setTimeout(r,0));
  assert.equal(owedCalls,1);assert.equal(timers3.length,1,'No more retries once cleared from the ledger');
  // Cancel pending retries on exit
  const timers4=[];let stopCalls=0;
  const stopping=new MessageDelivery({deliver:async()=>{stopCalls++;throw new Error('x');},stillOwed:async()=>true,log:()=>{},setTimer:(run,ms)=>{const t={run,ms};timers4.push(t);return t;},clearTimer:t=>{t.cleared=true;}});
  await stopping.deliver({conversationId:'c4',messageId:'m4',seq:1});
  stopping.stop();
  assert.equal(timers4[0].cleared,true,'Exit cancels timers');
  timers4[0].run();await new Promise(r=>setTimeout(r,0));
  assert.equal(stopCalls,1,'Not handed over after exit');
  console.log('message-delivery: unfinished user messages (including partially handled group messages) are re-triggered after restart; retries back off 5/10/20/40s');
} finally {
  // Stop the scheduler first: the pending turn is cancelled and nothing more is written to the directory before exit; then close the store, and finally delete the directory
  for (const scheduler of schedulers) await scheduler.shutdown().catch(()=>{});
  for (const s of stores) await s.close().catch(()=>{});
  await rm(dir,{recursive:true,force:true});
}
