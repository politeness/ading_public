import assert from 'node:assert/strict';
import {rm,mkdir,chmod,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp} from './tmp.mjs';
import {LocalStore} from '../dist/store/local.js';
import {KnowledgeService} from '../dist/knowledge/service.js';
import {SkillSyncer} from '../dist/skills/sync.js';
import {describeSyncFailures,withAgentKind,bestEffortSync} from '../dist/knowledge/sync-failure.js';
import {mainMessages} from '../dist/locales/main.js';

// 1. Attribution: explicit tag > longest native path > Agent named in the error > all Agents in this turn
const kinds=['codex','claude-code','qoder','qoder-cn'];
const paths=async()=>[
 {kind:'claude-code',paths:['/home/me/.claude/skills']},
 {kind:'codex',paths:['/home/me/.codex/AGENTS.md']},
 {kind:'qoder',paths:['/home/me/.codex/AGENTS.md','/home/me/.qoder/skills']}
];
const aggregate=new AggregateError([
 withAgentKind(Error('memory denied'),'qoder-cn'),
 Object.assign(Error("EACCES: permission denied, open '/home/me/.claude/skills/review/SKILL.md'"),{code:'EACCES'}),
 Error("EACCES: permission denied, open '/home/me/.codex/AGENTS.md'"),
 Error('无法同步 qoder-cn 的 global 技能目录：目标不存在或不可写'),
 Error('store offline'),
 Error('store offline')
],'nested');
const failures=await describeSyncFailures('skills',new AggregateError([aggregate],'outer'),kinds,paths);
assert.deepEqual(failures.map(failure=>[failure.agents.join(),failure.category]),[
 ['qoder-cn','skills'],['claude-code','skills'],['codex,qoder','skills'],['qoder-cn','skills'],[kinds.join(),'skills']
],'each leaf error is attributed to the Agent(s) it belongs to, duplicates merged');
assert.equal(failures[1].detail,"EACCES: permission denied, open '/home/me/.claude/skills/review/SKILL.md'");
const long=await describeSyncFailures('memories',Error('x'.repeat(5000)),['codex']);
assert.ok(long[0].detail.length<=300&&long[0].detail.endsWith('…'),'details are bounded so a huge AggregateError cannot flood the UI');
assert.equal((await describeSyncFailures('skills',new AggregateError(Array.from({length:50},(_,i)=>Error('e'+i)),'many'),['codex'])).length,20);
assert.deepEqual((await describeSyncFailures('skills',Error('qoder-cn broke'),['qoder','qoder-cn'])).map(f=>f.agents),[['qoder-cn']],'qoder is not matched inside qoder-cn');
let reported;assert.equal(await bestEffortSync(async()=>{throw Error('copy');},'fallback',error=>{reported=error.message;throw Error('observer must not leak');}),'fallback');
assert.equal(reported,'copy');

// 2. KnowledgeService: push when failures change, push an empty list on recovery; pre-run sync failures are only reported, not blocking
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-knowledge-sync-failures-'));
for(const account of ['first-login','second-account']) {
 const root=path.join(dir,account),fresh=new LocalStore(root);await fresh.init();
 const runtime=path.join(root,'knowledge-runtime');
 const realDirectories={invalidate:()=>{},ensureSynced:async resolution=>{await mkdir(path.join(resolution.workspacePath,'skills'));return [];},unsyncMemories:async()=>[],unsyncWorkspace:async()=>[]};
 try {
  const service=new KnowledgeService(fresh,realDirectories,{kinds:()=>['codex'],resolveWorkspace:async()=>({workspacePath:runtime,sharesKnowledge:false}),fallback:()=>({workspacePath:runtime,sharesKnowledge:false})});
  assert.equal((await service.refresh()).synced,true,'fresh login initializes its owned fallback before native copies');
 } finally {await fresh.close();}
}
const store=new LocalStore(dir);await store.init();
try {
 let skillsFail=true,skillErrors=[Error("EACCES: permission denied, mkdir '/home/me/.claude/skills/x'")];
 const syncer={invalidate:()=>{},
  ensureSynced:async()=>{if(skillsFail)throw new AggregateError(skillErrors,'skills');return [];},
  unsyncMemories:async()=>[],unsyncWorkspace:async()=>[]};
 const states=[];
 const service=new KnowledgeService(store,syncer,{kinds:()=>['codex','claude-code'],resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),fallback:()=>({workspacePath:dir,sharesKnowledge:false}),onSyncState:state=>{states.push(state);throw Error('observer failures stay best-effort');},skillPaths:async()=>[{kind:'claude-code',paths:['/home/me/.claude/skills']}]});
 const first=await service.refresh();
 assert.equal(first.synced,false);
 assert.deepEqual(first.failures.map(f=>[f.category,f.agents.join()]),[['skills','claude-code']],'retry result carries who failed');
 assert.equal(states.length,1,'a new failure is pushed to the UI');
 await service.refresh();assert.equal(states.length,1,'an unchanged failure list is not pushed again');
 const me=await store.currentUser();
 const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'fixture',executablePath:'/fixture/codex'}]);
 const conversation=await store.createConversation({name:'sync',memberIds:[agent.userId]});
 skillErrors=[withAgentKind(Error('ENOSPC: no space left on device'),'codex')];
 const refs=await service.prepare({conversation,agent,resolution:{workspacePath:dir,sharesKnowledge:false}});
 assert.ok(Array.isArray(refs),'a failed copy never blocks the turn');
 assert.equal(states.length,2,'pre-turn failures are reported too');
 assert.deepEqual(states.at(-1).failures.map(f=>[f.category,f.agents.join(),f.detail]),[
  ['skills','claude-code',"EACCES: permission denied, mkdir '/home/me/.claude/skills/x'"],
  ['skills','codex','ENOSPC: no space left on device']
 ],'a pre-turn failure adds to the state without erasing other contexts');
 skillsFail=false;
 const recovered=await service.refresh();
 assert.equal(recovered.synced,true);assert.deepEqual(recovered.failures,[]);
 assert.deepEqual(states.at(-1),{failures:[]},'recovery is pushed so the UI can drop the notice');
 assert.ok(me.userId);
} finally {await store.close();await rm(dir,{recursive:true,force:true});}

// 3. A missing working directory at refresh (e.g. a conversation synced from the cloud and never run locally) is not a failure and no directory is created for it; pre-run sync proceeds as usual and real failures are reported as usual
{
 const root=await mkdtemp(path.join(os.tmpdir(),'ading-knowledge-missing-'));
 const data=new LocalStore(path.join(root,'data'));await data.init();
 const exists=target=>access(target).then(()=>true,()=>false);
 const globalTargets=[];
 const registry={resolveSkillTargets:async(scope,workspacePath,kinds)=>{
   const base=scope==='global'?path.join(root,'home'):workspacePath;
   if(scope==='workspace'&&!await exists(base))return [];
   return kinds.map(agentKind=>({agentKind,scope,style:'skill-dir',dirPath:path.join(base,'.'+agentKind,'skills')}));
  },syncSkills:async target=>{if(target.scope==='global')globalTargets.push(target.dirPath);return [];},unsyncSkills:async()=>[]};
 try {
  const [agent]=await data.syncDiscoveredAgents([{kind:'codex',localUuid:'fixture',executablePath:'/fixture/codex'}]);
  const conversation=await data.createConversation({name:'imported',memberIds:[agent.userId]});
  const missing=path.join(root,'inbox',conversation.conversationId);
  const fallback=path.join(root,'knowledge-runtime');
  const service=new KnowledgeService(data,new SkillSyncer(data,registry),{kinds:()=>['codex'],resolveWorkspace:async()=>({workspacePath:missing,sharesKnowledge:false}),fallback:()=>({workspacePath:fallback,sharesKnowledge:false})});
  const refreshed=await service.refresh();
  assert.deepEqual(refreshed.failures,[],'a conversation that has no directory yet is not a sync failure');
  assert.equal(refreshed.synced,true);
  assert.equal(await exists(missing),false,'refresh does not create directories for conversations that never ran here');
  assert.ok(globalTargets.length,'global copies still sync when every conversation directory is missing');
  assert.equal(await exists(fallback),true,'the owned fallback carries that global sync');

  // When it is time to run, resolveFor has created the directory; memory copies are no longer generated
  await mkdir(missing,{recursive:true});
  await service.prepare({conversation,agent,resolution:{workspacePath:missing,sharesKnowledge:false}});
  assert.equal(await exists(path.join(missing,'.codex','ading-memories')),false,'the pre-turn sync writes no memory copy');
  assert.deepEqual(service.syncState().failures,[]);
 // Cloud failures are not refresh's concern: refreshing native copies must not clear them; only cloud success itself dismisses them
 service.setCloudFailure('server 500');
 assert.equal((await service.refresh()).synced,false,'native refresh cannot claim all sync succeeded while cloud sync failed');
 assert.deepEqual(service.syncState().failures.filter(failure=>failure.category==='cloud'),[{category:'cloud',agents:[],detail:'server 500'}]);
 service.setCloudFailure(undefined);
 assert.equal(service.syncState().failures.filter(failure=>failure.category==='cloud').length,0);
 const pushed=[],cloudService=new KnowledgeService({},{},{kinds:()=>[],onSyncState:state=>pushed.push(state)});
 cloudService.setCloudFailure('server 500');cloudService.setCloudFailure('server 500');cloudService.setCloudFailure(undefined);
 assert.deepEqual(pushed.map(state=>state.failures.length),[1,0],'the UI hears each change once, including recovery');
 } finally {await data.close();await rm(root,{recursive:true,force:true});}
}

// 4. Main process copy: failures recorded before deleting a scope need zh/en explanations; the English unread notice must not show "1 unread messages"
const removal=mainMessages['main.knowledge.removalRecordFailed'];
assert.match(removal.zh,/已取消/);assert.match(removal.zh,/\{error\}/);assert.match(removal.en,/cancelled/);assert.match(removal.en,/\{error\}/);
assert.equal(mainMessages['main.notification.unread'].en.replace('{count}','1'),'Unread messages: 1');
console.log('knowledge sync failures: per-Agent attribution, bounded details, push on change/recovery, non-blocking pre-turn reports, missing conversation directories and bilingual removal error passed');

// Missing native roots are optional; a denied root or copy still identifies the failing Agent.
{
 const {AgentRegistry}=await import('../dist/agents/registry.js');
 const {skillRootMayExist}=await import('../dist/agents/cli-agent.js');
 const root=await mkdtemp(path.join(os.tmpdir(),'ading-native-sync-'));
 const denied=path.join(root,'denied');await mkdir(denied);await chmod(denied,0o500);
 const registry=new AgentRegistry();
 const target=(agentKind,scope)=>({agentKind,scope,style:'skill-dir',dirPath:path.join(root,agentKind,'skills')});
 const missingKinds=['qwen-code','kiro','copilot','antigravity'];
 registry.adapters=[
  ...missingKinds.map(kind=>({kind,resolveSkillTarget:async scope=>scope==='global'&&!await skillRootMayExist(path.join(root,kind))?null:target(kind,scope),syncSkills:async()=>[]})),
  {kind:'codex',resolveSkillTarget:async scope=>target('codex',scope),syncSkills:async()=>['codex-ok']},
  {kind:'qoder',resolveSkillTarget:async scope=>target('qoder',scope),syncSkills:async()=>[]}
 ];
 const syncer=new SkillSyncer({listSkills:async()=>[],knowledgeRoot:async()=>root},registry);
 const resolution={workspacePath:root,sharesKnowledge:false};
 try {
  assert.equal(await skillRootMayExist(path.join(root,'not-installed')),false);
  assert.equal(await skillRootMayExist(denied),true,'an existing read-only root still resolves a complete native target');
  assert.ok((await syncer.ensureSynced(resolution,[...missingKinds,'codex','qoder'])).includes('codex-ok'),'missing global roots do not fail the pass');
  const qoder=registry.adapters.at(-1);
  qoder.resolveSkillTarget=async scope=>{if(scope==='global')throw Object.assign(Error(`EACCES: permission denied, access '${denied}'`),{code:'EACCES',path:denied});return target('qoder',scope);};
  let error;try {await syncer.ensureSynced(resolution,['codex','qoder']);}catch(e){error=e;}
  const failed=await describeSyncFailures('skills',error,['codex','qoder']);
  assert.deepEqual(failed.map(f=>f.agents),[['qoder']],'one denied target is not attributed to Codex');
  assert.match(failed[0].detail,/EACCES/);
  const deniedFile=path.join(root,'qoder/skills/.ading-candidate-test/agents/openai.yaml');
  qoder.resolveSkillTarget=async scope=>target('qoder',scope);
  qoder.syncSkills=async()=>{throw Object.assign(new Error(`EPERM: operation not permitted, open '${deniedFile}'`),{code:'EPERM',path:deniedFile});};
  try {await syncer.ensureSynced(resolution,['codex','qoder']);}catch(e){error=e;}
  assert.deepEqual((await describeSyncFailures('skills',error,['codex','qoder'])).map(f=>f.agents),[['qoder']],'openai.yaml is attributed to its destination Agent, not its filename');
  qoder.syncSkills=async()=>{throw new AggregateError([Error('first skill denied'),Error('second skill denied')],'two skills');};
  try {await syncer.ensureSynced(resolution,['codex','qoder']);}catch(e){error=e;}
  const packageErrors=await describeSyncFailures('skills',error,['codex','qoder']);
  assert.deepEqual(packageErrors.map(f=>[f.agents.join(),f.detail]),[['qoder','first skill denied'],['qoder','second skill denied']],'per-skill details survive explicit Agent attribution');
 }finally{await chmod(denied,0o700);await rm(root,{recursive:true,force:true});}
}

// Permission diagnostics distinguish a writable directory from the rejected file operation.
{
 const root=await mkdtemp(path.join(os.tmpdir(),'ading-permission-advice-'));
 try {
  const file=path.join(root,'.ading-candidate-fixture','agents','openai.yaml');
  const failure=Object.assign(Error(`EPERM: operation not permitted, open '${file}'`),{code:'EPERM',path:file,syscall:'open'});
  const [item]=await describeSyncFailures('skills',withAgentKind(failure,'qoder'),['codex','qoder']);
  assert.deepEqual(item.permission,{code:'EPERM',path:file,directory:root,platform:process.platform,directoryWritable:true});
  assert.deepEqual(item.agents,['qoder']);
  const [parsed]=await describeSyncFailures('skills',Error(failure.message),['qoder']);
  assert.equal(parsed.permission.directory,root,'string-only native errors retain their affected directory');
  assert.equal((await describeSyncFailures('skills',Error('ENOSPC: no space left on device'),['codex']))[0].permission,undefined,'disk errors must not suggest access authorization');
 }finally{await rm(root,{recursive:true,force:true});}
}
