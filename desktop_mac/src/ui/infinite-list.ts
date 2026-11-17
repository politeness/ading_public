/** Pages a presentation over the synchronized local index without truncating unread/navigation state. */
export class InfiniteList {
  private ids: string[] = [];
  /** Items already fetched */
  private loaded = new Set<string>();
  /** Items already requested: those missing locally after fetching also count, to avoid repeated requests */
  private asked = new Set<string>();
  /** How many items are currently displayed */
  private depth = 0;
  private revision = 0;
  private pending = false;
  private settled: Promise<void> = Promise.resolve();

  constructor(private readonly size: number, private readonly request: (ids: string[]) => Promise<string[]>,
    private readonly changed: () => void, private readonly failed: (error: unknown) => void) {}

  visible(ids: string[]): Set<string> {
    if (ids.length !== this.ids.length || ids.some((id, index) => id !== this.ids[index])) {
      // Order or membership changed (new message, filter change): keep fetched items, keep display depth, only request newly appearing items
      const next = new Set(ids);
      for (const id of this.loaded) if (!next.has(id)) this.loaded.delete(id);
      this.asked = new Set(this.loaded);
      this.ids = [...ids];
      this.pending = false;
      this.revision++;
    }
    this.depth = Math.min(this.ids.length, Math.max(this.depth, this.size));
    if (!this.pending) void this.fill();
    return new Set(this.ids.slice(0, this.depth).filter(id => this.loaded.has(id)));
  }

  async next(): Promise<void> {
    if (this.pending) return;
    if (!this.missing().length) {
      if (this.depth >= this.ids.length) return;
      this.depth = Math.min(this.ids.length, this.depth + this.size);
    }
    await this.fill();
  }

  async reveal(id: string): Promise<void> {
    const revision = this.revision;
    const index = this.ids.indexOf(id);
    if (index < 0) return;
    while (revision === this.revision && (this.pending || index >= this.depth || !this.asked.has(id))) {
      if (this.pending) { await this.settled; continue; }
      const before = this.depth + this.asked.size;
      await this.next();
      if (before === this.depth + this.asked.size) break;
    }
  }

  nearEnd(element: HTMLElement): void {
    if (element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < 80) void this.next();
  }

  private missing(): string[] {
    return this.ids.slice(0, this.depth).filter(id => !this.asked.has(id));
  }

  private async fill(): Promise<void> {
    if (this.pending) return;
    const batch = this.missing().slice(0, this.size);
    if (!batch.length) return;
    const revision = this.revision;
    for (const id of batch) this.asked.add(id);
    this.pending = true;
    let settle!: () => void;
    this.settled = new Promise(resolve => { settle = resolve; });
    try {
      const result = await this.request(batch);
      if (revision !== this.revision) return;
      const requested = new Set(batch);
      for (const id of result) if (requested.has(id)) this.loaded.add(id);
      this.pending = false;
      this.changed();
    } catch (error) {
      if (revision === this.revision) {
        for (const id of batch) this.asked.delete(id);
        this.failed(error);
      }
    } finally {
      if (revision === this.revision) this.pending = false;
      settle();
    }
  }
}
