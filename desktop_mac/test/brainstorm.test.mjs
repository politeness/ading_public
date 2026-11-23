import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';
import {parseLeaderControl} from '../dist/orchestration/control.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<1000;i++){if(await fn())return;await sleep(5);}throw Error('timeout');}
const ok=message=>({ok:true,message,steps:[],metrics:{iterations:1,sideEffects:false}});
const ctl=c=>JSON.stringify({control:c});
async function harness(handler){
 const dir=await mkdtemp(path.join(os.tmpdir(),'ading-brainstorm-'));const store=new LocalStore(path.join(dir,'data'));await store.init();
 const discovered=['codex','claude-code','qoder-cn','qoder'].map(kind=>({kind,localUuid:kind,executablePath:'/mock'}));
 const found=await store.syncDiscoveredAgents(discovered);const agents=discovered.map(d=>found.find(a=>a.kind===d.kind));
 const calls=[],events=[];let scheduler;
 const registry={adapterFor:()=>({supportsParallelWork:true}),runTurn:async(d,input)=>{const phase=input.prompt.match(/当前是分工前共同讨论阶段：(\w+)/)?.[1];const call={d,input,phase};calls.push(call);return handler(call,{store,agents,scheduler,calls});},cancel:()=>true};
 scheduler=new ConversationScheduler({store,registry,idleRetryLimit:0,concurrentInbox:true,brainstormTimeoutMs:100,resolveDiscovered:id=>discovered.find(d=>found.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:a=>a.kind!=='qoder',syncer:{ensureSynced:async()=>[]},resolveWorkspace:async conversation=>{const workspacePath=path.join(dir,conversation.conversationId);await mkdir(workspacePath,{recursive:true});return{workspacePath,sharesKnowledge:false};},broadcast:(channel,payload)=>events.push({channel,payload}),log:async(event,details)=>events.push({event,...details}),requestPermission:async()=>true});
 return {dir,store,agents,scheduler,calls,events,create:()=>scheduler.createConversation({name:'共同方案',memberIds:agents.map(a=>a.userId),leaderId:agents[0].userId,initialMessage:'核对输入，形成报告，不修改原件'}),close:async()=>{await scheduler.shutdown();await until(()=>scheduler.runtimeSnapshot().agents.length===0);await store.close();await rm(dir,{recursive:true,force:true});}};
}
// Material disagreement opens review; early assignments still cannot execute.
let releaseReview;let concurrent=0,peak=0;
const h=await harness(async(call,{agents})=>{
 if(call.d.localUuid.includes('::inbox:'))return ok('成员正在复核方案，尚未正式执行。');
 if(call.phase){assert.equal(call.input.threadId,undefined);if(call.phase==='ideas'&&call.d.kind==='codex'){assert.equal(call.input.discussionOnly,false);assert.equal(call.input.communicationOnly,false);assert.equal(call.input.fullAccess,false);}else{assert.equal(call.input.discussionOnly,call.phase!=='probe');assert.equal(call.input.communicationOnly,call.phase!=='probe');}assert.equal(call.input.timeoutMs,100);}
 if(call.phase==='frame')return ok('兼容旧任务的框定阶段。');
 if(call.phase==='ideas'){concurrent++;peak=Math.max(peak,concurrent);await sleep(25);concurrent--;return ok('可并行核查，报告单独保存。'+(call.d.kind==='codex'?ctl({action:'assign',to:agents[1].userId,assignment:'禁止提前执行'}):''));}
 if(call.phase==='synthesize')return ok('方案：核查输入，保存独立报告，以实际证据验收。'+ctl({action:'brainstorm',decision:'revise',reason:'请复核报告证据是否足够'}));
 if(call.phase==='review'&&call.d.kind==='qoder-cn')await new Promise(r=>releaseReview=r);
 if(call.phase==='review')return ok('认可，核查与报告保存没有冲突。');
 if(call.phase==='decide')return ok('关键疑虑已解决，进入分工。'+ctl({action:'organize'}));
 return ok('已按方案完成交付。'+ctl({action:'stop',reason:'已交付'}));
});
try{
 const t=await h.create();await until(()=>releaseReview);
 assert.equal(peak,3,'leader evidence and peer ideas run concurrently');assert.ok(!h.calls.some(c=>!c.phase));assert.equal((await h.store.getConversation(t.conversationId)).workPlan,undefined,'early assign is not applied');
 assert.ok(!h.calls.some(c=>c.d.kind==='qoder'),'unavailable member never scheduled');
 const report=await h.scheduler.reportConversation(t.conversationId);assert.equal(report.report,true);assert.ok(h.calls.at(-1).d.localUuid.includes('::inbox:'),'report during peer review uses isolated inbox');
 releaseReview();await until(async()=>(await h.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');await until(()=>h.scheduler.runtimeSnapshot().agents.length===0);await sleep(30);
 // organize ends the joint discussion and returns to normal chat; it no longer launches an execution turn.
 assert.ok(!h.calls.some(c=>!c.phase),'organize does not start execution');
 const phases=h.calls.filter(c=>!c.d.localUuid.includes('::inbox:')).map(c=>c.phase);assert.equal(phases.filter(p=>p==='frame').length,0);assert.equal(phases.filter(p=>p==='review').length,2);assert.equal(phases.filter(p=>p==='decide').length,1);
 const msgs=await h.store.listMessages(t.conversationId);assert.equal(msgs[0].content,'核对输入，形成报告，不修改原件');assert.equal(msgs.filter(m=>m.agentReply?.lane==='brainstorm').length,7);assert.ok(msgs.some(m=>m.content==='可并行核查，报告单独保存。'));
 const reloaded=new LocalStore(path.join(h.dir,'data'));await reloaded.init();assert.equal((await reloaded.getConversation(t.conversationId)).brainstorm.phase,'ready');await reloaded.close();
 // One agent bypasses coordination and has ordinary tool access immediately.
 const solo=await h.scheduler.createConversation({name:'solo',memberIds:[h.agents[0].userId],initialMessage:'直接做'});await until(()=>h.calls.some(c=>c.input.workspacePath.endsWith(solo.conversationId)));const sc=h.calls.find(c=>c.input.workspacePath.endsWith(solo.conversationId));assert.equal(sc.phase,undefined);assert.equal(sc.input.discussionOnly,false);assert.ok(!sc.input.prompt.includes('你的角色：负责人')); 
}finally{releaseReview?.();await h.close();}
// Common path converges in parallel independent views -> leader synthesis, without a ceremonial framing/review round.
const fast=await harness(async c=>{if(c.phase==='synthesize'){assert.ok(c.input.prompt.includes('原始秒数不可直接比较为执行速度'));return ok('方法和验收已具体确认。'+ctl({action:'organize'}));}return ok('提出具体方法、首个验证和失败替代。');});
try{const t=await fast.create();await until(async()=>(await fast.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');const phases=fast.calls.filter(c=>c.phase).map(c=>c.phase);assert.deepEqual(phases,['ideas','ideas','ideas','synthesize']);assert.ok(!phases.includes('frame')&&!phases.includes('review')&&!phases.includes('decide'));}finally{await fast.close();}
// A final concrete plan is applied directly from synthesis; no second Leader planning turn is required.
let plannedConversation;
const directPlan=await harness(async(c,{agents})=>{
 if(c.phase==='synthesize')return {...ok('方案已收敛，直接启动首个可验收工作。'+ctl({action:'plan',work:[{id:'direct_sample',assignment:'按已确认方法制作一个样本，失败即停止',candidates:['leader'],dependsOn:[],outputs:['draft/direct_sample.txt'],acceptance:'读取样本并对照输入',readOnly:false,preAgreed:false}]})),threadId:`shared-${c.d.kind}`};
 if(!c.phase){assert.ok(c.input.prompt.includes('direct_sample'),'the first execution turn must already carry the final work and must not restate the plan');assert.equal(c.input.threadId,'shared-codex','the same Agent reuses the task-native session from plan discussion through the first sequential work');return {...ok('样本已提交。'),threadId:'shared-codex'};}
 return {...ok('提出具体方法、首个验证和失败替代。'),threadId:`shared-${c.d.kind}`};
});
try{plannedConversation=await directPlan.create();await until(async()=>{const t=await directPlan.store.getConversation(plannedConversation.conversationId);return !!t.workPlan?.length||t.brainstorm?.phase==='waiting';});const current=await directPlan.store.getConversation(plannedConversation.conversationId);assert.equal(current.brainstorm.phase,'ready',current.brainstorm.reason);assert.equal(current.charter?.mode,undefined,'no internal discussion/execution mode is recorded');assert.equal(current.workPlan[0].id,'direct_sample');assert.deepEqual(current.workPlan[0].candidates,[directPlan.agents[0].userId],'unique visible member name is normalized without another model round');assert.ok(!directPlan.calls.some(c=>!c.phase&&c.d.kind==='codex'&&!c.input.prompt.includes('direct_sample')));await directPlan.scheduler.stopConversation(plannedConversation.conversationId);}finally{await directPlan.close();}
// If every peer times out, promote the Leader's evidence-backed draft instead of paying for a duplicate synthesis turn.
let fallbackConversation;
const draftFallback=await harness(async(c,{agents})=>{
 if(c.phase==='ideas'&&c.d.kind==='codex'){assert.ok(c.input.prompt.includes('你本轮亲自核实的工具链应由你承担关键首样'));return ok(ctl({action:'plan',work:[{id:'W1',assignment:'按核对过的方法制作样本，失败即停止',candidates:[agents[0].userId],dependsOn:[],outputs:['draft/sample.txt'],acceptance:'读取产物并与输入核对',readOnly:false}]})+'\n已只读核对输入和工具。');}
 if(c.phase==='ideas')return {ok:false,error:'Timeout',partialMessage:'',steps:[],metrics:{iterations:0,sideEffects:false}};
 if(!c.phase)return ok('开始执行待定计划。');
 return ok('先明确目标和边界。');
});
try{fallbackConversation=await draftFallback.create();await until(async()=>!!(await draftFallback.store.getConversation(fallbackConversation.conversationId)).workPlan?.length);const current=await draftFallback.store.getConversation(fallbackConversation.conversationId);assert.equal(current.brainstorm.phase,'ready');assert.equal(current.workPlan[0].id,'W1');assert.ok(!draftFallback.calls.some(c=>c.phase==='synthesize'),'all peers failed, so duplicate synthesis must be skipped');assert.ok(draftFallback.events.some(e=>e.event==='brainstorm-draft-plan-promoted'));await draftFallback.scheduler.stopConversation(fallbackConversation.conversationId);}finally{await draftFallback.close();}
// A failed peer may keep nonblocking work, but may not be the sole prerequisite on the critical path.
let guardedConversation;
const criticalGuard=await harness(async(c,{agents})=>{
 const draft={action:'plan',work:[
  {id:'W1',assignment:'慢成员先盘点',candidates:[agents[1].userId],dependsOn:[],outputs:['draft/map.txt'],acceptance:'清单完整',readOnly:false},
  {id:'W2',assignment:'Leader制作关键样本',candidates:[agents[0].userId],dependsOn:['W1'],outputs:['draft/sample.txt'],acceptance:'样本正确',readOnly:false}
 ]};
 if(c.phase==='ideas'&&c.d.kind==='codex')return ok(ctl(draft)+'\n已核对输入。');
 if(c.phase==='ideas')return {ok:false,error:'Timeout',partialMessage:'',steps:[],metrics:{iterations:0,sideEffects:false}};
 if(c.phase==='synthesize'){assert.ok(c.input.prompt.includes('前置依赖'));return ok(ctl({action:'plan',work:[
  {id:'W1',assignment:'慢成员独立盘点',candidates:[agents[1].userId],dependsOn:[],outputs:['draft/map.txt'],acceptance:'清单完整',readOnly:false},
  {id:'W2',assignment:'Leader制作关键样本',candidates:[agents[0].userId],dependsOn:[],outputs:['draft/sample.txt'],acceptance:'样本正确',readOnly:false}
 ]}));}
 if(!c.phase)return ok('开始执行。');
 return ok('继续。');
});
try{guardedConversation=await criticalGuard.create();await until(async()=>!!(await criticalGuard.store.getConversation(guardedConversation.conversationId)).workPlan?.length);const current=await criticalGuard.store.getConversation(guardedConversation.conversationId);assert.deepEqual(current.workPlan.find(w=>w.id==='W2').dependsOn,[]);assert.equal(criticalGuard.calls.filter(c=>c.phase==='synthesize').length,1);assert.ok(criticalGuard.events.some(e=>e.event==='brainstorm-draft-plan-critical-peer-unresponsive'));await criticalGuard.scheduler.stopConversation(guardedConversation.conversationId);}finally{await criticalGuard.close();}
// Human clarification is durable, resumes only on new input; probe uses normal approval policy.
let asked=false,probed=false,probePermission=false;
const w=await harness(async c=>{
 if(c.phase==='ideas'&&c.d.kind==='codex'&&!asked){asked=true;return ok(ctl({action:'brainstorm',decision:'ask',reason:'请提供输入文件位置。'}));}
 if(c.phase==='ideas'&&c.d.kind==='codex'&&!probed){probed=true;return ok('先核对输入格式。'+ctl({action:'brainstorm',decision:'probe',reason:'只读取输入文件头确认格式，不修改原件，读完停止'}));}
 if(c.phase==='probe'){assert.equal(c.input.discussionOnly,false);assert.equal(c.input.fullAccess,true);probePermission=await c.input.onPermission({toolName:'Read',requestId:'p',signal:new AbortController().signal});return ok('已实际确认输入格式。');}
 if(c.phase==='synthesize')return ok('讨论结论已充分。'+ctl({action:'stop',reason:'只需要讨论结论'}));
 return ok('目标明确，建议独立核对并复核结果。');
});
try{
 const t=await w.create();await until(async()=>(await w.store.getConversation(t.conversationId)).brainstorm?.phase==='waiting');await sleep(30);assert.equal(w.calls.length,3,'owner question does not cancel already-running independent peer views');assert.ok((await w.store.listMessages(t.conversationId)).some(m=>m.content==='请提供输入文件位置。'&&!m.internal));
 await w.scheduler.sendUserMessage({conversationId:t.conversationId,clientMessageId:'answer',content:'文件在指定工作目录'});
 await until(async()=>(await w.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');assert.ok(probePermission);assert.equal(w.calls.filter(c=>c.phase==='probe').length,1);assert.equal(w.calls.filter(c=>c.phase==='ideas').length,6,'clarification reruns parallel independent views against the new owner input');assert.equal(w.calls.filter(c=>c.phase==='review').length,0);
}finally{await w.close();}
// A failed bounded probe keeps its partial evidence and returns to synthesis instead of blindly repeating it.
let failedProbeRequested=false;
const oneProbe=await harness(async c=>{
 if(c.phase==='ideas'&&c.d.kind==='codex'&&!failedProbeRequested){failedProbeRequested=true;return ok(ctl({action:'brainstorm',decision:'probe',reason:'只核对一个关键事实'}));}
 if(c.phase==='probe')return {ok:false,error:'Timeout',partialMessage:'已读到关键事实：输入共有4项。',steps:['Read'],metrics:{iterations:1,sideEffects:false}};
 if(c.phase==='synthesize'){assert.ok(c.input.prompt.includes('输入共有4项'));return ok(ctl({action:'stop',reason:'使用已保存证据完成收敛'}));}
 return ok('补充具体方法。');
});
try{const t=await oneProbe.create();await until(async()=>(await oneProbe.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');assert.equal(oneProbe.calls.filter(c=>c.phase==='probe').length,1);}finally{await oneProbe.close();}
// Timed out member is not agreement; leader decides with explicit missing evidence.
const f=await harness(async c=>{
 if(c.phase==='ideas'&&c.d.kind==='qoder-cn')return{ok:false,error:'Timeout',partialMessage:'我认为应先确认',steps:[],metrics:{iterations:0,sideEffects:false}};
 if(c.phase==='synthesize'){assert.ok(c.input.prompt.includes('不能当作同意'));return ok('该成员未给出完整意见，保留不确定性。'+ctl({action:'stop',reason:'讨论结论已交付'}));}
 return ok('使用可复核证据，小步验证。');
});
try{const t=await f.create();await until(async()=>(await f.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');assert.ok((await f.store.listMessages(t.conversationId)).some(m=>m.content==='我认为应先确认'));}finally{await f.close();}
// Stop cancels discussion and cannot launch the next stage, while another task remains independent.
let holding;
const s=await harness(async c=>{
 if(c.phase==='ideas')return new Promise(resolve=>{holding=true;c.input.signal.addEventListener('abort',()=>resolve({ok:false,error:'cancelled',cancelled:true,steps:[],metrics:{iterations:0,sideEffects:false}}),{once:true});});
 return ok('先理解任务。');
});
try{const t=await s.create();await until(()=>holding);await s.scheduler.stopConversation(t.conversationId);await until(()=>s.scheduler.runtimeSnapshot().agents.length===0);await sleep(30);assert.ok(!s.calls.some(c=>c.phase==='synthesize'));assert.notEqual((await s.store.getConversation(t.conversationId)).brainstorm.phase,'ready');}finally{await s.close();}
// New owner input invalidates an in-flight final decision without losing that reply.
let oldDecision;let framed=0;
const n=await harness(async c=>{
 if(c.d.localUuid.includes('::inbox:'))return ok('已收到新要求，方案需要重新确认。');
 if(c.phase==='ideas'&&c.d.kind==='codex')framed++;
 if(c.phase==='synthesize'&&framed===1)return new Promise(resolve=>oldDecision=()=>resolve(ok('旧方案决定。'+ctl({action:'organize'}))));
 if(c.phase==='synthesize')return ok('新要求已复核。'+ctl({action:'stop',reason:'方案交付'}));
 return ok('共同核对方案。');
});
try{const t=await n.create();await until(()=>oldDecision);await n.scheduler.sendUserMessage({conversationId:t.conversationId,clientMessageId:'new-scope',content:'改成按季度汇总'});oldDecision();await until(async()=>(await n.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');assert.equal(framed,2);assert.ok(!n.calls.some(c=>!c.phase));const messages=await n.store.listMessages(t.conversationId);assert.ok(messages.some(m=>m.content==='旧方案决定。'&&m.agentReply?.newerInput));assert.ok(messages.some(m=>m.content==='改成按季度汇总'));}finally{await n.close();}
// Repeated identical requests stop only because they add no substantive issue, not because a round cap was reached.
const b=await harness(async c=>['synthesize','decide'].includes(c.phase)?ok('仍需讨论。'+ctl({action:'brainstorm',decision:'revise',reason:'继续讨论同一问题'})):ok('给出可行方案并核对。'));
try{const t=await b.create();await until(async()=>(await b.store.getConversation(t.conversationId)).brainstorm?.phase==='waiting');assert.match((await b.store.getConversation(t.conversationId)).brainstorm.reason,/重复同一修订理由/);assert.ok(!b.calls.some(c=>!c.phase));}finally{await b.close();}

// Materially new disagreements may continue beyond three rounds and still converge normally.
let revisions=0;
const u=await harness(async c=>['synthesize','decide'].includes(c.phase)&&revisions++<4?ok(ctl({action:'brainstorm',decision:'revise',reason:`新的具体问题 ${revisions}`})):c.phase==='decide'?ok(ctl({action:'stop',reason:'全部新问题已解决'})):ok('补充新的证据并复核。'));
try{const t=await u.create();await until(async()=>(await u.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');assert.equal((await u.store.getConversation(t.conversationId)).brainstorm.round,5);assert.equal(u.calls.filter(c=>c.phase==='review').length,8);}finally{await u.close();}

// Sequential discussion turns for one Agent resume one provider conversation with incremental task messages.
const p=await harness(async c=>({...ok(c.phase==='synthesize'?ctl({action:'stop',reason:'讨论完成'}):'具体方法与验收已说明。'),threadId:`thread-${c.d.kind}`}));
try{const t=await p.create();await until(async()=>(await p.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');for(const kind of ['codex','claude-code','qoder-cn']){const calls=p.calls.filter(c=>c.d.kind===kind&&!c.d.localUuid.includes('::inbox:'));assert.equal(calls[0].input.threadId,undefined);for(const call of calls.slice(1))assert.equal(call.input.threadId,`thread-${kind}`);}}finally{await p.close();}
assert.equal(parseLeaderControl(ctl({action:'brainstorm',decision:'ask',reason:'输入缺失'})).control.decision,'ask');assert.equal(parseLeaderControl(ctl({action:'brainstorm',decision:'agree',reason:'具体路线已核对'})).control.decision,'agree');assert.equal(parseLeaderControl(ctl({action:'brainstorm',decision:'execute',reason:'invalid'})).control,undefined);
// A Leader on another computer is coordinated there; this computer must not mark it unavailable.
// Once a Leader-unavailable wait sees the Leader ready again, the discussion resumes without new input.
const remoteLead=await harness(async c=>ok(c.phase==='synthesize'?ctl({action:'stop',reason:'讨论完成'}):'具体方法与验收已说明。'));
try{
 const leaderId=remoteLead.agents[0].userId;const getUser=remoteLead.store.getUser.bind(remoteLead.store);let remote=true;
 remoteLead.store.getUser=async id=>{const u=await getUser(id);return remote&&u&&id===leaderId?{...u,remote:{computerId:'other',computerName:'other',online:true,readiness:'ready'}}:u;};
 const t=await remoteLead.create();await sleep(80);
 const idle=await remoteLead.store.getConversation(t.conversationId);
 assert.equal(idle.brainstorm,undefined,'remote Leader: no shared discussion state written here');
 assert.equal(remoteLead.calls.length,0,'remote Leader: no local discussion turns');
 assert.ok(!(await remoteLead.store.listMessages(t.conversationId)).some(m=>m.content.includes('方案讨论暂缓')),'no misleading unavailable notice');
 remote=false;
 await remoteLead.store.updateConversation(t.conversationId,{brainstorm:{phase:'waiting',round:1,revision:1,probes:0,attempts:0,leaderId,inputSeq:1,participants:[],responses:{},turnDurationsMs:{},evidenceReady:false,reason:'Leader当前不可用，尚未完成方案讨论。'}});
 await remoteLead.scheduler.resumeConversation(t.conversationId);
 await until(async()=>(await remoteLead.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');
 assert.ok(remoteLead.calls.some(c=>c.phase==='ideas'&&c.d.kind==='codex'),'Leader-unavailable wait resumes once the Leader is ready');
}finally{await remoteLead.close();}
console.log('brainstorm: fast convergence, on-demand review, persistent sessions, substantive convergence without a round cap, unavailable/timeout handling, clarification, bounded probe and stop passed');

// A full resumed discussion thread is rebuilt once from the durable ledger instead of failing the Leader three times.
const full=await harness(async c=>{
 if(c.phase==='synthesize'&&c.input.threadId)return {ok:false,error:'context_length_exceeded: rebuild provider context',threadId:c.input.threadId,steps:[],cancelled:false,metrics:{iterations:0,sideEffects:false}};
 if(c.phase==='synthesize')return {...ok(ctl({action:'stop',reason:'讨论完成'})),threadId:'thread-rebuilt'};
 return {...ok('具体方法与验收已说明。'),threadId:`thread-${c.d.kind}`};
});
try{const t=await full.create();await until(async()=>(await full.store.getConversation(t.conversationId)).brainstorm?.phase==='ready');
 const synth=full.calls.filter(c=>c.phase==='synthesize');assert.equal(synth.length,2,'one rebuild, no blind repeats');assert.equal(synth[0].input.threadId,'thread-codex');assert.equal(synth[1].input.threadId,undefined);
 assert.ok(synth[1].input.prompt.includes('核对输入，形成报告，不修改原件'),'rebuilt thread carries the full task ledger');
 assert.ok(!(await full.store.listMessages(t.conversationId)).some(m=>m.failed&&/context_length_exceeded/.test(m.content)),'recoverable overflow is not shown as a chat failure');
 assert.equal((await full.store.getAgentSession(t.conversationId,full.agents[0].userId)).providerThreadId,'thread-rebuilt');
}finally{await full.close();}
