/**
 * Coordinating computer sleep with ADing execution.
 *
 * 1. Prevent system idle sleep while an Agent is running (can be turned off in settings), released immediately when all finish.
 *    Busy state is recomputed each time from the scheduler's run snapshot instead of keeping a reference count: after turn errors, cancellation,
 *    or data session close, they're naturally absent from the snapshot and the next recompute releases it, so nothing leaks. Lid-close sleep can't be blocked.
 * 2. When the system really goes to sleep (suspend): go offline proactively until resume.
 *    During macOS sleep there's a DarkWake every ten-odd minutes, and the process runs for a few seconds to a minute or two,
 *    but Electron doesn't emit resume (local logs on 2026-10-29: in 3 hours after suspend, multiple DarkWakes
 *    reconnected and published status, and resume arrived only on actual wake).
 *    So "after suspend, before resume" means asleep; during this time don't reconnect, backfill, or proactively start new turns,
 *    so the server doesn't see it briefly online and the turn it starts doesn't get frozen right away.
 *    The scheduler waits via whenAwake() until wake before starting a new turn; see LocalScheduler's sleep gate.
 */

export interface SleepGuardOptions {
  /** An Agent is running locally (turns, work lanes, parallel subtasks); sign-in, installation, and connection checks don't count */
  busy(): boolean;
  /** The setting "Keep the computer awake while running tasks" */
  keepAwake(): boolean;
  /** Power blocker: Electron's powerSaveBlocker.start("prevent-app-suspension") / stop */
  blocker: { start(): number; stop(id: number): void };
  /** The system is going to sleep: take cloud connections offline and pause backfill */
  onSleep(): void;
  /** Actually awake: reconnect immediately and backfill once */
  onWake(): void;
  log(event: string, data?: Record<string, unknown>): unknown;
  /** Fallback recompute interval, 30 seconds by default: even if a busy/idle event isn't emitted, sleep won't stay blocked */
  intervalMs?: number;
}

export class SleepGuard {
  private blockerId: number | undefined;
  private asleep = false;
  private queued = false;
  private disposed = false;
  private waiters: Array<() => void> = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: SleepGuardOptions) {
    this.timer = setInterval(() => this.refresh(), options.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  /** The system has suspended and not yet resumed (including brief process runs during DarkWake) */
  get sleeping(): boolean {
    return this.asleep;
  }

  /** Returns immediately when awake; when asleep, returns only on actual wake (or quit) */
  whenAwake(): Promise<void> {
    if (!this.asleep || this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Called from busy/idle events: defer computing until this round of event handling finishes, computing once for multiple events at the same moment */
  schedule(): void {
    if (this.queued || this.disposed) return;
    this.queued = true;
    setTimeout(() => {
      this.queued = false;
      this.refresh();
    }, 0);
  }

  refresh(): void {
    if (this.disposed) return;
    let busy = false;
    try {
      busy = this.options.busy();
    } catch {
      // No snapshot is available while switching data sessions, so treat as idle; the fallback recompute corrects it later
    }
    const want = !this.asleep && busy && this.options.keepAwake();
    if (want && this.blockerId === undefined) {
      try {
        this.blockerId = this.options.blocker.start();
        void this.options.log("power-keep-awake-started");
      } catch (error) {
        void this.options.log("power-keep-awake-failed", { error: String(error) });
      }
    } else if (!want) this.release();
  }

  suspend(): void {
    if (this.asleep || this.disposed) return;
    this.asleep = true;
    void this.options.log("power-suspended");
    this.release();
    this.options.onSleep();
  }

  /** resume, or signals like unlocking the screen or the user returning that only occur when truly awake */
  resume(reason: string): void {
    if (!this.asleep || this.disposed) return;
    this.asleep = false;
    void this.options.log("power-resumed", { reason });
    this.wakeWaiters();
    this.options.onWake();
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.wakeWaiters();
    this.release();
  }

  private wakeWaiters(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private release(): void {
    const id = this.blockerId;
    if (id === undefined) return;
    this.blockerId = undefined;
    try {
      this.options.blocker.stop(id);
    } catch {
      // Already stopped
    }
    void this.options.log("power-keep-awake-stopped");
  }
}
