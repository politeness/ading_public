import { TEAM_RELAY_PREFIX } from "./team";
/** Cloud messages from any known person can drive a local member Agent, including shared Agents. */
export function shouldDispatchRemoteUserMessage(message: Message, sender: UserRef | null): boolean {
  return message.type === "USER" && !message.internal && !!sender && !sender.isAgent;
}

/**
 * Messages from Agents on other computers are handed to the local scheduler only when explicitly addressed: assignments and returned results, @-mentions, discussion replies.
 * Ordinary messages are already synced and displayed, and no longer trigger local Agents, to keep Agents on two computers from replying to each other.
 */
export function shouldDispatchRemoteAgentMessage(message: Message, sender: UserRef | null): boolean {
  if (!sender?.isAgent || !sender.remote || (message.failed && !message.coordination)) return false;
  return !!message.coordination || !!message.mentions?.length || (!!message.internal && message.content.startsWith(TEAM_RELAY_PREFIX));
}

/** Retry intervals after a dispatch failure: 5, 10, 20, 40 seconds; if all four fail, wait for the next launch */
export const DELIVERY_RETRY_MS = [5_000, 10_000, 20_000, 40_000];

export interface MessageDeliveryOptions {
  /** Hands to the scheduler; returning false means quitting, no retry */
  deliver(message: Message, interrupted: boolean): Promise<boolean>;
  /** Before retrying, confirm the message is still in the "unfinished" ledger: don't hand over ones the user paused or that are already processed */
  stillOwed(message: Message): Promise<boolean>;
  log(event: string, data: Record<string, unknown>): unknown;
  /** The computer is asleep (after suspend, before resume): hold off, and wake() continues delivery on wake */
  asleep?(): boolean;
  retryMs?: number[];
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * The only entry point for handing user messages to the scheduler: backfilled ones and ones re-triggered from the ledger after restart all go through here.
 * Within one process a message is handed over only once (restart recovery and backfill leftovers may hand over the same one at the same time);
 * errors when handing over are retried per DELIVERY_RETRY_MS, and if all fail it stays in the ledger until the next launch.
 * "Processed" isn't judged here; the Agent's processed watermark clears the ledger.
 * Messages arriving during sleep, retries due during sleep, and failures during sleep are all held, and on wake continue from the same attempt number:
 * the network often isn't up in DarkWake, so those few seconds mustn't burn through all four retries.
 */
export class MessageDelivery {
  private readonly delivered = new Set<string>();
  private readonly timers = new Set<unknown>();
  private parked: Array<() => void> = [];
  private stopped = false;

  constructor(private readonly options: MessageDeliveryOptions) {}

  async deliver(message: Message, interrupted = false): Promise<void> {
    if (this.stopped || this.delivered.has(message.messageId)) return;
    this.delivered.add(message.messageId);
    await this.attempt(message, interrupted, 0);
  }

  /** Cancels retries not yet due when quitting or switching data sessions; undelivered ones stay in the ledger */
  stop(): void {
    this.stopped = true;
    const clear = this.options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    for (const timer of this.timers) clear(timer);
    this.timers.clear();
    this.parked = [];
  }

  /** The computer woke up: continue delivering what was held during sleep */
  wake(): void {
    for (const run of this.parked.splice(0)) run();
  }

  private park(message: Message, interrupted: boolean, failures: number): void {
    void this.options.log("message-delivery-deferred-asleep", { conversationId: message.conversationId, messageId: message.messageId, attempt: failures + 1 });
    this.parked.push(() => { if (!this.stopped) void this.attempt(message, interrupted, failures); });
  }

  private async attempt(message: Message, interrupted: boolean, failures: number): Promise<void> {
    if (this.options.asleep?.()) return this.park(message, interrupted, failures);
    let error: unknown;
    try {
      if (failures > 0 && !(await this.options.stillOwed(message))) return;
      await this.options.deliver(message, interrupted);
      return;
    } catch (caught) {
      error = caught;
    }
    const where = { conversationId: message.conversationId, messageId: message.messageId, attempt: failures + 1, error: error instanceof Error ? error.message : String(error) };
    const retryMs = this.options.retryMs ?? DELIVERY_RETRY_MS;
    if (this.stopped) return;
    // A failure during sleep is most likely because the network isn't up yet, so it doesn't count as an attempt
    if (this.options.asleep?.()) return this.park(message, interrupted, failures);
    if (failures >= retryMs.length) {
      await this.options.log("message-delivery-abandoned", where);
      return;
    }
    await this.options.log("message-delivery-failed", { ...where, retryInMs: retryMs[failures] });
    const set = this.options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return timer;
    });
    const timer = set(() => {
      this.timers.delete(timer);
      if (!this.stopped) void this.attempt(message, interrupted, failures + 1);
    }, retryMs[failures]);
    this.timers.add(timer);
  }
}
