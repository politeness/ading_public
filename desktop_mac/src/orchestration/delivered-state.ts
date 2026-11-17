import { createHash } from "node:crypto";

/**
 * State carried every turn, like the work queue and assignment status, already has an older version in the vendor thread; resending it whole just piles up context.
 * Record a digest of each item this thread has received, and next turn send only what changed.
 *
 * Vendors may compress old content in the thread themselves, and after sending only increments for a while the Agent's version may drift, so send a full copy every few turns.
 */
export interface DeliveredItems {
  items: Record<string, string>;
  /** How many turns since the last full send */
  turns: number;
}

export const FULL_STATE_EVERY = 8;

export type StateDelta<T> =
  | { kind: "full"; items: T[] }
  | { kind: "same"; total: number }
  | { kind: "changed"; changed: T[]; removed: string[]; total: number };

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** When previous is empty (new thread, or the last turn failed) it's always a full send. */
export function stateDelta<T>(items: T[], keyOf: (item: T) => string, previous: DeliveredItems | undefined): { delta: StateDelta<T>; next: DeliveredItems } {
  const current = Object.fromEntries(items.map(item => [keyOf(item), digest(item)]));
  if (!previous || previous.turns + 1 >= FULL_STATE_EVERY) return { delta: { kind: "full", items }, next: { items: current, turns: 0 } };
  const next = { items: current, turns: previous.turns + 1 };
  const changed = items.filter(item => previous.items[keyOf(item)] !== current[keyOf(item)]);
  const removed = Object.keys(previous.items).filter(key => !(key in current));
  if (!changed.length && !removed.length) return { delta: { kind: "same", total: items.length }, next };
  return { delta: { kind: "changed", changed, removed, total: items.length }, next };
}
