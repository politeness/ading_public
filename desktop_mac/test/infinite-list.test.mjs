import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../dist/ui/infinite-list.js',import.meta.url),'utf8');
const {InfiniteList}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const pending=[];let renders=0;const errors=[];
const pager=new InfiniteList(2,ids=>new Promise((resolve,reject)=>pending.push({ids,resolve,reject})),()=>renders++,e=>errors.push(e));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
pager.visible(['a','b','c']);pager.next();assert.equal(pending.length,1,'single in-flight page');
pager.visible(['x','y','z']);assert.equal(pending.length,2);
pending[0].resolve(['a','b']);await flush();assert.equal(renders,0,'old filter response ignored');
pending[1].resolve(['x','y','unexpected']);await flush();assert.deepEqual([...pager.visible(['x','y','z'])],['x','y']);
const last=pager.next();assert.deepEqual(pending[2].ids,['z']);pending[2].reject(new Error('temporary'));await last;assert.equal(errors.length,1);
const retry=pager.next();assert.deepEqual(pending[3].ids,['z']);pending[3].resolve(['z']);await retry;
assert.deepEqual([...pager.visible(['x','y','z'])],['x','y','z']);await pager.next();assert.equal(pending.length,4,'no request after final page');
console.log('infinite-list: single flight, stale response isolation, filtering, retry and final page passed');

const batches=[];
const navigation=new InfiniteList(2,async ids=>{batches.push(ids);return ids;},()=>{},e=>{throw e;});
navigation.visible(['a','b','c','d','e']);await navigation.reveal('e');
assert.deepEqual(batches,[['a','b'],['c','d'],['e']],'navigation loads successive capped pages');

// When order changes (messages arrive in other conversations), already-fetched items stay and display depth is unchanged; only newly appearing items are requested
const asked=[];let redraws=0;
const live=new InfiniteList(2,async ids=>{asked.push(ids);return ids;},()=>redraws++,e=>{throw e;});
live.visible(['a','b','c','d','e']);await flush();await live.next();
assert.deepEqual([...live.visible(['a','b','c','d','e'])],['a','b','c','d']);
assert.deepEqual([...live.visible(['d','a','b','c','e'])],['d','a','b','c'],'reorder keeps loaded rows without a request');
assert.equal(asked.length,2);
assert.deepEqual([...live.visible(['n','d','a','b','c','e'])],['d','a','b'],'loaded rows stay while the new row is fetched');
await flush();assert.deepEqual(asked.at(-1),['n']);
assert.deepEqual([...live.visible(['n','d','a','b','c','e'])],['n','d','a','b']);
const gone=new InfiniteList(2,async()=>[],()=>{},e=>{throw e;});let goneRequests=0;
const absent=new InfiniteList(2,async()=>{goneRequests++;return [];},()=>absent.visible(['a']),e=>{throw e;});
absent.visible(['a']);await flush();await flush();assert.equal(goneRequests,1,'rows absent locally are not requested again');
await gone.reveal('missing');
console.log('infinite-list: reorder keeps rows and depth, only new rows requested passed');
