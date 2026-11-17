import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from './tmp.mjs';
import {selectGroupContext,groupContextNeedsReset} from '../dist/orchestration/group-context.js';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {setMainLanguage} from '../dist/i18n.js';

const message=(seq,content,extra={})=>({seq,messageId:`m${seq}`,senderId:'human',type:'USER',content,mentions:[],...extra});
const conversation={type:'GROUP',members:[],workPlan:[{assignmentId:'active',status:'running'}]};
const humans=new Set(['human']);
const messages=[message(1,'以前的旅游讨论'),message(2,'不得向 GitHub 推送'),message(3,'相关附件',{attachments:[{name:'需求.pdf',kind:'file'}]}),
 message(4,'继续修改群聊',{replyTo:'m3'}),message(5,'当前执行证据',{coordination:{id:'active'}}),message(6,'改吧')];
const selected=await selectGroupContext(messages,humans,conversation,async prompt=>{
 const data=JSON.parse(prompt.split('\n').at(-1));
 assert.equal(data.current.seq,6);assert.ok(!data.candidates.some(m=>m.seq===5),'in-flight work cannot be excluded');
 return {ok:true,text:'```json\n{"excludeSeqs":[1,3]}\n```'};
});
assert.deepEqual(selected,{anchorSeq:6,excludedSeqs:[1]},'retain attachments referenced by retained history');
await assert.rejects(()=>selectGroupContext(messages,humans,conversation,async()=>({ok:true,text:'{"excludeSeqs":[6]}'})),/invalid/,'latest request cannot be excluded');
await assert.rejects(()=>selectGroupContext(messages,humans,conversation,async()=>({ok:true,text:'{"excludeSeqs":["1"]}'})),/invalid/);
await assert.rejects(()=>selectGroupContext(messages,humans,conversation,async()=>({ok:false,text:'unavailable'})),/unavailable/);
assert.equal(groupContextNeedsReset(selected,{providerThreadId:'old',messageSyncedSeq:4}),true);
assert.equal(groupContextNeedsReset(selected,{providerThreadId:'clean',messageSyncedSeq:4,groupContext:selected}),false);
assert.equal(groupContextNeedsReset(selected,{providerThreadId:'not-yet-delivered',messageSyncedSeq:0}),false);
assert.equal(groupContextNeedsReset(undefined,{providerThreadId:'old'}),false);
assert.equal(groupContextNeedsReset(selected,null),false);
assert.equal(groupContextNeedsReset({anchorSeq:8,excludedSeqs:[]},{providerThreadId:'filtered',messageSyncedSeq:7,groupContext:selected}),true,'returning to a prior topic must replay newly relevant old history');
setMainLanguage('en');
try {
 await selectGroupContext([message(1,'Old trip'),message(2,'Fix group context')],humans,{type:'GROUP'},async prompt=>{
  assert.doesNotMatch(prompt,/[一-鿿]/,'English classifier instructions');return {ok:true,text:'{"excludeSeqs":[1]}'};
 });
} finally {setMainLanguage('zh');}

// Real scheduler/store: old provider history is rebuilt, protected instructions
// and current work survive, then normal continuations reuse the clean thread.
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-group-context-'));
const store=new LocalStore(dir);await store.init();
try {
 const discovered=['codex','claude-code'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
 const agents=await store.syncDiscoveredAgents(discovered),[leader,worker]=discovered.map(d=>agents.find(a=>a.kind===d.kind));
 const me=await store.currentUser();
 const conv=await store.createConversation({name:'群聊筛选',memberIds:[leader.userId,worker.userId],leaderId:leader.userId,charter:{mode:'discussion'}});
 const append=async(content,extra={})=>store.appendMessage({conversationId:conv.conversationId,clientMessageId:Math.random().toString(),senderId:me.userId,type:'USER',content,...extra});
 const old=await append('无关旅游：明天去杭州');
 await append('没有确认，不得推送 GitHub');
 const current=await append('请修改群聊上下文筛选');
 await store.saveAgentSession({conversationId:conv.conversationId,agentUserId:leader.userId,providerThreadId:'tainted',messageSyncedSeq:current.seq,memoryIsolated:false});
 const turns=[],events=[];let asks=0,fail=false;
 const scheduler=new LocalScheduler({store,idleRetryLimit:0,teamMonitorIntervalMs:0,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async(event,detail)=>events.push({event,...detail}),registry:{
  askOnce:async()=>{asks++;return fail?{ok:false,text:'offline'}:{ok:true,text:JSON.stringify({excludeSeqs:[old.seq]})};},
  runTurn:async(_agent,input)=>{turns.push(input);return {ok:true,message:'SKIP',threadId:input.threadId??'clean',steps:[],metrics:{iterations:1,sideEffects:false}};}
 }});
 scheduler.engagedConversations.add(conv.conversationId);
 await scheduler.runAgentTurn(await store.getConversation(conv.conversationId),leader);
 assert.equal(turns[0].threadId,undefined,'cannot resume a transcript containing excluded history');
 assert.doesNotMatch(turns[0].prompt,/无关旅游/);
 assert.match(turns[0].prompt,/没有确认，不得推送 GitHub/);
 assert.match(turns[0].prompt,/请修改群聊上下文筛选/);
 assert.ok(events.some(e=>e.event==='provider-thread-discarded'&&e.reason==='group-context-filtered'));
 assert.deepEqual((await store.listMessages(conv.conversationId,{limit:100})).find(m=>m.seq===old.seq).content,old.content,'history is not deleted');
 await store.appendMessage({conversationId:conv.conversationId,clientMessageId:'peer',senderId:worker.userId,content:'补充相关结果'});
 await scheduler.runAgentTurn(await store.getConversation(conv.conversationId),leader);
 assert.equal(turns[1].threadId,'clean');assert.equal(asks,1,'no classifier per Agent reply');
 fail=true;await append('新请求：核对文件');
 await scheduler.runAgentTurn(await store.getConversation(conv.conversationId),leader);
 assert.ok(events.some(e=>e.event==='group-context-selection-failed'),'classifier errors are recorded and do not block execution');
 assert.match(turns.at(-1).prompt,/新请求：核对文件/);
 assert.equal(turns.at(-1).threadId,undefined,'fallback restores previously excluded history in a fresh thread');
 assert.match(turns.at(-1).prompt,/无关旅游/,'failed selection conservatively replays the original evidence');
 // A long group must rebuild from recent history, including the current request.
 const originalList=store.listMessages.bind(store);
 const long=Array.from({length:1002},(_,i)=>({...message(i+1,i===1001?'最新请求必须存在':`历史 ${i+1}`),senderId:me.userId}));
 store.listMessages=async(_id,options={})=>options.afterSeq!==undefined?long.filter(m=>m.seq>options.afterSeq).slice(0,options.limit??200):long.slice(-(options.limit??200));
 try {
  const rebuilt=await scheduler.buildPrompt(await store.getConversation(conv.conversationId),leader,{workspacePath:dir,sharesKnowledge:false},0,undefined);
  assert.equal(rebuilt.upToSeq,1002);assert.match(rebuilt.dialogue,/最新请求必须存在/);assert.doesNotMatch(rebuilt.dialogue,/历史 1\n/);
 } finally {store.listMessages=originalList;}
 fail=false;
 const switched=await append('切换话题：修复阿钉');
 const key=scheduler.directionKey(conv.conversationId,leader.userId);
 scheduler.activeTurnInputs.set(key,{upToSeq:current.seq,steeredThrough:current.seq,steers:[],steerChain:Promise.resolve()});
 scheduler.deps.registry.steer=async()=>{throw Error('must not steer into a contaminated transcript');};
 assert.equal(await scheduler.steerCurrentTurn(await store.getConversation(conv.conversationId),leader,switched),false);
 assert.ok(events.some(e=>e.event==='turn-steer-deferred'&&e.reason==='group-context-filtered'));
 scheduler.activeTurnInputs.delete(key);
 await scheduler.shutdown();
} finally {await store.close();await rm(dir,{recursive:true,force:true});}
console.log('group context: semantic exclusions, references, clean provider resume, cached classification, conservative failure');
