import {configureCodexSessionRoot} from '../dist/agents/codex-session-home.js';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {WorkSlots,CompletionFeed,parallelTool,parseParallelJobs,inspectOutputs,outputSpecsConflict} from '../dist/agents/parallel-work.js';
import {CodexAdapter} from '../dist/agents/codex.js';
const feed=new CompletionFeed('batch',2),feedSignal=new AbortController();
const first=feed.next(0,feedSignal.signal);feed.push({id:'fast',ok:true});const early=await first;
assert.equal(early.pending,1);assert.deepEqual(early.results,[{id:'fast',ok:true}]);
feed.push({id:'slow',ok:false});const later=await feed.next(early.cursor,feedSignal.signal);assert.equal(later.pending,0);assert.deepEqual(later.results,[{id:'slow',ok:false}]);
assert.deepEqual((await feed.next(later.cursor,feedSignal.signal)).results,[]);
const waitingFeed=new CompletionFeed('waiting',1),stopFeed=new AbortController();const wait=waitingFeed.next(0,stopFeed.signal);stopFeed.abort();await assert.rejects(wait);
const slots=new WorkSlots(),releases=[];
for(let i=0;i<10;i++)releases.push(await slots.acquire('conversation-a:agent',10));
let started=false;const queued=slots.acquire('conversation-a:agent',10).then(release=>{started=true;return release;});
await Promise.resolve();assert.equal(started,false,'11th job waits');
const otherConversation=await slots.acquire('conversation-b:agent',10);const otherAgent=await slots.acquire('conversation-a:other',10);otherConversation();otherAgent();
releases.shift()();const extra=await queued;assert.equal(started,true,'release fills waiting work');extra();releases.forEach(r=>r());
const held=await slots.acquire('cancel',1),abort=new AbortController();const cancelled=slots.acquire('cancel',1,abort.signal);abort.abort();await assert.rejects(cancelled);held();(await slots.acquire('cancel',1))();
assert.throws(()=>parseParallelJobs({jobs:[{id:'a',instruction:'x',outputs:['out']},{id:'b',instruction:'y',outputs:['out/file']}]},'/tmp'),/冲突/);
assert.throws(()=>parseParallelJobs({jobs:[{id:'a',instruction:'x',outputs:[]},{id:'a',instruction:'y',outputs:[]}]},'/tmp'),/唯一/);
const shared=parseParallelJobs({sharedInstruction:'共同验收一次说明',jobs:[{id:'a',instruction:'只写本项差异',outputs:[]}]},'/tmp');
assert.equal(shared[0].sharedInstruction,'共同验收一次说明');assert.equal(shared[0].instruction,'只写本项差异','shared prefix stays separate so provider caching reaches the unique suffix');
assert.equal(parallelTool.inputSchema.oneOf.length,2);assert.ok(parallelTool.inputSchema.oneOf.every(branch=>branch.additionalProperties===false),'submit and poll requests are structurally exclusive');
assert.match(parallelTool.description,/coverage-audit/);assert.match(parallelTool.description,/依赖图/);assert.match(parallelTool.description,/继续修正直到合格/);assert.doesNotMatch(parallelTool.description,/最多一次|返回父会话|逐参数循环/);assert.match(parallelTool.description,/独立候选/);
assert.throws(()=>parseParallelJobs({sharedInstruction:'  ',jobs:[{id:'a',instruction:'x',outputs:[]}]},'/tmp'),/公共说明/);
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-parallel-')),bin=path.join(dir,'codex');
configureCodexSessionRoot(path.join(dir,'codex-sessions'));
assert.throws(()=>parseParallelJobs({jobs:[{id:'placeholder',instruction:'x',outputs:['IMG_q<按数量递增>.png']}]},dir),/不能使用占位符/);
assert.equal(outputSpecsConflict(path.join(dir,'IMG_0952_q*.png'),path.join(dir,'IMG_0953_q*.png')),false);
assert.equal(outputSpecsConflict(path.join(dir,'IMG_0952_q*.png'),path.join(dir,'IMG_0952_q2.png')),true);
await writeFile(path.join(dir,'IMG_0952_q1.png'),'one');await writeFile(path.join(dir,'IMG_0952_q2.png'),'two');
await mkdir(path.join(dir,'looks-like-output.png'));
assert.deepEqual((await inspectOutputs([path.join(dir,'IMG_0952_q*.png')])).artifacts.map(p=>path.basename(p)),['IMG_0952_q1.png','IMG_0952_q2.png']);
assert.deepEqual((await inspectOutputs([path.join(dir,'looks-like-output.png')])).missing,[path.join(dir,'looks-like-output.png')],'directories are not deliverable files');
await writeFile(bin,`#!/usr/bin/env node
const readline=require('node:readline'),crypto=require('node:crypto');
const thread=crypto.randomUUID(),turn='turn';let tools,mode,namespace;let gathered=[];
const send=e=>console.log(JSON.stringify(e));const io=readline.createInterface({input:process.stdin});io.on('close',()=>process.exit(0));
const finish=text=>{send({method:'item/completed',params:{threadId:thread,item:{id:'final',type:'agentMessage',phase:'final_answer',text}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});};
io.on('line',line=>{const e=JSON.parse(line);
 if(e.method==='initialize')send({id:e.id,result:{}});
 if(e.method==='config/read')send({id:e.id,result:{config:{model:'gpt-test',model_reasoning_effort:'medium',service_tier:'priority'}}});
 if(e.method==='thread/start'){tools=(e.params.dynamicTools??[]).flatMap(tool=>tool.type==='namespace'?tool.tools.map(member=>({...member,namespace:tool.name})):[tool]);send({id:e.id,result:{thread:{id:thread}}});}
 if(e.method==='turn/start'){
  mode=String(e.params.input[0].text).split(String.fromCharCode(10,10))[0];
  send({id:e.id,result:{turn:{id:turn}}});
  if(tools?.some(t=>t.name==='ading_parallel')){
   namespace=tools.find(tool=>tool.name==='ading_parallel').namespace;
   send({id:100,method:'item/tool/call',params:{threadId:thread,turnId:turn,...(namespace?{namespace}:{}),tool:'ading_parallel',arguments:{stream:mode==='stream-good'||mode==='stream-early',jobs:[{id:'one',instruction:'fixture-one',outputs:[]},{id:'two',instruction:'fixture-two',outputs:[]},{id:'missing',instruction:'fixture-missing',outputs:['missing.txt']}]}}});
  }else {const id=crypto.randomUUID();send({method:'item/started',params:{threadId:thread,item:{id,type:'commandExecution',command:'fixture'}}});setTimeout(()=>{send({method:'item/completed',params:{threadId:thread,item:{id,type:'commandExecution',status:'completed'}}});finish('fixture result');},120);}
 }
 if(e.id>=100){if(e.error)finish(JSON.stringify(e.error));else {
   const r=JSON.parse(e.result.contentItems[0].text);
   if(mode==='stream-good'){gathered.push(...r.results);if(r.pending>0){send({id:e.id+1,method:'item/tool/call',params:{threadId:thread,turnId:turn,...(namespace?{namespace}:{}),tool:'ading_parallel',arguments:{batchId:r.batchId,cursor:r.cursor}}});}else finish(JSON.stringify({results:gathered,incremental:e.id>100}));}
   else finish(JSON.stringify(r));
 }}
});
`);await chmod(bin,0o755);
try {
 const adapter=new CodexAdapter(),events=[];
 const result=await adapter.runTurn({localUuid:'same-agent',kind:'codex',executablePath:bin},{prompt:'parent',workspacePath:dir,fullAccess:true,onPermission:async()=>false,parallelWork:{key:'t:a',limit:2,executionSlot:true,allowSplit:true,sessionBudget:3},onProgress:()=>{},onAudit:e=>events.push(e),signal:AbortSignal.timeout(10000)});
 assert.ok(result.ok,JSON.stringify(result));const batch=JSON.parse(result.message).results;
 assert.deepEqual(batch.map(x=>x.ok),[true,true,false]);assert.match(batch[2].error,/不存在或为空/);
 assert.equal(new Set(batch.map(x=>x.threadId)).size,3,'each job has independent provider context');
 let active=0,peak=0;for(const e of events.filter(x=>x.kind==='commandExecution')){active+=e.phase==='item/started'?1:-1;peak=Math.max(peak,active);}assert.equal(peak,2,'real RPC workers overlap and respect capacity');assert.equal(active,0);
 const streamed=await adapter.runTurn({localUuid:'stream-parent',kind:'codex',executablePath:bin},{prompt:'stream-good',workspacePath:dir,fullAccess:true,onPermission:async()=>false,parallelWork:{key:'stream-conversation:a',limit:1,executionSlot:true,allowSplit:true,sessionBudget:2},onProgress:()=>{},signal:AbortSignal.timeout(10000)});
 assert.ok(streamed.ok,JSON.stringify(streamed));const streamResult=JSON.parse(streamed.message);assert.equal(streamResult.incremental,true);assert.deepEqual(streamResult.results.map(x=>x.id),['one','two','missing'],'cursor drains each result once while other jobs run');
 const earlyExit=await adapter.runTurn({localUuid:'early-parent',kind:'codex',executablePath:bin},{prompt:'stream-early',workspacePath:dir,fullAccess:true,onPermission:async()=>false,parallelWork:{key:'early-conversation:a',limit:1,executionSlot:false,allowSplit:true,sessionBudget:2},onProgress:()=>{},signal:AbortSignal.timeout(10000)});
 assert.equal(earlyExit.ok,false,'parent cannot claim completion while work remains');assert.equal(adapter.busyIds().length,0);
 const abortRun=new AbortController();let childStarted=false;
 const cancelledRun=await adapter.runTurn({localUuid:'cancel-parent',kind:'codex',executablePath:bin},{prompt:'parent',workspacePath:dir,fullAccess:true,onPermission:async()=>false,parallelWork:{key:'cancel-conversation:a',limit:1,executionSlot:false,allowSplit:true,sessionBudget:2},onProgress:()=>{},onAudit:e=>{if(e.kind==='commandExecution'&&e.phase==='item/started'){childStarted=true;abortRun.abort();}},signal:abortRun.signal});
 assert.ok(childStarted);assert.equal(cancelledRun.cancelled,true);assert.equal(adapter.busyIds().length,0,'cancellation drains running and queued children');
 console.log('parallel-work: task/agent capacity, 11th queued, refill, cancellation, output conflicts, native dynamic RPC, isolated sessions and missing outputs passed');
}finally{await rm(dir,{recursive:true,force:true});}
