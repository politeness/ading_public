import { t } from "./i18n.js";

/** A task/Agent pair owns execution state; concurrent tasks never overwrite one another. */
export class RuntimeState {
  readonly busy = new Map<string, string>();
  readonly progress = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  key(conversationId: string, agentUserId: string): string { return JSON.stringify([conversationId, agentUserId]); }
  agentId(key: string): string { return JSON.parse(key)[1]; }
  isBusy(conversationId: string, agentUserId: string): boolean { return this.busy.has(this.key(conversationId, agentUserId)); }
  accept(key: string, revision?: number): boolean {
    if (revision === undefined) return true;
    if (revision <= (this.revisions.get(key) ?? -1)) return false;
    this.revisions.set(key, revision);
    return true;
  }
  restore(snapshot?: AgentRuntimeSnapshot): void {
    if (!snapshot) return;
    const present = new Set(snapshot.agents.map(a => this.key(a.conversationId, a.agentUserId)));
    for (const key of this.busy.keys()) {
      if (!present.has(key) && this.accept(key, snapshot.revision)) {
        this.busy.delete(key); this.progress.delete(key);
      }
    }
    for (const agent of snapshot.agents) {
      const key = this.key(agent.conversationId, agent.agentUserId);
      if (!this.accept(key, snapshot.revision)) continue;
      if (agent.busy) this.busy.set(key, agent.conversationId);
      else this.busy.delete(key);
      if (agent.text) this.progress.set(key, agent.text);
    }
  }
}

/** Pending execution continuation is distinct from concurrent message handling. */
export function queueEntryText(entry: AgentQueueEntry): string {
  if (entry.messageState === "processing") return t("ui.queue.processing");
  if (entry.messageState === "waiting") return t("ui.queue.waiting");
  if (entry.messageState === "handled") return t("ui.queue.handled");
  // Pending follow-up work shows no status text (user decision: the text carries no information)
  return "";
}
