import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';

// A message steered into the running turn must not be sent again as a new turn
// once the provider confirmed the turn saw it before its final reply. Failed,
// stopped or late (unechoed) steers keep the fallback turn.
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-steer-dedup-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate) {for(let i=0;i<400;i++){if(await predicate())return;await sleep(5);}throw Error('timeout');}
const ok=(message,extra={})=>({ok:true,message,threadId:'thread',steps:[],metrics:{iterations:0,sideEffects:false},...extra});
const failed=(extra={})=>({ok:false,error:'provider exploded',steps:[],cancelled:false,metrics:{iterations:0,sideEffects:false},...extra});
let scheduler;
try {
 const store=new LocalStore(dir); await store.init();
 const discovered=[{kind:'codex',localUuid:'leader',executablePath:'/mock'},{kind:'claude-code',localUuid:'worker',executablePath:'/mock'}];
 const [agent,worker]=await store.syncDiscoveredAgents(discovered);
 const calls=[], active=new Map(), steers=[];
 const registry={runTurn:async(d,input)=>{
   calls.push({d,input});
   return new Promise(resolve=>{
     const finish=outcome=>{active.delete(d.localUuid);resolve(outcome);};
     active.set(d.localUuid,{input,finish});
     input.signal.addEventListener('abort',()=>finish({...failed(),cancelled:true}),{once:true});
   });
 },steer:async(_kind,id,input)=>{steers.push({id,input});return {status:'accepted'};},cancel:()=>false};
 scheduler=new ConversationScheduler({idleRetryLimit:0,store,registry,syncer:{ensureSynced:async()=>[]},
   resolveWorkspace:async conversation=>{const workspacePath=path.join(dir,conversation.conversationId);await mkdir(workspacePath,{recursive:true});return{workspacePath,sharesKnowledge:false};},
   resolveDiscovered:id=>discovered.find(d=>d.kind===(id===agent.userId?'codex':'claude-code')),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
 const turnFor=localUuid=>[...active].find(([key])=>key.startsWith(localUuid))?.[1];
 const member=async(conversationId,userId)=>(await store.getConversation(conversationId)).members.find(m=>m.userId===userId);

 // One direct conversation per scenario: start a turn, steer a follow-up, finish it.
 const scenario=async(name,finishWith)=>{
   const conversation=await scheduler.createConversation({name,memberIds:[agent.userId],initialMessage:`${name}_START`});
   await until(()=>!!turnFor('leader'));
   const before=calls.length;
   const follow=await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:`${name}-follow`,content:`${name}_FOLLOW`});
   assert.equal(steers.at(-1).input.clientMessageId,follow.messageId);
   assert.equal(calls.length,before,'steering does not start another provider turn');
   turnFor('leader').finish(finishWith(follow.messageId));
   await until(async()=>(await store.listMessages(conversation.conversationId)).some(m=>m.senderId===agent.userId));
   await sleep(40);
   return {conversation,follow,extraCalls:calls.slice(before)};
 };

 {
   const {conversation,follow,extraCalls}=await scenario('SEEN',id=>ok('handled both',{steersSeen:[id]}));
   assert.equal(extraCalls.length,0,'a steer the turn confirmed seeing is not replayed as a new turn');
   assert.equal(scheduler.runtimeSnapshot().queued.length,0,'the fallback follow-up is dropped');
   assert.ok((await member(conversation.conversationId,agent.userId)).lastProcessedSeq>=follow.seq,'the steered message counts as processed');
   const reply=(await store.listMessages(conversation.conversationId)).find(m=>m.senderId===agent.userId);
   assert.equal(reply.agentReply.inputSeq,follow.seq);assert.equal(reply.agentReply.newerInput,false);
 }
 {
   const {extraCalls}=await scenario('LATE',()=>ok('only the first request'));
   assert.equal(extraCalls.length,1,'an accepted but unseen steer still gets its own turn');
   assert.ok(extraCalls[0].input.prompt.includes('LATE_FOLLOW'));
   turnFor('leader').finish(ok('handled late follow-up'));
   await until(()=>!turnFor('leader'));
 }
 {
   const {extraCalls}=await scenario('FAILED',id=>failed({steersSeen:[id]}));
   assert.equal(extraCalls.length,1,'a failed turn keeps the fallback turn');
   turnFor('leader').finish(ok('recovered'));
   await until(()=>!turnFor('leader'));
 }
 {
   const {extraCalls}=await scenario('CANCELLED',()=>({...failed(),cancelled:true}));
   assert.equal(extraCalls.length,1,'a provider-cancelled turn keeps the fallback turn');
   turnFor('leader').finish(ok('resumed'));
   await until(()=>!turnFor('leader'));
 }
 {
   // Two steers, only the first echoed before the final reply: the second still gets a turn.
   const conversation=await scheduler.createConversation({name:'PARTIAL',memberIds:[agent.userId],initialMessage:'PARTIAL_START'});
   await until(()=>!!turnFor('leader'));
   const before=calls.length;
   const first=await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'p1',content:'PARTIAL_ONE'});
   const second=await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'p2',content:'PARTIAL_TWO'});
   turnFor('leader').finish(ok('saw the first',{steersSeen:[first.messageId]}));
   await until(()=>calls.length===before+1);
   assert.ok((await member(conversation.conversationId,agent.userId)).lastProcessedSeq>=first.seq);
   assert.ok(calls.at(-1).input.prompt.includes('PARTIAL_TWO'));
   assert.ok(!calls.at(-1).input.prompt.includes('PARTIAL_ONE'),'the confirmed steer is not replayed');
   assert.ok(second.seq>first.seq);
   turnFor('leader').finish(ok('saw the second'));
   await until(()=>!turnFor('leader'));
 }
 {
   // Group: the Leader and a member are both steered; each settles on its own confirmation.
   const group=await store.createConversation({name:'GROUP',memberIds:[agent.userId,worker.userId],leaderId:agent.userId});
   await store.updateConversation(group.conversationId,{charter:{mode:'discussion'}});
   await scheduler.sendUserMessage({conversationId:group.conversationId,clientMessageId:'g0',content:'GROUP_START'});
   await until(()=>!!turnFor('leader')&&!!turnFor('worker'));
   const before=calls.length;
   const follow=await scheduler.sendUserMessage({conversationId:group.conversationId,clientMessageId:'g1',content:'GROUP_FOLLOW'});
   assert.equal(steers.filter(s=>s.input.clientMessageId===follow.messageId).length,2,'both running members are steered');
   turnFor('leader').finish(ok('leader saw it',{steersSeen:[follow.messageId]}));
   const leaderReplied=async()=>(await store.listMessages(group.conversationId)).find(m=>m.senderId===agent.userId&&m.agentReply);
   await until(leaderReplied);
   const leaderReply=await leaderReplied();
   assert.equal(leaderReply.agentReply.newerInput,false,'the Leader reply is not deferred for a message it already saw');
   turnFor('worker').finish(ok('worker saw it',{steersSeen:[follow.messageId]}));
   await until(()=>!turnFor('worker'));
   await sleep(60);
   for(const turn of [...active.values()])turn.finish(ok('SKIP'));
   const extra=calls.slice(before).filter(c=>c.input.prompt.includes('GROUP_FOLLOW'));
   assert.equal(extra.length,0,'neither the Leader nor the member replays the confirmed steer');
   for(const id of [agent.userId,worker.userId])assert.ok((await member(group.conversationId,id)).lastProcessedSeq>=follow.seq);
 }
 console.log('steer-dedup: confirmed steers settle in-turn; failed, cancelled, late and partial steers keep the fallback turn; direct and group');
} finally {
 await scheduler?.shutdown();
 await sleep(50);
 await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});
}
