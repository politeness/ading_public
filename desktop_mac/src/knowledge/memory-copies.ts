import { createHash } from "node:crypto";
import { lstat, readFile, rm, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceResolution } from "../orchestration/workspace";
import { withAgentKind } from "./sync-failure";
import { p } from "../prompt-language";

const digest=(value:string):string=>createHash("sha256").update(value).digest("hex");
/**
 * Released versions left memory copies in each working directory (.codex/ading-memories/...). They are no longer generated; this only cleans them up,
 * and only deletes directories carrying the ADing managed marker.
 */
export const LEGACY_MEMORY_COPY_KINDS:AgentKind[]=["codex","claude-code","qoder","qoder-cn","qwen-code","kiro","copilot","antigravity"];
function contextRefs(resolution: WorkspaceResolution,context: {userId:string;conversationId?:string}): Array<{scope:MemoryScope;ownerId:string}> {
  if(!context.userId) throw new Error(p("记忆同步缺少用户范围", "Memory sync is missing the user scope"));
  const refs: Array<{scope:MemoryScope;ownerId:string}>=[{scope:"user",ownerId:context.userId}];
  if(resolution.sharesKnowledge && resolution.knowledgeOwnerId) refs.push({scope:"workspace",ownerId:resolution.knowledgeOwnerId});
  if(context.conversationId) refs.push({scope:"conversation",ownerId:context.conversationId});
  return refs;
}
function memoryReplicaRoot(resolution:WorkspaceResolution,kind:AgentKind): string {
  const vendor=kind==="codex" ? ".codex" : kind==="claude-code" ? ".claude" : kind==="qwen-code" ? ".qwen" : kind==="kiro" ? ".kiro" : kind==="copilot" ? ".github" : kind==="antigravity" ? ".agents" : ".qoder";
  return path.join(resolution.workspacePath,vendor,"ading-memories",kind);
}
/** Withdraw only owned context replicas. Pass the old resolution before deleting its owner. */
export async function removeMemoryCopies(resolution:WorkspaceResolution,kinds:AgentKind[],context:{userId:string;conversationId?:string;allContexts?:boolean;anyUser?:boolean}): Promise<string[]> {
  const wanted=context.allContexts ? undefined : digest(JSON.stringify(contextRefs(resolution,context)));
  const cleared:string[]=[];const failures:unknown[]=[];
  for(const kind of new Set(kinds)) {
    const root=memoryReplicaRoot(resolution,kind);
    try {
      let cursor=resolution.workspacePath;
      for(const component of path.relative(resolution.workspacePath,root).split(path.sep)) { cursor=path.join(cursor,component);const st=await lstat(cursor);if(st.isSymbolicLink()||!st.isDirectory())throw new Error(p("记忆副本目录冲突", "Memory replica directory conflict")); }
      for(const entry of await readdir(root,{withFileTypes:true})) {
        if(!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || wanted && entry.name!==wanted) continue;
        const destination=path.join(root,entry.name),marker=path.join(destination,".ading-managed");
        try {
          const stat=await lstat(marker);if(!stat.isFile()||stat.isSymbolicLink())continue;
          const value=JSON.parse(await readFile(marker,"utf8"));
          if(value.version!==1||value.type!=="memory"||value.contextKey!==entry.name||!context.anyUser&&value.userHash!==digest(context.userId))continue;
        } catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT" || error instanceof SyntaxError)continue;throw error; }
        await rm(destination,{recursive:true,force:true});cleared.push(destination);
      }
      // Nothing generates these any more; rmdir only succeeds on what is left empty.
      if(context.anyUser)for(const directory of [root,path.dirname(root)])await rmdir(directory).catch(()=>undefined);
    } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")failures.push(withAgentKind(error,kind));}
  }
  if(failures.length)throw new AggregateError(failures,failures.map(error=>String(error)).join("; "));
  return cleared;
}
