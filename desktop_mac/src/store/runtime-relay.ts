/**
 * Syncing execution progress across computers: activity feed, "AI working".
 *
 * Cross-computer collaboration relies on syncing: messages sync over and run on the computer hosting the agent. Execution progress must sync back too,
 * so the sending side can see "who is working and how far along"; otherwise it can only wait for results.
 *
 * These are only relayed by the server, not persisted (see backend TurnActivityBoard): the feed has several entries per second and is useless after the turn ends.
 * The local UI still understands the same two events — agent:busy (start / end of a turn) and agent:progress (a feed line) —
 * and remote ones are converted to the same events, so remote agents at work look exactly like local ones.
 */

type RuntimeFrame = { conversationId: string; agentUserId: string; busy?: boolean; text?: string };
export type RuntimeEvent = { channel: "agent:busy" | "agent:progress"; payload: Record<string, unknown> };

function frameOf(payload: unknown): RuntimeFrame | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  if (typeof value.conversationId !== "string" || typeof value.agentUserId !== "string") return undefined;
  return {
    conversationId: value.conversationId,
    agentUserId: value.agentUserId,
    ...(typeof value.busy === "boolean" ? { busy: value.busy } : {}),
    ...(typeof value.text === "string" && value.text ? { text: value.text } : {})
  };
}

const keyOf = (frame: RuntimeFrame) => `${frame.conversationId}\n${frame.agentUserId}`;

/**
 * Executing side: report the local scheduler's busy state and feed events upward.
 *
 * Start and end are reported immediately; feed lines are reported at most once per intervalMs per "task + agent", keeping only the latest,
 * so the long-lived connection isn't flooded (tool events can be several per second in one turn). Before ending, the last unsent line is flushed first so order is preserved.
 */
export class RuntimeUplink {
  private readonly active = new Map<string, RuntimeFrame>();
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly lastSent = new Map<string, number>();
  private readonly pending = new Map<string, { frame: RuntimeFrame; timer: NodeJS.Timeout }>();

  constructor(
    private readonly send: (frame: RuntimeFrame) => void,
    private readonly intervalMs = 500,
    private readonly now: () => number = Date.now
  ) {}

  push(channel: string, payload: unknown): void {
    if (channel !== "agent:busy" && channel !== "agent:progress") return;
    const frame = frameOf(payload);
    if (!frame) return;
    const key = keyOf(frame);
    if (channel === "agent:busy") {
      this.flush(key);
      if (frame.busy === true) {
        this.active.set(key, { conversationId: frame.conversationId, agentUserId: frame.agentUserId, busy: true });
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => this.reportBusy(), 10_000);
          this.heartbeat.unref?.();
        }
      } else {
        this.active.delete(key);
        if (!this.active.size) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
      }
      this.send({ conversationId: frame.conversationId, agentUserId: frame.agentUserId, busy: frame.busy === true });
      if (frame.busy !== true) this.lastSent.delete(key);
      return;
    }
    if (!frame.text) return;
    const line = { conversationId: frame.conversationId, agentUserId: frame.agentUserId, text: frame.text };
    const wait = (this.lastSent.get(key) ?? 0) + this.intervalMs - this.now();
    if (wait <= 0 && !this.pending.has(key)) {
      this.lastSent.set(key, this.now());
      this.send(line);
      return;
    }
    const waiting = this.pending.get(key);
    if (waiting) {
      waiting.frame = line;
      return;
    }
    const timer = setTimeout(() => this.flush(key), Math.max(0, wait));
    timer.unref?.();
    this.pending.set(key, { frame: line, timer });
  }

  reportBusy(): void { for (const frame of this.active.values()) this.send(frame); }

  /** On disconnect or exit drop what's unsent: after reconnecting the server takes the executing side's next report as authoritative */
  reset(): void {
    clearInterval(this.heartbeat); this.heartbeat = undefined; this.active.clear();
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.lastSent.clear();
  }

  private flush(key: string): void {
    const waiting = this.pending.get(key);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(key);
    this.lastSent.set(key, this.now());
    this.send(waiting.frame);
  }
}

/**
 * Receiving side: convert events reported by other computers into agent:busy / agent:progress the local UI understands.
 *
 * Local agents don't go through here (those are our own reports echoed back by the server; we already have them).
 * Event IDs derive from the current time, guaranteeing monotonic increase and being larger than the local scheduler's IDs: the UI judges freshness per "task + agent",
 * and remote and local agents are tracked separately without interfering.
 */
export class RemoteRuntime {
  private readonly busy = new Map<string, { conversationId: string; agentUserId: string; text?: string }>();
  private readonly seen = new Map<string, { sentAt: number; receivedAt: number }>();
  private revision: number;

  constructor(private readonly isLocalAgent: (agentUserId: string) => boolean, start = Date.now() * 1000) {
    this.revision = start;
  }

  apply(payload: unknown): RuntimeEvent[] {
    const frame = frameOf(payload);
    if (!frame || this.isLocalAgent(frame.agentUserId)) return [];
    const key = keyOf(frame);
    const events: RuntimeEvent[] = [];
    // Frames relayed by the server all carry the executing side's sentAt (always present in MQTT reports); use it to drop late and duplicate frames;
    // frames without sentAt are synthesized locally (e.g. clearing busy after a successful remote pause) and take effect directly
    const sentAt = (payload as { sentAt?: unknown }).sentAt;
    const previous = this.seen.get(key);
    if (typeof sentAt === "number" && previous && sentAt <= previous.sentAt) return [];
    this.seen.set(key, { sentAt: typeof sentAt === "number" ? sentAt : previous?.sentAt ?? 0, receivedAt: Date.now() });
    if (frame.busy !== undefined) {
      if (frame.busy) this.busy.set(key, { ...this.busy.get(key), conversationId: frame.conversationId, agentUserId: frame.agentUserId });
      else this.busy.delete(key);
      events.push({ channel: "agent:busy", payload: { conversationId: frame.conversationId, agentUserId: frame.agentUserId, busy: frame.busy, revision: ++this.revision } });
    }
    if (frame.text) {
      // A feed line means it's working, even if the start event was lost
      const entry = this.busy.get(key) ?? { conversationId: frame.conversationId, agentUserId: frame.agentUserId };
      entry.text = frame.text;
      this.busy.set(key, entry);
      events.push({ channel: "agent:progress", payload: { conversationId: frame.conversationId, agentUserId: frame.agentUserId, text: frame.text, revision: ++this.revision } });
    }
    return events;
  }

  expire(now = Date.now()): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const [key, entry] of this.busy) {
      if (now - (this.seen.get(key)?.receivedAt ?? 0) < 30_000) continue;
      this.busy.delete(key);
      events.push({ channel: "agent:busy", payload: { ...entry, busy: false, revision: ++this.revision } });
    }
    for (const [key, value] of this.seen) if (now - value.receivedAt > 300_000 && !this.busy.has(key)) this.seen.delete(key);
    return events;
  }

  /** Disconnected from the server: other computers' state is no longer trustworthy, treat all as ended; the server resends current state after reconnect */
  clear(): RuntimeEvent[] {
    const events = [...this.busy.values()].map((entry) => ({
      channel: "agent:busy" as const,
      payload: { conversationId: entry.conversationId, agentUserId: entry.agentUserId, busy: false, revision: ++this.revision }
    }));
    this.busy.clear();
    return events;
  }

  /** On initial UI load, include remote agents currently working in the busy state */
  snapshot(): Array<{ agentUserId: string; conversationId: string; busy: boolean; text?: string }> {
    return [...this.busy.values()].map((entry) => ({ ...entry, busy: true }));
  }
}
