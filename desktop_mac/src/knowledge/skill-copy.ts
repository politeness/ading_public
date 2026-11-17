import {p} from "../prompt-language";
import {readFile,realpath,lstat} from "node:fs/promises";
import path from "node:path";
import {writeSkillDirs,skillSlug,renderSkillFile} from "../skills/skill-dir";
import {writeManagedBlock,renderManagedBlock,BLOCK_BEGIN} from "../skills/block";
import {readPackageDirectory,fingerprintPackageFiles,validatePackageFiles,packageManifest} from "./bundle-files";
import type {SkillTarget} from "../skills/target";

export interface SkillCopyPlan {target:SkillTarget;skills:Skill[];workspacePath:string;}
export function skillCopyKey(plan:SkillCopyPlan):string {
  return JSON.stringify([plan.target.agentKind,plan.target.scope,plan.target.style,plan.target.dirPath,plan.target.filePath]);
}
export interface SkillCopyIssue {code:string;path:string;detail:string;syscall?:string;}
export class SkillCopyVerificationError extends Error {
  readonly code:string;readonly path:string;readonly syscall?:string;
  constructor(readonly issue:SkillCopyIssue) {super(`${issue.code}: ${issue.detail} (${issue.path})`);this.code=issue.code;this.path=issue.path;this.syscall=issue.syscall;}
}
/** No contents or credentials: safe to persist in a diagnostic log or helper receipt. */
export function skillCopyIssues(error:unknown,fallbackPath:string):SkillCopyIssue[] {
  if(error instanceof AggregateError)return error.errors.flatMap(leaf=>skillCopyIssues(leaf,fallbackPath)).slice(0,20);
  if(error instanceof SkillCopyVerificationError)return [error.issue];
  const value=error as NodeJS.ErrnoException;
  const detail=(error instanceof Error ? error.message : String(error)).slice(0,1000);
  const code=value?.code??detail.match(/^(EPERM|EACCES|ENOENT|ENOSPC|EROFS|ENOTDIR):/)?.[1]??"SYNC_ERROR";
  return [{code,path:value?.path??detail.match(/, \w+ '([^']+)'$/)?.[1]??fallbackPath,detail,...(value?.syscall ? {syscall:value.syscall} : {})}];
}
/** Read-only verification; distinguish inaccessible files from mismatching bytes/metadata. */
export async function inspectSkillCopy({target,skills}:SkillCopyPlan):Promise<SkillCopyIssue|undefined> {
  let currentPath=target.filePath??target.dirPath??"";
  const issue=(code:string,zh:string,en:string):SkillCopyIssue=>({code,path:currentPath,detail:p(zh,en)});
  try {
    if(target.style==="managed-block"&&target.filePath) {
      const text=await readFile(target.filePath,"utf8");
      const expected=renderManagedBlock(skills).replace(BLOCK_BEGIN,target.ownerFingerprint ? `${BLOCK_BEGIN}\n<!-- ADING:OWNER ${target.ownerFingerprint} -->` : BLOCK_BEGIN);
      return text.includes(expected)&&text.split(BLOCK_BEGIN).length===2 ? undefined : issue("INDEX_MISMATCH","技能索引内容或托管块数量不符","Skill index contents or managed block count do not match");
    }
    if(!target.dirPath)return issue("INVALID_TARGET","缺少原生技能目录","Missing native skill directory");
    const expected=new Set<string>();
    for(const skill of skills.filter(item=>item.enabled)) {
      const name=skill.directoryName??skillSlug(skill);
      if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)||expected.has(name.toLowerCase()))return issue("INVALID_TARGET","技能目录名无效或重复","Invalid or duplicate skill directory name");
      expected.add(name.toLowerCase());
      currentPath=skill.source?.directory??target.dirPath;
      const files=skill.source ? await readPackageDirectory(skill.source.directory) : [{path:"SKILL.md",bytes:Buffer.from(renderSkillFile(skill)),mode:0o644}];
      validatePackageFiles(files);
      const fingerprint=fingerprintPackageFiles(files);
      if(skill.source&&fingerprint!==skill.source.fingerprint)return issue("SOURCE_CHANGED","中央技能源已变化，需要重新读取","Central skill source changed; reload required");
      const nativePath=path.join(target.dirPath,name);currentPath=nativePath;
      const native=await readPackageDirectory(nativePath);
      currentPath=path.join(nativePath,".ading-managed");
      const markerFile=native.find(file=>file.path===".ading-managed");if(!markerFile)return issue("MARKER_MISSING","缺少阿钉托管标记","Missing ADing managed marker");
      let marker;
      try {marker=JSON.parse(Buffer.from(markerFile.bytes).toString("utf8"));}catch{return issue("MARKER_INVALID","阿钉托管标记格式损坏","Invalid ADing managed marker");}
      if(!marker||marker.skillId!==skill.skillId||marker.ownerFingerprint!==target.ownerFingerprint)return issue("OWNER_MISMATCH","技能或账号归属不符，未覆盖","Skill or account ownership differs; left untouched");
      if(marker.fingerprint!==fingerprint)return issue("VERSION_MISMATCH","托管标记的技能版本不符","Managed skill version does not match");
      const actual=new Map(packageManifest(native.filter(file=>file.path!==".ading-managed")).map(file=>[file.path,file]));
      for(const file of packageManifest(files)) {
        currentPath=path.join(nativePath,file.path);const found=actual.get(file.path);
        if(!found)return issue("FILE_MISSING","原生技能文件缺失","Native skill file is missing");
        if(found.sha256!==file.sha256)return issue("CONTENT_MISMATCH","原生技能文件内容与中央源不同","Native skill file contents differ from the central source");
        if(found.mode!==file.mode)return issue("MODE_MISMATCH","原生技能文件权限位与中央源不同","Native skill file mode differs from the central source");
        actual.delete(file.path);
      }
      if(actual.size){currentPath=path.join(nativePath,actual.keys().next().value!);return issue("EXTRA_FILE","原生托管技能包含中央源没有的文件","Native managed skill contains an extra file");}
    }
    // Verify cleanup too, without reading unrelated user-maintained packages.
    const {readdir}=await import("node:fs/promises");
    currentPath=target.dirPath;
    for(const entry of await readdir(target.dirPath,{withFileTypes:true})) {
      if(!entry.isDirectory()||expected.has(entry.name.toLowerCase()))continue;
      try {
        const marker=JSON.parse(await readFile(path.join(target.dirPath,entry.name,".ading-managed"),"utf8"));
        if(marker.ownerFingerprint===target.ownerFingerprint&&typeof marker.skillId==="string"){currentPath=path.join(target.dirPath,entry.name);return issue("STALE_COPY","已撤销的技能副本仍然存在","Withdrawn skill copy still exists");}
      }catch(error) {
        // A missing/malformed marker is unmanaged; an unreadable marker is unknown,
        // and cannot prove that withdrawal completed.
        if((error as NodeJS.ErrnoException).code&&(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
      }
    }
    return undefined;
  } catch(error) {return skillCopyIssues(error,currentPath)[0];}
}
export async function verifySkillCopy(plan:SkillCopyPlan):Promise<boolean> {
  return !await inspectSkillCopy(plan);
}
export async function canonicalSkillPlan(plan:SkillCopyPlan):Promise<SkillCopyPlan> {
  const target={...plan.target};
  const original=target.dirPath ?? target.filePath;
  if(!original||!path.isAbsolute(original))throw Error(p("原生技能目标必须是绝对路径", "Native skill targets must be absolute paths"));
  // Resolve the nearest existing parent; a missing final skills directory is normal.
  const resolve=async(value:string):Promise<string>=>{
    try{return await realpath(value);}catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT"||path.dirname(value)===value)throw error;
      return path.join(await resolve(path.dirname(value)),path.basename(value));
    }
  };
  const actual=await resolve(original);
  const inside=(base:string,value:string)=>{const rel=path.relative(base,value);return rel!==""&&!rel.startsWith(`..${path.sep}`)&&rel!==".."&&!path.isAbsolute(rel);};
  if(plan.target.scope==="workspace"&&!inside(await realpath(plan.workspacePath),actual))throw Error(p("技能目标链接超出当前工作区", "The skill target link leaves the current workspace"));
  // Never turn a native-root link into a write to a central package or another
  // user's filesystem tree. Package-internal links remain forbidden.
  for(const skill of plan.skills)if(skill.source){const source=await realpath(skill.source.directory);if(actual===source||inside(source,actual)||inside(actual,source))throw Error(p("技能目标不能覆盖中央源", "A skill target cannot overwrite a central source"));}
  let parent=actual;
  for(;;){try{const st=await lstat(parent);if(!st.isDirectory()&&parent!==actual)throw Error("ENOTDIR");if(process.getuid&&st.uid!==process.getuid())throw Error(p("技能目标不属于当前用户", "The skill target is not owned by the current user"));break;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;parent=path.dirname(parent);}}
  if(target.dirPath)target.dirPath=actual;else target.filePath=actual;
  return {...plan,target};
}
export async function applySkillCopy(plan:SkillCopyPlan):Promise<void> {
  const {target,skills}=plan;
  if(target.style==="managed-block"&&target.filePath)await writeManagedBlock(target.filePath,skills,{ownerFingerprint:target.ownerFingerprint});
  else if(target.dirPath)await writeSkillDirs(target.dirPath,skills,{ownerFingerprint:target.ownerFingerprint});
  else throw Error(p("原生技能目标无效", "Invalid native skill target"));
  const issue=await inspectSkillCopy(plan);if(issue)throw new SkillCopyVerificationError(issue);
}
