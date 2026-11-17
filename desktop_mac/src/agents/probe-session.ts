/** A sleep-interrupted check is not a provider failure. Resume only pending checks. */
export class ProbeSession {
  private revision = 0;
  private sleeping = false;
  private waiters: Array<() => void> = [];
  private flights = new Map<string, Promise<unknown>>();
  get epoch(): number { return this.revision; }
  isCurrent(epoch: number): boolean { return !this.sleeping && epoch === this.revision; }

  suspend(): void { this.sleeping = true; this.revision++; }
  resume(): void {
    this.sleeping = false;
    this.revision++;
    this.waiters.splice(0).forEach(resolve => resolve());
  }
  async stable<T>(attempt: () => Promise<T>): Promise<T> {
    for (;;) {
      if (this.sleeping) await new Promise<void>(resolve => this.waiters.push(resolve));
      const revision = this.revision;
      try {
        const result = await attempt();
        if (!this.sleeping && revision === this.revision) return result;
      } catch (error) {
        if (!this.sleeping && revision === this.revision) throw error;
      }
      // Discard everything from the interrupted attempt, including "missing".
    }
  }
  single<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.flights.get(key);
    if (pending) return pending as Promise<T>;
    const flight = run().finally(() => { this.flights.delete(key); });
    this.flights.set(key, flight);
    return flight;
  }
}
