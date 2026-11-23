import {readyGroup} from './ready-group.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {parseLeaderControl} from '../dist/orchestration/control.js';
import {isConnectionFailure,isContextOverflow,isProviderSessionMissing} from '../dist/orchestration/connection-recovery.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-connection-'));
const store=new LocalStore(dir);await store.init();
const discovered=['codex','claude-code'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
const users=await store.syncDiscoveredAgents(discovered),[leader,worker]=discovered.map(d=>users.find(u=>u.kind===d.kind));
const me=await store.currentUser();
const base={store,connectionRetryDelayMs:1,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>users.find(u=>u.kind===d.kind)?.userId===id),isAgentReady:u=>u.userId===leader.userId,broadcast:()=>{},log:async()=>{}};
const metrics={iterations:1,sideEffects:true};
const broken=()=>({ok:false,threadId:'broken-thread',error:'stream disconnected before completion: websocket closed by server before response.completed',steps:['已有文件写入'],cancelled:false,metrics});
const ok=message=>({ok:true,threadId:'healthy-thread',message,steps:[],metrics});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(s){for(let i=0;i<800;i++){if(!s.runtimeSnapshot().agents.length&&!s.idleChecks.size){await sleep(5);if(!s.runtimeSnapshot().agents.length&&!s.idleChecks.size)return;}await sleep(5);}throw Error('not settled');}
async function conversation(name){const t=await readyGroup(store,{name,memberIds:users.map(u=>u.userId),leaderId:leader.userId});await store.appendMessage({conversationId:t.conversationId,clientMessageId:name,senderId:me.userId,content:'保留源图，只修复副本'});return t;}
try {
 assert.ok(isConnectionFailure(broken().error));
 for(const error of ['permission denied','quota exceeded','rate limit','审批拒绝'])assert.equal(isConnectionFailure(error),false);
 const t=await conversation('连接失败后重建');
 await store.appendMessage({conversationId:t.conversationId,clientMessageId:'earlier',senderId:leader.userId,content:'已保存草稿 drafts/q01.png'});
 await store.saveAgentSession({conversationId:t.conversationId,agentUserId:leader.userId,providerThreadId:'broken-thread',memorySyncedAt:'2000-01-01'});
 await store.markProcessed(t.conversationId,leader.userId,2);
 const inputs=[];
 const s=new LocalScheduler({...base,idleRetryLimit:0,registry:{runTurn:async(_,input)=>{inputs.push(input);return inputs.length<3?{...broken(),partialMessage:'上轮已写入草稿，尚未复核'}:ok('已核对草稿并继续。');}}});
 await s.runAgentTurn(t,leader);await settle(s);
 assert.equal(inputs.length,3);assert.equal(inputs[1].threadId,'broken-thread');assert.equal(inputs[2].threadId,undefined);
 assert.match(inputs[2].prompt,/保留源图，只修复副本/);assert.match(inputs[2].prompt,/drafts\/q01.png/);assert.match(inputs[2].prompt,/不要盲目重做/);
 assert.equal(inputs[2].fullAccess,inputs[0].fullAccess,'Recovery must not expand permissions');
 assert.equal((await store.getAgentSession(t.conversationId,leader.userId)).recovery,undefined);
 assert.equal((await store.getConversation(t.conversationId)).followUp,undefined,'Connection retries do not consume business follow-up count');
 const retained=await store.listMessages(t.conversationId);assert.equal(retained.filter(m=>m.agentReply?.raw==='上轮已写入草稿，尚未复核').length,2);
 assert.ok(retained.filter(m=>m.agentReply?.raw==='上轮已写入草稿，尚未复核').every(m=>m.type==='USER'&&!m.internal&&!m.failed),'Real body text after connection failure still shows in chat');
 assert.ok(retained.filter(m=>m.type==='SYSTEM').every(m=>m.internal));
 // A full context cannot be fixed by resuming the same session: the very next turn starts a fresh one with the task history.
 const overflowText='Qoder 回复失败：Context exceeds the limit and automatic context recovery is unavailable. Run /compact or /clear, then retry.';
 assert.ok(isContextOverflow(overflowText));
 for(const error of ['prompt is too long: 250000 tokens > 200000 maximum','This model\'s maximum context length is 128000 tokens','context_length_exceeded'])assert.ok(isContextOverflow(error),error);
 for(const error of ['permission denied','quota exceeded','Not logged in'])assert.equal(isContextOverflow(error),false,error);
 assert.ok(isProviderSessionMissing('Qoder 回复失败：Error resuming session: Invalid session identifier "637e28a3".'));
 assert.ok(isProviderSessionMissing('SessionError: NO_SESSIONS_FOUND'));
 assert.ok(isProviderSessionMissing('No conversation found with session ID 123'));
 for(const error of ['resource not found','permission denied','Not logged in'])assert.equal(isProviderSessionMissing(error),false,error);
 // A vendor transcript may disappear while ADing still has its durable thread id.
 // Drop the stale id immediately, replay the ledger once, and persist the replacement.
 {
  const missing=await conversation('原厂商会话丢失后重建');
  await store.appendMessage({conversationId:missing.conversationId,clientMessageId:'missing-history',senderId:leader.userId,content:'已完成第一步，保留 drafts/result.png'});
  await store.saveAgentSession({conversationId:missing.conversationId,agentUserId:leader.userId,providerThreadId:'637e28a3',providerThreadGeneration:1});
  await store.markProcessed(missing.conversationId,leader.userId,2);
  const turns=[],events=[];
  const m=new LocalScheduler({...base,idleRetryLimit:0,log:async(event,detail)=>{events.push({event,...detail});},registry:{runTurn:async(_,input)=>{
    turns.push(input);
    return turns.length===1
      ? {ok:false,error:'Qoder 回复失败：Error resuming session: Invalid session identifier "637e28a3".',steps:[],cancelled:false,metrics}
      : ok('新会话已核对产物并继续。');
  }}});
  await m.runAgentTurn(missing,leader);await settle(m);
  assert.equal(turns.length,2,'Replays automatically only once');
  assert.equal(turns[0].threadId,'637e28a3');
  assert.equal(turns[1].threadId,undefined,'No longer reuses the expired vendor session');
  assert.match(turns[1].prompt,/已完成第一步/,'New session replays persisted messages');
  assert.equal((await store.getAgentSession(missing.conversationId,leader.userId)).providerThreadId,'healthy-thread');
  assert.ok(events.some(e=>e.event==='provider-thread-discarded'&&e.reason==='provider-session-missing'));
  const notes=(await store.listMessages(missing.conversationId)).filter(m=>m.type==='SYSTEM').map(m=>m.content).join('\n');
  assert.match(notes,/原厂商会话已不存在/);
 }
 {
  const full=await conversation('上下文超限后开新会话');
  await store.saveAgentSession({conversationId:full.conversationId,agentUserId:leader.userId,providerThreadId:'full-thread'});
  const turns=[];
  const f=new LocalScheduler({...base,idleRetryLimit:0,registry:{runTurn:async(_,input)=>{turns.push(input);return turns.length===1?{ok:false,threadId:'full-thread',error:overflowText,steps:[],cancelled:false,metrics}:ok('新会话里核对后继续完成。');}}});
  await f.runAgentTurn(full,leader);await settle(f);
  assert.equal(turns.length,2,'Automatically runs another turn after overflow');
  assert.equal(turns[0].threadId,'full-thread');
  assert.equal(turns[1].threadId,undefined,'First recovery opens a new session instead of reusing the full one');
  assert.match(turns[1].prompt,/保留源图，只修复副本/,'New session carries the task history');
  const notes=(await store.listMessages(full.conversationId)).filter(m=>m.type==='SYSTEM').map(m=>m.content).join('\n');
  assert.doesNotMatch(notes,/会话上下文已满|context.*full/i,"overflow recovery stays out of chat");
 }
 // A failed turn keeps its original error and the scene of any permission denial in the log.
 {
  const denied=await conversation('执行失败留日志');const sessionFile=path.join(dir,'c0fb62a7.jsonl');await writeFile(sessionFile,'{}');
  const events=[];
  const d=new LocalScheduler({...base,idleRetryLimit:0,log:async(event,detail)=>{events.push({event,...detail});},registry:{runTurn:async()=>({ok:false,error:`Qoder 回复失败：Error resuming session: EPERM: operation not permitted, open '${sessionFile}'`,steps:[],cancelled:false,metrics})}});
  await d.runAgentTurn(denied,leader);await settle(d);
  const failed=events.find(e=>e.event==='agent-turn-failed');
  assert.ok(failed&&failed.error.includes('Error resuming session: EPERM'),'Failure text goes into the log');
  const probe=events.find(e=>e.event==='agent-turn-denied-path');
  assert.equal(probe?.path,sessionFile,'Rejected file goes into the log');assert.equal(probe.appCanOpen,true,'Also records whether the main process itself can open it');
 }
 // Persistent exhaustion cannot be circumvented by idle work, worker results or restart.
 const exhausted=await conversation('连接重试耗尽');let calls=0;
 const e=new LocalScheduler({...base,registry:{runTurn:async()=>{calls++;return broken();}}});
 await e.runAgentTurn(exhausted,leader);await settle(e);assert.equal(calls,4);
 assert.equal((await store.getConversation(exhausted.conversationId)).followUp,undefined);
 assert.equal((await store.getAgentSession(exhausted.conversationId,leader.userId)).recovery.state,'blocked');
 const restarted=new LocalScheduler({...base,registry:{runTurn:async()=>{calls++;return broken();}}});
 await restarted.followUpIdleConversation(exhausted.conversationId);await restarted.runAgentTurn(exhausted,leader);assert.equal(calls,4);
 await restarted.sendUserMessage({conversationId:exhausted.conversationId,clientMessageId:'retry-owner',content:'现在继续'});await settle(restarted);assert.equal(calls,8);
 // Pause during backoff cancels the retry without executing another provider turn.
 const paused=await conversation('等待时暂停');let pauseCalls=0;
 const p=new LocalScheduler({...base,connectionRetryDelayMs:1000,registry:{cancel:()=>true,runTurn:async()=>{pauseCalls++;return broken();}}});
 const running=p.runAgentTurn(paused,leader);while(!(await store.getAgentSession(paused.conversationId,leader.userId))?.recovery)await sleep(2);
  await p.stopConversation(paused.conversationId);await running;assert.equal(pauseCalls,1);
  const resumed=new LocalScheduler({...base,idleRetryLimit:0,registry:{runTurn:async()=>{pauseCalls++;return ok('恢复后核对完成');}}});
  await store.markProcessed(paused.conversationId,leader.userId,(await store.getConversation(paused.conversationId)).lastSeq);
  await resumed.resumeConversation(paused.conversationId);await settle(resumed);assert.equal(pauseCalls,2,'Paused during connection retry; resuming must still re-push even without new messages');
 // Both real incidents: blocked text is saved in full, and one missing brace is tolerated.
 for(const malformed of [false,true]) {
  const b=await conversation('完整受阻正文-'+malformed),id='assignment-'+malformed;
  const coordination={id,assigneeId:worker.userId,phase:'accepted',brief:'核对原图',workId:'q09'};
  await store.updateConversation(b.conversationId,{workPlan:[{id:'q09',assignment:'核对原图',candidates:[worker.userId],dependsOn:[],outputs:[],acceptance:'保持公式',readOnly:true,status:'active',assignmentId:id}]});
  await store.appendMessage({conversationId:b.conversationId,clientMessageId:id,senderId:leader.userId,type:'TASK',content:'按方案执行',coordination});
  const body='已尝试修复。草稿 drafts/q09.png，公式有损伤，不能验收。';
  const raw=body+'\n'+JSON.stringify({control:{action:'blocked',assignmentId:id,reason:'公式有损伤'}}).slice(0,malformed?-1:undefined);
  const bsch=new LocalScheduler({...base,isAgentReady:()=>true,idleRetryLimit:0,registry:{runTurn:async d=>d.kind===worker.kind?ok(raw):ok('SKIP')}});
  await bsch.runAgentTurn(b,worker);await settle(bsch);
  const reply=(await store.listMessages(b.conversationId)).find(m=>m.agentReply?.raw===raw);
  assert.equal(reply.content,body);assert.equal(reply.coordination.phase,'rejected');assert.equal((await store.getConversation(b.conversationId)).workPlan[0].status,'blocked');
 }
 for(const raw of ['{"control":{"action":"stop"}', '{"control":{"action":"blocked","assignmentId":"x","reason":"未写完', '{"control":{"action":"blocked","assignmentId":"x"}'])assert.equal(parseLeaderControl(raw).control,undefined);
 // Idle instruction was previously omitted because it had the leader's own sender id.
 const idle=await conversation('内部跟进必须送达');let idleCalls=0;
 await store.updateConversation(idle.conversationId,{workPlan:[{id:'unfinished',assignment:'Inspect the draft',candidates:[leader.userId],dependsOn:[],outputs:[],acceptance:'Checked evidence',status:'blocked'}]});
 const i=new LocalScheduler({...base,idleRetryLimit:3,registry:{runTurn:async(_,input)=>{idleCalls++;if(idleCalls>1)assert.match(input.prompt,/自动跟进/);return ok('SKIP');}}});
 await i.runAgentTurn(idle,leader);await settle(i);assert.equal(idleCalls,4);
 assert.ok((await store.listMessages(idle.conversationId)).filter(m=>m.type==='SYSTEM').every(m=>m.internal));
 console.log('connection recovery: fresh context, durable text, bounded retries, pause, explicit reset, blocked receipts and internal prompt delivery passed');
} finally {await store.close();await rm(dir,{recursive:true,force:true});}
