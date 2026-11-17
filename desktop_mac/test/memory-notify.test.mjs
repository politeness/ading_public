import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {setMainLanguage} from '../dist/i18n.js';
import {LocalStore} from '../dist/store/local.js';
import {KnowledgeService} from '../dist/knowledge/service.js';
import {SkillSyncer} from '../dist/skills/sync.js';
import {withKnowledgeGuidance} from '../dist/knowledge/tools.js';
import {computerToolsEnabled} from '../dist/agents/computer-tools.js';
import {MemoryNotifier,memoryDelta,memorySyncPrompt,confirmsMemorySync} from '../dist/knowledge/memory-notify.js';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const versionOf=prompt=>prompt.match(/ADING_MEMORY_SYNC_DONE (\w+)/)[1];
const codex={kind:'codex',localUuid:'codex-1',executablePath:'/fixture/codex'};
const claude={kind:'claude-code',localUuid:'claude-1',executablePath:'/fixture/claude'};
const done={steps:[],metrics:{iterations:0,sideEffects:false},threadId:'t'};
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-memory-notify-'));
let index=0;
async function fixture(options={}) {
 const root=path.join(dir,`account-${index++}`),store=new LocalStore(root);await store.init();
 const me=await store.currentUser(),turns=[],failures=[];
 let behave=(_agent,input)=>({...done,ok:true,message:`synced\nADING_MEMORY_SYNC_DONE ${versionOf(input.prompt)}`});
 const make=()=>new MemoryNotifier({store,enabled:options.enabled??true,agents:options.agents??(async()=>[codex]),debounceMs:options.debounceMs??30,cooldownMs:options.cooldownMs??0,
  runTurn:async(agent,input)=>{turns.push({agent,input});await options.gate?.();return behave(agent,input);},
  onFailures:list=>failures.push(list)});
 const notify=make(),subscribed=store.subscribe(event=>notify.onStoreEvent(event));
 const add=content=>store.appendMemory({scope:'user',ownerId:me.userId,content,authorKind:'human'});
 const settled=async()=>{await wait((options.debounceMs??30)+40);await notify.idle();};
 return {root,store,me,notify,make,turns,failures,add,settled,behaveAs:fn=>{behave=fn;},close:async()=>{notify.dispose();subscribed();await store.close();}};
}
const state=async root=>JSON.parse(await readFile(path.join(root,'knowledge-memory-sync.json'),'utf8'));

try {
 setMainLanguage('zh');
 // Change list and done marker
 assert.deepEqual(memoryDelta({a:'A2',c:'C'},{a:'A',b:'B'}),{added:['C'],changed:[{before:'A',after:'A2'}],removed:['B']});
 assert.equal(confirmsMemorySync('好了\n**ADING_MEMORY_SYNC_DONE v1**','v1'),true);
 assert.equal(confirmsMemorySync('ADING_MEMORY_SYNC_DONE v0','v1'),false,'an older version confirms nothing');
 assert.equal(confirmsMemorySync('我没有写 ADING_MEMORY_SYNC_DONE v1 这一行','v1'),false,'a mention is not a confirmation');

 // Prompt in zh and en, no longer mentioning ading-memories
 const delta={added:['新增项'],changed:[{before:'旧',after:'新'}],removed:['删除项']};
 const zh=memorySyncPrompt({file:'/central/user.jsonl',version:'v9',delta,full:false});
 for(const text of ['/central/user.jsonl','【新增】','新增项','原内容：旧','新内容：新','【删除】','删除项','记录里不要复述原文','只改你自己的记忆位置','其他 Agent','ADING_MEMORY_SYNC_DONE v9'])assert.ok(zh.includes(text),text);
 assert.ok(memorySyncPrompt({file:'/f',version:'v',delta:{added:['x'],changed:[],removed:[]},full:true}).includes('你第一次收到'));
 setMainLanguage('en');
 const en=memorySyncPrompt({file:'/central/user.jsonl',version:'v9',delta,full:false});
 for(const text of ['/central/user.jsonl','[Added]','Before: 旧','After: 新','[Removed]','without repeating the text','other Agent','ADING_MEMORY_SYNC_DONE v9'])assert.ok(en.includes(text),text);
 assert.ok(!/[一-鿿]/.test(en.replaceAll(/新增项|旧|新|删除项/g,'')),'the English prompt has no Chinese of its own');
 const guided=withKnowledgeGuidance({prompt:'x',onKnowledgeTool:async()=>[]},['/skills/SKILL.md']).prompt;
 assert.ok(guided.includes('ading_memory list')&&guided.includes('/skills/SKILL.md'));
 setMainLanguage('zh');
 const guidedZh=withKnowledgeGuidance({prompt:'x',onKnowledgeTool:async()=>[]},['/skills/SKILL.md']).prompt;
 assert.ok(guidedZh.includes('ading_memory list'));
 for(const text of [zh,en,guided,guidedZh])assert.ok(!text.includes('ading-memories'));
 assert.equal(computerToolsEnabled({fullAccess:true,noComputerTools:true},'darwin'),false);
 assert.equal(computerToolsEnabled({fullAccess:true},'darwin'),true,'ordinary turns keep computer tools');

 {// Merge consecutive changes; send everything the first time; shape of the background round
  const f=await fixture();
  try {
   await f.add('fact one');await f.add('fact two');await f.settled();
   assert.equal(f.turns.length,1,'consecutive changes merge into one turn');
   const {agent,input}=f.turns[0];
   assert.ok(input.prompt.includes('fact one')&&input.prompt.includes('fact two')&&input.prompt.includes('你第一次收到'),'the first sync sends everything');
   assert.ok(input.prompt.includes(path.join(f.root,'memories','user-local_me.jsonl')),'names the central file');
   assert.equal(input.fullAccess,true);assert.equal(input.permissionMode,'unattended');assert.equal(input.noComputerTools,true);
   assert.equal(input.onPermission,undefined,'never raises a permission dialog');
   assert.equal(input.onKnowledgeTool,undefined,'no knowledge write tool, so it cannot write back and loop');
   assert.equal(input.refreshKnowledge,undefined);
   assert.equal(input.workspacePath,path.join(f.root,'memory-sync-runtime','codex'));await access(input.workspacePath);
   assert.equal(agent.localUuid,'codex-1::memory-sync','its own process slot, apart from real turns');
   // No more runs once the version is confirmed and nothing changed
   const saved=await state(f.root);assert.equal(saved.agents.codex.version,versionOf(input.prompt));
   f.notify.catchUp('codex');await wait(20);await f.notify.idle();assert.equal(f.turns.length,1,'a confirmed version is not sent again');
   // Incremental: edits and deletions carry content
   const entries=await f.store.listMemories('user',f.me.userId);
   await f.store.updateMemory(entries.find(entry=>entry.content==='fact one').memoryId,{content:'fact one changed'});
   await f.store.deleteMemory(entries.find(entry=>entry.content==='fact two').memoryId);
   await f.add('fact three');await f.settled();
   assert.equal(f.turns.length,2);
   const next=f.turns[1].input.prompt;
   assert.ok(!next.includes('你第一次收到'),'later syncs send only the change');
   assert.ok(next.includes('原内容：fact one')&&next.includes('新内容：fact one changed')&&next.includes('【删除】\n- fact two')&&next.includes('【新增】\n- fact three'));
  } finally {await f.close();}
 }

 {// Only personal memories trigger
  const f=await fixture();
  try {
   await f.store.appendMemory({scope:'conversation',ownerId:'conv',content:'conversation only',authorKind:'human'});
   await f.store.appendMemory({scope:'workspace',ownerId:'ws',content:'workspace only',authorKind:'human'});
   await f.settled();
   assert.equal(f.turns.length,0,'conversation and workspace memories notify nobody');
   await f.add('personal');await f.settled();
   assert.equal(f.turns.length,1);
   assert.ok(!f.turns[0].input.prompt.includes('conversation only')&&!f.turns[0].input.prompt.includes('workspace only'));
  } finally {await f.close();}
 }

 {// Does not run in the dev build
  const f=await fixture({enabled:false});
  try {
   await f.add('dev change');f.notify.changed();f.notify.catchUp();f.notify.retry();await f.settled();
   assert.equal(f.turns.length,0,'the develop channel runs no background turn');
   await assert.rejects(access(path.join(f.root,'knowledge-memory-sync.json')));
  } finally {await f.close();}
 }

 {// Failures are marked pending, no loop; accumulated changes are re-sent before the next work; dismissed on success
  const f=await fixture();
  try {
   f.behaveAs(()=>({...done,ok:false,error:'not logged in',cancelled:false,threadId:undefined}));
   await f.add('pending fact');await f.settled();
   assert.equal(f.turns.length,1);await wait(60);assert.equal(f.turns.length,1,'a failure is not retried in a loop');
   assert.deepEqual(f.failures.at(-1),[{category:'memories',agents:['codex'],detail:'not logged in'}],'reported per Agent');
   await assert.rejects(access(path.join(f.root,'knowledge-memory-sync.json')),'nothing was confirmed');
   f.behaveAs(()=>({...done,ok:true,message:'回复里没有标记'}));
   f.notify.catchUp('codex');await wait(20);await f.notify.idle();
   assert.equal(f.turns.length,2,'catches up before the next work');
   assert.match(f.failures.at(-1)[0].detail,/没有回报/,'a reply without the marker is not success');
   f.behaveAs((_agent,input)=>({...done,ok:true,message:`ADING_MEMORY_SYNC_DONE ${versionOf(input.prompt)}`}));
   f.notify.catchUp('codex');await wait(20);await f.notify.idle();
   assert.equal(f.turns.length,3);assert.ok(f.turns[2].input.prompt.includes('pending fact'));
   assert.deepEqual(f.failures.at(-1),[],'success drops the failure');
   // Confirmed version survives restart: send only the diff
   const again=f.make();await f.add('after restart');f.notify.dispose();
   again.catchUp();await wait(20);await again.idle();again.dispose();
   assert.equal(f.turns.length,4);assert.ok(f.turns[3].input.prompt.includes('after restart')&&!f.turns[3].input.prompt.includes('pending fact'),'the confirmed version survives a restart');
  } finally {await f.close();}
 }

 {// Cooldown: multiple parallel channels in one round re-send only once
  const f=await fixture({cooldownMs:60_000});
  try {
   f.behaveAs(()=>({...done,ok:false,error:'no quota',cancelled:false}));
   await f.add('x');await f.settled();assert.equal(f.turns.length,1);
   f.notify.catchUp('codex');await wait(20);await f.notify.idle();assert.equal(f.turns.length,1,'catch-up waits out the cooldown');
   f.notify.retry();await wait(20);await f.notify.idle();assert.equal(f.turns.length,2,'the retry button does not');
  } finally {await f.close();}
 }

 {// The same Agent runs only one at a time; changes during it run after it ends; different Agents do not affect each other; unready ones do not count as failures
  let release;const gateOpen=new Promise(resolve=>{release=resolve;});let usable=[codex,claude];
  const f=await fixture({gate:()=>gateOpen,agents:async()=>usable});
  try {
   await f.add('first');await wait(70);
   assert.deepEqual(f.turns.map(turn=>turn.agent.kind).sort(),['claude-code','codex'],'one turn per Agent');
   await f.add('second');await wait(70);
   assert.equal(f.turns.length,2,'never two at once for an Agent');
   release();await f.settled();
   assert.equal(f.turns.length,4,'a change during the turn runs after it');
   assert.ok(f.turns[2].input.prompt.includes('【新增】\n- second')&&!f.turns[2].input.prompt.includes('- first'));
   usable=[codex];await f.add('third');await f.settled();
   assert.equal(f.turns.length,5,'an unusable Agent stays pending');assert.deepEqual(f.failures,[]);
   usable=[codex,claude];f.notify.catchUp();await wait(20);await f.notify.idle();
   assert.equal(f.turns.length,6);assert.equal(f.turns[5].agent.kind,'claude-code');assert.ok(f.turns[5].input.prompt.includes('third'));
  } finally {release();await f.close();}
 }

 {// Exit interruption: counts as neither confirmation nor failure
  const f=await fixture({gate:()=>wait(40)});
  try {
   await f.add('interrupted');await wait(55);assert.equal(f.turns.length,1);
   const {signal}=f.turns[0].input;f.notify.dispose();assert.equal(signal.aborted,true);await f.notify.idle();
   await assert.rejects(access(path.join(f.root,'knowledge-memory-sync.json')));assert.deepEqual(f.failures,[]);
  } finally {await f.close();}
 }

 {// Central library empty and never confirmed: spend no quota
  const f=await fixture();
  try {f.notify.catchUp();await wait(20);await f.notify.idle();assert.equal(f.turns.length,0);}
  finally {await f.close();}
 }

 {// service: prepare returns no memory path and re-syncs asynchronously; failures merge into status and are not wiped by refresh; old copies only clear managed ones
  const root=path.join(dir,'service'),store=new LocalStore(root);await store.init();
  try {
   const me=await store.currentUser(),project=path.join(root,'project');await mkdir(project);
   const sha=value=>createHash('sha256').update(value).digest('hex');
   const legacy=async(vendor,kind,key,marker=true,user=me.userId)=>{const target=path.join(project,vendor,'ading-memories',kind,key);await mkdir(target,{recursive:true});if(marker)await writeFile(path.join(target,'.ading-managed'),JSON.stringify({version:1,type:'memory',contextKey:key,userHash:sha(user)}));await writeFile(path.join(target,'MEMORY.md'),'old');return target;};
   await legacy('.claude','claude-code','a'.repeat(64));await legacy('.codex','codex','b'.repeat(64),true,'someone-else');
   const foreign=await legacy('.qoder','qoder','c'.repeat(64),false);
   const caught=[],states=[],registry={resolveSkillTargets:async()=>[]};
   const make=clean=>new KnowledgeService(store,new SkillSyncer(store,registry,{writeNativeSkills:false}),{kinds:()=>[],resolveWorkspace:async()=>({workspacePath:project,sharesKnowledge:false}),fallback:()=>({workspacePath:project,sharesKnowledge:false}),onSyncState:state=>states.push(state),memoryNotify:{catchUp:kind=>caught.push(kind)},cleanLegacyMemoryCopies:clean});
   const dev=make(false);await dev.refresh();
   await access(path.join(project,'.claude/ading-memories'));
   const service=make(true);await service.refresh();
   await assert.rejects(access(path.join(project,'.claude/ading-memories')),'managed copies are gone, with their empty folders');
   await assert.rejects(access(path.join(project,'.codex/ading-memories')),"another account's managed copies too");
   assert.equal(await readFile(path.join(foreign,'MEMORY.md'),'utf8'),'old','unmarked directories are never touched');
   const [agent]=await store.syncDiscoveredAgents([codex]);
   const conversation=await store.createConversation({name:'x',memberIds:[agent.userId]});
   await store.appendMemory({scope:'user',ownerId:me.userId,content:'y',authorKind:'human'});
   const paths=await service.prepare({conversation,agent,resolution:{workspacePath:project,sharesKnowledge:false}});
   assert.deepEqual(paths,[],'no memory path in the prompt');assert.deepEqual(caught,['codex'],'the Agent catches up before work');
   const failure={category:'memories',agents:['codex'],detail:'no quota'};
   service.setMemorySyncFailures([failure]);assert.deepEqual(states.at(-1).failures,[failure]);
   const refreshed=await service.refresh();assert.equal(refreshed.synced,false,'a pending memory sync failure means not everything is synced');assert.deepEqual(service.syncState().failures,[failure],'a refresh does not clear it');
   service.setMemorySyncFailures([]);assert.deepEqual(service.syncState().failures,[]);
  } finally {await store.close();}
 }
 // Background sync rounds leave no session records: the launch args of these three vendors actually include the no-persistence flag
{
  const {ClaudeCodeAdapter}=await import('../dist/agents/claude.js');
  const {QoderAdapter}=await import('../dist/agents/qoder.js');
  for(const Adapter of [ClaudeCodeAdapter,QoderAdapter]) {
    const input={prompt:'x',workspacePath:'/tmp',fullAccess:true,permissionMode:'unattended'};
    assert.ok(new Adapter().buildArgs({...input,noSessionPersistence:true}).includes('--no-session-persistence'));
    assert.ok(!new Adapter().buildArgs(input).includes('--no-session-persistence'),'ordinary turns stay resumable');
  }
}
console.log('memory-notify: merge, versions, catch-up, develop channel, scopes, prompts and legacy copies passed');
} finally {setMainLanguage('zh');await rm(dir,{recursive:true,force:true});}
