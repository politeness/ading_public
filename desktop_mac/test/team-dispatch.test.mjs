import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-team-dispatch-'));
const store=new LocalStore(dir);await store.init();
const discovered=['codex','claude-code','qoder-cn'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
const agents=await store.syncDiscoveredAgents(discovered),[leader,worker,peer]=discovered.map(d=>agents.find(a=>a.kind===d.kind));
const base={store,idleRetryLimit:0,teamMonitorIntervalMs:0,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}};
const ok=message=>({ok:true,message,steps:[],metrics:{iterations:1,sideEffects:false}});
const encoded=control=>JSON.stringify({control});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn)=>{for(let i=0;i<600;i++){if(await fn())return;await sleep(5);}throw Error('timeout');};
const conversation=async name=>store.createConversation({name,memberIds:agents.map(a=>a.userId),leaderId:leader.userId});
const item=(id,candidates=[worker.userId],extra={})=>({id,assignment:`独立工作 ${id}`,candidates,dependsOn:[],outputs:[`draft/${id}.txt`],acceptance:'实际文件内容通过检查',readOnly:false,...extra});
try {
 const t=await conversation('self-assignment');let rounds=0;
 const self=new LocalScheduler({...base,registry:{runTurn:async()=>{
  if(rounds++===0)return ok(encoded({action:'assign',to:leader.userId,assignment:'读取一个样张并报告'}));
  if(rounds===2)return ok('样张已检查，证据在 draft/self.txt');
  return ok('SKIP');
 }}});
 await self.runAgentTurn(t,leader);await until(()=>!self.runtimeSnapshot().agents.length);
 const messages=await store.listMessages(t.conversationId);
 assert.deepEqual(messages.filter(m=>m.coordination).map(m=>m.coordination.phase),['accepted','result']);
 assert.ok(!messages.some(m=>m.content.includes('分工未派发')));
 // Usage in turn-done is this turn alone even though providers report the thread's running total.
 {
  const usageConversation=await store.createConversation({name:'usage',memberIds:[leader.userId]});
  const logs=[];let total=0,thread='thread-1';
  const metered=new LocalScheduler({...base,log:async(event,data)=>{if(event==='turn-done')logs.push(data);},registry:{adapterFor:()=>({cumulativeTokenUsage:true}),runTurn:async()=>{
   total+=1000;return {...ok('好的'),threadId:thread,metrics:{iterations:1,sideEffects:false,tokenUsage:{inputTokens:total,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:10,reasoningOutputTokens:0,totalTokens:total+10}}};
  }}});
  const say=async id=>{await metered.sendUserMessage({conversationId:usageConversation.conversationId,clientMessageId:id,content:id});await until(()=>logs.length>=Number(id.slice(1)));};
  await say('u1');assert.equal(logs[0].tokenUsage.inputTokens,1000,'the first turn of a thread is its whole total');
  await say('u2');assert.equal(logs[1].tokenUsage.inputTokens,1000,'a resumed turn only counts what it added');
  thread='thread-2';await say('u3');assert.equal(logs[2].tokenUsage.inputTokens,3000,'a different thread has nothing to subtract');
  assert.equal((await store.getAgentSession(usageConversation.conversationId,leader.userId)).tokenUsageTotal.inputTokens,3000,'the running total is remembered for the next turn');
 }
 // Separate, truthful rejection causes are visible and identical retries do not spam.
 const bad=await conversation('failure-causes');const logs=[];
 const failures=new LocalScheduler({...base,isAgentReady:a=>a.userId!==peer.userId,agentUnavailableReason:()=> '额度已耗尽，请主人补充额度或改派。',registry:{},log:async(e,d)=>logs.push({e,...d})});
 for(const to of ['missing',peer.userId,peer.userId])await failures.applyLeaderControl(bad,leader,encoded({action:'assign',to,assignment:'检查'}),null);
 const rejected=(await store.listMessages(bad.conversationId)).filter(m=>m.content.includes('分工未派发'));
 assert.equal(rejected.length,2);assert.ok(rejected.every(m=>!m.internal));
 assert.ok(rejected.some(m=>m.content.includes('额度已耗尽')));assert.deepEqual(logs.map(l=>l.code),['member-not-found','agent-unavailable','agent-unavailable']);
 // Transient failed writes retry the same id and deliver only one accepted self-assignment.
 const retryConversation=await conversation('retry');let writes=0;const ids=[];
 const wrapped=new Proxy(store,{get(t,k){if(k==='appendMessage')return async input=>{if(input.coordination){ids.push(input.clientMessageId);if(writes++<2)throw Error('temporary storage');}return t.appendMessage(input);};const v=t[k];return typeof v==='function'?v.bind(t):v;}});
 const retry=new LocalScheduler({...base,store:wrapped,registry:{}});
 await retry.applyLeaderControl(retryConversation,leader,encoded({action:'assign',to:leader.userId,assignment:'retry-me'}),null);
 assert.equal(writes,3);assert.equal(new Set(ids).size,1);assert.equal((await store.listMessages(retryConversation.conversationId)).filter(m=>m.coordination).length,1);
 // Permanent storage errors stop immediately and expose the actual cause.
 const full=await conversation('disk-full');let fullAttempts=0;
 const fullStore=new Proxy(store,{get(t,k){if(k==='appendMessage')return async input=>{if(input.coordination){fullAttempts++;throw Object.assign(Error('no space'),{code:'ENOSPC'});}return t.appendMessage(input);};const v=t[k];return typeof v==='function'?v.bind(t):v;}});
 const diskFull=new LocalScheduler({...base,store:fullStore,registry:{}});await diskFull.applyLeaderControl(full,leader,encoded({action:'assign',to:leader.userId,assignment:'save'}),null);
 assert.equal(fullAttempts,1);assert.ok((await store.listMessages(full.conversationId)).some(m=>m.content.includes('磁盘空间不足')&&!m.internal));
 // A plan dispatch also retries idempotently and releases its reservation on permanent failure.
 const pf=await conversation('plan-save-full');const planFull=new LocalScheduler({...base,store:fullStore,registry:{runTurn:async()=>ok('SKIP')}});planFull.engagedConversations.add(pf.conversationId);
 await planFull.planner.merge(pf.conversationId,[item('full')]);
 await assert.rejects(()=>planFull.fillWork(pf.conversationId),/no space/);
 assert.equal((await store.getConversation(pf.conversationId)).workPlan[0].status,'blocked');
 // Detect idle capacity while leader is still executing; route into the coordination inbox.
 const gap=await conversation('busy-leader-gap');await store.updateConversation(gap.conversationId,{workPlan:[{...item('blocked'),status:'blocked',evidence:'需要重新安排'}]});
 const monitor=new LocalScheduler({...base,teamMonitorIntervalMs:15_000,concurrentInbox:true,registry:{}});monitor.engagedConversations.add(gap.conversationId);monitor.runningTurns.set(leader.userId,gap.conversationId);
 const inbox=[];monitor.queueInbox=(t,a,c,seq)=>inbox.push(seq);
 await monitor.monitorTeams();await monitor.monitorTeams();assert.equal(inbox.length,1);
 await store.setConversationPaused(gap.conversationId,true);await monitor.monitorTeams();assert.equal(inbox.length,1);
 // A blocked item whose follow-up already started is in hand: waking the Leader again only
 // produced "still waiting" turns. Once the follow-up finishes, the Leader is needed again.
 const handled=await conversation('follow-up-in-hand');const at=ms=>new Date(Date.now()-ms).toISOString();
 const sample={...item('sample'),status:'blocked',evidence:'退回',startedAt:at(120_000),completedAt:at(60_000)};
 await store.updateConversation(handled.conversationId,{workPlan:[sample,{...item('recheck'),status:'active',assigneeId:leader.userId,startedAt:at(60_020)}]});
 const quiet=new LocalScheduler({...base,teamMonitorIntervalMs:15_000,concurrentInbox:true,registry:{}});quiet.engagedConversations.add(handled.conversationId);quiet.runningTurns.set(leader.userId,handled.conversationId);
 const quietInbox=[];quiet.queueInbox=(t,a,c,seq)=>quietInbox.push(seq);
 await quiet.monitorTeams();assert.equal(quietInbox.length,0,'follow-up dispatched in the same Leader turn: no extra wakeup');
 await store.updateConversation(handled.conversationId,{workPlan:[sample,{...item('recheck'),status:'done',assigneeId:leader.userId,startedAt:at(60_020),completedAt:at(1_000)}]});
 await quiet.monitorTeams();assert.equal(quietInbox.length,1,'finished follow-up hands the blocked item back to the Leader');
 // Product default keeps coordination queued for the existing provider session.
 const oneSession=await conversation('one-session-gap');await store.updateConversation(oneSession.conversationId,{workPlan:[{...item('one-blocked'),status:'blocked',evidence:'等待原会话协调'}]});
 const serialMonitor=new LocalScheduler({...base,teamMonitorIntervalMs:15_000,registry:{}});serialMonitor.engagedConversations.add(oneSession.conversationId);serialMonitor.runningTurns.set(leader.userId,oneSession.conversationId);
 let freshInboxes=0;serialMonitor.queueInbox=()=>{freshInboxes++;};await serialMonitor.monitorTeams();
 assert.equal(freshInboxes,0);assert.ok(serialMonitor.pendingTurns.get(leader.userId)?.has(oneSession.conversationId),'coordination waits for the same provider session');
 // Two independent jobs on one Agent overlap; third waits, sessions and receipts stay isolated.
 const parallel=await conversation('parallel-lanes');const releases=new Map(), started=[],keys=new Set(),threads=new Map();let max=0,active=0;
 const s=new LocalScheduler({...base,maxConcurrentWorkPerAgent:2,registry:{cancel:()=>true,runTurn:async(d,input)=>{
  if(!d.localUuid.includes('::work:'))return ok('SKIP');
  keys.add(d.localUuid);const id=d.localUuid.split('::work:')[1];
  if(input.discussionOnly){assert.equal(input.threadId,undefined);threads.set(id,`thread-${id}`);return {...ok('同意，执行这项独立工作。'),threadId:threads.get(id)};}
  assert.equal(input.threadId,threads.get(id));active++;max=Math.max(max,active);started.push(id);
  await new Promise(resolve=>releases.set(id,resolve));active--;return {...ok(`完成 ${id}，具体证据在独立产物。`),threadId:threads.get(id)};
 }}});
 s.engagedConversations.add(parallel.conversationId);
 await s.planner.merge(parallel.conversationId,[item('a'),item('b'),item('c'),item('dependent',[peer.userId],{dependsOn:['a']})]);
 await s.fillWork(parallel.conversationId);await until(()=>started.length===2);
 assert.equal(max,2);assert.equal(keys.size,2);assert.equal(s.runtimeSnapshot().agents.filter(a=>a.agentUserId===worker.userId).length,1);
 releases.get(started[0])();await until(()=>started.length===3);assert.equal(max,2);
 releases.get(started[1])();releases.get(started[2])();await until(()=>!s.workLanes.size&&!s.runtimeSnapshot().agents.length);
 const plan=(await store.getConversation(parallel.conversationId)).workPlan;assert.ok(plan.filter(w=>w.id!=='dependent').every(w=>w.status==='review'));assert.equal(plan.find(w=>w.id==='dependent').status,'queued');
 const results=(await store.listMessages(parallel.conversationId)).filter(m=>m.coordination?.phase==='result');assert.equal(results.length,3);assert.equal(new Set(results.map(m=>m.coordination.workId)).size,3);
 const primarySession=await store.getAgentSession(parallel.conversationId,worker.userId);
 assert.equal(primarySession.providerThreadId,threads.get(started[0]),'first sequential lane reuses the conversation-native session');
 assert.ok(await store.getAgentSession(parallel.conversationId,`${worker.userId}::assignment:${started[1]}`),'simultaneous sibling keeps an isolated provider branch');
 await s.stopConversation(parallel.conversationId);
 // Stop cancels every lane and late provider results never become completed work.
 const stopped=await conversation('cancel-lanes');let began=0;const cancels=[];
 const stop=new LocalScheduler({...base,maxConcurrentWorkPerAgent:2,registry:{cancel:(kind,key)=>{cancels.push(key);return true;},runTurn:async(d,input)=>{
  if(input.discussionOnly)return ok('同意');began++;
  await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));return ok('迟到结果');
 }}});stop.engagedConversations.add(stopped.conversationId);await stop.planner.merge(stopped.conversationId,[item('x'),item('y')]);await stop.fillWork(stopped.conversationId);await until(()=>began===2);await stop.stopConversation(stopped.conversationId);await until(()=>!stop.workLanes.size);
 assert.equal(new Set(cancels).size,2);assert.ok(!(await store.listMessages(stopped.conversationId)).some(m=>m.content==='迟到结果'));
 // Resume every accepted persisted lane, using its own provider session.
 const resume=await conversation('resume-two-lanes');const previousPlan=[];
 for(const id of ['resume-a','resume-b']) {
  previousPlan.push({...item(id),status:'active',assigneeId:worker.userId,assignmentId:id});
  await store.appendMessage({conversationId:resume.conversationId,clientMessageId:id,senderId:leader.userId,type:'TASK',content:id,coordination:{id,workId:id,assigneeId:worker.userId,phase:'accepted',brief:id}});
  await store.saveAgentSession({conversationId:resume.conversationId,agentUserId:`${worker.userId}::assignment:${id}`,providerThreadId:`previous-${id}`});
 }
 await store.updateConversation(resume.conversationId,{workPlan:previousPlan});const resumed=[];
 const recovery=new LocalScheduler({...base,maxConcurrentWorkPerAgent:2,registry:{runTurn:async(d,input)=>{
  if(d.localUuid.includes('::work:')) {resumed.push(input.threadId);return ok('恢复后检查已有产物并提交');}return ok('SKIP');
 }}});await recovery.resumeConversation(resume.conversationId);await until(()=>!recovery.workLanes.size&&!recovery.runtimeSnapshot().agents.length);
 assert.deepEqual(resumed.sort(),['previous-resume-a','previous-resume-b']);assert.ok((await store.getConversation(resume.conversationId)).workPlan.every(w=>w.status==='review'));await recovery.stopConversation(resume.conversationId);
 // Losing availability rejects every outstanding lane, not only the latest assignment.
 const off=await conversation('all-lanes-unavailable');const offPlan=[];
 for(const id of ['off-a','off-b']) {
  offPlan.push({...item(id),status:'active',assigneeId:worker.userId,assignmentId:id});
  await store.appendMessage({conversationId:off.conversationId,clientMessageId:id,senderId:leader.userId,type:'TASK',content:id,coordination:{id,workId:id,assigneeId:worker.userId,phase:'accepted',brief:id}});
 }
 await store.updateConversation(off.conversationId,{workPlan:offPlan});const unavailable=new LocalScheduler({...base,maxConcurrentWorkPerAgent:10,isAgentReady:a=>a.userId!==worker.userId,registry:{cancel:()=>true}});unavailable.dispatch=async()=>{};
 await unavailable.pauseUnavailableAgents(worker.kind);assert.ok((await store.getConversation(off.conversationId)).workPlan.every(w=>w.status==='blocked'));
 assert.equal((await store.listMessages(off.conversationId)).filter(m=>m.coordination?.phase==='rejected').length,2);
 // Leader execution lanes retain real permission roles and return results to coordination.
 const owned=await conversation('leader-own-lane');let ownerReviews=0,permissions=0;
 const own=new LocalScheduler({...base,maxConcurrentWorkPerAgent:2,requestPermission:async(t,a)=>{
  assert.equal(t.members.find(m=>m.userId===a.userId).role,'LEADER');permissions++;return true;
 },registry:{runTurn:async(d,input)=>{
  if(d.localUuid.includes('::work:')) {assert.equal(input.discussionOnly,false);await input.onPermission({toolName:'Read',signal:input.signal});return ok('自己的独立工作已完成');}
  ownerReviews++;return ok('协调会话检查结果');
 }}});own.engagedConversations.add(owned.conversationId);await own.planner.merge(owned.conversationId,[item('owner-job',[leader.userId])]);await own.fillWork(owned.conversationId);await until(()=>!own.workLanes.size&&!own.runtimeSnapshot().agents.length);
 assert.equal(permissions,1);assert.equal(ownerReviews,1);assert.equal((await store.listMessages(owned.conversationId)).filter(m=>m.coordination?.phase==='result').length,1);
 assert.equal(await own.assignmentFor(owned.conversationId,leader.userId),undefined,'coordinator must not execute or complete its lane assignment');
 await own.stopConversation(owned.conversationId);
 // Product limit: ten lanes per Agent; the eleventh starts immediately after one finishes.
 const ten=await conversation('ten-lane-limit');const tenReleases=[];let tenStarted=0,tenActive=0,tenPeak=0;
 const wide=new LocalScheduler({...base,maxConcurrentWorkPerAgent:10,registry:{cancel:()=>true,runTurn:async(d,input)=>{
  if(!d.localUuid.includes('::work:'))return ok('SKIP');
  assert.ok(input.prompt.includes('你的 Agent 并发上限为 10 路'),'lane capacity prompt matches product limit');
  assert.ok(!/并行工作：\d+\/1(?:，|）)/.test(input.prompt),'lane must not expose internal scheduler limit as Agent capacity');
  if(input.discussionOnly)return ok('同意');
  tenStarted++;tenActive++;tenPeak=Math.max(tenPeak,tenActive);await new Promise(resolve=>tenReleases.push(resolve));tenActive--;return ok('已完成独立项');
 }}});wide.engagedConversations.add(ten.conversationId);await wide.planner.merge(ten.conversationId,Array.from({length:11},(_,i)=>item(`wide-${i}`)));await wide.fillWork(ten.conversationId);await until(()=>tenStarted===10);
 assert.equal(tenPeak,10);await sleep(20);assert.equal(tenStarted,10);tenReleases[0]();await until(()=>tenStarted===11);assert.equal(tenPeak,10);
 for(const release of tenReleases)release();await until(()=>!wide.workLanes.size&&!wide.runtimeSnapshot().agents.length);await wide.stopConversation(ten.conversationId);
 // A message sent during readiness detection resumes once the leader becomes ready.
 // Monitoring is gated on open work now (no execution mode), so the group carries a blocked item.
 const boot=await conversation('readiness-restored');let ready=false,bootCalls=0;await store.updateConversation(boot.conversationId,{workPlan:[{...item('boot-blocked'),status:'blocked',evidence:'等待 Leader 就绪后重新安排'}]});
 const bootScheduler=new LocalScheduler({...base,idleRetryLimit:1,teamMonitorIntervalMs:15_000,isAgentReady:()=>ready,registry:{runTurn:async()=>{bootCalls++;return ok('SKIP');}}});
 bootScheduler.engagedConversations.add(boot.conversationId);await bootScheduler.monitorTeams();assert.equal(bootCalls,0);ready=true;await bootScheduler.monitorTeams();await until(()=>bootCalls===1&&!bootScheduler.runtimeSnapshot().agents.length);await bootScheduler.stopConversation(boot.conversationId);

 // Coordinator availability flips do not create a duplicate allocation notice.
 await store.setConversationPaused(gap.conversationId,false);
 monitor.runningTurns.delete(leader.userId);
 monitor.workLanes.set('keep-alive',{conversationId:gap.conversationId,agentId:peer.userId});
 await monitor.monitorTeams();
 const stable=inbox.length;
 monitor.runningTurns.set(leader.userId,gap.conversationId);
 await monitor.monitorTeams();assert.equal(inbox.length,stable);
 monitor.workLanes.clear();monitor.runningTurns.clear();
 // Long-running work and repeated tool errors never create an automatic
 // interruption, continuation, or Leader wake-up.
 const uninterruptedConversation=await conversation('uninterrupted-work');let uninterrupted=false;
 const uninterruptedScheduler=new LocalScheduler({...base,maxConcurrentWorkPerAgent:10,registry:{cancel:()=>true,runTurn:async(d,input)=>{
  if(!d.localUuid.includes('::work:'))return ok('SKIP');if(input.discussionOnly)return ok('同意');
  for(let i=0;i<50;i++)input.onAudit({id:String(i),kind:'Bash',phase:'completed',failed:true});
  await sleep(100);assert.equal(input.signal.aborted,false);uninterrupted=true;return ok('长工作正常完成');
 }}});uninterruptedScheduler.engagedConversations.add(uninterruptedConversation.conversationId);await uninterruptedScheduler.planner.merge(uninterruptedConversation.conversationId,[item('long-work')]);await uninterruptedScheduler.fillWork(uninterruptedConversation.conversationId);
 await until(()=>uninterrupted&&!uninterruptedScheduler.workLanes.size&&!uninterruptedScheduler.runtimeSnapshot().agents.length);
 assert.equal((await store.getConversation(uninterruptedConversation.conversationId)).workPlan[0].status,'review');
 const uninterruptedMessages=await store.listMessages(uninterruptedConversation.conversationId);
 assert.ok(!uninterruptedMessages.some(m=>/工作巡检提醒|执行检查点/.test(m.content)));
 await uninterruptedScheduler.stopConversation(uninterruptedConversation.conversationId);

 // Leader must cite evidence, target the current assignment, and leave siblings running.
 const inspected=await conversation('leader-interrupt');let inspectionStopped=false,releaseSibling;let siblingSignal;
 const overseer=new LocalScheduler({...base,maxConcurrentWorkPerAgent:10,registry:{cancel:()=>true,runTurn:async(d,input)=>{
  if(!d.localUuid.includes('::work:'))return ok('SKIP');if(input.discussionOnly)return ok('同意');
  if(input.prompt.includes('独立工作 inspect-me')) {await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));inspectionStopped=true;return {ok:false,cancelled:true,error:'cancelled',steps:[]};}
  siblingSignal=input.signal;await new Promise(resolve=>releaseSibling=resolve);return ok('其他工作完成');
 }}});overseer.engagedConversations.add(inspected.conversationId);await overseer.planner.merge(inspected.conversationId,[item('inspect-me'),item('keep-going')]);await overseer.fillWork(inspected.conversationId);
 await until(()=>!!releaseSibling);
 const iw=(await store.getConversation(inspected.conversationId)).workPlan.find(w=>w.id==='inspect-me');
 const decision={action:'interrupt',workId:iw.id,assignmentId:iw.assignmentId,evidence:'产物校验失败且重复同一错误',reason:'讨论替代方法后再执行'};
 await overseer.applyLeaderControl(await store.getConversation(inspected.conversationId),worker,encoded(decision),null);assert.equal(inspectionStopped,false);
 await overseer.applyLeaderControl(await store.getConversation(inspected.conversationId),leader,encoded({...decision,assignmentId:'stale'}),null);assert.equal(inspectionStopped,false);
 await overseer.applyLeaderControl(await store.getConversation(inspected.conversationId),leader,encoded(decision),null);await until(()=>inspectionStopped);
 assert.equal(siblingSignal.aborted,false);assert.equal((await store.getConversation(inspected.conversationId)).workPlan.find(w=>w.id===iw.id).status,'blocked');
 releaseSibling();await until(()=>!overseer.workLanes.size&&!overseer.runtimeSnapshot().agents.length);await overseer.stopConversation(inspected.conversationId);

 // A fixable inspection atomically stops the bad branch and restarts the same work only after the correction is in task context.
 const redirectConversation=await conversation('leader-redirect');await store.updateConversation(redirectConversation.conversationId,{brainstorm:{phase:'ready',revision:3,round:2,probes:0,attempts:0,leaderId:leader.userId,inputSeq:0,participants:[leader.userId,worker.userId],confirmedParticipants:[worker.userId],responses:{}}});
 let redirectAttempts=0,oldAborted=false,sawCorrection=false;
 const redirector=new LocalScheduler({...base,maxConcurrentWorkPerAgent:10,registry:{cancel:()=>true,runTurn:async(d,input)=>{
  if(!d.localUuid.includes('::work:'))return ok('SKIP');
  redirectAttempts++;
  if(redirectAttempts===1){await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));oldAborted=true;return {ok:false,cancelled:true,error:'cancelled',steps:[],metrics:{iterations:1,sideEffects:true}};}
  sawCorrection=input.prompt.includes('改用已验证工具，只做一个样本，失败即停止');return ok('纠正后完成');
 }}});redirector.engagedConversations.add(redirectConversation.conversationId);await redirector.planner.merge(redirectConversation.conversationId,[item('fixable',[worker.userId],{preAgreed:true})]);await redirector.fillWork(redirectConversation.conversationId);await until(()=>redirectAttempts===1);
 const activeFix=(await store.getConversation(redirectConversation.conversationId)).workPlan[0];
 await redirector.applyLeaderControl(await store.getConversation(redirectConversation.conversationId),leader,encoded({action:'interrupt',workId:'fixable',assignmentId:activeFix.assignmentId,evidence:'样本仍有残留','reason':'当前参数不合格',assignment:'改用已验证工具，只做一个样本，失败即停止'}),null);
 await until(()=>redirectAttempts===2&&!redirector.workLanes.size);assert.ok(oldAborted&&sawCorrection);assert.equal((await store.getConversation(redirectConversation.conversationId)).workPlan[0].status,'review');await redirector.stopConversation(redirectConversation.conversationId);

 // One coordinator decision stream while worker execution remains independently parallel.
 const serialConversation=await conversation('one-coordinator');let releaseDecision,decisionCalls=0;
 await store.updateConversation(serialConversation.conversationId,{workPlan:[{...item('past'),status:'done'}]});
 const serialScheduler=new LocalScheduler({...base,registry:{runTurn:async()=>{decisionCalls++;if(decisionCalls===1)await new Promise(r=>releaseDecision=r);return ok('SKIP');}}});
 const pendingDecision=serialScheduler.runAgentTurn(await store.getConversation(serialConversation.conversationId),leader);
 await until(()=>!!releaseDecision);
 serialScheduler.queueInbox(await store.getConversation(serialConversation.conversationId),leader,null,20);await sleep(20);assert.equal(decisionCalls,1,'no second leader decision while first is active');
 releaseDecision();await pendingDecision;assert.equal(decisionCalls,2);await serialScheduler.stopConversation(serialConversation.conversationId);

 // A Leader's own tool lane and main coordination session never overlap. New
 // chat is handled by the tool-free inbox; the durable result wakes one full
 // coordination turn only after the work lane releases.
 const leaderLaneConversation=await conversation('leader-lane-serialization');let releaseLeaderLane,leaderLaneStarted=false,baseLeaderCalls=0;const laneCalls=[];
 const laneScheduler=new LocalScheduler({...base,maxConcurrentWorkPerAgent:10,concurrentInbox:true,registry:{cancel:()=>true,runTurn:async(d,input)=>{
  laneCalls.push({id:d.localUuid,discussionOnly:input.discussionOnly,fullAccess:input.fullAccess});
  if(d.localUuid.includes('::work:')){leaderLaneStarted=true;await new Promise(r=>releaseLeaderLane=r);return ok('Leader工作已提交，等待验收');}
  if(d.localUuid.includes('::inbox:')){assert.equal(input.discussionOnly,true);assert.equal(input.fullAccess,false);return ok('已记录新消息，当前工具工作继续。');}
  baseLeaderCalls++;return ok('已验证工具工作释放后才进入完整协调。'+encoded({action:'stop',reason:'并发互斥验证完成'}));
 }}});laneScheduler.engagedConversations.add(leaderLaneConversation.conversationId);await laneScheduler.planner.merge(leaderLaneConversation.conversationId,[item('leader-own',[leader.userId])]);await laneScheduler.fillWork(leaderLaneConversation.conversationId);await until(()=>leaderLaneStarted);
 const peerMessage=await store.appendMessage({conversationId:leaderLaneConversation.conversationId,clientMessageId:'while-leader-works',senderId:peer.userId,content:'补充一条不需要工具的新信息',mentions:[leader.userId]});await laneScheduler.dispatch(await store.getConversation(leaderLaneConversation.conversationId),peerMessage);await until(()=>laneCalls.some(c=>c.id.includes('::inbox:')));assert.equal(baseLeaderCalls,0,'full-access coordination must not start before the Leader tool work is released');
 releaseLeaderLane();await until(()=>baseLeaderCalls===1&&!laneScheduler.workLanes.size&&!laneScheduler.runtimeSnapshot().agents.length);await sleep(30);assert.equal(baseLeaderCalls,1,'the Leader result wakes full coordination only once');await laneScheduler.stopConversation(leaderLaneConversation.conversationId);

 // A coordination turn may launch a Leader work lane while another full turn
 // is already pending. The outer loop must requeue it instead of resuming the
 // same provider thread beside the new lane.
 const writerConversation=await conversation('leader-writer-race');let writerScheduler,releaseWriter,writerLane=false,writerBase=0;
 writerScheduler=new LocalScheduler({...base,maxConcurrentWorkPerAgent:10,registry:{cancel:()=>true,runTurn:async(d,input)=>{
  if(d.localUuid.includes('::work:')){writerLane=true;await new Promise(r=>releaseWriter=r);return ok('Leader工作完成');}
  writerBase++;if(writerBase===2){assert.equal(input.fullAccess,false,'Leader coordination inspects and plans but cannot become a hidden writer');assert.equal(input.timeoutMs,undefined);assert.ok(input.prompt.includes('不是隐形执行通道'));}return writerBase===1?ok(encoded({action:'plan',work:[item('writer-work',[leader.userId])]})):ok('SKIP');
 }}});writerScheduler.engagedConversations.add(writerConversation.conversationId);writerScheduler.rememberPending(writerConversation,leader,null,writerConversation.lastSeq,true);
 const writerRun=writerScheduler.runAgentTurn(writerConversation,leader);await until(()=>writerLane);await sleep(25);assert.equal(writerBase,1,'pending full turn cannot overlap a lane launched by the preceding turn');
 releaseWriter();await until(()=>writerBase===2&&!writerScheduler.workLanes.size);await writerRun;await writerScheduler.stopConversation(writerConversation.conversationId);

 // Worker scope excludes peer reassignment claims; missing promised output is not a delivery.
 const scoped=await conversation('scoped-delivery');const owner=await store.currentUser();
 await store.appendMessage({conversationId:scoped.conversationId,clientMessageId:'constraint',senderId:owner.userId,content:'保留原始输入文件'});
 await store.appendMessage({conversationId:scoped.conversationId,clientMessageId:'old-order',senderId:leader.userId,content:'现在改为复制另一题，不用做原来的任务'});
 let sawScope=false;
 const scopeScheduler=new LocalScheduler({...base,maxConcurrentWorkPerAgent:10,validateWorkOutputs:async()=>['draft/expected.txt'],registry:{runTurn:async(d,input)=>{
  if(!d.localUuid.includes('::work:'))return ok('SKIP');
  assert.ok(input.prompt.includes('保留原始输入文件'));assert.ok(!input.prompt.includes('现在改为复制另一题'));sawScope=true;
  return input.discussionOnly?ok('同意'):ok('另一题已经复制');
 }}});scopeScheduler.engagedConversations.add(scoped.conversationId);await scopeScheduler.planner.merge(scoped.conversationId,[item('expected')]);await scopeScheduler.fillWork(scoped.conversationId);
 await until(()=>!scopeScheduler.workLanes.size&&!scopeScheduler.runtimeSnapshot().agents.length);
 assert.ok(sawScope);assert.equal((await store.getConversation(scoped.conversationId)).workPlan[0].status,'blocked');assert.ok(!(await store.listMessages(scoped.conversationId)).some(m=>m.coordination?.phase==='result'));await scopeScheduler.stopConversation(scoped.conversationId);
 // Rejected plan prose remains visible once; only committed control creates work.
 const rejectedPlan=await conversation('uncommitted-plan');let planned=false;const publicationCalls=[];
 const rejectedProse='你现在去覆盖另一份文件。';
 const rejectedRaw=rejectedProse+encoded({action:'plan',work:[item('invalid',['missing-agent'])]});
 const publication=new LocalScheduler({...base,registry:{runTurn:async(d)=>{publicationCalls.push(d.kind);if(planned)return ok('SKIP');planned=true;return ok(rejectedRaw);}}});
 await publication.runAgentTurn(rejectedPlan,leader);
 const decisions=await store.listMessages(rejectedPlan.conversationId);
 const visibleDecisions=decisions.filter(m=>!m.internal&&!m.failed&&m.content===rejectedProse);
 assert.equal(visibleDecisions.length,1,'actual body is visible and published only once');
 assert.equal(visibleDecisions[0].agentReply?.raw,rejectedRaw,'original control remains auditable');
 assert.ok(decisions.some(m=>m.internal&&m.content.includes('工作计划未生效')),'control rejection is still recorded in the feed');
 assert.ok(!(await store.getConversation(rejectedPlan.conversationId)).workPlan?.length,'rejected plan does not enter the work queue');
 assert.ok(!decisions.some(m=>m.coordination),'rejected control does not create task assignments');
 assert.deepEqual(publicationCalls,[leader.kind],'visible body does not trigger other members to execute');
 await publication.stopConversation(rejectedPlan.conversationId);

 const idem=await conversation('duplicate-review');const delivered={...item('delivered'),status:'review',assignmentId:'delivery-v1',completedAt:'v1'};
 await store.updateConversation(idem.conversationId,{workPlan:[delivered]});
 await uninterruptedScheduler.planner.review(idem.conversationId,'delivered','pass','first evidence',delivered);
 await uninterruptedScheduler.planner.review(idem.conversationId,'delivered','pass','duplicate evidence',delivered);
 assert.equal((await store.getConversation(idem.conversationId)).workPlan[0].evidence,'first evidence');
 await assert.rejects(()=>uninterruptedScheduler.planner.review(idem.conversationId,'delivered','pass','stale',{...delivered,assignmentId:'older'}));
 console.log('team-dispatch: self execution, precise failures, idempotent retry, busy leader monitoring, uninterrupted work, isolated parallel lanes, dependencies and cancellation passed');
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
