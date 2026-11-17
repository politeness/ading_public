import assert from 'node:assert/strict';
import { CloudReconciler } from '../dist/store/cloud-reconciler.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async test => { for (let i=0;i<200 && !test();i++) await sleep(5); assert.ok(test()); };

// No socket hint at all: regular reconciliation recovers from a failed network request.
let pulls = 0;
const applied = [], errors = [];
const poller = new CloudReconciler({ intervalMs: 10,
  pull: async () => { if (++pulls === 1) throw new Error('network unavailable'); return ['m_phone']; },
  apply: async result => applied.push(result), onError: error => errors.push(error)
});
try {
  poller.start();
  await until(() => applied.length >= 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(applied[0], ['m_phone']);
} finally { await poller.stop(); }
const stoppedPulls = pulls;
await sleep(25); assert.equal(pulls, stoppedPulls);

// Wake/reconnect requests coalesce instead of starting concurrent full reconciliations.
let release, active = 0, maximum = 0, count = 0;
const coalesced = new CloudReconciler({ intervalMs: 60000,
  pull: async () => { count++; active++; maximum = Math.max(maximum,active);
    if (count === 1) await new Promise(resolve => { release = resolve; });
    active--; return count;
  }, apply: async () => {}, onError: error => { throw error; }
});
try {
  coalesced.start();
  for (let i=0;i<10;i++) coalesced.request();
  assert.equal(count,1); release();
  await until(() => count === 2);
  assert.equal(maximum,1);
} finally { await coalesced.stop(); }

// Switching accounts during an in-flight fetch must not dispatch work for the old account.
let finish, received = false;
const closing = new CloudReconciler({
  pull: () => new Promise(resolve => { finish = resolve; }),
  apply: async () => { received = true; }, onError() {}
});
closing.start();
const closed = closing.stop(); finish(['stale']); await closed;
assert.equal(received,false);
// System sleep (including DarkWake, where no resume arrives): no pulls until wake, then one immediately.
let sleepPulls = 0;
const sleeper = new CloudReconciler({ intervalMs: 10, pull: async () => ++sleepPulls, apply: async () => {}, onError() {} });
try {
  sleeper.start();
  await until(() => sleepPulls >= 1);
  sleeper.pause();
  await sleep(10);
  const asleep = sleepPulls;
  sleeper.request();
  await sleep(40);
  assert.equal(sleepPulls, asleep, 'paused: neither hints nor the timer pull');
  sleeper.resume();
  await until(() => sleepPulls === asleep + 1);
} finally { await sleeper.stop(); }
console.log('cloud-reconciler: missed hints, network retry, coalescing, sleep and shutdown passed');
