import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ok=message=>({ok:true,threadId:'resumed-thread',message,steps:[],metrics:{iterations:1,sideEffects:false}});
const stop=JSON.stringify({control:{action:'stop',reason:'Finished'}});
async function fixture({group=false,phase='ready',reason,answered=false,legacy=false,paused=false,ownerPaused=false,readyKind='codex',maxConcurrentWorkPerAgent=1}={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'ading-reconnect-'));
  const store=new LocalStore(dir);await store.init();
  const found=[{kind:'codex',localUuid:'c',executablePath:'/mock'},{kind:'qoder',localUuid:'q',executablePath:'/mock'}];
  const agents=await store.syncDiscoveredAgents(found),leader=agents.find(a=>a.kind==='codex'),peer=agents.find(a=>a.kind==='qoder');
  const c=await store.createConversation({name:'Reconnect fixture',memberIds:group?[leader.userId,peer.userId]:[leader.userId],leaderId:leader.userId});
  const input=await store.appendMessage({conversationId:c.conversationId,clientMessageId:'existing-input',senderId:(await store.currentUser()).userId,content:'Continue the approved task, preserving existing output.'});
  if(group)await store.updateConversation(c.conversationId,{brainstorm:{phase,revision:3,round:1,probes:0,attempts:0,inputSeq:input.seq,leaderId:leader.userId,participants:[leader.userId],responses:{},turnDurationsMs:{},evidenceReady:false,reason}});
  if(answered) {
    await store.appendMessage({conversationId:c.conversationId,clientMessageId:'existing-answer',senderId:leader.userId,content:'The requested work is complete.',...(!legacy?{agentReply:{turnId:'existing-answer',inputSeq:input.seq,raw:'The requested work is complete.',newerInput:false}}:{})});
    for(const agent of agents)await store.markProcessed(c.conversationId,agent.userId,input.seq);
  }
  if(paused)await store.setConversationPaused(c.conversationId,true);
  if(ownerPaused)await store.syncConversationMembers(c.conversationId,c.members.map(m=>({...m,ownerPaused:true})));
  let ready=false,pending=false;const calls=[],events=[];
  const scheduler=new ConversationScheduler({store,teamMonitorIntervalMs:0,idleRetryLimit:0,connectionRetryDelayMs:1,maxConcurrentWorkPerAgent,
    isAgentReady:a=>ready&&(readyKind==='all'||a.kind===readyKind),isAgentPending:()=>pending,
    resolveDiscovered:id=>found.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),
    registry:{cancel:()=>true,runTurn:async(d,input)=>{calls.push({kind:d.kind,input});return ok(group?stop:'Finished after checking the existing output.');}},
    syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),broadcast:()=>{},log:async(event,data)=>events.push({event,...data})});
  const settled=async()=>{for(let i=0;i<300;i++){await sleep(5);if(!scheduler.runtimeSnapshot().agents.length){await sleep(15);if(!scheduler.runtimeSnapshot().agents.length)return;}}throw Error('Scheduler did not settle');};
  return {store,c,input,leader,peer,scheduler,calls,events,settled,
    ready:value=>{ready=value;},pending:value=>{pending=value;},
    failure:async(error='stream disconnected',agent=leader)=>{
      await store.appendMessage({conversationId:c.conversationId,clientMessageId:'network-failure-'+agent.userId,senderId:agent.userId,type:'SYSTEM',content:error,failed:true});
      await store.saveAgentSession({conversationId:c.conversationId,agentUserId:agent.userId,providerThreadId:'interrupted-thread',recovery:{attempts:4,state:'blocked',error,freshContext:false}});
    },
    close:async()=>{await scheduler.shutdown();await store.close();await rm(dir,{recursive:true,force:true});}};
}

// Red -> green, repeated status broadcasts and a stand-in Leader cannot revive completed history.
for(const legacy of [false,true]) for(const readyKind of ['codex','qoder']) {
  const f=await fixture({group:true,phase:'ideas',answered:true,legacy,readyKind});
  try {
    await f.scheduler.teamAvailabilityChanged();
    f.ready(true);await f.scheduler.teamAvailabilityChanged(readyKind);
    await f.scheduler.teamAvailabilityChanged();
    f.ready(false);await f.scheduler.teamAvailabilityChanged();f.ready(true);await f.scheduler.teamAvailabilityChanged(readyKind);
    await f.settled();assert.equal(f.calls.length,0);
    assert.ok(!f.events.some(e=>e.event==='team-coordination-taken'));
  } finally {await f.close();}
}
// An unexplained historical planning marker alone does not establish a disconnected task.
{
  const f=await fixture({group:true,phase:'ideas',readyKind:'qoder'});
  try {await f.scheduler.teamAvailabilityChanged();f.ready(true);await f.scheduler.teamAvailabilityChanged('qoder');await f.settled();assert.equal(f.calls.length,0);}
  finally {await f.close();}
}
// A connection failure remains resumable even if it saved partial text first.
for(const group of [false,true]) {
  const f=await fixture({group});
  try {
    await f.store.appendMessage({conversationId:f.c.conversationId,clientMessageId:'partial',senderId:f.leader.userId,content:'A draft was saved, verification is unfinished.',agentReply:{turnId:'partial',inputSeq:f.input.seq,raw:'A draft was saved, verification is unfinished.',newerInput:false}});
    await f.failure();await f.scheduler.teamAvailabilityChanged('codex');assert.equal(f.calls.length,0);
    f.ready(true);await Promise.all([f.scheduler.teamAvailabilityChanged('codex'),f.scheduler.teamAvailabilityChanged()]);await f.settled();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].input.threadId,'interrupted-thread');
    assert.match(f.calls[0].input.prompt,/不要盲目重做|Don't blindly redo/);
    assert.equal((await f.store.getAgentSession(f.c.conversationId,f.leader.userId)).recovery,undefined);
    await f.scheduler.teamAvailabilityChanged('codex');await f.settled();assert.equal(f.calls.length,1,'A finished retry does not replay on another successful probe');
  } finally {await f.close();}
}
// Other failures, user decisions and explicit pauses are not network recovery permission.
for(const error of ['permission denied','quota exceeded','not logged in','context_length_exceeded']) {
  const f=await fixture();try{await f.failure(error);f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');await f.settled();assert.equal(f.calls.length,0,error);}finally{await f.close();}
}
for(const flag of ['paused','ownerPaused']) {
  const f=await fixture({[flag]:true});try{await f.failure();f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');await f.settled();assert.equal(f.calls.length,0,flag);}finally{await f.close();}
}
{
  const f=await fixture({group:true,phase:'waiting',reason:'Please approve the next operation.'});
  try{await f.scheduler.teamAvailabilityChanged();f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');await f.settled();assert.equal(f.calls.length,0);}finally{await f.close();}
}
// Persisted discussion network failures resume their planning stage without a new human message.
{
  const f=await fixture({group:true,phase:'waiting',reason:'stream disconnected'});
  try {
    await f.scheduler.teamAvailabilityChanged();f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');await f.settled();
    const calls=f.calls.length;assert.ok(calls>0);assert.ok(f.events.some(e=>e.event==='brainstorm-turn-start'));
    const finished=await f.store.getConversation(f.c.conversationId);assert.ok(finished.paused||finished.brainstorm.phase==='ready');
    await f.scheduler.teamAvailabilityChanged();await f.settled();assert.equal(f.calls.length,calls);
  } finally {await f.close();}
}
// The durable unfinished-input ledger still recovers an interrupted direct turn after restart.
{
  const f=await fixture();
  try {
    await f.store.oweMessage(f.c.conversationId,f.input.messageId);
    await f.store.saveAgentSession({conversationId:f.c.conversationId,agentUserId:f.leader.userId,providerThreadId:'interrupted-thread'});
    f.pending(true);await f.scheduler.redeliverUserMessage(f.input);assert.equal(f.calls.length,0);
    f.pending(false);f.ready(true);await f.scheduler.resumeReadyAgents();await f.scheduler.teamAvailabilityChanged('codex');await f.settled();
    assert.equal(f.calls.length,1);assert.equal((await f.store.listOwedMessages()).length,0);
    await f.scheduler.redeliverUserMessage(f.input);await f.settled();assert.equal(f.calls.length,1);
  } finally {await f.close();}
}
// Accepted output and later successful replies outrank stale failure records.
for(const completedPlan of [false,true]) {
  const f=await fixture({group:completedPlan});
  try {
    await f.failure();await f.store.appendMessage({conversationId:f.c.conversationId,clientMessageId:'completed',senderId:f.leader.userId,content:'Finished.',agentReply:{turnId:'completed',inputSeq:2,raw:'Finished.',newerInput:false}});
    if(completedPlan)await f.store.updateConversation(f.c.conversationId,{workPlan:[{id:'work',assignment:'Task',candidates:[f.leader.userId],dependsOn:[],outputs:[],acceptance:'Verified',readOnly:true,status:'done'}]});
    f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');await f.settled();assert.equal(f.calls.length,0);
  } finally {await f.close();}
}
// A Leader's accepted work resumes its own provider session; completed work never reopens.
for(const status of ['active','done']) {
  const f=await fixture({group:true});
  try {
    const assignment={id:'assignment-one',workId:'work-one',assigneeId:f.leader.userId,phase:'accepted',brief:'Verify saved output'};
    await f.store.updateConversation(f.c.conversationId,{workPlan:[{id:'work-one',assignment:'Verify saved output',candidates:[f.leader.userId],dependsOn:[],outputs:[],acceptance:'Verified',readOnly:true,status,assigneeId:f.leader.userId,assignmentId:assignment.id}]});
    await f.store.appendMessage({conversationId:f.c.conversationId,clientMessageId:'accepted-work',senderId:f.leader.userId,type:'TASK',content:'Work accepted',coordination:assignment});
    const key=`${f.leader.userId}::assignment:work-one`;
    await f.store.saveAgentSession({conversationId:f.c.conversationId,agentUserId:key,providerThreadId:'work-thread',recovery:{attempts:4,state:'blocked',error:'stream disconnected',freshContext:false}});
    f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');await f.settled();
    assert.equal(f.calls.length,status==='done'?0:1);
    if(status==='active')assert.equal(f.calls[0].input.threadId,'work-thread');
  } finally {await f.close();}
}
// Failed worker assignments are reconciled by the Leader, including isolated parallel sessions.
for(const maxConcurrentWorkPerAgent of [1,2]) {
  const f=await fixture({group:true,readyKind:'all',maxConcurrentWorkPerAgent});
  try {
    const assignment={id:'failed-assignment',workId:'failed-work',assigneeId:f.peer.userId,phase:'rejected',brief:'Unfinished after disconnect'};
    await f.store.updateConversation(f.c.conversationId,{workPlan:[{id:'failed-work',assignment:assignment.brief,candidates:[f.peer.userId],dependsOn:[],outputs:[],acceptance:'Verified',readOnly:true,status:'blocked',assigneeId:f.peer.userId,assignmentId:assignment.id}]});
    await f.failure('stream disconnected',f.peer);
    if(maxConcurrentWorkPerAgent>1) {
      await f.store.saveAgentSession({conversationId:f.c.conversationId,agentUserId:f.peer.userId});
      await f.store.saveAgentSession({conversationId:f.c.conversationId,agentUserId:`${f.peer.userId}::assignment:${assignment.id}`,providerThreadId:'sibling-thread',recovery:{attempts:4,state:'blocked',error:'stream disconnected',freshContext:false}});
    }
    await f.store.appendMessage({conversationId:f.c.conversationId,clientMessageId:'failed-assignment-message',senderId:f.peer.userId,type:'TASK',content:'Assignment blocked',coordination:assignment});
    f.ready(true);await f.scheduler.teamAvailabilityChanged('qoder');await f.settled();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'codex','Leader reconciles failure without blindly rerunning the worker');
  } finally {await f.close();}
}
// Explicit new input and Continue still work for an otherwise dormant historical group.
for(const action of ['input','continue']) {
  const f=await fixture({group:true,phase:'ideas'});
  try {
    await f.scheduler.teamAvailabilityChanged();f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');assert.equal(f.calls.length,0);
    if(action==='input')await f.scheduler.sendUserMessage({conversationId:f.c.conversationId,clientMessageId:'new-request',content:'Please continue now.'});
    else await f.scheduler.resumeConversation(f.c.conversationId);
    await f.settled();assert.ok(f.calls.length>0,action);
  } finally {await f.close();}
}
// A successful probe opens only tasks that may have been interrupted, not every historical conversation.
{
  const f=await fixture();
  try {
    const me=(await f.store.currentUser()).userId,dormant=[];
    for(let i=0;i<12;i++) {
      const group=i%2===1;
      const c=await f.store.createConversation({name:`Dormant ${i}`,memberIds:group?[f.leader.userId,f.peer.userId]:[f.leader.userId],leaderId:f.leader.userId});
      const input=await f.store.appendMessage({conversationId:c.conversationId,clientMessageId:`dormant-input-${i}`,senderId:me,content:'Old request'});
      await f.store.appendMessage({conversationId:c.conversationId,clientMessageId:`dormant-answer-${i}`,senderId:f.leader.userId,content:'Done.',agentReply:{turnId:`dormant-answer-${i}`,inputSeq:input.seq,raw:'Done.',newerInput:false}});
      // A different kind's connection failure is not evidence for this probe.
      if(group)await f.store.saveAgentSession({conversationId:c.conversationId,agentUserId:f.peer.userId,providerThreadId:'other-kind',recovery:{attempts:4,state:'blocked',error:'stream disconnected',freshContext:false}});
      dormant.push(c.conversationId);
    }
    const owedGroup=await f.store.createConversation({name:'Owed group',memberIds:[f.leader.userId,f.peer.userId],leaderId:f.leader.userId});
    const owedInput=await f.store.appendMessage({conversationId:owedGroup.conversationId,clientMessageId:'owed-input',senderId:me,content:'Unanswered request'});
    await f.store.oweMessage(owedGroup.conversationId,owedInput.messageId);
    await f.failure();
    const read=new Set(),list=f.store.listMessages.bind(f.store);
    f.store.listMessages=async(id,options)=>{read.add(id);return list(id,options);};
    f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');await f.settled();
    assert.ok(f.calls.some(call=>call.input.threadId==='interrupted-thread'),'the interrupted direct chat resumes');
    assert.ok(f.events.some(e=>e.event==='team-coordination-taken'&&e.conversation===owedGroup.conversationId),'owed group input is still picked up');
    assert.deepEqual(dormant.filter(id=>read.has(id)),[],'dormant conversations are not read');
    assert.equal(f.scheduler.conversations.size,2,'no scheduler is created for dormant conversations');
  } finally {await f.close();}
}
// Several recovered members of the verified kind restart an interrupted discussion once.
{
  const f=await fixture({group:true,phase:'waiting',reason:'stream disconnected',readyKind:'all'});
  try {
    const getUser=f.store.getUser.bind(f.store);
    f.store.getUser=async id=>{const user=await getUser(id);return user?.userId===f.peer.userId?{...user,kind:'codex'}:user;};
    await f.failure();await f.failure('stream disconnected',f.peer);
    const lane=f.scheduler.forConversation(f.c.conversationId);let discussions=0;
    lane.handleBrainstorm=async()=>{discussions++;return true;};
    f.ready(true);await f.scheduler.teamAvailabilityChanged('codex');await f.settled();
    assert.equal(discussions,1);
  } finally {await f.close();}
}
console.log('reconnect continuation: completed history stays idle; network interruptions, durable input and explicit continue resume; policy, pause and stale recovery boundaries passed');
