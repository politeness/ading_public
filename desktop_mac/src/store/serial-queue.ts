/** Serialize operations sharing a resource; a rejected operation never poisons the queue. */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.tails.set(key, result);
    void result.finally(() => {
      if (this.tails.get(key) === result) this.tails.delete(key);
    }).catch(() => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.tails.values());
  }
}
