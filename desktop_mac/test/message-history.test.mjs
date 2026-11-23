import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../dist/ui/message-history.js', import.meta.url), 'utf8');
const { MessageHistory } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const rows = (from, to) => Array.from({length: to - from + 1}, (_, index) => ({messageId: `m${from + index}`, seq: from + index}));
let source = rows(1, 25), fail = false, release;
const requests = [];
const history = new MessageHistory(async (id, options) => {
  requests.push({id, ...options});
  if (fail) { fail = false; throw Error('offline'); }
  if (release) await new Promise(resolve => { release = resolve; });
  return options.beforeSeq !== undefined ? source.filter(m => m.seq < options.beforeSeq).slice(-options.limit)
    : options.afterSeq !== undefined ? source.filter(m => m.seq > options.afterSeq).slice(0, options.limit)
    : source.slice(-options.limit);
});
await history.load('a');
assert.deepEqual(history.messages.get('a').map(m => m.seq), rows(16, 25).map(m => m.seq));
assert.equal(history.hasOlder('a'), true);
fail = true;
await assert.rejects(history.loadOlder('a'), /offline/);
assert.equal(history.messages.get('a').length, 10, 'failure retains loaded messages');
release = true;
const first = history.loadOlder('a');
assert.equal(first, history.loadOlder('a'), 'one older request at a time');
history.merge('a', [source.at(-1), ...rows(26, 26)]);
release(); release = undefined;
await first;
assert.equal(history.messages.get('a').length, 21, 'arrivals survive prepend without duplicates');
assert.equal(history.messages.get('a')[0].seq, 6);
await history.loadOlder('a');
assert.equal(history.messages.get('a').length, 26);
assert.equal(history.hasOlder('a'), false);
const endRequests = requests.length;
await history.loadOlder('a');
assert.equal(requests.length, endRequests, 'no request after end');
source = rows(1, 53);
await history.load('a');
assert.equal(history.messages.get('a').length, 53, 'catch-up beyond one page has no gaps');
assert.ok(requests.every(request => request.limit === 10));
assert.deepEqual(requests.filter(request => request.afterSeq).map(request => request.afterSeq), [26, 36, 46]);

let resolveOld;
const stale = new MessageHistory(() => new Promise(resolve => { resolveOld = resolve; }));
const load = stale.load('a');
stale.clear();
resolveOld(rows(1, 10));
await load;
assert.equal(stale.messages.size, 0, 'account switch ignores stale response');
const initial = stale.load('b');
stale.merge('b', rows(11, 11));
resolveOld(rows(1, 10));
await initial;
assert.equal(stale.messages.get('b').length, 11, 'initial in-flight arrivals retained');
assert.equal(stale.hasOlder('b'), false, 'exact page beginning at seq1 is final');
console.log('message-history: 10-row pages, retry, dedup, concurrent arrivals, catch-up, end and stale requests passed');
