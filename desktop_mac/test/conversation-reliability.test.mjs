import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {SkillSyncer} from '../dist/skills/sync.js';
import {CodexAdapter,retainCodexLine} from '../dist/agents/codex.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-reliability-'));const store=new LocalStore(dir);await store.init();
const discovered=['codex','claude-code','qoder-cn'].map(kind=>({kind,localUuid:kind,executablePath:'/mock',version:'test'}));
const agents=await store.syncDiscoveredAgents(discovered);const [leader,a,b]=discovered.map(d=>agents.find(a=>a.kind===d.kind));const me=await store.currentUser();
const base={store,syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.localUuid===d.localUuid)?.userId===id),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}};
const outcome=message=>({ok:true,threadId:'session',message,steps:[],metrics:{iterations:1,sideEffects:false}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function settled(scheduler){for(let i=0;i<1000;i++){if(!scheduler.runtimeSnapshot().agents.length){await sleep(10);if(!scheduler.runtimeSnapshot().agents.length)return;}await sleep(5);}throw new Error('Scheduling did not converge');}
try {
 const conversation=await store.createConversation({name:'真实调度器三人队列',memberIds:agents.map(a=>a.userId),leaderId:leader.userId,charter:{mode:'execution'}});
 let calls=0;let planned=false;const executed=new Set();
 const scheduler=new LocalScheduler({idleRetryLimit:0,...base,registry:{cancel:()=>true,runTurn:async(d,input)=>{
  assert.ok(++calls<40,'No idle polling loop');const user=agents.find(a=>a.kind===d.kind);const t=await store.getConversation(conversation.conversationId);
  const coord=(await store.listMessages(conversation.conversationId,{limit:1000})).filter(m=>m.coordination?.assigneeId===user.userId).at(-1)?.coordination;
  if(user.userId===leader.userId && !planned){planned=true;return outcome(JSON.stringify({control:{action:'plan',work:[leader,a,b].map((u,i)=>({id:`w${i}`,assignment:'产出独立检查报告',candidates:[u.userId],dependsOn:[],outputs:[],acceptance:'列出核对证据',readOnly:true}))}}));}
  if(coord?.phase==='proposal'){assert.equal(input.discussionOnly,true);return outcome(JSON.stringify({control:{action:'accept',assignmentId:coord.id}}));}
  if(coord?.phase==='accepted'){assert.equal(input.fullAccess,true,'Scope requirement to review originals should not disable report-writing tools');executed.add(user.userId);await sleep(user===b?20:5);return outcome('核查完成，报告证据：测试原始输入逐项一致。');}
  if(user.userId===leader.userId){const review=t.workPlan?.find(w=>w.status==='review');if(review)return outcome(JSON.stringify({control:{action:'review',workId:review.id,verdict:'pass',evidence:'核对三项原始输入的测试报告'}}));}
  return outcome('SKIP');
 }}});
 await scheduler.runAgentTurn(conversation,leader);await settled(scheduler);
 assert.equal(executed.size,3,'All three members, including the Leader and Qoder CN, truly went through acceptance and execution');
 assert.ok((await store.getConversation(conversation.conversationId)).workPlan.every(w=>w.status==='done'),'All dependency states closed out through actual scheduler review');
 const staleConversation=await store.createConversation({name:'迟到结果不得发布旧结论',memberIds:[leader.userId,a.userId],leaderId:leader.userId,charter:{mode:'execution'}});
 let turn=0;const logs=[];
 const stale=new LocalScheduler({idleRetryLimit:0,...base,log:async(e)=>logs.push(e),registry:{cancel:()=>true,runTurn:async()=>{
  if(++turn===1){await store.appendMessage({conversationId:staleConversation.conversationId,clientMessageId:'new-owner',senderId:me.userId,content:'文件已上传，不用再等待'});return outcome('还在等待文件上传');}
  return outcome('收到文件，按最新要求继续');
 }}});
 await stale.runAgentTurn(staleConversation,leader);await settled(stale);
 assert.equal(turn,2);assert.ok(logs.includes('reply-retained-with-new-context'));
 assert.ok((await store.listMessages(staleConversation.conversationId)).some(m=>m.content==='还在等待文件上传' && m.agentReply?.newerInput));
 const failConversation=await store.createConversation({name:'同步失败不影响执行',memberIds:[leader.userId],leaderId:leader.userId,charter:{mode:'execution'}});
 let called=false;const fail=new LocalScheduler({idleRetryLimit:0,...base,syncer:{ensureSynced:async()=>{throw Error('mock write failed');}},registry:{runTurn:async()=>{called=true;return outcome('同步失败仍正常回复');}}});
 await fail.runAgentTurn(failConversation,leader);assert.equal(called,true);const afterFailure=await store.listMessages(failConversation.conversationId);assert.ok(!afterFailure.some(m=>m.failed));assert.ok(afterFailure.some(m=>m.content==='同步失败仍正常回复'));
 const memory=await store.appendMemory({scope:'conversation',ownerId:conversation.conversationId,content:'旧值',authorKind:'agent'});
 await sleep(3);const since=new Date().toISOString();await sleep(3);
 await Promise.all([store.updateMemory(memory.memoryId,{content:'新值'}),...Array.from({length:20},(_,i)=>store.appendMemory({scope:'conversation',ownerId:conversation.conversationId,content:`追加${i}`,authorKind:'agent'}))]);
 const memories=await store.listMemories('conversation',conversation.conversationId,{since});assert.equal(memories.length,21);assert.ok(memories.some(m=>m.content==='新值'));
 const memConversation=await store.createConversation({name:'轮中记忆同步水位',memberIds:[leader.userId],leaderId:leader.userId,charter:{mode:'execution'}});
 const memScheduler=new LocalScheduler({idleRetryLimit:0,...base,registry:{runTurn:async()=>{await sleep(3);await store.appendMemory({scope:'conversation',ownerId:memConversation.conversationId,content:'执行期间新增',authorKind:'agent'});return outcome('完成');}}});
 await memScheduler.runAgentTurn(memConversation,leader);
 const session=await store.getAgentSession(memConversation.conversationId,leader.userId);
 assert.equal((await store.listMemories('conversation',memConversation.conversationId,{since:session.memorySyncedAt})).length,1);
 // When the same AGENTS.md is shared by different vendors, a single-vendor turn does not overwrite another vendor's exclusive skills.
 const skill={skillId:'one',name:'规则',content:'第一版',enabled:true,scope:'global',targets:['qoder-cn'],updatedAt:'fixed',createdAt:'fixed',authorKind:'human'};const writes=[];
 const sync=new SkillSyncer({knowledgeRoot:()=>store.knowledgeRoot(),listSkills:async()=>[skill]}, {
  resolveSkillTargets:async(scope,_p,kinds)=>kinds.map(agentKind=>({agentKind,scope,style:'managed-block',filePath:scope==='workspace'?path.join(dir,'AGENTS.md'):path.join(dir,'native-user',agentKind,'AGENTS.md'),humanNote:'fixture'})),
  syncSkills:async(target,skills)=>{writes.push(skills.map(s=>s.content));return [target.filePath];}
 });
 await sync.ensureSynced({workspacePath:dir,sharesKnowledge:false},['codex']);assert.deepEqual(writes.at(-1),['第一版']);
 skill.content='第二版';await sync.ensureSynced({workspacePath:dir,sharesKnowledge:false},['qoder-cn']);assert.deepEqual(writes.at(-1),['第二版']);
 assert.equal(retainCodexLine(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(100000)}})),undefined);
 const parsed=new CodexAdapter().parseOutput([JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'处理中'}}),JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'最终交付'}})].join('\n'),'session');assert.equal(parsed.message,'最终交付');
 console.log('conversation-reliability: three-agent integration, stale suppression, sync failure, memory watermark/race/update, shared skills and final-only passed');
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
