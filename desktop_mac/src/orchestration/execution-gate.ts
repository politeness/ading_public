import type { Store } from "../store/store";

export interface ExecutionLease {
  conversationId: string;
  agentUserId: string;
  signal: AbortSignal;
  valid(): Promise<boolean>;
  close(): void;
}

/** One cancellation boundary for preparation, execution and result application. */
export class ExecutionGate {
  private readonly active = new Map<ExecutionLease, AbortController>();

  constructor(private readonly store: Store) {}

  begin(conversationId: string, agentUserId: string): ExecutionLease {
    const controller = new AbortController();
    const lease: ExecutionLease = {
      conversationId, agentUserId, signal: controller.signal,
      valid: async () => {
        if (controller.signal.aborted) return false;
        const conversation = await this.store.getConversation(conversationId);
        const member = conversation?.members.find(m => m.userId === agentUserId);
        return !controller.signal.aborted && Boolean(conversation && conversation.status === "ACTIVE" && !conversation.paused && member && !member.paused && !member.ownerPaused && member.role !== "OBSERVER");
      },
      close: () => { this.active.delete(lease); }
    };
    this.active.set(lease, controller);
    return lease;
  }

  cancel(conversationId: string, agentUserId?: string): void {
    for (const [lease, controller] of this.active) {
      if (lease.conversationId === conversationId && (!agentUserId || lease.agentUserId === agentUserId)) controller.abort();
    }
  }
}
