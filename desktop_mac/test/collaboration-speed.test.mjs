import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {parseLeaderControl} from '../dist/orchestration/control.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-speed-'));
const store=new LocalStore(dir);await store.init();
const discovered=['codex','claude-code','qoder-cn'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
const agents=await store.syncDiscoveredAgents(discovered),[leader,worker,peer]=discovered.map(d=>agents.find(a=>a.kind===d.kind));
const me=await store.currentUser();
const base={store,idleRetryLimit:0,teamMonitorIntervalMs:0,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}};
const ok=message=>({ok:true,message,steps:[],metrics:{iterations:1,sideEffects:false}});
const encoded=control=>'实际检查与安排。\n'+JSON.stringify({control});
const item=(id,extra={})=>({id,assignment:'处理独立输入',candidates:[worker.userId],dependsOn:[],outputs:[`draft/${id}.txt`],acceptance:'核对实际文件',readOnly:false,...extra});
const review=id=>({action:'review',workId:id,verdict:'pass',evidence:`实际检查 ${id} 文件`});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(s){for(let i=0;i<400;i++){if(!s.runtimeSnapshot().agents.length&&!s.idleChecks.size){await sleep(5);if(!s.runtimeSnapshot().agents.length&&!s.idleChecks.size)return;}await sleep(5);}throw Error('did not settle');}
async function conversation(name,workPlan=[]){let t=await store.createConversation({name,memberIds:agents.map(a=>a.userId),leaderId:leader.userId,charter:{mode:'execution',instructions:'保留原件，允许独立报告'}});return store.updateConversation(t.conversationId,{workPlan});}
try {
 const batch={action:'batch',actions:[review('a'),review('b'),{action:'plan',work:[item('next',{dependsOn:['a','b']})]}]};
 assert.equal(parseLeaderControl(encoded(batch)).control.actions.length,3);
 for(const actions of [[],[review('a'),{action:'stop'}],[{action:'batch',actions:[review('a')]}],[review('a'),{action:'review',workId:'b',verdict:'pass'}],Array(21).fill(review('a'))]) {
  assert.equal(parseLeaderControl(encoded({action:'batch',actions})).control,undefined,'invalid batches must never execute partially');
 }
 // Compare model round trips for the same four real persisted decisions, independent of model speed.
 const decisions=[review('a'),review('b'),review('c'),{action:'plan',work:[item('next',{dependsOn:['a','b','c']})]}];
 const counts={};
 for(const batched of [false,true]){
  const t=await conversation(`roundtrips-${batched}`,['a','b','c'].map(id=>({...item(id),status:'review',assignmentId:id,completedAt:'v1'})));
  let calls=0,fills=0;const logs=[];
  const s=new LocalScheduler({...base,log:async(e,d)=>logs.push({e,...d}),registry:{runTurn:async()=>{
   const i=calls++;
   return ok(batched ? i===0?encoded({action:'batch',actions:decisions}):'SKIP' : i<2?encoded(decisions[i]):i===2?encoded({action:'batch',actions:decisions.slice(2)}):'SKIP');
  }}});
  // Isolate coordination costs; use the real planner to validate and persist every decision.
  s.fillWork=async()=>{fills++;};
  await s.runAgentTurn(t,leader);await settle(s);
  counts[batched?'batch':'single']=calls;
  const current=await store.getConversation(t.conversationId);
  assert.ok(current.workPlan.filter(w=>w.id!=='next').every(w=>w.status==='done'));
  assert.equal(current.workPlan.find(w=>w.id==='next').status,'queued');
  if(batched){assert.ok(logs.some(l=>l.e==='work-batch-applied'&&l.applied===4));assert.equal((await store.listMessages(t.conversationId)).filter(m=>m.agentReply).length,1,'one visible delivery, raw batch retained');}
  assert.ok(logs.filter(l=>l.e==='turn-done').every(l=>l.durationMs>=0&&l.promptChars>0&&l.phase==='coordination'));
  const delivered=[];
  s.planner.deps.available=()=>true;s.planner.deps.busy=()=>false;s.planner.deps.deliver=async(t,a,m)=>delivered.push(m);
  await s.planner.fill(t.conversationId);
  assert.equal(delivered[0].coordination.workId,'next');assert.equal(delivered[0].coordination.phase,'proposal','batch does not bypass agreement');
 }
 assert.deepEqual(counts,{single:3,batch:1},'the last review and newly-unblocked plan share a turn instead of paying for a redundant acknowledgement');
 // An unrelated peer result must not throw away independent queued work; new owner input still wins.
 for(const event of ['system','peer-result','human','revision','changed-dependency','changed-target']){
  const old={...item('previous'),status:'active',assignmentId:'p'};
  const t=await conversation(event,[old]);let calls=0;
  const planned=item(event==='changed-target'?'previous':'next',event==='changed-dependency'?{dependsOn:['previous']}:{});
  const s=new LocalScheduler({...base,registry:{runTurn:async()=>{
   if(calls++)return ok('SKIP');
   const phase=event==='revision'?'revision':'result';
   if(event.startsWith('changed'))await store.updateConversation(t.conversationId,{workPlan:[{...old,status:'blocked',evidence:'new failure'}]});
   await store.appendMessage({conversationId:t.conversationId,clientMessageId:`new-${event}`,type:event==='system'?'SYSTEM':'USER',internal:event==='system',senderId:event==='human'?me.userId:peer.userId,content:event==='human'?'先别做，要求变了':'新工作结果',coordination:event==='human'?undefined:{id:'peer-result',workId:'previous',assigneeId:peer.userId,phase,brief:'独立工作'}});
   return ok(encoded({action:'plan',work:[planned]}));
  }}});s.fillWork=async()=>{};
  await s.runAgentTurn(t,leader);await settle(s);
  const plan=(await store.getConversation(t.conversationId)).workPlan;
  assert.equal(plan.some(w=>w.id===planned.id&&w.status==='queued'),['peer-result','system'].includes(event),event);
  assert.ok((await store.listMessages(t.conversationId)).some(m=>m.agentReply?.raw.includes('实际检查与安排')),'words are retained even if control conflicts');
 }
 // One stale review does not block independent checks; the next job stays locked on that stale dependency.
 const basis=['a','b'].map(id=>({...item(id),status:'review',assignmentId:id,completedAt:'v1'}));
 const mixed=await conversation('mixed',basis);let mixedCalls=0;
 const s=new LocalScheduler({...base,registry:{runTurn:async()=>{
  if(mixedCalls++)return ok('SKIP');
  await store.updateConversation(mixed.conversationId,{workPlan:[{...basis[0],assignmentId:'replacement',completedAt:'v2'},basis[1]]});
  return ok(encoded(batch));
 }}});s.fillWork=async()=>{};await s.runAgentTurn(mixed,leader);await settle(s);
 const mixedPlan=(await store.getConversation(mixed.conversationId)).workPlan;
 assert.equal(mixedPlan.find(w=>w.id==='a').status,'review');assert.equal(mixedPlan.find(w=>w.id==='b').status,'done');
 assert.ok(!mixedPlan.some(w=>w.id==='next'),'changed dependency prevents applying stale plan');
 // Cancellation during a batch stops all subsequent decisions.
 const stop=await conversation('cancel-between-actions',basis);const cancel=new LocalScheduler({...base,registry:{}});cancel.fillWork=async()=>{};
 let valid=true;const actualReview=cancel.planner.review.bind(cancel.planner);
 cancel.planner.review=async(...args)=>{await actualReview(...args);valid=false;};
 await cancel.applyLeaderControl(stop,leader,encoded(batch),null,false,basis,async()=>valid);
 assert.equal((await store.getConversation(stop.conversationId)).workPlan.find(w=>w.id==='b').status,'review');
 // Agreement is saved and worker executes immediately without waking the idle leader.
 const agreed=await conversation('accepted-no-roundtrip');
 const proposal={id:'agreement',workId:'job',assigneeId:worker.userId,phase:'proposal',brief:'读取并报告，不改原件'};
 await store.appendMessage({conversationId:agreed.conversationId,clientMessageId:'proposal',senderId:leader.userId,mentions:[worker.userId],content:proposal.brief,coordination:proposal});
 await store.updateConversation(agreed.conversationId,{workPlan:[{...item('job'),status:'active',assignmentId:'agreement',assigneeId:worker.userId}]});
 let workerCalls=0,leaderCalls=0;const prompts=[];
 const fast=new LocalScheduler({...base,registry:{runTurn:async(d,input)=>{
  if(d.kind===leader.kind){leaderCalls++;return ok('已收到结果，准备核查');}
  prompts.push(input.prompt);
  if(workerCalls++===0){assert.equal(input.discussionOnly,true);return ok('同意，我按这个方案执行：直接从原图裁取第7题可见残片、保留原有断边，不生成新内容，先核实范围内有无手写重叠再决定是否需要清除，输出到 drafts/xiaocc/0954_q07_visible.png。');}
  assert.equal(leaderCalls,0,'acceptance must not wake leader');assert.equal(input.discussionOnly,false);
  return ok('实际读取完成，报告待验收');
 }}});
 await fast.runAgentTurn(agreed,worker);await settle(fast);
 assert.equal(workerCalls,2);assert.equal(leaderCalls,1,'result still wakes leader');
 assert.ok(prompts[0].includes('保留原件，允许独立报告'));assert.ok(prompts[0].length<prompts[1].length);
 assert.deepEqual((await store.listMessages(agreed.conversationId)).filter(m=>m.coordination).map(m=>m.coordination.phase),['proposal','accepted','result']);
 const rejected={...proposal,phase:'revision'};
 const msg=await store.appendMessage({conversationId:agreed.conversationId,clientMessageId:'revision',senderId:worker.userId,mentions:[leader.userId],content:'有疑问',coordination:rejected});
 assert.deepEqual((await fast.pickTargets(await store.getConversation(agreed.conversationId),msg)).map(a=>a.userId),[leader.userId]);
 console.log(JSON.stringify({test:'collaboration-speed',roundTrips:counts,proposalChars:prompts[0].length,executionChars:prompts[1].length,checks:'stale inputs, per-item review, dependencies, cancellation, durable replies, agreement and objections passed'}));
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
