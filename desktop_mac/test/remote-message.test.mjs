import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';

// A message sent from the phone has already been backfilled into local data (in the store, but not sent through the desktop UI):
// once handed to the scheduler, the local agent replies as usual, just like a message sent on the desktop
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-remote-message-'));
const store=new LocalStore(dir);await store.init();
try {
  const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'c',executablePath:'/mock'}]);
  const prompts=[];
  const scheduler=new ConversationScheduler({idleRetryLimit:0,store,registry:{runTurn:async(_d,input)=>{prompts.push(input.prompt);return {ok:true,threadId:'t',message:'已经看过了',steps:[],metrics:{iterations:0,sideEffects:false}};}},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'codex',localUuid:'c'}),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
  const waitFor=async fn=>{for(let i=0;i<400&&!(await fn());i++)await new Promise(r=>setTimeout(r,5));assert.ok(await fn());};
  const conversation=await store.createConversation({name:'手机上建的',memberIds:[agent.userId]});
  const me=(await store.currentUser()).userId;
  const fromPhone=await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'m_phone_1',senderId:me,content:'帮我看看桌面上的报表'});
  await scheduler.receiveRemoteUserMessage(fromPhone);
  await waitFor(async()=>(await store.listMessages(conversation.conversationId)).some(m=>m.senderId===agent.userId));
  assert.ok(prompts.some(p=>p.includes('帮我看看桌面上的报表')),'agent receives the content sent from the phone');
  const reply=(await store.listMessages(conversation.conversationId)).find(m=>m.senderId===agent.userId);
  assert.equal(reply.content,'已经看过了');
  assert.equal(prompts.length,1,'the same message is executed only once');
  // Crash before the backfill dispatch ack is persisted: after restart (new scheduler) the same message is handed over again; if the Agent already handled it, it is not executed again
  const processed=async()=>(await store.getConversation(conversation.conversationId)).members.find(m=>m.userId===agent.userId).lastProcessedSeq??0;
  await waitFor(async()=>(await processed())>=fromPhone.seq);
  const restarted=new ConversationScheduler({idleRetryLimit:0,store,registry:{runTurn:async(_d,input)=>{prompts.push(input.prompt);return {ok:true,threadId:'t',message:'又看了一遍',steps:[],metrics:{iterations:0,sideEffects:false}};}},syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:()=>({kind:'codex',localUuid:'c'}),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
  assert.equal(await restarted.receiveRemoteUserMessage(fromPhone),true,'an already-handled message still counts as accepted, so the backfiller can acknowledge it');
  await new Promise(r=>setTimeout(r,100));
  assert.equal(prompts.length,1,'repeated dispatch does not make the Agent execute again');
  // a message not yet handled is executed as usual when re-dispatched
  const later=await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'m_phone_2',senderId:me,content:'再看一下利润表'});
  assert.equal(await restarted.receiveRemoteUserMessage(later),true);
  await waitFor(async()=>prompts.length===2);
  assert.ok(prompts[1].includes('再看一下利润表'));
  // clean up the temp directory only after this turn finishes wrapping up (advance the watermark, clear pending bookkeeping)
  await waitFor(async()=>(await processed())>=later.seq&&(await store.listOwedMessages()).length===0);
  console.log('remote-message: phone message dispatched to the local agent once');
} finally {
  await store.close?.();
  await rm(dir,{recursive:true,force:true});
}
