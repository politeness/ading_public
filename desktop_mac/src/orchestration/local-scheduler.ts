import { turnUsageSince } from "../agents/token-usage";
import { selectGroupContext, groupContextNeedsReset, type GroupContextSelection } from "./group-context";
import { stateDelta } from "./delivered-state";
import { bestEffortSync } from "../knowledge/sync-failure";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isConnectionFailure, isContextOverflow, isProviderSessionMissing, recoveryDelay } from "./connection-recovery";
import type { AgentRuntimeConfig, ToolPermissionRequest, TurnInput } from "../agents/types";
import type {KnowledgeService} from "../knowledge/service";
import {sessionRuntimeConfig} from "../agents/runtime-config";
import { retryableStoreError, storeFailureReason } from "./store-retry";
import { workLaneStore } from "./work-lane-store";
import { WorkPlanner } from "./work-plan";
import { decodeTeamRelay, encodeTeamRelay, isTeamRelay, teamStore, type BrainstormRelayRequest } from "./team";
import { BrainstormCoordinator, brainstorming, brainstormInstruction, leaderUnavailable } from "./brainstorm";
import type { AgentRegistry } from "../agents/registry";
import type { CaptureContext } from "../skills/capture";
import type { SkillSyncer } from "../skills/sync";
import { newId } from "../store/ids";
import { owesMessage, processedByAllOwners } from "../store/message-owners";
import { tm } from "../i18n";
import type { CreateConversationInput, Store } from "../store/store";
import { controlProtocolIssue, parseLeaderControl } from "./control";
import { cleanConversationName, parseConversationTitle, conversationNamingAsk } from "./conversation-title";
import { addressOwner } from "./owner-name";
import { deniedPaths, outputTail, probeDeniedPath } from "../agents/lifecycle-diagnostics";
import { interpretProposalReply } from "./proposal-reply";
import { ExecutionGate, type ExecutionLease } from "./execution-gate";
import { memoryScopesFor, type WorkspaceResolution } from "./workspace";
import { p } from "../prompt-language";
import { localReplyAttachments, prepareReplyAttachments } from "./reply-attachments";
import { humanMemberIds, isHumanInput, latestUnansweredInput } from "./human-input";

/** Lists attachment names only (for discussion summaries and auto-naming), without downloading files */
function attachmentNote(message: Message): string {
  if (!message.attachments?.length) return "";
  return p(` [附件：${message.attachments.map(a => a.name).join("、")}]`, ` [Attachments: ${message.attachments.map(a => a.name).join(", ")}]`);
}

/** Contract version of the shared child-task channel. Bump it only when a thread
 * built under the old contract must be rebuilt; every bump costs every running
 * task one extra top-level provider session. */
const PARALLEL_TOOLS_VERSION=8;
const KNOWLEDGE_TOOLS_VERSION=1;
/** Upper bound for shutdown to wait on in-flight scheduling tasks: returns normally on timeout so quitting doesn't hang */
const SHUTDOWN_SETTLE_MS=10_000;

/**
 * The offline scheduler depends only on these ports, not on Electron.
 *
 * When the online edition later moves the same scheduling policy to the server, it can reuse the boundaries of Store, Agent execution,
 * workspace resolution, and event notification; the desktop main process only assembles the local implementations.
 */
export interface LocalSchedulerDeps {
  /** Default: three automatic attempts after meaningful new input or progress. */
  idleRetryLimit?: number;
  teamMonitorIntervalMs?: number;
  validateWorkOutputs?(work: WorkItem, workspacePath: string): Promise<string[]>;
  maxConcurrentWorkPerAgent?: number;
  /** Optional legacy low-latency replies; false keeps one provider session per Agent/task. */
  concurrentInbox?: boolean;
  /** Internal isolated execution lane; only owner input invalidates its in-flight result. */
  workAssignmentId?: string;
  agentActivity?(id: string): {busyConversationId?:string; parallel:number; capacity:number};
  agentUnavailableReason?(agent: UserRef): string;
  /** The computer is asleep (after suspend, before resume, including brief DarkWake runs): no proactive follow-ups, no new turns */
  systemAsleep?(): boolean;
  /** Returns immediately when awake, otherwise waits until wake; the sleep gate waits here, see untilAwake */
  whenAwake?(): Promise<void>;
  connectionRetryLimit?: number;
  connectionRetryDelayMs?: number;
  brainstormTimeoutMs?: number;
  /** How often a discussion turn relayed to another computer re-checks that the Agent is still available (tests). */
  relayCheckMs?: number;
  /** How long work held by an Agent on a computer that left is kept before it is released (tests). */
  strandedWorkGraceMs?: number;
  store: Store;
  registry: AgentRegistry;
  syncer: SkillSyncer;
  knowledge?: KnowledgeService;
  resolveWorkspace(conversation: Conversation): Promise<WorkspaceResolution>;
  resolveDiscovered(userId: string): DiscoveredAgent | undefined;
  isAgentReady(agent: UserRef): boolean;
  /** A local Agent is still being checked (or not yet checked): not counted as unavailable until the result is in; messages are recorded and dispatched once the check makes it available */
  isAgentPending?(agent: UserRef): boolean;
  broadcast(channel: string, payload: unknown): void;
  log(event: string, detail?: Record<string, unknown>): Promise<void>;
  getPermissionMode?(): Promise<PermissionMode>;
  requestPermission?(conversation: Conversation, agent: UserRef, request: ToolPermissionRequest): Promise<boolean>;
  afterTurn?(context: CaptureContext): Promise<void>;
  onAgentFailure?(agent: UserRef, error: string): Promise<void>;
}

/**
 * Caller-side context such as the source window is carried into later turns as-is, but the scheduler doesn't read it.
 * This keeps the core module from depending back on Electron's WebContents.
 */
export type SchedulerContext = unknown;

interface PendingTurn {
  conversation: Conversation;
  agent: UserRef;
  context: SchedulerContext;
  /** Must read at least up to this triggering message; when messages keep arriving for the same task, keep only the latest watermark. */
  afterSeq: number;
  force: boolean;
  interactive?: boolean;
  handledThrough?: number;
  /** Only accepted steers asked for this turn; dropped once the active turn is confirmed to have seen them. */
  steerFallback?: boolean;
}

interface ActiveTurnInput {
  groupContext?: GroupContextSelection;
  upToSeq: number;
  steeredThrough: number;
  /** Accepted steers in order; each covers the messages after the previous one. */
  steers: {clientMessageId: string; throughSeq: number}[];
  steerChain: Promise<void>;
}

interface PendingReport {
  conversationId: string;
  leader: UserRef;
  context: SchedulerContext;
  resolve(message: Message): void;
  reject(error: unknown): void;
}

interface InboxState {
  conversationId: string;
  pending?: PendingTurn;
  reports: Array<{resolve(message: Message): void; reject(error: unknown): void}>;
  cancelled: boolean;
  discovered?: DiscoveredAgent;
}

/**
 * The complete conversation scheduling lifecycle for the offline edition.
 *
 * main.ts only hands messages in; who speaks, prompts, turn continuation, group-chat handoff, and cancellation all live here.
 */
export class LocalScheduler {
  private readonly groupContextCache = new Map<string, Promise<GroupContextSelection | undefined>>();

  private async groupContext(conversation: Conversation, agent: UserRef): Promise<GroupContextSelection | undefined> {
    if (conversation.type !== "GROUP" || !this.deps.registry.askOnce) return undefined;
    const discovered = this.deps.resolveDiscovered(agent.userId);
    if (!discovered) return undefined;
    const messages = await this.deps.store.listMessages(conversation.conversationId, {limit:1000});
    const humans = await humanMemberIds(this.deps.store, conversation);
    const anchor = [...messages].reverse().find(m => isHumanInput(m, humans) && m.type === "USER" && !m.internal && !m.failed);
    if (!anchor) return undefined;
    const key = createHash("sha256").update(JSON.stringify([conversation.conversationId, agent.userId, anchor.messageId, anchor.content, conversation.charter])).digest("hex");
    let pending = this.groupContextCache.get(key);
    if (!pending) {
      if (this.groupContextCache.size >= 100) this.groupContextCache.delete(this.groupContextCache.keys().next().value!);
      pending = selectGroupContext(messages,humans,conversation,prompt=>this.deps.registry.askOnce({...discovered,localUuid:`${discovered.localUuid}::context-selection`},prompt))
        .then(async selection=>{
          await this.deps.log("group-context-selected",{conversation:conversation.conversationId,agent:agent.userId,anchorSeq:selection?.anchorSeq,excludedSeqs:selection?.excludedSeqs});
          return selection;
        }).catch(async error=>{
          await this.deps.log("group-context-selection-failed",{conversation:conversation.conversationId,agent:agent.userId,error:String(error)});
          // Restore previously omitted evidence too when classification fails,
          // so a reference to an older topic never loses its antecedent.
          return {anchorSeq:anchor.seq,excludedSeqs:[]};
        });
      this.groupContextCache.set(key,pending);
    }
    return pending;
  }

  private knowledgeInput(conversation:Conversation,agent:UserRef,resolution:WorkspaceResolution):Pick<TurnInput,"onKnowledgeTool"|"refreshKnowledge"> {
    const service=this.deps.knowledge;
    if(!service)return {};
    const context={conversation,agent,resolution};
    return {onKnowledgeTool:async(name,args,signal)=>service.call({...context,isolateMemory:await this.memoryIsolated(conversation,agent)},name,args,signal),refreshKnowledge:()=>service.prepare(context)};
  }
  /**
   * Isolate when the conversation has humans other than the owner (one-on-one or group, owner present or not): don't read personal memories or the Agent's own cross-conversation memories.
   * Don't isolate when only the owner and their own Agents are present, even if shared. Members that can't be looked up count as humans.
   */
  private async memoryIsolated(conversation:Conversation,agent:UserRef):Promise<boolean> {
    const current=await this.deps.store.getUser(agent.userId) ?? agent;
    const owner=current.owner ?? (await this.deps.store.currentUser()).userId;
    for(const member of conversation.members) {
      if(member.userId===owner||member.userId===agent.userId)continue;
      if(!(await this.deps.store.getUser(member.userId))?.isAgent)return true;
    }
    return false;
  }
  /** The turn currently running: agent userId -> its conversation */
  private readonly runningTurns = new Map<string, string>();
  /** Follow-up messages received by a running provider turn; confirmed insertion does not mean processing is done. */
  private readonly activeTurnInputs = new Map<string,ActiveTurnInput>();
  /** Don't drop messages while an Agent is busy; merge per task, recording only each task's latest pending watermark. */
  private readonly pendingTurns = new Map<string, Map<string, PendingTurn>>();
  /** Report requests queue while the Leader is busy and run first once the current reply finishes. */
  private readonly pendingReports = new Map<string, PendingReport[]>();
  private readonly coordinating = new Set<string>();
  private readonly inboxes = new Map<string, InboxState>();
  /** Message watermarks received during a check: agent userId -> conversation -> seq. These messages are executed or consumed after the check. */
  private readonly awaitingReady = new Map<string, Map<string, number>>();
  private readonly gate: ExecutionGate;
  private runtimeRevision = 0;
  private shuttingDown = false;
  private readonly progress = new Map<string, string>();
  private readonly startedAt = new Map<string, number>();
  private readonly planner: WorkPlanner;
  private readonly brainstorm: BrainstormCoordinator;
  private readonly idleChecks = new Set<string>();
  /** Only tasks engaged in this app session may be automatically followed up. */
  private readonly engagedConversations = new Set<string>();
  /** Explicit Stop wins over continuations already selected from an in-memory queue. */
  private readonly stoppedConversations = new Set<string>();
  private readonly workLanes = new Map<string, {conversationId:string; agentId:string; scheduler:LocalScheduler}>();
  /** A patrol, follow-up, or dispatch is already waiting during sleep: running once per conversation after wake is enough; don't queue a second */
  private readonly sleepParked = new Set<string>();
  private releaseSleepWaiters!: () => void;
  /** Release sleep-gate waiters on quit so they don't hang until the next wake */
  private readonly shutdownSignal = new Promise<void>(resolve => { this.releaseSleepWaiters = resolve; });
  private asleep(): boolean {
    return !!this.deps.systemAsleep?.();
  }
  /**
   * Sleep gate: every place that starts a new turn (speaking and its continuation, work lanes, reports, discussions, concurrent inbox, dispatch, patrol, follow-up) goes through here first.
   * While the computer is asleep (after suspend, before resume, including DarkWake), wait in place until wake, then continue immediately:
   * the pending turn is held by the waiter itself and not lost; after wake it goes through busy-merging and processed-watermark checks as usual, without duplication.
   * Connection-recovery retries and messages returned by in-flight backfills land on these entry points and likewise wait for wake. Turns already running are left alone.
   * Callers write `this.asleep() && !(await this.untilAwake(...))`: no await while awake, so turn-start timing stays the same as before.
   * key is for checks like patrols and follow-ups that need to run only once per conversation. Returns false when there's no need to start (already quitting, or one with the same key is already waiting).
   */
  private async untilAwake(where: string, conversationId: string, agentUserId?: string, key?: string): Promise<boolean> {
    if (key && this.sleepParked.has(key)) return false;
    if (key) this.sleepParked.add(key);
    try {
      await this.deps.log("turn-deferred-asleep", {conversation:conversationId,agent:agentUserId,where});
      await Promise.race([this.deps.whenAwake?.(), this.shutdownSignal]);
    } finally { if (key) this.sleepParked.delete(key); }
    if (this.shuttingDown) return false;
    await this.deps.log("turn-resumed-awake", {conversation:conversationId,agent:agentUserId,where});
    return true;
  }
  private agentActivity(agentId: string): {busyConversationId?:string; parallel:number; capacity:number} {
    return this.deps.agentActivity?.(agentId) ?? {
      busyConversationId:this.runningTurns.get(agentId) ?? [...this.workLanes.values()].find(l=>l.agentId===agentId)?.conversationId,
      parallel:this.laneCount(agentId),capacity:this.deps.maxConcurrentWorkPerAgent ?? 1
    };
  }
  private laneCount(agentId: string): number {
    return [...this.workLanes.values()].filter(l=>l.agentId === agentId).length;
  }
  private directionKey(conversationId:string,agentUserId:string):string{return `${conversationId}:${agentUserId}`;}

  /** Give new input to the provider's active turn. Unsupported routes simply keep
   * the message for the next safe turn; they never kill the current request. */
  private async steerCurrentTurn(conversation:Conversation,agent:UserRef,message:Message):Promise<boolean>{
    const key=this.directionKey(conversation.conversationId,agent.userId);
    const active=this.activeTurnInputs.get(key);
    if(!active||!this.deps.registry.steer)return false;
    const steer=async()=>{
      if(this.activeTurnInputs.get(key)!==active)return false;
      const discovered=this.deps.resolveDiscovered(agent.userId);
      if(!discovered)return false;
      const selection=await this.groupContext(conversation,agent);
      if(this.activeTurnInputs.get(key)!==active)return false;
      if(groupContextNeedsReset(selection,{conversationId:conversation.conversationId,agentUserId:agent.userId,
        providerThreadId:"active",messageSyncedSeq:active.steeredThrough,groupContext:active.groupContext})) {
        // The caller queues a fresh turn; steering cannot remove already-read text.
        await this.deps.log("turn-steer-deferred",{conversation:conversation.conversationId,agent:agent.userId,reason:"group-context-filtered"});
        return false;
      }
      const excluded=new Set(selection?.excludedSeqs ?? []);
      const delta:Message[]=[];let cursor=active.steeredThrough;
      while(cursor<message.seq){
        const page=(await this.deps.store.listMessages(conversation.conversationId,{afterSeq:cursor,limit:100})).filter(item=>item.seq<=message.seq);
        if(!page.length)break;
        delta.push(...page);cursor=page.at(-1)!.seq;
        if(page.length<100)break;
      }
      const lines=await Promise.all(delta.filter(item=>!excluded.has(item.seq)&&item.senderId!==agent.userId&&!item.failed).map(async item=>{
        const sender=await this.deps.store.getUser(item.senderId);
        const meta=item.coordination?p(`；协作状态 ${JSON.stringify(item.coordination)}`, `; coordination state ${JSON.stringify(item.coordination)}`):"";
        const said=await this.spoken(conversation.conversationId,item);
        return p(`[${item.seq}] ${sender?.isAgent?sender.displayName:"主人"}：${said}${meta}`, `[${item.seq}] ${sender?.isAgent?sender.displayName:"the task owner"}: ${said}${meta}`);
      }));
      const content=p(`执行期间收到新的聊天内容。请在不中断当前会话、保留已完成工作和仍有用的在途子任务的前提下，立即结合这些内容调整方向；独立的新工作可以通过当前会话的 ading_parallel 或厂商原生子 Agent 并行处理。\n${lines.join("\n")||`主人：${message.content}`}`, `New chat messages arrived while you were working. Without interrupting the current session, and keeping finished work and any in-flight subtasks that are still useful, adjust your direction right away based on them; independent new work can run in parallel through this session's ading_parallel or the vendor's native sub-agents.\n${lines.join("\n")||`the task owner: ${message.content}`}`);
      const result=await this.deps.registry.steer(discovered.kind,discovered.localUuid,{content,clientMessageId:message.messageId});
      if(result.status!=="accepted"){
        await this.deps.log("turn-steer-unavailable",{conversation:conversation.conversationId,agent:agent.userId,status:result.status,error:result.error});
        return false;
      }
      active.steeredThrough=Math.max(active.steeredThrough,message.seq);
      active.steers.push({clientMessageId:message.messageId,throughSeq:message.seq});
      // A successful turn/steer only confirms delivery to the provider. The
      // current turn may still finish without addressing it, so keep a durable
      // unread watermark and a fallback turn. The fallback is dropped only when
      // the provider echoes the steer into this turn before its final reply.
      this.rememberPending(conversation,agent,null,message.seq,true,true,true);
      this.emitProgress(conversation.conversationId,agent.userId,p("新消息已插入当前会话，正在结合最新内容继续", "The new message was added to the current session; continuing with the latest content"));
      await this.deps.log("turn-steered",{conversation:conversation.conversationId,agent:agent.userId,throughSeq:active.steeredThrough});
      return true;
    };
    const operation=active.steerChain.then(steer,steer);
    active.steerChain=operation.then(()=>undefined,()=>undefined);
    return operation;
  }
  /** The input a finished turn handled: its prompt plus every leading steer the
   * provider confirmed it saw before the final reply. Failed, stopped or late
   * steers keep the prompt watermark, so their fallback turn still runs. */
  private steerHandledThrough(active:ActiveTurnInput,outcome:AgentTurnOutcome):number{
    if(!outcome.ok)return active.upToSeq;
    const seen=new Set(outcome.steersSeen ?? []);
    let through=active.upToSeq;
    for(const steer of active.steers){if(!seen.has(steer.clientMessageId))break;through=steer.throughSeq;}
    return through;
  }
  private settleSteerFallback(conversationId:string,agentUserId:string,through:number):void{
    const pending=this.pendingTurns.get(agentUserId);
    const turn=pending?.get(conversationId);
    if(!turn?.steerFallback||turn.afterSeq>through)return;
    pending!.delete(conversationId);
    if(!pending!.size)this.pendingTurns.delete(agentUserId);
    void this.deps.log("turn-steer-settled",{conversation:conversationId,agent:agentUserId,throughSeq:through});
    this.emitQueue();
  }
  private startWorkLane(conversation: Conversation, agent: UserRef, message: Message): Promise<void> {
    return this.track(this.startWorkLaneNow(conversation, agent, message));
  }

  private async startWorkLaneNow(conversation: Conversation, agent: UserRef, message: Message): Promise<void> {
    const assignment = message.coordination!;
    if (this.asleep() && !(await this.untilAwake("work-lane", conversation.conversationId, agent.userId))) return;
    if (this.workLanes.has(assignment.id) || this.shuttingDown || !this.engagedConversations.has(conversation.conversationId)) return;
    // The first active lane is the Agent's primary sequential continuation and
    // reuses its task-native provider session (including brainstorm context).
    // Only simultaneous sibling lanes branch into assignment-local sessions.
    const primarySession=this.laneCount(agent.userId)===0;
    const scopedStore = workLaneStore(this.deps.store,conversation.conversationId,agent.userId,assignment.id,primarySession);
    const lane = new LocalScheduler({...this.deps,store:scopedStore,idleRetryLimit:0,maxConcurrentWorkPerAgent:1,workAssignmentId:assignment.id,
      agentActivity:id=>this.agentActivity(id),
      requestPermission:this.deps.requestPermission ? async(_conversation,who,request)=> {
        const current = await this.deps.store.getConversation(conversation.conversationId);
        return !!current && await this.deps.requestPermission!(current,who,request);
      } : undefined,
      resolveDiscovered:id=> {
        const discovered = this.deps.resolveDiscovered(id);
        return discovered && {...discovered,localUuid:`${discovered.localUuid}::work:${assignment.id}`};
      },
      broadcast:(channel,payload)=> {
        if (channel === "agent:busy" || channel === "agent:progress") {
          const progress = (payload as {text?:string}).text;
          if (progress) this.progress.set(agent.userId,`${assignment.workId}：${progress}`);
          this.deps.broadcast("agent:busy",{conversationId:conversation.conversationId,agentUserId:agent.userId,busy:true,revision:++this.runtimeRevision});
          this.emitProgress(conversation.conversationId,agent.userId,p(`并行工作 ${this.laneCount(agent.userId)} 项；${this.progress.get(agent.userId) ?? assignment.workId}`, `${this.laneCount(agent.userId)} parallel work items; ${this.progress.get(agent.userId) ?? assignment.workId}`));
        }
      },
      log:(event,detail)=>this.deps.log(event,{...detail,workId:assignment.workId,assignmentId:assignment.id})});
    // All work-state transitions use the parent's serialized planner.
    lane.planner.transition = this.planner.transition.bind(this.planner);
    lane.fillWork = async()=>{};
    lane.monitorTeam = async()=>{};
    lane.assignmentFor = async(tid,id)=> {
      const messages = await this.deps.store.listMessages(tid,{limit:1000});
      return messages.slice().reverse().find(m=>m.coordination?.assigneeId === id && (id !== agent.userId || m.coordination.id === assignment.id))?.coordination;
    };
    lane.dispatch = async(_conversation,result,context)=> {
      if (result.coordination?.phase === "accepted") return;
      const fresh = await this.deps.store.getConversation(conversation.conversationId);
      if (fresh && fresh.members.some(m=>m.userId === agent.userId && m.role === "LEADER") && result.coordination) {
        // A Leader's own lane result needs the real coordination conversation so
        // it can be independently reviewed and advance dependencies. An isolated
        // inbox can acknowledge it but cannot apply review controls.
        this.rememberPending(fresh,agent,context,result.seq,true);
        this.kickAgentWork(agent.userId);
        return;
      }
      if (fresh) await this.dispatch(fresh,{...result,mentions:result.coordination ? fresh.members.filter(m=>m.role === "LEADER").map(m=>m.userId) : result.mentions},context);
    };
    this.workLanes.set(assignment.id,{conversationId:conversation.conversationId,agentId:agent.userId,scheduler:lane});
    try {
      // The first work lane in sequential execution reuses the task's native session. If this work previously ran as a parallel sibling lane,
      // its session is stored under agentId::assignment:<workId> (see work-lane-store); when promoted to the main lane it's taken over and reused.
      // This is the normal runtime flow, not a migration of old data.
      if(primarySession && !await this.deps.store.getAgentSession(conversation.conversationId,agent.userId)){
        const siblingSession=await this.deps.store.getAgentSession(conversation.conversationId,`${agent.userId}::assignment:${assignment.id}`);
        if(siblingSession)await this.deps.store.saveAgentSession({...siblingSession,agentUserId:agent.userId});
      }
      const fresh = await scopedStore.getConversation(conversation.conversationId);
      if (fresh) await lane.runAgentTurn(fresh,agent);
    } catch (error) {
      await this.planner.transition(conversation.conversationId,assignment,"blocked");
      const fresh = await this.deps.store.getConversation(conversation.conversationId);
      if (fresh && this.engagedConversations.has(conversation.conversationId) && !fresh.paused) {
        const notice = await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:agent.userId,type:"TASK",
          content:p(`工作 ${assignment.workId} 执行通道失败：${storeFailureReason(error)}。本项未完成，请 Leader 调整安排；其他独立工作继续。`, `The execution lane for work ${assignment.workId} failed: ${storeFailureReason(error)}. This item is not done; Leader, please reassign it. Other independent work continues.`),
          coordination:{...assignment,phase:"rejected"},mentions:fresh.members.filter(m=>m.role === "LEADER").map(m=>m.userId)});
        await this.dispatch(fresh,notice);
      }
    } finally {
      this.workLanes.delete(assignment.id);
      const busy = this.runningTurns.has(agent.userId) || this.inboxes.has(agent.userId) || this.laneCount(agent.userId)>0;
      this.deps.broadcast("agent:busy",{conversationId:conversation.conversationId,agentUserId:agent.userId,busy,revision:++this.runtimeRevision});
      await this.fillWork(conversation.conversationId);
      await this.monitorTeam(conversation.conversationId);
      await this.followUpIdleConversation(conversation.conversationId);
      this.kickAgentWork(agent.userId);
    }
  }
  private async cancelWorkLanes(conversationId: string, agentId?: string): Promise<void> {
    for (const lane of this.workLanes.values()) if (lane.conversationId === conversationId && (!agentId || lane.agentId === agentId)) await lane.scheduler.stopConversation(conversationId);
  }
  private readonly teamChecks = new Set<string>();
  private readonly teamAllocationSnapshots = new Map<string, string>();

  /** Refill declared work immediately; ask the leader only when a new allocation gap exists. */
  async monitorTeam(conversationId: string, includeUnplanned = false): Promise<void> {
    if (await this.directedAndNoOpenWork(conversationId)) return;
    if (this.deps.teamMonitorIntervalMs === 0 || this.shuttingDown || !this.engagedConversations.has(conversationId) || this.teamChecks.has(conversationId)) return;
    if (this.asleep() && !(await this.untilAwake("team-monitor", conversationId, undefined, `monitor:${conversationId}`))) return;
    if (this.teamChecks.has(conversationId)) return;
    this.teamChecks.add(conversationId);
    try {
      let conversation = await this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.type !== "GROUP" || conversation.paused || conversation.status !== "ACTIVE" || brainstorming(conversation) || !(await this.hasOpenWork(conversation))) return;
      await this.fillWork(conversationId);
      conversation = await this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.paused || conversation.status !== "ACTIVE") return;
      const leaderMember = conversation.members.find(m=>m.role === "LEADER");
      const leader = leaderMember && await this.deps.store.getUser(leaderMember.userId);
      if (!leader || leaderMember?.paused || !this.deps.isAgentReady(leader) || !this.deps.resolveDiscovered(leader.userId) ||
          (await this.deps.store.getAgentSession(conversationId,leader.userId))?.recovery) return;
      const messages = await this.deps.store.listMessages(conversationId,{limit:1000});
      const assignments = new Map<string, NonNullable<Message["coordination"]>>();
      for (const m of messages) if (m.coordination) assignments.set(m.coordination.assigneeId,m.coordination);
      const idle: UserRef[] = [];
      for (const member of conversation.members) {
        const user = await this.deps.store.getUser(member.userId);
        if (!user?.isAgent || member.paused || member.ownerPaused || member.role === "OBSERVER" || !this.present(user)) continue;
        if (this.laneCount(user.userId) >= (this.deps.maxConcurrentWorkPerAgent ?? 1) || this.runningTurns.has(user.userId) || this.inboxes.has(user.userId) || this.pendingTurns.get(user.userId)?.size ||
            (await this.deps.store.getAgentSession(conversationId,user.userId))?.recovery ||
            ["proposal","accepted"].includes(assignments.get(user.userId)?.phase ?? "")) continue;
        idle.push(user);
      }
      if (!idle.length) return;
      // A wholly idle team is handled by the bounded idle follow-up, not a second wakeup.
      if (![...this.runningTurns.values()].includes(conversationId) && ![...this.workLanes.values()].some(l=>l.conversationId===conversationId)) return;
      const done=new Set((conversation.workPlan??[]).filter(w=>w.status==="done").map(w=>w.id));
      // A blocked or review item is already in hand once follow-up work started after it
      // finished (a fix, a re-review). Waking the Leader for it again only produces
      // "still waiting" turns that re-read the whole context. The Leader dispatches that
      // follow-up in the same turn that records the result, so allow a few seconds of skew.
      const plan = conversation.workPlan ?? [];
      const inHand = (item:WorkItem)=>!!item.completedAt && plan.some(other=>other.id!==item.id && other.status==="active" && !!other.startedAt &&
        Date.parse(other.startedAt) >= Date.parse(item.completedAt!) - 5000);
      const work = plan.filter(w=>((w.status==="blocked" || w.status==="review") && !inHand(w)) || (w.status==="queued" && w.dependsOn.every(id=>done.has(id))));
      // Legacy assignment-only tasks also need oversight while a teammate is working.
      const unplanned = includeUnplanned && !(conversation.workPlan?.length) && [...assignments.values()].some(a=>["proposal","accepted"].includes(a.phase));
      if (!work.length && !unplanned) return;
      const input = messages.filter(m=>m.type === "USER" && !m.agentReply).at(-1)?.seq ?? 0;
      const result = messages.filter(m=>m.coordination && ["result","revision","rejected"].includes(m.coordination.phase)).at(-1)?.seq ?? 0;
      // Coordinator busy/idle transitions are not new task progress.
      const fingerprint = JSON.stringify([input,result,conversation.members.map(m=>[m.userId,m.paused]),work]);
      if (this.teamAllocationSnapshots.get(conversationId) === fingerprint) return;
      const notice = await this.persistAgentReply({conversationId,clientMessageId:newId("message"),senderId:leader.userId,type:"SYSTEM",internal:true,
        content:p(`团队空闲检查：${idle.map(a=>`${a.displayName} [${a.userId}]（运行 ${this.laneCount(a.userId)} 项，可用容量 ${Math.max(0,(this.deps.maxConcurrentWorkPerAgent ?? 1)-this.laneCount(a.userId))}）`).join("、")} 可承接独立工作。${unplanned ? "当前只有临时分工，检查是否遗漏了可并行的工作，并登记到工作队列。" : `待安排或复核工作：${work.map(w=>`${w.id}（${w.status}）`).join("、")}。`}请检查依赖、能力和输出冲突；有独立工作就立即用 plan/batch 分配给适合的空闲成员，也可由自己承担。不能为凑人数重复劳动，不能跳过验收或权限。确实只能等待时记录具体依赖和下一触发条件；需要主人处理时在聊天里说明具体原因和动作。`, `Team idle check: ${idle.map(a=>`${a.displayName} [${a.userId}] (running ${this.laneCount(a.userId)}, free capacity ${Math.max(0,(this.deps.maxConcurrentWorkPerAgent ?? 1)-this.laneCount(a.userId))})`).join(", ")} can take independent work. ${unplanned ? "There is only an ad-hoc division of work right now; check whether any parallelizable work was missed and register it in the work queue." : `Work waiting to be scheduled or reviewed: ${work.map(w=>`${w.id} (${w.status})`).join(", ")}.`} Check dependencies, capabilities and output conflicts; if there is independent work, assign it right away with plan/batch to a suitable idle member, or take it yourself. Don't duplicate work just to keep people busy, and don't skip acceptance or permissions. If waiting really is the only option, record the specific dependency and the next trigger; if the task owner needs to act, explain the specific reason and action in the chat.`),mentions:[leader.userId]});
      this.teamAllocationSnapshots.set(conversationId,fingerprint);
      await this.deps.log("team-allocation-gap",{conversation:conversationId,idle:idle.map(a=>a.userId),work:work.map(w=>w.id)});
      // The product default queues coordination into the Leader's existing
      // provider thread. A separate tool-free inbox is an explicit legacy mode.
      if (this.deps.concurrentInbox && (this.runningTurns.has(leader.userId) || this.laneCount(leader.userId)>0)) this.queueInbox(conversation,leader,null,notice.seq);
      else this.rememberPending(conversation,leader,null,notice.seq,true);
      this.kickAgentWork(leader.userId);
    } finally { this.teamChecks.delete(conversationId); }
  }

  async monitorTeams(): Promise<void> {
    for (const conversationId of this.engagedConversations) {
      await this.monitorTeam(conversationId,true);
      await this.followUpIdleConversation(conversationId);
    }
  }

  private async persistAgentReply(input: Parameters<Store["appendMessage"]>[0]): Promise<Message> {
    const references = !input.internal && input.type !== "SYSTEM" ? localReplyAttachments(input.content) : [];
    if (references.length) {
      const conversation = await this.deps.store.getConversation(input.conversationId);
      if (!conversation) throw new Error(p("准备回复附件时找不到会话", "Conversation not found while preparing reply attachments"));
      const resolution = await this.deps.resolveWorkspace(conversation);
      input = { ...input, ...await prepareReplyAttachments({
        content: input.content, attachments: input.attachments, references,
        workspacePath: resolution.workspacePath,
        importAttachment: file => this.deps.store.importAttachment(file)
      }) };
    }
    let error: unknown;
    for (let attempt=1;attempt<=3;attempt++) {
      try { return await this.deps.store.appendMessage(input); }
      catch (cause) { error=cause; await this.deps.log("reply-save-retry",{conversation:input.conversationId,messageId:input.clientMessageId,attempt,error:String(cause)}); }
    }
    this.emitProgress(input.conversationId,input.senderId,p("回复保存失败，输入进度未推进，请检查存储后重试", "Failed to save the reply, so input progress didn't advance. Check storage and try again"));
    throw error;
  }

  async followUpIdleConversation(conversationId: string, context: SchedulerContext = null): Promise<void> {
    if (await this.directedAndNoOpenWork(conversationId)) return;
    if (this.shuttingDown || !this.engagedConversations.has(conversationId) || this.idleChecks.has(conversationId) || this.deps.idleRetryLimit === 0) return;
    // Follow-ups write prompts and count follow-ups, so don't follow up while asleep
    if (this.asleep() && !(await this.untilAwake("follow-up", conversationId, undefined, `follow-up:${conversationId}`))) return;
    if (this.shuttingDown || !this.engagedConversations.has(conversationId) || this.idleChecks.has(conversationId)) return;
    this.idleChecks.add(conversationId);
    try {
      let conversation = await this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.type !== "GROUP" || conversation.paused || conversation.status !== "ACTIVE" || (!conversation.workPlan?.length && !(await this.hasOpenWork(conversation)))) return;
      if ([...this.workLanes.values()].some(l=>l.conversationId===conversationId) || [...this.inboxes.values()].some(i=>i.conversationId===conversationId) || [...this.runningTurns.values()].includes(conversationId) || [...this.pendingTurns.values()].some(p=>p.has(conversationId)) || [...this.pendingReports.values()].some(p=>p.some(r=>r.conversationId===conversationId))) return;
      const member = conversation.members.find(m=>m.role==="LEADER");
      const leader = member && await this.deps.store.getUser(member.userId);
      if (!leader || member?.paused || !this.deps.isAgentReady(leader) || !this.deps.resolveDiscovered(leader.userId) || this.runningTurns.has(leader.userId)) return;
      // A broken connection is not an empty business queue. It has its own retry budget.
      if ((await this.deps.store.getAgentSession(conversationId,leader.userId))?.recovery) return;
      const messages = await this.deps.store.listMessages(conversationId,{limit:1000});
      // Work held by an available Agent on another computer is in progress there.
      if (await this.remoteWorkInFlight(messages)) return;
      const humanIds = await humanMemberIds(this.deps.store, conversation);
      // Chatter, SKIP, reports and new plan ids cannot reset the retry budget.
      const inputSeq = messages.filter(m=>isHumanInput(m,humanIds) && m.type==="USER").at(-1)?.seq ?? 0;
      const resultSeq = messages.filter(m=>m.coordination?.phase==="result" && !m.failed).at(-1)?.seq ?? 0;
      const done = (conversation.workPlan??[]).filter(w=>w.status==="done").map(w=>w.id).sort();
      const decision = messages.filter(m=>m.senderId===leader.userId && m.agentReply && !m.failed && !m.report && m.agentReply.lane!=="inbox").at(-1);
      const assignments = new Map<string, NonNullable<Message["coordination"]>>();
      for (const message of messages) if (message.coordination) assignments.set(message.coordination.id,message.coordination);
      const openAssignment = [...assignments.values()].some(assignment=>["proposal","accepted"].includes(assignment.phase) &&
        !conversation!.workPlan?.some(work=>work.assignmentId===assignment.id && work.status==="done"));
      // Every item is done only through a passing review. Later chat in the same group is answered as chat,
      // not treated as an unfinished delivery to chase; a new request that needs work adds new plan items.
      if (done.length && done.length===conversation.workPlan?.length && !openAssignment &&
          resultSeq <= (decision?.agentReply?.inputSeq ?? 0)) {
        // Recheck after asynchronous reads. Never disengage new input/work that
        // arrived while checking completion, and never persist a user pause.
        const fresh = await this.deps.store.getConversation(conversationId);
        if (!fresh || fresh.paused || fresh.status!=="ACTIVE" || fresh.members.find(m=>m.role==="LEADER")?.userId!==leader.userId ||
            fresh.lastSeq!==messages.at(-1)?.seq || JSON.stringify(fresh.workPlan)!==JSON.stringify(conversation.workPlan)) return;
        if ([...this.workLanes.values()].some(l=>l.conversationId===conversationId) || [...this.inboxes.values()].some(i=>i.conversationId===conversationId) ||
            [...this.runningTurns.values()].includes(conversationId) || [...this.pendingTurns.values()].some(p=>p.has(conversationId)) ||
            [...this.pendingReports.values()].some(p=>p.some(r=>r.conversationId===conversationId))) return;
        this.engagedConversations.delete(conversationId);
        await this.deps.log("conversation-work-completed",{conversation:conversationId,work:done,inputSeq:decision?.agentReply?.inputSeq});
        return;
      }
      const fingerprint = JSON.stringify([inputSeq,resultSeq,done]);
      const attempts = conversation.followUp?.fingerprint === fingerprint ? conversation.followUp.attempts : 0;
      // The user decided not to set "stop after N follow-ups": by default keep following up until the task completes, pauses, or stops.
      // idleRetryLimit is only for tests or special cases to set an explicit limit (0 means no follow-up).
      const limit = this.deps.idleRetryLimit ?? Number.POSITIVE_INFINITY;
      const ownerName = (await this.deps.store.getUser(conversation.owner))?.displayName || p("会话发起人", "the conversation owner");
      const summary = ((conversation.workPlan??[]).map(w=>`${w.id}: ${w.status}${w.evidence ? `（${w.evidence}）` : ""}`).join("；") || p("尚无后续工作计划", "No follow-up work plan yet")).slice(0,1600);
      if (attempts >= limit) {
        if (conversation.followUp?.state === "blocked" && conversation.followUp.fingerprint === fingerprint) return;
        const lastReply = messages.filter(m=>m.senderId===leader.userId && m.type!=="SYSTEM" && !m.report && !m.failed).at(-1);
        const reason = p(`会话尚未停止，但已连续跟进 ${limit} 次仍未产生新的可执行安排，自动跟进暂缓。当前状态：${summary}。${lastReply ? `\nLeader 最近回复：\n${lastReply.content.slice(0,1200)}` : "\nLeader 尚未说明具体障碍。"}\n${ownerName}可补充消息或继续会话后重试；这不是任务完成通知。`, `The conversation hasn't stopped, but ${limit} follow-ups in a row produced no new actionable plan, so automatic follow-up is paused. Current state: ${summary}.${lastReply ? `\nLeader's latest reply:\n${lastReply.content.slice(0,1200)}` : "\nThe Leader hasn't explained the specific blocker yet."}\n${ownerName} can add a message or continue the conversation to retry. This is not a completion notice.`);
        await this.deps.store.appendMessage({conversationId,clientMessageId:newId("message"),senderId:leader.userId,type:"SYSTEM",content:reason});
        await this.deps.store.updateConversation(conversationId,{followUp:{fingerprint,attempts,state:"blocked",reason}});
        await this.deps.log("conversation-idle-blocked",{conversation:conversationId,attempts});
        return;
      }
      const reason = p(`会话未停止、尚未完成交付，目前没有 Agent 正在执行。自动跟进第 ${attempts+1} 次：处理待复核项，针对受阻原因换方法或调整分工，并把自己承担的工作列入计划。仅说“我接手”或 SKIP 不会推进任务。若确实需要${ownerName}决定，必须在本条回复里重新写出具体问题，不能假定之前的问题已送达；同时继续不依赖该决定的工作。不得跳过权限审批、重复被拒绝的操作或把未验收结果当成完成。若目标已完成，请交付证据并明确停止任务。${attempts+1===limit ? "这是最后一次自动跟进，必须由你向主人说明已完成、未完成、具体障碍和下一步；不要只输出 SKIP。" : ""}\n当前队列：${summary}`, `The conversation hasn't stopped and hasn't been delivered, and no Agent is working on it right now. Automatic follow-up #${attempts+1}: handle items waiting for review, change the method or the division of work to get past blockers, and put the work you'll take on yourself into the plan. Just saying "I'll take it" or SKIP won't move the task forward. If ${ownerName} really needs to decide something, restate the specific question in this reply — don't assume an earlier question was delivered — and keep doing the work that doesn't depend on that decision. Don't skip permission approval, repeat operations that were denied, or treat unaccepted results as done. If the goal is already met, deliver the evidence and clearly stop the task.${attempts+1===limit ? " This is the last automatic follow-up: you must tell the task owner what's done, what isn't, the specific blockers and the next step; don't output only SKIP." : ""}\nCurrent queue: ${summary}`);
      const notice = await this.deps.store.appendMessage({conversationId,clientMessageId:newId("message"),senderId:leader.userId,type:"SYSTEM",content:reason,mentions:[leader.userId]});
      conversation = await this.deps.store.updateConversation(conversationId,{followUp:{fingerprint,attempts:attempts+1,state:"retrying",reason}});
      await this.deps.log("conversation-idle-follow-up",{conversation:conversationId,attempt:attempts+1});
      if (this.runningTurns.has(leader.userId)) this.rememberPending(conversation,leader,context,notice.seq,true);
      else void this.runAgentTurn(conversation,leader,context).catch(error=>this.deps.log("conversation-follow-up-failed",{conversation:conversationId,error:String(error)}));
    } finally { this.idleChecks.delete(conversationId); }
  }

  private async remoteWorkInFlight(messages: Message[]): Promise<boolean> {
    const latest = new Map<string, NonNullable<Message["coordination"]>>();
    for (const message of messages) if (message.coordination) latest.set(message.coordination.id,message.coordination);
    for (const assignment of latest.values()) {
      if (assignment.phase !== "proposal" && assignment.phase !== "accepted") continue;
      const agent = await this.deps.store.getUser(assignment.assigneeId);
      if (agent?.remote && this.present(agent)) return true;
    }
    return false;
  }

  constructor(private readonly deps: LocalSchedulerDeps) {
    // The scheduler sees the acting Leader: while the Leader can't take part, an available member coordinates.
    deps = this.deps = {...deps, store:teamStore(deps.store,{present:agent=>this.present(agent),pending:agent=>!agent.remote && !!deps.isAgentPending?.(agent)})};
    this.gate = new ExecutionGate(deps.store);
    this.brainstorm = new BrainstormCoordinator({
      store:deps.store, ready:agent=>this.present(agent),
      active:conversationId=>!this.shuttingDown && this.engagedConversations.has(conversationId),
      run:(conversation,agent)=>agent.remote ? this.relayBrainstormTurn(conversation,agent) : this.runBrainstormTurn(conversation,agent), log:deps.log,
      proceed:async(conversation,control)=> {
        if (control.action==="stop") { await this.stopConversation(conversation.conversationId); return; }
        // Anything else just ends the joint discussion; the group then carries on as a normal chat.
        if (control.action==="plan" && control.work?.length) {
          await this.planner.merge(conversation.conversationId,control.work);
          await this.fillWork(conversation.conversationId);
        }
      }
    });
    this.planner = new WorkPlanner({store:deps.store, workspacePath:async conversation=>(await deps.resolveWorkspace(conversation)).workspacePath,
      available:(id,conversationId)=>!!this.readyUsers.get(`${conversationId}:${id}`),
      busy:(id,conversationId,leaderId)=>this.runningTurns.has(id) && (id!==leaderId || this.runningTurns.get(id)!==conversationId),
      capacity:()=>deps.maxConcurrentWorkPerAgent ?? 1, log:deps.log,
      coordinates:conversation=>this.coordinatesHere(conversation),
      deliver:async(conversation,agent,message)=>this.deliverWork(conversation,agent,message)});
  }

  /** Can take part now: a ready local Agent, or a ready Agent on another computer that is online. */
  private present(agent: UserRef): boolean {
    return this.deps.isAgentReady(agent) && (!!agent.remote || !!this.deps.resolveDiscovered(agent.userId));
  }

  /** This computer coordinates the task when it hosts the (acting) Leader. Tasks without a Leader stay local. */
  private async coordinatesHere(conversation: Conversation): Promise<boolean> {
    const leader = conversation.members.find(m=>m.role === "LEADER");
    if (!leader) return true;
    return !(await this.deps.store.getUser(leader.userId))?.remote;
  }

  /** Start dispatched work. Work for an Agent on another computer reaches it through the synced message. */
  private async deliverWork(conversation: Conversation, agent: UserRef, message: Message): Promise<void> {
    if (agent.remote) return;
    this.engagedConversations.add(conversation.conversationId);
    if ((this.deps.maxConcurrentWorkPerAgent ?? 1) > 1 && message.coordination?.workId && ["proposal","accepted"].includes(message.coordination.phase)) {
      void this.startWorkLane(conversation,agent,message).catch(error=>this.deps.log("work-lane-failed",{conversation:conversation.conversationId,work:message.coordination?.workId,error:String(error)}));
      return;
    }
    if (this.runningTurns.has(agent.userId)) this.rememberPending(conversation,agent,null,message.seq,true);
    else void this.runAgentTurn(conversation,agent).catch(error=>this.deps.log("work-start-failed",{conversation:conversation.conversationId,agent:agent.userId,error:String(error)}));
  }

  private readonly readyUsers = new Map<string, boolean>();
  private async fillWork(conversationId: string): Promise<void> {
    if (this.shuttingDown || !this.engagedConversations.has(conversationId)) return;
    // Dispatch changes queued work to in-progress, so leave it in the queue while asleep
    if (this.asleep() && !(await this.untilAwake("fill-work", conversationId, undefined, `fill:${conversationId}`))) return;
    if (this.shuttingDown || !this.engagedConversations.has(conversationId)) return;
    const conversation = await this.deps.store.getConversation(conversationId);
    if (!conversation || conversation.type !== "GROUP" || brainstorming(conversation)) return;
    for (const m of conversation.members) {
      const user = await this.deps.store.getUser(m.userId);
      const session = await this.deps.store.getAgentSession(conversationId,m.userId);
      this.readyUsers.set(`${conversationId}:${m.userId}`, !!user?.isAgent && this.present(user) && session?.recovery?.state !== "blocked");
    }
    try { await this.planner.fill(conversationId); }
    catch (error) {
      const leaderId=conversation.members.find(m=>m.role === "LEADER")?.userId;
      if (leaderId) {
        const content=p(`工作队列派发失败：${storeFailureReason(error)}。未启动的工作保留，请处理原因后继续会话。`, `Failed to dispatch the work queue: ${storeFailureReason(error)}. Work that hasn't started is kept; resolve the cause and continue the conversation.`);
        this.emitProgress(conversationId,leaderId,content);
        await this.deps.store.appendMessage({conversationId,clientMessageId:newId("message"),senderId:leaderId,type:"TASK",content}).catch(()=>undefined);
      }
      throw error;
    }
  }

  runtimeSnapshot(): AgentRuntimeSnapshot {
    return { queued: this.queueSnapshot(), revision: this.runtimeRevision, agents: [...new Map([...this.runningTurns, ...[...this.workLanes.values()].map(l=>[l.agentId,l.conversationId] as [string,string]), ...[...this.inboxes].map(([id,inbox])=>[id,inbox.conversationId] as [string,string])])].map(([agentUserId, conversationId]) => ({ agentUserId, conversationId, busy: true, text: this.progress.get(agentUserId) })) };
  }

  private queueSnapshot(): AgentQueueEntry[] {
    const queued: AgentQueueEntry[] = [...this.pendingTurns].flatMap(([agentUserId, turns]) => [...turns.values()].map(turn => {
      const inbox = this.inboxes.get(agentUserId);
      const messageState: AgentQueueEntry["messageState"] = inbox?.conversationId === turn.conversation.conversationId && !inbox.cancelled
        ? inbox.pending ? "waiting" : "processing"
        : (turn.handledThrough ?? -1) >= turn.afterSeq ? "handled" : undefined;
      return {agentUserId,conversationId:turn.conversation.conversationId,waitingForConversationId:this.runningTurns.get(agentUserId),messageState};
    }));
    // A message taken by the concurrent lane has no pending turn, but it is still being handled.
    for (const [agentUserId, inbox] of this.inboxes) {
      if (inbox.cancelled || queued.some(entry => entry.agentUserId === agentUserId && entry.conversationId === inbox.conversationId)) continue;
      queued.push({agentUserId,conversationId:inbox.conversationId,waitingForConversationId:this.runningTurns.get(agentUserId),messageState:inbox.pending ? "waiting" : "processing"});
    }
    return queued;
  }

  private emitQueue(): void {
    this.deps.broadcast("agent:queue", {revision: ++this.runtimeRevision, queued: this.queueSnapshot()});
  }

  private emitProgress(conversationId: string, agentUserId: string, text: string): void {
    this.progress.set(agentUserId, text);
    this.deps.broadcast("agent:progress", { conversationId, agentUserId, text, revision: ++this.runtimeRevision });
  }

  async pauseUnavailableAgents(kind?: AgentKind): Promise<void> {
    for (const conversation of await this.deps.store.listConversations()) {
      for (const member of conversation.members) {
        if (member.paused || member.ownerPaused) continue;
        const agent = await this.deps.store.getUser(member.userId);
        // Agents on other computers are handled by their own computers. If handled here too, "no longer available" would be posted to the task in its name,
        // and the work that computer is doing would be marked blocked. The offline edition has no remote field, so behavior is unchanged
        if (agent?.isAgent && !agent.remote && (!kind || agent.kind === kind) && !this.deps.isAgentReady(agent)) {
          await this.cancelMemberWork(conversation.conversationId, agent.userId, p(`${agent.displayName} 当前不可用`, `${agent.displayName} is currently unavailable`));
          const latest = new Map<string,NonNullable<Message["coordination"]>>();
          for (const message of await this.deps.store.listMessages(conversation.conversationId,{limit:1000})) {
            if (message.coordination?.assigneeId === agent.userId) latest.set(message.coordination.id,message.coordination);
          }
          for (const assignment of latest.values()) {
            if (!["proposal","accepted"].includes(assignment.phase)) continue;
            await this.planner.transition(conversation.conversationId,assignment,"blocked");
            const notice = await this.deps.store.appendMessage({
              conversationId: conversation.conversationId, clientMessageId: newId("message"), senderId: agent.userId, type: "TASK",
              content: p(`${agent.displayName} 已不可用，${assignment.workId ? `工作 ${assignment.workId}` : "当前分工"}未完成：${this.deps.agentUnavailableReason?.(agent) ?? "Agent 当前不可用，请检查连接状态"}。请 Leader 重新安排。`, `${agent.displayName} is no longer available, and ${assignment.workId ? `work ${assignment.workId}` : "the current assignment"} isn't done: ${this.deps.agentUnavailableReason?.(agent) ?? "The Agent is currently unavailable; check its connection"}. Leader, please reassign it.`),
              mentions: conversation.members.filter(item => item.role === "LEADER").map(item => item.userId),
              coordination: { ...assignment, phase: "rejected" }
            });
            const fresh = await this.deps.store.getConversation(conversation.conversationId);
            if (fresh) await this.dispatch(fresh, notice);
          }
        }
      }
    }
  }

  /** The latest human message, when it selected Agents with @. */
  private async latestDirected(conversation: Conversation, beforeSeq = Number.MAX_SAFE_INTEGER): Promise<{seq:number;agentIds:string[]} | undefined> {
    let cursor = beforeSeq;
    while (cursor > 0) {
      const messages = await this.deps.store.listMessages(conversation.conversationId, {beforeSeq:cursor, limit:1000});
      for (const message of [...messages].reverse()) {
        if (message.seq >= cursor || message.type !== "USER") continue;
        const sender = await this.deps.store.getUser(message.senderId);
        if (!sender || sender.isAgent) continue;
        const agentIds: string[] = [];
        for (const id of message.mentions ?? []) if ((await this.deps.store.getUser(id))?.isAgent) agentIds.push(id);
        // Only people mentioned: a reminder between people, transparent to scheduling, so look further back.
        if (message.mentions?.length && !agentIds.length) continue;
        return agentIds.length ? {seq:message.seq,agentIds} : undefined;
      }
      const next = messages[0]?.seq;
      if (messages.length < 1000 || next === undefined || next >= cursor) break;
      cursor = next;
    }
    return undefined;
  }

  private async directedInput(conversation: Conversation, beforeSeq = Number.MAX_SAFE_INTEGER): Promise<boolean> {
    return !!(await this.latestDirected(conversation, beforeSeq));
  }

  /** Declared team work keeps running under a directed question; only unplanned follow-ups stay quiet. */
  private async directedAndNoOpenWork(conversationId: string): Promise<boolean> {
    const conversation = await this.deps.store.getConversation(conversationId);
    if (!conversation || conversation.workPlan?.some(item => item.status !== "done")) return false;
    return this.directedInput(conversation);
  }

  /** This turn answers the @ itself, so the Agent replies alone, even when it is the Leader. */
  private async answersDirected(conversation: Conversation, agentId: string): Promise<boolean> {
    const directed = await this.latestDirected(conversation);
    if (!directed?.agentIds.includes(agentId)) return false;
    const member = conversation.members.find(item => item.userId === agentId);
    return (member?.lastProcessedSeq ?? member?.lastReadSeq ?? 0) < directed.seq;
  }

  /** Decides which Agents a message should trigger. */
  async pickTargets(conversation: Conversation, message: Message): Promise<UserRef[]> {
    if (this.shuttingDown || conversation.paused || conversation.status !== "ACTIVE" || message.report) return [];
    // Agreement is already durable and automatically starts the worker. It needs no extra
    // leader round trip; questions, rejections and results still wake the leader immediately.
    if (conversation.type === "GROUP" && message.coordination?.phase === "accepted") return [];

    const sender = await this.deps.store.getUser(message.senderId);
    if (!sender) return [];

    // A reply to a directed human request must not start a second, unrequested agent turn.
    // Work results are not such replies: the Leader still has to review them.
    if (sender.isAgent && !message.coordination && await this.directedInput(conversation, message.seq)) return [];
    const targets: UserRef[] = [];
    for (const member of conversation.members) {
      // Agents on other computers aren't driven locally: the message has already synced there, equivalent to typing on that computer, and that computer's scheduler dispatches it
      const user = await this.deps.store.getUser(member.userId);
      if (!user || !owesMessage(conversation, member, user, message, sender)) continue;
      // User messages re-triggered after restart: Agents that already processed them don't rerun; only those not yet done are triggered
      if (!sender.isAgent && (member.lastProcessedSeq ?? 0) >= message.seq) continue;
      if (!this.deps.isAgentReady(user)) {
        await this.waitForAgentCheck(conversation.conversationId, user, "dispatch", message.seq);
        continue;
      }
      targets.push(user);
    }
    return targets;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.releaseSleepWaiters();
    this.engagedConversations.clear();
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    for (const conversation of await this.deps.store.listConversations()) await this.cancelRunningTurns(conversation.conversationId);
    // Cancelling only sends a signal: cancelled turns still need to write back results, clear the ledger, and dispatch next steps. Wait for them to wrap up before returning,
    // otherwise writes are still in flight when the caller then closes the store or deletes directories (data may be lost or files corrupted on quit).
    await this.settleInflight(SHUTDOWN_SETTLE_MS);
    await this.brainstorm.settle();
  }

  /** Scheduling tasks started in the background that nobody awaits; shutdown must wait for them to wrap up */
  private readonly inflight = new Set<Promise<unknown>>();

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const done = () => { this.inflight.delete(work); };
    work.then(done, done);
    return work;
  }

  /** Waits for in-flight tasks to finish; finishing tasks may start new ones, so loop until empty or timeout. Timeout doesn't block quitting, only logs */
  private async settleInflight(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, deadline - Date.now()); });
      await Promise.race([Promise.allSettled([...this.inflight]), timeout]);
      clearTimeout(timer);
    }
    if (this.inflight.size > 0) this.deps.log("scheduler-shutdown-timeout", { pending: this.inflight.size });
  }

  async updateConversation(conversationId: string, patch: Parameters<Store["updateConversation"]>[1], context: SchedulerContext = null): Promise<Conversation> {
    const current = await this.deps.store.getConversation(conversationId);
    const charterText = (charter?: Conversation["charter"]) => JSON.stringify([charter?.goal ?? "", charter?.instructions ?? ""]);
    const before = charterText(current?.charter);
    if (patch.name !== undefined) patch = { ...patch, autoTitle: false };
    const conversation = await this.deps.store.updateConversation(conversationId, patch);
    if (patch.charter && charterText(conversation.charter) !== before) {
      const owner = await this.deps.store.currentUser();
      const message = await this.deps.store.appendMessage({
        conversationId, clientMessageId: newId("message"), senderId: owner.userId, type: "SYSTEM",
        content: p(`会话指示已更新。\n目标：${conversation.charter?.goal ?? ""}\n你的指示：${conversation.charter?.instructions || "无额外指示"}`, `Conversation instructions updated.\nGoal: ${conversation.charter?.goal ?? ""}\nYour instructions: ${conversation.charter?.instructions || "No extra instructions"}`),
        mentions: conversation.members.filter(member => member.role === "LEADER").map(member => member.userId)
      });
      await this.dispatch(conversation, message, context);
    }
    return conversation;
  }

  /** Receives a new message and starts all Agents that should respond in parallel. */
  async dispatch(
    conversation: Conversation,
    message: Message,
    context: SchedulerContext = null
  ): Promise<void> {
    if (await this.remindsOnlyPeople(message)) return;
    if (await this.handleBrainstorm(conversation)) {
      const sender=await this.deps.store.getUser(message.senderId);
      const leaderId=conversation.brainstorm?.leaderId;
      const leader=leaderId && await this.deps.store.getUser(leaderId);
      if (sender && !sender.isAgent && leader && this.runningTurns.has(leader.userId)) {
        if(this.deps.concurrentInbox)this.queueInbox(conversation,leader,context,message.seq);
        else if(!await this.steerCurrentTurn(conversation,leader,message))this.rememberPending(conversation,leader,context,message.seq,false,true);
      }
      return;
    }
    const targets = await this.pickTargets(conversation, message);
    const sender = await this.deps.store.getUser(message.senderId);
    const interactive = !!sender && !sender.isAgent && message.type === "USER";
    if (targets.length) this.engagedConversations.add(conversation.conversationId);
    for (const target of targets) {
      if (this.runningTurns.has(target.userId) || this.laneCount(target.userId)>0) {
        // Every message is handled exactly once: by the concurrent lane when it takes it, otherwise by the next turn.
        // Actual messages/results can be handled while the execution conversation is busy.
        // Generated receipts alone must not start another conversation.
        if (this.deps.concurrentInbox && (message.failed || /^(?:(?:任务|会话)指示已更新。|(?:Task|Conversation) instructions updated\.)/.test(message.content) ||
            (!message.internal && message.type !== "SYSTEM" && (!message.coordination || ["result", "revision", "rejected"].includes(message.coordination.phase))))) {
          this.queueInbox(conversation, target, context, message.seq);
        } else if(interactive && !this.deps.concurrentInbox){
          // A discussion turn is not steered with @ content; the Agent answers it in its own turn afterwards.
          if(message.mentions.length && brainstorming(conversation))this.rememberPending(conversation,target,context,message.seq,false,true);
          else if(this.runningTurns.get(target.userId)===conversation.conversationId){
            if(!await this.steerCurrentTurn(conversation,target,message))this.rememberPending(conversation,target,context,message.seq,false,true);
          }else{
            const activeLane=[...this.workLanes.values()].find(l=>l.conversationId===conversation.conversationId&&l.agentId===target.userId);
            if(activeLane){if(!await activeLane.scheduler.steerCurrentTurn(conversation,target,message))activeLane.scheduler.rememberPending(conversation,target,context,message.seq,false,true);}
            else this.rememberPending(conversation,target,context,message.seq,false,true);
          }
        }else this.rememberPending(conversation, target, context, message.seq, false, interactive);
        continue;
      }
      void this.runAgentTurn(conversation, target, context).catch(() => undefined);
    }
  }

  /** Declared work still running or waiting for review: what team monitoring and idle follow-ups exist for. A plain chat has none. */
  private async hasOpenWork(conversation: Conversation): Promise<boolean> {
    if (conversation.workPlan?.some(work => work.status !== "done")) return true;
    const latest = new Map<string, NonNullable<Message["coordination"]>>();
    for (const message of await this.deps.store.listMessages(conversation.conversationId, {limit:1000})) if (message.coordination) latest.set(message.coordination.id, message.coordination);
    return [...latest.values()].some(assignment => ["proposal", "accepted"].includes(assignment.phase) &&
      !conversation.workPlan?.some(work => work.assignmentId === assignment.id && work.status === "done"));
  }

  /** The joint plan discussion only opens a group: once an Agent has spoken, the group is already under way. */
  private async agentsHaveSpoken(conversation: Conversation): Promise<boolean> {
    return (await this.deps.store.listMessages(conversation.conversationId, {limit:1000})).some(message => !!message.agentReply && !message.failed);
  }

  private async soloAgent(conversation: Conversation): Promise<boolean> {
    const members=await Promise.all(conversation.members.filter(m=>m.role!=="OBSERVER").map(m=>this.deps.store.getUser(m.userId)));
    return members.filter(m=>m?.isAgent).length===1;
  }

  private async handleBrainstorm(conversation: Conversation, resume = false): Promise<boolean> {
    conversation=(await this.deps.store.getConversation(conversation.conversationId)) ?? conversation;
    if (this.shuttingDown || conversation.paused || conversation.status!=="ACTIVE" || conversation.type!=="GROUP") return false;
    // @ never starts or interrupts a discussion: only the mentioned Agent answers it, and a discussion under way continues.
    if (await this.directedInput(conversation) && !(resume && brainstorming(conversation))) return false;
    if (!brainstorming(conversation) && (conversation.brainstorm || conversation.workPlan?.length || await this.soloAgent(conversation) || await this.agentsHaveSpoken(conversation))) return false;
    this.engagedConversations.add(conversation.conversationId);
    this.brainstorm.start(conversation.conversationId);
    return true;
  }

  /** Keep each Agent's discussion in one provider conversation for this task.
   * Scheduler-managed group execution resumes that conversation, while durable
   * task context also protects providers that cannot resume a native thread.
   */
  private async runBrainstormTurn(conversation: Conversation, agent: UserRef): Promise<BrainstormState["responses"][string]> {
    if (this.asleep() && !(await this.untilAwake("brainstorm", conversation.conversationId, agent.userId))) return {ok:false,reason:p("讨论已停止", "The discussion has stopped")};
    const state=conversation.brainstorm!;
    const discovered=this.deps.resolveDiscovered(agent.userId);
    if (!discovered || !this.deps.isAgentReady(agent)) return {ok:false,reason:p("成员当前不可用", "The member is currently unavailable")};
    // The Agent may be answering an @ in this conversation; one provider thread runs one turn at a time.
    while (this.runningTurns.get(agent.userId)===conversation.conversationId && !this.shuttingDown) await new Promise(resolve=>setTimeout(resolve,50));
    if (this.shuttingDown || this.stoppedConversations.has(conversation.conversationId)) return {ok:false,reason:p("讨论已停止", "The discussion has stopped")};
    const lease=this.gate.begin(conversation.conversationId,agent.userId);
    const turnId=newId("message");
    const started=Date.now();
    this.markBusy(conversation.conversationId,agent.userId,true);
    try {
      if (!(await lease.valid())) return {ok:false,reason:p("讨论已停止", "The discussion has stopped")};
      const resolution=await this.deps.resolveWorkspace(conversation);
      await bestEffortSync(()=>this.deps.syncer.ensureSynced(resolution,[discovered.kind]),[]);
      const discussionSessionId=agent.userId;
      let session=await this.deps.store.getAgentSession(conversation.conversationId,discussionSessionId);
      const priorRuntimeConfig=sessionRuntimeConfig(session);
      const isolateMemory = await this.memoryIsolated(conversation, agent);
      const isolationChanged = session?.providerThreadId && ((session.memoryIsolated === true) !== isolateMemory || isolateMemory && session.memoryIsolated === undefined);
      const groupContext = await this.groupContext(conversation,agent);
      const contextChanged = groupContextNeedsReset(groupContext,session);
      if(contextChanged || isolationChanged || this.deps.knowledge&&session?.providerThreadId&&session.knowledgeToolsVersion!==KNOWLEDGE_TOOLS_VERSION) {
        await this.deps.log("provider-thread-discarded",{conversation:conversation.conversationId,agent:agent.userId,reason:contextChanged?"group-context-filtered":isolationChanged?"memory-isolation-changed":"knowledge-tool-channel-version",lane:"brainstorm"});
        session=null;
      }
      const probe=state.phase==="probe";
      const readOnlySynthesis=state.phase==="synthesize" && !state.evidenceReady;
      const readOnlyEvidence=state.phase==="ideas" && agent.userId===state.leaderId;
      let runtimeConfig=sessionRuntimeConfig(session)??priorRuntimeConfig;
      let outcome:AgentTurnOutcome;
      let activeInput:ActiveTurnInput;
      // A full provider thread is rebuilt once from ADing's durable ledger, like the execution lane.
      for(;;){
      const sinceSeq=session?.providerThreadId ? session.messageSyncedSeq ?? 0 : 0;
      const {prompt,app,dialogue,contextMessages,upToSeq}=await this.buildPrompt(conversation,agent,resolution,sinceSeq,session?.memorySyncedAt);
      if (!(await lease.valid())) return {ok:false,reason:p("讨论已停止", "The discussion has stopped")};
      await this.deps.log("brainstorm-turn-start",{conversation:conversation.conversationId,agent:agent.userId,turnId,phase:state.phase,round:state.round,revision:state.revision,inputSeq:upToSeq});
      const activeKey=this.directionKey(conversation.conversationId,agent.userId);
      const turnInput:ActiveTurnInput=activeInput={upToSeq,steeredThrough:upToSeq,steers:[],steerChain:Promise.resolve(),groupContext};
      this.activeTurnInputs.set(activeKey,turnInput);
      try { outcome=await this.deps.registry.runTurn(discovered,{
        ...this.knowledgeInput(conversation,agent,resolution),
        steerable:true,
        contextMessages:contextMessages ? await Promise.all(contextMessages.map(text=>this.addressOwner(conversation,text))) : undefined,
        prompt:await this.addressOwner(conversation,prompt),split:await this.addressOwnerSplit(conversation,{app,dialogue}),
        threadId:session?.providerThreadId,workspacePath:resolution.workspacePath,signal:lease.signal,
        // Synthesis may inspect decisive input facts with read-only tools in the
        // same turn. This removes a whole probe/re-synthesis round without
        // allowing discussion to mutate user data.
        discussionOnly:!probe && !readOnlySynthesis && !readOnlyEvidence,communicationOnly:!probe && !readOnlySynthesis && !readOnlyEvidence,fullAccess:probe,isolateMemory:await this.memoryIsolated(conversation,agent),
        runtimeConfig,appRuntimeConfig:agent.modelConfig,onRuntimeConfig:snapshot=>{runtimeConfig=snapshot;},
        // The user decided not to time-limit Agents: no whole-turn timeout, keeping only the process-level 30-minute no-output hang fallback.
        // brainstormTimeoutMs is only for test injection.
        timeoutMs:this.deps.brainstormTimeoutMs,
        onPermission:probe && this.deps.requestPermission ? async request=> {
          if (!(await lease.valid())) return false;
          const allowed=await this.deps.requestPermission!(conversation,agent,request);
          return allowed && !request.signal.aborted && await lease.valid();
        } : undefined,
        onProgress:text=>{if(!lease.signal.aborted)this.emitProgress(conversation.conversationId,agent.userId,text);},
        onAudit:event=>{void this.deps.log("tool-event",{conversation:conversation.conversationId,agent:agent.userId,turnId,lane:"brainstorm",...event});}
      }); }
      finally {if(this.activeTurnInputs.get(activeKey)===turnInput)this.activeTurnInputs.delete(activeKey);}
      await this.deps.log("brainstorm-turn-done",{conversation:conversation.conversationId,agent:agent.userId,turnId,phase:state.phase,ok:outcome.ok,durationMs:Date.now()-started});
      if(outcome.ok || !session?.providerThreadId || outcome.cancelled || outcome.contextBudgetExhausted || outcome.metrics.sideEffects || outcome.partialMessage?.trim() || !isContextOverflow(outcome.error))break;
      await this.deps.log("provider-thread-discarded",{conversation:conversation.conversationId,agent:agent.userId,reason:"context-overflow",lane:"brainstorm"});
      session=null;
      }
      const inputSeq=this.steerHandledThrough(activeInput,outcome);
      if (!(await lease.valid())) return {ok:false,reason:p("讨论已停止", "The discussion has stopped")};
      const raw=outcome.ok ? outcome.message : outcome.partialMessage ?? "";
      const named=parseConversationTitle(raw);
      const parsed=parseLeaderControl(named.visible);
      const skip=/^skip[.!]?$/i.test(raw.trim());
      const question=agent.userId===state.leaderId && parsed.control?.action==="brainstorm" && parsed.control.decision==="ask" ? parsed.control.reason : undefined;
      const content=parsed.visible || question || raw;
      const latest=await this.deps.store.listMessages(conversation.conversationId,{afterSeq:inputSeq,limit:1000});
      const humanIds=await humanMemberIds(this.deps.store,conversation);
      const newerInput=latest.some(m=>isHumanInput(m,humanIds));
      let saved:Message|undefined;
      if (raw.trim()) saved=await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,
        content,internal:skip || (!!parsed.control && !parsed.visible && !question),steps:outcome.steps,
        agentReply:{turnId,inputSeq,raw,newerInput,lane:"brainstorm"}});
      if(outcome.threadId)await this.deps.store.saveAgentSession({conversationId:conversation.conversationId,agentUserId:discussionSessionId,
        groupContext,
        providerThreadId:outcome.threadId,memoryIsolated:isolateMemory,workspacePath:resolution.workspacePath,runtimeConfig,
        knowledgeToolsVersion:this.deps.knowledge ? KNOWLEDGE_TOOLS_VERSION : session?.knowledgeToolsVersion,
        messageSyncedSeq:saved?.seq ?? inputSeq,memorySyncedAt:new Date().toISOString()});
      if (named.title && agent.userId===state.leaderId && (await this.deps.store.getConversation(conversation.conversationId))?.autoTitle) await this.deps.store.updateConversation(conversation.conversationId,{name:named.title,autoTitle:false});
      if (!outcome.ok) {
        await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:agent.userId,type:"SYSTEM",failed:true,
          content:p(`本次方案讨论未获得有效意见：${outcome.error}`, `This planning discussion produced no usable input: ${outcome.error}`)});
        await this.deps.onAgentFailure?.(agent,outcome.error);
        return {ok:false,reason:outcome.error,durationMs:Date.now()-started};
      }
      await this.deps.store.markProcessed(conversation.conversationId,agent.userId,inputSeq);
      this.settleSteerFallback(conversation.conversationId,agent.userId,inputSeq);
      const protocolIssue=agent.userId===state.leaderId && ["synthesize","decide"].includes(state.phase) && !parsed.control
        ? controlProtocolIssue(named.visible) : undefined;
      const protocolReason=protocolIssue==="incomplete" ? p("control JSON被截断，必须缩短并完整闭合", "The control JSON was cut off; it must be shorter and fully closed")
        : protocolIssue==="invalid-plan-id" ? p("计划id非法，必须使用W1等ASCII稳定编号", "Invalid plan id; use a stable ASCII id such as W1")
        : protocolIssue==="invalid-json" ? p("control不是合法JSON", "control is not valid JSON")
        : protocolIssue==="invalid-fields" ? p("control字段不符合计划协议", "control fields don't match the plan protocol") : undefined;
      return {ok:!!raw.trim() && !skip,control:parsed.control,reason:skip ? p("SKIP，未表达评审意见", "SKIP; no review opinion given") : !raw.trim() ? p("空回复", "Empty reply") : protocolReason,durationMs:Date.now()-started};
    } finally {
      lease.close();
      this.markBusy(conversation.conversationId,agent.userId,false);
      this.kickAgentWork(agent.userId);
    }
  }

  /** Explicit legacy mode: a fresh, tool-free inbox beside execution. */
  private queueInbox(conversation: Conversation, agent: UserRef, context: SchedulerContext, afterSeq: number,
    report?: InboxState["reports"][number]): void {
    if (!report && this.coordinating.has(agent.userId)) {
      this.rememberPending(conversation,agent,context,afterSeq,true);
      return;
    }
    let state = this.inboxes.get(agent.userId);
    if (state?.cancelled || this.shuttingDown) { report?.reject(new Error(tm("orch.report.messageCancelled"))); return; }
    if (state) {
      state.pending = {conversation,agent,context,afterSeq:Math.max(afterSeq,state.pending?.afterSeq ?? 0),force:true};
      if (report) state.reports.push(report);
      this.emitQueue();
      return;
    }
    state = {conversationId:conversation.conversationId,pending:{conversation,agent,context,afterSeq,force:true},reports:report ? [report] : [],cancelled:false};
    this.inboxes.set(agent.userId,state);
    this.deps.broadcast("agent:busy",{conversationId:conversation.conversationId,agentUserId:agent.userId,busy:true,revision:++this.runtimeRevision});
    void this.drainInbox(agent,state).catch(error=>this.deps.log("inbox-drain-failed",{conversation:conversation.conversationId,agent:agent.userId,error:String(error)}));
    this.emitQueue();
  }

  private async cancelInboxes(conversationId: string, agentUserId?: string): Promise<number> {
    let cancelled=0;
    for (const [id,state] of this.inboxes) {
      if (state.conversationId!==conversationId || (agentUserId && id!==agentUserId)) continue;
      state.cancelled=true;
      state.pending=undefined;
      for (const report of state.reports.splice(0)) report.reject(new Error(tm("orch.report.cancelled")));
      if (state.discovered && await Promise.resolve(this.deps.registry.cancel(state.discovered.kind,state.discovered.localUuid))) cancelled++;
    }
    return cancelled;
  }

  private drainInbox(agent: UserRef, state: InboxState): Promise<void> {
    return this.track(this.drainInboxNow(agent, state));
  }

  private async drainInboxNow(agent: UserRef, state: InboxState): Promise<void> {
    try {
      while (state.pending && !state.cancelled && !this.shuttingDown) {
        const pending=state.pending;state.pending=undefined;
        this.emitQueue();
        const reports=state.reports.splice(0);
        try {
          const message=await this.executeInbox(pending,agent,state,reports.length>0);
          for (const report of reports) {
            if (message) report.resolve(message); else report.reject(new Error(tm("orch.report.notGenerated")));
          }
        } catch (error) {
          for (const report of reports) report.reject(error);
          await this.deps.log("inbox-turn-failed",{conversation:state.conversationId,agent:agent.userId,error:String(error)});
          // The lane didn't answer, so the message falls back to the next turn instead of being lost.
          if (!state.cancelled && !reports.length) this.rememberPending(pending.conversation,agent,pending.context,pending.afterSeq,true,true);
          if (!state.cancelled) await this.persistAgentReply({conversationId:state.conversationId,clientMessageId:newId("message"),senderId:agent.userId,
            type:"SYSTEM",internal:true,failed:true,content:p(`并发消息处理失败，原执行及待处理消息保留：${String(error).slice(0,500)}`, `Failed to handle concurrent messages; the original execution and pending messages are kept: ${String(error).slice(0,500)}`)});
        }
      }
    } finally {
      for (const report of state.reports.splice(0)) report.reject(new Error(tm("orch.report.cancelled")));
      if (this.inboxes.get(agent.userId)===state) this.inboxes.delete(agent.userId);
      this.emitQueue();
      this.deps.broadcast("agent:busy",{conversationId:state.conversationId,agentUserId:agent.userId,busy:this.runningTurns.has(agent.userId) || this.laneCount(agent.userId)>0,revision:++this.runtimeRevision});
      this.kickAgentWork(agent.userId);
      await this.followUpIdleConversation(state.conversationId);
    }
  }

  private async executeInbox(pending: PendingTurn, agent: UserRef, state: InboxState, report: boolean): Promise<Message | undefined> {
    if (this.asleep() && !(await this.untilAwake("inbox", state.conversationId, agent.userId))) return;
    const conversation=await this.deps.store.getConversation(state.conversationId);
    const discovered=this.deps.resolveDiscovered(agent.userId);
    if (!conversation || !discovered || !this.deps.isAgentReady(agent) || state.cancelled) return;
    const lease=this.gate.begin(conversation.conversationId,agent.userId);
    const turnId=newId("message");
    try {
      if (!(await lease.valid())) return;
      const resolution=await this.deps.resolveWorkspace(conversation);
      await bestEffortSync(()=>this.deps.syncer.ensureSynced(resolution,[discovered.kind]),[]);
      if (!(await lease.valid())) return;
      const answering=await this.answersDirected(conversation,agent.userId);
      const {prompt:contextPrompt,app:contextApp,dialogue,contextMessages,upToSeq}=await this.buildPrompt(answering ? {...conversation,brainstorm:undefined} : conversation,agent,resolution,0,undefined);
      // Each inbox turn has its own provider context and process key. Never overwrite
      // the execution thread ID, memory watermark or assignment result from this lane.
      const inboxAgent={...discovered,localUuid:`${discovered.localUuid}::inbox:${turnId}`};
      state.discovered=inboxAgent;
      const instructions=[
        p("当前是同一Agent的并发消息处理通道；原执行通道可能仍在调用工具，两个通道共享会话记录但不共享厂商会话。", "This is the concurrent message lane of the same Agent; the original execution session may still be calling tools. The two channels share the conversation record but not the vendor session."),
        p("本轮仅处理新消息、沟通、解释已有进展和安排后续工作，不调用工具，不执行、重复或重新提交原会话正在做的工作。这是通道职责，不表示任务缺权限。", "This turn only handles new messages: communicate, explain existing progress and arrange follow-up work. Don't call tools, and don't execute, repeat or resubmit work the original session is doing. That is this lane's role; it doesn't mean the task lacks permissions."),
        p("严格区分已经核实的事实、同伴自述和待核查事项。不能声称本轮实际查看了文件。需要工具核验就安排独立核查，不能凭猜测通过验收。", "Strictly separate verified facts, what peers report about themselves, and items still to be checked. Don't claim you actually looked at files this turn. If verification needs tools, arrange an independent check; don't pass acceptance by guessing."),
        p("Leader可以根据最新已保存证据讨论、派工和更新计划；对同一工作/依赖的版本仍须校验。独立工作不添加无关依赖。若用户改变执行要求，说明在途工作状态并协调处理，不声称旧工具已经收到更改或停止。", "The Leader may discuss, assign work and update the plan based on the latest saved evidence; versions of the same work/dependency must still be checked. Don't add unrelated dependencies to independent work. If the user changes execution requirements, explain the state of in-flight work and coordinate, without claiming that old tools already received the change or stopped."),
        p("普通成员回应问题、说明在途工作的状态和提出建议，不输出接单、交付或blocked控制；原工作结果由执行会话提交。", "Regular members answer questions, explain the state of in-flight work and make suggestions; they don't output accept, deliver or blocked controls. Results of the original work are submitted by the execution session."),
        p(`本轮重点处理触发消息，至少读到seq ${pending.afterSeq}；不要重新回答历史上已经回应的问题。当前会话消息水位：${upToSeq}。`, `Focus this turn on the triggering message, reading at least up to seq ${pending.afterSeq}; don't re-answer questions that were already answered. Current conversation message watermark: ${upToSeq}.`),
        report ? p("主人请求汇报目前进展。仅根据已保存记录给出一份真实阶段汇报，不输出控制指令。", "The task owner asked for a progress report. Give one honest status report based only on saved records, with no control instructions.") : p("没有需要补充的实质内容可回复SKIP。真实回复直接说内容，不添加通道或系统前缀。", "If there's nothing substantive to add, reply SKIP. A real reply states the content directly, without any lane or system prefix.")
      ].join("\n");
      const prompt=contextPrompt+"\n\n"+instructions;
      // Notes appended this turn are also generated by ADing, so they go with the app half
      const split={app:[contextApp,instructions].filter(Boolean).join("\n\n"),dialogue};
      const basis=structuredClone(conversation.workPlan ?? []);
      const started=Date.now();
      await this.deps.log("inbox-turn-start",{conversation:conversation.conversationId,agent:agent.userId,turnId,inputSeq:upToSeq,report});
      const outcome=await this.deps.registry.runTurn(inboxAgent,{contextMessages:contextMessages ? await Promise.all(contextMessages.map(text=>this.addressOwner(conversation,text))) : undefined,
        prompt:await this.addressOwner(conversation,prompt),split:await this.addressOwnerSplit(conversation,split),
        ...this.knowledgeInput(conversation,agent,resolution),
        threadId:undefined,workspacePath:resolution.workspacePath,
        preserveReplyText:conversation.type === "DIRECT",
        discussionOnly:true,communicationOnly:true,fullAccess:false,isolateMemory:await this.memoryIsolated(conversation,agent),signal:lease.signal,
        onAudit:event=>{void this.deps.log("tool-event",{turnId,conversation:conversation.conversationId,agent:agent.userId,lane:"inbox",...event});},
        onProgress:()=>{if(!lease.signal.aborted)this.deps.broadcast("agent:progress",{conversationId:conversation.conversationId,agentUserId:agent.userId,text:tm("orch.progress.inboxHandling"),revision:++this.runtimeRevision});}});
      await this.deps.log("inbox-turn-done",{conversation:conversation.conversationId,agent:agent.userId,turnId,durationMs:Date.now()-started,ok:outcome.ok,report});
      if (state.cancelled || !(await lease.valid())) return;
      if (!outcome.ok) {
        if (outcome.partialMessage?.trim()) await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,
          type:"SYSTEM",content:outcome.partialMessage,steps:outcome.steps,
          agentReply:{turnId,inputSeq:upToSeq,raw:outcome.partialMessage,newerInput:false,lane:"inbox"}});
        throw new Error(outcome.error);
      }
      const parsed=parseLeaderControl(parseConversationTitle(outcome.message).visible);
      if (!outcome.message.trim() || /^skip[.!]?$/i.test(outcome.message.trim())) return;
      const latest=await this.deps.store.listMessages(conversation.conversationId,{afterSeq:upToSeq,limit:1000});
      const newer=latest.filter(m=>m.type!=="SYSTEM" && m.senderId!==agent.userId && !m.internal && !m.report && !m.failed &&
        (!m.coordination || ["result","revision","rejected"].includes(m.coordination.phase)));
      const currentConversation=await this.deps.store.getConversation(conversation.conversationId);
      const leader=currentConversation?.type==="GROUP" && currentConversation.members.some(m=>m.userId===agent.userId && m.role==="LEADER");
      if (report && !leader) throw new Error(p("Leader 已切换，汇报已取消", "The Leader changed, so the report was cancelled"));
      // persistAgentReply may rewrite image links, so compare the control result with the source text.
      const replySource=parsed.visible || p(`调度控制：${parsed.control?.reason || parsed.control?.action || outcome.message}`, `Scheduling control: ${parsed.control?.reason || parsed.control?.action || outcome.message}`);
      let message=await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,
        content:replySource,
        internal:!!parsed.control && !parsed.visible && !report,report,
        agentReply:{turnId,inputSeq:upToSeq,raw:outcome.message,newerInput:newer.length>0,lane:"inbox"},steps:outcome.steps});
      const independent=newer.length>0 && newer.every(m=>m.coordination?.phase==="result");
      const defer=newer.length>0 && parsed.control?.action!=="review" && !(independent && ["plan","batch"].includes(parsed.control?.action ?? ""));
      if (leader && parsed.control && !report) {
        if (!defer) {
          const applied=await this.applyLeaderControl(currentConversation!,agent,parseConversationTitle(outcome.message).visible,pending.context,true,basis,()=>lease.valid());
          if (applied && parsed.control.action!=="stop" && (message.internal || applied!==replySource)) message=await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId+":applied",senderId:agent.userId,content:applied});
        }
        else if (!state.cancelled) state.pending={...pending,afterSeq:newer.at(-1)!.seq};
      }
      if (!report && !message.internal && await lease.valid()) {
        const fresh=await this.deps.store.getConversation(conversation.conversationId);
        if(fresh) await this.dispatch(fresh,message,pending.context);
      }
      // This lane answered these messages; a later turn or restart must not process them again.
      if (!report && await lease.valid()) await this.deps.store.markProcessed(conversation.conversationId,agent.userId,upToSeq);
      if (!report && !newer.length) {
        const continuation=this.pendingTurns.get(agent.userId)?.get(conversation.conversationId);
        if (continuation) continuation.handledThrough=Math.max(continuation.handledThrough ?? 0,upToSeq);
      }
      return message;
    } finally { state.discovered=undefined;lease.close(); }
  }

  /** Sending a message continues the task; save the message first so old context isn't processed first after resuming. */
  async sendUserMessage(
    input: { conversationId: string; clientMessageId: string; content: string; mentions?: string[]; replyTo?: string; quote?: MessageQuote; attachments?: Attachment[] },
    context: SchedulerContext = null
  ): Promise<Message> {
    this.stoppedConversations.delete(input.conversationId);
    const me = await this.deps.store.currentUser();
    const conversation = await this.deps.store.getConversation(input.conversationId);
    const message = await this.appendOwedMessage({ ...input, senderId: me.userId }, !!conversation && await this.hasLocalAgentMember(conversation));
    await this.handleUserMessage(message, context);
    return message;
  }

  /**
   * Record the "unfinished" ledger before writing the message: if it crashes after writing locally but before handing to an Agent, it can be re-triggered from the ledger on restart.
   * The ledger entry is cleared when the responsible Agents' processed watermark passes this message (see Store.markProcessed).
   */
  private async appendOwedMessage(input: Parameters<Store["appendMessage"]>[0], owed: boolean): Promise<Message> {
    if (!owed) return this.deps.store.appendMessage(input);
    await this.deps.store.oweMessage?.(input.conversationId, input.clientMessageId);
    try {
      return await this.deps.store.appendMessage(input);
    } catch (error) {
      await this.deps.store.settleOwed?.(input.conversationId, [input.clientMessageId]);
      throw error;
    }
  }

  /** Whether the task has Agents driven by this computer; Agents on other computers are handled by that computer's scheduler */
  private async hasLocalAgentMember(conversation: Conversation): Promise<boolean> {
    for (const member of conversation.members) {
      const user = await this.deps.store.getUser(member.userId);
      if (user?.isAgent && !user.remote) return true;
    }
    return false;
  }

  /**
   * A message handed to an agent: attachments become absolute local file paths, which the agent reads with its own file-reading and image tools.
   * In the online edition, attachments from other clients are downloaded here; a download failure only means it can't be read and doesn't hold up this turn.
   */
  private async spoken(conversationId: string, message: Message): Promise<string> {
    // Reply: state which message this follows up on, otherwise the Agent can't know what "this" refers to in "this is wrong"
    const quoted = message.quote ? (await this.deps.store.getUser(message.quote.senderId))?.displayName ?? message.quote.senderId : "";
    const reply = message.quote ? p(`（这条消息是在 ${quoted} 的这条消息基础上的回复：${message.quote.text}）`, `(This message is a reply to this message from ${quoted}: ${message.quote.text})`) : "";
    if (!message.attachments?.length) return [message.content, reply].filter(Boolean).join("\n");
    const lines = await Promise.all(message.attachments.map(async (attachment) => {
      try {
        const file = await this.deps.store.attachmentFile(conversationId, attachment);
        return `- ${attachment.name}（${attachment.mimeType}）：${file}`;
      } catch (error) {
        await this.deps.log("attachment-unavailable", { conversation: conversationId, attachment: attachment.attachmentId, error: error instanceof Error ? error.message : String(error) });
        return p(`- ${attachment.name}：暂时下载不到，读不了`, `- ${attachment.name}: couldn't be downloaded right now, so it can't be read`);
      }
    }));
    const head = p("附件（已保存在本机，可以直接读取）：", "Attachments (saved on this computer; read them directly):");
    return [message.content, reply, head, ...lines].filter(Boolean).join("\n");
  }

  /**
   * Online edition: messages the user sent on another device (e.g. a phone) have been backfilled from the cloud into local data,
   * and here go through the same scheduling as local messages, handed to local agents.
   * Returns true when the scheduler has taken over (or it was already processed); returns false while quitting.
   * Taking over doesn't mean done: the "unfinished" ledger is cleared only when the Agent's processed watermark passes it.
   * When the same message is handed over again (re-triggered from the ledger after restart): if all local Agents that should handle it have passed it, it's already processed and isn't executed again;
   * if only partially processed, trigger only the Agents not yet done (see pickTargets).
   */
  async receiveRemoteUserMessage(message: Message): Promise<boolean> {
    return this.acceptUserMessage(message, false);
  }

  /**
   * After restart, re-trigger user messages left unfinished last time (whether sent locally or from other clients).
   * The previous turn may have run halfway; Agents continuing the original session for this message are handled as connection recovery: verify operations already applied before continuing, no blind redo.
   */
  async redeliverUserMessage(message: Message): Promise<boolean> {
    return this.acceptUserMessage(message, true);
  }

  private async acceptUserMessage(message: Message, interrupted: boolean): Promise<boolean> {
    if (this.shuttingDown) return false;
    const known = await this.deps.store.getConversation(message.conversationId);
    // Restart recovery replays old input; it isn't a new instruction to continue.
    if (interrupted && known?.paused) {
      await this.deps.store.settleOwed?.(message.conversationId, [message.messageId]);
      return true;
    }
    if (known && known.members.some((member) => (member.lastProcessedSeq ?? 0) >= message.seq)
      && await processedByAllOwners(known, message, (userId) => this.deps.store.getUser(userId))) {
      await this.deps.log("remote-user-message-already-processed", { conversation: message.conversationId, message: message.messageId, seq: message.seq });
      await this.deps.store.settleOwed?.(message.conversationId, [message.messageId]);
      return true;
    }
    // Task gone, ended, or has no local Agent: nobody locally will handle this, so after handing it to scheduling per the original rules, don't keep a ledger entry
    const owedHere = known?.status === "ACTIVE" && await this.hasLocalAgentMember(known);
    if (interrupted && owedHere) await this.markInterrupted(known!, message);
    this.stoppedConversations.delete(message.conversationId);
    await this.handleUserMessage(message, null);
    // For tasks created on another client, the first message syncing over equals typing locally: if the naming agent is local, this computer names it
    const conversation = await this.deps.store.getConversation(message.conversationId);
    if (conversation?.autoTitle && await this.isOpeningMessage(conversation.conversationId, message)) void this.nameConversation(conversation, message.content || attachmentNote(message).trim());
    if (!owedHere) await this.deps.store.settleOwed?.(message.conversationId, [message.messageId]);
    return !this.shuttingDown;
  }

  /**
   * Reuse connection recovery: Agents that will take this message and continue the original vendor session are marked "retrying" once, and this turn carries the connection-recovery note.
   * Those without an original session replay from the task record anyway; unavailable Agents that can't wait for a check result consume these messages per the original rules, without marking.
   */
  private async markInterrupted(conversation: Conversation, message: Message): Promise<void> {
    for (const member of conversation.members) {
      if ((member.lastProcessedSeq ?? 0) >= message.seq) continue;
      const agent = await this.deps.store.getUser(member.userId);
      if (!agent || !owesMessage(conversation, member, agent, message, await this.deps.store.getUser(message.senderId)) || !(this.deps.isAgentReady(agent) || this.deps.isAgentPending?.(agent))) continue;
      const session = await this.deps.store.getAgentSession(conversation.conversationId, await this.turnSessionKey(conversation, agent.userId));
      if (!session?.providerThreadId || session.recovery) continue;
      await this.deps.store.saveAgentSession({ ...session, recovery: { attempts: 1, state: "retrying", error: p("阿钉在这一轮完成前退出", "ADing exited before this turn finished"), freshContext: false } });
      await this.deps.log("turn-interrupted-recovery", { conversation: conversation.conversationId, agent: agent.userId, message: message.messageId, seq: message.seq });
    }
  }

  /** Whether this is the first message the user sent in the task (the one when creating it) */
  private async isOpeningMessage(conversationId: string, message: Message): Promise<boolean> {
    const first = (await this.deps.store.listMessages(conversationId, { limit: 50 }))
      .filter((item) => item.type === "USER" && !item.internal)
      .sort((a, b) => a.seq - b.seq)[0];
    return first?.messageId === message.messageId;
  }

  /** Tasks with only humans (online edition and friend chats) have no agents to drive, so the scheduler doesn't step in */
  private async hasAgentMember(conversation: Conversation): Promise<boolean> {
    for (const member of conversation.members) if ((await this.deps.store.getUser(member.userId))?.isAgent) return true;
    return false;
  }

  /** Whose provider session this turn runs in: a Leader's accepted plan work has its own, keyed by work so rework resumes it. */
  private async turnSessionKey(conversation: Conversation, agentUserId: string): Promise<string> {
    if (conversation.type !== "GROUP" || this.deps.workAssignmentId) return agentUserId;
    if (conversation.members.find(member => member.userId === agentUserId)?.role !== "LEADER") return agentUserId;
    const assignment = await this.assignmentFor(conversation.conversationId, agentUserId);
    return assignment?.phase === "accepted" ? `${agentUserId}::assignment:${assignment.workId ?? assignment.id}` : agentUserId;
  }

  /** A person's @ of other people only reminds them: it must not wake, resume or steer any Agent. */
  private async remindsOnlyPeople(message: Message): Promise<boolean> {
    if (message.type !== "USER" || !message.mentions?.length) return false;
    if ((await this.deps.store.getUser(message.senderId))?.isAgent) return false;
    for (const id of message.mentions) if ((await this.deps.store.getUser(id))?.isAgent) return false;
    return true;
  }

  /** The scheduling note saying an @ of people is theirs to handle; empty when this message mentions no one else. */
  private async peopleMentionNote(item: Message, agent: UserRef): Promise<string> {
    if (item.type !== "USER" || !item.mentions?.length || item.mentions.includes(agent.userId)) return "";
    if ((await this.deps.store.getUser(item.senderId))?.isAgent) return "";
    const people: string[] = [];
    for (const id of item.mentions) {
      const mentioned = await this.deps.store.getUser(id);
      if (mentioned && !mentioned.isAgent) people.push(mentioned.displayName);
    }
    return people.length ? p(`调度上下文（不是成员发言）：上面这条消息 @ 了 ${people.join("、")}，是提醒对方，只由对方处理；你知道这件事即可，不需要处理或回复。`, `Scheduling context (not a member's message): the message above @-mentions ${people.join(", ")} to remind them. Only they handle it; you just need to be aware of it, and shouldn't handle or reply to it.`) : "";
  }

  private async handleUserMessage(message: Message, context: SchedulerContext): Promise<void> {
    if (await this.remindsOnlyPeople(message)) return;
    let conversation = await this.deps.store.getConversation(message.conversationId);
    if (conversation && !(await this.hasAgentMember(conversation))) return;
    const reengaging = !this.engagedConversations.has(message.conversationId);
    if (conversation) await this.resetBlockedConnections(conversation);
    if (conversation?.status === "ACTIVE" && conversation.paused) {
      conversation = await this.deps.store.setConversationPaused(conversation.conversationId, false);
    }
    if (conversation) await this.dispatch(conversation, message, context);
    // A new message also resumes accepted work left by a previous app session.
    // Do not restart unrelated tasks or duplicate a turn already dispatched above.
    if (conversation && reengaging) await this.resumeConversation(conversation.conversationId, context);
  }

  /** Cancels all Agent turns currently running for a task. */
  async cancelRunningTurns(conversationId: string, running: Array<[string, string]> = [...this.runningTurns]): Promise<number> {
    this.brainstorm.cancel(conversationId);
    this.finishRelays(conversationId,{ok:false,reason:p("讨论已停止", "The discussion has stopped")});
    this.gate.cancel(conversationId);
    await this.cancelWorkLanes(conversationId);
    const inboxCancelled=await this.cancelInboxes(conversationId);
    for (const [agentUserId, pending] of this.pendingTurns) {
      pending.delete(conversationId);
      if (pending.size === 0) this.pendingTurns.delete(agentUserId);
    }
    for(const key of this.activeTurnInputs.keys())if(key.startsWith(conversationId+":"))this.activeTurnInputs.delete(key);
    this.emitQueue();
    this.cancelPendingReports(conversationId, tm("orch.report.runCancelled"));
    const cancelling: Promise<boolean>[] = [];
    // The turns running when the stop was asked: an aborted turn may finish on its own while the awaits above run.
    for (const [agentUserId, runningConversationId] of running) {
      if (runningConversationId !== conversationId) continue;
      const discovered = this.deps.resolveDiscovered(agentUserId);
      if (!discovered) continue;
      cancelling.push(
        Promise.resolve(
          this.deps.registry.cancel(discovered.kind, discovered.localUuid)
        )
      );
    }
    const results = await Promise.allSettled(cancelling);
    return inboxCancelled + results.filter(
      (result) => result.status === "fulfilled" && result.value
    ).length;
  }

  /**
   * After creation, scheduling starts with the user's first message verbatim; the task form uses the goal the user filled in.
   */
  async createConversation(
    input: CreateConversationInput,
    context: SchedulerContext = null,
    dispatchOpening: LocalScheduler["dispatch"] = this.dispatch.bind(this)
  ): Promise<Conversation> {
    if (this.shuttingDown) throw new Error(tm("orch.app.exiting"));
    const direct = new Set([(await this.deps.store.currentUser()).userId, ...input.memberIds]).size === 2;
    if (direct) input = { ...input, leaderId: undefined };
    // Auto-naming needs someone to come up with the name, so group tasks pick an available Agent as leader.
    // One-on-one chats don't pick a leader and shouldn't be blocked by this check: the user has already named the counterpart,
    // and even if it's temporarily unavailable the task must still be created, with messages queued until it recovers.
    if (input.autoTitle && !input.leaderId && !direct) {
      const candidates = await Promise.all(input.memberIds.map(id => this.deps.store.getUser(id)));
      const ready = candidates.find(agent => agent?.isAgent && this.deps.isAgentReady(agent));
      if (!ready) throw new Error(tm("orch.conversation.noReadyAgent"));
      input = { ...input, leaderId: ready.userId };
    }
    const ids = input.leaderId ? [input.leaderId] : input.memberIds;
    for (const id of ids) {
      const candidate = await this.deps.store.getUser(id);
      if (!candidate?.isAgent) continue;
      if (!this.deps.isAgentReady(candidate)) throw new Error(tm(direct ? "orch.conversation.agentUnavailable" : "orch.conversation.agentUnavailablePickLeader", { name: candidate.displayName }));
      input = { ...input, leaderId: direct ? undefined : id };
      break;
    }
    const conversation = await this.deps.store.createConversation(input);
    const content = input.initialMessage ?? input.charter?.goal ?? "";
    const attachments = input.initialAttachments?.length ? input.initialAttachments : undefined;
    if (!content.trim() && !attachments) return conversation;

    const me = await this.deps.store.currentUser();
    const opening = await this.appendOwedMessage({
      conversationId: conversation.conversationId,
      clientMessageId: newId("message"),
      senderId: me.userId,
      content,
      ...(input.initialMentions?.length ? { mentions: input.initialMentions } : {}),
      attachments
    }, await this.hasLocalAgentMember(conversation));
    const latestConversation = (await this.deps.store.getConversation(conversation.conversationId)) ?? conversation;
    if (!(await this.hasAgentMember(latestConversation))) return latestConversation;
    // Naming is sent concurrently with the first turn without waiting: wall time is basically unchanged. It's placed here rather than in one execution path
    // because brainstorm, one-on-one, and group chats use different turn entry points; only task creation is the common starting point of all four.
    if (latestConversation.autoTitle) void this.nameConversation(latestConversation, content || attachmentNote(opening).trim());
    await dispatchOpening(latestConversation, opening, context);
    return latestConversation;
  }

  /**
   * After the user sends a message, resume the task and push unprocessed messages per each Agent's read watermark.
   * Ordinary task switching only displays data in the renderer and doesn't call this.
   */
  async resumeConversation(
    conversationId: string,
    context: SchedulerContext = null
  ): Promise<Conversation | null> {
    let conversation = await this.deps.store.getConversation(conversationId);
    if (!conversation) return null;
    if (conversation.status !== "ACTIVE") return conversation;
    this.stoppedConversations.delete(conversationId);
    this.engagedConversations.add(conversationId);
    if (conversation.paused) {
      conversation = await this.deps.store.setConversationPaused(conversationId, false);
    }
    if (conversation.followUp) conversation = await this.deps.store.updateConversation(conversationId,{followUp:{fingerprint:"",attempts:0,state:"retrying",reason:p("主人继续会话", "The task owner continued the conversation")}});
    await this.resetBlockedConnections(conversation);

    if (await this.handleBrainstorm(conversation,true)) return (await this.deps.store.getConversation(conversationId)) ?? conversation;

    const resumedAgents = new Set<string>();
    if ((this.deps.maxConcurrentWorkPerAgent ?? 1) > 1) {
      const messages = await this.deps.store.listMessages(conversationId,{limit:1000});
      for (const work of conversation.workPlan ?? []) {
        if (work.status !== "active" || !work.assigneeId || !work.assignmentId) continue;
        const message = messages.slice().reverse().find(m=>m.coordination?.id === work.assignmentId);
        const agent = await this.deps.store.getUser(work.assigneeId);
        if (!agent || !message || !["proposal","accepted"].includes(message.coordination!.phase)) continue;
        resumedAgents.add(agent.userId);
        if (this.laneCount(agent.userId) >= (this.deps.maxConcurrentWorkPerAgent ?? 1)) continue;
        const key = `${agent.userId}::assignment:${work.assignmentId}`;
        const session = await this.deps.store.getAgentSession(conversationId,key);
        if (session?.recovery?.state === "blocked") await this.deps.store.saveAgentSession({...session,providerThreadId:undefined,recovery:undefined,memorySyncedAt:undefined});
        void this.startWorkLane(conversation,agent,message).catch(error=>this.deps.log("work-resume-failed",{conversation:conversationId,work:work.id,error:String(error)}));
      }
    }
    for (const member of conversation.members) {
      if (member.paused || member.ownerPaused || member.role === "OBSERVER" || (resumedAgents.has(member.userId) && member.role !== "LEADER")) continue;
      const agent = await this.deps.store.getUser(member.userId);
      if (!agent?.isAgent || !this.deps.isAgentReady(agent)) continue;
      if (!this.deps.resolveDiscovered(agent.userId)) continue;
      if (this.runningTurns.get(agent.userId) === conversationId) continue;
      const session = await this.deps.store.getAgentSession(conversationId,await this.turnSessionKey(conversation,agent.userId));
      if (session?.recovery?.state !== "retrying" && !(await this.hasUnreadFromOthers(conversation, agent))) continue;
      void this.runAgentTurn(conversation, agent, context).catch(() => undefined);
    }
    await this.followUpIdleConversation(conversationId,context);
    return conversation;
  }

  private readonly ownerPausedMembers = new Set<string>();

  async syncOwnerPauses(conversationId: string): Promise<void> {
    const conversation = await this.deps.store.getConversation(conversationId);
    if (!conversation || this.shuttingDown) return;
    let resumed = false;
    for (const member of conversation.members) {
      const agent = await this.deps.store.getUser(member.userId);
      if (!agent?.isAgent || agent.remote) continue;
      if (member.ownerPaused) {
        this.ownerPausedMembers.add(member.userId);
        await this.cancelMemberWork(conversationId, member.userId, tm("main.store.ownerPaused"));
      } else if (this.ownerPausedMembers.delete(member.userId)) {
        resumed = true;
      }
    }
    if (resumed) await this.resumeConversation(conversationId);
  }

  /** Immediate local cancellation guard; the conversation's paused flag survives restart. */
  isStopped(conversationId: string): boolean {
    return this.stoppedConversations.has(conversationId);
  }

  /** Persist a task stop. Cancelling one assignment lane must not pause its parent task. */
  async stopConversation(conversationId: string): Promise<number> {
    this.stoppedConversations.add(conversationId);
    this.engagedConversations.delete(conversationId);
    const running = [...this.runningTurns];
    this.gate.cancel(conversationId);
    let cancelled = 0;
    try {
      const conversation = await this.deps.store.getConversation(conversationId);
      if (conversation && !this.deps.workAssignmentId) {
        await this.deps.store.setConversationPaused(conversationId, true);
        await this.deps.store.settleOwed?.(conversationId);
      }
    } finally {
      // A storage/sync failure must not leave the current execution running.
      cancelled = await this.cancelRunningTurns(conversationId, running);
    }
    return cancelled;
  }

  /** When removing a member, also revoke their queued and in-flight work in the current task, without affecting other tasks. */
  async removeMember(conversationId: string, userId: string): Promise<Conversation> {
    // Store validates ownership/type before any runtime state is changed.
    const next = await this.deps.store.removeMember(conversationId, userId);
    this.gate.cancel(conversationId, userId);
    await this.cancelWorkLanes(conversationId,userId);
    await this.cancelInboxes(conversationId, userId);
    const pending = this.pendingTurns.get(userId);
    pending?.delete(conversationId);
    if (pending?.size === 0) this.pendingTurns.delete(userId);
    this.emitQueue();
    this.cancelPendingReports(conversationId, tm("orch.report.memberRemoved"), userId);
    if (this.runningTurns.get(userId) === conversationId) {
      const discovered = this.deps.resolveDiscovered(userId);
      if (discovered) await Promise.resolve(this.deps.registry.cancel(discovered.kind, discovered.localUuid));
    }
    return next;
  }

  /** Cancel only this member's owned work; availability is not a membership switch. */
  private async cancelMemberWork(conversationId: string, agentUserId: string, reason: string): Promise<void> {
    this.gate.cancel(conversationId, agentUserId);
    await this.cancelWorkLanes(conversationId,agentUserId);
    await this.cancelInboxes(conversationId, agentUserId);
    const pending = this.pendingTurns.get(agentUserId);
    pending?.delete(conversationId);
    if (pending?.size === 0) this.pendingTurns.delete(agentUserId);
    this.emitQueue();
    this.cancelPendingReports(conversationId, reason, agentUserId);
    if (this.runningTurns.get(agentUserId) === conversationId) {
      const discovered = this.deps.resolveDiscovered(agentUserId);
      if (discovered) await Promise.resolve(this.deps.registry.cancel(discovered.kind, discovered.localUuid));
    }
  }

  /** The task's Agent Leader summarizes the current discussion and appends just one report to the chat, without triggering group-chat handoff. */
  async reportConversation(
    conversationId: string,
    context: SchedulerContext = null
  ): Promise<Message> {
    let conversation = await this.deps.store.getConversation(conversationId);
    if (!conversation) throw new Error(tm("orch.conversation.notFound"));
    if (conversation.type !== "GROUP") throw new Error(tm("orch.report.directNotNeeded"));
    if (conversation.paused) conversation = await this.deps.store.setConversationPaused(conversationId, false);
    if (conversation.status !== "ACTIVE") throw new Error(tm("orch.report.conversationEnded"));
    const latestMessage = (await this.deps.store.listMessages(conversationId, { limit: 1 })).at(-1);
    if (latestMessage?.report) throw new Error(tm("orch.report.alreadyLatest"));
    const leaderEntry = conversation.members.find((member) => member.role === "LEADER");
    const possibleLeader = leaderEntry
      ? await this.deps.store.getUser(leaderEntry.userId)
      : null;
    let leader = possibleLeader?.isAgent ? possibleLeader : null;
    if (!leader) {
      for (const member of conversation.members) {
        const candidate = await this.deps.store.getUser(member.userId);
        if (candidate?.isAgent && member.role === "LEADER") {
          leader = candidate;
          break;
        }
      }
    }
    if (!leader) throw new Error(tm("orch.report.noLeader"));
    const member = conversation.members.find((item) => item.userId === leader?.userId);
    if (member?.paused) throw new Error(tm("orch.report.leaderPaused", { name: leader.displayName }));

    if (this.deps.concurrentInbox && (brainstorming(conversation) || this.runningTurns.has(leader.userId) || this.inboxes.has(leader.userId) || this.laneCount(leader.userId)>0)) {
      return new Promise<Message>((resolve,reject) => this.queueInbox(conversation!,leader!,context,conversation!.lastSeq,{resolve,reject}));
    }
    return new Promise<Message>((resolve, reject) => {
      const queue = this.pendingReports.get(leader.userId) ?? [];
      queue.push({ conversationId, leader, context, resolve, reject });
      this.pendingReports.set(leader.userId, queue);
      this.kickAgentWork(leader.userId);
    });
  }

  /** Actually generates the report; the caller already holds the serial execution slot for this Leader. */
  private async executeReport(
    conversationId: string,
    leader: UserRef
  ): Promise<Message> {
    if (this.asleep() && !(await this.untilAwake("report", conversationId, leader.userId))) throw new Error(tm("orch.app.exiting"));
    const lease = this.gate.begin(conversationId, leader.userId);
    this.markBusy(conversationId, leader.userId, true);
    try { return await this.executeReportWithLease(conversationId, leader, lease); }
    finally { lease.close(); }
  }

  private async executeReportWithLease(conversationId: string, leader: UserRef, lease: ExecutionLease): Promise<Message> {
    const conversation = await this.deps.store.getConversation(conversationId);
    if (!conversation) throw new Error(tm("orch.conversation.notFound"));
    if (conversation.type !== "GROUP") throw new Error(tm("orch.report.directNotNeeded"));
    if (conversation.paused) throw new Error(tm("orch.report.conversationPaused"));
    if (conversation.status !== "ACTIVE") throw new Error(tm("orch.report.conversationEnded"));
    const latestMessage = (await this.deps.store.listMessages(conversationId, { limit: 1 })).at(-1);
    if (latestMessage?.report) throw new Error(tm("orch.report.alreadyLatest"));
    const currentLeader = conversation.members.find(
      (item) => item.role === "LEADER" && item.userId === leader.userId
    );
    if (!currentLeader) throw new Error(tm("orch.report.leaderChanged"));
    if (currentLeader.paused) {
      throw new Error(tm("orch.report.leaderPaused", { name: leader.displayName }));
    }

    const owner = await this.deps.store.getUser(conversation.owner);
    const messages = await this.deps.store.listMessages(conversationId, { limit: 160 });
    const transcriptLines = await Promise.all(
      messages
        .filter((message) => !message.report)
        .map(async (message) => {
          const speaker = await this.deps.store.getUser(message.senderId);
          return `${speaker?.displayName ?? message.senderId}：${message.content.slice(0, 1400)}${attachmentNote(message)}`;
        })
    );
    const transcript = transcriptLines.join("\n\n").slice(-30000);
    const prompt = [
      p(`你是会话「${conversation.name ?? "未命名任务"}」的 Agent Leader。`, `You are the Agent Leader of the conversation "${conversation.name ?? "Untitled task"}".`),
      conversation.charter?.goal ? p(`会话目标：${conversation.charter.goal}`, `Conversation goal: ${conversation.charter.goal}`) : "",
      conversation.charter?.instructions ? p(`主人当前指示：${conversation.charter.instructions}`, `The task owner's current instructions: ${conversation.charter.instructions}`) : "",
      p(`请向${owner?.displayName ?? "主人"}做一次阶段汇报。`, `Give ${owner?.displayName ?? "the task owner"} a progress report.`),
      p("总结此前讨论的关键结论、尚未解决的问题和建议的下一步；内容要清晰、具体，不要继续发散讨论，也不要提及这段指令。", "Summarize the key conclusions of the discussion so far, the open issues and the suggested next steps. Be clear and specific; don't keep expanding the discussion, and don't mention these instructions."),
      p("以下是当前会话的讨论记录：", "Here is the discussion record of the current conversation:"),
      transcript || p("（暂无讨论记录）", "(No discussion yet)")
    ].filter(Boolean).join("\n\n");

    if (!(await lease.valid())) throw new Error(tm("orch.report.cancelled"));
    const outcome = await this.speakInConversation(conversation, leader, prompt);
    if (!outcome.ok) throw new Error(outcome.error);
    if (!(await lease.valid())) throw new Error(tm("orch.report.cancelled"));
    const latestConversation = await this.deps.store.getConversation(conversationId);
    const latestLeader = latestConversation?.members.find(
      (item) => item.userId === leader.userId && item.role === "LEADER"
    );
    if (
      !latestConversation ||
      latestConversation.paused ||
      latestConversation.status !== "ACTIVE" ||
      !latestLeader || latestLeader.paused
    ) {
      throw new Error(tm("orch.report.conversationChanged"));
    }
    const content = outcome.message.trim();
    if (!content || /^skip[.!]?$/i.test(content)) {
      throw new Error(tm("orch.report.empty", { name: leader.displayName }));
    }
    return this.deps.store.appendMessage({
      conversationId,
      clientMessageId: newId("message"),
      senderId: leader.userId,
      content,
      steps: outcome.steps,
      report: true
    });
  }

  /**
   * Stash message watermarks during a check; if the check result is unavailable, consume these messages, and don't rerun them on later recovery.
   * readyAgain handles the race where the check finished before execution and the recovery callback fires before this turn returns.
   */
  private async waitForAgentCheck(conversationId: string, agent: UserRef, where: "dispatch" | "turn" | "queued" | "start" | "execution", afterSeq: number, readyAgain = false): Promise<void> {
    if (!this.deps.isAgentPending?.(agent) && !(readyAgain && this.deps.isAgentReady(agent))) {
      if (!agent.remote) {
        await this.deps.store.markProcessed(conversationId, agent.userId, afterSeq);
        await this.deps.log("agent-message-consumed-unavailable", { conversation: conversationId, agent: agent.userId, kind: agent.kind, upToSeq: afterSeq });
      }
      return;
    }
    let conversations = this.awaitingReady.get(agent.userId);
    if (!conversations) this.awaitingReady.set(agent.userId, conversations = new Map());
    conversations.set(conversationId, Math.max(conversations.get(conversationId) ?? 0, afterSeq));
    await this.deps.log("agent-turn-deferred", { conversation: conversationId, agent: agent.userId, kind: agent.kind, where });
    if (readyAgain) await this.resumeReadyAgents();
  }

  /** Discussion turns waiting on an Agent's own computer, by request id. */
  private readonly relays = new Map<string, {conversationId: string; finish(result: BrainstormState["responses"][string]): void}>();
  /** Requests this computer already answered: a re-pulled request must not run the turn twice. */
  private readonly answeredRelays = new Set<string>();
  /** Whether this computer coordinated each task at the last availability change. */
  private readonly coordinatorSeen = new Map<string, boolean>();
  private availabilityChanges: Promise<void> = Promise.resolve();
  private readonly releaseTimers = new Map<string, NodeJS.Timeout>();

  private finishRelays(conversationId: string, result: BrainstormState["responses"][string]): void {
    for (const relay of [...this.relays.values()]) if (relay.conversationId === conversationId) relay.finish(result);
  }

  /**
   * Coordinating computer: an Agent on another computer takes its discussion turn there.
   * Ask with a hidden message and wait for the answer. There is no time limit, as for local
   * turns; the wait ends when the Agent or its computer becomes unavailable, or the task stops.
   */
  private async relayBrainstormTurn(conversation: Conversation, agent: UserRef): Promise<BrainstormState["responses"][string]> {
    const {responses: _responses, ...state} = conversation.brainstorm!;
    const requestId = newId("message");
    let timer: NodeJS.Timeout | undefined;
    const answer = new Promise<BrainstormState["responses"][string]>(resolve => {
      const finish = (result: BrainstormState["responses"][string]) => {
        clearInterval(timer);
        if (this.relays.get(requestId)?.finish !== finish) return;
        this.relays.delete(requestId);
        resolve(result);
      };
      this.relays.set(requestId, {conversationId: conversation.conversationId, finish});
      timer = setInterval(() => {
        if (this.shuttingDown || this.stoppedConversations.has(conversation.conversationId)) finish({ok:false,reason:p("讨论已停止", "The discussion has stopped")});
        else if (!this.present(agent)) finish({ok:false,reason:p("成员当前不可用", "The member is currently unavailable")});
      }, this.deps.relayCheckMs ?? 5_000);
      timer.unref?.();
    });
    try {
      await this.deps.store.appendMessage({conversationId:conversation.conversationId,clientMessageId:requestId,senderId:state.leaderId,type:"SYSTEM",internal:true,
        content:encodeTeamRelay({kind:"brainstorm-request",requestId,agentId:agent.userId,state})});
      await this.deps.log("brainstorm-relay-requested",{conversation:conversation.conversationId,agent:agent.userId,requestId,phase:state.phase,revision:state.revision});
    } catch (error) {
      this.relays.get(requestId)?.finish({ok:false,reason:storeFailureReason(error)});
    }
    return answer;
  }

  /** The Agent's own computer: run the requested discussion turn here and answer with the result. */
  private async answerBrainstormRelay(message: Message, relay: BrainstormRelayRequest): Promise<void> {
    if (this.answeredRelays.has(relay.requestId)) return;
    this.answeredRelays.add(relay.requestId);
    const agent = await this.deps.store.getUser(relay.agentId);
    if (!agent?.isAgent || agent.remote) return;
    const conversation = await this.deps.store.getConversation(message.conversationId);
    if (!conversation || conversation.paused || conversation.status !== "ACTIVE" || this.stoppedConversations.has(conversation.conversationId)) return;
    // The coordinating computer has already moved past this round.
    if ((conversation.brainstorm?.revision ?? 0) > relay.state.revision) return;
    const member = conversation.members.find(m => m.userId === agent.userId);
    await this.deps.log("brainstorm-relay-received",{conversation:conversation.conversationId,agent:agent.userId,requestId:relay.requestId,phase:relay.state.phase,revision:relay.state.revision});
    const result: BrainstormState["responses"][string] = !member || member.paused || member.ownerPaused || member.role === "OBSERVER" || !this.present(agent)
      ? {ok:false,reason:p("成员当前不可用", "The member is currently unavailable")}
      : await this.runBrainstormTurn({...conversation,brainstorm:{...relay.state,responses:{}}},agent);
    if (this.shuttingDown) return;
    await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:agent.userId,type:"SYSTEM",internal:true,
      content:encodeTeamRelay({kind:"brainstorm-response",requestId:relay.requestId,revision:relay.state.revision,phase:relay.state.phase,result})});
  }

  /**
   * Online edition: messages from Agents on other computers. Discussion replies go back to the waiting discussion; assignments go to the assigned local Agent;
   * when this computer coordinates, results, blockers, and objections returned by executors are recorded in the shared work queue, then handed to the local Agent that should handle them (usually the Leader).
   */
  async receiveRemoteAgentMessage(message: Message): Promise<void> {
    if (this.shuttingDown) return;
    const relay = message.internal ? decodeTeamRelay(message.content) : undefined;
    if (relay?.kind === "brainstorm-response") {
      this.relays.get(relay.requestId)?.finish(relay.result);
      return;
    }
    if (relay?.kind === "brainstorm-request") {
      void this.track(this.answerBrainstormRelay(message,relay)).catch(error=>this.deps.log("brainstorm-relay-failed",{conversation:message.conversationId,requestId:relay.requestId,error:String(error)}));
      return;
    }
    const conversation = await this.deps.store.getConversation(message.conversationId);
    if (!conversation || conversation.type !== "GROUP" || conversation.paused || conversation.status !== "ACTIVE" || this.stoppedConversations.has(conversation.conversationId)) return;
    const coordination = message.coordination;
    if (coordination && message.senderId === coordination.assigneeId) {
      if (coordination.phase === "result") await this.planner.transition(conversation.conversationId,coordination,"result");
      else if (coordination.phase === "rejected" || coordination.phase === "revision") await this.planner.transition(conversation.conversationId,coordination,"blocked");
    } else if (coordination) {
      const assignee = await this.deps.store.getUser(coordination.assigneeId);
      if (assignee?.isAgent && !assignee.remote) {
        if (coordination.phase === "proposal" || coordination.phase === "accepted") {
          await this.deps.log("remote-work-received",{conversation:conversation.conversationId,agent:assignee.userId,work:coordination.workId,assignmentId:coordination.id,phase:coordination.phase});
          await this.deliverWork(conversation,assignee,message);
          return;
        }
        // The coordinator released this work (for example after this computer was offline): stop running it here.
        if (coordination.phase === "rejected" && (await this.assignmentFor(conversation.conversationId,assignee.userId))?.id === coordination.id) {
          await this.cancelMemberWork(conversation.conversationId,assignee.userId,p("分工已被收回", "The assignment was withdrawn"));
        }
      }
    }
    if (!coordination && !message.mentions?.length) return;
    await this.dispatch(conversation,message);
  }

  /**
   * Agent availability changed here or on another computer. The computer now hosting the acting
   * Leader takes over coordination right away instead of waiting for new input; work held by an
   * Agent whose computer left is released after a grace period so the team can reassign it.
   */
  teamAvailabilityChanged(firstLook = false, verifiedKind?: AgentKind): Promise<void> {
    const next = this.availabilityChanges.catch(() => {}).then(() => this.checkTeamAvailability(firstLook, verifiedKind));
    this.availabilityChanges = next;
    return this.track(next);
  }

  /** Old planning metadata is not proof that a task was interrupted. */
  private async continuationState(conversation: Conversation) {
    const messages = await this.deps.store.listMessages(conversation.conversationId, {limit:1000});
    const humans = await humanMemberIds(this.deps.store, conversation);
    const input = messages.filter(m => isHumanInput(m, humans) && m.type === "USER" && !m.internal && !m.failed && !m.report).at(-1);
    let answered = false;
    if (input) for (const message of messages) {
      if (message.seq <= input.seq || message.failed || message.report || message.coordination ||
          messages.some(later => later.seq > message.seq && later.failed && later.senderId === message.senderId)) continue;
      if (message.agentReply) {
        if (message.agentReply.lane !== "brainstorm" && message.agentReply.inputSeq >= input.seq) answered = true;
      } else if (message.type === "USER" && !message.internal && (await this.deps.store.getUser(message.senderId))?.isAgent) {
        // Older releases saved real replies without agentReply metadata.
        answered = true;
      }
    }
    const pendingInput = !!input && !answered;
    const work = await this.hasOpenWork(conversation);
    const discussion = brainstorming(conversation) && !answered;
    const interruptedDiscussion = discussion && [conversation.brainstorm?.reason,
      ...Object.values(conversation.brainstorm?.responses ?? {}).filter(r => !r.ok).map(r => r.reason)
    ].some(reason => !!reason && (isConnectionFailure(reason) || leaderUnavailable(reason)));
    return {messages, input, answered, pendingInput, work, discussion, interruptedDiscussion};
  }

  /** A successful connection probe can reopen a bounded network retry, never an auth/policy failure. */
  private async recoverVerifiedConnection(conversation: Conversation, kind: AgentKind, state: Awaited<ReturnType<LocalScheduler["continuationState"]>>): Promise<boolean> {
    if (!state.pendingInput && !state.work && !state.discussion) return false;
    let resumed = false;
    // Discussion and Leader reconciliation are task-level: several recovered members of this kind trigger them once.
    let discussion = false;
    let reconcileWith: UserRef | undefined;
    for (const member of conversation.members) {
      if (member.paused || member.ownerPaused || member.role === "OBSERVER") continue;
      const agent = await this.deps.store.getUser(member.userId);
      if (!agent || agent.remote || agent.kind !== kind || !this.deps.isAgentReady(agent) ||
          this.runningTurns.has(agent.userId) || this.inboxes.has(agent.userId) || this.laneCount(agent.userId)) continue;
      const assignment = await this.assignmentFor(conversation.conversationId, agent.userId);
      const item = conversation.workPlan?.find(w => w.id === assignment?.workId);
      // A failed worker may already have been replaced, or its output accepted.
      if (assignment && (["result", "revision"].includes(assignment.phase) || item?.status === "done" ||
          item?.assigneeId && item.assigneeId !== agent.userId ||
          assignment.phase === "rejected" && item && item.status !== "blocked")) continue;
      const key = await this.turnSessionKey(conversation, agent.userId);
      const keys = new Set([key, agent.userId]);
      for (const work of conversation.workPlan ?? []) if (work.assigneeId === agent.userId && work.status !== "done") {
        keys.add(`${agent.userId}::assignment:${work.id}`);
        if (work.assignmentId) keys.add(`${agent.userId}::assignment:${work.assignmentId}`);
      }
      const sessions: AgentSessionRef[] = [];
      for (const sessionKey of keys) {
        const session = await this.deps.store.getAgentSession(conversation.conversationId,sessionKey);
        if (session?.recovery && isConnectionFailure(session.recovery.error)) sessions.push(session);
      }
      if (!sessions.length) continue;
      const latestFailure = state.messages.filter(m => m.senderId === agent.userId && m.failed).at(-1);
      if (latestFailure && state.messages.some(m => m.senderId === agent.userId && !m.failed && !m.report && m.agentReply?.lane !== "brainstorm" &&
          (m.agentReply?.inputSeq ?? -1) >= latestFailure.seq)) continue;
      const reassign = assignment?.phase === "rejected" || (this.deps.maxConcurrentWorkPerAgent ?? 1) > 1 &&
        conversation.workPlan?.some(w => w.assigneeId === agent.userId && w.status !== "done");
      const leaderMember = conversation.members.find(m => m.role === "LEADER");
      const leader = reassign && leaderMember && await this.deps.store.getUser(leaderMember.userId);
      if (reassign && (!leader || leader.remote || !this.present(leader) || leaderMember?.paused ||
          leaderMember?.ownerPaused || this.runningTurns.has(leader.userId))) continue;
      for (const session of sessions) await this.deps.store.saveAgentSession({...session,recovery:{...session.recovery!,attempts:1,state:"retrying"}});
      this.engagedConversations.add(conversation.conversationId);
      await this.deps.log("connection-recovered-after-check",{conversation:conversation.conversationId,agent:agent.userId});
      if (state.discussion) {
        discussion = true;
      } else if (reassign && leader) {
        // Reconcile interrupted parallel work with the Leader instead of starting an unscoped worker turn.
        for (const session of sessions) await this.deps.store.saveAgentSession({...session,recovery:undefined});
        reconcileWith = leader;
      } else {
        void this.runAgentTurn(conversation,agent).catch(error=>this.deps.log("connection-resume-failed",{error:String(error)}));
      }
      resumed = true;
    }
    if (discussion) await this.handleBrainstorm(conversation,true);
    else if (reconcileWith) void this.runAgentTurn(conversation,reconcileWith).catch(error=>this.deps.log("connection-resume-failed",{error:String(error)}));
    return resumed;
  }

  private async checkTeamAvailability(firstLook: boolean, verifiedKind?: AgentKind): Promise<void> {
    if (this.shuttingDown) return;
    for (const conversation of await this.deps.store.listConversations()) {
      const conversationId = conversation.conversationId;
      if (this.asleep() || conversation.paused || conversation.status !== "ACTIVE" || this.stoppedConversations.has(conversationId)) continue;
      const continuation = await this.continuationState(conversation);
      if (verifiedKind && await this.recoverVerifiedConnection(conversation,verifiedKind,continuation)) continue;
      if (conversation.type !== "GROUP") continue;
      const leaderMember = conversation.members.find(m => m.role === "LEADER");
      const leader = leaderMember && await this.deps.store.getUser(leaderMember.userId);
      const here = !!leader?.isAgent && !leader.remote && this.present(leader);
      const before = this.coordinatorSeen.get(conversationId);
      this.coordinatorSeen.set(conversationId, here);
      if (!here) continue;
      if (continuation.answered && !continuation.work && brainstorming(conversation) && !this.runningTurns.size && !this.workLanes.size) {
        await this.deps.store.updateConversation(conversationId,{brainstorm:{...conversation.brainstorm!,phase:"ready",reason:undefined}});
        await this.deps.log("brainstorm-stale-dropped",{conversation:conversationId,inputSeq:continuation.input?.seq,revision:conversation.brainstorm?.revision});
        continue;
      }
      await this.releaseStrandedWork(conversation);
      const owed = await this.deps.store.listOwedMessages?.(conversationId) ?? [];
      const interrupted = continuation.interruptedDiscussion || continuation.pendingInput && owed.some(m => m.messageId === continuation.input?.messageId);
      // Merely observing a historical group must not turn a red-to-green check into new work.
      if (!(this.engagedConversations.has(conversationId) && (continuation.pendingInput || continuation.work || continuation.discussion)) && !interrupted) continue;
      // Repeated presence broadcasts are not new evidence that a failed connection recovered.
      if (before === true && !(interrupted && verifiedKind === leader!.kind)) continue;
      if (before === undefined && firstLook && !(interrupted && verifiedKind === leader!.kind)) continue;
      this.engagedConversations.add(conversationId);
      await this.deps.log("team-coordination-taken",{conversation:conversationId,leader:leader!.userId});
      if (continuation.interruptedDiscussion && conversation.brainstorm) {
        const state = conversation.brainstorm;
        await this.deps.store.updateConversation(conversationId,{brainstorm:{...state,
          phase:state.phase === "waiting" ? state.evidenceReady ? "synthesize" : "ideas" : state.phase,
          attempts:0, reason:undefined,
          responses:Object.fromEntries(Object.entries(state.responses).filter(([,r])=>r.ok || !r.reason || !isConnectionFailure(r.reason)))
        }});
      }
      // A discussion under way, or one the previous coordinator never got to start, continues here.
      if (await this.handleBrainstorm(conversation,true)) continue;
      // Input the previous coordinator received but never answered (its Leader went offline or was
      // changed mid-turn) is handled here as if it had just arrived. Answered input is not replayed.
      if (await this.dispatchUnansweredInput(conversationId)) continue;
      if (await this.hasOpenWork(conversation)) {
        await this.monitorTeam(conversationId,true);
        await this.followUpIdleConversation(conversationId);
      }
    }
  }

  private async dispatchUnansweredInput(conversationId: string): Promise<boolean> {
    const conversation = await this.deps.store.getConversation(conversationId);
    if (!conversation || conversation.paused || conversation.status !== "ACTIVE") return false;
    const messages = await this.deps.store.listMessages(conversationId, {limit:1000});
    const input = latestUnansweredInput(messages, await humanMemberIds(this.deps.store, conversation));
    const leader = conversation.members.find(m => m.role === "LEADER");
    if (!input || (leader?.lastProcessedSeq ?? 0) >= input.seq) return false;
    await this.deps.log("unanswered-input-resumed", {conversation:conversationId, seq:input.seq, leader:leader?.userId});
    await this.dispatch(conversation, input);
    return true;
  }

  private async releaseStrandedWork(conversation: Conversation): Promise<void> {
    const latest = new Map<string, NonNullable<Message["coordination"]>>();
    for (const message of await this.deps.store.listMessages(conversation.conversationId,{limit:1000})) if (message.coordination) latest.set(message.coordination.id,message.coordination);
    for (const assignment of latest.values()) {
      if (assignment.phase !== "proposal" && assignment.phase !== "accepted") continue;
      if (conversation.workPlan?.some(w => w.assignmentId === assignment.id && w.status === "done")) continue;
      const agent = await this.deps.store.getUser(assignment.assigneeId);
      if (!agent?.isAgent || !agent.remote) continue;
      const key = `${conversation.conversationId}:${assignment.id}`;
      if (this.present(agent)) {
        clearTimeout(this.releaseTimers.get(key));
        this.releaseTimers.delete(key);
        continue;
      }
      if (this.releaseTimers.has(key)) continue;
      const timer = setTimeout(() => {
        this.releaseTimers.delete(key);
        void this.track(this.releaseAssignment(conversation.conversationId,assignment.id,agent.userId)).catch(error=>this.deps.log("stranded-work-release-failed",{conversation:conversation.conversationId,assignmentId:assignment.id,error:String(error)}));
      }, this.deps.strandedWorkGraceMs ?? 60_000);
      timer.unref?.();
      this.releaseTimers.set(key, timer);
    }
  }

  private async releaseAssignment(conversationId: string, assignmentId: string, agentId: string): Promise<void> {
    const agent = await this.deps.store.getUser(agentId);
    if (this.shuttingDown || !agent || this.present(agent)) return;
    const conversation = await this.deps.store.getConversation(conversationId);
    if (!conversation || conversation.paused || conversation.status !== "ACTIVE" || !(await this.coordinatesHere(conversation))) return;
    const assignment = (await this.deps.store.listMessages(conversationId,{limit:1000})).filter(m => m.coordination?.id === assignmentId).at(-1)?.coordination;
    if (!assignment || (assignment.phase !== "proposal" && assignment.phase !== "accepted")) return;
    if (conversation.workPlan?.some(w => w.assignmentId === assignmentId && w.status === "done")) return;
    const leaderId = conversation.members.find(m => m.role === "LEADER")?.userId;
    if (!leaderId) return;
    await this.planner.transition(conversationId,assignment,"blocked");
    const notice = await this.deps.store.appendMessage({conversationId,clientMessageId:newId("message"),senderId:leaderId,type:"TASK",mentions:[leaderId],
      content:p(`${agent.displayName} 所在电脑已离线或该 Agent 不可用，${assignment.workId ? `工作 ${assignment.workId}` : "当前分工"}未完成，已收回。请 Leader 重新安排。`, `${agent.displayName}'s computer went offline or the Agent is unavailable, so ${assignment.workId ? `work ${assignment.workId}` : "the current assignment"} isn't done and has been withdrawn. Leader, please reassign it.`),
      coordination:{...assignment,phase:"rejected"}});
    await this.deps.log("stranded-work-released",{conversation:conversationId,agent:agentId,assignmentId,work:assignment.workId});
    const fresh = await this.deps.store.getConversation(conversationId);
    if (fresh) await this.dispatch(fresh,notice);
  }

  /** Settles stashed messages when a check ends: rerun if available, otherwise only advance the consumed watermark for the stashed batch. */
  async resumeReadyAgents(): Promise<void> {
    for (const [agentUserId, conversationIds] of [...this.awaitingReady]) {
      const agent = await this.deps.store.getUser(agentUserId);
      if (!agent) { this.awaitingReady.delete(agentUserId); continue; }
      if (!this.deps.isAgentReady(agent) && this.deps.isAgentPending?.(agent)) continue;
      this.awaitingReady.delete(agentUserId);
      for (const [conversationId, afterSeq] of conversationIds) {
        const conversation = await this.deps.store.getConversation(conversationId);
        if (!conversation || this.shuttingDown || this.stoppedConversations.has(conversationId) || conversation.paused || conversation.status !== "ACTIVE") continue;
        const member = conversation.members.find(item => item.userId === agentUserId);
        if (!member || member.paused || member.ownerPaused || member.role === "OBSERVER") continue;
        if (!this.deps.isAgentReady(agent)) {
          await this.waitForAgentCheck(conversationId, agent, "queued", afterSeq);
          continue;
        }
        const unread = await this.hasUnreadFromOthers(conversation, agent);
        await this.deps.log("agent-turn-resumed", { conversation: conversationId, agent: agentUserId, unread });
        if (unread) void this.runAgentTurn(conversation, agent, null).catch(() => undefined);
      }
    }
  }

  /** Runs one speaking turn for an Agent; the result is stored as an ordinary message. */
  async runAgentTurn(conversation: Conversation, agent: UserRef, context: SchedulerContext = null): Promise<void> {
    return this.track(this.runAgentTurnNow(conversation, agent, context));
  }

  private async runAgentTurnNow(
    conversation: Conversation,
    agent: UserRef,
    context: SchedulerContext
  ): Promise<void> {
    if (this.shuttingDown || this.stoppedConversations.has(conversation.conversationId)) return;
    if (this.asleep() && !(await this.untilAwake("turn", conversation.conversationId, agent.userId))) return;
    if (this.shuttingDown || this.stoppedConversations.has(conversation.conversationId)) return;
    if (conversation.paused || conversation.status !== "ACTIVE") return;
    if (!this.deps.isAgentReady(agent)) {
      await this.waitForAgentCheck(conversation.conversationId, agent, "turn", conversation.lastSeq);
      return;
    }
    if (!this.deps.resolveDiscovered(agent.userId)) return;
    this.engagedConversations.add(conversation.conversationId);
    if (this.runningTurns.has(agent.userId) || this.inboxes.has(agent.userId) || this.laneCount(agent.userId)>0) {
      this.rememberPending(conversation, agent, context, conversation.lastSeq);
      return;
    }

    this.markBusy(conversation.conversationId, agent.userId, true);
    try {
      let pending: PendingTurn | undefined = {
        conversation,
        agent,
        context,
        afterSeq: conversation.lastSeq,
        force: true
      };
      while (pending) {
        // The computer was asleep when the previous turn finished: the continuation turn (including connection-recovery retries) waits in place for wake without giving up the execution slot
        if (this.asleep() && !(await this.untilAwake("continuation", pending.conversation.conversationId, agent.userId))) break;
        // The preceding coordination turn may have launched this same Agent's
        // work lane. Do not consume a queued inspection/coordination turn in
        // the already-running outer loop beside that new provider writer.
        if(this.inboxes.has(agent.userId) || this.laneCount(agent.userId)>0){
          this.rememberPending(pending.conversation,pending.agent,pending.context,pending.afterSeq,pending.force,pending.interactive);
          pending=undefined;
          break;
        }
        const latestConversation =
          (await this.deps.store.getConversation(pending.conversation.conversationId)) ?? pending.conversation;
        const latestAgent =
          (await this.deps.store.getUser(pending.agent.userId)) ?? pending.agent;
        const member = latestConversation.members.find(
          (item) => item.userId === latestAgent.userId
        );
        const hasUnread = (member?.lastProcessedSeq ?? member?.lastReadSeq ?? 0) < pending.afterSeq;
        const due =
          !this.shuttingDown && this.engagedConversations.has(latestConversation.conversationId) && !latestConversation.paused &&
          latestConversation.status === "ACTIVE" &&
          !!member &&
          !member.paused && !member.ownerPaused &&
          member.role !== "OBSERVER" &&
          (pending.force || hasUnread);
        if (due && !this.deps.isAgentReady(latestAgent)) {
          await this.waitForAgentCheck(latestConversation.conversationId, latestAgent, "queued", pending.afterSeq);
        } else if (due && this.deps.resolveDiscovered(latestAgent.userId)) {
          this.markBusy(latestConversation.conversationId, latestAgent.userId, true);
          await this.executeAgentTurn(latestConversation, latestAgent, pending.context);
        }
        await this.drainPendingReports(agent.userId);
        pending = this.inboxes.has(agent.userId) ? undefined : this.takePending(agent.userId);
      }
    } finally {
      this.markBusy(conversation.conversationId, agent.userId, false);
      this.kickAgentWork(agent.userId);
      for (const candidate of await this.deps.store.listConversations()) {
        if (candidate.workPlan?.some(w=>w.status==="queued")) await this.fillWork(candidate.conversationId);
      }
      await this.monitorTeam(conversation.conversationId);
      await this.followUpIdleConversation(conversation.conversationId,context);
    }
  }

  /** Runs one turn; serialization and unread push for the same Agent are guaranteed by the outer runAgentTurn. */
  private async executeAgentTurn(
    conversation: Conversation,
    agent: UserRef,
    context: SchedulerContext
  ): Promise<void> {
    // A direction-change continuation may already have been selected by the
    // outer loop when Stop arrives. Recheck the app-session engagement at the
    // last synchronous boundary so Stop cannot miss a not-yet-started process.
    if(!this.engagedConversations.has(conversation.conversationId))return;
    const lease = this.gate.begin(conversation.conversationId, agent.userId);
    const assignment=await this.assignmentFor(conversation.conversationId,agent.userId);
    const coordinator=!!conversation.workPlan?.length && conversation.members.some(m=>m.userId===agent.userId && m.role==="LEADER") && assignment?.phase!=="accepted";
    if (coordinator) this.coordinating.add(agent.userId);
    try { await this.executeAgentTurnWithLease(conversation, agent, context, lease); }
    finally { this.coordinating.delete(agent.userId); lease.close(); }
  }

  private async executeAgentTurnWithLease(conversation: Conversation, agent: UserRef, context: SchedulerContext, lease: ExecutionLease): Promise<void> {
      const discovered = this.deps.resolveDiscovered(agent.userId);
      if (!discovered) return;
      const member = conversation.members.find((item) => item.userId === agent.userId);
      const myAssignment = conversation.type === "GROUP" ? await this.assignmentFor(conversation.conversationId, agent.userId) : undefined;
      const directedTurn = await this.answersDirected(conversation, agent.userId);
      const leaderCoordinator=conversation.type==="GROUP" && !!conversation.workPlan?.length && member?.role==="LEADER" && myAssignment?.phase!=="accepted" && !this.deps.workAssignmentId;
      // Direct chat and accepted group work use the same provider-independent
      // child-task channel. Discussion and coordinator-only turns stay read-only.
      const parallelTools=!this.deps.workAssignmentId && !!this.deps.registry.adapterFor?.(discovered.kind)?.supportsParallelWork && !!this.deps.requestPermission && (conversation.type==="DIRECT" || await this.soloAgent(conversation) || myAssignment?.phase==="accepted");
      let sinceSeq = member?.lastProcessedSeq ?? member?.lastReadSeq ?? 0;
      // A Leader's own plan work runs in its own provider session: what it reads and runs
      // stays there, and only the result reaches the thread every coordination turn re-reads.
      const sessionKey = await this.turnSessionKey(conversation, agent.userId);
      const ownWork = sessionKey !== agent.userId;
      let session = await this.deps.store.getAgentSession(
        conversation.conversationId,
        sessionKey
      );
      if (session?.recovery?.state === "blocked") return;
      // Both of a Leader's threads move the one processed watermark; each must still see what the other handled.
      if (member?.role === "LEADER" && conversation.type === "GROUP" && session?.providerThreadId && session.messageSyncedSeq !== undefined) sinceSeq = Math.min(sinceSeq, session.messageSyncedSeq);
      const recovery = session?.recovery;
      const priorRuntimeConfig=sessionRuntimeConfig(session);
      // A processed watermark without a provider thread is not context. Replay the
      // durable task ledger so execution receives the accepted brainstorm verbatim.
      if (!session?.providerThreadId || recovery?.freshContext) sinceSeq = 0;
      // Dropping a provider thread is never free: the next turn replays the whole
      // task ledger into a brand-new top-level session and pays a fresh prompt
      // cache. So this is the only place allowed to drop one, every reason is
      // named, and each drop is logged and counted. Anything not listed resumes.
      const isolateMemory = await this.memoryIsolated(conversation, agent);
      const groupContext = await this.groupContext(conversation,agent);
      const discardReason=
        groupContextNeedsReset(groupContext,session) ? "group-context-filtered" :
        session?.providerThreadId && (session.memoryIsolated === true) !== isolateMemory ? "memory-isolation-changed" :
        session?.providerThreadId && isolateMemory && session.memoryIsolated === undefined ? "memory-isolation-unverified" :
        // Tool registration is part of a provider thread. Rebuild once when the
        // shared child-task channel contract changes so every adapter sees it.
        this.deps.knowledge && session?.providerThreadId && session.knowledgeToolsVersion !== KNOWLEDGE_TOOLS_VERSION ? "knowledge-tool-channel-version" :
        parallelTools && session?.providerThreadId && session.parallelToolsVersion !== PARALLEL_TOOLS_VERSION ? "child-task-channel-version" :
        undefined;
      if (discardReason) {
        if (session?.providerThreadId) await this.deps.log("provider-thread-discarded", {
          conversation: conversation.conversationId, agent: agent.userId, reason: discardReason,
          generation: (session.providerThreadGeneration ?? 1) + 1
        });
        session = null;
        sinceSeq = 0;
      }
      const resumingThread=Boolean(session?.providerThreadId && !recovery?.freshContext);
      const memorySince = resumingThread ? session!.memorySyncedAt : undefined;
      const resolution = await this.deps.resolveWorkspace(conversation);
      const contextAt = new Date().toISOString();
      const turnId = newId("message");
      const namingRequested = conversation.autoTitle && (conversation.type === "DIRECT" || conversation.members.some(member => member.userId === agent.userId && member.role === "LEADER"));
      const { prompt: conversationPrompt, app: conversationApp, dialogue, contextMessages, upToSeq, protocol: conversationProtocol, deliveredState } = await this.buildPrompt(
        // Answering @ is an ordinary turn, not a discussion step, even while a discussion runs.
        // Doing its own work a Leader is a worker: the coordination rules stay in the coordination thread.
        ownWork ? {...conversation,members:conversation.members.map(item=>item.userId===agent.userId ? {...item,role:"ENGINEER" as const} : item)}
          : directedTurn ? {...conversation,brainstorm:undefined} : conversation,
        agent,
        resolution,
        sinceSeq,
        memorySince,
        resumingThread ? session?.deliveredState : undefined
      );
      const basePrompt = recovery && !isContextOverflow(recovery.error) ? p(`${conversationPrompt}\n\n连接恢复第 ${recovery.attempts} 次。上一轮因连接中断未完成，不代表会话无工作。${recovery.freshContext ? "当前是新会话，以上已重放任务上下文。" : "继续原会话。"}先核对当前分工和已有产物、上轮操作记录，再继续未完成部分；不要盲目重做可能已经生效的操作，不扩大权限、不重复被拒绝的操作。由你在正常回复中说明恢复后的实际进展。`, `${conversationPrompt}\n\nConnection recovery #${recovery.attempts}. The last turn didn't finish because the connection dropped; that doesn't mean the conversation has no work. ${recovery.freshContext ? "This is a new session; the task context has been replayed above." : "Continuing the original session."} First check the current assignment, existing outputs and the previous turn's operation record, then continue what's unfinished. Don't blindly redo operations that may already have taken effect, don't widen permissions, and don't repeat operations that were denied. Explain the actual progress after recovery in your normal reply.`) : conversationPrompt;
      const baseApp = recovery && !isContextOverflow(recovery.error) ? p(`${conversationApp}\n\n连接恢复第 ${recovery.attempts} 次。上一轮因连接中断未完成，不代表会话无工作。${recovery.freshContext ? "当前是新会话，以上已重放任务上下文。" : "继续原会话。"}先核对当前分工和已有产物、上轮操作记录，再继续未完成部分；不要盲目重做可能已经生效的操作，不扩大权限、不重复被拒绝的操作。由你在正常回复中说明恢复后的实际进展。`, `${conversationApp}\n\nConnection recovery #${recovery.attempts}. The last turn didn't finish because the connection dropped; that doesn't mean the conversation has no work. ${recovery.freshContext ? "This is a new session; the task context has been replayed above." : "Continuing the original session."} First check the current assignment, existing outputs and the previous turn's operation record, then continue what's unfinished. Don't blindly redo operations that may already have taken effect, don't widen permissions, and don't repeat operations that were denied. Explain the actual progress after recovery in your normal reply.`) : conversationApp;
      const environment=p(`本机工作目录：${resolution.workspacePath}；用户主目录：${os.homedir()}。用户提到桌面、下载等目录时，先在用户指定的位置定向检查，不从根目录递归搜索。目录位置不代表额外授权，仍遵守任务范围和审批。`, `Local working directory: ${resolution.workspacePath}; user home directory: ${os.homedir()}. When the user mentions Desktop, Downloads or similar folders, check the location they named directly; don't search recursively from the root. A directory's location doesn't grant extra permission; the task scope and approvals still apply.`);
      const methodPrompt=p("方法选择：先核对当前可用工具与技能。方法不确定、首次使用或结果有内容/视觉质量风险时，先用最小样本确认再批量；内容明确且可精确复核的机械操作直接一次批量执行并在末尾校验，不为走流程额外拆成样本和批次。发现缺陷先定位根因再修正，持续修正直到达到要求。已有可用产物的返修必须先写到独立候选路径，对照检查通过后再原子替换；不得先覆盖唯一可用版本再搜索恢复源。复用本轮开始前已有的产物时，必须证明其来源和输入版本适用于当前任务，并在最终回复明确标为复用；不能把旧产物说成本轮新制作或用其耗时冒充本轮制作速度。无法证明来源时只把它当候选，重新核对或制作。原始内容被遮挡、覆盖或缺失且没有可证明的恢复来源时，不从相似位置移字拼贴，不推测或生成补齐；保留歧义证据并明确报告无法可靠恢复。不得自行降低内容、形式或质量标准，也不把替代方法当作等效完成；最终仍有无法满足之处时在回复中如实说明。不额外求解、重建或美化用户只要求整理的内容。", "Choosing a method: first check the tools and skills currently available. When the method is uncertain, used for the first time, or the result carries content or visual quality risk, confirm on the smallest sample before batching; mechanical operations with clear content that can be checked exactly run in one batch with a check at the end, without splitting into samples and batches just for procedure. When you find a defect, locate the root cause before fixing it, and keep fixing until the requirement is met. Rework on an output that already works must first be written to a separate candidate path and only atomically replace the original after a side-by-side check passes; never overwrite the only working version and then go looking for a way to restore it. When reusing an output that existed before this turn started, you must show that its source and input version fit the current task, and clearly mark it as reused in the final reply; don't present an old output as newly made this turn or use its time to inflate this turn's speed. If its source can't be shown, treat it only as a candidate and re-check or remake it. When original content is covered, overwritten or missing and there's no provable source to restore it from, don't move and patch text from similar places, and don't guess or generate the missing parts; keep the evidence of the ambiguity and clearly report that it can't be reliably restored. Don't lower the content, form or quality bar on your own, and don't treat a substitute method as an equivalent completion; if something still can't be met in the end, say so honestly in the reply. Don't additionally solve, rebuild or polish content that the user only asked to organize.");
      const leaderPrompt=leaderCoordinator ? p("当前是Leader协调/验收回合，不是隐形执行通道：只读检查交付证据、判断方法并用plan/review/interrupt更新队列，不直接修改任务文件。若替代路线还需更长验证，把验证登记成由合适成员（包括你自己）承担的最小工作项，写清产物和验收标准，让它进入可检查的正式工作通道。不要在协调回合反复探测环境或实现新方案。", "This is a Leader coordination/acceptance turn, not a hidden execution lane: inspect delivery evidence read-only, judge the method and update the queue with plan/review/interrupt, without modifying task files directly. If an alternative route needs longer verification, register that verification as the smallest work item owned by a suitable member (possibly yourself), with the output and acceptance criteria written down, so it goes through a formal, checkable work lane. Don't keep probing the environment or implementing new approaches in a coordination turn.") : "";
      const parallelPrompt=parallelTools ? p("子任务并行规则：开工先建立输入清单并选择执行形态，不要先逐项处理完所有输入再决定。短小同质工作若能由父会话一次本地工具调用、确定性脚本或本地批处理覆盖，立即合并执行；有至少 2 项各自包含明显模型推理、生成、外部工具等待或多步处理，且输出独立、没有真实依赖时，立即一次调用 ading_parallel 批量分派。速度优先，但子任务是完整模型上下文，不为几秒小事增加上下文。\n阿钉已为当前工作准备好顶层厂商会话，不要自行另开。当前会话已开放统一的 ading_parallel 子任务通道，最多同时运行 10 项。需要拆分时，把所有无依赖的实质工作一次批量分派。系统已经给出工作目录，除非实际操作报错，不要额外探测它是否存在、可写或当前路径。子通道不会复制父会话完整记录，因此 sharedInstruction 必须精简但完整地包含共同授权范围、输入、方法和验收标准，各 job 只写本项差异。厂商原生子 Agent、Task 或并行工具也可使用；两类子上下文都属于当前任务，不建立新的顶层聊天。若用户要求全部、每个、完整覆盖或按可见标记筛选，分派前先查看原始输入总览，建立包含对象编号、来源位置和入选证据的紧凑清单，再让每个清单项对应一个 job；不要靠求解内容猜测入选对象。若清单成员需要从图片、文档、代码或其他内容中推断，而不是用户明确列出了对象编号，批次中必须增加一个只读 coverage-audit job：它独立核对原始总览并只返回漏项、多选和证据，与生产 job 并发，父会话在最终答复前对照审计结果，只补做确认遗漏的项。批次结束后再把原始总览、清单、coverage-audit 和实际产物逐项对照，文件数量与子任务自报完成不能证明无遗漏。每项使用独立临时路径和互不冲突的最终输出。需要样本且样本通过后其余项可沿用同一方法时，把样本 job 与其余 dependsOn 样本的 jobs 一次提交成依赖图；不要由父会话串行做完样本后才回来分派，系统会在样本完成后立即启动后续项。不依赖样本结论的读取、裁切、清单和 coverage-audit 应立即并发。不要重复已分给群聊其他成员的工作；已有结果先检查，不重新生成。发现缺陷只返修失败项；返修必须先写独立候选并通过对照验收，之后才原子替换正式产物，不能覆盖唯一可用版本后再搜索恢复。发现缺陷先定位根因再修正，直到达到要求。", "Subtask parallelism rules: when you start, first build an input list and choose how to execute; don't process every input one by one before deciding. If short, homogeneous work can be covered by one local tool call, a deterministic script or local batch processing in the parent session, merge it and run it right away; when there are at least 2 items that each involve real model reasoning, generation, waiting on external tools or multi-step processing, with independent outputs and no real dependencies, dispatch them all at once with a single ading_parallel call. Speed comes first, but a subtask is a full model context, so don't add one for something that takes a few seconds.\nADing has prepared the top-level vendor session for this work; don't open another one yourself. This session has the unified ading_parallel subtask lane open, with at most 10 items running at once. When you split work, dispatch all substantive work without dependencies in one batch. The system has already given the working directory; unless an actual operation fails, don't probe whether it exists, is writable or what the current path is. Sub-lanes don't copy the parent session's full record, so sharedInstruction must be concise but complete, including the shared scope of authorization, inputs, method and acceptance criteria; each job only states what differs for that item. The vendor's native sub-agents, Task or parallel tools may also be used; both kinds of sub-context belong to the current task and don't start a new top-level chat. If the user asks for all, every, complete coverage, or selection by a visible marker, first look at an overview of the original input before dispatching, build a compact list with each object's id, source location and the evidence for including it, and map each list item to one job; don't guess which objects are included by solving the content. If list membership has to be inferred from images, documents, code or other content rather than object ids the user listed explicitly, the batch must add a read-only coverage-audit job: it independently checks the original overview and returns only omissions, extra selections and evidence, running in parallel with the production jobs, and the parent session compares against the audit before the final reply and only redoes items confirmed missing. After the batch, compare the original overview, the list, the coverage-audit and the actual outputs item by item; file counts and subtasks' self-reported completion don't prove nothing was missed. Each item uses its own temporary path and a final output that doesn't conflict with others. When a sample is needed and the remaining items can reuse the same method once the sample passes, submit the sample job and the remaining jobs that dependsOn it as one dependency graph; don't have the parent session finish the sample serially and then come back to dispatch — the system starts the follow-up items as soon as the sample finishes. Reading, cropping, listing and coverage-audit that don't depend on the sample's conclusion should run in parallel right away. Don't repeat work already assigned to other members of the group chat; check existing results first instead of regenerating them. When you find defects, rework only the failed items; rework must first be written to a separate candidate and pass a side-by-side acceptance check before atomically replacing the official output — never overwrite the only working version and then look for a way to restore it. When you find a defect, locate the root cause before fixing it, until the requirement is met.") : "";
      // Method, coordinator, child-task and collaboration rules are thousands of
      // tokens that never change between turns, while the provider thread keeps
      // every turn ever sent. Deliver them once per thread and re-send only when
      // they actually differ — a role, mode or tool-channel change alters the text
      // and therefore the digest, so a stale protocol can never be skipped.
      const directedPrompt = directedTurn ? p("本条是真人通过 @ 指定成员的定向消息，只由被提及的 Agent 正常回复。不要启动群讨论、分配任务或要求未被提及的 Agent 回复；直接回答本条请求，不输出团队调度控制块。", "This is a directed message from a person using @ to select members. Only the mentioned Agents should reply normally. Do not start a group discussion, assign work, or ask unmentioned Agents to reply. Answer this request directly without team scheduling control blocks.") : "";
      // Per section, because which sections apply changes between a thread's turns. @ only concerns this turn, so it always goes out.
      const sections=[methodPrompt,leaderPrompt,parallelPrompt,conversationProtocol].filter((section):section is string=>!!section);
      const sectionDigest=(section:string)=>createHash("sha256").update(section).digest("hex").slice(0,16);
      const deliveredSections=new Set(resumingThread ? session?.protocolDigests ?? [] : []);
      const newSections=sections.filter(section=>!deliveredSections.has(sectionDigest(section)));
      const protocol=[...newSections,directedPrompt].filter(Boolean).join("\n\n");
      const repeatProtocol=newSections.length<sections.length;
      const protocolDigests=[...new Set([...deliveredSections,...sections.map(sectionDigest)])].slice(-16);
      const prompt=[environment,basePrompt,repeatProtocol ? p("方法要求、协作规则和控制块格式已经在本会话前面给出，仍然完全有效，本轮不再重复；这里只有本轮变化的部分。", "The method requirements, collaboration rules and control block format were given earlier in this session and remain fully in effect; they aren't repeated this turn. Only what changed this turn is here.") : "",protocol].filter(Boolean).join("\n\n");
      const app=[environment,baseApp,repeatProtocol ? p("方法要求、协作规则和控制块格式已经在本会话前面给出，仍然完全有效，本轮不再重复；这里只有本轮变化的部分。", "The method requirements, collaboration rules and control block format were given earlier in this session and remain fully in effect; they aren't repeated this turn. Only what changed this turn is here.") : "",protocol].filter(Boolean).join("\n\n");
      // Everything ADing generates goes to app; only chat content stays in this turn's input
      const split={app,dialogue};

      await this.deps.log("turn-start", {
        conversation: conversation.conversationId,
        agent: agent.displayName,
        kind: discovered.kind,
        workspacePath: resolution.workspacePath,
        resuming: resumingThread,
        providerThreadGeneration: session?.providerThreadGeneration ?? 1,
        topLevelProviderSessions:parallelTools ? 1 : undefined,
        childTaskLimit:parallelTools ? 10 : undefined,
        parallelism:parallelTools ? "shared-subtasks" : undefined
      });

      const written = await bestEffortSync(()=>this.deps.syncer.ensureSynced(resolution, [discovered.kind]),[]);
      await this.deps.log("context-ready", {turnId, conversation:conversation.conversationId, agent:agent.userId, upToSeq, promptHash:createHash("sha256").update(prompt).digest("hex"), written, sharesKnowledge:resolution.sharesKnowledge});

      if (!this.engagedConversations.has(conversation.conversationId) || !(await lease.valid())) return;
      const workPlanAtStart = structuredClone(conversation.workPlan ?? []);
      const discussionOnly = conversation.type === "GROUP" && !(await this.soloAgent(conversation)) && !conversation.members.some(member => member.userId === agent.userId && member.role === "LEADER") && myAssignment?.phase !== "accepted";
      // A review assignment constrains the work, not the available tool set.
      // Execution requests still go through the owner's global approval policy.
      const fullAccess = !discussionOnly && !leaderCoordinator;
      const permissionMode=await this.deps.getPermissionMode?.();
      const fastApproval=fullAccess&&permissionMode==="unattended";
      await this.deps.log("permission-profile",{turnId,conversation:conversation.conversationId,agent:agent.userId,discussionOnly,fullAccess,sourceReadOnly:!!myAssignment?.readOnly,permissionMode,fastApproval,approvalHost:!discussionOnly && !fastApproval && !!this.deps.requestPermission});
      // During the second or two of preparing context the Agent may start rechecking: record it and run after the check rather than treating it as a failure
      if (!this.deps.isAgentReady(agent)) {
        await this.waitForAgentCheck(conversation.conversationId, agent, "start", upToSeq);
        return;
      }
      const providerStartedAt = Date.now();
      let outcome: AgentTurnOutcome;
      let runtimeConfig:AgentRuntimeConfig|undefined = sessionRuntimeConfig(session)??priorRuntimeConfig;
      const activeKey=this.directionKey(conversation.conversationId,agent.userId);
      const activeInput:ActiveTurnInput={upToSeq,steeredThrough:upToSeq,steers:[],steerChain:Promise.resolve(),groupContext};
      this.activeTurnInputs.set(activeKey,activeInput);
      try {
      outcome = await this.deps.registry.runTurn(discovered, {
        ...this.knowledgeInput(conversation,agent,resolution),
        steerable:true,
        preserveReplyText:conversation.type === "DIRECT",
        permissionMode,
        parallelWork:parallelTools ? {key:`${conversation.conversationId}:${agent.userId}`,limit:10,executionSlot:!!this.deps.workAssignmentId,allowSplit:true,planBeforeExecution:false,sessionBudget:11} : undefined,
        canStartWork:()=>this.deps.isAgentReady(agent),
        onWorkFailure:error=>this.deps.onAgentFailure?.(agent,error) ?? Promise.resolve(),
        discussionOnly,
        // No time limit for assignment proposals and Leader coordination (user decision); hangs are handled by the process-level no-output fallback
        timeoutMs: undefined,
        onPermission: !discussionOnly && !fastApproval && this.deps.requestPermission ? async request => {
          if (!(await lease.valid())) return false;
          let announced=false;
          const announceTimer=setTimeout(()=>{
            announced=true;
            if(!request.signal.aborted&&!lease.signal.aborted)this.emitProgress(conversation.conversationId,agent.userId,p(`等待权限确认：${request.toolName}`, `Waiting for permission: ${request.toolName}`));
          },400);
          announceTimer.unref?.();
          await this.deps.log("permission-requested",{turnId,conversation:conversation.conversationId,agent:agent.userId,requestId:request.requestId,tool:request.toolName});
          let allowed: boolean;
          try { allowed = await this.deps.requestPermission!(conversation,agent,request); }
          finally { clearTimeout(announceTimer); }
          const valid = !request.signal.aborted && await lease.valid();
          await this.deps.log("permission-resolved",{turnId,conversation:conversation.conversationId,agent:agent.userId,requestId:request.requestId,allowed:valid && allowed});
          if (valid && (!allowed||announced)) this.emitProgress(conversation.conversationId,agent.userId,allowed ? p("权限已确认，继续当前操作", "Permission granted; continuing the current operation") : p("操作未获授权，正在报告受阻", "Operation not authorized; reporting it as blocked"));
          return valid && allowed;
        } : undefined,
        signal: lease.signal,
        contextMessages:contextMessages ? await Promise.all(contextMessages.map(text=>this.addressOwner(conversation,text))) : undefined,
        prompt:await this.addressOwner(conversation,prompt),split:await this.addressOwnerSplit(conversation,split),
        threadId: recovery?.freshContext ? undefined : session?.providerThreadId,
        workspacePath: resolution.workspacePath,
        fullAccess,
        isolateMemory: await this.memoryIsolated(conversation,agent),
        runtimeConfig,
        appRuntimeConfig:agent.modelConfig,
        onRuntimeConfig: snapshot => { runtimeConfig=snapshot; },
        onAudit: event => {
          void this.deps.log("tool-event", {turnId,conversation:conversation.conversationId,agent:agent.userId,...event});
        },
        onProgress: (text) => {
          if (!lease.signal.aborted) {
            this.emitProgress(conversation.conversationId, agent.userId, text);
            // Audit stores only a digest fingerprint; command arguments and user content aren't copied into the diagnostics log.
            void this.deps.log("turn-progress", {turnId,conversation:conversation.conversationId,agent:agent.userId,category:text.split("：")[0],digest:createHash("sha256").update(text).digest("hex").slice(0,16)});
          }
        }
      });
      } finally {
        if(this.activeTurnInputs.get(activeKey)===activeInput)this.activeTurnInputs.delete(activeKey);
      }
      const inputSeq=this.steerHandledThrough(activeInput,outcome);

      if (!(await lease.valid())) return;
      // Model configuration and execution capacity both await after the start check.
      // Verification can begin in that gap; no provider work happened, so keep the
      // unread messages pending. Recheck immediately in case verification already
      // finished and its resume callback ran before we recorded the deferral.
      if (!outcome.ok && !outcome.cancelled && outcome.notStarted === "agent-unavailable") {
        await this.waitForAgentCheck(conversation.conversationId, agent, "execution", inputSeq, true);
        return;
      }
      if (outcome.threadId) {
        await this.deps.store.saveAgentSession({
          conversationId: conversation.conversationId,
          agentUserId: sessionKey,
          providerThreadId: outcome.threadId,
          recovery: outcome.ok ? undefined : recovery,
          groupContext,
          workspacePath: resolution.workspacePath,
          parallelTools,
          protocolDigests:outcome.ok ? protocolDigests : session?.protocolDigests,
          deliveredState:outcome.ok ? deliveredState ?? session?.deliveredState : session?.deliveredState,
          tokenUsageTotal:outcome.metrics.tokenUsage ?? (outcome.threadId===session?.providerThreadId ? session?.tokenUsageTotal : undefined),
          // Always record the contract, so a turn without a child-task channel
          // cannot look like a session written before the field existed.
          parallelToolsVersion:PARALLEL_TOOLS_VERSION,
          knowledgeToolsVersion:this.deps.knowledge ? KNOWLEDGE_TOOLS_VERSION : session?.knowledgeToolsVersion,
          providerThreadGeneration:outcome.threadId===session?.providerThreadId
            ? session?.providerThreadGeneration ?? 1
            : (session?.providerThreadGeneration ?? 0)+1,
          runtimeConfig,
          messageSyncedSeq:inputSeq,
          memoryIsolated: isolateMemory,
          memorySyncedAt: outcome.ok ? contextAt : session?.memorySyncedAt
        });
      }
      // Stopping may coincide with the underlying process returning. Content that comes back after pausing must be discarded,
      // and the read watermark must not advance, so this unfinished batch is pushed again when the user continues the task.
      const currentConversation = await this.deps.store.getConversation(conversation.conversationId);
      const currentMember = currentConversation?.members.find(
        (item) => item.userId === agent.userId
      );
      if (
        !currentConversation ||
        currentConversation.paused ||
        currentConversation.status !== "ACTIVE" ||
        currentMember?.paused
      ) {
        await this.deps.log("turn-discarded-after-pause", {
          conversation: conversation.conversationId,
          agent: agent.displayName,
          ok: outcome.ok
        });
        return;
      }
      await this.deps.log("turn-done", {
        turnId,
        durationMs: Date.now() - providerStartedAt,
        phase: myAssignment?.phase === "proposal" ? "negotiation" : myAssignment?.phase === "accepted" ? "execution" : discussionOnly ? "discussion" : "coordination",
        promptChars: prompt.length,
        conversation: conversation.conversationId,
        agent: agent.displayName,
        ok: outcome.ok,
        cancelled: !outcome.ok && outcome.cancelled,
        error: outcome.ok ? undefined : outcome.error.slice(0, 500),
        iterations: outcome.metrics.iterations,
        sideEffects: outcome.metrics.sideEffects,
        tokenUsage: this.deps.registry.adapterFor?.(discovered.kind)?.cumulativeTokenUsage
          ? turnUsageSince(outcome.metrics.tokenUsage, outcome.threadId===session?.providerThreadId ? session?.tokenUsageTotal : undefined)
          : outcome.metrics.tokenUsage,
        providerCredits: outcome.metrics.providerCredits,
        contextUsagePeak: outcome.metrics.contextUsagePeak,
        steps: outcome.steps.slice(-6)
      });

      if (outcome.ok) {
        if (!(await lease.valid())) return;
        this.settleSteerFallback(conversation.conversationId,agent.userId,inputSeq);
        // Always strip the tag: it's metadata for the UI and shouldn't appear in the conversation.
        // Only adopt the name inside when this turn is actually waiting for naming.
        const parsedTitle = parseConversationTitle(outcome.message);
        const named = namingRequested ? parsedTitle : { visible: parsedTitle.visible };
        let trimmed = named.visible.trim();
        const saveTitle = async () => {
          if (!named.title) return;
          try {
            const fresh = await this.deps.store.getConversation(conversation.conversationId);
            if (fresh?.autoTitle) await this.deps.store.updateConversation(conversation.conversationId, { name: named.title, autoTitle: false });
          } catch (error) { await this.deps.log("conversation-title-save-failed", { conversation: conversation.conversationId, error: String(error) }); }
        };
        if (myAssignment?.phase === "proposal" && !directedTurn) {
          const current = await this.assignmentFor(conversation.conversationId,agent.userId);
          if (current?.id !== myAssignment.id || current.phase !== "proposal") {
            if (trimmed) await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,type:"TASK",content:trimmed,agentReply:{turnId,inputSeq,raw:outcome.message,newerInput:true}});
            await this.deps.store.markProcessed(conversation.conversationId,agent.userId,inputSeq);
            return;
          }
          const response = interpretProposalReply(trimmed,myAssignment.id);
          if (response.action === "clarify") await this.recoverProposal(currentConversation,agent,myAssignment,context,trimmed);
          else await this.recordProposalReply(currentConversation,agent,current,response.action,response.visible,response.source,context);
          await this.deps.store.markProcessed(conversation.conversationId,agent.userId,inputSeq);
          return;
        }
        const myRole = conversation.members.find(
          (item) => item.userId === agent.userId
        )?.role;
        // Only work received at the start of this turn can be submitted; newly created assignments must not be mislabeled as results.
        const completedWork = myAssignment?.phase === "accepted" ? myAssignment : undefined;
        const receipt = parseLeaderControl(trimmed);
        if (myAssignment?.phase === "accepted" && receipt.control?.action === "blocked" && receipt.control.assignmentId === myAssignment.id) {
          const reply = await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,type:"TASK",content:receipt.visible || receipt.control.reason!,steps:outcome.steps,agentReply:{turnId,inputSeq,raw:outcome.message,newerInput:false},mentions:conversation.members.filter(m=>m.role==="LEADER" && m.userId!==agent.userId).map(m=>m.userId),coordination:{...myAssignment,phase:"rejected"}});
          await this.planner.transition(conversation.conversationId,myAssignment,"blocked");
          await this.deps.store.markProcessed(conversation.conversationId,agent.userId,inputSeq);
          await this.dispatch(currentConversation,reply,context);
          return;
        }
        if (completedWork && this.deps.validateWorkOutputs) {
          const work=currentConversation.workPlan?.find(w=>w.assignmentId===completedWork.id);
          const missing=work ? await this.deps.validateWorkOutputs(work,resolution.workspacePath) : [];
          if (missing.length) {
            await this.planner.transition(conversation.conversationId,completedWork,"blocked");
            const rejected=await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,type:"TASK",
              content:p(`工作 ${completedWork.workId} 交付不完整，缺少声明产物：${missing.join("、")}。本项未完成，其他工作成果不能替代。执行者报告：${trimmed}`, `Work ${completedWork.workId} was delivered incomplete; declared outputs are missing: ${missing.join(", ")}. This item isn't done, and results of other work can't substitute for it. Executor's report: ${trimmed}`),
              coordination:{...completedWork,phase:"rejected"},mentions:conversation.members.filter(m=>m.role==="LEADER").map(m=>m.userId),
              agentReply:{turnId,inputSeq,raw:outcome.message,newerInput:false}});
            await this.deps.store.markProcessed(conversation.conversationId,agent.userId,inputSeq);
            await this.dispatch(currentConversation,rejected,context);
            return;
          }
        }
        const newMessages = await this.deps.store.listMessages(conversation.conversationId,{afterSeq:inputSeq,limit:1000});
        const newer = newMessages.filter(m=>m.type!=="SYSTEM" && !m.internal && (!this.deps.workAssignmentId || (m.type === "USER" && !m.agentReply && m.senderId === conversation.owner)) && (m.senderId!==agent.userId || m.agentReply?.lane === "inbox") && !m.report && !m.failed && (!m.coordination || ["result","revision","rejected"].includes(m.coordination.phase)));
        // Save the complete reply before applying any control or advancing the input watermark.
        // New peer/user messages may invalidate a plan, never the author's actual words or results.
        let savedReply: Message | undefined;
        let savedReplySource: string | undefined;
        if (conversation.type === "GROUP" && myRole === "LEADER" && !completedWork && !directedTurn && trimmed && !/^skip[.!]?$/i.test(trimmed)) {
          const content = receipt.visible || p(`Leader 提交${receipt.control?.action === "review" ? "复核结论" : "任务安排"}：${receipt.control?.evidence || receipt.control?.reason || receipt.control?.action || trimmed}`, `Leader submitted ${receipt.control?.action === "review" ? "a review verdict" : "a task arrangement"}: ${receipt.control?.evidence || receipt.control?.reason || receipt.control?.action || trimmed}`);
          savedReplySource = content;
          savedReply = await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,content,internal:!!receipt.control && !receipt.visible,steps:outcome.steps,agentReply:{turnId,inputSeq,raw:outcome.message,newerInput:newer.length>0}});
        }
        if (savedReply) await saveTitle();
        const catchUp = conversation.type === "GROUP" && myRole === "LEADER" && newer.length>0;
        // A peer delivery need not invalidate an independent plan. Human instructions and
        // unresolved discussion still require a fresh decision; item versions are checked on write.
        const independentResults = newer.length > 0 && newer.every(m => m.coordination?.phase === "result");
        const incremental = ["plan", "batch"].includes(receipt.control?.action ?? "");
        const deferControl = catchUp && receipt.control && receipt.control.action !== "review" && !(incremental && independentResults);
        if (conversation.type === "GROUP") {
          if (deferControl) {
            await this.deps.store.appendMessage({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:agent.userId,type:"SYSTEM",content:p("上条回复已保留。生成期间收到新消息，其中任务安排暂未执行，Leader 将结合最新内容重新确认。", "The previous reply was kept. New messages arrived while it was being generated, so the task arrangement in it hasn't been carried out yet; the Leader will reconfirm based on the latest content.")});
          } else if (!directedTurn) trimmed = await this.applyLeaderControl(
            currentConversation,
            agent,
            trimmed,
            context,
            !!savedReply,
            workPlanAtStart,
            () => lease.valid()
          );
        }
        if (catchUp) {
          await this.deps.log("reply-retained-with-new-context",{conversation:conversation.conversationId,agent:agent.userId,turnId,inputSeq,newestSeq:newer.at(-1)!.seq});
          const fresh = await this.deps.store.getConversation(conversation.conversationId);
          if (fresh && !fresh.paused) this.rememberPending(fresh,agent,context,newer.at(-1)!.seq,true);
        }
        if (savedReply) {
          if (receipt.control && !deferControl && trimmed && receipt.control.action!=="stop" && (savedReply.internal || trimmed!==savedReplySource)) {
            savedReply=await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId+":applied",senderId:agent.userId,content:trimmed});
          }
          await this.deps.store.markProcessed(conversation.conversationId,agent.userId,inputSeq);
          const fresh = await this.deps.store.getConversation(conversation.conversationId);
          if (fresh && !savedReply.internal) await this.dispatch(fresh,savedReply,context);
          await this.fillWork(conversation.conversationId);
          if (resolution.sharesKnowledge && await lease.valid()) await this.deps.afterTurn?.({conversation,agent,resolution,evidenceFromSeq:sinceSeq+1,evidenceToSeq:savedReply.seq,steps:outcome.steps,metrics:outcome.metrics}).catch(error=>this.deps.log("knowledge-capture-failed",{conversation:conversation.conversationId,agent:agent.userId,error:String(error)}));
          return;
        }
        if (!trimmed || (conversation.type === "GROUP" && /^skip[.!]?$/i.test(trimmed))) {
          if (myAssignment?.phase === "accepted") {
            await this.planner.transition(conversation.conversationId,myAssignment,"blocked");
            const missing = await this.deps.store.appendMessage({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:agent.userId,type:"TASK",content:p("已接单但未提交结果或受阻说明，请 Leader 跟进。", "The work was accepted but no result or blocker note was submitted. Leader, please follow up."),mentions:conversation.members.filter(m=>m.role==="LEADER" && m.userId!==agent.userId).map(m=>m.userId),coordination:{...myAssignment,phase:"rejected"}});
            await this.dispatch(currentConversation,missing,context);
          }
          if (await lease.valid()) this.emitProgress(conversation.conversationId, agent.userId, p("本轮已结束，没有新发言", "This turn ended with nothing new to say"));
          await this.deps.store.markProcessed(conversation.conversationId,agent.userId,inputSeq);
          return;
        }
        if (!(await lease.valid())) return;

        const finishedAssignment = conversation.type === "GROUP" ? completedWork ?? (myRole !== "LEADER" ? await this.assignmentFor(conversation.conversationId, agent.userId) : undefined) : undefined;
        const coordination: Message["coordination"] = finishedAssignment?.phase === "accepted" ? { ...finishedAssignment, phase: "result" } : undefined;
        const reply = await this.persistAgentReply({
          coordination,
          type: coordination ? "TASK" : "USER",
          mentions: coordination ? conversation.members.filter(member => member.role === "LEADER").map(member => member.userId) : undefined,
          conversationId: conversation.conversationId,
          clientMessageId: turnId,
          senderId: agent.userId,
          content: trimmed,
          agentReply:{turnId,inputSeq,raw:outcome.message,newerInput:newer.length>0},
          steps: outcome.steps
        });
        await saveTitle();
        if (completedWork) await this.planner.transition(conversation.conversationId,completedWork,"result");
        await this.deps.store.markProcessed(conversation.conversationId,agent.userId,inputSeq);
        this.emitProgress(conversation.conversationId, agent.userId, p("消息已发出", "Message sent"));

        const latestConversation = await this.deps.store.getConversation(conversation.conversationId);
        if (latestConversation?.type === "GROUP") {
          await this.dispatch(latestConversation, reply, context);
        }

        await this.fillWork(conversation.conversationId);
        if (!resolution.sharesKnowledge || !(await lease.valid())) return;
        await this.deps.afterTurn?.({
          conversation,
          agent,
          resolution,
          evidenceFromSeq: sinceSeq + 1,
          evidenceToSeq: reply.seq,
          steps: outcome.steps,
          metrics: outcome.metrics
        }).catch(error => this.deps.log("knowledge-capture-failed", {conversation:conversation.conversationId,agent:agent.userId,error:String(error)}));
        return;
      }

      // A user stop cancels the run AND invalidates the lease, so this branch has to come
      // before the lease gate: behind it, stopping a task left no trace at all — no turn-done,
      // no log line, and no message in the feed, so the UI looked like nothing had happened.
      if (outcome.cancelled) {
        await this.deps.log("turn-stopped", {turnId,conversation:conversation.conversationId,agent:agent.displayName,steps:outcome.steps?.length ?? 0});
        await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,type:"SYSTEM",failed:true,
          content:p("本轮执行已停止，任务尚未完成。已有文件已保留，可继续原任务核对并完成剩余工作。", "This turn was stopped and the task isn't finished. Existing files are kept; you can continue the task to check them and finish the remaining work."),steps:outcome.steps});
        return;
      }
      if (!(await lease.valid())) return;
      // Both the raw failure text and the "no permission" scene go into the logs: previously there was only one error line in the UI, and reports couldn't be traced.
      await this.deps.log("agent-turn-failed",{turnId,conversation:conversation.conversationId,agent:agent.userId,kind:agent.kind,error:outputTail(outcome.error,1500)});
      for (const denied of deniedPaths(outcome.error).slice(0,3)) {
        await this.deps.log("agent-turn-denied-path",{turnId,conversation:conversation.conversationId,agent:agent.userId,kind:agent.kind,...(await probeDeniedPath(denied).catch(error=>({path:denied,probeError:String(error)})))});
      }
      if (outcome.partialMessage?.trim()) {
        await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:turnId,senderId:agent.userId,type:"USER",content:outcome.partialMessage,steps:outcome.steps,agentReply:{turnId,inputSeq,raw:outcome.partialMessage,newerInput:false}});
      }
      const contextOverflow = !outcome.contextBudgetExhausted && isContextOverflow(outcome.error);
      const providerSessionMissing = resumingThread && isProviderSessionMissing(outcome.error);
      if (isConnectionFailure(outcome.error) || contextOverflow || providerSessionMissing) {
        const attempts = (recovery?.attempts ?? 0) + 1;
        // A missing vendor transcript is deterministic: discard it immediately
        // and allow exactly one fresh-session replay instead of retrying the bad id.
        const limit = providerSessionMissing || contextOverflow ? (resumingThread ? 1 : 0) : this.deps.connectionRetryLimit ?? 3;
        const retry = attempts <= limit;
        const state: NonNullable<AgentSessionRef["recovery"]> = {attempts,state:retry ? "retrying" : "blocked",error:outcome.error,freshContext:providerSessionMissing || contextOverflow || attempts>=2};
        const currentSession = await this.deps.store.getAgentSession(conversation.conversationId,sessionKey);
        await this.deps.store.saveAgentSession({...currentSession,conversationId:conversation.conversationId,agentUserId:sessionKey,recovery:state,
          ...(providerSessionMissing ? {providerThreadId:undefined,memorySyncedAt:undefined} : {})});
        if (providerSessionMissing) await this.deps.log("provider-thread-discarded", {
          conversation:conversation.conversationId,agent:agent.userId,reason:"provider-session-missing",
          generation:(session?.providerThreadGeneration ?? 1)+1
        });
        const reason = retry ? (providerSessionMissing
          ? p("原厂商会话已不存在，正在新会话中重放任务上下文后继续。", "The original provider session no longer exists; continuing in a new session after replaying the task context.")
          : contextOverflow ? p(`会话上下文已满，已开新会话并核对已有产物后继续（第 ${attempts} 次）。`, `The session context is full; started a new session, checked existing outputs and continuing (attempt ${attempts}).`)
          : p(`连接中断，正在恢复 ${attempts}/${limit}${state.freshContext ? "，重建会话并核对已有产物" : "，续接原会话"}。`, `Connection dropped; recovering ${attempts}/${limit}${state.freshContext ? ", rebuilding the session and checking existing outputs" : ", resuming the original session"}.`))
          : p(`连接恢复 ${limit} 次后仍失败，当前 Agent 等待重试；任务尚未完成。`, `Connection recovery still failed after ${limit} attempts; this Agent is waiting to retry. The task isn't finished.`);
        if(!contextOverflow) this.emitProgress(conversation.conversationId,agent.userId,reason);
        if(!contextOverflow) await this.deps.store.appendMessage({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:agent.userId,type:"SYSTEM",content:reason,failed:true,steps:[...outcome.steps,outcome.error]});
        await this.deps.log("connection-recovery",{conversation:conversation.conversationId,agent:agent.userId,...state});
        if (retry) {
          await recoveryDelay(this.deps.connectionRetryDelayMs ?? Math.min(1000 * 2 ** (attempts-1),8000),lease.signal);
          if (await lease.valid()) this.rememberPending(currentConversation,agent,context,inputSeq,true);
          return;
        }
        // Exhausted worker connections release their assignment and notify the leader below.
        // A leader connection remains explicitly blocked; business idle retries cannot bypass it.
      }
      await this.deps.onAgentFailure?.(agent, outcome.error);
      const failedAssignment = await this.assignmentFor(conversation.conversationId, agent.userId);
      if (failedAssignment) await this.planner.transition(conversation.conversationId,failedAssignment,"blocked");
      const failureMessage = await this.deps.store.appendMessage({
        coordination: failedAssignment && ["accepted", "proposal"].includes(failedAssignment.phase) ? { ...failedAssignment, phase: "rejected" } : undefined,
        mentions: conversation.members.filter(member => member.role === "LEADER" && member.userId !== agent.userId).map(member => member.userId),
        conversationId: conversation.conversationId,
        clientMessageId: newId("message"),
        senderId: agent.userId,
        content: outcome.error,
        type: "SYSTEM",
        steps: outcome.steps,
        failed: true
      });
      if (conversation.members.find(member => member.userId === agent.userId)?.role !== "LEADER") {
        const fresh = await this.deps.store.getConversation(conversation.conversationId);
        if (fresh) await this.dispatch(fresh, failureMessage, context);
      }
  }

  private async resetBlockedConnections(conversation: Conversation): Promise<void> {
    for (const member of conversation.members) {
      // A Leader doing its own work has two threads; either being blocked stalls the conversation.
      for (const key of new Set([member.userId,await this.turnSessionKey(conversation,member.userId)])) {
        const session = await this.deps.store.getAgentSession(conversation.conversationId,key);
        if (session?.recovery?.state !== "blocked") continue;
        await this.deps.store.saveAgentSession({...session,providerThreadId:undefined,memorySyncedAt:undefined,recovery:undefined});
        // Without a provider context, replay the task history regardless of the read watermark.
      }
    }
  }

  /**
   * Lets the Agent say one more thing on the task's current provider thread, without automatically becoming an ordinary reply.
   * Skill distillation and review use this path.
   */
  async speakInConversation(
    conversation: Conversation,
    agent: UserRef,
    prompt: string
  ): Promise<AgentTurnOutcome> {
    if (this.asleep() && !(await this.untilAwake("speak", conversation.conversationId, agent.userId))) throw new Error(tm("orch.app.exiting"));
    const lease = this.gate.begin(conversation.conversationId, agent.userId);
    try { return await this.speakWithLease(conversation, agent, prompt, lease); }
    finally { lease.close(); }
  }

  /** Before sending to an Agent, replace "主人" (owner) with the conversation initiator's name (nickname) */
  private async addressOwner(conversation: Conversation, prompt: string): Promise<string> {
    return addressOwner(prompt, (await this.deps.store.getUser(conversation.owner))?.displayName);
  }

  /**
   * Gives an auto-named conversation a name.
   *
   * Asked separately rather than mixed into the user-facing reply: previously the prompt asked the Agent to output
   * <task-title>name</task-title>, but vendors' own apps don't recognize this convention and showed that line to the user.
   * Uses the askOnce channel (no tools, session not persisted); on failure keep the original name without affecting the main turn.
   */
  private nameConversation(conversation: Conversation, message: string): Promise<void> {
    return this.track(this.nameConversationNow(conversation, message));
  }

  private async nameConversationNow(conversation: Conversation, message: string): Promise<void> {
    try {
      // Who names it doesn't matter; pick the first available agent member; if none is available, keep the original name.
      // Whichever computer it's on does the naming — the task's first message syncs there, equivalent to typing on that computer.
      // Every client picks the same agent in the same order, so only one computer names a task and the two sides don't each name it.
      // In the offline edition all available agents are local, exactly as before.
      let namer: UserRef | undefined;
      for (const member of conversation.members) {
        const user = await this.deps.store.getUser(member.userId);
        if (user?.isAgent && this.deps.isAgentReady(user)) { namer = user; break; }
      }
      const discovered = namer && this.deps.resolveDiscovered(namer.userId);
      if (!discovered) return;
      const result = await this.deps.registry.askOnce(discovered, conversationNamingAsk(message.slice(0, 2000)));
      const name = result.ok ? cleanConversationName(result.text) : undefined;
      await this.deps.log("conversation-named", { conversation: conversation.conversationId, kind: discovered.kind, ok: result.ok, name, detail: result.ok ? undefined : result.text.slice(0, 200) });
      if (!name) return;
      const fresh = await this.deps.store.getConversation(conversation.conversationId);
      if (fresh?.autoTitle) await this.deps.store.updateConversation(conversation.conversationId, { name, autoTitle: false });
    } catch (error) {
      await this.deps.log("conversation-name-failed", { conversation: conversation.conversationId, error: String(error) });
    }
  }

  /** Both halves of split delivery also need the form of address replaced, or the Agent still sees "主人" (owner) in system instructions */
  private async addressOwnerSplit(
    conversation: Conversation,
    split: { app: string; dialogue: string }
  ): Promise<{ app: string; dialogue: string }> {
    const name = (await this.deps.store.getUser(conversation.owner))?.displayName;
    return { app: addressOwner(split.app, name), dialogue: addressOwner(split.dialogue, name) };
  }

  private async speakWithLease(conversation: Conversation, agent: UserRef, prompt: string, lease: ExecutionLease): Promise<AgentTurnOutcome> {
    if (!(await lease.valid())) return this.unavailableOutcome(p("会话或 Agent 已暂停", "The conversation or Agent is paused"));
    prompt = await this.addressOwner(conversation, prompt);
    if (!this.deps.isAgentReady(agent)) {
      return this.unavailableOutcome(p("Agent 当前未就绪", "The Agent isn't ready yet"));
    }
    const discovered = this.deps.resolveDiscovered(agent.userId);
    if (!discovered) {
      return this.unavailableOutcome(p("本机找不到这个 Agent", "This Agent can't be found on this computer"));
    }

    let session = await this.deps.store.getAgentSession(
      conversation.conversationId,
      agent.userId
    );
    const resolution = await this.deps.resolveWorkspace(conversation);
    const {workspacePath}=resolution;
    let restoredContext="";
    const isolateMemory = await this.memoryIsolated(conversation, agent);
    const isolationChanged = session?.providerThreadId && ((session.memoryIsolated === true) !== isolateMemory || isolateMemory && session.memoryIsolated === undefined);
    if(isolationChanged || this.deps.knowledge&&session?.providerThreadId&&session.knowledgeToolsVersion!==KNOWLEDGE_TOOLS_VERSION) {
      await this.deps.log("provider-thread-discarded",{conversation:conversation.conversationId,agent:agent.userId,reason:isolationChanged?"memory-isolation-changed":"knowledge-tool-channel-version",lane:"report"});
      restoredContext=(await this.buildPrompt(conversation,agent,resolution,0,undefined)).prompt+"\n\n";
      session=null;
    }

    const ownsBusyState = !this.runningTurns.has(agent.userId);
    if (!ownsBusyState && this.runningTurns.get(agent.userId) !== conversation.conversationId) return this.unavailableOutcome(p("Agent 正在处理其他会话", "The Agent is working on another conversation"));
    if (ownsBusyState) this.markBusy(conversation.conversationId, agent.userId, true);
    try {
      if (!(await lease.valid())) return this.unavailableOutcome(p("会话或 Agent 已暂停", "The conversation or Agent is paused"));
      const outcome = await this.deps.registry.runTurn(discovered, {
        ...this.knowledgeInput(conversation,agent,resolution),
        signal: lease.signal,
        prompt: restoredContext+prompt + p("\n本轮仅生成汇报或整理知识，权限仅限本轮。不能从本轮限制推断任务或其他成员权限变化；请按已记录的执行和审批事件报告状态。", "\nThis turn only produces a report or organizes knowledge, and its permissions apply to this turn only. Don't infer changes to the task's or other members' permissions from this turn's limits; report status based on the recorded execution and approval events."),
        threadId: session?.providerThreadId,
        workspacePath,
        fullAccess: false,
        isolateMemory: await this.memoryIsolated(conversation,agent),
        onProgress: (text) => { if (!lease.signal.aborted) this.emitProgress(conversation.conversationId, agent.userId, text); }
      });
      if (!(await lease.valid())) return this.unavailableOutcome(p("会话或 Agent 已暂停", "The conversation or Agent is paused"));
      if (outcome.threadId) {
        await this.deps.store.saveAgentSession({
          conversationId: conversation.conversationId,
          agentUserId: agent.userId,
          providerThreadId: outcome.threadId,
          knowledgeToolsVersion:this.deps.knowledge ? KNOWLEDGE_TOOLS_VERSION : session?.knowledgeToolsVersion,
          // Reports may quote older history; re-evaluate the transcript before
          // treating it as a filtered execution context again.
          groupContext: undefined,
          workspacePath,
          memoryIsolated: isolateMemory
        });
      }
      return outcome;
    } finally {
      if (ownsBusyState) this.markBusy(conversation.conversationId, agent.userId, false);
    }
  }

  private async buildPrompt(
    conversation: Conversation,
    agent: UserRef,
    resolution: WorkspaceResolution,
    sinceSeq: number,
    memorySince: string | undefined,
    delivered?: AgentSessionRef["deliveredState"]
  ): Promise<{ prompt: string; app: string; dialogue: string; contextMessages?: string[]; upToSeq: number; protocol?: string; deliveredState?: AgentSessionRef["deliveredState"] }> {
    const me = await this.deps.store.currentUser();
    const members = await Promise.all(
      conversation.members.map(async (member) => ({
        member,
        session: await this.deps.store.getAgentSession(conversation.conversationId,member.userId),
        user: await this.deps.store.getUser(member.userId)
      }))
    );
    const myRole =
      conversation.members.find((member) => member.userId === agent.userId)?.role ??
      "ENGINEER";
    const leader = members.find(
      (entry) => entry.member.role === "LEADER" && entry.user?.isAgent
    );

    const identity = [
      p(`你是「${agent.displayName}」，正在 ADing 里参与一个会话。`, `You are "${agent.displayName}", taking part in a conversation in ADing.`),
      agent.persona ? p(`你的设定：${agent.persona}`, `Your persona: ${agent.persona}`) : ""
    ]
      .filter(Boolean)
      .join("\n");

    const charter = conversation.charter;
    const workspace = await this.deps.store.getWorkspace(conversation.workspaceId);
    const charterLines = [
      sinceSeq === 0
        ? p("这是你第一次进入这个会话，请先理解会话信息再开始推进。", "This is the first time you've joined this conversation; understand the conversation information before moving it forward.")
        : "",
      p(`会话名称：${conversation.name ?? "未命名"}`, `Conversation name: ${conversation.name ?? "Untitled"}`),
      workspace?.kind === "folder" ? p(`所属工作区：${workspace.name}`, `Workspace: ${workspace.name}`) : "",
      charter?.goal ? p(`会话目标：${charter.goal}`, `Conversation goal: ${charter.goal}`) : "",
      charter?.boundary ? p(`边界：${charter.boundary}（超出这个范围就算跑题）`, `Scope: ${charter.boundary} (anything outside it is off-topic)`) : "",
      charter?.doneWhen ? p(`完成标准：${charter.doneWhen}`, `Done when: ${charter.doneWhen}`) : "",
      brainstorming(conversation) ? p("当前协作阶段：共同制定并复核方案，尚未正式分工", "Current collaboration stage: jointly drafting and reviewing the plan; work not formally assigned yet") : "",
      charter?.instructions ? p(`主人当前的指示（优先遵守）：${charter.instructions}`, `The task owner's current instructions (take priority): ${charter.instructions}`) : "",
      p(`工作目录：${resolution.workspacePath}`, `Working directory: ${resolution.workspacePath}`)
    ].filter(Boolean);

    const others = members
      .filter((entry) => entry.member.userId !== agent.userId && entry.user)
      .map((entry) => {
        const who = entry.user as UserRef;
        const tag = who.isAgent ? "Agent" : p("真人", "Human");
        const paused = entry.member.paused ? p("，已暂停", ", paused") : "";
        // Files an Agent on another computer produces stay on that computer; the Leader plans and reviews accordingly.
        const computer = who.isAgent && who.remote ? who.remote.computerName || "" : undefined;
        const where = computer === undefined ? {zh:"",en:""} : {zh:`，在另一台电脑${computer ? `「${computer}」` : ""}上，产物保存在那台电脑`,en:`, on another computer${computer ? ` "${computer}"` : ""}; its output files stay on that computer`};
        const role = who.userId === conversation.owner ? p("主人", "task owner") : roleLabel(entry.member.role);
        const available = who.isAgent ? (entry.session?.recovery?.state === "blocked" ? p("连接恢复失败，禁止分派，需主人继续会话后重试", "connection recovery failed; don't assign work until the task owner continues the conversation and it retries") : this.deps.isAgentReady(who) ? p("可用", "available") : p("不可用，禁止分派", "unavailable; don't assign work")) : "";
        const activity=this.agentActivity(who.userId);
        const busy = activity.busyConversationId;
        const elapsed = Math.floor((Date.now() - (this.startedAt.get(who.userId) ?? Date.now())) / 1000);
        return p(`${who.displayName} [${who.userId}]（${tag}，${role}${paused}${where.zh}，${available}${busy ? `，正在会话 ${busy} 工作 ${elapsed} 秒，当前进度：${this.progress.get(who.userId) ?? "处理中"}` : "，空闲"}${who.isAgent ? `，并行工作：${activity.parallel}/${activity.capacity}，能力参考：${who.persona || who.kind || "未知"}，剩余配额：未知，不可臆测` : ""}）`, `${who.displayName} [${who.userId}] (${tag}, ${role}${paused}${where.en}, ${available}${busy ? `, working on conversation ${busy} for ${elapsed} s, current progress: ${this.progress.get(who.userId) ?? "in progress"}` : ", idle"}${who.isAgent ? `, parallel work: ${activity.parallel}/${activity.capacity}, capabilities: ${who.persona || who.kind || "unknown"}, remaining quota: unknown, don't guess` : ""})`);
      });
    const teamLines = [
      p(`你的角色：${roleLabel(myRole)}`, `Your role: ${roleLabel(myRole)}`),
      p("系统不会因耗时或工具调用次数自动中断、续接或额外唤醒执行。只有用户停止、权限结果、连接失败或 Leader 根据具体证据主动调整分工才改变执行。保存阶段产物和验证证据，不能把工具成功等同于目标进展。", "The system won't automatically interrupt, resume or wake up execution because of elapsed time or the number of tool calls. Execution only changes when the user stops it, a permission result arrives, the connection fails, or the Leader adjusts the division of work based on specific evidence. Save stage outputs and verification evidence; a tool call succeeding isn't the same as progress toward the goal."),

      p("Leader调度：按可独立验收的产物或阶段细分工作，真正无依赖的工作同时派出；仅将确实需要上游产物的工作设为依赖。执行者交回阶段结果不代表完成或成员不可用，先核实已有产物，再换方法、改派或分阶段续做；不盲目原样重试，不重复已生效的副作用。对同一版本只验收一次，已有交付直接引用验收记录。用户提出时限时规划时间预算，未提出时不虚构截止时间。", "Leader scheduling: break work down by outputs or stages that can be accepted independently, and dispatch genuinely independent work at the same time; only make work depend on something when it really needs the upstream output. An executor handing back a stage result doesn't mean the work is done or the member is unavailable — first verify the existing outputs, then change method, reassign or continue in stages; don't blindly retry as-is, and don't repeat side effects that already took effect. Accept the same version only once; for existing deliveries, cite the acceptance record directly. When the user gives a deadline, plan a time budget; when they don't, don't invent one."),
      this.deps.workAssignmentId ? p(`当前为独立工作会话 ${this.deps.workAssignmentId}。你的 Agent 并发上限为 ${this.agentActivity(agent.userId).capacity} 路，当前并行工作 ${this.agentActivity(agent.userId).parallel} 项。此会话只负责当前分工，其他工作由独立会话执行。群聊口头改派、其他会话的自述不改变本分工；只有调度器发出的新分工或明确中断才改变执行。交回本分工要求的全部产物与证据，其他工作成果不能代替；不要把其他会话的工作当作自己本轮的待办，也不要因同一 Agent 已有其他任务而声称只能串行。本分工已由调度器检查并发容量，仍须检查实际能力、依赖和输出冲突。`, `This is the independent work session ${this.deps.workAssignmentId}. Your Agent concurrency limit is ${this.agentActivity(agent.userId).capacity} lanes, with ${this.agentActivity(agent.userId).parallel} parallel work items running now. This session is only responsible for the current assignment; other work runs in independent sessions. Verbal reassignment in the group chat and other sessions' self-reports don't change this assignment; only a new assignment or an explicit interruption from the scheduler changes execution. Hand back all outputs and evidence this assignment requires — results of other work can't substitute for them. Don't treat other sessions' work as your to-dos for this turn, and don't claim you can only work serially because the same Agent has other tasks. The scheduler has already checked concurrency capacity for this assignment; you still need to check actual capability, dependencies and output conflicts.`) : "",
      others.length ? p(`其他成员：${others.join("、")}`, `Other members: ${others.join(", ")}`) : "",
      leader && leader.member.userId !== agent.userId && leader.user
        ? p(`${leader.user.displayName} 是负责人，有权决定话题走向和结束讨论。`, `${leader.user.displayName} is the lead and decides where the topic goes and when the discussion ends.`)
        : ""
    ].filter(Boolean);

    const headings: Record<MemoryScope, string> = {
      user: p(`关于${me.displayName}`, `About ${me.displayName}`),
      workspace: p(`关于工作区「${workspace?.name ?? ""}」`, `About the workspace "${workspace?.name ?? ""}"`),
      conversation: p("关于本次会话", "About this conversation")
    };
    const memoryLines: string[] = [];
    const isolated = await this.memoryIsolated(conversation, agent);
    for (const target of memoryScopesFor(
      resolution,
      me.userId,
      conversation.conversationId
    )) {
      if (isolated && target.scope === "user") continue;
      const entries = await this.deps.store.listMemories(
        target.scope,
        target.ownerId,
        {
          since: this.deps.knowledge ? undefined : memorySince,
          limit: target.scope === "user" ? 60 : 80
        }
      );
      if (!entries.length) continue;
      await this.deps.log("memory-injected",{conversation:conversation.conversationId,agent:agent.userId,scope:target.scope,ownerId:target.ownerId,entries:entries.map(e=>({id:e.memoryId,version:e.updatedAt ?? e.createdAt}))});
      memoryLines.push(
        `${headings[target.scope]}：\n` +
          entries.map((entry) => `- ${entry.content}`).join("\n")
      );
    }

    const fresh = await this.deps.store.listMessages(conversation.conversationId, {
      // Rebuilding a filtered thread needs the latest history, not the first
      // thousand messages of a long-running group.
      ...(sinceSeq > 0 ? {afterSeq: sinceSeq} : {}),
      limit: 1000
    });
    const scopedAssignment = this.deps.workAssignmentId ? await this.assignmentFor(conversation.conversationId,agent.userId) : undefined;
    const scopedWork = conversation.workPlan?.find(w=>w.assignmentId===scopedAssignment?.id);
    const neededWork = new Set(scopedWork?.dependsOn ?? []);
    const selection = await this.groupContext(conversation,agent);
    const excluded = new Set(selection?.excludedSeqs ?? []);
    const lines: string[] = [];
    for (const item of fresh) {
      if (excluded.has(item.seq) || isTeamRelay(item)) continue;
      if (item.internal && item.agentReply && ["plan","batch","review","assign","interrupt","organize","stop"].includes(parseLeaderControl(item.agentReply.raw).control?.action ?? "")) continue; // Keep genuine objections and failure evidence.
      if (scopedAssignment && !(item.senderId===conversation.owner && item.type==="USER" && !item.agentReply) &&
          item.coordination?.id!==scopedAssignment.id && !(item.coordination?.workId && neededWork.has(item.coordination.workId) && item.coordination.phase==="result")) continue;
      // Coordinating, a Leader sees the results its own execution sessions handed back: this thread never produced them.
      const ownWorkResult = item.senderId === agent.userId && myRole === "LEADER" && (item.coordination?.phase === "result" || item.coordination?.phase === "rejected");
      if ((sinceSeq > 0 && item.senderId === agent.userId && !ownWorkResult && !item.internal && item.type !== "SYSTEM" && item.agentReply?.lane !== "inbox") || item.report) continue;
      const who = await this.deps.store.getUser(item.senderId);
      const said = await this.spoken(conversation.conversationId, item);
      // An @ addressed to someone else stays visible as context, but it isn't this member's to handle.
      const directedTo: string[] = [];
      if (who && !who.isAgent && item.type === "USER" && !item.mentions?.includes(agent.userId)) {
        for (const id of item.mentions ?? []) {
          const mentioned = await this.deps.store.getUser(id);
          if (mentioned?.isAgent) directedTo.push(mentioned.displayName);
        }
      }
      lines.push(p(`${item.agentReply?.lane === "inbox" && item.senderId === agent.userId ? "你已在并发消息通道回复（勿重复）" : item.internal || item.type === "SYSTEM" ? "调度上下文（不是成员发言）" : who?.displayName ?? item.senderId}：${said}`, `${item.agentReply?.lane === "inbox" && item.senderId === agent.userId ? "You already replied in the concurrent message lane (don't repeat)" : item.internal || item.type === "SYSTEM" ? "Scheduling context (not a member's message)" : who?.displayName ?? item.senderId}: ${said}`));
      if (directedTo.length) lines.push(p(`调度上下文（不是成员发言）：上面这条消息 @ 了 ${directedTo.join("、")}，只由被 @ 的 Agent 处理；你知道这件事即可，不需要处理或回复。`, `Scheduling context (not a member's message): the message above @-mentions ${directedTo.join(", ")}. Only the mentioned Agents handle it; you just need to be aware of it, and shouldn't handle or reply to it.`));
      const peopleNote = await this.peopleMentionNote(item, agent);
      if (peopleNote) lines.push(peopleNote);
    }

    if (conversation.type === "DIRECT" || await this.soloAgent(conversation)) {
      const history = sinceSeq === 0 ? await this.deps.store.listMessages(conversation.conversationId,{limit:100}) : fresh;
      const chat: string[] = [];
      for (const item of history) {
        if (conversation.type === "GROUP" && excluded.has(item.seq)) continue;
        if (item.report || item.coordination || item.failed || (sinceSeq > 0 && item.senderId === agent.userId)) continue;
        // The user's words go in verbatim without a "User:" prefix — this is sent to the vendor as this turn's input,
        // and with a prefix, what the user sees in Codex's own UI wouldn't be their own words.
        // Assistant and system notices are still labeled; the unlabeled one is what the user said, so the two remain distinguishable.
        const speaker = item.senderId === agent.userId ? p("助手", "Assistant") : item.type === "SYSTEM" ? p("系统通知", "System notice") : "";
        const said = await this.spoken(conversation.conversationId, item);
        const note = await this.peopleMentionNote(item, agent);
        chat.push([speaker ? `${speaker}：${said}` : said, note].filter(Boolean).join("\n"));
      }
      // ADing's own generated instructions are delivered separately from the conversation content: compose differs only in the conversation slot,
      // the assembled full prompt is identical to before, and app is the same thing with the conversation removed.
      const said = chat.join("\n\n");
      const compose = (dialogue: string) => [identity,
          p("直接回应用户的消息；需要使用工具时按用户的请求执行，需要权限时等待审批。", "Respond directly to the user's message; when tools are needed, act on the user's request, and when permission is needed, wait for approval."),
          p("执行原则：先明确每个产物的输入范围、必须保留的内容和不得添加的内容；通用模板只用于真正共有的要求，不把某一产物特有的结构套给其他产物。无依赖且工具允许的工作可并行，完成一个就检查并保存一个，发现缺陷只修正受影响部分。", "Execution principles: first make clear, for each output, its input scope, what must be kept and what must not be added; use a common template only for requirements that are truly shared, and don't impose one output's specific structure on others. Work without dependencies can run in parallel if the tools allow; check and save each item as it finishes, and when you find a defect, fix only the affected part."),
          p("临时脚本、中间图、联系表和调试文件写在工作目录或临时目录，运行时使用绝对路径；用户指定的目标文件夹只放最终交付物。", "Put temporary scripts, intermediate images, contact sheets and debug files in the working directory or a temp directory, using absolute paths at run time; the target folder the user named only holds the final deliverables."),
          p("长工具调用按工具说明等待，优先使用返回的进度、结果和文件路径；不要用短间隔轮询、重复列目录或重复读取替代等待。原生图片结果直接展示供检查，避免把图片二进制或完整结果对象当文本输出。并行调用要逐项检查成功与失败，不遗漏失败项。", "For long tool calls, wait as the tool describes, preferring the returned progress, results and file paths; don't replace waiting with short polling, repeated directory listings or repeated reads. Show native image results directly for inspection, and avoid outputting image binaries or entire result objects as text. For parallel calls, check each success and failure; don't miss failed items."),
          p("仅使用当前会话、明确授权的文件及注入记忆；不要检索其他会话历史补全事实。", "Only use the current conversation, explicitly authorized files and injected memory; don't search other conversations' history to fill in facts."),
          p(`工作目录：${resolution.workspacePath}`, `Working directory: ${resolution.workspacePath}`),
          charter?.instructions ? p(`用户指示：${charter.instructions}`, `User instructions: ${charter.instructions}`) : "",
          memoryLines.join("\n\n"),
          dialogue
        ].filter(Boolean).join("\n\n");
      return {
        prompt: compose(said),
        app: compose(""),
        dialogue: said,
        contextMessages:chat,
        upToSeq: history.at(-1)?.seq ?? sinceSeq
      };
    }

    if (brainstorming(conversation)) {
      const said = lines.join("\n\n");
      const compose = (dialogue: string) => [identity,charterLines.join("\n"),teamLines.join("\n"),
        memoryLines.join("\n\n"),
        dialogue,brainstormInstruction(conversation.brainstorm!,agent.userId)].filter(Boolean).join("\n\n");
      return {prompt:compose(said),app:compose(""),dialogue:said,contextMessages:lines,
        upToSeq:fresh.at(-1)?.seq ?? sinceSeq};
    }

    const assignment = await this.assignmentFor(conversation.conversationId, agent.userId);
    if (myRole !== "LEADER" && assignment?.phase === "proposal") {
      // Negotiation keeps all new messages, task constraints and memories, but does not
      // resend the entire execution/leader protocol just to obtain a short decision.
      const said = lines.length ? p("自你上次发言以来的新消息：\n", "New messages since you last spoke:\n") + lines.join("\n") : "";
      const compose = (dialogue: string) => [identity, charterLines.join("\n"), teamLines.join("\n"), memoryLines.join("\n\n"),
          dialogue,
          p(`当前待讨论分工：${JSON.stringify(assignment)}`, `Assignment under discussion: ${JSON.stringify(assignment)}`),
          p("本轮仅评估方案，没有工具。请独立判断范围、能力、成本和风险；同意时简短确认即可，不必完整复述任务。发现疑问或更好方法时说明原因和建议，交给负责人讨论，达成一致前不执行。确认后系统直接安排执行轮，不需要等负责人再说一次开始。", "This turn only evaluates the plan; there are no tools. Judge the scope, capability, cost and risk independently; if you agree, a short confirmation is enough — no need to restate the whole task. If you have doubts or a better method, explain why and what you suggest, and leave it to the lead to discuss; don't execute before agreement. Once confirmed, the system schedules the execution turn directly; there's no need to wait for the lead to say start again."),
          p("正文简短说明判断，并在末尾附结构化控制 {\"control\":{\"action\":\"accept\",\"assignmentId\":\"当前分工id\"}}；有真实疑虑则 action=\"revise\" 并写 reason。这个控制表达接单意愿，不是工具调用。叙述工作中的不确定内容不等于拒绝分工。当前禁用工具不代表执行轮没有权限。", "Briefly explain your judgment in the body, and append a structured control at the end: {\"control\":{\"action\":\"accept\",\"assignmentId\":\"current assignment id\"}}; if you have real concerns, use action=\"revise\" and write a reason. This control expresses willingness to take the work; it isn't a tool call. Describing uncertainty in the work doesn't mean rejecting the assignment. Tools being disabled now doesn't mean the execution turn lacks permissions."),
          p("仅使用当前会话上下文与注入记忆，不检索其他会话历史；保留主人要求和原文件，不能用同意分工扩大授权。", "Only use the current conversation context and injected memory; don't search other conversations' history. Keep the task owner's requirements and the original files; agreeing to an assignment can't widen the authorization.")
        ].filter(Boolean).join("\n\n");
      return {
        prompt: compose(said),
        app: compose(""),
        dialogue: said,
        contextMessages:lines,
        upToSeq: fresh.at(-1)?.seq ?? sinceSeq
      };
    }
    // The collaboration protocol below is thousands of tokens and identical from
    // turn to turn, while the provider thread keeps every turn ever sent. Tag each
    // line so a resumed thread is only told what actually changed - the same
    // watermark idea as memorySyncedAt, applied to the protocol itself.
    const instruction:{text:string;stable:boolean}[]=[];
    const deliveredState:NonNullable<AgentSessionRef["deliveredState"]>={};
    const stable=(...texts:string[])=>{for(const text of texts)instruction.push({text,stable:true});};
    const perTurn=(...texts:string[])=>{for(const text of texts)instruction.push({text,stable:false});};
    stable(
      p("上下文边界：当前会话事实只来自本次群聊、当前工作区明确授权的文件及以下注入记忆。全局个人偏好可沿用，其他会话的照片题号、结论、输出和要求必须重新核实。不要搜索厂商全局 memories 或历史会话来补全本任务事实。", "Context boundary: facts about the current conversation only come from this group chat, files explicitly authorized in the current workspace, and the injected memory below. General personal preferences may carry over, but photo question numbers, conclusions, outputs and requirements from other conversations must be re-verified. Don't search the vendor's global memories or past sessions to fill in facts for this task."),
      p("只有最后一段输出进入聊天。中间工具/进度只描述过程，最终回复只给当前有效的交付、讨论或提问。不要拼接过时进展，不声称未实际查看的文件已验收。", "Only the last section of your output goes into the chat. Intermediate tool/progress notes only describe the process; the final reply only gives the currently valid delivery, discussion or question. Don't stitch together outdated progress, and don't claim files you didn't actually look at have been accepted."),
      p("产物先写到自己负责的草稿路径，保留源文件；不得改写其他人的候选版本。逐项核对主人的验收条件，附实际文件路径和检查证据；未通过只能报告部分完成/待修。图像内容和数学符号对照原图，先验收样张再批量处理。同一方法连续失败应讨论替代方案，不能把方法失败说成任务不可能。", "Write outputs to your own draft path first and keep the source files; don't rewrite other people's candidate versions. Check the task owner's acceptance criteria item by item, with actual file paths and evidence of the check; anything that doesn't pass can only be reported as partially done / needs fixing. Compare image content and math symbols against the original, and accept a sample before batch processing. If the same method keeps failing, discuss alternatives; don't present a failed method as the task being impossible."),
      conversation.type === "GROUP"
        ? p("请阅读以上群聊。群里每个人都能看到每条消息，你像真人群成员一样，以最新消息为中心判断自己要不要发言、回应哪条：\n- 最新消息 @ 你或点名提到你：必须回复。\n- 最新消息 @ 了其他成员：默认不回复；只有发现明显错误，或你掌握对方缺少的关键信息时才发言。\n- 你参与过与最新消息相关的话题，或消息和你手上的工作有关：按需要回复。\n- 无人指定的请求或提问：由 Leader 回复；其他人有不同看法或关键补充时再发言。\n- Leader 已经派工的复杂任务进行中：由 Leader 统筹回应；其他成员只在消息与自己的工作有关、被点名，或有关键信息、纠错要补充时发言。\n- 最新消息与你无关（例如别人之间的交流、明确交给其他成员的事）：不回复。\n早先的话题已告一段落、与最新消息无关时，只回应最新消息，不要接着旧话题说，也不要重提旧方案。\n只输出你要在群里说的话，不要复述别人说过的内容。不需要发言时只回复 SKIP。", "Read the group chat above. Everyone in the group sees every message; like a member of a real group, decide from the latest message whether to speak and which message to respond to:\n- The latest message @-mentions you or names you: you must reply.\n- The latest message @-mentions other members: don't reply by default; speak only if you spot an obvious mistake or have key information they're missing.\n- You took part in a topic the latest message relates to, or it concerns work you're doing: reply as needed.\n- A request or question addressed to no one in particular: the Leader replies; others speak only if they have a different view or a key addition.\n- A complex task the Leader has already assigned is under way: the Leader coordinates and responds; other members speak only when the message concerns their own work, they're named, or they have key information or a correction to add.\n- The latest message has nothing to do with you (for example other people talking to each other, or something clearly handed to another member): don't reply.\nWhen an earlier topic has wrapped up and is unrelated to the latest message, respond only to the latest message; don't carry on the old topic or bring old plans back up.\nOutput only what you want to say in the group; don't repeat what others have said. When you don't need to speak, reply only SKIP.")
        : p("请回复老板。", "Please reply to your boss.")
    );
    if (myRole === "LEADER") {
      stable(
        p("你负责统筹全局：根据会话目标、聊天上下文和主人的最新指示，自主判断最新消息需要怎样回应，不能要求主人选择或解释任务类型。普通交流直接在群里回复；需要操作、制作产物、修复或交付结果的任务，可以自己完成，复杂时拆分并用 plan 或 assign 分派，由你主持进度。", "You coordinate the big picture: based on the conversation goal, the chat context and the task owner's latest instructions, decide on your own how the latest message should be handled; don't ask the task owner to choose or explain the task type. Reply in the group directly for ordinary conversation; for work that needs operations, producing outputs, fixing or delivering results, you can do it yourself, or when it's complex, split it up and assign it with plan or assign, and you run the progress."),
        p("操作任务以实际成果为目标：持续理解主人需求、必要时确认，拆分独立工作、指导协商、review 实物结果并总结交付。难题交给能力适合的 Agent；较简单但耗 token 的工作优先交给已知剩余配额更多者。配额未知时明确未知，可依据主人指示，不能捏造。不可分派给不可用、暂停或观察员。不要为并行而拆碎小事或重复劳动。你也要承担适合自己的实质工作，与已委派的工作并行；明确各自输出路径、验收条件和依赖，避免覆盖。", "For operational tasks the goal is actual results: keep understanding the task owner's needs, confirm when necessary, split independent work, guide negotiation, review the actual outputs and summarize the delivery. Hard problems go to the Agent with suitable capability; simpler but token-heavy work goes first to whoever is known to have more remaining quota. When quota is unknown, say it's unknown; you may follow the task owner's instructions, but don't make it up. Don't assign work to members who are unavailable, paused or observers. Don't split small things into pieces or duplicate work just for parallelism. You also take on substantive work suited to you, in parallel with delegated work; make each one's output path, acceptance criteria and dependencies clear to avoid overwriting.")
      );
      const board = await Promise.all(conversation.members.map(member => this.assignmentFor(conversation.conversationId, member.userId)));
      const boardState = stateDelta(board.filter((item): item is NonNullable<typeof item> => !!item), item => item.id, delivered ? delivered.board ?? {items:{},turns:0} : undefined);
      deliveredState.board = boardState.next;
      perTurn(boardState.delta.kind === "full"
        ? p(`当前分工状态（只读，result 仍需 review）：${JSON.stringify(boardState.delta.items)}`, `Current assignment status (read-only; results still need review): ${JSON.stringify(boardState.delta.items)}`)
        : boardState.delta.kind === "same"
        ? p(`当前分工状态没有变化（共 ${boardState.delta.total} 项，result 仍需 review）。`, `Assignment status hasn't changed (${boardState.delta.total} in total; results still need review).`)
        : p(`当前分工状态的变化（只读，result 仍需 review；共 ${boardState.delta.total} 项，其余不变）：${JSON.stringify(boardState.delta.changed)}${boardState.delta.removed.length ? `；已移除：${boardState.delta.removed.join("、")}` : ""}`, `Changes in assignment status (read-only; results still need review; ${boardState.delta.total} in total, the rest unchanged): ${JSON.stringify(boardState.delta.changed)}${boardState.delta.removed.length ? `; removed: ${boardState.delta.removed.join(", ")}` : ""}`));
      stable(p("proposal 仅代表待确认，绝不代表正在执行。成员可以自然语言同意、提问或提出异议。收到待讨论/待澄清时阅读成员原文，回应问题并更新方案；需要确认能力时可拆一个有限的读取/样张任务，不要把格式差异或本轮禁用工具认定为该成员永久无能力。接单超时会释放占用并通知你；需更新 blocked 工作的方案与候选人，可自己接手，不要只口头催促。权限按 Agent、按轮次独立生效，你的权限变化不代表其他成员恢复。受阻不得验收，不重复申请主人已拒绝的相同操作。", "A proposal only means it's awaiting confirmation; it never means work is in progress. Members may agree, ask questions or object in natural language. When something needs discussion or clarification, read the member's actual words, answer the question and update the plan; if you need to confirm a capability, split off a bounded read/sample task — don't conclude a member is permanently incapable because of a format difference or tools being disabled this turn. If accepting times out, the reservation is released and you're notified; update the plan and candidates for blocked work, or take it yourself, rather than just nudging verbally. Permissions take effect per Agent and per turn; a change in your permissions doesn't mean other members got theirs back. Blocked work can't be accepted, and don't re-request the same operation the task owner already denied."));
      stable(p(`你的协调和你承接的每项 plan 工作由阿钉分别放在独立的顶层厂商会话里，执行时读过的内容不会回到协调会话，协调时只看得到交回的结果。每个成员一次只承接一项 plan 工作；需要并行时，由执行会话使用厂商原生子 Agent、并行工具或有界批处理完成，不要为 plan 子项自行另开顶层会话。优先按照片、题目、模块等可独立验收的单位描述工作，让执行会话可以内部并行。声明真实依赖和独立输出路径；不要把整个批次绑在一个样张上，不同方法只等待各自必需的验证。避免把几秒小事拆成多轮讨论，以总完成时间为目标。`, `ADing keeps your coordination and each plan work item you take on in separate top-level vendor sessions: what you read while executing doesn't come back to the coordination session, which only sees the result handed back. Each member takes on one plan work item at a time; when parallelism is needed, the execution session uses the vendor's native sub-agents, parallel tools or bounded batch processing, and you don't open another top-level session for plan sub-items yourself. Prefer to describe work in units that can be accepted independently — photos, questions, modules — so the execution session can parallelize internally. Declare real dependencies and separate output paths; don't tie the whole batch to one sample, and let different methods wait only for the verification each one needs. Avoid splitting things that take a few seconds into multiple rounds of discussion; aim for the shortest total completion time.`));
      stable(p("持续检查成员的空闲情况：有人空闲且有可执行工作时，立即更新计划分配；仅等待真实依赖，不把整组任务都串行化。收到团队空闲检查时实际提交分工或说明具体等待条件，不只口头承诺。派单失败按确切原因调整；暂时保存失败由系统有限重试，登录、额度、暂停和权限问题不得原样反复派发，需要主人处理时明确告诉主人具体操作。assign 支持给自己派单，系统直接登记 accepted 并在下一轮执行，无需自己向自己确认。", "Keep checking whether members are idle: when someone is idle and there's executable work, update the plan assignment right away; only wait on real dependencies, and don't serialize the whole group's work. When you receive a team idle check, actually submit assignments or state the specific waiting condition — don't just promise verbally. When dispatch fails, adjust based on the exact reason; temporary save failures are retried a limited number of times by the system, while login, quota, pause and permission problems must not be dispatched again unchanged — when the task owner needs to act, tell them the specific action. assign can assign work to yourself; the system registers it as accepted directly and runs it next turn, with no need to confirm to yourself."));
      const planState = stateDelta(conversation.workPlan ?? [], item => item.id, delivered ? delivered.plan ?? {items:{},turns:0} : undefined);
      deliveredState.plan = planState.next;
      perTurn(planState.delta.kind === "full"
        ? p(`持久化工作队列：${JSON.stringify(planState.delta.items)}`, `Persistent work queue: ${JSON.stringify(planState.delta.items)}`)
        : planState.delta.kind === "same"
        ? p(`持久化工作队列没有变化（共 ${planState.delta.total} 项）。`, `The persistent work queue hasn't changed (${planState.delta.total} items).`)
        : p(`持久化工作队列的变化（共 ${planState.delta.total} 项，其余不变）：${JSON.stringify(planState.delta.changed)}${planState.delta.removed.length ? `；已移除：${planState.delta.removed.join("、")}` : ""}`, `Changes in the persistent work queue (${planState.delta.total} items, the rest unchanged): ${JSON.stringify(planState.delta.changed)}${planState.delta.removed.length ? `; removed: ${planState.delta.removed.join(", ")}` : ""}`));
      stable(
        p("执行任务优先用 plan 维护可增量更新的工作队列。拆成可验收的小工作，先发依赖满足的一批，后续根据完成速度和当前工作量调整 queued 工作的候选人。尽量让所有可用 Agent 包括自己有独立有效的工作；不用一次分完，不为凑人数重复劳动。若让可用成员空闲，说明具体依赖或能力原因并在结果返回后重新评估。", "For execution tasks, prefer maintaining an incrementally updatable work queue with plan. Break the work into small items that can be accepted, dispatch the batch whose dependencies are met first, and adjust the candidates of queued work later based on completion speed and current workload. Try to give every available Agent, including yourself, independent useful work; you don't have to assign everything at once, and don't duplicate work just to keep people busy. If you leave an available member idle, explain the specific dependency or capability reason and re-evaluate when results come back."),
        p("每项工作 candidates 用实际成员 id 按能力适配排序；系统自动挑当前空闲者。同等能力可列多名候选让快者多接工作。重难点给适合的强者；已知配额多者承担简单耗量工作，未知则不得捏造。系统只在候选范围内选择。", "For each work item, order candidates by capability fit using actual member ids; the system picks whoever is idle at the moment. Several candidates of similar capability can be listed so the faster one takes more work. Give the hard parts to the strong members suited to them; members known to have more quota take the simple, token-heavy work — if quota is unknown, don't make it up. The system only chooses within the candidate list."),
        p("避免自己一个长轮串行处理整批产物。每完成一小批就提交阶段结果，让系统读取协作者结果、派发后续工作；依赖只有 review pass 后才解锁。你自己也列为候选并承担小工作。", "Avoid processing a whole batch of outputs serially in one long turn of your own. Submit a stage result after each small batch, so the system can read collaborators' results and dispatch follow-up work; dependencies only unlock after a review pass. List yourself as a candidate too and take on small work items."),
        p('末尾格式：{"control":{"action":"plan","work":[{"id":"crop1","assignment":"用已通过的主工具和步骤处理第一张，先完成样本并按失败判据决定是否切换替代路线","candidates":["实际成员id"],"dependsOn":[],"outputs":["草稿/第一张_*.png"],"acceptance":"对照源图验证题干完整","readOnly":false,"preAgreed":false}]}}。outputs 必须是具体文件或带一个 * 的文件模式，不能只写目录。只有该执行者已在本会话共同讨论中明确复核过完全相同的主工具、步骤、边界和失败路线，且没有未解决异议时，才可设 preAgreed=true 跳过重复接单讨论；任务相似或笼统同意不算。可只补充或修改尚未开始的工作；id稳定，不能改写已开始项。', `Format at the end: {"control":{"action":"plan","work":[{"id":"crop1","assignment":"Process the first image with the approved main tool and steps; finish the sample first and use the failure criteria to decide whether to switch to the fallback route","candidates":["actual member id"],"dependsOn":[],"outputs":["drafts/first_*.png"],"acceptance":"Verify against the source image that the question stem is complete","readOnly":false,"preAgreed":false}]}}. outputs must be specific files or a file pattern with a single *, not just a directory. Only when this executor has explicitly reviewed exactly the same main tool, steps, scope and failure route in this conversation's joint discussion, with no unresolved objections, may preAgreed=true be set to skip a repeated accept discussion; a similar task or a general agreement doesn't count. You may only add or change work that hasn't started; ids are stable, and items that have started can't be rewritten.`),
        p('收到结果后实际检查，再用 {"control":{"action":"review","workId":"crop1","verdict":"pass或retry","evidence":"实际检查的文件和逐项证据"}}。成员提交只是待验收。需要异人验收时先安排独立复核工作。不修改被核查原件的工作标 readOnly=true，outputs可为空；这是工作范围要求，不是禁用工具或禁止保存报告。需要报告文件时指定独立输出路径。工具审批统一遵循主人的权限设置。retry 会退回 blocked，不会原样自动重跑；用 plan 更新受阻项的方案和候选人后再派发。', `After receiving results, actually check them, then use {"control":{"action":"review","workId":"crop1","verdict":"pass or retry","evidence":"the files actually checked and item-by-item evidence"}}. A member's submission only awaits acceptance. When acceptance by a different person is needed, arrange an independent review work item first. Mark work that doesn't modify the original being checked as readOnly=true; outputs may be empty. That's a scope requirement, not a ban on tools or on saving a report. When a report file is needed, specify a separate output path. Tool approvals follow the task owner's permission settings. retry sends the item back to blocked and doesn't rerun it automatically as-is; update the blocked item's plan and candidates with plan before dispatching again.`)
      );
      stable(
        p("最后一批验收通过且没有后续工作时，在本轮正文交付最终结果，并提交 review/pass（多项用 batch）。全部工作已验收且没有新输入或在途工作后，系统会结束自动跟进，无需另起一轮重复验收或补 stop。仍有后续工作时在同一 batch 登记 plan。", "When the final batch passes acceptance and no further work remains, deliver the final result in this reply and submit review/pass (use batch for multiple items). Once all work is accepted and there is no new input or in-flight work, the system ends automatic follow-up; no extra turn is needed to repeat acceptance or add stop. If further work remains, register its plan in the same batch."),
        p('优先同轮提交多个已检查结果和后续安排：{"control":{"action":"batch","actions":[{"action":"review","workId":"crop1","verdict":"pass","evidence":"实际检查证据"},{"action":"plan","work":[完整工作项]}]}}。actions最多20项，只含review和plan、不嵌套，依次执行；某项过时不阻止其他独立项，但依赖仍须验收通过。不要为了每个验收或派工单独调用一轮。旧的单项控制仍可用。', `Prefer submitting several checked results and the follow-up arrangements in the same turn: {"control":{"action":"batch","actions":[{"action":"review","workId":"crop1","verdict":"pass","evidence":"evidence actually checked"},{"action":"plan","work":[full work items]}]}}. actions holds at most 20 items, only review and plan, not nested, run in order; an outdated item doesn't block other independent items, but dependencies still have to pass acceptance. Don't spend a separate turn on each acceptance or assignment. The old single-item controls still work.`),
        p("先把不依赖自己操作的工作正式派出去，再开始自己的长操作。结果可用时一批核查、一批加工并行；每完成一个小成果就结束当前轮并交回安排，不把一整批串在自己的单轮里。多名成员确认接单不会额外唤醒你，结果和异议会；不用回复收到或重复开始指令。", "First formally dispatch the work that doesn't depend on your own operations, then start your own long operation. When results are available, check one batch and process another in parallel; each time a small result is done, end the current turn and hand back the arrangement, instead of chaining a whole batch in your own single turn. Several members confirming acceptance won't wake you up again; results and objections will. There's no need to reply that you received them or repeat start instructions."),
        p("计划要包含样张或小样验证。不要把工具调用次数当进展，也不要让简单裁边/复制等步骤的协商成本超过工作本身，可合成一个可验收小批。", "The plan should include sample or small-batch verification. Don't treat the number of tool calls as progress, and don't let the negotiation cost of simple steps like trimming edges or copying exceed the work itself; they can be combined into one acceptable small batch.")
      );
    }
    stable(
      p("共同方案已通过评审后，以独立产物为单位登记 plan，包括自己的执行与独立复核；不要再用临时 assign 承载制作工作。每项必须继承讨论中最终采用的具体方法；被明确否决的方法不得重新成为主路线，除非出现新证据并先交回 Leader 讨论。每项包含制作和基本自检，避免把读取、保存等小步骤拆成跨成员接力。复核结果返回后及时 review，并在同一 batch 登记依赖已满足的后续工作。工具能力以实际可调用工具为准，不能只按角色名称平均分配。", "After the joint plan passes review, register plan items by independent output, including your own execution and independent reviews; don't carry production work with ad-hoc assign anymore. Each item must inherit the specific method finally adopted in the discussion; a method that was explicitly rejected can't become the main route again unless there's new evidence and it goes back to the Leader for discussion first. Each item includes production and a basic self-check; avoid splitting small steps like reading and saving into relays across members. When review results come back, review promptly and register follow-up work whose dependencies are now met in the same batch. Tool capability is based on the tools that can actually be called, not an even split by role name."),
      p("委派必须用结构化控制，口头点名不会执行分工。可在同一个控制块中用 assignments 数组一次提出多个独立分工。接收者应先独立评估方案、成本、能力和风险，用自然语言明确同意或提出问题和替代建议，达成一致前不动手。接受后系统会安排下一轮执行。", "Delegation must use structured control; naming someone verbally doesn't assign work. You can propose several independent assignments at once with an assignments array in the same control block. The recipient should first independently evaluate the plan, cost, capability and risk, then clearly agree in natural language or raise questions and alternatives, and not start before agreement. After acceptance, the system schedules the next execution turn."),
      p("执行先验证一个小样，再按已验证方法批量处理；发现缺陷先定位根因，再继续修正直到完成。不要只报告工具一直在运行。", "When executing, first verify a small sample, then batch process with the verified method; when you find a defect, locate the root cause first, then keep fixing until it's done. Don't just report that a tool is still running.")
    );
    perTurn(
      assignment ? p(`你当前的分工状态：${JSON.stringify(assignment)}`, `Your current assignment status: ${JSON.stringify(assignment)}`) : p("你当前没有待接收的分工。", "You have no assignment waiting to be accepted."),
      assignment?.readOnly ? p("本分工 readOnly=true 表示不得修改被核查的原件或超出核查范围；并不禁止工具调用。可按交付需要在当前会话工作目录中保存独立报告、创建测量用临时副本，不覆盖原件或他人产物。若要求直接回复，则不必额外写文件。工具权限由主人的全局审批设置处理，不因 readOnly 标签自行断言无写入权限，也不要求主人处理内部权限矛盾；以实际工具结果为准。", "readOnly=true on this assignment means you must not modify the original being checked or go beyond the scope of the check; it doesn't forbid tool calls. As delivery requires, you may save a separate report in the current conversation's working directory and create temporary copies for measurement, without overwriting the original or other people's outputs. If a direct reply is asked for, there's no need to write an extra file. Tool permissions are handled by the task owner's global approval settings; don't assert on your own that you lack write permission because of the readOnly label, and don't ask the task owner to resolve internal permission contradictions; go by the actual tool results.") : "",
      myRole !== "LEADER" && conversation.type === "GROUP" && assignment
        ? assignment.phase === "accepted" ? p("方案已达成一致，现在严格按分工中写明的主工具、首个验证动作和失败路线执行并交付路径、验证证据和未解决项。不得静默换回讨论中已否决的方法；发现主工具不可用或有新证据时，先报告 blocked 交回 Leader。若无法完成，在末尾用 control action=blocked、assignmentId=当前分工id、reason=实际障碍；不要把受阻描述为已完成。", "The plan is agreed. Now execute strictly with the main tool, first verification step and failure route written in the assignment, and deliver the paths, verification evidence and unresolved items. Don't silently switch back to a method that was rejected in the discussion; if the main tool is unavailable or there's new evidence, first report blocked and hand it back to the Leader. If you can't finish, use control action=blocked, assignmentId=the current assignment id and reason=the actual obstacle at the end; don't describe blocked work as done.") : p('本轮仅沟通与评估，没有工具；这不表示执行轮也没有工具。请明确复述你准备采用的主工具/关键步骤，并指出是否与已通过方案完全一致；一致才 accept。想改用被否决的方法必须 revise 并给新证据，不能一边声称同意一边换路线。正文保持简短，末尾用 {"control":{"action":"accept","assignmentId":"对应 id"}} 或 revise 加 reason。', `This turn is only for communication and evaluation, with no tools; that doesn't mean the execution turn has no tools either. Clearly restate the main tool/key steps you plan to use, and say whether they exactly match the approved plan; only accept if they do. If you want to switch to a rejected method, you must revise with new evidence — you can't claim to agree while changing route. Keep the body short, and end with {"control":{"action":"accept","assignmentId":"the matching id"}} or revise with a reason.`)
        : ""
    );
    if (myRole === "LEADER") {
      stable(
        "",
        p("你是这个会话的负责人。除了正常发言，必要时可以在**最后一行**附一个控制块来实际改变讨论走向：", "You are the lead of this conversation. Besides speaking normally, when needed you can attach a control block on the **last line** to actually change where the discussion goes:"),
        p('{"control":{"action":"stop","reason":"结论已经有了，不用再展开"}}', '{"control":{"action":"stop","reason":"We already have the conclusion; no need to go further"}}'),
        p('{"control":{"action":"assign","to":"成员花名","assignment":"要它做的事"}}', '{"control":{"action":"assign","to":"member nickname","assignment":"what you want them to do"}}'),
        p('{"control":{"action":"assign","assignments":[{"to":"成员 id","assignment":"独立产物、指导建议、验收条件"},{"to":"另一成员 id","assignment":"另一独立工作"}]}}', '{"control":{"action":"assign","assignments":[{"to":"member id","assignment":"independent output, guidance, acceptance criteria"},{"to":"another member id","assignment":"another independent piece of work"}]}}'),
        p('{"control":{"action":"refocus","topic":"把话题拉回到这里"}}', '{"control":{"action":"refocus","topic":"bring the topic back here"}}'),
        p("提出分工后你会获得继续自己工作的轮次；可先交代自己要承担的工作。接收者提出异议时讨论后重新 assign。收到结果时检查实际产物，不要仅根据对方自述声称完成。小任务可直接自己完成。", "After proposing assignments you'll get turns to continue your own work; you can state the work you'll take on first. When a recipient objects, discuss and assign again. When you receive results, check the actual outputs; don't claim completion based only on the other side's own account. Small tasks can be done directly by yourself.")
      );
    }

    // The caller decides whether this thread still needs the stable half; it also
    // owns the turn-level protocol blocks, so the whole decision lives in one place.
    const protocol=instruction.filter(item=>item.stable).map(item=>item.text).join("\n");
    const body=instruction.filter(item=>!item.stable).map(item=>item.text).join("\n");

    const said = lines.length
      ? p("自你上次发言以来的新消息：\n", "New messages since you last spoke:\n") + lines.join("\n")
      : p("（没有新消息）", "(No new messages)");
    const compose = (dialogue: string) => [
      identity,
      "",
      charterLines.join("\n"),
      "",
      teamLines.join("\n"),
      memoryLines.length ? "\n" + memoryLines.join("\n\n") : "",
      "",
      dialogue,
      "",
      body
    ]
      .filter((part) => part !== "")
      .join("\n");

    return {
      prompt: compose(said),
      app: compose(""),
      dialogue: said,
      contextMessages:lines,
      protocol,
      deliveredState,
      upToSeq: fresh.length ? fresh[fresh.length - 1].seq : sinceSeq
    };
  }

  private async recordProposalReply(conversation: Conversation, agent: UserRef, assignment: NonNullable<Message["coordination"]>, action: "accept" | "revise", reply: string, source: string, context: SchedulerContext): Promise<void> {
    const accepted = action === "accept";
    const notice = await this.deps.store.appendMessage({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:agent.userId,type:"TASK",
      content:p(`${agent.displayName} ${accepted ? "已同意方案，进入执行" : "提出分工问题，待 Leader 讨论"}：\n${reply || assignment.brief}`, `${agent.displayName} ${accepted ? "agreed to the plan and is starting execution" : "raised a question about the assignment, pending Leader discussion"}:\n${reply || assignment.brief}`),
      mentions:conversation.members.filter(m=>m.role==="LEADER" && m.userId!==agent.userId).map(m=>m.userId),coordination:{...assignment,phase:accepted ? "accepted" : "revision"}});
    if (!accepted) await this.planner.transition(conversation.conversationId,assignment,"blocked");
    await this.deps.log("assignment-response",{conversation:conversation.conversationId,agent:agent.userId,assignmentId:assignment.id,action,source,messageId:notice.messageId});
    await this.dispatch(conversation,notice,context);
    if (accepted) {
      const fresh = await this.deps.store.getConversation(conversation.conversationId);
      if (fresh) this.rememberPending(fresh,agent,context,fresh.lastSeq,true);
    }
  }

  private async recoverProposal(conversation: Conversation, agent: UserRef, assignment: NonNullable<Message["coordination"]>, context: SchedulerContext, reply: string): Promise<void> {
    if ((assignment.protocolAttempts ?? 0) >= 1) {
      await this.recordProposalReply(conversation,agent,assignment,"revise",p(`接单意图仍待澄清，请讨论后调整方案，不代表能力不可用。成员原文：\n${reply || "（空回复）"}`, `The intent to accept is still unclear; please discuss and adjust the plan. This doesn't mean the capability is unavailable. Member's words:\n${reply || "(empty reply)"}`),"unresolved",context);
      return;
    }
    const notice = await this.deps.store.appendMessage({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:agent.userId,type:"TASK",mentions:[],
      content:p(`${agent.displayName} 的接单意图待澄清，本轮尚未执行。请用一句普通话说明同意、疑问或替代方案；当前分工 ${assignment.id}。没有真实工具事件的标签不表示执行成功。成员原文：\n${reply || "（空回复）"}`, `${agent.displayName}'s intent to accept needs clarifying, and nothing has run this turn. Please state in one plain sentence whether you agree, have a question or an alternative; current assignment ${assignment.id}. A tag without a real tool event doesn't mean execution succeeded. Member's words:\n${reply || "(empty reply)"}`),
      coordination:{...assignment,protocolAttempts:1}});
    await this.deps.log("assignment-protocol-repair",{conversation:conversation.conversationId,agent:agent.userId,assignmentId:assignment.id});
    this.rememberPending(conversation,agent,context,notice.seq,true);
  }

  private async assignmentFor(conversationId: string, assigneeId: string): Promise<Message["coordination"]> {
    if ((await this.deps.store.getConversation(conversationId))?.type === "DIRECT") return undefined;
    const messages = await this.deps.store.listMessages(conversationId, { limit: 1000 });
    return messages.slice().reverse().find(message => message.coordination?.assigneeId === assigneeId && !((this.deps.maxConcurrentWorkPerAgent ?? 1) > 1 && message.coordination.workId))?.coordination;
  }

  private async applyLeaderControl(conversation: Conversation, speaker: UserRef, reply: string, context: SchedulerContext, alreadySaved = false, basisPlan?: WorkItem[], stillValid?: () => Promise<boolean>): Promise<string> {
    if (conversation.type !== "GROUP") return reply;
    const { visible, control } = parseLeaderControl(reply);
    if (brainstorming((await this.deps.store.getConversation(conversation.conversationId)) ?? conversation)) {
      if (control) await this.deps.log("brainstorm-control-deferred",{conversation:conversation.conversationId,agent:speaker.userId,action:control.action});
      return visible;
    }
    const role = conversation.members.find(member => member.userId === speaker.userId)?.role;
    const current = await this.assignmentFor(conversation.conversationId, speaker.userId);
    const say = async (content: string, mentions: string[] = [], coordination?: Message["coordination"]): Promise<Message> => {
      const message = await this.deps.store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: newId("message"), senderId: speaker.userId, type: "TASK", internal:!coordination, content, mentions, coordination });
      const fresh = await this.deps.store.getConversation(conversation.conversationId);
      if (fresh) await this.dispatch(fresh, message, context);
      return message;
    };
    const leaderIds = conversation.members.filter(member => member.role === "LEADER").map(member => member.userId);
    if (role !== "LEADER") {
      if (control?.action === "accept" || control?.action === "revise") {
        if (!current || current.phase !== "proposal" || current.id !== control.assignmentId) {
          // An obsolete receipt is not new coordination input. Persist the fact for
          // the worker/UI, but never wake a Leader (possibly in a tool-using work
          // lane) or publish the stale proposal as an ordinary peer message.
          await this.deps.store.appendMessage({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:speaker.userId,
            type:"TASK",internal:true,content:p(`${speaker.displayName} 的接单未生效：分工已变化，请按最新方案确认。`, `${speaker.displayName}'s acceptance didn't take effect: the assignment has changed; please confirm against the latest plan.`)});
          await this.deps.log("stale-assignment-receipt-ignored",{conversation:conversation.conversationId,agent:speaker.userId,assignmentId:control.assignmentId});
          return "";
        }
        const accepted = control.action === "accept";
        if (!accepted) await this.planner.transition(conversation.conversationId,current,"blocked");
        await say(p(`${speaker.displayName} ${accepted ? "已同意方案，开始执行" : "提出分工异议"}：${control.reason || visible || current.brief}`, `${speaker.displayName} ${accepted ? "agreed to the plan and is starting execution" : "objected to the assignment"}: ${control.reason || visible || current.brief}`), leaderIds,
          { ...current, phase: accepted ? "accepted" : "revision" });
        if (accepted) {
          const fresh = await this.deps.store.getConversation(conversation.conversationId);
          if (fresh) this.rememberPending(fresh, speaker, context, fresh.lastSeq, true);
        }
        return "";
      }
      return visible;
    }
    if (!control) return reply;
    // organize used to pick an internal discussion/execution mode; that mode is gone, so it changes nothing.
    if (control.action === "organize") return visible;
    // The first ad-hoc delegation in a group gives the Leader another turn to carry on with its own share
    // (plan work, the Leader's own included, runs in work lanes and needs no extra coordination turn).
    if (conversation.type === "GROUP" && control.action === "assign" && !conversation.workPlan?.length && !(await this.hasOpenWork(conversation)) &&
        conversation.members.some(member => member.userId === speaker.userId && member.role === "LEADER")) {
      this.rememberPending(conversation, speaker, context, conversation.lastSeq, true);
    }
    if (["plan", "review", "batch"].includes(control.action)) {
      const actions = control.action === "batch" ? control.actions! : [control];
      const basis = basisPlan && structuredClone(basisPlan);
      let applied = 0;
      for (const action of actions) {
        if (stillValid && !(await stillValid())) break;
        const fresh = await this.deps.store.getConversation(conversation.conversationId);
        if (!fresh || fresh.paused || fresh.status !== "ACTIVE" || !fresh.members.some(m=>m.userId===speaker.userId && m.role==="LEADER")) break;
        try {
          if (action.action === "plan") await this.planner.merge(conversation.conversationId,action.work!,basis);
          else {
            const item = basis?.find(w=>w.id===action.workId);
            if (basis && !item) throw new Error(p("本轮未读取这项交付，请读取后再复核。", "This delivery wasn't read this turn; read it before reviewing."));
            await this.planner.review(conversation.conversationId,action.workId!,action.verdict!,action.evidence!,item);
          }
          applied++;
          // Allow dependencies changed by our own preceding decisions, never unrelated concurrent changes.
          if (basis) {
            const ids = action.action === "plan" ? action.work!.map(w=>w.id) : [action.workId!];
            const latest = (await this.deps.store.getConversation(conversation.conversationId))?.workPlan ?? [];
            for (const id of ids) {
              const updated = latest.find(w=>w.id===id);
              const index = basis.findIndex(w=>w.id===id);
              if (updated) { if (index<0) basis.push(structuredClone(updated)); else basis[index]=structuredClone(updated); }
            }
          }
        } catch (error) {
          await say(p(`工作计划未生效（${action.workId ?? action.work?.map(w=>w.id).join("、") ?? action.action}）：${error instanceof Error ? error.message : String(error)}`, `Work plan didn't take effect (${action.workId ?? action.work?.map(w=>w.id).join(", ") ?? action.action}): ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (control.action === "batch") await this.deps.log("work-batch-applied",{conversation:conversation.conversationId,requested:actions.length,applied});
      if (applied) {
        // Apply the decisions before filling once; do not launch an intermediate, superseded plan.
        await this.fillWork(conversation.conversationId);
        // After the Leader's current turn ends it can take its own work; with no work of its own, it follows up on acceptance/next planning.
        const fresh = await this.deps.store.getConversation(conversation.conversationId);
        // A plan already launched its work lanes, so it needs no acknowledgement.
        // Concurrent deliveries may share one input watermark while the model
        // reviews only one of them. Keep draining explicit review state even
        // when there is no newer message; otherwise the task can look idle with
        // an accepted result stranded forever.
        const hasPendingReview=fresh?.workPlan?.some(work=>work.status==="review") ?? false;
        if (fresh && !actions.some(action=>action.action==="plan") &&
            (hasPendingReview || actions.some(action=>action.action==="review" && action.verdict==="retry"))) {
          this.rememberPending(fresh,speaker,context,fresh.lastSeq,true);
        }
      }
      return p(`调度处理完成：${applied}/${actions.length} 项决定已生效。${applied===actions.length ? "执行成员以已登记分工为准。" : "未生效部分保留待处理，不能按原提议执行；详见失败原因。"}`, `Scheduling done: ${applied}/${actions.length} decisions took effect. ${applied===actions.length ? "Executing members follow the registered assignments." : "The parts that didn't take effect are kept pending and can't be executed as originally proposed; see the failure reasons."}`);
    }
    if (control.action === "interrupt") {
      const fresh = await this.deps.store.getConversation(conversation.conversationId);
      const work = fresh?.workPlan?.find(w=>w.id===control.workId);
      const lane = this.workLanes.get(control.assignmentId!);
      if (!fresh || fresh.paused || fresh.status!=="ACTIVE" || !fresh.members.some(m=>m.userId===speaker.userId && m.role==="LEADER") ||
          work?.status!=="active" || work.assignmentId!==control.assignmentId || !lane || lane.conversationId!==conversation.conversationId) {
        await say(p("单项中断未生效：工作已完成、分工版本已变化或没有对应运行通道。", "The single-item interruption didn't take effect: the work is already done, the assignment version changed, or there's no matching execution lane."),leaderIds);
        return visible;
      }
      const assignment = await lane.scheduler.assignmentFor(conversation.conversationId,lane.agentId);
      if (!assignment || assignment.id!==control.assignmentId) return visible;
      const redirected=!!control.assignment;
      const targetId=control.to || lane.agentId;
      const target=redirected ? await this.deps.store.getUser(targetId) : undefined;
      if(redirected && (!target?.isAgent || !fresh.members.some(member=>member.userId===targetId && member.role!=="OBSERVER" && !member.paused && !member.ownerPaused))){
        await say(p(`单项中断未生效：接管目标 ${targetId} 不是当前可执行成员。`, `The single-item interruption didn't take effect: the takeover target ${targetId} isn't a member who can execute right now.`),leaderIds);
        return visible;
      }
      const changed=redirected
        ? await this.planner.redirect(conversation.conversationId,speaker.userId,assignment,control.assignment!,control.evidence!,()=>lane.scheduler.gate.cancel(conversation.conversationId),targetId)
        : await this.planner.interrupt(conversation.conversationId,speaker.userId,assignment,()=>lane.scheduler.gate.cancel(conversation.conversationId));
      if (!changed) {
        await say(p("单项中断未生效：工作状态已变化，请检查最新结果。", "The single-item interruption didn't take effect: the work state has changed; check the latest results."),leaderIds);
        return visible;
      }
      await lane.scheduler.stopConversation(conversation.conversationId);
      await say(redirected
        ? p(`Leader 已根据检查中断工作 ${work.id} 的旧执行分支。问题证据：${control.evidence}。纠正要求：${control.assignment}。已有产物保留；${targetId===lane.agentId?"原执行者":"接管者"}将在读取本条纠正后直接续做同一工作。`, `After checking, the Leader interrupted the old execution branch of work ${work.id}. Evidence of the problem: ${control.evidence}. Correction required: ${control.assignment}. Existing outputs are kept; ${targetId===lane.agentId?"the original executor":"the new owner"} will continue the same work right after reading this correction.`)
        : p(`Leader 已根据检查中断工作 ${work.id}。问题证据：${control.evidence}。请讨论解决方向：${control.reason}。已有产物保留，其他工作继续；讨论后更新方案再派发。`, `After checking, the Leader interrupted work ${work.id}. Evidence of the problem: ${control.evidence}. Please discuss how to resolve it: ${control.reason}. Existing outputs are kept and other work continues; update the plan after discussion and dispatch again.`),[lane.agentId,...leaderIds],{...assignment,phase:"revision"});
      return visible;
    }
    if (control.action === "stop") {
      // Pausing invalidates the lease, so save the last actual deliverable first.
      if (visible && !alreadySaved) await this.deps.store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: newId("message"), senderId: speaker.userId, content: visible });
      await this.stopConversation(conversation.conversationId);
      await say(p(`本轮已暂停${control.reason ? `：${control.reason}` : ""}。`, `This turn has been paused${control.reason ? `: ${control.reason}` : ""}.`));
      return "";
    }
    if (control.action === "refocus") {
      await say(p(`调整方向：${control.topic ?? control.reason ?? ""}`, `Change of direction: ${control.topic ?? control.reason ?? ""}`));
      return visible;
    }
    if (control.action !== "assign") return visible;
    const assignments = control.assignments?.length ? control.assignments : [{ to: control.to!, assignment: control.assignment ?? p("请先讨论分工方案", "Please discuss the assignment plan first") }];
    const seen = new Set<string>();
    for (const entry of assignments) {
      const fresh = await this.deps.store.getConversation(conversation.conversationId);
      if (!fresh || fresh.paused || fresh.status !== "ACTIVE") break;
      const candidates = (await Promise.all(fresh.members.map(member => this.deps.store.getUser(member.userId))))
        .filter((user): user is UserRef => !!user?.isAgent && (user.userId === entry.to || user.displayName === entry.to));
      const target = candidates.length === 1 ? candidates[0] : undefined;
      const member = fresh.members.find(item => item.userId === target?.userId);
      const recovery = target && (await this.deps.store.getAgentSession(conversation.conversationId,target.userId))?.recovery;
      const failure = !target ? (candidates.length > 1
        ? {code:"ambiguous-member",reason:p(`名称匹配 ${candidates.length} 个成员，请使用唯一成员 id。`, `The name matches ${candidates.length} members; use a unique member id.`)}
        : {code:"member-not-found",reason:p("目标不在本会话的 Agent 成员中，请核对成员 id 或重新选择。", "The target isn't one of this conversation's Agent members; check the member id or choose again.")})
        : member?.paused ? {code:"member-paused",reason:p("成员已暂停；请改派其他可用成员。若必须使用此成员，请主人恢复该成员后继续。", "The member is paused; reassign to another available member. If this member must be used, the task owner needs to resume them first.")}
        : member?.role === "OBSERVER" ? {code:"observer",reason:p("成员是观察员，不能执行；请改派执行成员。", "The member is an observer and can't execute; reassign to an executing member.")}
        : !this.deps.resolveDiscovered(target.userId) ? {code:"agent-not-discovered",reason:p("当前节点未发现该 Agent；请改派其他成员，或请主人检查安装和节点连接。", "This Agent wasn't found on the current node; reassign to another member, or have the task owner check the installation and node connection.")}
        : !this.deps.isAgentReady(target) ? {code:"agent-unavailable",reason:this.deps.agentUnavailableReason?.(target) ?? p("Agent 当前不可用；请改派其他成员，若必须使用此成员，请主人检查 Agent 连接与可用状态。", "The Agent is currently unavailable; reassign to another member. If this member must be used, have the task owner check the Agent's connection and availability.")}
        : recovery ? {code:"connection-recovery",reason:recovery.state === "blocked" ? p("连接自动恢复已失败；请改派其他成员，或请主人恢复连接后继续会话。", "Automatic connection recovery has failed; reassign to another member, or have the task owner restore the connection and continue the conversation.") : p("连接正在自动重试；请等待恢复结果或改派其他成员，不重复创建分工。", "The connection is retrying automatically; wait for the recovery result or reassign to another member, without creating a duplicate assignment.")}
        : undefined;
      if (failure) {
        const rejection = p(`分工未派发给「${entry.to}」：${failure.reason}`, `Assignment not dispatched to "${entry.to}": ${failure.reason}`);
        const recent = await this.deps.store.listMessages(conversation.conversationId, { limit: 100 });
        if (!recent.some(message => message.content === rejection)) {
          // Actionable failures must be visible in chat, not hidden operational receipts.
          const notice = await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:speaker.userId,type:"TASK",content:rejection});
          this.rememberPending(fresh,speaker,context,notice.seq,true);
        }
        await this.deps.log("assignment-rejected", {conversation:conversation.conversationId,to:entry.to,code:failure.code,reason:failure.reason});
        continue;
      }
      if (!target) continue;
      if (seen.has(target.userId)) {
        const notice=await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:speaker.userId,type:"TASK",
          content:p(`分工未派发给「${target.displayName}」：本批 assign 已为该成员登记另一项工作。多项独立工作请分别登记到 plan 队列，系统可并行启动；本条尚未执行：${entry.assignment}`, `Assignment not dispatched to "${target.displayName}": this batch of assign already registered another piece of work for this member. Register several independent pieces of work separately in the plan queue so the system can start them in parallel; this one hasn't run yet: ${entry.assignment}`)});
        this.rememberPending(fresh,speaker,context,notice.seq,true);
        await this.deps.log("assignment-rejected",{conversation:conversation.conversationId,to:target.userId,code:"duplicate-target-use-plan"});
        continue;
      }
      const previous = await this.assignmentFor(conversation.conversationId, target.userId);
      if (previous?.phase === "accepted" || previous?.phase === "proposal") {
        await say(p(`${target.displayName} 已有${previous.phase === "accepted" ? "执行中" : "待确认"}的分工，请先等其回报或沟通调整，未重复派发。`, `${target.displayName} already has an assignment ${previous.phase === "accepted" ? "in progress" : "awaiting confirmation"}; wait for their report or discuss an adjustment first. Not dispatched again.`));
        continue;
      }
      seen.add(target.userId);
      const self = target.userId === speaker.userId;
      const input: Parameters<Store["appendMessage"]>[0] = {
        conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:speaker.userId,type:"TASK",mentions:[target.userId],
        content:self ? p(`Leader 开始承担分工：${entry.assignment}`, `The Leader is taking on an assignment: ${entry.assignment}`) : p(`请 ${target.displayName} 评估并确认分工：${entry.assignment}`, `${target.displayName}, please evaluate and confirm the assignment: ${entry.assignment}`),
        coordination:{id:newId("message"),assigneeId:target.userId,phase:self ? "accepted" : "proposal",brief:entry.assignment}
      };
      // Retry the same durable message id, never create a second assignment after an uncertain write.
      let delivered: Message | undefined;
      let saveError: unknown;
      let attempts = 0;
      for (let attempt=1;attempt<=3;attempt++) {
        const latest = await this.deps.store.getConversation(conversation.conversationId);
        if (!latest || latest.paused || latest.status !== "ACTIVE" || (stillValid && !await stillValid())) break;
        attempts = attempt;
        try { delivered = await this.deps.store.appendMessage(input); break; }
        catch (error) {
          saveError = error;
          await this.deps.log("assignment-save-retry",{conversation:conversation.conversationId,to:target.userId,attempt,error:String(error),retryable:retryableStoreError(error)});
          if (!retryableStoreError(error)) break;
        }
      }
      if (!delivered) {
        if (!saveError || (stillValid && !await stillValid())) continue;
        const content = p(`分工保存未确认：${target.displayName} 的任务未启动。保存尝试 ${attempts} 次后失败：${storeFailureReason(saveError)}。请处理存储问题后继续会话；不要重复派发同一工作。`, `The assignment save wasn't confirmed: ${target.displayName}'s task didn't start. Saving failed after ${attempts} attempts: ${storeFailureReason(saveError)}. Resolve the storage problem and continue the conversation; don't dispatch the same work again.`);
        this.emitProgress(conversation.conversationId,speaker.userId,content);
        await this.persistAgentReply({conversationId:conversation.conversationId,clientMessageId:newId("message"),senderId:speaker.userId,type:"TASK",content}).catch(()=>undefined);
        continue;
      }
      const updated = await this.deps.store.getConversation(conversation.conversationId);
      if (updated) {
        if (self) this.rememberPending(updated,speaker,context,delivered.seq,true);
        else await this.dispatch(updated,delivered,context);
      }
      await this.deps.log("assignment-proposed", { conversation: conversation.conversationId, agent: target.userId });
    }
    // The turn that issued the assignments has ended; let the leader do its own work while other members evaluate.
    const fresh = await this.deps.store.getConversation(conversation.conversationId);
    if (fresh && seen.size) this.rememberPending(fresh, speaker, context, fresh.lastSeq, true);
    return visible;
  }

  /** When an Agent is idle, consume reports first; only continue ordinary unread messages when there are none. */
  private kickAgentWork(agentUserId: string): void {
    if (this.shuttingDown) return;
    // A work lane is a real provider/tool turn even though it lives in a child
    // scheduler. Never start the Agent's main coordination session beside it;
    // urgent chat has its explicitly tool-free inbox lane.
    if (this.runningTurns.has(agentUserId) || this.inboxes.has(agentUserId) || this.laneCount(agentUserId)>0) return;
    if ((this.pendingReports.get(agentUserId)?.length ?? 0) > 0) {
      void this.runReportQueue(agentUserId).catch(() => undefined);
      return;
    }
    const pending = this.takePending(agentUserId);
    if (pending) {
      void this.runAgentTurn(pending.conversation, pending.agent, pending.context).catch(
        () => undefined
      );
    }
  }

  /** Starts the Leader's report queue from idle. */
  private runReportQueue(agentUserId: string): Promise<void> {
    return this.track(this.runReportQueueNow(agentUserId));
  }

  private async runReportQueueNow(agentUserId: string): Promise<void> {
    if (this.runningTurns.has(agentUserId)) return;
    const first = this.pendingReports.get(agentUserId)?.[0];
    if (!first) return;
    this.markBusy(first.conversationId, agentUserId, true);
    try {
      await this.drainPendingReports(agentUserId);
    } finally {
      this.markBusy(first.conversationId, agentUserId, false);
      this.kickAgentWork(agentUserId);
      await this.followUpIdleConversation(first.conversationId,first.context);
    }
  }

  /** After the current reply ends, finish already-requested reports before the next ordinary message. */
  private async drainPendingReports(agentUserId: string): Promise<void> {
    while (true) {
      const queue = this.pendingReports.get(agentUserId);
      const request = queue?.shift();
      if (!queue || !request) {
        this.pendingReports.delete(agentUserId);
        return;
      }
      if (queue.length === 0) this.pendingReports.delete(agentUserId);
      try {
        request.resolve(await this.executeReport(request.conversationId, request.leader));
      } catch (error) {
        request.reject(error);
      }
    }
  }

  private cancelPendingReports(
    conversationId: string,
    reason: string,
    agentUserId?: string
  ): void {
    const entries = agentUserId
      ? [[agentUserId, this.pendingReports.get(agentUserId) ?? []] as const]
      : Array.from(this.pendingReports.entries());
    for (const [userId, queue] of entries) {
      const keep: PendingReport[] = [];
      for (const request of queue) {
        if (request.conversationId === conversationId) request.reject(new Error(reason));
        else keep.push(request);
      }
      if (keep.length) this.pendingReports.set(userId, keep);
      else this.pendingReports.delete(userId);
    }
  }

  private rememberPending(
    conversation: Conversation,
    agent: UserRef,
    context: SchedulerContext,
    afterSeq: number,
    force = false,
    interactive = false,
    steerFallback = false
  ): void {
    let pending = this.pendingTurns.get(agent.userId);
    if (!pending) {
      pending = new Map();
      this.pendingTurns.set(agent.userId, pending);
    }
    const previous = pending.get(conversation.conversationId);
    pending.set(conversation.conversationId, {
      conversation,
      agent,
      context,
      afterSeq: Math.max(previous?.afterSeq ?? 0, afterSeq),
      force: force || (previous?.force ?? false),
      handledThrough: previous?.handledThrough,
      interactive: interactive || previous?.interactive,
      steerFallback: steerFallback && (!previous || !!previous.steerFallback)
    });
    this.emitQueue();
  }

  private async hasUnreadFromOthers(
    conversation: Conversation,
    agent: UserRef
  ): Promise<boolean> {
    const member = conversation.members.find((item) => item.userId === agent.userId);
    let afterSeq = member?.lastProcessedSeq ?? member?.lastReadSeq ?? 0;
    if (afterSeq >= conversation.lastSeq) return false;

    while (afterSeq < conversation.lastSeq) {
      const messages = await this.deps.store.listMessages(conversation.conversationId, {
        afterSeq,
        limit: 100
      });
      if (!messages.length) return false;
      // Everyone reads ordinary messages, @ included; only a delegation for someone else isn't this Agent's to pick up.
      if (messages.some((message) => message.senderId !== agent.userId && !message.failed && !message.report && !isTeamRelay(message) && (!message.coordination || message.mentions.includes(agent.userId)))) {
        return true;
      }
      afterSeq = messages[messages.length - 1].seq;
      if (messages.length < 100) return false;
    }
    return false;
  }

  private takePending(agentUserId: string): PendingTurn | undefined {
    const pending = this.pendingTurns.get(agentUserId);
    if (!pending) return undefined;
    // Explicit user input gets the next turn before automatic continuation.
    const interactive = [...pending].find(([, turn]) => turn.interactive);
    const first = interactive ? { done: false as const, value: interactive } : pending.entries().next();
    if (first.done) {
      this.pendingTurns.delete(agentUserId);
      return undefined;
    }
    const [conversationId, turn] = first.value;
    pending.delete(conversationId);
    if (pending.size === 0) this.pendingTurns.delete(agentUserId);
    this.emitQueue();
    return turn;
  }

  private markBusy(conversationId: string, agentUserId: string, busy: boolean): void {
    const currentConversationId = this.runningTurns.get(agentUserId);
    if (busy) {
      if (currentConversationId === conversationId) return;
      if (currentConversationId) {
        this.deps.broadcast("agent:busy", {
          agentUserId,
          conversationId: currentConversationId,
          busy: false,
          revision: ++this.runtimeRevision
        });
      }
      this.runningTurns.set(agentUserId, conversationId);
      this.startedAt.set(agentUserId,Date.now());
      this.deps.broadcast("agent:busy", { agentUserId, conversationId, busy: true, revision: ++this.runtimeRevision });
      return;
    }
    if (!currentConversationId) return;
    this.runningTurns.delete(agentUserId);
    this.startedAt.delete(agentUserId);
    this.progress.delete(agentUserId);
    this.deps.broadcast("agent:busy", {
      agentUserId,
      conversationId: currentConversationId,
      busy: this.inboxes.has(agentUserId) || this.laneCount(agentUserId)>0,
      revision: ++this.runtimeRevision
    });
  }

  private unavailableOutcome(error: string): AgentTurnOutcome {
    return {
      ok: false,
      error,
      steps: [],
      cancelled: false,
      metrics: { iterations: 0, sideEffects: false }
    };
  }
}

function roleLabel(role: MemberRole): string {
  switch (role) {
    case "LEADER":
      return p("负责人", "Lead");
    case "REVIEWER":
      return p("评审", "Reviewer");
    case "OBSERVER":
      return p("旁观（不参与发言）", "Observer (doesn't speak)");
    default:
      return p("工程师", "Engineer");
  }
}
