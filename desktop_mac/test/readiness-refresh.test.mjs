import assert from 'node:assert/strict';
import { ReadinessRefresh } from '../dist/agents/readiness-refresh.js';
import { AgentRegistry } from '../dist/agents/registry.js';
const minute = 60_000;
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
let now = 2_000_000, enabled = true, busy = new Set(), candidates = [], calls = [], errors = [];
let verify = async kind => { calls.push(kind); };
const refresh = new ReadinessRefresh({ now: () => now, enabled: () => enabled, busy: kind => busy.has(kind),
  candidates: async () => candidates, verify: kind => verify(kind), onError: error => errors.push(error) });
const evidence = (readiness, age = 0) => ({readiness, checkedAt: new Date(now - age).toISOString()});
try {
  refresh.start();
  candidates = [{kind:'codex',evidence:evidence('ready')},{kind:'qoder',evidence:evidence('exhausted')}];
  await refresh.tick(); assert.deepEqual(calls, [], 'fresh states do not consume probes');
  now += 10 * minute;
  await refresh.tick(); assert.deepEqual(calls, ['qoder'], 'unavailable contact automatically rechecked');
  await refresh.tick(); assert.equal(calls.length, 1, 'unchanged or failed checks are throttled');
  now += 50 * minute;
  busy.add('codex'); enabled = false;
  await refresh.tick(); assert.equal(calls.length, 1, 'sleep/startup/quit do not start checks');
  enabled = true;
  await refresh.tick(); assert.deepEqual(calls, ['qoder','qoder'], 'running tasks and lifecycle actions are skipped');
  busy.clear();
  const pending = gate();
  verify = async kind => { calls.push(kind); await pending.promise; };
  const a = refresh.tick(), b = refresh.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(calls.filter(k => k === 'codex').length, 1, 'overlapping ticks cannot duplicate a probe');
  pending.resolve(); await Promise.all([a,b]);
  now += 10 * minute;
  candidates = [{kind:'qoder',evidence:evidence('exhausted',10*minute)}];
  verify = async kind => {
    calls.push(kind);
    candidates[0].evidence = evidence('ready');
  };
  await refresh.tick();
  const recoveredCalls = calls.length;
  now += 10 * minute; await refresh.tick();
  assert.equal(calls.length, recoveredCalls, 'recovery switches to the longer healthy interval');
  candidates = [{kind:'claude-code',evidence:evidence('ready',-minute)}, {kind:'kiro',evidence:{readiness:'error',checkedAt:'broken'}}, {kind:'copilot'}];
  verify = async kind => { calls.push(kind); if (kind === 'kiro') throw Error('transient failure'); };
  await refresh.tick();
  assert.deepEqual(calls.slice(-3), ['claude-code','kiro','copilot'], 'invalid/future/missing timestamps eventually rechecked');
  assert.equal(errors.length, 1, 'one provider failure does not block others');
  const count = calls.length; await refresh.tick(); assert.equal(calls.length,count,'exceptions have a retry cooldown');
  refresh.stop(); now += 120*minute; await refresh.tick(); assert.equal(calls.length,count,'stopped timer cannot start work');
} finally { refresh.stop(); }

// The production timer must trigger a check without a renderer request.
{
  const fired=gate();let enumerations=0;
  const r=new ReadinessRefresh({intervalMs:5,candidates:async()=>{enumerations++;return [{kind:'codex'}];},
    enabled:()=>true,busy:()=>false,verify:async()=>fired.resolve(),onError:e=>{throw e;}});
  let timeout;
  try {
    r.start();r.start();
    await Promise.race([fired.promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('automatic refresh did not run')),1000);})]);
    r.stop();const stopped=enumerations;await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(enumerations,stopped,'stop clears the actual timer');
  } finally {clearTimeout(timeout);r.stop();}
}

// Sleep or quit while awaiting the candidate list must also suppress new work.
for (const stop of [false,true]) {
  const pending = gate(); let awake = true, checks = 0;
  const r = new ReadinessRefresh({candidates:()=>pending.promise,enabled:()=>awake,busy:()=>false,
    verify:async()=>checks++,onError:e=>{throw e;}});
  try { r.start(); const tick=r.tick(); if(stop)r.stop();else awake=false;
    pending.resolve([{kind:'codex'}]);await tick;assert.equal(checks,0);
  } finally {r.stop();}
}

// Busy task, login and installation state still guard automatic checks.
const registry = new AgentRegistry();
const running = [];
registry.adapters.splice(0,registry.adapters.length,{kind:'codex',busyIds:()=>running});
assert.equal(registry.isBusy('codex'),false);running.push('task');assert.equal(registry.isBusy('codex'),true);running.pop();
registry.loginFlights.set('codex',Promise.resolve());assert.equal(registry.isBusy('codex'),true);registry.loginFlights.clear();
registry.installFlights.set('codex',Promise.resolve());assert.equal(registry.isBusy('codex'),true);registry.installFlights.clear();
console.log('readiness-refresh: stale recovery, healthy TTL, busy/sleep/quit guards, deduplication, cooldowns and automatic timer passed');
