export const MESSAGE_PAGE_SIZE = 10;
type PageOptions = { limit: number; beforeSeq?: number; afterSeq?: number };
type PageState = { ready: boolean; hasOlder: boolean; oldest?: number; loading?: Promise<void>; older?: Promise<boolean> };

/** UI history only. Agent context and durable storage keep their own limits. */
export class MessageHistory {
  readonly messages = new Map<string, Message[]>();
  private readonly pages = new Map<string, PageState>();

  constructor(private readonly fetch: (id: string, options: PageOptions) => Promise<Message[]>) {}

  private state(id: string): PageState {
    let state = this.pages.get(id);
    if (!state) { state = { ready: false, hasOlder: false }; this.pages.set(id, state); }
    return state;
  }

  merge(id: string, incoming: Message[]): void {
    const merged = new Map((this.messages.get(id) ?? []).map(message => [message.messageId, message]));
    for (const message of incoming) merged.set(message.messageId, message);
    this.messages.set(id, [...merged.values()].sort((a, b) => a.seq - b.seq));
  }

  load(id: string): Promise<void> {
    const state = this.state(id);
    if (state.loading) return state.loading;
    // Retain arrivals while the initial request is in flight.
    if (!this.messages.has(id)) this.messages.set(id, []);
    const request = (async () => {
      if (!state.ready) {
        const page = await this.fetch(id, { limit: MESSAGE_PAGE_SIZE });
        if (this.pages.get(id) !== state) return;
        this.merge(id, page);
        state.oldest = page[0]?.seq;
        state.hasOlder = page.length === MESSAGE_PAGE_SIZE && (state.oldest ?? 0) > 1;
        state.ready = true;
      } else {
        // Catch up in bounded pages, so returning after more than a page of arrivals leaves no gap.
        let cursor = this.messages.get(id)?.at(-1)?.seq ?? 0;
        while (true) {
          const page = await this.fetch(id, { afterSeq: cursor, limit: MESSAGE_PAGE_SIZE });
          if (this.pages.get(id) !== state) return;
          this.merge(id, page);
          const next = page.at(-1)?.seq ?? cursor;
          if (page.length < MESSAGE_PAGE_SIZE || next <= cursor) break;
          cursor = next;
        }
      }
    })();
    state.loading = request;
    void request.finally(() => { if (state.loading === request) state.loading = undefined; }).catch(() => undefined);
    return request;
  }

  hasOlder(id: string): boolean { return this.pages.get(id)?.hasOlder ?? false; }

  loadOlder(id: string): Promise<boolean> {
    const state = this.state(id);
    if (state.older) return state.older;
    if (!state.ready || !state.hasOlder || state.oldest === undefined) return Promise.resolve(false);
    const beforeSeq = state.oldest;
    const request = (async () => {
      const page = await this.fetch(id, { beforeSeq, limit: MESSAGE_PAGE_SIZE });
      if (this.pages.get(id) !== state) return false;
      const older = page.filter(message => message.seq < beforeSeq);
      this.merge(id, older);
      state.oldest = older[0]?.seq ?? beforeSeq;
      state.hasOlder = older.length === MESSAGE_PAGE_SIZE && state.oldest > 1;
      return older.length > 0;
    })();
    state.older = request;
    void request.finally(() => { if (state.older === request) state.older = undefined; }).catch(() => undefined);
    return request;
  }

  delete(id: string): void { this.pages.delete(id); this.messages.delete(id); }
  clear(): void { this.pages.clear(); this.messages.clear(); }
}
