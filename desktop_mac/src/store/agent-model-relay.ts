import { randomUUID } from "node:crypto";
import { tm } from "../i18n";

export type AgentModelCommand = { action: "catalog" } | { action: "set"; modelId: string | null };
type Payload = Record<string, unknown>;
type Pending = {
  agentUserId: string;
  resolve: (catalog: AgentModelCatalog | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Reading/setting Agent models across computers on the same account: the server relays the request to the computer hosting the Agent, which executes it and replies back the same way.
 * No replay: disconnects and timeouts are reported directly to the requester; the user decides whether to retry.
 */
export class AgentModelRelay {
  private readonly pending = new Map<string, Pending>();
  private readonly executed = new Map<string, number>();
  private closed = false;

  constructor(private readonly options: {
    send: (type: string, payload: Payload) => boolean;
    catalog: (agentUserId: string) => Promise<AgentModelCatalog>;
    set: (agentUserId: string, modelId: string | null) => Promise<unknown>;
    timeoutMs?: number;
  }) {}

  request(agentUserId: string, command: AgentModelCommand): Promise<AgentModelCatalog | undefined> {
    if (this.closed) return Promise.reject(new Error(tm("main.agents.modelRemoteDisconnected")));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(requestId, new Error(tm("main.agents.modelRemoteTimeout"))), this.options.timeoutMs ?? 60_000);
      this.pending.set(requestId, { agentUserId, resolve, reject, timer });
      if (!this.options.send("AGENT_MODEL_REQUEST", { requestId, agentUserId, ...command })) {
        this.fail(requestId, new Error(tm("main.agents.modelRemoteDisconnected")));
      }
    });
  }

  receive(type: string, raw: unknown): void {
    if (this.closed || !raw || typeof raw !== "object") return;
    const payload = raw as Payload;
    const { requestId, agentUserId } = payload;
    if (typeof requestId !== "string" || typeof agentUserId !== "string") return;
    if (type === "AGENT_MODEL_REQUEST") { void this.execute(payload, requestId, agentUserId); return; }
    if (type !== "AGENT_MODEL_RESULT") return;
    const pending = this.pending.get(requestId);
    if (!pending || pending.agentUserId !== agentUserId) return;
    if (payload.ok === true) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(payload.catalog as AgentModelCatalog | undefined);
      return;
    }
    this.fail(requestId, new Error(
      payload.error === "AGENT_009" ? tm("main.agents.modelRemoteOffline")
        : payload.error === "NODE_006" ? tm("main.control.presenceUnknown")
          : payload.error ? tm("main.agents.modelRemoteRejected")
            : typeof payload.message === "string" && payload.message ? payload.message : tm("main.agents.modelRemoteRejected")));
  }

  private async execute(payload: Payload, requestId: string, agentUserId: string): Promise<void> {
    const { requesterTerminalId, expiresAt, action } = payload;
    if (typeof requesterTerminalId !== "string" || typeof expiresAt !== "number" || Date.now() > expiresAt) return;
    for (const [key, expiry] of this.executed) if (expiry < Date.now()) this.executed.delete(key);
    const key = `${requesterTerminalId}:${requestId}`;
    if (this.executed.has(key)) return;
    this.executed.set(key, expiresAt);
    const reply = { requestId, agentUserId, requesterTerminalId };
    try {
      if (action === "catalog") {
        const catalog = await this.options.catalog(agentUserId);
        this.reply({ ...reply, ok: true, catalog });
      } else if (action === "set") {
        await this.options.set(agentUserId, typeof payload.modelId === "string" ? payload.modelId : null);
        this.reply({ ...reply, ok: true });
      }
    } catch (error) {
      this.reply({ ...reply, ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    }
  }

  private reply(payload: Payload): void {
    if (!this.closed) this.options.send("AGENT_MODEL_RESULT", payload);
  }

  private fail(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error);
  }

  disconnect(): void {
    for (const requestId of this.pending.keys()) this.fail(requestId, new Error(tm("main.agents.modelRemoteDisconnected")));
  }

  close(): void {
    this.closed = true;
    this.disconnect();
  }
}
