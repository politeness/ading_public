import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from './tmp.mjs';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {stateDelta,FULL_STATE_EVERY} from '../dist/orchestration/delivered-state.js';

// Send only changes: full content for a new thread, say "unchanged" when nothing changed, send only what changed otherwise, and resend the full content every few rounds to avoid drift after vendor compaction
{
 const key=item=>item.id,a={id:'a',status:'queued'},b={id:'b',status:'queued'};
 let state=stateDelta([a,b],key,undefined);assert.equal(state.delta.kind,'full');
 state=stateDelta([a,b],key,state.next);assert.deepEqual(state.delta,{kind:'same',total:2});
 state=stateDelta([{...a,status:'done'},b],key,state.next);assert.deepEqual(state.delta,{kind:'changed',changed:[{...a,status:'done'}],removed:[],total:2});
 state=stateDelta([b],key,state.next);assert.deepEqual(state.delta,{kind:'changed',changed:[],removed:['a'],total:1});
 let turns=state.next;for(let i=0;i<FULL_STATE_EVERY-4;i++)turns=stateDelta([b],key,turns).next;
 assert.equal(stateDelta([b],key,turns).delta.kind,'full','a full copy goes out periodically');
}

const dir=await mkdtemp(path.join(os.tmpdir(),'ading-leader-sessions-'));
const store=new LocalStore(dir);await store.init();
try {
 const discovered=['codex','claude-code'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
 const agents=await store.syncDiscoveredAgents(discovered),[leader,worker]=discovered.map(d=>agents.find(a=>a.kind===d.kind));
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const turns=[];let script=[];
 const ok=message=>({ok:true,message,steps:[],metrics:{iterations:1,sideEffects:false}});
 const scheduler=new LocalScheduler({store,idleRetryLimit:0,teamMonitorIntervalMs:0,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{},
  registry:{runTurn:async(agent,input)=>{
   const executing=input.fullAccess&&!input.discussionOnly,threadId=input.threadId??`thread-${turns.length+1}`;
   turns.push({agent:agent.kind,executing,threadId:input.threadId,assigned:threadId,prompt:input.prompt});
   return {...ok(script.shift()??'SKIP'),threadId};
  }}});
 const settle=async()=>{for(let i=0;i<600;i++){await sleep(5);if(i>20&&!scheduler.runtimeSnapshot().agents.length&&!scheduler.pendingTurns.size)return;}throw Error('timeout');};
 const conversation=await store.createConversation({name:'分工',memberIds:[leader.userId,worker.userId],leaderId:leader.userId,charter:{mode:'execution'}});
 const id=conversation.conversationId;
 scheduler.engagedConversations.add(id);

 // First coordination round: the Leader assigns work to itself
 script=[JSON.stringify({control:{action:'plan',work:[{id:'own',assignment:'读取样张并写报告',candidates:[leader.userId],dependsOn:[],outputs:[],acceptance:'报告存在',readOnly:false}]}}),'样张已检查，证据在 draft/own.txt','SKIP'];
 await scheduler.runAgentTurn(await store.getConversation(id),leader);await settle();

 const [coordination,execution]=turns;
 assert.equal(execution.executing,true,'then the Leader executes');
 assert.equal(execution.threadId,undefined,'its own work starts a provider session of its own');
 assert.match(execution.prompt,/读取样张并写报告/,'and is told the assignment');
 assert.doesNotMatch(execution.prompt,/你是这个会话的负责人/,'the coordination rules stay in the coordination thread');
 assert.equal((await store.getAgentSession(id,leader.userId)).providerThreadId,coordination.assigned,'the coordination thread is not taken over');
 assert.equal((await store.getAgentSession(id,`${leader.userId}::assignment:own`))?.providerThreadId,execution.assigned,'the work session is kept for rework');

 // Back to coordination: resume the clean thread, see the result it handed back, send only changes
 const wake=async(cid,content)=>{turns.length=0;script=['SKIP'];await store.appendMessage({conversationId:id,clientMessageId:cid,senderId:worker.userId,content});await scheduler.runAgentTurn(await store.getConversation(id),leader);await settle();return turns[0];};
 const back=await wake('peer-1','我这边做完了');
 assert.equal(back.executing,false,'this is a coordination turn');
 assert.equal(back.threadId,coordination.assigned,'it resumes the coordination thread');
 assert.match(back.prompt,/样张已检查，证据在 draft\/own\.txt/,'the result reaches the coordination thread');
 assert.match(back.prompt,/持久化工作队列的变化/,'only the changed queue entries are sent');
 assert.match(back.prompt,/已经在本会话前面给出/,'delivered rules are not repeated');
 assert.doesNotMatch(back.prompt,/方法选择：/,'not even the method section');
 assert.ok(back.prompt.length<coordination.prompt.length,'and the coordination prompt shrinks');

 // Woken again with no changes: just say unchanged; results already handed back are not repeated
 const quiet=await wake('peer-2','我这边空闲');
 assert.equal(quiet.threadId,coordination.assigned);
 assert.match(quiet.prompt,/持久化工作队列没有变化/,'an unchanged queue is not re-sent');
 assert.doesNotMatch(quiet.prompt,/样张已检查/,'a result already seen is not repeated');

 console.log('leader sessions: own work in its own session, results reach coordination, only changes are re-sent');
} finally {await store.close();await rm(dir,{recursive:true,force:true});}
