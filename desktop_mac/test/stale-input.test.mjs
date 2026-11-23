// Regression: a discussion paused while the Leader was offline must not be revived for input an
// Agent already answered, an Agent reply from a sender not known locally is never owner input,
// and a computer taking over coordination answers the input the previous coordinator left.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';
import {inputAnswered,isHumanInput,latestUnansweredInput} from '../dist/orchestration/human-input.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,what='condition'){for(let i=0;i<1000;i++){if(await fn())return;await sleep(5);}throw Error('timeout: '+what);}
const ok=message=>({ok:true,message,steps:[],metrics:{iterations:1,sideEffects:false}});

// Pure rules.
{
 const humans=new Set(['owner','ghost']);
 const reply={seq:2,senderId:'ghost',type:'USER',mentions:[],agentReply:{turnId:'t',inputSeq:1,raw:'',newerInput:false}};
 assert.equal(isHumanInput(reply,humans),false,'an Agent reply is not owner input even from an unknown sender');
 assert.equal(isHumanInput({seq:1,senderId:'owner',type:'USER',mentions:[]},humans),true);
 const discussion={...reply,agentReply:{...reply.agentReply,lane:'brainstorm'}};
 assert.equal(inputAnswered([discussion],1),false,'a discussion turn does not settle the input');
 assert.equal(inputAnswered([reply],1),true);
 const messages=[{seq:1,senderId:'owner',type:'USER',mentions:[]},reply];
 assert.equal(latestUnansweredInput(messages,humans),undefined);
 const image={seq:3,senderId:'owner',type:'USER',mentions:[],content:''};
 assert.equal(latestUnansweredInput([...messages,image],humans)?.seq,3);
 assert.equal(latestUnansweredInput([...messages,{...image,mentions:['a']}],humans),undefined,'@ input belongs to the mentioned Agent');
}

async function computer(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'ading-stale-input-'));
 const store=new LocalStore(path.join(dir,'data'));await store.init();
 const discovered=['codex','claude-code'].map(kind=>({kind,localUuid:kind,executablePath:'/mock'}));
 const found=await store.syncDiscoveredAgents(discovered);
 const agents=discovered.map(d=>found.find(a=>a.kind===d.kind));
 const calls=[],events=[];let ready=false;
 const registry={adapterFor:()=>({supportsParallelWork:true}),runTurn:async(d,input)=>{const phase=input.prompt.match(/当前是分工前共同讨论阶段：(\w+)/)?.[1];calls.push({d,input,phase});return ok(phase?'意见。':'SKIP');},cancel:()=>true};
 const scheduler=new ConversationScheduler({store,registry,idleRetryLimit:0,teamMonitorIntervalMs:0,concurrentInbox:true,brainstormTimeoutMs:2000,
  resolveDiscovered:id=>discovered.find(d=>found.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>ready,
  syncer:{ensureSynced:async()=>[]},resolveWorkspace:async c=>{const workspacePath=path.join(dir,c.conversationId);await mkdir(workspacePath,{recursive:true});return{workspacePath,sharesKnowledge:false};},
  broadcast:()=>{},log:async(event,details)=>events.push({event,...details}),requestPermission:async()=>true});
 const owner=(await store.currentUser()).userId;
 // Leader = agents[0]; "ghost" stands for a shared Agent from another account not yet in this computer's Agent list.
 const base=await store.createConversation({name:'狗剩吧',memberIds:agents.map(a=>a.userId),leaderId:agents[0].userId});
 const t=await store.importConversation({...base,conversationId:'t_stale_input',members:[...base.members,{userId:'u_ghost',role:'ENGINEER',paused:false,lastReadSeq:0}]});
 const say=(senderId,content,extra={})=>store.appendMessage({conversationId:t.conversationId,clientMessageId:`m-${Math.random()}`,senderId,type:'USER',mentions:[],content,...extra});
 // The running app has already seen this conversation while its Leader was elsewhere (not a restart).
 const observe=async()=>{scheduler.forConversation(t.conversationId);await scheduler.teamAvailabilityChanged();};
 return {dir,store,agents,calls,events,scheduler,owner,t,say,observe,setReady:v=>{ready=v;},
  close:async()=>{await scheduler.shutdown();await store.close();await rm(dir,{recursive:true,force:true});}};
}
const waitingState=(leaderId,inputSeq)=>({phase:'waiting',revision:3,round:1,probes:0,attempts:0,leaderId,inputSeq,participants:[],responses:{},turnDurationsMs:{},evidenceReady:false,reason:'Leader当前不可用，尚未完成方案讨论。'});

// 1. The incident: the discussion paused while the Leader was offline; meanwhile the owner's last
// message was answered (by an Agent this computer doesn't know). The Leader coming back must not
// restart the discussion on that finished topic.
{
 const c=await computer();
 try{
  const first=await c.say(c.owner,'画个鹈鹕骑自行车');
  const last=await c.say(c.owner,'也没啥特别的啊');
  await c.say('u_ghost','要特别的话可以加喉囊弹簧。',{agentReply:{turnId:'r1',inputSeq:last.seq,raw:'',newerInput:false}});
  await c.store.updateConversation(c.t.conversationId,{brainstorm:waitingState(c.agents[0].userId,first.seq)});
  await c.observe();
  c.setReady(true);
  await c.scheduler.teamAvailabilityChanged();
  await until(async()=>(await c.store.getConversation(c.t.conversationId)).brainstorm.phase==='ready','stale discussion is dropped');
  await sleep(80);
  assert.equal(c.calls.length,0,'no Agent replies to the finished topic');
  assert.ok(c.events.some(e=>e.event==='brainstorm-stale-dropped'));
  assert.ok(!c.events.some(e=>e.event==='unanswered-input-resumed'));
 }finally{await c.close();}
}

// 2. A new owner message (an image) left unanswered when coordination moved is handled by the new
// coordinator, and the discussion is about that message, not the old one.
{
 const c=await computer();
 try{
  const first=await c.say(c.owner,'画个鹈鹕骑自行车');
  const last=await c.say(c.owner,'也没啥特别的啊');
  await c.say('u_ghost','要特别的话可以加喉囊弹簧。',{agentReply:{turnId:'r1',inputSeq:last.seq,raw:'',newerInput:false}});
  const image=await c.say(c.owner,'这张排行榜你们怎么看');
  await c.store.updateConversation(c.t.conversationId,{brainstorm:waitingState(c.agents[0].userId,first.seq)});
  await c.observe();
  c.setReady(true);
  await c.scheduler.teamAvailabilityChanged();
  await until(()=>c.calls.some(x=>x.phase==='ideas'),'discussion restarts for the new input');
  assert.equal((await c.store.getConversation(c.t.conversationId)).brainstorm.inputSeq,image.seq);
 }finally{await c.close();}
}

// 3. Takeover with no discussion pending: the unanswered owner message reaches the Leader once.
{
 const c=await computer();
 try{
  await c.store.updateConversation(c.t.conversationId,{brainstorm:{...waitingState(c.agents[0].userId,0),phase:'ready',reason:undefined}});
  const image=await c.say(c.owner,'这张排行榜你们怎么看');
  // Real delivery persists the unfinished input before dispatch; observing history alone is not delivery.
  await c.store.oweMessage(c.t.conversationId,image.messageId);
  await c.observe();
  assert.equal(c.calls.length,0,'the Leader is not on this computer yet');
  c.setReady(true);
  await c.scheduler.teamAvailabilityChanged();
  await until(()=>c.calls.some(x=>!x.phase&&x.d.kind==='codex'),'the Leader answers the left-over message');
  assert.ok(c.events.some(e=>e.event==='unanswered-input-resumed'&&e.seq===image.seq));
  assert.ok(c.calls.filter(x=>x.d.kind==='codex'&&!x.phase).length===1,'the Leader answers the recovered input exactly once');
  assert.ok(c.calls.every(x=>!x.phase),'recovery does not restart the completed planning phase');
 }finally{await c.close();}
}
console.log('stale-input ok');
