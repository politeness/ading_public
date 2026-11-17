import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';

// Sending only a cancel signal on shutdown is not enough: the cancelled turn still has to write back its result and clear bookkeeping.
// shutdown must wait for it to finish before returning, so no writes are in flight when the caller then closes the store, deletes directories (or the app exits).
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-scheduler-shutdown-'));
const store=new LocalStore(dir);
let scheduler;
const waitFor=async(fn,what)=>{for(let i=0;i<400&&!(await fn());i++)await new Promise(r=>setTimeout(r,5));assert.ok(await fn(),what);};
try {
  await store.init();
  const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'c',executablePath:'/mock'}]);
  const conversation=await store.createConversation({name:'退出时还在跑',memberIds:[agent.userId]});
  let started=false,finishedAt=0;
  // return the result 300ms after cancellation, simulating a slow CLI wrap-up
  const slowCancel=(_d,input)=>{started=true;return new Promise(resolve=>input.signal?.addEventListener('abort',()=>setTimeout(()=>{finishedAt=Date.now();resolve({ok:false,cancelled:true,error:'cancelled',steps:[],metrics:{iterations:0,sideEffects:false}});},300)));};
  scheduler=new ConversationScheduler({idleRetryLimit:0,teamMonitorIntervalMs:0,store,registry:{runTurn:slowCancel,cancel:()=>true},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'codex',localUuid:'c'}),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
  await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'m1',content:'跑一个长任务'});
  await waitFor(()=>started,'this turn has started');
  await scheduler.shutdown();
  const returnedAt=Date.now();
  assert.ok(finishedAt>0 && finishedAt<=returnedAt,'shutdown returns only after the cancelled turn hands back its result');
  assert.equal(scheduler.runtimeSnapshot().agents.length,0,'no Agent still running on return');
  scheduler=undefined;
  console.log('scheduler-shutdown: shutdown waits for cancelled turns to finish writing before returning');
} finally {
  await scheduler?.shutdown().catch(()=>{});
  await store.close().catch(()=>{});
  await rm(dir,{recursive:true,force:true});
}
