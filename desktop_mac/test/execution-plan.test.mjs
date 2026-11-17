import assert from 'node:assert/strict';
import {stat,rm} from 'node:fs/promises';
import {ParallelExecutor} from '../dist/agents/parallel-executor.js';
import {parseParallelJobs,runJobGraph} from '../dist/agents/parallel-work.js';
import {parseExecutionPlan} from '../dist/agents/execution-plan.js';

const job=(id,dependsOn=[])=>({id,instruction:id,outputs:[],dependsOn});
for(const jobs of [[job('a',['missing'])],[job('a',['a'])],[job('a',['b']),job('b',['a'])]]){
 assert.throws(()=>parseParallelJobs({jobs},'/tmp'));
}
assert.throws(()=>parseExecutionPlan('{"decision":"direct"}','/tmp'));
assert.throws(()=>parseExecutionPlan(JSON.stringify({decision:'parallel',reason:'split',jobs:[job('a')]}),'/tmp'));
assert.equal(parseExecutionPlan(JSON.stringify({decision:'parallel',reason:'split',jobs:[job('a'),job('b')],stream:true}),'/tmp').stream,undefined);

let finishSlow;const slow=new Promise(resolve=>finishSlow=resolve),order=[];
const jobs=parseParallelJobs({jobs:[job('fast'),job('slow'),job('after-fast',['fast']),job('failed'),job('blocked',['failed'])]},'/tmp');
const graph=await runJobGraph(jobs,async j=>{
 order.push(j.id);
 if(j.id==='slow')await slow;
 if(j.id==='after-fast')finishSlow();
 return {ok:j.id!=='failed',id:j.id};
},j=>({ok:false,id:j.id}));
assert.ok(order.indexOf('after-fast')>=0,'dependency starts before unrelated slow job finishes');
assert.ok(!order.includes('blocked'));assert.equal(graph.find(r=>r.id==='blocked').ok,false);

for(const kind of ['codex','claude-code','qoder','qoder-cn']){
 const executor=new ParallelExecutor();let plans=0,parents=0,active=0,peak=0,children=0;
 const scratchPaths=new Set();
 const input={prompt:'process independent inputs',workspacePath:'/tmp',fullAccess:true,onProgress:()=>{},
  runtimeConfig:{model:'native',reasoningEffort:'high',fastMode:false},
  parallelWork:{key:kind,limit:10,executionSlot:true,allowSplit:true,planBeforeExecution:true,sessionBudget:11}};
 const outcome=await executor.run({kind,localUuid:kind},input,async(_a,i)=>{
  const ok=message=>({ok:true,message,threadId:'fixture',steps:[],metrics:{iterations:0,sideEffects:false}});
  if(!i.parallelWork){
   plans++;assert.equal(i.onParallelWork,undefined);assert.equal(i.onPermission,undefined);
   return ok(JSON.stringify({decision:'parallel',reason:'independent inputs',jobs:Array.from({length:11},(_,n)=>job(String(n)))}));
  }
  if(i.parallelWork.allowSplit){assert.equal(i.fullAccess,false,'delivered batch verifier cannot rewrite outputs');assert.equal(i.onParallelWork,undefined);parents++;assert.equal(children,11);assert.match(i.prompt,/系统已按执行计划完成调度/);return ok('all complete');}
  assert.equal(i.parallelWork.planBeforeExecution,false);assert.equal(i.runtimeConfig.fastMode,false);
  const scratch=i.prompt.match(/本执行通道专属临时目录：([^\n]+)/)?.[1];
  assert.ok(scratch);assert.equal(scratchPaths.has(scratch),false);scratchPaths.add(scratch);
  assert.ok((await stat(scratch)).isDirectory());assert.equal(i.workspacePath,'/tmp');
  children++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return ok('child complete');
 });
 assert.equal(outcome.ok,true);assert.equal(plans,1);assert.equal(parents,1);assert.equal(peak,10);assert.equal(active,0);
 // The executor deletes the temp directory itself when the channel ends: otherwise every parallel run would leave a copy in the system temp directory
 for(const p of scratchPaths)await assert.rejects(stat(p),{code:'ENOENT'},`Channel temp directory should be deleted: ${p}`);
}
for(const mode of ['direct','cancel','invalid']){
 const executor=new ParallelExecutor(),stop=new AbortController();let calls=0;
 const outcome=await executor.run({kind:'fixture',localUuid:mode},{prompt:'one task',workspacePath:'/tmp',fullAccess:true,onProgress:()=>{},signal:stop.signal,
  parallelWork:{key:mode,limit:10,executionSlot:false,allowSplit:true,planBeforeExecution:true,sessionBudget:11}},async(_a,i)=>{
  calls++;
  if(!i.fullAccess){if(mode==='cancel')stop.abort();return {ok:true,message:mode==='invalid'?'invalid':JSON.stringify({decision:'direct',reason:'one small indivisible action'}),threadId:'planning',steps:[],metrics:{iterations:0,sideEffects:false}};}
  assert.ok(['direct','invalid'].includes(mode));return {ok:true,message:'done',threadId:'execution',steps:[],metrics:{iterations:0,sideEffects:false}};
 });
 assert.equal(calls,mode==='cancel'?1:2);assert.equal(outcome.ok,mode!=='cancel');
}
// Read-only planning and verification still need host approval for external inputs.
{
 const permission=async()=>true;let stage=0;
 const out=await new ParallelExecutor().run({kind:'fixture',localUuid:'external-read'},{prompt:'read external files',workspacePath:'/tmp',fullAccess:true,onPermission:permission,onProgress:()=>{},parallelWork:{key:'external-read',limit:10,executionSlot:false,allowSplit:true,planBeforeExecution:true,sessionBudget:11}},async(_agent,i)=>{
  assert.equal(i.onPermission,permission,'read-only must preserve the normal approval host');
  if(!i.parallelWork){stage++;assert.equal(i.fullAccess,false);return {ok:true,message:JSON.stringify({decision:'parallel',reason:'independent',jobs:[job('a'),job('b')]}),steps:[],metrics:{iterations:0,sideEffects:false}};}
  if(i.parallelWork.allowSplit){stage++;assert.equal(i.fullAccess,false);}
  return {ok:true,message:'done',steps:[],metrics:{iterations:0,sideEffects:false}};
 });assert.equal(out.ok,true);assert.equal(stage,2);
}
console.log('execution-plan: explicit multi-session mode dispatches 11 jobs at 10 lanes, dependency backfill, failure isolation, cycle rejection, direct path and cancellation passed');

for(const mode of ['timeout','cancelled','side-effect','startup','auth']){
 let calls=0;
 const result=await new ParallelExecutor().run({kind:'fixture',localUuid:mode},{prompt:'original',workspacePath:'/tmp',fullAccess:true,onProgress:()=>{},parallelWork:{key:mode,limit:10,executionSlot:false,allowSplit:true,planBeforeExecution:true,sessionBudget:11}},async(_a,i)=>{
  calls++;
  if(calls===2){assert.equal(mode,'timeout');assert.equal(i.fullAccess,true);assert.equal(typeof i.onParallelWork,'function');assert.match(i.prompt,/只读拆分超时/);return {ok:true,message:'done',steps:[],metrics:{iterations:1,sideEffects:false}};}
  return {ok:false,cancelled:mode==='cancelled',error:mode==='startup'?'权限控制通道初始化超时':mode==='auth'?'not authenticated':'Qoder CN 超过 90 秒还没结束',steps:[],metrics:{iterations:2,sideEffects:mode==='side-effect'}};
 });assert.equal(calls,mode==='timeout'?2:1);assert.equal(result.ok,mode==='timeout');
}
