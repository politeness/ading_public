import assert from 'node:assert/strict';
import { ProbeSession } from '../dist/agents/probe-session.js';
import { AgentRegistry } from '../dist/agents/registry.js';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
{
  const session=new ProbeSession(), pending=gate();let calls=0;
  const result=session.stable(async()=>{calls++;return calls===1?pending.promise:'ready';});
  session.suspend();pending.resolve('missing');
  await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  session.resume();assert.equal(await result,'ready');assert.equal(calls,2);
  session.suspend();session.resume();assert.equal(calls,2,'a completed check is not rerun on wake');
}
{
  const session=new ProbeSession(), pending=gate();let calls=0;
  const result=session.stable(async()=>{if(++calls===1){await pending.promise;throw Error('timeout');}return 'exhausted';});
  session.suspend();session.resume();pending.resolve();
  assert.equal(await result,'exhausted');assert.equal(calls,2,'a stale failure returned only after wake is also discarded');
  await assert.rejects(session.stable(async()=>{throw Error('real failure');}),/real failure/);
}
{
  const session=new ProbeSession(), pending=gate();let calls=0;
  const a=session.single('qoder',async()=>{calls++;await pending.promise;return 'intl';});
  const b=session.single('qoder',async()=>{calls++;return 'duplicate';});
  const cn=session.single('qoder-cn',async()=> 'cn');
  assert.equal(await cn,'cn');pending.resolve();assert.deepEqual(await Promise.all([a,b]),['intl','intl']);assert.equal(calls,1);
  await assert.rejects(session.single('bad',async()=>{throw Error('failed');}));
  assert.equal(await session.single('bad',async()=> 'retry'),'retry');
}
{
  const registry=new AgentRegistry(), pending=gate();let discoveries=0;
  registry.adapters.splice(0, registry.adapters.length, {kind:'qoder',discover:async()=>{discoveries++;await pending.promise;return [];},busyIds:()=>['conversation','probe::verify'],cancel:id=>{assert.equal(id,'probe::verify');}});
  const a=registry.discoverAll(), b=registry.discoverAll();pending.resolve();await Promise.all([a,b]);assert.equal(discoveries,1);
  registry.cancelChecks();
}
console.log('probe-session: sleep/wake stale results, no idle polling, concurrent deduplication, provider isolation and cancellation passed');
