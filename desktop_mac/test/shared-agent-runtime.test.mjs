import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ClaudeCodeAdapter} from '../dist/agents/claude.js';
import {readClaudeDesktopSelection} from '../dist/agents/claude-config.js';
import {codexRuntimeConfig,codexServiceTier} from '../dist/agents/codex-config.js';
import {AgentRegistry} from '../dist/agents/registry.js';
import {ExecutionAgent} from '../dist/agents/execution-agent.js';
import {mergeRuntimeConfigSnapshot,resolveRuntimeConfig,sessionRuntimeConfig} from '../dist/agents/runtime-config.js';

let reads=0;
const native=async()=>{reads++;return {model:'native-model',reasoningEffort:'high',fastMode:true,source:'native-app'};};
assert.deepEqual(await resolveRuntimeConfig({app:{model:'app-model'},native}),{model:'app-model',reasoningEffort:'high',fastMode:true,source:'ading'});
assert.equal(reads,1,'explicit app model still reads native effort and fast mode');
for(let mask=0;mask<8;mask++){
 const overrides={};
 if(mask&1)overrides.model='app-model';
 if(mask&2)overrides.reasoningEffort='low';
 if(mask&4)overrides.fastMode=false;
 const result=await resolveRuntimeConfig({app:overrides,native});
 assert.equal(result.model,mask&1?'app-model':'native-model');
 assert.equal(result.reasoningEffort,mask&2?'low':'high');
 assert.equal(result.fastMode,!(mask&4),'false is an explicit setting, not missing');
}
const before=reads;
await resolveRuntimeConfig({app:{model:'complete',reasoningEffort:'high',fastMode:false},native});
assert.equal(reads,before,'complete app settings need no native read');
assert.equal((await resolveRuntimeConfig({app:{model:undefined,fastMode:undefined},native})).fastMode,true);
assert.equal((await resolveRuntimeConfig({native})).model,'native-model');
assert.deepEqual(await resolveRuntimeConfig({app:{reasoningEffort:'low'},native}),{model:'native-model',reasoningEffort:'low',fastMode:true,source:'ading'});
assert.equal((await resolveRuntimeConfig({pinned:{model:'pinned'},native})).model,'pinned');
assert.equal((await resolveRuntimeConfig({native:async()=>undefined})).source,'provider-default');
assert.match((await resolveRuntimeConfig({native:async()=>{throw Error('unreadable');}})).notice,/未能读取/);
// A session records what ran, never a user selection: it never pins the model.
const stuck=sessionRuntimeConfig({runtimeConfig:{model:'cli-default',fastMode:false,source:'native settings'}});
assert.equal((await resolveRuntimeConfig({pinned:stuck,native})).model,'native-model','an existing task is not stuck on the model its CLI once defaulted to');
assert.equal((await resolveRuntimeConfig({pinned:stuck,native})).fastMode,true);
assert.equal(mergeRuntimeConfigSnapshot({model:'real-model',source:'native'},{model:'<synthetic>',source:'stream'}).model,'real-model','provider placeholder cannot replace a real model id');
assert.equal((await resolveRuntimeConfig({pinned:{model:'<synthetic>'},native})).model,'native-model','persisted placeholders are discarded for every adapter');

// A model seen in a provider response reports what actually ran; it is not a user
// choice. It must never outrank the selection kept in the vendor's own app, and it
// must not suppress the read that would find that selection.
const observedPin={model:'observed-model',source:'stream',observed:true};
const beforeObserved=reads;
assert.equal((await resolveRuntimeConfig({pinned:observedPin,native})).model,'native-model','an observed model never overrides the vendor app');
assert.equal(reads,beforeObserved+1,'an observed model does not suppress the native read');
assert.equal((await resolveRuntimeConfig({pinned:{...observedPin,reasoningEffort:'low',fastMode:false},native})).fastMode,true,'every field of an observed snapshot is a report, not a setting');
assert.equal(mergeRuntimeConfigSnapshot({model:'chosen',source:'native'},{model:'ran',observed:true}).observed,true,'the marker travels with the values it describes');
assert.equal(mergeRuntimeConfigSnapshot({model:'ran',observed:true},{model:'chosen',source:'native'}).observed,undefined,'a real configuration clears it again');

// The vendor app can be unreadable for a moment - desktop app closed, no session
// file written yet. Falling through to the CLI's own default silently changes the
// model, so the last selection actually read from that app is used, and said so.
const remembered={model:'remembered-model',reasoningEffort:'high',source:'desktop selection'};
const missing=async()=>undefined;
const fallback=await resolveRuntimeConfig({remembered,native:missing});
assert.equal(fallback.model,'remembered-model','a transient read failure keeps the user model');
assert.match(fallback.source,/desktop selection/);assert.match(fallback.notice,/沿用上次/);
assert.equal((await resolveRuntimeConfig({remembered,native})).model,'native-model','a fresh read always wins over the remembered one');
assert.equal((await resolveRuntimeConfig({remembered,native})).notice,undefined,'a successful read is not reported as stale');
assert.equal((await resolveRuntimeConfig({remembered:{...remembered,observed:true},native:missing})).model,undefined,'an observed value is never remembered as a selection');
assert.equal((await resolveRuntimeConfig({app:{model:'app-model'},remembered,native:missing})).model,'app-model');
assert.equal(codexRuntimeConfig({service_tier:'priority'}).fastMode,true);
assert.equal(codexRuntimeConfig({service_tier:'fast'}).fastMode,true);
assert.equal(codexRuntimeConfig({}).fastMode,false);
assert.equal(codexServiceTier({serviceTier:'priority',fastMode:false}),'default');
assert.equal(codexServiceTier({serviceTier:'default',fastMode:true}),'priority');
assert.equal(codexServiceTier({serviceTier:'flex',fastMode:false}),'flex');

// Native configuration reads must honor scope and environment without writing user settings.
const tmp=await mkdtemp(path.join(os.tmpdir(),'ading-native-config-'));
const saved=Object.fromEntries(['CLAUDE_CONFIG_DIR','ANTHROPIC_MODEL','CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_DISABLE_FAST_MODE'].map(key=>[key,process.env[key]]));
try {
 process.env.CLAUDE_CONFIG_DIR=path.join(tmp,'user');
 delete process.env.ANTHROPIC_MODEL;delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
 delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE;
 await mkdir(process.env.CLAUDE_CONFIG_DIR,{recursive:true});
 await mkdir(path.join(tmp,'.claude'));
 await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({model:'user-model',effortLevel:'high',fastMode:true}));
 await writeFile(path.join(tmp,'.claude/settings.json'),JSON.stringify({model:'project-model'}));
 await writeFile(path.join(tmp,'.claude/settings.local.json'),JSON.stringify({model:'local-model'}));
 const claude=new ClaudeCodeAdapter();
 const config=await claude.initializeConfiguration({},tmp);
 assert.equal(config.model,'local-model');assert.equal(config.reasoningEffort,'high');assert.equal(config.notice,undefined);
 assert.equal(config.fastMode,true);
 for(const fastMode of [true,false]){
  const effective=await claude.initializeConfiguration({},tmp,{fastMode});
  const args=claude.extraArgs({runtimeConfig:effective});
  assert.equal(JSON.parse(args[args.indexOf('--settings')+1]).fastMode,fastMode);
  assert.equal(args[args.indexOf('--effort')+1],'high');
 }
 await writeFile(path.join(tmp,'.claude/settings.local.json'),JSON.stringify({model:'local-model',fastMode:false}));
 assert.equal((await claude.initializeConfiguration({},tmp)).fastMode,false);
 await writeFile(path.join(tmp,'.claude/settings.local.json'),JSON.stringify({model:'local-model',fastModePerSessionOptIn:true}));
 assert.equal((await claude.initializeConfiguration({},tmp)).fastMode,false);
 process.env.ANTHROPIC_MODEL='env-model';process.env.CLAUDE_CODE_EFFORT_LEVEL='low';
 assert.equal((await claude.initializeConfiguration({},tmp)).model,'env-model');
 assert.equal((await claude.initializeConfiguration({},tmp)).reasoningEffort,'low');
 assert.equal((await claude.initializeConfiguration({},tmp,{model:'ading-model'})).model,'ading-model');
 // Nothing configured anywhere: report that, instead of labelling whatever the CLI
 // falls back to as the user's own setting, and do not invent a Fast switch.
 for(const file of ['settings.json']) await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR,file),'{}');
 await writeFile(path.join(tmp,'.claude/settings.json'),'{}');
 await writeFile(path.join(tmp,'.claude/settings.local.json'),'{}');
 delete process.env.ANTHROPIC_MODEL;delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
 assert.equal(await claude.readNativeConfiguration({},tmp),undefined,'an empty read is not a configuration');
 const empty=await claude.initializeConfiguration({},tmp);
 assert.equal(empty.model,undefined);assert.equal(empty.source,'provider-default');
 assert.deepEqual(claude.extraArgs({runtimeConfig:empty}),[],'no model, effort or Fast argument is invented');
 const desktop=path.join(tmp,'desktop');
 const sessions=path.join(desktop,'claude-code-sessions','account-one','org-one');
 await mkdir(sessions,{recursive:true});
 await writeFile(path.join(desktop,'config.json'),JSON.stringify({lastKnownAccountUuid:'account-one'}));
 const save=async(id,selection)=>writeFile(path.join(sessions,`local_${id}.json`),JSON.stringify(selection));
 await save('old',{isArchived:false,lastFocusedAt:1,lastActivityAt:999,model:'old'});
 await save('current',{isArchived:false,lastFocusedAt:2,model:'desktop-opus',effort:'high',sessionSettings:{fastMode:false}});
 await save('archived',{isArchived:true,lastFocusedAt:3,model:'archived'});
 const selection=await readClaudeDesktopSelection(desktop);
 assert.equal(selection.model,'desktop-opus');assert.equal(selection.reasoningEffort,'high');
 assert.equal(selection.fastMode,false);
 assert.match(selection.source,/desktop selection/);
 await save('current',{isArchived:false,lastFocusedAt:2});
 assert.equal(await readClaudeDesktopSelection(desktop),undefined,'do not replace current automatic selection with an older model');
 await mkdir(path.join(desktop,'claude-code-sessions','account-one','org-two'));
 assert.equal(await readClaudeDesktopSelection(desktop),undefined,'ambiguous organizations cannot leak settings');
 await writeFile(path.join(desktop,'config.json'),JSON.stringify({lastKnownAccountUuid:'../account-one'}));
 assert.equal(await readClaudeDesktopSelection(desktop),undefined);
} finally {
 for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 await rm(tmp,{recursive:true,force:true});
}

const registry=new AgentRegistry();
for(const {kind} of registry.describeAll()){
 const adapter=registry.adapterFor(kind);
 assert.equal(adapter.runTurn,ExecutionAgent.prototype.runTurn,kind+' must use the shared execution entry');
 assert.equal(adapter.supportsParallelWork,true,kind+' must expose shared parallel work');
 adapter.readNativeConfiguration=native;
 const agent={kind,localUuid:kind,executablePath:'/mock'};
 assert.equal((await adapter.initializeConfiguration(agent,'/tmp',{model:'chosen'})).model,'chosen');
 let childConfig;
 adapter.executeTurn=async(_agent,input)=>{
   if(input.onParallelWork){
     input.onRuntimeConfig({model:'resolved-parent',reasoningEffort:'high',fastMode:false,source:'native-app'});
     const batch=await input.onParallelWork({sharedInstruction:'COMMON_SCOPE_ONLY',jobs:[{id:'one',instruction:'read',outputs:[]}]},input.signal);
     assert.equal(batch.results[0].ok,true);
     assert.ok(batch.results[0].message.length<1800);assert.match(batch.results[0].message,/已截断/);
   } else {
     childConfig=input.runtimeConfig;
     assert.equal(input.steerable,false,kind+' child is not a second steering target');
    assert.equal(input.onPermission,undefined,kind+' unattended child uses native fast approval');
    assert.match(input.prompt,/COMMON_SCOPE_ONLY/);
    assert.ok(input.prompt.indexOf('COMMON_SCOPE_ONLY')<input.prompt.indexOf('唯一当前工作 one'),'shared context is a cacheable prefix before the unique child suffix');
    assert.doesNotMatch(input.prompt,/PARENT_TRANSCRIPT_SECRET/,kind+' child prompt must not copy the parent transcript');
   }
   return {ok:true,message:input.onParallelWork?'done':'x'.repeat(3000),threadId:'fixture',steps:[],metrics:{iterations:0,sideEffects:false,tokenUsage:{inputTokens:10,cachedInputTokens:5,cacheWriteInputTokens:0,outputTokens:2,reasoningOutputTokens:1,totalTokens:12}}};
 };
 const result=await adapter.runTurn(agent,{workspacePath:'/tmp',prompt:'PARENT_TRANSCRIPT_SECRET',fullAccess:true,steerable:true,permissionMode:'unattended',onPermission:async()=>{throw Error('fast approval must not call host')},onProgress:()=>{},parallelWork:{key:kind,limit:10,allowSplit:true,executionSlot:false,sessionBudget:2}});
 assert.equal(result.ok,true);assert.equal(childConfig.model,'resolved-parent',kind+' child inherits actual model');
 assert.equal(childConfig.reasoningEffort,'high');assert.equal(childConfig.fastMode,false,kind+' children preserve Fast off');
 assert.equal(result.metrics.tokenUsage.totalTokens,24,kind+' parent and child usage are merged once');
}

// The shared default is one long-lived provider session. Merely enabling the
// execution policy must not create a planner or child model context.
for(const {kind} of registry.describeAll()){
 const adapter=registry.adapterFor(kind);let calls=0;
 adapter.readNativeConfiguration=async()=>({model:'real-model',source:'fixture'});
 adapter.executeTurn=async(_agent,input)=>{calls++;assert.equal(input.onParallelWork,undefined);input.onRuntimeConfig?.({model:'<synthetic>',source:'provider-event'});return {ok:true,message:'done',threadId:'one-thread',steps:[],metrics:{iterations:0,sideEffects:false}};};
 let snapshot;
 const result=await adapter.runTurn({kind,localUuid:'single-'+kind,executablePath:'/mock'},{workspacePath:'/tmp',prompt:'batch independent tools',fullAccess:true,onProgress:()=>{},onRuntimeConfig:value=>{snapshot=value;},parallelWork:{key:'single:'+kind,limit:10,allowSplit:true,planBeforeExecution:true,executionSlot:false}});
 assert.equal(result.ok,true);assert.equal(calls,1,kind+' defaults to exactly one provider session');assert.equal(snapshot.model,'real-model',kind+' ignores provider placeholder model ids');
}

// A tool-free discussion that reached the provider but produced no text may be
// resumed once. This is safe because the first turn had no tools or side
// effects, and avoids treating a transient silent model stream as a member's
// missing opinion. Execution work and partial replies are never replayed.
class SilentCommunicationFixture extends ExecutionAgent {
 constructor(outcomes){super();this.outcomes=outcomes;this.inputs=[];}
 async readNativeConfiguration(){return {model:'fixture-model',source:'fixture'};}
 async executeTurn(_agent,input){this.inputs.push(input);return this.outcomes.shift();}
}
const silent=new SilentCommunicationFixture([
 {ok:false,error:'Fixture 超过 60 秒还没结束',threadId:'stalled-session',steps:['已连接'],metrics:{iterations:0,sideEffects:false}},
 {ok:true,message:'恢复后的有效意见',threadId:'stalled-session',steps:['已完成'],metrics:{iterations:1,sideEffects:false}}
]);
const recoveryProgress=[];
const recovered=await silent.runTurn({kind:'fixture',localUuid:'fixture'},
 {workspacePath:'/tmp',prompt:'原始讨论',fullAccess:false,discussionOnly:true,communicationOnly:true,onProgress:text=>recoveryProgress.push(text)});
assert.equal(recovered.ok,true);assert.equal(recovered.message,'恢复后的有效意见');assert.equal(silent.inputs.length,2);
assert.equal(silent.inputs[1].threadId,'stalled-session','silent retry resumes the provider session containing the original prompt');
assert.doesNotMatch(silent.inputs[1].prompt,/原始讨论/,'retry sends a nudge instead of duplicating the full request');
assert.ok(recoveryProgress.some(text=>text.includes('重试一次')));

for(const [name,firstInput,firstOutcome] of [
 ['execution',{fullAccess:true},{ok:false,error:'Fixture 超过 60 秒还没结束',threadId:'execution-session',steps:[],metrics:{iterations:0,sideEffects:false}}],
 ['partial',{fullAccess:false,discussionOnly:true,communicationOnly:true},{ok:false,error:'Fixture 超过 60 秒还没结束',threadId:'partial-session',partialMessage:'已有正文',steps:[],metrics:{iterations:0,sideEffects:false}}]
]){
 const fixture=new SilentCommunicationFixture([firstOutcome]);
 const result=await fixture.runTurn({kind:'fixture',localUuid:name},{workspacePath:'/tmp',prompt:name,onProgress:()=>{},...firstInput});
 assert.equal(result.ok,false);assert.equal(fixture.inputs.length,1,`${name} must not be replayed`);
}
// End to end: what one turn observed must not become the next turn's argument, and
// the last selection read from the vendor app has to survive a failed read.
class ObservingFixture extends ExecutionAgent {
 constructor(nativeModel){super();this.nativeModel=nativeModel;this.seen=[];}
 async readNativeConfiguration(){return this.nativeModel?{model:this.nativeModel,source:'vendor app'}:undefined;}
 async executeTurn(_agent,input){
  this.seen.push(input.runtimeConfig);
  input.onRuntimeConfig?.({...input.runtimeConfig,model:'cli-default-model',observed:true,source:'实际使用的模型'});
  return {ok:true,message:'done',threadId:'t',steps:[],metrics:{iterations:0,sideEffects:false}};
 }
}
const observing=new ObservingFixture(undefined);
const observingAgent={kind:'fixture',localUuid:'observing'};
let carried;
const observedTurn=(prompt)=>observing.runTurn(observingAgent,{workspacePath:'/tmp',prompt,fullAccess:true,runtimeConfig:carried,onProgress:()=>{},onRuntimeConfig:value=>{carried=value;}});
await observedTurn('one');
assert.equal(carried.model,'cli-default-model','the turn still reports the model that actually ran');
assert.equal(carried.observed,true,'and keeps it marked as an observation');
observing.nativeModel='user-opus';
await observedTurn('two');
assert.equal(observing.seen[1].model,'user-opus','the next turn follows the vendor app, not the model the CLI happened to pick');
observing.nativeModel=undefined;
await observedTurn('three');
assert.equal(observing.seen[2].model,'user-opus','the last selection read from the vendor app survives a failed read');

for(const file of ['execution-agent','parallel-executor']){
 const text=await readFile(new URL('../src/agents/'+file+'.ts',import.meta.url),'utf8');
 assert.doesNotMatch(text,/Codex|Claude|Qoder|codexModel|providerModel/,'shared runtime cannot contain vendor branches or vendor configuration fields');
 assert.doesNotMatch(text,/executeWithCheckpoint|execution-checkpoint/,'shared execution cannot install an automatic checkpoint wrapper');
}
const scheduler=await readFile(new URL('../src/orchestration/local-scheduler.ts',import.meta.url),'utf8');
assert.doesNotMatch(scheduler,/codexModel|onCodexModel|claudeMcpConfig/);
assert.doesNotMatch(scheduler,/workCheckpointMs|workToolLimit|工作巡检提醒|执行检查点/,'direct and group execution cannot restore automatic checkpoints');
console.log('shared-agent-runtime: every registered adapter, one entry, model precedence, fallback, child inheritance and no automatic checkpoints passed');
