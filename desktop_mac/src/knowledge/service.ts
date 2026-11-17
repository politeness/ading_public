import type {SkillFallback} from "./skill-fallback";
import { mkdir, stat } from "node:fs/promises";
import { bestEffortSync, describeSyncFailures, type SkillPathsResolver } from "./sync-failure";
import { log } from "../orchestration/diagnostics";
import type { Store } from "../store/store";
import type { SkillSyncer } from "../skills/sync";
import type { MemoryNotifier } from "./memory-notify";
import { LEGACY_MEMORY_COPY_KINDS, removeMemoryCopies } from "./memory-copies";
import type { WorkspaceResolution } from "../orchestration/workspace";
import { memoryScopesFor } from "../orchestration/workspace";
import { p } from "../prompt-language";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {readFile,writeFile,rename,rm} from "node:fs/promises";

export interface KnowledgeContext {conversation:Conversation;agent:UserRef;resolution:WorkspaceResolution;
  /** Someone other than the owner is in this conversation, so the owner's personal memory is out of reach. */
  isolateMemory?:boolean;}
export interface KnowledgeSyncResult {centralSaved:true;synced:boolean;written:string[];failures:KnowledgeSyncFailure[];}
/** Writing the pending-withdrawal record failed, so the central mutation never ran. */
export class KnowledgeRemovalRecordError extends Error {
  constructor(readonly cause:unknown) {super(cause instanceof Error ? cause.message : String(cause));this.name="KnowledgeRemovalRecordError";}
}
interface ScopeRemoval {id:string;kind:"conversation"|"workspace";ownerId:string;userId:string;resolution:WorkspaceResolution;kinds:AgentKind[];}
export class KnowledgeService {
  private pending:Promise<unknown>=Promise.resolve();
  private failures:KnowledgeSyncFailure[]=[];
  private cloudFailure:KnowledgeSyncFailure|undefined;
  private skillFallbackFailures:KnowledgeSyncFailure[]=[];
  private skillFallbackPending:KnowledgeSyncPending[]=[];
  private memorySyncFailures:KnowledgeSyncFailure[]=[];
  private legacyCopiesCleaned=false;
  syncState():KnowledgeSyncState {return {failures:[...this.failures,...this.skillFallbackFailures,...this.memorySyncFailures,...(this.cloudFailure ? [this.cloudFailure] : [])].map(failure=>({...failure,agents:[...failure.agents]})),...(this.skillFallbackPending.length ? {pending:this.skillFallbackPending.map(item=>({...item,agents:[...item.agents]}))} : {})};}
  setSkillFallbackPending(pending:KnowledgeSyncPending[]):void {
    if(JSON.stringify(pending)===JSON.stringify(this.skillFallbackPending))return;
    this.skillFallbackPending=pending;
    try {this.options.onSyncState?.(this.syncState());}catch {/* best-effort notification */}
  }
  /** Cloud sync runs on its own schedule, so a refresh of the native copies must not clear its failure. */
  setCloudFailure(detail:string|undefined):void {
    if(detail===this.cloudFailure?.detail)return;
    this.cloudFailure=detail===undefined ? undefined : {category:"cloud",agents:[],detail};
    try { this.options.onSyncState?.(this.syncState()); } catch { /* best-effort notification */ }
  }
  /** The Agents' background memory turns finish on their own schedule too; a refresh must not clear these either. */
  setMemorySyncFailures(failures:KnowledgeSyncFailure[]):void {
    this.memorySyncFailures=failures;
    try { this.options.onSyncState?.(this.syncState()); } catch { /* best-effort notification */ }
  }
  setSkillFallbackFailures(failures:KnowledgeSyncFailure[]):void {
    this.skillFallbackFailures=failures;
    try {this.options.onSyncState?.(this.syncState());}catch {/* best-effort notification */}
  }
  /** onSyncState hears every refresh result (empty failures = recovered) and every failed pre-turn sync. skillPaths attributes path-bearing errors to Agents. */
  constructor(private readonly store:Store,private readonly syncer:SkillSyncer,private readonly options:{kinds:()=>AgentKind[];resolveWorkspace:(conversation:Conversation)=>Promise<WorkspaceResolution>;fallback:()=>WorkspaceResolution;onSyncState?:(state:KnowledgeSyncState)=>void;skillPaths?:(resolution:WorkspaceResolution,kinds:AgentKind[])=>ReturnType<SkillPathsResolver>;memoryNotify?:Pick<MemoryNotifier,"catchUp">;skillFallback?:Pick<SkillFallback,"catchUp">;cleanLegacyMemoryCopies?:boolean}) {}
  private serialized<T>(operation:()=>Promise<T>):Promise<T> {const result=this.pending.then(operation,operation);this.pending=result.catch(()=>undefined);return result;}
  private async removals():Promise<ScopeRemoval[]> {
    try {return JSON.parse(await readFile(path.join(await this.store.knowledgeRoot(),"knowledge-pending-removals.json"),"utf8")) as ScopeRemoval[];}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
  }
  private async saveRemovals(removals:ScopeRemoval[]):Promise<void> {
    const file=path.join(await this.store.knowledgeRoot(),"knowledge-pending-removals.json");
    if(!removals.length){await rm(file,{force:true});return;}
    const candidate=`${file}.${randomUUID()}.candidate`;
    try {await writeFile(candidate,JSON.stringify(removals),{flag:"wx",mode:0o600});await rename(candidate,file);}
    finally {await rm(candidate,{force:true});}
  }
  /** Persist the old scope before central deletion, so failed withdrawal survives a restart. The record gates the central mutation; only the bookkeeping after it is best-effort. */
  async removeScope<T>(kind:ScopeRemoval["kind"],ownerId:string,resolution:WorkspaceResolution,operation:()=>Promise<T>):Promise<T> {
    const user=await this.store.currentUser();
    const record:ScopeRemoval={id:randomUUID(),kind,ownerId,userId:user.userId,resolution,kinds:this.options.kinds()};
    try {await this.serialized(async()=>{await this.saveRemovals([...await this.removals(),record]);});}
    catch(error){throw new KnowledgeRemovalRecordError(error);}
    let result:T;
    try {result=await operation();}
    catch(error){await bestEffortSync(()=>this.serialized(async()=>this.saveRemovals((await this.removals()).filter(item=>item.id!==record.id))),undefined);throw error;}
    await bestEffortSync(async()=>{
      const owner=kind==="workspace" ? await this.store.getWorkspace(ownerId) : await this.store.getConversation(ownerId);
      if(owner) {
        const current=kind==="workspace" ? {workspacePath:(owner as Workspace).path,sharesKnowledge:true,knowledgeOwnerId:ownerId} : await this.options.resolveWorkspace(owner as Conversation);
        if(sameResolution(current,resolution))await this.serialized(async()=>this.saveRemovals((await this.removals()).filter(item=>item.id!==record.id)));
      }
    },undefined);
    await this.saved();return result;
  }
  private async withdrawRemovedScopes(userId:string):Promise<{written:string[];failures:KnowledgeSyncFailure[]}> {
    const records=await this.removals(),kept:ScopeRemoval[]=[],written:string[]=[],failures:KnowledgeSyncFailure[]=[];
    for(const record of records) {
      if(record.userId!==userId){kept.push(record);continue;}
      const owner=record.kind==="workspace" ? await this.store.getWorkspace(record.ownerId) : await this.store.getConversation(record.ownerId);
      if(owner) {
        const current=record.kind==="workspace" ? {workspacePath:(owner as Workspace).path,sharesKnowledge:true,knowledgeOwnerId:record.ownerId} : await this.options.resolveWorkspace(owner as Conversation);
        if(sameResolution(current,record.resolution)){kept.push(record);continue;}
      }
      try {
        const kinds=[...new Set([...record.kinds,...this.options.kinds()])];
        written.push(...await (record.kind==="workspace" ? this.syncer.unsyncWorkspace(record.resolution,kinds,{userId}) : this.syncer.unsyncMemories(record.resolution,kinds,{userId,conversationId:record.ownerId})));
      }catch(error){kept.push(record);failures.push(...await this.describe("removal",error,record.resolution,record.kinds));}
    }
    if(kept.length!==records.length)await this.saveRemovals(kept);
    return {written,failures};
  }
  async prepare(context:KnowledgeContext):Promise<string[]> {
    const kinds=this.options.kinds();
    // A failed copy never blocks the turn; it is reported so the user can see which Agent lacks it.
    await bestEffortSync(()=>this.syncer.ensureSynced(context.resolution,kinds),[],error=>this.reportPrepareFailure("skills",error,context.resolution,kinds));
    // Runs in the background: an Agent that still owes a memory sync never delays the user's turn.
    if(context.agent.kind){this.options.memoryNotify?.catchUp(context.agent.kind);this.options.skillFallback?.catchUp(context.agent.kind);}
    const refs:ScopeRef[]=[{scope:"global"},...(context.resolution.sharesKnowledge&&context.resolution.knowledgeOwnerId ? [{scope:"workspace" as const,ownerId:context.resolution.knowledgeOwnerId}] : [])];
    const skills=(await this.store.listSkills(refs)).filter(skill=>skill.enabled&&skill.source&&(!skill.targets?.length||context.agent.kind&&skill.targets.includes(context.agent.kind)));
    return skills.map(skill=>path.join(skill.source!.directory,"SKILL.md"));
  }
  refresh():Promise<KnowledgeSyncResult> {
    const operation=async()=>{
      this.syncer.invalidate();
      const kinds=this.options.kinds(),written:string[]=[],failures:KnowledgeSyncFailure[]=[];
      const me=await this.store.currentUser();
      const removals=await this.withdrawRemovedScopes(me.userId);written.push(...removals.written);failures.push(...removals.failures);
      const contexts:Array<{resolution:WorkspaceResolution;conversationId?:string}>=[];
      for(const workspace of await this.store.listWorkspaces())if(workspace.kind==="folder"&&workspace.path)contexts.push({resolution:{workspacePath:workspace.path,sharesKnowledge:true,knowledgeOwnerId:workspace.workspaceId}});
      for(const conversation of await this.store.listConversations())contexts.push({resolution:await this.options.resolveWorkspace(conversation),conversationId:conversation.conversationId});
      // A directory that does not exist yet (e.g. a cloud conversation that never ran here) has nothing to
      // update and no Agent reading it: the pre-turn sync creates it. Never recreate it here, the user may have removed it.
      const present:typeof contexts=[];
      for(const context of contexts)if(await workspaceExists(context.resolution.workspacePath))present.push(context);
      contexts.splice(0,contexts.length,...present);
      if(!contexts.length) {
        const resolution=this.options.fallback();
        await mkdir(resolution.workspacePath,{recursive:true});
        contexts.push({resolution});
      }
      const seen=new Set<string>();
      for(const context of contexts) {
        const key=JSON.stringify([context.resolution,context.conversationId]);if(seen.has(key))continue;seen.add(key);
        try {
          written.push(...await this.syncer.ensureSynced(context.resolution,kinds));
        }catch(error){failures.push(...await this.describe("skills",error,context.resolution,kinds));}
      }
      if(this.options.cleanLegacyMemoryCopies&&!this.legacyCopiesCleaned) {
        this.legacyCopiesCleaned=true;
        for(const resolution of new Map(contexts.map(context=>[context.resolution.workspacePath,context.resolution])).values())
          await bestEffortSync(()=>removeMemoryCopies(resolution,LEGACY_MEMORY_COPY_KINDS,{userId:me.userId,allContexts:true,anyUser:true}),[]);
      }
      await this.publish(failures,true);
      const state=this.syncState();
      return {centralSaved:true as const,synced:!state.failures.length&&!state.pending?.length&&!this.syncer.hasPending?.(),written:[...new Set(written)],failures:state.failures};
    };
    return this.serialized(async()=>{
      try { return await operation(); }
      catch(error) {
        // Whatever stopped the whole pass (e.g. the store), every discovered Agent is left without the update.
        await this.publish(await this.describe("skills",error,this.options.fallback(),this.options.kinds()),true);
        return {centralSaved:true as const,synced:false,written:[],failures:this.syncState().failures};
      }
    });
  }
  private describe(category:KnowledgeSyncFailure["category"],error:unknown,resolution:WorkspaceResolution,kinds:AgentKind[]):Promise<KnowledgeSyncFailure[]> {
    return describeSyncFailures(category,error,kinds,this.options.skillPaths ? ()=>this.options.skillPaths!(resolution,kinds) : undefined);
  }
  private async reportPrepareFailure(category:KnowledgeSyncFailure["category"],error:unknown,resolution:WorkspaceResolution,kinds:AgentKind[]):Promise<void> {
    await this.publish(await this.describe(category,error,resolution,kinds),false);
  }
  /** A refresh replaces the whole state; a pre-turn failure only adds to it, since it saw a single context. */
  private async publish(failures:KnowledgeSyncFailure[],replace:boolean):Promise<void> {
    const merged=replace ? [] : [...this.failures],seen=new Set(merged.map(failureKey));
    for(const failure of failures){const key=failureKey(failure);if(seen.has(key))continue;seen.add(key);merged.push(failure);}
    const changed=JSON.stringify(merged)!==JSON.stringify(this.failures);
    this.failures=merged;
    // Pre-turn failures were already logged by bestEffortSync.
    if(replace&&failures.length)await log("knowledge-sync-failed",{failures}).catch(()=>{});
    if(!changed)return;
    // Observers must never turn a copy failure into a failed operation.
    try { this.options.onSyncState?.(this.syncState()); } catch { /* best-effort notification */ }
  }
  async saved():Promise<void> {
    await this.refresh();
  }
  async call(context:KnowledgeContext,name:string,value:unknown,signal:AbortSignal):Promise<unknown> {
    signal.throwIfAborted();
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(p("知识工具参数必须为对象", "Knowledge tool arguments must be an object"));
    const args=value as Record<string,any>,action=String(args.action??"");
    const me=await this.store.currentUser();
    const scopes=memoryScopesFor(context.resolution,me.userId,context.conversation.conversationId);
    let result:unknown;
    if(name==="ading_skill") {
      const refs:ScopeRef[]=[{scope:"global"},...(context.resolution.sharesKnowledge&&context.resolution.knowledgeOwnerId ? [{scope:"workspace" as const,ownerId:context.resolution.knowledgeOwnerId}] : [])];
      const scope=args.scope??(context.resolution.sharesKnowledge ? "workspace" : "global");
      const ownerId=scope==="workspace" ? context.resolution.knowledgeOwnerId : undefined;
      const ensureScope=()=>{if(!refs.some(ref=>ref.scope===scope&&ref.ownerId===ownerId)||args.ownerId&&args.ownerId!==ownerId)throw new Error(p("技能作用域不属于当前执行通道", "The skill scope does not belong to this execution lane"));};
      const existing=async()=>{const skill=await this.store.getSkill(String(args.skillId??""));if(!skill||!refs.some(ref=>ref.scope===skill.scope&&ref.ownerId===skill.ownerId)||(args.scope&&args.scope!==skill.scope)||(args.ownerId&&args.ownerId!==skill.ownerId))throw new Error(p("当前作用域没有这条技能", "This skill is not in the current scope"));return skill;};
      if(action==="list") {if(args.scope){ensureScope();return this.store.listSkills([{scope,ownerId}]);}return this.store.listSkills(refs);}
      if(action==="get")return existing();
      if(action==="create") {ensureScope();result=await this.store.createSkill({name:required(args.name),description:String(args.description??""),content:required(args.content),scope,ownerId,authorKind:"agent",authorUserId:context.agent.userId,targets:args.targets});}
      else if(action==="import") {ensureScope();if(args.skillId)await existing();result=await this.store.importSkill({sourcePath:required(args.sourcePath),skillId:args.skillId,scope,ownerId,authorKind:"agent",authorUserId:context.agent.userId,targets:args.targets,name:args.name,description:args.description});}
      else if(action==="update") {const skill=await existing();result=await this.store.updateSkill(skill.skillId,args.patch??{content:required(args.content)});}
      else if(action==="delete") {const skill=await existing();await this.store.deleteSkill(skill.skillId);result={deleted:skill.skillId};}
      else throw new Error(p("未知技能操作", "Unknown skill action"));
    } else if(name==="ading_memory") {
      const scope=args.scope??"conversation";
      if(scope==="user"&&context.isolateMemory)throw new Error(p("这个会话里有主人以外的人，不能读取或修改主人的个人记忆。工作区和会话记忆不受影响。", "Someone other than the owner is in this conversation, so the owner's personal memory can't be read or changed. Workspace and conversation memory are unaffected."));
      const target=scopes.find(ref=>ref.scope===scope&&(!args.ownerId||ref.ownerId===args.ownerId));
      if(!target)throw new Error(p("记忆作用域不属于当前执行通道", "The memory scope does not belong to this execution lane"));
      if(action==="list")return this.store.listMemories(target.scope,target.ownerId,{limit:Math.min(500,Math.max(1,Number(args.limit)||200))});
      if(target.scope==="user"&&args.userRequested!==true)throw new Error(p("个人记忆只能按用户明确要求修改；自动沉淀应使用工作区或会话作用域。", "Change personal memory only when the user explicitly asks; automatic capture belongs in workspace or conversation scope."));
      const existing=async()=>{const entry=(await this.store.listMemories(target.scope,target.ownerId,{limit:10000})).find(item=>item.memoryId===args.memoryId);if(entry)return entry;throw new Error(p("当前作用域没有这条记忆", "This memory is not in the current scope"));};
      if(action==="append") {
        const userMessage=target.scope==="user" ? (await this.store.listMessages(context.conversation.conversationId,{limit:1000})).filter(message=>message.senderId===me.userId&&!message.internal).at(-1) : undefined;
        result=await this.store.appendMemory({scope:target.scope,ownerId:target.ownerId,content:required(args.content),pinned:args.pinned,authorKind:target.scope==="user" ? "human" : "agent",authorUserId:target.scope==="user" ? me.userId : context.agent.userId,sourceMessageId:userMessage?.messageId});
      }
      else if(action==="update") {const entry=await existing();result=await this.store.updateMemory(entry.memoryId,args.patch??{content:required(args.content)});}
      else if(action==="delete") {const entry=await existing();await this.store.deleteMemory(entry.memoryId);result={deleted:entry.memoryId};}
      else throw new Error(p("未知记忆操作", "Unknown memory action"));
    } else throw new Error(p("未知知识工具", "Unknown knowledge tool"));
    const {centralSaved,synced}=await this.refresh();
    return {result,sync:{centralSaved,synced}};
  }
}
async function workspaceExists(workspacePath:string):Promise<boolean> {
  try {await stat(workspacePath);return true;}
  catch(error){const code=(error as NodeJS.ErrnoException).code;return code!=="ENOENT"&&code!=="ENOTDIR";}
}
function failureKey(failure:KnowledgeSyncFailure):string {return JSON.stringify([failure.category,[...failure.agents].sort(),failure.detail]);}
function required(value:unknown):string {if(typeof value!=="string"||!value.trim())throw new Error(p("缺少必填文字参数", "A required text argument is missing"));return value;}
function sameResolution(a:Partial<WorkspaceResolution>,b:WorkspaceResolution):boolean {return a.workspacePath===b.workspacePath&&a.sharesKnowledge===b.sharesKnowledge&&a.knowledgeOwnerId===b.knowledgeOwnerId;}
