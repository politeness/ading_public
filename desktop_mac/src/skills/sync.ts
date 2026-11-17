import {inspectSkillCopy} from "../knowledge/skill-copy";
import type {SkillFallback} from "../knowledge/skill-fallback";
import { createHash } from "node:crypto";
import { p } from "../prompt-language";
import { log } from "../orchestration/diagnostics";
import { withAgentKind } from "../knowledge/sync-failure";
import type { AgentRegistry } from "../agents/registry";
import type { SkillTarget } from "./target";
import type { WorkspaceResolution } from "../orchestration/workspace";
import type { Store } from "../store/store";

/**
 * Distribute the shared skill library into each agent's own rules files.
 *
 * The trigger is not a timer — a timer would change an agent's rules file while it's running,
 * and codex may or may not have read AGENTS.md into context yet: nondeterministic and not reproducible.
 * Instead, two deterministic points: distribute immediately on skill changes; compare hashes before each agent turn and write only if dirty.
 */
export class SkillSyncer {
  /** `${scope}|${target}` -> hash of the last written content. A target is a file path or skill directory, not an agent */
  private readonly lastHash = new Map<string, string>();

  // Preparation is brief; serialize it across callers sharing managed target files.
  private pending: Promise<unknown> = Promise.resolve();
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result=this.pending.then(operation,operation);
    this.pending=result.catch(()=>undefined);
    return result;
  }

  constructor(
    private readonly store: Store,
    private readonly registry: AgentRegistry,
    /** Dev and release builds on the same computer share each Agent's native directories; only release writes, dev leaves them alone */
    private readonly options: { writeNativeSkills?: boolean; fallback?:Pick<SkillFallback,"request"|"cancelWorkspace"|"cancelTarget"|"isRunning"|"hasPending"|"isVerified"> } = {}
  ) {}

  hasPending():boolean {return this.options.fallback?.hasPending?.()??false;}

  /**
   * Ensure the rules files for these agent types under this conversation's working directory are up to date.
   *
   * Complete global packages go to native user skill directories; workspace packages
   * remain in native project directories. Rule blocks are retained as compatibility indexes.
   */
  async ensureSynced(
    resolution: WorkspaceResolution,
    kinds: AgentKind[]
  ): Promise<string[]> {
    return this.serialized(()=>this.ensureSyncedLocked(resolution,kinds));
  }

  private async ensureSyncedLocked(resolution: WorkspaceResolution,kinds: AgentKind[]): Promise<string[]> {
    if(this.options.writeNativeSkills===false)return [];
    const written: string[] = [];
    const globals = await this.store.listSkills([{ scope: "global" }]);
    const scoped =
      resolution.sharesKnowledge && resolution.knowledgeOwnerId
        ? await this.store.listSkills([
            { scope: "workspace", ownerId: resolution.knowledgeOwnerId }
          ])
        : [];

    const failures: unknown[]=[];
    for (const [scope,skills,indexSkills] of [["global",globals,globals],["workspace",scoped,[...globals,...scoped]]] as const) {
      try { written.push(...await this.write(scope,resolution.workspacePath,kinds,[...skills],[...indexSkills])); } catch(error) { failures.push(error); }
    }
    if(failures.length) throw new AggregateError(failures, failures.map(error=>String(error)).join("; "));
    return written;
  }

  /**
   * The step that actually writes to disk.
   *
   * The key is **grouping by target file**, not by agent: codex and Qoder both read
   * the same AGENTS.md; writing separately would overwrite each other's managed block — last writer wins,
   * and results differ every round. After grouping each file is written once, with content being
   * the union of "skills every agent reading this file should see".
   *
   * Claude Code's one-directory-per-skill targets aren't shared; they're grouped per agent.
   */
  private async write(
    scope: Scope,
    workspacePath: string,
    kinds: AgentKind[],
    skills: Skill[],
    indexSkills: Skill[] = skills
  ): Promise<string[]> {
    const failures: unknown[] = [];
    const targets = await this.registry.resolveSkillTargets(
      scope,
      workspacePath,
      kinds,
      (error, kind) => { failures.push(withAgentKind(error, kind)); }
    );

    const groups = new Map<string, { target: SkillTarget; owners: AgentKind[] }>();
    for (const target of targets) {
      const key =
        target.style === "managed-block" && target.filePath
          ? `file:${target.filePath}`
          : `dir:${target.dirPath ?? ""}`;
      const existing = groups.get(key);
      if (existing) existing.owners.push(target.agentKind);
      else groups.set(key, { target, owners: [target.agentKind] });
      if(target.compatibilityFilePath) {
        const indexKey=`file:${target.compatibilityFilePath}`;
        const previous=groups.get(indexKey);
        if(previous) previous.owners.push(target.agentKind);
        else groups.set(indexKey,{target:{agentKind:target.agentKind,scope,style:"managed-block",filePath:target.compatibilityFilePath,humanNote:target.humanNote},owners:[target.agentKind]});
      }
    }

    const written: string[] = [];
    const ownerFingerprint=createHash("sha256").update(await this.store.knowledgeRoot()).digest("hex");
    for (const [key, group] of groups) {
      if (scope === "workspace" && group.target.style === "managed-block") group.owners = [...new Set([...group.owners, "codex", "qoder", "qoder-cn"] as AgentKind[])];
      const mine = (group.target.style === "managed-block" ? indexSkills : skills).filter(
        (skill) =>
          skill.enabled &&
          (!skill.targets?.length ||
            skill.targets.some((kind) => group.owners.includes(kind)))
      );
      const hash = hashSkills(group.owners, mine);
      if (group.target.style === "managed-block" && this.lastHash.get(`${scope}|${key}`) === hash) continue;
      group.target.ownerFingerprint=ownerFingerprint;
      const plan={target:group.target,skills:mine,workspacePath};
      const issue=await inspectSkillCopy(plan);
      if(!issue) {this.options.fallback?.cancelTarget(plan);this.lastHash.set(`${scope}|${key}`,hash);continue;}
      if(["EPERM","EACCES"].includes(issue.code)&&this.options.fallback?.isVerified?.(plan)) {this.lastHash.set(`${scope}|${key}`,hash);continue;}
      if(this.options.fallback?.isRunning(plan)) {
        this.options.fallback.request(plan);
        continue;
      }
      try { written.push(...(await this.registry.syncSkills(group.target, mine))); } catch(error) {
        // Delegate any native-target copy failure, including symbolic links and
        // incompatible directory layouts. Keep package validation in the helper.
        if(this.options.fallback) {this.options.fallback.request(plan,error);continue;}
        const tagged = (failure: unknown, kind: AgentKind): Error => failure instanceof AggregateError
          ? new AggregateError(failure.errors.map(leaf => tagged(leaf, kind)), failure.message)
          : withAgentKind(failure instanceof Error ? Object.assign(new Error(failure.message, {cause:failure}), failure) : failure, kind);
        failures.push(new AggregateError(group.owners.map(kind => tagged(error, kind)), String(error)));
        continue;
      }
      this.options.fallback?.cancelTarget(plan);
      this.lastHash.set(`${scope}|${key}`, hash);
      await log("skill-sync-applied", {scope, target:key, fingerprint:hash, skills:mine.map(s=>({id:s.skillId, version:s.updatedAt}))});
    }
    if(failures.length) throw new AggregateError(failures,failures.map(error=>String(error)).join("; "));
    return written;
  }

  async unsyncMemories(resolution:WorkspaceResolution,kinds:AgentKind[],context?:{userId:string;conversationId?:string;allContexts?:boolean}): Promise<string[]> {
    return this.serialized(async()=>{
      const {removeMemoryCopies}=await import("../knowledge/memory-copies.js");
      return removeMemoryCopies(resolution,kinds,context ?? {userId:(await this.store.currentUser()).userId,allContexts:true});
    });
  }

  async unsyncWorkspace(resolution:WorkspaceResolution,kinds:AgentKind[],context?:{userId:string}): Promise<string[]> {
    this.options.fallback?.cancelWorkspace(resolution.workspacePath);
    return this.serialized(async()=>{
      const cleared:string[]=[];const failures:unknown[]=[];
      const ownerFingerprint=createHash("sha256").update(await this.store.knowledgeRoot()).digest("hex");
      for(const target of this.options.writeNativeSkills===false ? [] : await this.registry.resolveSkillTargets("workspace",resolution.workspacePath,kinds)) {
        target.ownerFingerprint=ownerFingerprint;
        try { cleared.push(...await this.registry.unsyncSkills(target)); } catch(error) { failures.push(error); }
      }
      const {removeMemoryCopies}=await import("../knowledge/memory-copies.js");
      try { cleared.push(...await removeMemoryCopies(resolution,kinds,{userId:context?.userId ?? (await this.store.currentUser()).userId,allContexts:true})); } catch(error) { failures.push(error); }
      if(failures.length)throw new AggregateError(failures,failures.map(error=>String(error)).join("; "));
      this.lastHash.clear();return cleared;
    });
  }

  /** Force redistribution after a change */
  invalidate(): void {
    this.lastHash.clear();
  }

  /** Withdraw: clear all managed blocks ADing wrote into agents' rules files */
  async unsyncAll(
    workspacePath: string,
    kinds: AgentKind[]
  ): Promise<string[]> {
    this.options.fallback?.cancelWorkspace(workspacePath);
    return this.serialized(()=>this.unsyncLocked(workspacePath,kinds));
  }

  private async unsyncLocked(workspacePath: string,kinds: AgentKind[]): Promise<string[]> {
    const cleared: string[] = [];
    const failures:unknown[]=[];
    const ownerFingerprint=createHash("sha256").update(await this.store.knowledgeRoot()).digest("hex");
    for (const scope of (this.options.writeNativeSkills===false ? [] : ["workspace", "global"]) as Scope[]) {
      const targets = await this.registry.resolveSkillTargets(
        scope,
        workspacePath,
        kinds
      );
      for (const target of targets) {
        target.ownerFingerprint=ownerFingerprint;
        try { cleared.push(...(await this.registry.unsyncSkills(target))); } catch(error) { failures.push(error); }
      }
    }
    const {removeMemoryCopies}=await import("../knowledge/memory-copies.js");
    try { cleared.push(...await removeMemoryCopies({workspacePath,sharesKnowledge:false},kinds,{userId:(await this.store.currentUser()).userId,allContexts:true})); } catch(error) { failures.push(error); }
    this.lastHash.clear();
    if(failures.length)throw new AggregateError(failures,failures.map(error=>String(error)).join("; "));
    return cleared;
  }
}

function hashSkills(owners: AgentKind[], skills: Skill[]): string {
  const body = skills
    .slice()
    .sort((a, b) => a.skillId.localeCompare(b.skillId))
    .map((skill) => JSON.stringify(skill))
    .join("\n");
  // owners also go into the hash: when a file goes from "read only by codex" to "read by codex + qoder",
  // the skill set to write changes even though the skills themselves didn't, so without it nothing would be redistributed
  return createHash("sha1")
    .update([...owners].sort().join(",") + "\n" + body)
    .digest("hex");
}
