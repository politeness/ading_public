import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {PermissionPolicy,parsePermissionDecision} from '../dist/permissions/policy.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-policy-'));
const conversation={conversationId:'t'},agent={userId:'a'},request=signal=>({requestId:'r',toolName:'Bash',input:{command:'test'},signal});
let manual=0,reviews=0;const audit=[];
const deps={manual:async()=>{manual++;return true;},review:async()=>{reviews++;return false;},audit:async(t,a,m,ok)=>audit.push({m,ok})};
try {
 const file=path.join(dir,'policy.json');const p=new PermissionPolicy(file,deps);
 assert.equal(await p.get(),'unattended');assert.equal(await p.request(conversation,agent,request(new AbortController().signal)),true);assert.equal(manual,0);assert.equal(reviews,0);
 await p.set('manual');assert.equal(await p.request(conversation,agent,request(new AbortController().signal)),true);assert.equal(manual,1);
 assert.equal(await new PermissionPolicy(file,deps).get(),'manual');
 await p.set('leader');assert.equal(await p.request(conversation,agent,request(new AbortController().signal)),false);assert.equal(reviews,1);assert.equal(manual,1);
 deps.review=async()=>undefined;assert.equal(await p.request(conversation,agent,request(new AbortController().signal)),true);assert.equal(manual,2,'when review is impossible, hand to a human instead of silently allowing');
 for(const text of ['允许','{"decision":"allow"}','{"decision":"allow","reason":null}'])assert.equal(parsePermissionDecision(text),undefined);
 assert.deepEqual(parsePermissionDecision('```json\n{"decision":"allow","reason":"属于任务输出"}\n```'),{allowed:true,reason:'属于任务输出'});
 assert.deepEqual(parsePermissionDecision('{"decision":"deny","reason":"超出任务目录"}'),{allowed:false,reason:'超出任务目录'});
 await assert.rejects(p.set('all'));assert.equal(await p.get(),'leader');
 const cancelled=new AbortController();cancelled.abort();assert.equal(await p.request(conversation,agent,request(cancelled.signal)),false);
 // Changing mode cancels an already-open dialog and resolves that same request under the new mode.
 await p.set('manual');let started;const ready=new Promise(r=>started=r);
 deps.manual=async(t,a,r)=>{started();await new Promise(resolve=>r.signal.addEventListener('abort',resolve,{once:true}));return false;};
 const pending=p.request(conversation,agent,request(new AbortController().signal));await ready;await p.set('unattended');assert.equal(await pending,true);
 assert.equal(await new PermissionPolicy(file,deps).get(),'unattended');
 console.log('permission-policy: default, persistence, manual/leader/unattended routing, ambiguous fallback, cancellation and live switching passed');
}finally{await rm(dir,{recursive:true,force:true});}
