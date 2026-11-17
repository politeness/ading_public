import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {ClaudeCodeAdapter} from '../dist/agents/claude.js';
import {QoderCnAdapter} from '../dist/agents/qoder-cn.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-approval-'));
try {
 const executable=path.join(dir,'cli');
 await writeFile(executable,`#!/usr/bin/env node
const readline=require('node:readline');
const args=process.argv.slice(2);
const fast=args.includes('bypassPermissions')||args.includes('bypass_permissions');
const send=o=>console.log(JSON.stringify(o));
let steering=false,folding=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const e=JSON.parse(line);
 if(e.request?.subtype==='initialize')send({type:'control_response',response:{request_id:e.request_id,subtype:'success',response:{}}});
 if(e.type==='user'){
  // Execution-turn prompts end with the computer-use guidance: record the original text for assertions, and pick the fake reply by the first paragraph
  const nl=String.fromCharCode(10);
  require('node:fs').appendFileSync(process.env.ADING_FAKE_PROMPTS,JSON.stringify(e.message.content)+nl);
  e.message.content=String(e.message.content).split(nl+nl)[0];
  send({type:'system',subtype:'init',session_id:'session'});
  if(fast){send({type:'result',session_id:'session',subtype:'success',result:'fast:'+e.message.content});return;}
  if(e.message.content==='steer-once'){folding=true;return;}
  // The real CLI folds a mid-turn steer into the running turn and reports it
  // with a single result, never one result per message received.
  if(folding){send({type:'result',session_id:'session',subtype:'success',result:'folded:'+e.message.content});folding=false;return;}
  if(e.message.content==='steer-first'){steering=true;return;}
  if(steering){send({type:'result',session_id:'session',subtype:'success',result:'old result'});send({type:'result',session_id:'session',subtype:'success',result:'steered:'+e.message.content});steering=false;return;}
  send({type:'control_request',request_id:'req',request:{subtype:'can_use_tool',tool_name:e.message.content==='write'?'Write':'Read',input:{file_path:'/fixture/input.txt'},tool_use_id:'tool'}});
 }
 if(e.type==='control_response'){
  send({type:'result',session_id:'session',subtype:'success',result:e.response.response.behavior==='allow'?'file read completed':'blocked'});
 }
});
`);await chmod(executable,0o755);
 process.env.ADING_FAKE_PROMPTS=path.join(dir,'prompts.log');
 for(const adapter of [new ClaudeCodeAdapter(),new QoderCnAdapter()]) {
  const agent={kind:adapter.kind,localUuid:adapter.kind,executablePath:executable};
  const base={prompt:'read',workspacePath:dir,fullAccess:false,onProgress:()=>{}};
  let calls=0;
  const yes=await adapter.runTurn(agent,{...base,onPermission:async r=>{calls++;assert.equal(r.toolName,'Read');assert.deepEqual(r.input,{file_path:'/fixture/input.txt'});return true;}});
  assert.equal(calls,1);assert.equal(yes.ok,true);assert.equal(yes.message,'file read completed');
  const no=await adapter.runTurn(agent,{...base,onPermission:async()=>false});assert.equal(no.ok,false);assert.match(no.error,/未获授权/);
  assert.equal(no.partialMessage,'blocked','when denied, the model final report is still returned so the user can see what was actually done');
  const write=await adapter.runTurn(agent,{...base,prompt:'write',onPermission:async()=>{throw Error('read-only write must never prompt');}});assert.equal(write.ok,false);
  let writes=0;
  const report=await adapter.runTurn(agent,{...base,fullAccess:true,prompt:'write',onPermission:async r=>{writes++;assert.equal(r.toolName,'Write');return true;}});
  assert.equal(writes,1,'report writes in an execution turn must reach the approval policy');assert.equal(report.ok,true);
  const fast=await adapter.runTurn(agent,{...base,fullAccess:true,steerable:true,permissionMode:'unattended',prompt:'fast-read',onPermission:async()=>{throw Error('unattended fast path must not request approval');}});
  assert.equal(fast.ok,true);assert.equal(fast.message,'fast:fast-read');
  const sent=(await readFile(process.env.ADING_FAKE_PROMPTS,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(sent.some(prompt=>prompt.startsWith('fast-read')&&prompt.includes('优先使用阿钉提供的 computer_* 工具')),'fully authorized execution turns attach the computer-use guidance');
  assert.ok(sent.filter(prompt=>prompt==='read').length>0,'read-only turns attach no guidance');
  const steeringRun=adapter.runTurn(agent,{...base,fullAccess:true,prompt:'steer-first',onPermission:async()=>true});let steerResult;
  for(let i=0;i<100;i++){steerResult=await adapter.steer(agent.localUuid,{content:'new direction',clientMessageId:'steer-message'});if(steerResult.status==='accepted')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(steerResult?.status,'accepted');const steered=await steeringRun;assert.equal(steered.ok,true);
  // The first result answers the original request and the CLI's follow-up turn the
  // steer; dropping the first would lose that answer.
  assert.equal(steered.message,'old result\n\nsteered:new direction');assert.deepEqual(steered.steersSeen,['steer-message']);
  // A steer folded into the running turn must still release the process. Counting
  // it as its own expected result left stdin open, so the finished answer sat
  // undelivered until the inactivity watchdog killed the CLI and reported failure.
  const foldedRun=adapter.runTurn(agent,{...base,fullAccess:true,prompt:'steer-once',timeoutMs:8000,onPermission:async()=>true});let foldResult;
  for(let i=0;i<100;i++){foldResult=await adapter.steer(agent.localUuid,{content:'guard nudge',clientMessageId:'guard-message'});if(foldResult.status==='accepted')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(foldResult?.status,'accepted');
  const folded=await foldedRun;
  assert.equal(folded.ok,true,'a turn ending with a result must deliver normally instead of waiting for the idle timeout');
  assert.equal(folded.message,'folded:guard nudge');
  const discussionRun=adapter.runTurn(agent,{...base,prompt:'steer-first',steerable:true,discussionOnly:true});let discussionSteer;
  for(let i=0;i<100;i++){discussionSteer=await adapter.steer(agent.localUuid,{content:'group interjection'});if(discussionSteer.status==='accepted')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(discussionSteer?.status,'accepted');assert.equal((await discussionRun).message,'old result\n\nsteered:group interjection');
  const controller=new AbortController();let asked;
  const askedPromise=new Promise(resolve=>asked=resolve);
  const run=adapter.runTurn(agent,{...base,signal:controller.signal,onPermission:r=>new Promise(resolve=>{asked();r.signal.addEventListener('abort',()=>resolve(true));})});
  await askedPromise;controller.abort();const cancelled=await run;assert.equal(cancelled.ok,false);assert.equal(cancelled.cancelled,true);
  assert.equal(adapter.isBusy(agent.localUuid),false);
 }
 console.log('permission-flow: Claude/Qoder approval, deny, readonly write denial, native stream steering and cancellation passed');
}finally{await rm(dir,{recursive:true,force:true});}
