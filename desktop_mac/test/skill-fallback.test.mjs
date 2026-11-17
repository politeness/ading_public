import {execFile as exec} from "node:child_process";
import {promisify} from "node:util";
const execFile=promisify(exec);
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,rm,chmod,access,symlink,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from './tmp.mjs';
import {LocalStore} from '../dist/store/local.js';
import {SkillSyncer} from '../dist/skills/sync.js';
import {KnowledgeService} from '../dist/knowledge/service.js';
import {SkillFallback,skillFallbackPrompt} from '../dist/knowledge/skill-fallback.js';
import {applySkillCopy,verifySkillCopy,inspectSkillCopy,canonicalSkillPlan} from '../dist/knowledge/skill-copy.js';
import {observeSkillCopy,compareSkillEvidence} from '../dist/knowledge/skill-verification.js';
import {readPackageDirectory,packageManifest} from '../dist/knowledge/bundle-files.js';
import {setMainLanguage} from '../dist/i18n.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=await mkdtemp(path.join(os.tmpdir(),'ading-skill-self-sync-'));
const store=new LocalStore(path.join(root,'central'));await store.init();
const agent={kind:'qoder',localUuid:'qoder-fixture',executablePath:'/fixture/qoder'};
const result=message=>({ok:true,message,steps:[],metrics:{iterations:0,sideEffects:true}});
const target=(dir,scope='global')=>({agentKind:'qoder',scope,style:'skill-dir',dirPath:dir,ownerFingerprint:'account-a',humanNote:'fixture'});
let fallback;
try {
 const source=path.join(root,'source');await mkdir(path.join(source,'scripts'),{recursive:true});await mkdir(path.join(source,'assets'));
 await writeFile(path.join(source,'SKILL.md'),'---\nname: fixture\ndescription: fixture\n---\nFull package\n');
 await writeFile(path.join(source,'scripts/run.sh'),'#!/bin/sh\necho fixture\n');await chmod(path.join(source,'scripts/run.sh'),0o755);
 await writeFile(path.join(source,'assets/bytes.bin'),Buffer.from([0,255,34,10]));
 let skill=await store.importSkill({sourcePath:source,scope:'global',authorKind:'human'});
 const workspace=path.join(root,'project');await mkdir(workspace);
 const turns=[],states=[],pendingStates=[],events=[];let service,copied=0,mode='copy',usable=true,appDenied=false;
 const make=()=>new SkillFallback({enabled:true,root:()=>store.knowledgeRoot(),agents:async()=>usable?[agent]:[],debounceMs:10,cooldownMs:60_000,
  inspectCopy:async plan=>appDenied?{code:"EPERM",path:plan.target.dirPath,detail:"fixture: app context denied"}:inspectSkillCopy(plan),
  runTurn:async(found,input)=>{
   turns.push({found,input});
   const file=path.join(input.workspacePath,(await readdir(input.workspacePath)).find(name=>name.endsWith('.json')&&!name.endsWith('.result.json')&&(found.localUuid.endsWith('::skill-verify')?name.endsWith('.verify.json'):!name.endsWith('.verify.json'))));
   const task=JSON.parse(await readFile(file,'utf8'));
   if(mode==='fake'||mode==='fakeOnce'){if(mode==='fakeOnce')mode='copy';return result(`ADING_SKILL_SYNC_DONE ${task.version}`);}
   if(mode==='error')return {ok:false,error:'EPERM from the Agent',steps:[],metrics:{iterations:0,sideEffects:false}};
   let stdout;
   try {({stdout}=await execFile(process.execPath,[path.resolve("dist/knowledge/skill-fallback-runner.js"),file]));}
   catch(error){if(task.phase!=="verify")throw error;return {ok:false,error:error.stderr,steps:[],metrics:{iterations:0,sideEffects:false}};}
   if(task.phase==='verify'){
    if(mode==='staleEvidence'){const receipt=JSON.parse(await readFile(file+'.result.json','utf8'));receipt.nonce='stale';await writeFile(file+'.result.json',JSON.stringify(receipt));}
    return result(stdout);
   }
   const nativeFile=path.join(task.plans[0].target.dirPath,task.plans[0].skills[0].directoryName,'SKILL.md');
   if(mode==='corruptVerify')await writeFile(nativeFile,'corrupt native contents');
   if(mode==='corruptOnce'){await writeFile(nativeFile,'bad bytes');mode='copy';}
   if(mode==='denyRead')await chmod(nativeFile,0o000);
   return result(stdout);
  },onFailures:failures=>service?.setSkillFallbackFailures(failures),onPending:pending=>{pendingStates.push(pending);service?.setSkillFallbackPending(pending);},log:(event,data)=>events.push({event,...data}),onCopied:async()=>{copied++;await service?.refresh();}});
 fallback=make();
 const home=path.join(root,'native');
 const registry={resolveSkillTargets:async(scope,workspacePath,kinds)=>kinds.map(agentKind=>({...target(scope==='global'?path.join(home,agentKind):path.join(workspacePath,'.'+agentKind,'skills'),scope),agentKind})),
  syncSkills:async(t,skills)=>{if(t.scope==='global'&&t.agentKind==='qoder')throw Error(`EPERM: operation not permitted, open '${t.dirPath}/.ading-candidate-test/agents/openai.yaml'`);await applySkillCopy({target:t,skills,workspacePath:workspace});return [t.dirPath];},unsyncSkills:async()=>[]};
 const syncer=new SkillSyncer(store,registry,{fallback});
 service=new KnowledgeService(store,syncer,{kinds:()=>['qoder','codex'],resolveWorkspace:async()=>({workspacePath:workspace,sharesKnowledge:false}),fallback:()=>({workspacePath:workspace,sharesKnowledge:false}),onSyncState:state=>states.push(state)});
 assert.equal((await service.refresh()).synced,false,'the initial permission failure is not hidden');
 assert.equal(turns.length,0,'native copy failure does not block on an Agent turn');
 await wait(30);await fallback.idle();
 assert.equal(turns.length,1,'only the failed Agent is called');assert.equal(copied,1);assert.deepEqual(service.syncState().failures,[]);
 const turn=turns[0];assert.equal(turn.found.localUuid,'qoder-fixture::skill-sync');
 assert.equal(turn.input.fullAccess,true);assert.equal(turn.input.permissionMode,'unattended');assert.equal(turn.input.noComputerTools,true);assert.equal(turn.input.noSessionPersistence,true);
 assert.equal(turn.input.onPermission,undefined);assert.equal(turn.input.onKnowledgeTool,undefined);assert.equal(turn.input.refreshKnowledge,undefined);
 const native=path.join(home,'qoder',skill.directoryName);
 assert.deepEqual(await readFile(path.join(native,'assets/bytes.bin')),Buffer.from([0,255,34,10]));
 assert.match(await readFile(path.join(native,'scripts/run.sh'),'utf8'),/echo fixture/);
 await service.refresh();await wait(30);await fallback.idle();assert.equal(turns.length,1,'verified native copies are not delegated again');
 assert.equal((await readdir(turn.input.workspacePath)).filter(name=>name.endsWith('.json')).length,0,'task manifests are cleaned');
 skill=await store.updateSkill(skill.skillId,{content:'Updated central package'});
 await service.refresh();await service.refresh();await wait(30);await fallback.idle();
 assert.equal(turns.length,2,'repeated contexts merge the same changed global package');
 assert.match(await readFile(path.join(native,'SKILL.md'),'utf8'),/Updated central package/);
 assert.deepEqual(await readFile(path.join(native,'assets/bytes.bin')),Buffer.from([0,255,34,10]));
 const successfulCopies=copied;

 // A completion marker alone cannot claim success, and a failed background turn never loops by itself.
 const badPlan={target:target(path.join(root,'fake-native')),skills:[skill],workspacePath:workspace};
 mode='fake';fallback.request(badPlan);await wait(30);await fallback.idle();
 assert.equal(copied,successfulCopies);assert.equal(service.syncState().failures.at(-1).sync.code,'HELPER_NOT_RUN');
 assert.equal(events.filter(event=>event.event==='skill-self-sync-attempt'&&event.issues[0]?.code==='HELPER_NOT_RUN').length,2,'fake completion gets one repair, then stops');
 const count=turns.length;await wait(40);fallback.catchUp();await fallback.idle();assert.equal(turns.length,count,'cooldown prevents an immediate failure loop');
 mode='copy';fallback.retry();await wait(10);await fallback.idle();assert.equal(await verifySkillCopy(badPlan),true);
 // A missing execution receipt and app-side byte mismatch each receive one precise corrective turn.
 for(const scenario of ['fakeOnce','corruptOnce']) {
  const plan={target:target(path.join(root,scenario)),skills:[skill],workspacePath:workspace};
  mode=scenario;const before=turns.length;fallback.request(plan);await wait(30);await fallback.idle();
  assert.equal(turns.length,before+2);assert.equal(await verifySkillCopy(plan),true);
  assert.match(turns.at(-1).input.prompt,scenario==='fakeOnce'?/HELPER_NOT_RUN/:/CONTENT_MISMATCH/);
 }
 assert.ok(pendingStates.some(state=>state.some(item=>item.status==='repairing')));
 assert.ok(events.some(event=>event.event==='skill-self-sync-started'&&event.directIssues.some(issue=>issue.code==='EPERM')),'direct-copy cause survives delegation');
 // Helper execution can succeed while the app is denied read access: never call it a copy mismatch.
 const unreadable={target:target(path.join(root,'unreadable')),skills:[skill],workspacePath:workspace};
 mode='denyRead';const beforeDenied=turns.length;fallback.request(unreadable);await wait(30);await fallback.idle();
 const deniedFailure=service.syncState().failures.at(-1);
 assert.equal(turns.length,beforeDenied+2,'app denial gets one independent read, without blindly copying again');
 assert.equal(deniedFailure.sync.stage,'verification');assert.equal(deniedFailure.sync.code,'EACCES');
 assert.equal(deniedFailure.permission.path,await realpath(path.join(unreadable.target.dirPath,skill.directoryName,'SKILL.md')));
 await chmod(deniedFailure.permission.path,0o644);mode='copy';fallback.retry();await wait(10);await fallback.idle();
 assert.equal(await verifySkillCopy(unreadable),true);
 // Separate process can read a native copy even while the app context is denied.
 appDenied=true;
 const accessible={target:target(path.join(root,'agent-readable')),skills:[skill],workspacePath:workspace};
 setMainLanguage('en');
 const beforeIndependent=turns.length;fallback.request(accessible);await wait(30);await fallback.idle();
 assert.equal(turns.length,beforeIndependent+2);assert.equal(fallback.isVerified(accessible),true);
 assert.equal(turns.at(-1).found.localUuid,'qoder-fixture::skill-verify');assert.ok(!/[一-鿿]/.test(turns.at(-1).input.prompt));assert.match(turns.at(-1).input.prompt,/read-only/);
 assert.equal(turns.at(-1).input.noSessionPersistence,true);assert.equal(turns.at(-1).input.noComputerTools,true);
 setMainLanguage('zh');
 const realNow=Date.now;try{Date.now=()=>realNow()+61_000;assert.equal(fallback.isVerified(accessible),false,'native evidence expires and requires a fresh read');}finally{Date.now=realNow;}
 assert.ok(events.some(event=>event.event==='skill-self-sync-independently-verified'));
 assert.deepEqual(service.syncState().failures,[]);
 assert.equal(fallback.isVerified({...accessible,skills:[{...skill,content:'new source version'}]}),false,'changed plans invalidate cached evidence');
 for(const scenario of ['corruptVerify','staleEvidence']) {
  mode=scenario;const plan={target:target(path.join(root,scenario)),skills:[skill],workspacePath:workspace};
  fallback.request(plan);await wait(30);await fallback.idle();
  assert.equal(fallback.isVerified(plan),false);
  assert.equal(service.syncState().failures.at(-1).sync.code,scenario==='corruptVerify'?'CONTENT_MISMATCH':'EVIDENCE_INVALID');
  fallback.cancelTarget(plan);
 }
 appDenied=false;mode='copy';
 // File-level diagnostics distinguish extra, missing, changed and mode mismatches.
 const checked=path.join(badPlan.target.dirPath,skill.directoryName),asset=path.join(checked,'assets/bytes.bin');
 await writeFile(asset,'changed');assert.equal((await inspectSkillCopy(badPlan)).code,'CONTENT_MISMATCH');
 await rm(asset);assert.equal((await inspectSkillCopy(badPlan)).code,'FILE_MISSING');
 await applySkillCopy(badPlan);await chmod(path.join(checked,'scripts/run.sh'),0o644);
 assert.equal((await inspectSkillCopy(badPlan)).code,'MODE_MISMATCH');
 await applySkillCopy(badPlan);await writeFile(path.join(checked,'extra.txt'),'extra');
 assert.equal((await inspectSkillCopy(badPlan)).code,'EXTRA_FILE');await applySkillCopy(badPlan);
 // Read-only observations are independently compared with central bytes, including mode and ownership.
 const beforeObservation=packageManifest(await readPackageDirectory(checked));
 const evidence=await observeSkillCopy(badPlan);await compareSkillEvidence(badPlan,evidence);
 assert.deepEqual(packageManifest(await readPackageDirectory(checked)),beforeObservation,'verification does not change native files');
 for(const mutate of [
  item=>{item.packages[0].files.pop();},
  item=>{item.packages[0].files[0].mode^=0o111;},
  item=>{item.packages[0].files[0].sha256='0'.repeat(64);},
  item=>{item.packages[0].marker.ownerFingerprint='another-account';},
  item=>{item.managedDirectories.push('ading-stale');},
  item=>{item.key='other-plan';}
 ]){const changed=structuredClone(evidence);mutate(changed);await assert.rejects(compareSkillEvidence(badPlan,changed));}
 await assert.rejects(compareSkillEvidence({...badPlan,skills:[{...skill,source:{...skill.source,fingerprint:'changed'}}]},evidence),error=>error.code==='SOURCE_CHANGED');
 const indexPlan={target:{...target(path.join(root,'unused')),style:'managed-block',dirPath:undefined,filePath:path.join(root,'index.md')},skills:[skill],workspacePath:workspace};
 await applySkillCopy(indexPlan);const indexEvidence=await observeSkillCopy(indexPlan);await compareSkillEvidence(indexPlan,indexEvidence);
 indexEvidence.index.count=2;await assert.rejects(compareSkillEvidence(indexPlan,indexEvidence),error=>error.code==='INDEX_MISMATCH');
 // Provider failure is separate from an Agent which replied success without running the helper.
 const crashed={target:target(path.join(root,'crashed')),skills:[skill],workspacePath:workspace};
 mode='error';fallback.request(crashed);await wait(30);await fallback.idle();
 assert.equal(service.syncState().failures.at(-1).sync.code,'AGENT_TURN_FAILED');
 assert.match(service.syncState().failures.at(-1).detail,/EPERM from the Agent/);fallback.cancelTarget(crashed);mode='copy';
 // Runner failures still produce a receipt and do not prevent independent targets from completing.
 const helperDenied=path.join(root,'helper-denied');await mkdir(helperDenied);await chmod(helperDenied,0o500);
 const receiptTask=path.join(root,'helper-task.json'),independent=path.join(root,'independent');
 await writeFile(receiptTask,JSON.stringify({version:'receipt-fixture',language:'en',plans:[{target:target(helperDenied),skills:[skill],workspacePath:workspace},{target:target(independent),skills:[skill],workspacePath:workspace}]}));
 try {
  await assert.rejects(execFile(process.execPath,[path.resolve('dist/knowledge/skill-fallback-runner.js'),receiptTask]));
  const receipt=JSON.parse(await readFile(receiptTask+'.result.json','utf8'));
  assert.equal(receipt.ok,false);assert.equal(receipt.version,'receipt-fixture');assert.equal(receipt.issues[0].code,'EACCES');
  assert.equal(await verifySkillCopy({target:target(independent),skills:[skill],workspacePath:workspace}),true);
 }finally{await chmod(helperDenied,0o700);}
 // Recoverability on restart: normal startup sync reconstructs pending work from the central library.
 fallback.dispose();await rm(path.join(home,'qoder'),{recursive:true,force:true});fallback=make();
 fallback.request({target:{...target(path.join(home,'qoder')),ownerFingerprint:JSON.parse(await readFile(path.join(home,'codex',skill.directoryName,'.ading-managed'),'utf8')).ownerFingerprint},skills:[skill],workspacePath:workspace});
 await wait(30);await fallback.idle();await access(path.join(native,'SKILL.md'));
 // Scope isolation and cancellation: an unavailable Agent stays pending, removed workspaces are not recreated.
 usable=false;const cancelled={target:target(path.join(root,'removed-workspace','.qoder/skills'),'workspace'),skills:[skill],workspacePath:path.join(root,'removed-workspace')};
 fallback.request(cancelled);await wait(25);fallback.cancelWorkspace(cancelled.workspacePath);usable=true;fallback.catchUp();await wait(10);await fallback.idle();await assert.rejects(access(cancelled.target.dirPath));
 // Existing user skills and another account's package are preserved by the same copy helper as normal sync.
 const protectedRoot=path.join(root,'protected');await mkdir(path.join(protectedRoot,'personal'),{recursive:true});await writeFile(path.join(protectedRoot,'personal/SKILL.md'),'keep');
 await applySkillCopy({target:target(protectedRoot),skills:[skill],workspacePath:workspace});
 await applySkillCopy({target:{...target(protectedRoot),ownerFingerprint:'other-account'},skills:[skill],workspacePath:workspace});
 {const backups=path.join(root,'.ading-skill-backup');const kept=(await readdir(backups)).filter(name=>name.startsWith(`${skill.directoryName}-`));assert.equal(kept.length,1,'the previous account copy is kept in the backup');assert.ok(JSON.parse(await readFile(path.join(backups,kept[0],'.ading-managed'),'utf8')).ownerFingerprint!=='other-account');}
 assert.equal(await readFile(path.join(protectedRoot,'personal/SKILL.md'),'utf8'),'keep');
 assert.equal(await verifySkillCopy({target:target(protectedRoot),skills:[{...skill,directoryName:'../escape'}],workspacePath:workspace}),false,'verification never accepts a path outside the native root');

 // A real adapter with a read-only config root still yields a target and queues fallback after the actual copy fails.
 const {KiroAdapter}=await import('../dist/agents/acp-providers.js');
 const {AgentRegistry}=await import('../dist/agents/registry.js');
 const deniedHome=path.join(root,'denied-home'),deniedConfig=path.join(deniedHome,'.kiro');
 await mkdir(deniedConfig,{recursive:true});await chmod(deniedConfig,0o500);
 try {
  const nativeRegistry=new AgentRegistry();nativeRegistry.adapters=[new KiroAdapter(deniedHome)];
  const queued=[];
  const deniedSyncer=new SkillSyncer(store,nativeRegistry,{fallback:{request:plan=>queued.push(plan),cancelWorkspace:()=>{},cancelTarget:()=>{},isRunning:()=>false}});
  await deniedSyncer.ensureSynced({workspacePath:workspace,sharesKnowledge:false},['kiro']);
  assert.equal(queued.length,1);assert.equal(queued[0].target.dirPath,path.join(deniedConfig,'skills'));
 }finally{await chmod(deniedConfig,0o700);}
 // Native root links are resolved by the Agent helper, not by weakening package validation.
 const linkedReal=path.join(root,'linked-real');await mkdir(linkedReal);
 const linkedRoot=path.join(root,'linked-skills');await symlink(linkedReal,linkedRoot);
 const linkedPlan={target:target(linkedRoot),skills:[skill],workspacePath:workspace};
 await assert.rejects(applySkillCopy(linkedPlan),/符号链接|symbolic/);
 fallback.request(linkedPlan);await wait(30);await fallback.idle();
 assert.equal(await verifySkillCopy(linkedPlan),true,'Agent runner can sync through a native root link');
 assert.deepEqual(await readFile(path.join(linkedReal,skill.directoryName,'assets/bytes.bin')),Buffer.from([0,255,34,10]));
 const outside={...linkedPlan,target:target(linkedRoot,'workspace')};
 await assert.rejects(canonicalSkillPlan(outside),/工作区|workspace/);
 await assert.rejects(canonicalSkillPlan({...linkedPlan,target:target(skill.source.directory)}),/中央源|central source/);
 // Develop channel leaves native directories alone.
 const dev=new SkillFallback({enabled:false,root:()=>store.knowledgeRoot(),agents:async()=>[agent],runTurn:async()=>{throw Error('must not run');},onFailures:()=>{},onCopied:async()=>{}});
 dev.request(badPlan);dev.catchUp();await wait(20);await dev.idle();dev.dispose();
 setMainLanguage('en');const prompt=skillFallbackPrompt('/central/task.json','v1');assert.ok(!/[一-鿿]/.test(prompt));assert.match(prompt,/complete packages/);assert.match(prompt,/Do not change the central sources/);
 setMainLanguage('zh');assert.match(skillFallbackPrompt('/central/task.json','v1'),/不改中央源/);
 console.log('skill fallback: background failed-Agent routing, complete packages, native verification, no false completion, deduplication, cooldown, retry, restart, cancellation, scope/account protection and bilingual prompts passed');
}finally{fallback?.dispose();await fallback?.idle();await store.close();await rm(root,{recursive:true,force:true});}
