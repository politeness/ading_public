import assert from 'node:assert/strict';
import {chmod,lstat,mkdir,mkdtemp,readFile,readlink,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setMainLanguage} from '../dist/i18n.js';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {KnowledgeService} from '../dist/knowledge/service.js';
import {SkillSyncer} from '../dist/skills/sync.js';
import {MemoryNotifier} from '../dist/knowledge/memory-notify.js';
import {withMemoryIsolationGuidance} from '../dist/knowledge/tools.js';
import {isolatedHome} from '../dist/agents/isolated-home.js';
import {ClaudeCodeAdapter} from '../dist/agents/claude.js';
import {QoderAdapter} from '../dist/agents/qoder.js';
import {QoderCnAdapter} from '../dist/agents/qoder-cn.js';
import {QwenCodeAdapter} from '../dist/agents/qwen.js';
import {CodexAdapter} from '../dist/agents/codex.js';
import {CopilotAdapter} from '../dist/agents/acp-providers.js';

setMainLanguage('zh');
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-shared-isolation-'));
const base={prompt:'x',workspacePath:dir,fullAccess:true,permissionMode:'unattended',onProgress:()=>undefined};
const isolated={...base,isolateMemory:true};
const valueOf=(args,flag)=>args[args.indexOf(flag)+1];
try {
 // Claude: user settings stay, the user rule files and auto memory do not.
 {
  const adapter=new ClaudeCodeAdapter();
  assert.ok(!adapter.buildArgs(base).includes('--settings'),'an ordinary turn adds nothing');
  assert.equal(adapter.turnEnvironment(base),undefined);
  const args=adapter.buildArgs({...isolated,runtimeConfig:{fastMode:true}});
  assert.equal(args.filter(arg=>arg==='--settings').length,1,'Fast and isolation share one --settings');
  const settings=JSON.parse(valueOf(args,'--settings'));
  assert.equal(settings.fastMode,true);assert.equal(settings.autoMemoryEnabled,false);
  assert.ok(settings.claudeMdExcludes.some(item=>item.endsWith('.claude/CLAUDE.md')));
  assert.ok(settings.claudeMdExcludes.some(item=>item.endsWith('.claude/rules/**')));
  assert.ok(!args.includes('--setting-sources'),'login helpers in user settings keep working');
  assert.equal(adapter.turnEnvironment(isolated).CLAUDE_CODE_DISABLE_AUTO_MEMORY,'1');
  assert.ok(adapter.buildArgs({...isolated,threadId:'t'}).includes('--resume'),'resuming is unaffected');
 }
 // Qoder and Qoder CN: each with its own environment prefix.
 for(const [Adapter,prefix] of [[QoderAdapter,'QODER_'],[QoderCnAdapter,'QODERCN_']]) {
  const adapter=new Adapter();
  assert.ok(!adapter.buildArgs(base).includes('--setting-sources'));
  assert.equal(adapter.turnEnvironment(base),undefined);
  assert.equal(valueOf(adapter.buildArgs(isolated),'--setting-sources'),'project,local');
  const env=adapter.turnEnvironment(isolated);
  for(const name of ['MEMORY_HEADLESS','MEMORY_USER','MEMORY_PROJECT','DREAM'])assert.equal(env[prefix+name],'false');
  assert.equal(env.PATH,process.env.PATH,'the rest of the environment stays');
 }
 // Copilot: instructions off only when isolating or discussing.
 {
  const adapter=new CopilotAdapter();
  assert.ok(!(await adapter.prepareAcp(base)).args.includes('--no-custom-instructions'));
  assert.ok((await adapter.prepareAcp(isolated)).args.includes('--no-custom-instructions'));
  const discussion=(await adapter.prepareAcp({...base,discussionOnly:true,isolateMemory:true})).args;
  assert.equal(discussion.filter(arg=>arg==='--no-custom-instructions').length,1);
  assert.ok(!(await adapter.prepareAcp(isolated)).args.includes('--enable-memory'));
 }
 // The mirrored home: hidden entries gone, the rest linked, a replaced credential goes back.
 const real=path.join(dir,'real-home');
 await mkdir(path.join(real,'sessions'),{recursive:true});await mkdir(path.join(real,'memories'));
 for(const name of ['AGENTS.md','AGENTS.override.md','auth.json','config.toml','memories_1.sqlite'])await writeFile(path.join(real,name),name);
 const hideCodex=name=>name==='AGENTS.md'||name==='AGENTS.override.md'||name.startsWith('memories');
 {
  const home=await isolatedHome('fixture',real,hideCodex,['auth.json']);
  try {
   assert.deepEqual((await readdir(home.path)).sort(),['auth.json','config.toml','sessions']);
   assert.equal(await readlink(path.join(home.path,'sessions')),path.join(real,'sessions'));
   await writeFile(path.join(home.path,'sessions','new.jsonl'),'x');
   assert.equal(await readFile(path.join(real,'sessions','new.jsonl'),'utf8'),'x','sessions land in the real home');
   await rm(path.join(home.path,'auth.json'));await writeFile(path.join(home.path,'auth.json'),'rotated');
   await home.settle();
   assert.equal(await readFile(path.join(real,'auth.json'),'utf8'),'rotated','a rotated login is never stranded');
   assert.ok((await lstat(path.join(home.path,'auth.json'))).isSymbolicLink());
   await writeFile(path.join(real,'later.json'),'y');await rm(path.join(real,'config.toml'));
   await writeFile(path.join(home.path,'own-file'),'kept');
   const again=await isolatedHome('fixture',real,hideCodex,['auth.json']);
   const names=await readdir(again.path);
   assert.ok(names.includes('later.json')&&names.includes('own-file')&&!names.includes('config.toml'),'each turn refreshes the links');
   const separate=await isolatedHome('fixture',real,hideCodex,['auth.json'],'another-workspace');
   try {assert.notEqual(separate.path,home.path);assert.ok(!(await readdir(separate.path)).includes('own-file'),'vendor-created files cannot leak across workspaces');}
   finally {await rm(separate.path,{recursive:true,force:true});}
   const parallel=await Promise.all([1,2,3].map(()=>isolatedHome('fixture',real,hideCodex,['auth.json'])));
   assert.equal(new Set(parallel.map(item=>item.path)).size,1,'parallel lanes share it');
   await rm(path.join(real,'AGENTS.md'));await symlink(path.join(real,'auth.json'),path.join(real,'AGENTS.md'));
   assert.ok(!(await readdir((await isolatedHome('fixture',real,hideCodex)).path)).includes('AGENTS.md'));
  } finally {await rm(home.path,{recursive:true,force:true});}
 }
 // Fake CLIs: what the process actually receives.
 const fake=path.join(dir,'fake-cli');
 const capture=path.join(dir,'capture.json');
 await writeFile(fake,`#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),env:process.env}));\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'01234567-89ab-cdef-0123-456789abcdef'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}));console.log(JSON.stringify({type:'turn.completed',usage:{}}));\n`);
 await chmod(fake,0o755);
 {
  const home=path.join(dir,'codex-home');await mkdir(home);
  await writeFile(path.join(home,'AGENTS.md'),'global');await writeFile(path.join(home,'auth.json'),'{}');
  const saved=process.env.CODEX_HOME;process.env.CODEX_HOME=home;
  try {
   const adapter=new CodexAdapter(),agent={kind:'codex',localUuid:'c',executablePath:fake,version:'x'};
   const plain=await adapter.executeTurn(agent,base);assert.equal(plain.ok,true);
   let seen=JSON.parse(await readFile(capture,'utf8'));
   assert.equal(seen.env.CODEX_HOME,home,'an unshared Codex keeps its own home');
   assert.ok(!seen.argv.includes('features.memories=false'),'and its native memory');
   const outcome=await adapter.executeTurn(agent,isolated);assert.equal(outcome.ok,true);
   seen=JSON.parse(await readFile(capture,'utf8'));
   assert.notEqual(seen.env.CODEX_HOME,home);
   const names=await readdir(seen.env.CODEX_HOME);
   assert.ok(names.includes('auth.json')&&!names.includes('AGENTS.md'));
   for(const key of ['features.memories=false','memories.generate_memories=false','memories.use_memories=false'])assert.ok(seen.argv.includes(key),key);
   await adapter.executeTurn(agent,{...isolated,threadId:'01234567-89ab-cdef-0123-456789abcdef'});
   seen=JSON.parse(await readFile(capture,'utf8'));
   assert.ok(seen.argv.includes('resume'),'a resumed isolated turn still resumes');
   await rm(seen.env.CODEX_HOME,{recursive:true,force:true});
  } finally {if(saved===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=saved;}
 }
 // Qwen: home mirrored, memory base moves into the workspace, settings still there.
 {
  const home=path.join(dir,'qwen-home');await mkdir(path.join(home,'memories'),{recursive:true});await mkdir(path.join(home,'rules'));await mkdir(path.join(home,'projects'));
  for(const name of ['QWEN.md','AGENTS.md','settings.json','oauth_creds.json'])await writeFile(path.join(home,name),'{}');
  const saved=process.env.QWEN_HOME;process.env.QWEN_HOME=home;
  try {
   const adapter=new QwenCodeAdapter();
   assert.equal(await adapter.turnEnvironment(base),undefined);
   const env=await adapter.turnEnvironment(isolated);
   assert.equal(env.QWEN_CODE_MEMORY_BASE_DIR,path.join(dir,'.qwen','ading-memory'));
   assert.deepEqual((await readdir(env.QWEN_HOME)).sort(),['oauth_creds.json','projects','settings.json']);
   await rm(env.QWEN_HOME,{recursive:true,force:true});
  } finally {if(saved===undefined)delete process.env.QWEN_HOME;else process.env.QWEN_HOME=saved;}
 }
 // Guidance: both delivery forms, only when isolating.
 {
  assert.equal(withMemoryIsolationGuidance(base),base);
  const guided=withMemoryIsolationGuidance({...isolated,split:{app:'a',dialogue:'d'}});
  assert.ok(guided.prompt.includes('记忆隔离')&&guided.split.app.includes('记忆隔离'));assert.equal(guided.split.dialogue,'d');
 }
 // The scheduler: who is isolated, and what the prompt carries.
 {
  const store=new LocalStore(path.join(dir,'scheduler'));await store.init();
  try {
   const me=await store.currentUser();
   const [agent]=await store.syncDiscoveredAgents([{kind:'qoder-cn',localUuid:'q',version:'t',executablePath:'/mock'}]);
   await store.appendMemory({scope:'user',ownerId:me.userId,content:'主人的个人记忆PERSONAL',authorKind:'human'});
   const calls=[];
   const scheduler=new LocalScheduler({idleRetryLimit:0,store,registry:{runTurn:async(_a,input)=>{calls.push(input);return {ok:true,threadId:'t',message:'好',steps:[],metrics:{iterations:0,sideEffects:false}};}},syncer:{ensureSynced:async()=>[]},knowledge:{prepare:async()=>[],call:async context=>context.isolateMemory},resolveWorkspace:async conversation=>({workspacePath:path.join(dir,conversation.conversationId),sharesKnowledge:false}),resolveDiscovered:()=>({kind:'qoder-cn',localUuid:'q'}),isAgentReady:()=>true,getPermissionMode:async()=>'unattended',requestPermission:async()=>false,log:async()=>undefined,broadcast:()=>undefined});
   const settle=async()=>{for(let i=0;i<400&&scheduler.runtimeSnapshot().agents.length;i++)await new Promise(r=>setTimeout(r,5));};
   const conversation=await store.createConversation({name:'单聊',memberIds:[agent.userId]});
   await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'a',content:'你好'});await settle();
   assert.equal(calls.at(-1).isolateMemory,false,'an unshared Agent keeps its memory, even in an inbox conversation');
   assert.ok(calls.at(-1).prompt.includes('PERSONAL'));
   // Only the owner and their own Agent: shared or not, memory stays available.
   await store.updateContact(agent.userId,{sharedWith:['friend']});
   await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'b',content:'再来'});await settle();
   assert.equal(calls.at(-1).isolateMemory,false,'a shared Agent keeps its memory with its owner alone');
   assert.ok(calls.at(-1).prompt.includes('PERSONAL'));
   assert.equal(await scheduler.memoryIsolated({members:[{userId:agent.userId},{userId:me.userId}]},{...agent,sharedWith:['friend']}),false);
   // Anyone else in the room isolates: with the owner, without the owner, or a member this computer can't resolve.
   await store.upsertPerson?.({userId:'friend',displayName:'朋友',isAgent:false});
   for(const members of [[{userId:agent.userId},{userId:me.userId},{userId:'friend'}],[{userId:agent.userId},{userId:'friend'}],[{userId:agent.userId},{userId:'someone-unknown'}]]) {
    assert.equal(await scheduler.memoryIsolated({members},{...agent,sharedWith:['friend']}),true,JSON.stringify(members));
    assert.equal(await scheduler.memoryIsolated({members},{...agent,sharedWith:[]}),true,'a stale local share list changes nothing');
   }
   // What an isolated turn carries.
   await store.appendMemory({scope:'conversation',ownerId:conversation.conversationId,content:'本会话记忆CONVERSATION',authorKind:'human'});
   const realIsolated=scheduler.memoryIsolated;scheduler.memoryIsolated=async()=>true;
   await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'c',content:'又来'});await settle();
   assert.equal(calls.at(-1).isolateMemory,true);
   assert.equal(calls.at(-1).threadId,undefined,'switching to isolation must discard the transcript containing personal memory');
   assert.ok(!calls.at(-1).prompt.includes('PERSONAL'),'no personal memory in the prompt');
   assert.ok(!(calls.at(-1).split?.app??'').includes('PERSONAL'));
   assert.ok(calls.at(-1).prompt.includes('CONVERSATION'),'conversation memory stays');
   assert.equal(await calls.at(-1).onKnowledgeTool('ading_memory',{action:'list',scope:'user'},new AbortController().signal),true,'the tool call carries the isolation');
   await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:'d',content:'继续'});await settle();
   assert.equal(calls.at(-1).threadId,'t','stable isolation resumes its isolated transcript');
   scheduler.memoryIsolated=realIsolated;
   await scheduler.shutdown();
   assert.equal(await scheduler.memoryIsolated({members:[{userId:agent.userId},{userId:me.userId}]},agent),false);
  } finally {await store.close();}
 }
 // The tool itself: user scope refused in every action, the other scopes untouched.
 {
  const store=new LocalStore(path.join(dir,'tools'));await store.init();
  try {
   const me=await store.currentUser();
   const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'k',version:'t',executablePath:'/mock'}]);
   const conversation=await store.createConversation({name:'x',memberIds:[agent.userId]});
   await store.appendMemory({scope:'user',ownerId:me.userId,content:'PERSONAL',authorKind:'human'});
   const service=new KnowledgeService(store,new SkillSyncer(store,{resolveSkillTargets:async()=>[]},{writeNativeSkills:false}),{kinds:()=>[],resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),fallback:()=>({workspacePath:dir,sharesKnowledge:false})});
   const signal=new AbortController().signal;
   const open={conversation,agent,resolution:{workspacePath:dir,sharesKnowledge:false}},closed={...open,isolateMemory:true};
   assert.equal((await service.call(open,'ading_memory',{action:'list',scope:'user'},signal)).length,1,'unshared reads it');
   for(const args of [{action:'list',scope:'user'},{action:'append',scope:'user',content:'y',userRequested:true},{action:'update',scope:'user',memoryId:'m',content:'y',userRequested:true},{action:'delete',scope:'user',memoryId:'m',userRequested:true}])
    await assert.rejects(service.call(closed,'ading_memory',args,signal),/主人以外/,args.action);
   assert.equal((await store.listMemories('user',me.userId)).length,1,'nothing changed');
   await service.call(closed,'ading_memory',{action:'append',scope:'conversation',content:'本群的事'},signal);
   assert.equal((await service.call(closed,'ading_memory',{action:'list'},signal)).length,1,'conversation memory works');
  } finally {await store.close();}
 }
 // Background sync: a shared Agent still gets personal memory; isolated turns are what keep it from others.
 {
  const store=new LocalStore(path.join(dir,'notify'));await store.init();
  try {
   const me=await store.currentUser(),turns=[];
   const notify=new MemoryNotifier({store,enabled:true,debounceMs:5,cooldownMs:0,agents:async()=>[{kind:'codex',localUuid:'c',executablePath:'/x'}],
    runTurn:async(_a,input)=>{turns.push(input);return {ok:true,threadId:'t',steps:[],metrics:{iterations:0,sideEffects:false},message:`ADING_MEMORY_SYNC_DONE ${input.prompt.match(/ADING_MEMORY_SYNC_DONE (\w+)/)[1]}`};},onFailures:()=>undefined});
   const unsub=store.subscribe(event=>notify.onStoreEvent(event));
   const settled=async()=>{await new Promise(r=>setTimeout(r,40));await notify.idle();};
   const [known]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'c',version:'t',executablePath:'/x'}]);
   await store.updateContact(known.userId,{sharedWith:['friend']});
   await store.appendMemory({scope:'user',ownerId:me.userId,content:'分享期间',authorKind:'human'});await settled();
   assert.equal(turns.length,1,'sharing does not stop the sync');
   assert.ok(turns[0].prompt.includes('分享期间'));
   unsub();notify.dispose();
  } finally {await store.close();}
 }
 console.log('shared-isolation: adapters, mirrored home, fake CLIs, scheduler, tool refusal and sync skip passed');
} finally {setMainLanguage('zh');await rm(dir,{recursive:true,force:true});}
