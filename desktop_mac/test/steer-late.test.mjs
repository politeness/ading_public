import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, chmod, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';
import {ClaudeCodeAdapter} from '../dist/agents/claude.js';
import {QoderCnAdapter} from '../dist/agents/qoder-cn.js';

// End to end through the real stream-json adapter and the scheduler: a steered
// message is settled once the CLI handled it, whether folded into the running turn
// (echoed) or answered by the follow-up turn the CLI starts on its own when the
// steer lands after the final answer. Only an unhandled, failed or cancelled steer
// keeps the fallback turn. The fake CLI replays what qodercli 1.1.42 and Claude
// Code 2.1.309 emit live.
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-steer-late-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,label='condition') {for(let i=0;i<1000;i++){if(await predicate())return;await sleep(10);}throw Error(`timeout: ${label}`);}
const executable=path.join(dir,'cli');
await writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs');
const send=o=>process.stdout.write(JSON.stringify(o)+String.fromCharCode(10));
const marker=name=>fs.writeFileSync(require('node:path').join(process.env.ADING_STEER_MARKERS,name),'');
const say=text=>send({type:'assistant',session_id:'s',message:{content:[{type:'text',text}]},parent_tool_use_id:null});
const result=(text,error)=>send({type:'result',session_id:'s',subtype:error?'error':'success',is_error:!!error,result:text,parent_tool_use_id:null});
const init=()=>send({type:'system',subtype:'init',session_id:'s',tools:['mcp__ading__ading_parallel']});
let mode,ended=false,pending=0;
const finish=()=>{if(ended&&!pending)process.exit(0);};
// After the first result the CLI runs a queued steer as its own turn, whether or not
// stdin is still open, and exits once that turn is done and stdin is closed.
const followUp=steer=>{pending++;setTimeout(()=>{
  init();
  if(mode==='CANCEL'){marker('CANCEL-followup');return;}
  if(process.env.ADING_STEER_REPLAY)send({type:'user',session_id:'s',message:{role:'user',content:steer},parent_tool_use_id:null,isReplay:true});
  say('second answer');
  result(mode==='FAIL'?'follow-up failed':'second answer',mode==='FAIL');
  pending--;finish();
},30);};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const e=JSON.parse(line);
  if(e.request?.subtype==='initialize'){send({type:'control_response',response:{request_id:e.request_id,subtype:'success',response:{}}});return;}
  if(e.type!=='user')return;
  const text=String(e.message.content);
  if(!mode){
    if(text.includes('_FOLLOW')){init();say('fallback answer');result('fallback answer');mode='DONE';return;}
    mode=(text.match(/(EARLY|LATE|DROP|FAIL|CANCEL)_START/)||[])[1]||'DONE';
    init();
    if(mode==='EARLY')send({type:'assistant',session_id:'s',message:{content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:'sleep 1'}}]},parent_tool_use_id:null});
    else say('first answer');
    marker(mode);
    return;
  }
  // The steer itself.
  if(mode==='EARLY'){send({type:'user',session_id:'s',message:{role:'user',content:text},parent_tool_use_id:null});say('handled both');result('handled both');return;}
  result('first answer');
  if(mode!=='DROP')followUp(text);
});
process.stdin.on('end',()=>{ended=true;finish();});
`);
await chmod(executable,0o755);
const markers=path.join(dir,'markers');await mkdir(markers);
process.env.ADING_STEER_MARKERS=markers;
const exists=file=>access(file).then(()=>true,()=>false);

let scheduler;
try {
 for(const [Adapter,replay] of [[QoderCnAdapter,false],[ClaudeCodeAdapter,true]]){
  await rm(markers,{recursive:true,force:true});await mkdir(markers);
  if(replay)process.env.ADING_STEER_REPLAY='1';else delete process.env.ADING_STEER_REPLAY;
  const adapter=new Adapter();
  const store=new LocalStore(path.join(dir,adapter.kind)); await store.init();
  const discovered=[{kind:adapter.kind,localUuid:`${adapter.kind}-agent`,executablePath:executable}];
  const [agent]=await store.syncDiscoveredAgents(discovered);
  const prompts=[];
  const registry={runTurn:(d,input)=>{prompts.push(input.prompt);return adapter.runTurn(d,input);},
    steer:(_kind,id,input)=>adapter.steer(id,input),cancel:id=>adapter.cancel(id)};
  scheduler=new ConversationScheduler({idleRetryLimit:0,store,registry,syncer:{ensureSynced:async()=>[]},
    resolveWorkspace:async conversation=>{const workspacePath=path.join(dir,adapter.kind,conversation.conversationId);await mkdir(workspacePath,{recursive:true});return{workspacePath,sharesKnowledge:false};},
    resolveDiscovered:()=>discovered[0],isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
  const replies=async id=>(await store.listMessages(id)).filter(m=>m.senderId===agent.userId);
  const watermark=async id=>(await store.getConversation(id)).members.find(m=>m.userId===agent.userId).lastProcessedSeq;
  const scenario=async mode=>{
    const conversation=await scheduler.createConversation({name:`${adapter.kind}-${mode}`,memberIds:[agent.userId],initialMessage:`${mode}_START`});
    await until(()=>exists(path.join(markers,mode)),`${mode} ready`);
    const before=prompts.length;
    const follow=await scheduler.sendUserMessage({conversationId:conversation.conversationId,clientMessageId:`${adapter.kind}-${mode}-follow`,content:`${mode}_FOLLOW`});
    if(mode==='CANCEL'){await until(()=>exists(path.join(markers,'CANCEL-followup')),'cancel follow-up');adapter.cancel(discovered[0].localUuid);}
    await until(async()=>(await replies(conversation.conversationId)).length>0,`${mode} reply`);
    await sleep(80);
    return {id:conversation.conversationId,follow,fallbacks:()=>prompts.slice(before).filter(p=>p.includes(`${mode}_FOLLOW`)).length};
  };
  const label=adapter.kind;
  {
    const {id,follow,fallbacks}=await scenario('EARLY');
    assert.equal(fallbacks(),0,`${label}: a steer echoed into the running turn is not replayed`);
    assert.equal((await replies(id))[0].content,'handled both');
    assert.ok(await watermark(id)>=follow.seq);
  }
  {
    const {id,follow,fallbacks}=await scenario('LATE');
    assert.equal(fallbacks(),0,`${label}: a late steer the CLI answered in its own follow-up turn is not replayed`);
    const all=await replies(id);
    assert.equal(all.length,1,`${label}: one reply, not a duplicate`);
    assert.equal(all[0].content,'first answer\n\nsecond answer','both turns are kept in the reply');
    assert.ok(await watermark(id)>=follow.seq,'the late steer counts as processed');
    assert.equal(scheduler.runtimeSnapshot().queued.length,0);
  }
  for(const mode of ['DROP','FAIL','CANCEL']){
    const {id,follow,fallbacks}=await scenario(mode);
    await until(()=>fallbacks()===1,`${label}: ${mode} keeps the fallback turn`);
    await until(async()=>(await replies(id)).some(m=>m.content==='fallback answer'),`${mode} fallback reply`);
    await until(async()=>await watermark(id)>=follow.seq,`${mode} watermark`);
    await sleep(80);
    assert.equal(fallbacks(),1,`${label}: ${mode} replays the steer exactly once`);
  }
  await scheduler.shutdown();scheduler=undefined;
 }
 console.log('steer-late: Qoder/Claude steers settle when the CLI handled them in-turn or in its own follow-up turn; unhandled, failed and cancelled steers keep one fallback turn');
} finally {
 await scheduler?.shutdown();
 await sleep(50);
 await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});
}
