import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
const root=await mkdtemp(path.join(tmpdir(),"ading-knowledge-source-"));
process.env.ADING_LOG=path.join(root,"test.log");
const {LocalStore}=await import(path.resolve("dist/store/local.js"));
const bundle=await import(path.resolve("dist/knowledge/bundle-files.js"));
const dirs=await import(path.resolve("dist/skills/skill-dir.js"));
const {SkillSyncer}=await import(path.resolve("dist/skills/sync.js"));
const {writeManagedBlock}=await import(path.resolve("dist/skills/block.js"));
const doc=await import(path.resolve("dist/knowledge/skill-document.js"));
let store;let checks=0;
const check=(value)=>{assert.ok(value);checks++;};
const rejects=async(fn)=>{await assert.rejects(fn);checks++;};
const crc32=(bytes)=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;};
const zip=(items)=>{
  const locals=[],centrals=[];let offset=0;
  for(const item of items){const name=Buffer.from(item.name),bytes=Buffer.from(item.bytes??"x"),packed=item.compress?deflateRawSync(bytes):bytes,crc=crc32(bytes),method=item.compress?8:0;const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(0x800,6);l.writeUInt16LE(method,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(packed.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(name.length,26);locals.push(l,name,packed);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(method,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(((item.mode??0o100644)<<16)>>>0,38);c.writeUInt32LE(offset,42);centrals.push(c,name);offset+=l.length+name.length+packed.length;}
  const central=Buffer.concat(centrals),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50);e.writeUInt16LE(items.length,8);e.writeUInt16LE(items.length,10);e.writeUInt32LE(central.length,12);e.writeUInt32LE(offset,16);return Buffer.concat([...locals,central,e]);
};
const skillText="---\nname: bundle-sample\ndescription: >\n  Use this\n  complete package.\nallowed-tools:\n  - Read\n  - Bash\n---\n\n# Exact source\n";
try {
  const source=path.join(root,"source");await mkdir(path.join(source,"assets"),{recursive:true});await mkdir(path.join(source,"scripts"));
  await writeFile(path.join(source,"SKILL.md"),skillText);await writeFile(path.join(source,"assets","binary.png"),Buffer.from([0,255,13,10,12,127]));
  await writeFile(path.join(source,"scripts","run.sh"),"#!/bin/sh\nprintf 'hello\\n'\n");await chmod(path.join(source,"scripts","run.sh"),0o755);
  store=new LocalStore(path.join(root,"central"));await store.init();
  let events=0;store.subscribe(event=>{if(event.type==="skills")events++;});
  const skill=await store.importSkill({sourcePath:source,scope:"global",authorKind:"human"});
  check(skill.directoryName==="bundle-sample"&&skill.source.files.length===3&&events===1);
  check((await readFile(path.join(skill.source.directory,"SKILL.md"),"utf8"))===skillText);
  check((await readFile(path.join(skill.source.directory,"assets/binary.png"))).equals(Buffer.from([0,255,13,10,12,127])));
  check(skill.description==="Use this complete package.\n");
  const toggled=await store.updateSkill(skill.skillId,{enabled:false});check(toggled.source.fingerprint===skill.source.fingerprint&&(await readFile(path.join(toggled.source.directory,"SKILL.md"),"utf8"))===skillText);await store.updateSkill(skill.skillId,{enabled:true});
  const embedded=await store.createSkill({name:"Embedded",description:"Complete source input",content:"---\nname: Embedded\ndescription: Complete source input\nallowed-tools: [Read]\n---\n\nbody only",scope:"workspace",ownerId:"other-ws",authorKind:"human"});check(embedded.content==="body only"&&(await readFile(path.join(embedded.source.directory,"SKILL.md"),"utf8")).match(/^name:/gm).length===1);
  const updated=await store.updateSkill(skill.skillId,{description:"Updated description",content:"# Revised body"});
  const updatedText=await readFile(path.join(updated.source.directory,"SKILL.md"),"utf8");
  check(doc.parseSkillDocument(updatedText).content==="# Revised body"&&updatedText.includes("allowed-tools:")&&!updatedText.includes("complete package."));
  check(updated.source.files.find(item=>item.path==="scripts/run.sh").mode===0o755);
  const originalWrite=store.writeJson.bind(store);store.writeJson=async(relative,...args)=>{if(relative==="skills/index.json")throw new Error("simulated disk failure");return originalWrite(relative,...args);};
  await rejects(()=>store.updateSkill(skill.skillId,{content:"should roll back"}));store.writeJson=originalWrite;
  check((await store.getSkill(skill.skillId)).content==="# Revised body");
  check(!(await readdir(path.join(root,"central/skills"))).some(name=>name.startsWith(".candidate-")||name.startsWith(".backup-")));
  const replica=path.join(root,"replica");await dirs.writeSkillDirs(replica,[updated]);
  await writeFile(path.join(replica,"bundle-sample/assets/binary.png"),"damaged");await dirs.writeSkillDirs(replica,[updated]);
  check((await readFile(path.join(replica,"bundle-sample/assets/binary.png"))).equals(Buffer.from([0,255,13,10,12,127])));
  const own=path.join(root,"own");await mkdir(path.join(own,"bundle-sample"),{recursive:true});await writeFile(path.join(own,"bundle-sample/SKILL.md"),"personal");
  await dirs.writeSkillDirs(own,[updated]);check((await readFile(path.join(own,"bundle-sample/SKILL.md"),"utf8"))!=="personal");{const backups=path.join(root,dirs.BACKUP_DIR);const kept=(await readdir(backups)).filter(name=>name.startsWith("bundle-sample-"));check(kept.length===1&&(await readFile(path.join(backups,kept[0],"SKILL.md"),"utf8"))==="personal");}
  await dirs.writeSkillDirs(replica,[{...updated,enabled:false}]);await rejects(()=>readFile(path.join(replica,"bundle-sample/SKILL.md")));
  const adopt=path.join(root,"adopt");await mkdir(adopt);await bundle.writePackageCandidate(path.join(adopt,"bundle-sample"),await bundle.readSkillPackage(updated.source.directory));
  await dirs.writeSkillDirs(adopt,[updated]);
  check(JSON.parse(await readFile(path.join(adopt,"bundle-sample/.ading-managed"),"utf8")).skillId===updated.skillId);
  check((await readFile(path.join(adopt,"bundle-sample/SKILL.md"),"utf8"))===updatedText);
  await mkdir(path.join(adopt,"personal"));await writeFile(path.join(adopt,"personal/SKILL.md"),"personal");await dirs.removeSkillDirs(adopt);
  check((await readFile(path.join(adopt,"personal/SKILL.md"),"utf8"))==="personal");
  const archive=path.join(root,"sample.zip");await writeFile(archive,zip([{name:"wrapped/SKILL.md",bytes:skillText,compress:true},{name:"wrapped/references/read.txt",bytes:"exact refs",compress:true}]));
  const zskill=await store.importSkill({sourcePath:archive,scope:"workspace",ownerId:"ws-a",authorKind:"human"});check(zskill.source.files.length===2);
  await rejects(()=>store.importSkill({sourcePath:archive,skillId:zskill.skillId,scope:"workspace",ownerId:"ws-b",authorKind:"human"}));
  for(const items of [[{name:"../SKILL.md",bytes:skillText}],[{name:"SKILL.md",bytes:skillText},{name:"SKILL.md",bytes:skillText}],[{name:"SKILL.md",bytes:skillText},{name:"link",mode:0o120777}]]){await writeFile(archive,zip(items));await rejects(()=>store.importSkill({sourcePath:archive,scope:"global",authorKind:"human"}));}
  const linkdir=path.join(root,"links");await mkdir(linkdir);await writeFile(path.join(linkdir,"SKILL.md"),skillText);await symlink(source,path.join(linkdir,"assets"));await rejects(()=>bundle.readSkillPackage(linkdir));
  const legacy=path.join(root,"legacy");await mkdir(path.join(legacy,"skills"),{recursive:true});await writeFile(path.join(legacy,"skills/index.json"),JSON.stringify({k_legacy:{skillId:"k_legacy",name:"Legacy",description:"Legacy rule",scope:"global",enabled:true,authorKind:"human",useCount:0,createdAt:"",updatedAt:""}}));await writeFile(path.join(legacy,"skills/k_legacy.md"),"old content");
  const old=new LocalStore(legacy);try{await old.init();const migrated=await old.getSkill("k_legacy");check(migrated.content==="old content"&&migrated.source.files.length===1);check((await readFile(path.join(legacy,"skills/k_legacy.md"),"utf8"))==="old content");}finally{await old.close();}
  const project=path.join(root,"project");await mkdir(project);
  const native=path.join(root,"global-native");const registry={resolveSkillTargets:async(scope,workspace,kinds)=>kinds.map(kind=>({agentKind:kind,scope,style:"skill-dir",dirPath:scope==="global"?path.join(native,kind):path.join(workspace,kind,"skills"),compatibilityFilePath:path.join(scope==="global"?native:workspace,`${kind}.md`),humanNote:"test"})),syncSkills:async(target,skills)=>{if(target.style==="managed-block"){await writeManagedBlock(target.filePath,skills,{ownerFingerprint:target.ownerFingerprint});return[target.filePath];}return dirs.writeSkillDirs(target.dirPath,skills,{ownerFingerprint:target.ownerFingerprint});},unsyncSkills:async target=>dirs.removeSkillDirs(target.dirPath,{ownerFingerprint:target.ownerFingerprint})};
  const syncer=new SkillSyncer(store,registry);const resolution={workspacePath:project,sharesKnowledge:true,knowledgeOwnerId:"ws-a"};
  await syncer.ensureSynced(resolution,["codex"]);check((await readFile(path.join(native,"codex/bundle-sample/SKILL.md"),"utf8"))===updatedText);check((await readFile(path.join(project,"codex/skills/bundle-sample/references/read.txt"),"utf8"))==="exact refs");
  await store.appendMemory({scope:"user",ownerId:"user-a",content:"current user fact",authorKind:"human"});await store.appendMemory({scope:"user",ownerId:"user-b",content:"OTHER USER SECRET",authorKind:"human"});await store.appendMemory({scope:"workspace",ownerId:"ws-a",content:"current workspace fact",authorKind:"human"});await store.appendMemory({scope:"workspace",ownerId:"ws-b",content:"OTHER WORKSPACE SECRET",authorKind:"human"});const entry=await store.appendMemory({scope:"conversation",ownerId:"conv-a",content:"current conversation fact",authorKind:"human"});await store.appendMemory({scope:"conversation",ownerId:"conv-b",content:"OTHER CONVERSATION SECRET",authorKind:"human"});
  // No more memory copies are generated; those left by released versions are only withdrawn: conversation copies follow the conversation, workspace withdrawal only clears what this user manages, and the user's own directories are untouched
  const legacyCopy=async(target,kind,context)=>{const refs=[{scope:"user",ownerId:context.userId},...(target.sharesKnowledge&&target.knowledgeOwnerId?[{scope:"workspace",ownerId:target.knowledgeOwnerId}]:[]),...(context.conversationId?[{scope:"conversation",ownerId:context.conversationId}]:[])];const sha=value=>createHash("sha256").update(value).digest("hex");const key=sha(JSON.stringify(refs));const directory=path.join(target.workspacePath,".codex/ading-memories",kind,key);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,".ading-managed"),JSON.stringify({version:1,type:"memory",contextKey:key,userHash:sha(context.userId)}));await writeFile(path.join(directory,"MEMORY.md"),"legacy");return path.join(directory,"MEMORY.md");};
  const conversationCopy=await legacyCopy(resolution,"codex",{userId:"user-a",conversationId:"conv-a"}),workspaceCopy=await legacyCopy(resolution,"codex",{userId:"user-a"}),otherUserCopy=await legacyCopy(resolution,"codex",{userId:"user-b",conversationId:"conv-b"});
  await syncer.unsyncMemories(resolution,["codex"],{userId:"user-a",conversationId:"conv-a"});await rejects(()=>readFile(conversationCopy));check((await readFile(workspaceCopy,"utf8"))==="legacy");
  const personalContext=path.join(project,".codex/ading-memories/codex", "f".repeat(64));await mkdir(personalContext);await writeFile(path.join(personalContext,"notes.txt"),"user file");
  await syncer.unsyncWorkspace(resolution,["codex"],{userId:"user-a"});await rejects(()=>readFile(workspaceCopy));check((await readFile(otherUserCopy,"utf8"))==="legacy");check((await readFile(path.join(personalContext,"notes.txt"),"utf8"))==="user file");check((await readFile(path.join(native,"codex/bundle-sample/SKILL.md"),"utf8"))===updatedText);
  await syncer.ensureSynced(resolution,["codex"]);
  // The dev build does not touch each Agent's native directories: sync and withdrawal never touch the registry, and old copies are withdrawn as usual
  let nativeCalls=0;const countingRegistry=new Proxy(registry,{get(target,key){nativeCalls++;return target[key];}});
  const devSyncer=new SkillSyncer(store,countingRegistry,{writeNativeSkills:false});
  check((await devSyncer.ensureSynced(resolution,["codex"])).length===0);await devSyncer.unsyncAll(project,["codex"]);await devSyncer.unsyncWorkspace(resolution,["codex"],{userId:"user-a"});
  check(nativeCalls===0);await syncer.ensureSynced(resolution,["codex"]);
  const missingRegistry={...registry,resolveSkillTargets:async(scope,workspace,kinds)=>registry.resolveSkillTargets(scope,workspace,kinds.filter(kind=>kind!=="qoder"))};
  await new SkillSyncer(store,missingRegistry).ensureSynced(resolution,["codex","qoder"]); // Absent native targets are skipped; real permission errors are covered separately.
  check((await readFile(path.join(native,"codex/bundle-sample/SKILL.md"),"utf8"))===updatedText);
  const index=await readFile(path.join(project,"codex.md"),"utf8");check(index.includes(path.join(zskill.source.directory,"SKILL.md"))&&!index.includes("# Exact source"));check((await readFile(path.join(zskill.source.directory,"references/read.txt"),"utf8"))==="exact refs");
  const originalText=store.writeText.bind(store),beforeEvents=events;
  store.writeText=async(relative,...args)=>{if(relative===`skills/${skill.skillId}.md`)throw new Error("compatibility write failure");return originalText(relative,...args);};
  const committed=await store.updateSkill(skill.skillId,{content:"central committed despite compatibility failure"});store.writeText=originalText;
  check(committed.content.includes("central committed")&&events===beforeEvents+1);
  const recoveryRoot=path.join(root,"recovery"),recoveryStore=new LocalStore(recoveryRoot);await recoveryStore.init();const originalSkill=await recoveryStore.createSkill({name:"Recovery",description:"Recover interrupted transaction",scope:"global",authorKind:"human",content:"before interruption"});await recoveryStore.close();
  const backupName=".backup-11111111-1111-1111-1111-111111111111",candidateName=".candidate-22222222-2222-2222-2222-222222222222";
  await rename(originalSkill.source.directory,path.join(recoveryRoot,"skills",backupName));
  const nextFiles=[{path:"SKILL.md",bytes:Buffer.from("---\nname: Recovery\ndescription: Recover interrupted transaction\n---\n\nafter interruption"),mode:0o644}];await bundle.writePackageCandidate(originalSkill.source.directory,nextFiles);
  await writeFile(path.join(recoveryRoot,"skills/.ading-transaction.json"),JSON.stringify({skillId:originalSkill.skillId,candidate:candidateName,backup:backupName,had:true,fingerprint:bundle.fingerprintPackageFiles(nextFiles)}));
  const restarted=new LocalStore(recoveryRoot);try{await restarted.init();check((await restarted.getSkill(originalSkill.skillId)).content==="before interruption");check(!(await readdir(path.join(recoveryRoot,"skills"))).includes(backupName));}finally{await restarted.close();}
  const otherLibrary=new LocalStore(path.join(root,"other-library"));try{await otherLibrary.init();const independent=await otherLibrary.createSkill({name:"Independent Library",description:"Another account",content:"keep me",scope:"global",authorKind:"human"});await dirs.writeSkillDirs(path.join(native,"codex"),[independent]);await syncer.ensureSynced(resolution,["codex"]);check((await readFile(path.join(native,"codex",independent.directoryName,"SKILL.md"),"utf8")).includes("keep me"));await syncer.unsyncAll(project,["codex"]);check((await readFile(path.join(native,"codex",independent.directoryName,"SKILL.md"),"utf8")).includes("keep me"));}finally{await otherLibrary.close();}
  await store.deleteSkill(skill.skillId);check(await store.getSkill(skill.skillId)===null);
  console.log(`knowledge-source: ${checks} assertions passed`);
} finally {if(store)await store.close();await rm(root,{recursive:true,force:true});}
