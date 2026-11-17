import {readFile,writeFile,rename,rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {applySkillCopy,canonicalSkillPlan,skillCopyIssues,type SkillCopyPlan,type SkillCopyIssue} from "./skill-copy";
import {observeSkillCopy,type SkillCopyEvidence} from "./skill-verification";
import {setMainLanguage} from "../i18n";

/** Invoked by the affected Agent, in that Agent's execution context, never by the app as a permission bypass. */
export async function runSkillFallback(file:string):Promise<string> {
  const task=JSON.parse(await readFile(file,"utf8")) as {version:string;language:string;plans:SkillCopyPlan[];phase?:"verify";nonce?:string};
  setMainLanguage(task.language);
  const issues:SkillCopyIssue[]=[],evidence:SkillCopyEvidence[]=[];
  // One broken target must not prevent independent targets from being repaired.
  for(const plan of task.plans)try {if(task.phase==="verify")evidence.push(await observeSkillCopy(plan));else await applySkillCopy(await canonicalSkillPlan(plan));}
  catch(error){issues.push(...skillCopyIssues(error,plan.target.dirPath??plan.target.filePath??""));}
  const receipt=`${file}.result.json`,candidate=`${receipt}.${randomUUID()}.tmp`;
  try {
    await writeFile(candidate,JSON.stringify({version:task.version,nonce:task.nonce,evidence:task.phase==="verify"?evidence:undefined,ok:!issues.length,issues:issues.slice(0,20)}),{flag:"wx",mode:0o600});
    await rename(candidate,receipt);
  }finally{await rm(candidate,{force:true});}
  if(issues.length)throw new AggregateError(issues.map(issue=>Error(`${issue.code}: ${issue.detail} (${issue.path})`)),"Skill helper failed; see diagnostic receipt");
  return `${task.phase==="verify"?"ADING_SKILL_VERIFY_DONE":"ADING_SKILL_SYNC_DONE"} ${task.version}`;
}
if(require.main===module) {
  void runSkillFallback(process.argv[2]).then(result=>console.log(result)).catch(error=>{console.error(error);process.exitCode=1;});
}
