import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {WorkPlanner} from '../dist/orchestration/work-plan.js';
import {parseLeaderControl} from '../dist/orchestration/control.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-work-plan-'));
const store=new LocalStore(dir); await store.init();
const agents=await store.syncDiscoveredAgents(['codex','claude-code','qoder-cn','qoder'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'})));
const [leader,fast,slow,offline]=['codex','claude-code','qoder-cn','qoder'].map(k=>agents.find(a=>a.kind===k));
const busy=new Set();const unavailable=new Set([offline.userId]);const delivered=[];
const planner=new WorkPlanner({store,available:id=>!unavailable.has(id),busy:id=>busy.has(id),log:async()=>{},deliver:async(t,a,m)=>{if(m.coordination){busy.add(a.userId);delivered.push(m);}}});
const item=(id,candidates,extra={})=>({id,assignment:`执行 ${id}`,candidates,dependsOn:[],outputs:[`draft/${id}.png`],acceptance:'对照原件确认完整并提供文件证据',readOnly:false,...extra});
try {
 const conversation=await store.createConversation({name:'动态补位',memberIds:agents.map(a=>a.userId),leaderId:leader.userId});
 const work=[item('hard',[leader.userId]),item('a',[fast.userId,slow.userId]),item('b',[fast.userId,slow.userId]),item('c',[fast.userId,slow.userId]),item('final',[leader.userId],{dependsOn:['a','b','c','hard']}),item('offline',[offline.userId])];
 assert.equal(parseLeaderControl(JSON.stringify({control:{action:'plan',work}})).control.work.length,6);
 await planner.merge(conversation.conversationId,work);
 await Promise.all([planner.fill(conversation.conversationId),planner.fill(conversation.conversationId)]);
 assert.equal(delivered.length,3,'initially all three available members get independent work; repeated fill does not re-dispatch');
 assert.deepEqual(new Set(delivered.map(m=>m.coordination.assigneeId)),new Set([leader.userId,fast.userId,slow.userId]));
 const a=delivered.find(m=>m.coordination.workId==='a').coordination;
 await planner.transition(conversation.conversationId,a,'result');
 await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'result-a',senderId:fast.userId,content:'a已提交',coordination:{...a,phase:'result'}});
 busy.delete(fast.userId);await planner.fill(conversation.conversationId);
 assert.equal(delivered.at(-1).coordination.workId,'c','the faster member takes the next item without waiting for slower members');
 assert.equal(delivered.at(-1).coordination.assigneeId,fast.userId);
 assert.ok(!delivered.some(m=>m.coordination.workId==='final'),'submission is not acceptance; dependents stay locked');
 await assert.rejects(planner.merge(conversation.conversationId,[item('b',[fast.userId])]),/不能改写/);
 await assert.rejects(planner.merge(conversation.conversationId,[item('cycle1',[fast.userId],{dependsOn:['cycle2']}),item('cycle2',[fast.userId],{dependsOn:['cycle1']})]),/环/);
 await assert.rejects(planner.merge(conversation.conversationId,[item('missing',[fast.userId],{dependsOn:['absent']})]),/依赖不存在/);
 await assert.rejects(planner.merge(conversation.conversationId,[item('directory-only',[fast.userId],{outputs:['draft/']})]),/不能只声明目录/);
 for(const m of [...delivered]) {
  const c=m.coordination;
  if(c.workId!=='a'){
   await planner.transition(conversation.conversationId,c,'result');
   await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:`result-${c.workId}`,senderId:c.assigneeId,content:'已提交',coordination:{...c,phase:'result'}});
  }
  await planner.review(conversation.conversationId,c.workId,'pass','读取草稿，对照源图逐项确认');busy.delete(c.assigneeId);
 }
 await planner.fill(conversation.conversationId);assert.equal(delivered.at(-1).coordination.workId,'final');
 await store.setConversationPaused(conversation.conversationId,true);await planner.fill(conversation.conversationId);assert.equal(delivered.length,5);
 const reopened=new LocalStore(dir);await reopened.init();assert.equal((await reopened.getConversation(conversation.conversationId)).workPlan.find(w=>w.id==='a').status,'done');await reopened.close();
 const conflict=await store.createConversation({name:'写入冲突',memberIds:[leader.userId,fast.userId,slow.userId],leaderId:leader.userId});
 busy.clear();
 await planner.merge(conflict.conversationId,[item('one',[fast.userId],{outputs:['draft/shared.png']}),item('two',[slow.userId],{outputs:['draft/shared.png']})]);
 const count=delivered.length;await planner.fill(conflict.conversationId);assert.equal(delivered.length-count,1,'only one owner per file at a time');
 for (const [firstReadOnly,secondReadOnly] of [[true,true],[true,false],[false,true]]) {
  const reports=await store.createConversation({name:'报告写入互斥',memberIds:[leader.userId,fast.userId,slow.userId],leaderId:leader.userId});
  busy.clear();
  await planner.merge(reports.conversationId,[item('review1',[fast.userId],{readOnly:firstReadOnly,outputs:['reports/shared.txt']}),item('review2',[slow.userId],{readOnly:secondReadOnly,outputs:['reports/shared.txt']})]);
  const start=delivered.length;await planner.fill(reports.conversationId);
  assert.equal(delivered.length-start,1,'checking the original must also hold the report output path');
  const first=delivered.at(-1).coordination;
  await planner.transition(reports.conversationId,first,'result');busy.clear();
  await planner.fill(reports.conversationId);assert.equal(delivered.length-start,1,'report cannot be overwritten while awaiting acceptance');
 }
 const agreed=await store.createConversation({name:'讨论已确认',memberIds:[leader.userId,fast.userId],leaderId:leader.userId});
 await store.updateConversation(agreed.conversationId,{brainstorm:{phase:'ready',revision:6,round:2,probes:0,attempts:0,leaderId:leader.userId,inputSeq:0,participants:[leader.userId,fast.userId],confirmedParticipants:[fast.userId],responses:{}}});
 busy.clear();const before=delivered.length;await planner.merge(agreed.conversationId,[item('agreed',[fast.userId],{preAgreed:true})]);await planner.fill(agreed.conversationId);
 assert.equal(delivered.length,before+1);assert.equal(delivered.at(-1).coordination.phase,'accepted','exactly pre-agreed work skips a redundant proposal turn');
 const merelyPresent=await store.createConversation({name:'只参加过讨论',memberIds:[leader.userId,slow.userId],leaderId:leader.userId});
 await store.updateConversation(merelyPresent.conversationId,{brainstorm:{phase:'ready',revision:2,round:1,probes:0,attempts:0,leaderId:leader.userId,inputSeq:0,participants:[leader.userId,slow.userId],responses:{}}});busy.clear();
 await planner.merge(merelyPresent.conversationId,[item('not-confirmed',[slow.userId],{preAgreed:true})]);await planner.fill(merelyPresent.conversationId);
 assert.equal(delivered.at(-1).coordination.phase,'proposal','mere brainstorm participation cannot silently authorize a materially different method');
 const redirected=await store.createConversation({name:'纠偏续做',memberIds:[leader.userId,fast.userId],leaderId:leader.userId});
 await store.updateConversation(redirected.conversationId,{brainstorm:{phase:'ready',revision:3,round:2,probes:0,attempts:0,leaderId:leader.userId,inputSeq:0,participants:[leader.userId,fast.userId],confirmedParticipants:[fast.userId],responses:{}}});
 busy.clear();await planner.merge(redirected.conversationId,[item('sample',[fast.userId],{preAgreed:true})]);await planner.fill(redirected.conversationId);
 const old=delivered.at(-1).coordination;let aborted=false;
 assert.equal(await planner.redirect(redirected.conversationId,leader.userId,old,'改用已验证工具，只做一个样本，失败即停止','实查旧样本不通过',()=>{aborted=true;},leader.userId),true);
 const revised=(await store.getConversation(redirected.conversationId)).workPlan[0];
 assert.ok(aborted);assert.equal(revised.status,'queued');assert.equal(revised.assignment,'改用已验证工具，只做一个样本，失败即停止');assert.deepEqual(revised.candidates,[leader.userId]);assert.equal(revised.assigneeId,undefined);assert.equal(revised.assignmentId,undefined);assert.equal(revised.preAgreed,true);assert.equal(revised.resumeAfterInterrupt,true);assert.equal(revised.interventions,1);
 busy.clear();await planner.fill(redirected.conversationId);assert.equal(delivered.at(-1).coordination.phase,'accepted','after a Leader correction, the same work continues directly without renegotiation');
 console.log('work-plan: dependency, dynamic refill, leader work, offline, durable state, cycle and output ownership passed');
} finally {await store.close();await rm(dir,{recursive:true,force:true});}
