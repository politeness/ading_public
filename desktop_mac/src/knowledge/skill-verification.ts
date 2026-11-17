import {p} from "../prompt-language";
import {createHash} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import path from "node:path";
import {canonicalSkillPlan,skillCopyKey,SkillCopyVerificationError,type SkillCopyPlan} from "./skill-copy";
import {readPackageDirectory,packageManifest,fingerprintPackageFiles,validatePackageFiles} from "./bundle-files";
import {skillSlug,renderSkillFile} from "../skills/skill-dir";
import {BLOCK_BEGIN,BLOCK_END,renderManagedBlock} from "../skills/block";

const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
export interface SkillCopyEvidence {
  key:string;
  packages:Array<{name:string;files:ReturnType<typeof packageManifest>;marker:{skillId:string;ownerFingerprint?:string;fingerprint:string}}>;
  managedDirectories:string[];
  index?:{count:number;sha256:string};
}
/** A separate, read-only invocation observes native bytes. It never copies or repairs. */
export async function observeSkillCopy(original:SkillCopyPlan):Promise<SkillCopyEvidence> {
  const {target,skills}=await canonicalSkillPlan(original);
  const evidence:SkillCopyEvidence={key:skillCopyKey(original),packages:[],managedDirectories:[]};
  if(target.style==="managed-block"&&target.filePath) {
    const text=await readFile(target.filePath,"utf8"),start=text.indexOf(BLOCK_BEGIN),end=text.indexOf(BLOCK_END,start);
    evidence.index={count:text.split(BLOCK_BEGIN).length-1,sha256:hash(start>=0&&end>=start?text.slice(start,end+BLOCK_END.length):"")};
    return evidence;
  }
  if(!target.dirPath)throw Error(p("缺少原生技能目录","Missing native skill directory"));
  for(const skill of skills.filter(skill=>skill.enabled)) {
    const name=skill.directoryName??skillSlug(skill);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name))throw Error(p("原生技能目录无效","Invalid native skill directory"));
    const files=await readPackageDirectory(path.join(target.dirPath,name));
    const marker=JSON.parse(Buffer.from(files.find(file=>file.path===".ading-managed")?.bytes??[]).toString("utf8"));
    evidence.packages.push({name,files:packageManifest(files.filter(file=>file.path!==".ading-managed")),marker:{skillId:marker.skillId,ownerFingerprint:marker.ownerFingerprint,fingerprint:marker.fingerprint}});
  }
  // Read markers only, leaving unrelated user packages alone. Inaccessibility is an error.
  for(const entry of await readdir(target.dirPath,{withFileTypes:true})) {
    if(!entry.isDirectory())continue;
    let marker;
    try {marker=JSON.parse(await readFile(path.join(target.dirPath,entry.name,".ading-managed"),"utf8"));}
    catch(error){if(error instanceof SyntaxError||(error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
    if(marker.ownerFingerprint===target.ownerFingerprint&&typeof marker.skillId==="string")evidence.managedDirectories.push(entry.name);
  }
  return evidence;
}
/** App-side comparison reads only the authoritative source, never the denied native files. */
export async function compareSkillEvidence(plan:SkillCopyPlan,evidence:SkillCopyEvidence):Promise<void> {
  const fail=(code:string,file:string)=>{throw new SkillCopyVerificationError({code,path:file,detail:p("原生技能核验信息与中央版本不符","Native skill verification evidence does not match the central package")});};
  const {target,skills}=plan,root=target.dirPath??target.filePath??"";
  if(!evidence||evidence.key!==skillCopyKey(plan))fail("EVIDENCE_INVALID",root);
  if(target.style==="managed-block") {
    const expected=renderManagedBlock(skills).replace(BLOCK_BEGIN,target.ownerFingerprint?`${BLOCK_BEGIN}\n<!-- ADING:OWNER ${target.ownerFingerprint} -->`:BLOCK_BEGIN);
    if(evidence.index?.count!==1||evidence.index.sha256!==hash(expected))fail("INDEX_MISMATCH",root);
    return;
  }
  if(!Array.isArray(evidence.packages)||!Array.isArray(evidence.managedDirectories))fail("EVIDENCE_INVALID",root);
  const enabled=skills.filter(skill=>skill.enabled),names=enabled.map(skill=>skill.directoryName??skillSlug(skill));
  if(new Set(names.map(name=>name.toLowerCase())).size!==names.length||evidence.packages.length!==names.length)fail("EVIDENCE_INVALID",root);
  for(const [index,skill] of enabled.entries()) {
    const name=names[index],native=path.join(root,name),observed=evidence.packages[index];
    if(!observed||observed.name!==name)fail("EVIDENCE_INVALID",native);
    const files=skill.source?await readPackageDirectory(skill.source.directory):[{path:"SKILL.md",bytes:Buffer.from(renderSkillFile(skill)),mode:0o644}];
    validatePackageFiles(files);const fingerprint=fingerprintPackageFiles(files);
    if(skill.source&&fingerprint!==skill.source.fingerprint)fail("SOURCE_CHANGED",skill.source.directory);
    if(observed.marker?.skillId!==skill.skillId||observed.marker?.ownerFingerprint!==target.ownerFingerprint)fail("OWNER_MISMATCH",native);
    if(observed.marker.fingerprint!==fingerprint)fail("VERSION_MISMATCH",native);
    if(!Array.isArray(observed.files)||observed.files.length>10000||observed.files.some(file=>!file||typeof file.path!=="string"||typeof file.size!=="number"||typeof file.sha256!=="string"||typeof file.mode!=="number"))fail("EVIDENCE_INVALID",native);
    const actual=new Map(observed.files.map(file=>[file.path,file]));
    if(actual.size!==observed.files.length)fail("EVIDENCE_INVALID",native);
    for(const file of packageManifest(files)) {
      const found=actual.get(file.path),location=path.join(native,file.path);
      if(!found)fail("FILE_MISSING",location);
      if(found!.size!==file.size||found!.sha256!==file.sha256)fail("CONTENT_MISMATCH",location);
      if(found!.mode!==file.mode)fail("MODE_MISMATCH",location);
      actual.delete(file.path);
    }
    if(actual.size)fail("EXTRA_FILE",native);
  }
  if(JSON.stringify([...evidence.managedDirectories].sort())!==JSON.stringify([...names].sort()))fail("STALE_COPY",root);
}
