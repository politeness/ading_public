import { randomUUID } from "node:crypto";
import { tm } from "../i18n";

export type ConversationAction = "pause" | "resume";
export async function executeConversationControl(scheduler: {
  stopConversation: (id: string) => Promise<unknown>;
  resumeConversation: (id: string) => Promise<unknown>;
  runtimeSnapshot: () => AgentRuntimeSnapshot;
}, conversationId: string, action: ConversationAction, timeoutMs = 25_000): Promise<void> {
  if (action === "resume") { await scheduler.resumeConversation(conversationId); return; }
  await scheduler.stopConversation(conversationId);
  const deadline = Date.now() + timeoutMs;
  while (scheduler.runtimeSnapshot().agents.some(agent => agent.conversationId === conversationId && agent.busy)) {
    if (Date.now() >= deadline) throw new Error("Task cancellation timed out");
    await new Promise(resolve => setTimeout(resolve, Math.min(100, timeoutMs)));
  }
}
/**
 * Owner pause/resume: members on this computer are controlled here first, so a
 * remote rejection (offline computer, foreign Agent) never keeps them running.
 * Remote members are then controlled through the server; a remote failure after
 * a local success is reported as such instead of claiming nothing happened.
 */
export async function controlLocalThenRemote(action: ConversationAction, parts: {
  local?: () => Promise<number>;
  remote?: (localOk: boolean) => Promise<void>;
}): Promise<number> {
  let stopped = 0, localError: unknown;
  if (parts.local) {
    try { stopped = await parts.local(); } catch (error) { localError = error; }
  }
  // Pause is a safety action: remote members are still stopped when the local part failed.
  if (parts.remote && (localError === undefined || action === "pause")) {
    try { await parts.remote(localError === undefined); }
    catch (error) {
      if (!parts.local || localError !== undefined) throw localError ?? error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(tm(action === "pause" ? "main.control.remotePauseFailed" : "main.control.remoteResumeFailed", { reason }));
    }
  }
  if (localError !== undefined) throw localError;
  return stopped;
}
type Payload = Record<string, unknown>;
type Pending = {
  conversationId: string;
  action: ConversationAction;
  targets?: Set<string>;
  results: Map<string, boolean>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** A receipt means every execution computer acknowledged this exact task/action. */
export class ConversationControl {
  private readonly pending = new Map<string, Pending>();
  private readonly executed = new Map<string, { expiresAt: number; result: Promise<Payload> }>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly stopped = new Set<string>();
  /** Requests sent from here, with whether this computer's own part already succeeded. */
  private readonly own = new Map<string, boolean>();
  private closed = false;

  constructor(private readonly options: {
    send: (type: string, payload: Payload) => boolean;
    run: (conversationId: string, action: ConversationAction) => Promise<void>;
    timeoutMs?: number;
  }) {}

  stoppedIds(): string[] { return [...this.stopped]; }
  forget(conversationId: string): void { this.stopped.delete(conversationId); }

  /**
   * localOk: the caller has already controlled this computer's own members. The
   * server also routes the command back here; that echo only reports the outcome.
   */
  request(conversationId: string, action: ConversationAction, localOk?: boolean): Promise<void> {
    if (this.closed) return Promise.reject(new Error(tm("main.control.disconnected")));
    if ([...this.pending.values()].some(p => p.conversationId === conversationId)) {
      return Promise.reject(new Error(tm("main.control.pending")));
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(requestId, "main.control.timeout"), this.options.timeoutMs ?? 35_000);
      this.pending.set(requestId, { conversationId, action, results: new Map(), resolve, reject, timer });
      if (localOk !== undefined) {
        this.own.set(requestId, localOk);
        setTimeout(() => this.own.delete(requestId), 120_000).unref?.();
      }
      if (!this.options.send("CONVERSATION_CONTROL", { requestId, conversationId, action })) {
        this.fail(requestId, "main.control.disconnected");
      }
    });
  }

  receive(type: string, raw: unknown): void {
    if (this.closed || !raw || typeof raw !== "object") return;
    const payload = raw as Payload;
    const { requestId, conversationId, action } = payload;
    if (typeof requestId !== "string" || typeof conversationId !== "string" ||
        (action !== "pause" && action !== "resume")) return;
    if (type === "CONVERSATION_CONTROL") {
      void this.execute(payload, requestId, conversationId, action);
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending || pending.conversationId !== conversationId || pending.action !== action) return;
    if (type === "CONVERSATION_CONTROL_ACCEPTED") {
      if (payload.error) {
        this.fail(requestId, payload.error === "AGENT_009" ? "main.control.offline"
          : payload.error === "NODE_006" ? "main.control.presenceUnknown" : "main.control.rejected");
        return;
      }
      if (!Array.isArray(payload.terminalIds) || !payload.terminalIds.length ||
          !payload.terminalIds.every(id => typeof id === "string")) return;
      pending.targets = new Set(payload.terminalIds as string[]);
    } else if (type === "CONVERSATION_CONTROL_RESULT" && typeof payload.terminalId === "string" && typeof payload.ok === "boolean") {
      pending.results.set(payload.terminalId, payload.ok);
    } else return;
    if (!pending.targets) return;
    if ([...pending.targets].some(id => pending.results.get(id) === false)) {
      this.fail(requestId, "main.control.failed");
    } else if ([...pending.targets].every(id => pending.results.get(id) === true)) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (action === "pause") this.stopped.add(conversationId);
      else this.stopped.delete(conversationId);
      pending.resolve();
    }
  }

  private async execute(payload: Payload, requestId: string, conversationId: string, action: ConversationAction): Promise<void> {
    const { requesterTerminalId, expiresAt } = payload;
    if (typeof requesterTerminalId !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return;
    for (const [key, entry] of this.executed) if (entry.expiresAt < Date.now()) this.executed.delete(key);
    const key = `${requesterTerminalId}:${requestId}:${conversationId}:${action}`;
    let entry = this.executed.get(key);
    if (!entry) {
      const previous = this.lanes.get(conversationId) ?? Promise.resolve();
      const result = previous.catch(() => undefined).then(async () => {
        let ok = this.own.get(requestId) ?? false;
        if (!this.own.has(requestId) && !this.closed && Date.now() <= expiresAt) {
          try {
            await this.options.run(conversationId, action);
            ok = true;
          } catch { /* Sender receives a failure; never claim the task stopped. */ }
        }
        return { requestId, conversationId, action, requesterTerminalId, ok };
      });
      entry = { expiresAt, result };
      this.executed.set(key, entry);
      this.lanes.set(conversationId, result);
      void result.finally(() => { if (this.lanes.get(conversationId) === result) this.lanes.delete(conversationId); });
    }
    const result = await entry.result;
    if (!this.closed) this.options.send("CONVERSATION_CONTROL_RESULT", result);
  }

  private fail(requestId: string, key: "main.control.timeout" | "main.control.disconnected" | "main.control.offline" | "main.control.presenceUnknown" | "main.control.rejected" | "main.control.failed"): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(new Error(tm(key)));
  }

  disconnect(): void {
    for (const requestId of this.pending.keys()) this.fail(requestId, "main.control.disconnected");
  }

  close(): void {
    this.closed = true;
    this.disconnect();
    this.stopped.clear();
    this.own.clear();
  }
}
