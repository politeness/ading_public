import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';
import {MessageDelivery} from '../dist/orchestration/message-delivery.js';
import {SleepGuard} from '../dist/platform/sleep-guard.js';

// Sleep gate: while the computer sleeps (after suspend, before resume, including DarkWake) no new turn starts; on wake, dispatch immediately, without loss or duplication;
// long operations like sign-in, install and connection checks also count as busy and block idle sleep
const tick=(ms=5)=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(fn,what)=>{for(let i=0;i<400&&!(await fn());i++)await tick();assert.ok(await fn(),what);};
const metrics={iterations:0,sideEffects:false};
const ok=message=>({ok:true,threadId:'t',message,steps:[],metrics});
const broken=()=>({ok:false,threadId:'t',error:'stream disconnected before completion: websocket closed by server',steps:[],cancelled:false,metrics});

const newGuard=()=>new SleepGuard({busy:()=>false,keepAwake:()=>true,blocker:{start:()=>1,stop:()=>{}},onSleep:()=>{},onWake:()=>{},log:()=>undefined});

// ---- SleepGuard.whenAwake ----
{
  const guard=newGuard();
  let woke=0;
  await guard.whenAwake();
  guard.suspend();
  void guard.whenAwake().then(()=>woke++);void guard.whenAwake().then(()=>woke++);
  await tick();
  assert.equal(woke,0,'waits while asleep');
  guard.resume('resume');
  await tick();
  assert.equal(woke,2,'all released on wake');
  guard.suspend();
  void guard.whenAwake().then(()=>woke++);
  guard.dispose();
  await tick();
  assert.equal(woke,3,'released on exit too');
}

// ---- MessageDelivery: messages that arrive, come due or fail while asleep are held, and resume at their original attempt number on wake ----
{
  let asleep=true;const delivered=[],timers=[],logs=[];let fail=0;
  const delivery=new MessageDelivery({
    deliver:async message=>{delivered.push(message.messageId);if(fail>0){fail--;throw new Error('network down');}return true;},
    stillOwed:async()=>true,asleep:()=>asleep,log:(event,data)=>logs.push([event,data]),
    retryMs:[10,20],setTimer:(run,ms)=>{const t={run,ms};timers.push(t);return t;},clearTimer:()=>{}
  });
  const m={conversationId:'c',messageId:'m1'};
  await delivery.deliver(m);
  assert.deepEqual(delivered,[],'not handed to the scheduler while asleep');
  asleep=false;delivery.wake();await tick();
  assert.deepEqual(delivered,['m1'],'delivered immediately on wake');
  delivery.wake();await tick();
  assert.deepEqual(delivered,['m1'],'delivered once on wake, no duplicates');

  // Failed while awake and a retry was scheduled; asleep again when the retry comes due: no attempt consumed, resumes as attempt 2 on wake
  fail=1;
  await delivery.deliver({conversationId:'c',messageId:'m2'});
  assert.equal(timers.length,1);
  asleep=true;timers.shift().run();await tick();
  assert.deepEqual(delivered,['m1','m2'],'retry due while asleep is not executed');
  // A failure while asleep (network not up during DarkWake) does not count as an attempt either
  fail=5;asleep=false;delivery.wake();asleep=true;await tick();
  assert.equal(timers.length,0,'failure while asleep does not schedule the next retry');
  fail=0;asleep=false;delivery.wake();await tick();
  assert.deepEqual(delivered,['m1','m2','m2','m2'],'resumes delivery on wake');
  const attempts=logs.filter(([event])=>event==='message-delivery-deferred-asleep').map(([,data])=>data.attempt);
  assert.deepEqual(attempts,[1,2,2],'the held attempt stays the same; attempts are not consumed');
  assert.equal(logs.some(([event])=>event==='message-delivery-abandoned'),false);
}

// ---- scheduler: a single gate at the turn-start entry ----
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-sleep-gate-'));
try {
  const store=new LocalStore(dir);await store.init();
  const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'c',executablePath:'/mock'}]);
  const guard=newGuard();
  const turns=[];let runTurn=async(_d,input)=>{turns.push(input);return ok('好');};
  const scheduler=new ConversationScheduler({idleRetryLimit:0,teamMonitorIntervalMs:0,connectionRetryDelayMs:30,store,
    registry:{runTurn:(d,input)=>runTurn(d,input),cancel:()=>true},syncer:{ensureSynced:async()=>[]},
    resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'codex',localUuid:'c'}),
    isAgentReady:()=>true,broadcast:()=>{},log:async()=>{},
    systemAsleep:()=>guard.sleeping,whenAwake:()=>guard.whenAwake()});
  const conversation=await store.createConversation({name:'睡眠闸门',memberIds:[agent.userId]});
  const id=conversation.conversationId;
  const processed=async()=>(await store.getConversation(id)).members.find(m=>m.userId===agent.userId).lastProcessedSeq??0;

  // Two messages arriving while asleep: no turn; on wake only one turn starts and handles both
  guard.suspend();
  await scheduler.sendUserMessage({conversationId:id,clientMessageId:'s1',content:'第一条'});
  const second=await scheduler.sendUserMessage({conversationId:id,clientMessageId:'s2',content:'第二条'});
  await tick(40);
  assert.equal(turns.length,0,'no new turn while asleep');
  assert.equal(scheduler.runtimeSnapshot().agents.length,0,'turns waiting for wake do not count as running and do not block sleep');
  guard.resume('resume');
  await waitFor(async()=>(await processed())>=second.seq,'dispatched and processed immediately on wake');
  await tick(40);
  assert.equal(turns.length,1,'only one catch-up turn on wake, no duplicates');

  // A turn already running is left alone; messages arriving during it (follow-up turn) do not start while asleep, only on wake
  let release;turns.length=0;
  runTurn=async(_d,input)=>{turns.push(input);if(turns.length===1)await new Promise(r=>release=r);return ok('好');};
  await scheduler.sendUserMessage({conversationId:id,clientMessageId:'r1',content:'长任务'});
  await waitFor(()=>turns.length===1,'first turn started');
  const during=await scheduler.sendUserMessage({conversationId:id,clientMessageId:'r2',content:'执行中追加'});
  guard.suspend();
  release();
  await tick(40);
  assert.equal(turns.length,1,'running turn finishes normally; follow-up turn does not start while asleep');
  guard.resume('resume');
  await waitFor(async()=>(await processed())>=during.seq,'appended message processed on wake');
  assert.equal(turns.length,2);

  // Connection-recovery retry: if the computer sleeps while waiting, it does not start when due, only on wake
  turns.length=0;let broke=true;
  runTurn=async(_d,input)=>{turns.push(input);if(broke){broke=false;return broken();}return ok('恢复了');};
  const retried=await scheduler.sendUserMessage({conversationId:id,clientMessageId:'x1',content:'会断一次'});
  await waitFor(()=>turns.length===1,'first attempt failed');
  guard.suspend();
  await tick(80);
  assert.equal(turns.length,1,'connection-recovery retry does not start while asleep');
  guard.resume('resume');
  await waitFor(async()=>(await processed())>=retried.seq,'retry succeeds on wake');
  assert.equal(turns.length,2);

  // Exit while asleep: waiting turns are abandoned
  guard.suspend();turns.length=0;
  await scheduler.sendUserMessage({conversationId:id,clientMessageId:'q1',content:'退出前'});
  await scheduler.shutdown();
  guard.resume('resume');
  await tick(40);
  assert.equal(turns.length,0,'no turn on wake after exit');
  guard.dispose();
} finally { await rm(dir,{recursive:true,force:true}); }

console.log('sleep gate ok');
