/** Poll even while the socket stays connected: a missing hint must not stall synchronization. */
export class CloudReconciler<T> {
  private stopped = true;
  private paused = false;
  private pending = false;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: {
    pull: () => Promise<T>;
    apply: (result: T) => Promise<void>;
    onError: (error: unknown) => void;
    intervalMs?: number;
  }) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.request();
  }

  request(): void {
    if (this.stopped) return;
    this.pending = true;
    clearTimeout(this.timer);
    if (this.paused || this.running) return;
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.stopped || this.paused) return;
      if (this.pending) this.request();
      else {
        this.timer = setTimeout(() => this.request(), this.options.intervalMs ?? 30_000);
        this.timer.unref?.();
      }
    });
  }

  private async run(): Promise<void> {
    this.pending = false;
    try {
      const result = await this.options.pull();
      if (!this.stopped) await this.options.apply(result);
    } catch (error) {
      if (!this.stopped) this.options.onError(error);
    }
  }

  /** Don't pull while the computer sleeps (including brief DarkWake runs): pulled messages would start a turn that immediately freezes. A pull already in progress finishes normally */
  pause(): void {
    this.paused = true;
    clearTimeout(this.timer);
  }

  /** Pull once immediately after waking, then resume periodic pulls */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.request();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending = false;
    clearTimeout(this.timer);
    await this.running;
  }
}
