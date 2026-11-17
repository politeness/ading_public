import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';
import {LocalStore} from '../dist/store/local.js';
import {SkillSyncer} from '../dist/skills/sync.js';
import {writeManagedBlock} from '../dist/skills/block.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-inbox-'));
const store=new LocalStore(path.join(dir,'data'));await store.init();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(p){for(let i=0;i<600;i++){if(await p())return;await sleep(5);}throw Error('timeout');}
const ok=(message,threadId)=>({ok:true,message,threadId,steps:[],metrics:{iterations:1,sideEffects:false}});
const active=new Map(),calls=[],events=[];let scheduler;
try {
 const discovered=['codex','claude-code','qoder-cn'].map(kind=>({kind,localUuid:kind,executablePath:'/mock'}));
 const agents=await store.syncDiscoveredAgents(discovered);const [leader,worker]=discovered.map(d=>agents.find(a=>a.kind===d.kind));
 const registry={runTurn:(d,input)=>{
  assert.ok(!active.has(d.localUuid));calls.push({d,input});
  return new Promise(resolve=>{const finish=result=>{active.delete(d.localUuid);resolve(result);};active.set(d.localUuid,{d,input,finish});
   input.signal.addEventListener('abort',()=>finish({ok:false,error:'cancelled',cancelled:true,steps:[],metrics:{iterations:0,sideEffects:false}}),{once:true});});
 },cancel:(_kind,id)=>{active.get(id)?.finish({ok:false,error:'cancelled',cancelled:true,steps:[],metrics:{iterations:0,sideEffects:false}});return true;}};
 scheduler=new ConversationScheduler({store,registry,idleRetryLimit:0,concurrentInbox:true,syncer:{ensureSynced:async()=>[]},resolveDiscovered:id=>discovered.find(d=>agents.find(a=>a.kind===d.kind)?.userId===id),isAgentReady:()=>true,
 resolveWorkspace:async t=>{const workspacePath=path.join(dir,t.conversationId);await mkdir(workspacePath,{recursive:true});return{workspacePath,sharesKnowledge:false};},broadcast:(channel,payload)=>events.push({channel,payload}),log:async()=>{}});
 const t=await scheduler.createConversation({name:'same task',memberIds:[leader.userId],initialMessage:'long work'});
 await until(()=>active.size===1);const primary=[...active.values()][0];
 await scheduler.sendUserMessage({conversationId:t.conversationId,clientMessageId:'q1',content:'现在到哪一步？'});
 await until(()=>active.size===2);const inbox=[...active.values()].find(x=>x.d.localUuid.includes('::inbox:'));
 assert.equal(scheduler.runtimeSnapshot().queued.find(q=>q.conversationId===t.conversationId)?.messageState,"processing");
 assert.equal(inbox.input.threadId,undefined);assert.equal(inbox.input.discussionOnly,true);assert.equal(inbox.input.fullAccess,false);
 assert.equal(inbox.input.workspacePath,primary.input.workspacePath);
 inbox.finish(ok('原工作仍在执行，已收到你的问题。','inbox-thread'));
 await until(async()=>(await store.listMessages(t.conversationId)).some(m=>m.agentReply?.lane==='inbox'));
 // The lane handled it, so nothing stays queued to answer it a second time.
 await until(()=>!scheduler.runtimeSnapshot().queued.some(q=>q.conversationId===t.conversationId));
 assert.ok(active.has(primary.d.localUuid),'message answered before long work completes');
 assert.equal(await store.getAgentSession(t.conversationId,leader.userId),null,'inbox thread never overwrites execution session');
 // Burst is coalesced behind one inbox call, while the original remains active.
 await scheduler.sendUserMessage({conversationId:t.conversationId,clientMessageId:'q2',content:'接着核对A'});
 await until(()=>active.size===2);const second=[...active.values()].find(x=>x.d.localUuid.includes('::inbox:'));
 for(let i=0;i<4;i++)await scheduler.sendUserMessage({conversationId:t.conversationId,clientMessageId:'burst'+i,content:'追加方向'+i});
 assert.equal(active.size,2);
 assert.equal(scheduler.runtimeSnapshot().queued.find(q=>q.conversationId===t.conversationId)?.messageState,"waiting");
 second.finish(ok('收到A的要求'));
 await until(()=>[...active.values()].some(x=>x.d.localUuid.includes('::inbox:')&&x!==second));
 const third=[...active.values()].find(x=>x.d.localUuid.includes('::inbox:'));
 assert.ok(third.input.prompt.includes('追加方向3'));
 // Original finishing while inbox stays active must not make the UI idle.
 primary.finish(ok('第一阶段产物','primary-thread'));
 await until(async()=>(await store.getAgentSession(t.conversationId,leader.userId))?.providerThreadId==='primary-thread');
 assert.ok(scheduler.runtimeSnapshot().agents.some(a=>a.conversationId===t.conversationId));
 assert.equal(events.filter(e=>e.channel==='agent:busy'&&e.payload.conversationId===t.conversationId).at(-1).payload.busy,true);
 await scheduler.stopConversation(t.conversationId);await until(()=>active.size===0 && scheduler.runtimeSnapshot().agents.length===0);
 const owner=await store.currentUser();assert.equal((await store.listMessages(t.conversationId)).filter(m=>m.senderId===owner.userId).length,7);
 // Group leader can dispatch independent work while its own execution is still blocked.
 const g=await store.createConversation({name:'pipeline',memberIds:[leader.userId,worker.userId],leaderId:leader.userId,charter:{mode:'execution'}});
 await scheduler.sendUserMessage({conversationId:g.conversationId,clientMessageId:'go',content:'开始加工'});await until(()=>active.size===1);
 const gp=[...active.values()][0];
 await scheduler.sendUserMessage({conversationId:g.conversationId,clientMessageId:'split',content:'把独立核查分给小cc'});await until(()=>active.size===2);
 const gi=[...active.values()].find(x=>x.d.localUuid.includes('::inbox:'));
 gi.finish(ok('已安排独立核查。\n'+JSON.stringify({control:{action:'plan',work:[{id:'check',assignment:'核对独立输入',candidates:[worker.userId],dependsOn:[],outputs:[],acceptance:'实际核查',readOnly:true}]}})));
 await until(()=>[...active.values()].some(x=>x.d.kind==='claude-code'));
 assert.ok(active.has(gp.d.localUuid));assert.equal((await store.getConversation(g.conversationId)).workPlan[0].status,'active');
 // Execution failures also reach the busy leader immediately.
 const failed=await store.appendMessage({conversationId:g.conversationId,clientMessageId:'worker-failure',senderId:worker.userId,type:'SYSTEM',failed:true,content:'工具执行失败，需要协调',mentions:[leader.userId]});
 await scheduler.dispatch(await store.getConversation(g.conversationId),failed);
 await until(()=>[...active.values()].some(x=>x.d.localUuid.includes('::inbox:')));
 const failureInbox=[...active.values()].find(x=>x.d.localUuid.includes('::inbox:'));
 assert.ok(failureInbox.input.prompt.includes('工具执行失败，需要协调'));failureInbox.finish({ok:false,error:'connection interrupted',partialMessage:'已收到故障，正在核对安排。',steps:[],metrics:{iterations:1,sideEffects:false}});
 await until(()=>![...active.values()].some(x=>x.d.localUuid.includes('::inbox:')));
 await until(async()=>(await store.listMessages(g.conversationId)).some(m=>m.agentReply?.lane==='inbox'&&m.agentReply.raw==='已收到故障，正在核对安排。')); 
 // Reports use the inbox independently of the execution thread.
 const report=scheduler.reportConversation(g.conversationId);await until(()=>[...active.values()].some(x=>x.d.localUuid.includes('::inbox:')));
 const gr=[...active.values()].find(x=>x.d.localUuid.includes('::inbox:'));assert.ok(gr.input.prompt.includes('请求汇报目前进展')&&!gr.input.prompt.includes('主人'),'Report prompt uses the initiator\'s name instead of "master"');
 gr.finish(ok('加工仍在进行，核查已派出。'));assert.equal((await report).report,true);assert.ok(active.has(gp.d.localUuid));
 // Role changes invalidate an in-flight report from the previous leader.
 await store.appendMessage({conversationId:g.conversationId,clientMessageId:'before-role-change',senderId:owner.userId,content:'再核对一次进展'});
 const changedReport=scheduler.reportConversation(g.conversationId);
 const rejectedReport=assert.rejects(changedReport,/Leader 已切换/);
 await until(()=>[...active.values()].some(x=>x.d.localUuid.includes('::inbox:')));
 const former=[...active.values()].find(x=>x.d.localUuid.includes('::inbox:'));
 await store.setMemberRole(g.conversationId,worker.userId,'LEADER');former.finish(ok('不应作为新Leader汇报发布'));
 await rejectedReport;
 assert.ok(!(await store.listMessages(g.conversationId)).some(m=>m.content==='不应作为新Leader汇报发布'));
 await store.setMemberRole(g.conversationId,leader.userId,'LEADER');
 // Stop cancels both lanes without touching another task.
 const other=await scheduler.createConversation({name:'other',memberIds:[leader.userId],initialMessage:'unrelated'});await until(()=>[...active.values()].some(x=>x.input.workspacePath.endsWith(other.conversationId)));
 await scheduler.sendUserMessage({conversationId:g.conversationId,clientMessageId:'pending-stop',content:'请说明状态'});await until(()=>[...active.values()].some(x=>x.d.localUuid.includes('::inbox:')));
 await scheduler.stopConversation(g.conversationId);await until(()=>[...active.values()].every(x=>x.input.workspacePath.endsWith(other.conversationId)));
 assert.ok(active.size>0);await scheduler.shutdown();await until(()=>active.size===0 && scheduler.runtimeSnapshot().agents.length===0);
 // Concurrent preparation of a shared AGENTS.md is a single atomic update, including empty skills.
 const writes=new Map();const file=path.join(dir,'shared','AGENTS.md');
 const syncer=new SkillSyncer({knowledgeRoot:()=>store.knowledgeRoot(),listSkills:async()=>[]},{
  resolveSkillTargets:async(scope,_workspace,kinds)=>kinds.map(agentKind=>({scope,style:'managed-block',filePath:scope==='workspace'?file:path.join(dir,'native-user',agentKind,'AGENTS.md'),agentKind,humanNote:'fixture'})),
  syncSkills:async(target,skills)=>{writes.set(target.filePath,(writes.get(target.filePath)??0)+1);await sleep(5);await writeManagedBlock(target.filePath,skills,{ownerFingerprint:target.ownerFingerprint});return[target.filePath];}
 });
 await Promise.all(Array.from({length:12},()=>syncer.ensureSynced({workspacePath:path.dirname(file),sharesKnowledge:false},['codex','qoder-cn'])));
 assert.equal(writes.get(file),1,'twelve callers and two vendors still share one atomic project index write');
 assert.equal(writes.size,3,'global native indexes use distinct fixture paths for both requested vendors');
 assert.ok([...writes.values()].every(count=>count===1));assert.ok((await readFile(file,'utf8')).includes('ADING:BEGIN'));
 console.log('inbox-concurrency: live response, isolated sessions, bounded burst, pipeline dispatch, report, runtime union, cancellation isolation and shared skill sync passed');
} finally {await scheduler?.shutdown();await store.close();await rm(dir,{recursive:true,force:true});}
