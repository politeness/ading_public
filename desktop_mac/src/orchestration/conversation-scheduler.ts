import { LocalScheduler, type LocalSchedulerDeps, type SchedulerContext } from "./local-scheduler";
import type { CreateConversationInput, Store } from "../store/store";
import { tm } from "../i18n";

/** Each task owns its queue, sessions and CLI process keys; Agent identity remains shared. */
export class ConversationScheduler {
  private readonly conversations = new Map<string, LocalScheduler>();
  private revision = 0;
  private readonly ownerPauseSync = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private readonly monitor?: ReturnType<typeof setInterval>;
  constructor(private readonly deps: LocalSchedulerDeps) {
    if (deps.teamMonitorIntervalMs !== 0) {
      this.monitor = setInterval(() => {
        if (deps.systemAsleep?.()) return;
        for (const scheduler of this.conversations.values()) void scheduler.monitorTeams().catch(error=>deps.log("team-monitor-failed",{error:String(error)}));
      }, deps.teamMonitorIntervalMs ?? 15_000);
      this.monitor.unref();
    }
  }

  private forConversation(conversationId: string): LocalScheduler {
    let scheduler = this.conversations.get(conversationId);
    if (scheduler) return scheduler;
    if (this.shuttingDown) throw new Error(tm("orch.app.exiting"));
    const store = new Proxy(this.deps.store, {
      get: (target, key) => {
        if (key === "listConversations") return async () => (await target.listConversations()).filter(conversation => conversation.conversationId === conversationId);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    scheduler = new LocalScheduler({
      ...this.deps,
      store,
      resolveDiscovered: userId => {
        const agent = this.deps.resolveDiscovered(userId);
        // Adapters use localUuid solely to own/cancel a CLI run; provider threadId
        // still comes from the existing (conversationId, userId) session store.
        return agent ? {...agent, localUuid: `${agent.localUuid}::task:${conversationId}`} : undefined;
      },
      broadcast: (channel, payload) => {
        if (channel === "agent:queue") {
          this.deps.broadcast(channel, {revision: ++this.revision, queued: this.runtimeSnapshot().queued});
        } else if (channel === "agent:busy" || channel === "agent:progress") {
          this.deps.broadcast(channel, {...payload as object, revision: ++this.revision});
        } else this.deps.broadcast(channel, payload);
      }
    });
    this.conversations.set(conversationId, scheduler);
    return scheduler;
  }

  runtimeSnapshot(): AgentRuntimeSnapshot {
    const snapshots = [...this.conversations.values()].map(conversation => conversation.runtimeSnapshot());
    return {revision: this.revision, agents: snapshots.flatMap(s => s.agents), queued: snapshots.flatMap(s => s.queued ?? [])};
  }

  async createConversation(input: CreateConversationInput, context: SchedulerContext = null): Promise<Conversation> {
    if (this.shuttingDown) throw new Error(tm("orch.app.exiting"));
    // Reuse creation validation, but route the first message into its own executor.
    const creator = new LocalScheduler(this.deps);
    return creator.createConversation(input, context, (conversation, message, source) => this.dispatch(conversation, message, source));
  }

  dispatch(conversation: Conversation, message: Message, context: SchedulerContext = null): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return this.forConversation(conversation.conversationId).dispatch(conversation, message, context);
  }
  sendUserMessage(input: {conversationId: string; clientMessageId: string; content: string; mentions?: string[]}, context: SchedulerContext = null): Promise<Message> {
    return this.forConversation(input.conversationId).sendUserMessage(input, context);
  }
  receiveRemoteUserMessage(message: Message): Promise<boolean> {
    if (this.shuttingDown) return Promise.resolve(false);
    return this.forConversation(message.conversationId).receiveRemoteUserMessage(message);
  }
  /** Online edition: messages from Agents on other computers that need local handling (assignments, results, discussion replies) */
  receiveRemoteAgentMessage(message: Message): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return this.forConversation(message.conversationId).receiveRemoteAgentMessage(message);
  }
  /** Availability of a local or remote Agent changed: re-decide which computer coordinates */
  async teamAvailabilityChanged(): Promise<void> {
    if (this.shuttingDown) return;
    // Open group tasks are checked even before they receive a message this session, so work stranded on a computer that left is released.
    const open = (await this.deps.store.listConversations()).filter(c => c.type === "GROUP" && c.status === "ACTIVE" && !c.paused &&
      ((c.brainstorm && c.brainstorm.phase !== "ready") || c.workPlan?.some(w => w.status !== "done")));
    const ids = new Set([...this.conversations.keys(), ...open.map(c => c.conversationId)]);
    await Promise.all([...ids].map(id => {
      const firstLook = !this.conversations.has(id);
      return this.forConversation(id).teamAvailabilityChanged(firstLook);
    }));
  }
  /** After restart, re-trigger a user message from the "unfinished" ledger */
  redeliverUserMessage(message: Message): Promise<boolean> {
    if (this.shuttingDown) return Promise.resolve(false);
    return this.forConversation(message.conversationId).redeliverUserMessage(message);
  }
  updateConversation(conversationId: string, patch: Parameters<Store["updateConversation"]>[1], context: SchedulerContext = null): Promise<Conversation> {
    return this.forConversation(conversationId).updateConversation(conversationId, patch, context);
  }
  reportConversation(conversationId: string, context: SchedulerContext = null): Promise<Message> {
    return this.forConversation(conversationId).reportConversation(conversationId, context);
  }
  removeMember(conversationId: string, userId: string): Promise<Conversation> {
    return this.forConversation(conversationId).removeMember(conversationId, userId);
  }
  speakInConversation(conversation: Conversation, agent: UserRef, prompt: string): Promise<AgentTurnOutcome> {
    return this.forConversation(conversation.conversationId).speakInConversation(conversation, agent, prompt);
  }
  syncOwnerPauses(conversationId: string): Promise<void> {
    const previous = this.ownerPauseSync.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const existing = this.conversations.get(conversationId);
      if (existing) return existing.syncOwnerPauses(conversationId);
      const conversation = await this.deps.store.getConversation(conversationId);
      if (conversation?.members.some(member => member.ownerPaused)) {
        await this.forConversation(conversationId).syncOwnerPauses(conversationId);
      }
    });
    this.ownerPauseSync.set(conversationId, next);
    void next.finally(() => { if (this.ownerPauseSync.get(conversationId) === next) this.ownerPauseSync.delete(conversationId); }).catch(() => {});
    return next;
  }
  async stopConversation(conversationId: string): Promise<number> {
    // A remote request may arrive before this node has started a local lane.
    return this.forConversation(conversationId).stopConversation(conversationId);
  }
  /** Conversations that were paused and not yet continued; the UI uses this to switch the pause button to "Continue" */
  stoppedConversationIds(): string[] {
    return [...this.conversations].filter(([id, scheduler]) => scheduler.isStopped(id)).map(([id]) => id);
  }
  /** Clicking "Continue" after pausing: no new message needed; the Agent continues processing unfinished messages */
  async resumeConversation(conversationId: string): Promise<void> {
    await this.forConversation(conversationId).resumeConversation(conversationId);
  }
  async cancelRunningTurns(conversationId: string): Promise<number> {
    return this.stopConversation(conversationId);
  }
  async pauseUnavailableAgents(kind?: AgentKind): Promise<void> {
    await Promise.all([...this.conversations.values()].map(conversation => conversation.pauseUnavailableAgents(kind)));
  }
  async resumeReadyAgents(): Promise<void> {
    if (this.shuttingDown) return;
    await Promise.all([...this.conversations.values()].map(conversation => conversation.resumeReadyAgents()));
  }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.monitor) clearInterval(this.monitor);
    await Promise.all([...this.conversations.values()].map(conversation => conversation.shutdown()));
  }
}
