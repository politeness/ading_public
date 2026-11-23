export interface ReadinessEvidence {
  readiness: AgentReadiness;
  detail?: string;
  recovery?: AgentRecovery;
  checkedAt: string;
}

/** Each check is a real model call, so healthy Agents are rechecked hourly and unavailable ones every 10 minutes. */
const READY_RECHECK_MS = 60 * 60_000;
const UNAVAILABLE_RECHECK_MS = 10 * 60_000;

/** Refresh only stale local contacts based on the last connection check or failure. */
export class ReadinessRefresh {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private active = false;
  private attemptedAt = new Map<AgentKind, number>();
  constructor(private readonly deps: {
    candidates(): Promise<Array<{ kind: AgentKind; evidence?: ReadinessEvidence }>>;
    enabled(): boolean;
    busy(kind: AgentKind): boolean;
    verify(kind: AgentKind): Promise<unknown>;
    onError(error: unknown): void;
    now?: () => number;
    intervalMs?: number;
  }) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.active = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    if (!this.active || !this.deps.enabled()) return Promise.resolve();
    this.running = this.refresh().catch(error => this.deps.onError(error))
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async refresh(): Promise<void> {
    const candidates = await this.deps.candidates();
    await Promise.all(candidates.map(async ({ kind, evidence }) => {
      if (!this.active || !this.deps.enabled() || this.deps.busy(kind)) return;
      const now = this.deps.now?.() ?? Date.now();
      const checked = evidence ? Date.parse(evidence.checkedAt) : NaN;
      const ttl = evidence?.readiness === "ready" ? READY_RECHECK_MS : UNAVAILABLE_RECHECK_MS;
      // Invalid or future timestamps cannot pin a status forever.
      if (Number.isFinite(checked) && checked <= now && now - checked < ttl) return;
      const attempted = this.attemptedAt.get(kind);
      if (attempted !== undefined && now >= attempted && now - attempted < UNAVAILABLE_RECHECK_MS) return;
      this.attemptedAt.set(kind, now);
      try { await this.deps.verify(kind); }
      catch (error) { this.deps.onError(error); }
    }));
  }
}
