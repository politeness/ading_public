import {configureCodexSessionRoot} from '../dist/agents/codex-session-home.js';
import assert from 'node:assert/strict';import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {CodexAdapter} from '../dist/agents/codex.js';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
const screenshotReply='**不会自动同步。**我检查了，这次只有 Codex 的 `~/.codex/skills/ading-comic-promotion` 已安装，Claude 和 Qoder 的 skills 目录里都还没有。阿钉目前只同步公共技能库里登记的文字规则，不会扫描 Codex 目录并传播；也不会复制包内的图片等资源。见[同步实现](/fixture/ading/desktop_mac/src/skills/sync.ts:50)。这个 skill 带有 5 张参考漫画，其他 Agent 需要另外安装完整技能包。';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-codex-approval-'));
configureCodexSessionRoot(path.join(dir,'codex-sessions'));
const bin=path.join(dir,'codex');
await writeFile(bin,`#!/usr/bin/env node
const readline=require('node:readline');
if(!process.argv.includes('app-server')||process.argv.includes('--dangerously-bypass-approvals-and-sandbox'))process.exit(1);
const thread='123e4567-e89b-42d3-a456-426614174000',turn='t1';let mode='',configuration,clientInfo;
const finalReply=${JSON.stringify(screenshotReply)};
const send=e=>console.log(JSON.stringify(e));
const io=readline.createInterface({input:process.stdin});io.on('close',()=>process.exit(0));
io.on('line',line=>{const e=JSON.parse(line);
 if(e.method==='initialize'){clientInfo=e.params&&e.params.clientInfo;send({id:e.id,result:{}});}
 if(e.method==='config/read')send({id:e.id,result:{config:{model:'gpt-test-fast',model_reasoning_effort:'low',service_tier:'priority'}}});
 if(e.method==='thread/start'||e.method==='thread/resume'){
  const fast=e.params.approvalPolicy==='never';
  if((fast?e.params.sandbox!=='danger-full-access':e.params.sandbox!=='read-only')||e.params.approvalsReviewer!=='user')process.exit(2);
  configuration=e.params;
  send({id:e.id,result:{thread:{id:thread}}});
 }
 if(e.method==='turn/start'){
  if(e.params.approvalPolicy!==configuration.approvalPolicy)process.exit(4);
  mode=String(e.params.input[0].text).split(String.fromCharCode(10,10))[0];send({id:e.id,result:{turn:{id:turn}}});
  if(['native-subagents','message-phases','completion-snapshot','commentary-only','legacy-message'].includes(mode)){
   const item=(id,text,phase)=>({id,type:'agentMessage',text,...(phase===undefined?{}:{phase})});
   const notify=(owner,active,entry)=>send({method:'item/completed',params:{threadId:owner,turnId:active,item:entry}});
   notify(thread,turn,item('progress','Checking the skill directories.','commentary'));
   if(mode==='native-subagents'){
    send({method:'turn/started',params:{threadId:'child-thread',turn:{id:'child-before',status:'inProgress'}}});
    notify('child-thread','child-before',item('child-final','CHILD RESULT MUST NOT BE DELIVERED','final_answer'));
    notify(thread,turn,item('parent-final',finalReply,'final_answer'));
    send({method:'turn/started',params:{threadId:'child-thread',turn:{id:'child-after',status:'inProgress'}}});
    notify('child-thread','child-after',item('child-late','LATE CHILD RESULT MUST NOT OVERWRITE','final_answer'));
    send({method:'turn/completed',params:{threadId:'child-thread',turn:{id:'child-after',status:'completed'}}});
    notify(thread,'old-turn',item('stale-final','STALE TURN MUST NOT OVERWRITE','final_answer'));
   }
   if(mode==='message-phases'){
    notify(thread,turn,item('final',finalReply,'final_answer'));
    notify(thread,turn,item('unknown','Legacy auxiliary text',null));
    notify(thread,turn,item('empty-final','   ','final_answer'));
    notify(thread,turn,item('late-progress','Late progress after the final.','commentary'));
   }
   if(mode==='legacy-message')notify(thread,turn,item('legacy',finalReply));
   send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed',items:mode==='completion-snapshot'?[item('snapshot-final',finalReply,'final_answer')]:[]}}});return;
  }
  if(mode==='steer')return;
  if(mode==='loop'){
   for(let i=0;i<8;i++){send({method:'item/started',params:{threadId:thread,turnId:turn,item:{id:'v'+i,type:'imageView',path:'/fixture/same.png'}}});send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'v'+i,type:'imageView',path:'/fixture/same.png',status:'completed'}}});}
   return;
  }
  if(mode==='config-check'){
   send({method:'item/completed',params:{threadId:thread,item:{id:'config',type:'agentMessage',phase:'final_answer',text:JSON.stringify({...configuration,clientInfo})}}});
   send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});return;
  }
  const item=mode==='file'?{id:'i1',type:'fileChange',changes:[{path:'/fixture/a.txt',kind:{type:'add'},diff:'+fixture'}]}:{id:'i1',type:'commandExecution',command:'write fixture'};
  send({method:'item/started',params:{threadId:thread,turnId:turn,item}});
  send({id:100,method:mode==='file'?'item/fileChange/requestApproval':mode==='permissions'?'item/permissions/requestApproval':'item/commandExecution/requestApproval',params:{threadId:mode==='wrong-thread'?'other':thread,turnId:turn,itemId:'i1',command:'write fixture',cwd:'/fixture',permissions:{fileSystem:{write:['/fixture/a.txt']}}}});
 }
 if(e.method==='turn/steer'){
  if(e.params.threadId!==thread||e.params.expectedTurnId!==turn)process.exit(3);
  const successor='t2';send({id:e.id,result:{turnId:successor}});
  // Real Codex echoes folded input as a userMessage (clientId = clientUserMessageId) before sampling again.
  if(e.params.input[0].text!=='late answer')send({method:'item/completed',params:{threadId:thread,turnId:successor,item:{id:'echo',type:'userMessage',clientId:e.params.clientUserMessageId??null,content:e.params.input}}});
  send({method:'item/started',params:{threadId:thread,turnId:successor,item:{id:'steered',type:'agentMessage',phase:'final_answer',text:''}}});
  send({method:'item/completed',params:{threadId:thread,turnId:successor,item:{id:'steered',type:'agentMessage',phase:'final_answer',text:'steered:'+e.params.input[0].text}}});
  send({method:'turn/completed',params:{threadId:thread,turn:{id:successor,status:'completed'}}});
 }
 if(e.id===100){
  send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'i1',type:'commandExecution',status:e.result?.decision==='accept'?'completed':'declined'}}});
  send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'m',type:'agentMessage',phase:'final_answer',text:JSON.stringify(e.result||e.error)}}});
  send({method:'rawResponse/completed',params:{threadId:thread,turnId:turn,responseId:'r1',usage:{inputTokens:120,cachedInputTokens:80,cacheWriteInputTokens:0,outputTokens:30,reasoningOutputTokens:10,totalTokens:150}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:turn,tokenUsage:{total:{inputTokens:125,cachedInputTokens:80,cacheWriteInputTokens:0,outputTokens:35,reasoningOutputTokens:10,totalTokens:160},last:{inputTokens:5,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:5,reasoningOutputTokens:0,totalTokens:10},modelContextWindow:258400}}});
  send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
 }
});
`);await chmod(bin,0o755);
const a={localUuid:'codex-test',kind:'codex',executablePath:bin};
const adapter=new CodexAdapter();
const input=(prompt,onPermission,signal)=>({prompt,onPermission,signal,workspacePath:dir,fullAccess:true,isolateMemory:true,onProgress:()=>{},timeoutMs:5000});
try {
 for(const mode of ['native-subagents','message-phases','completion-snapshot','legacy-message','commentary-only']){
  const progress=[];
  const result=await adapter.runTurn(a,{...input(mode,async()=>true),timeoutMs:2000,onProgress:text=>progress.push(text)});
  if(mode==='commentary-only'){
   assert.equal(result.ok,false,'commentary alone is not a final answer');
   assert.equal(result.partialMessage,undefined,'progress must not be published as a final reply');
   assert.match(result.error,/返回的数据不完整|returned data is incomplete/);
  }else{
   assert.equal(result.ok,true,mode+': parent completion must end the turn');
   assert.equal(result.message,screenshotReply,mode+': preserve the parent final reply');
  }
  assert.ok(progress.some(text=>text.includes('Checking the skill directories.')),mode+': commentary remains in the activity feed');
  assert.ok(!result.steps.some(text=>text.includes('CHILD RESULT')),mode+': child content stays isolated');
 }
 for(const allow of [false,true]){let calls=0;const o=await adapter.runTurn(a,input('command',async r=>{calls++;assert.equal(r.input.command,'write fixture');return allow;}));assert.ok(o.ok);assert.equal(calls,1);assert.equal(JSON.parse(o.message).decision,allow?'accept':'decline');assert.deepEqual(o.metrics.tokenUsage,{inputTokens:125,cachedInputTokens:80,cacheWriteInputTokens:0,outputTokens:35,reasoningOutputTokens:10,totalTokens:160});}
 const file=await adapter.runTurn(a,input('file',async r=>{assert.equal(r.input.changes[0].diff,'+fixture');return true;}));assert.ok(file.ok);
 const permissions=await adapter.runTurn(a,input('permissions',async()=>true));assert.equal(JSON.parse(permissions.message).scope,'turn');assert.deepEqual(JSON.parse(permissions.message).permissions.fileSystem.write,['/fixture/a.txt']);
 let snapshot;const configured=await adapter.runTurn(a,{...input('command',async()=>true),onRuntimeConfig:value=>{snapshot=value;}});assert.ok(configured.ok);assert.deepEqual(snapshot,{model:'gpt-test-fast',reasoningEffort:'low',fastMode:true,serviceTier:'priority',source:'Codex config/read'});
 for(const fastMode of [true,false]){
  const o=await adapter.runTurn(a,{...input('config-check',async()=>true),appRuntimeConfig:{model:'app-model',fastMode}});
  const tools=(JSON.parse(o.message).dynamicTools??[]).flatMap(tool=>tool.type==='namespace'?tool.tools:[tool]).map(tool=>tool.name);
  assert.ok(tools.includes('computer_apps')&&tools.includes('computer_screenshot'),'Registers computer-use tools when creating a session');
  assert.ok(o.ok);const sent=JSON.parse(o.message);
  assert.equal(sent.model,'app-model');assert.equal(sent.config.model_reasoning_effort,'low');
  assert.equal(sent.config.service_tier,fastMode?'priority':'default');
  // The version reported in the handshake comes from the client-info module, no longer hard-coded 0.1.0.
  // In plain node tests the main process never set a version, so it should be "0" meaning "unknown", not a false specific version.
  assert.equal(sent.clientInfo.name,'ading');
  assert.equal(sent.clientInfo.version,'0','Reports unknown when no version was set, never a false one');
 }

 {
  const { setClientVersion, clientInfo } = await import('../dist/agents/client-info.js');
  setClientVersion('0.4.0-2026.9.22-031500-pre');
  assert.equal(clientInfo().version,'0.4.0-2026.9.22-031500-pre','Reports the real version once the main process sets it');
  setClientVersion('   ');
  assert.equal(clientInfo().version,'0.4.0-2026.9.22-031500-pre','Empty value does not overwrite an already-set version');
 }

 // Prompts generated by ADing go to developerInstructions; this turn's input keeps only the conversation content:
 // what the user sees in Codex's own UI should be what they said, not scaffolding assembled by ADing.
 {
  const app='你是「小c」，正在 ADing 里参与一个会话。\n任务名称：对账';
  const dialogue='config-check\n\n帮我把这个月的账对一下';
  const split=await adapter.runTurn(a,{...input(app+'\n\n'+dialogue,async()=>true),split:{app,dialogue}});
  assert.ok(split.ok);
  const sent=JSON.parse(split.message);
  assert.ok(String(sent.developerInstructions).startsWith(app),'ADing-generated instructions go to developerInstructions');
  assert.ok(String(sent.developerInstructions).includes('优先使用阿钉提供的 computer_* 工具'),'Tool usage guidance also belongs to the ADing half');
  assert.ok(!String(sent.developerInstructions).includes('帮我把这个月的账对一下'),'Conversation content stays out of system instructions');
 }
 // Turns without split (e.g. report turns) stay as-is: the whole text is still sent as this turn's input
 {
  const plain=await adapter.runTurn(a,input('config-check',async()=>true));
  assert.ok(plain.ok);
  assert.equal(JSON.parse(plain.message).developerInstructions,undefined,'No developerInstructions when not split');
 }
 const unattended=await adapter.runTurn(a,{...input('config-check',async()=>{throw Error('unattended must not ask')}),steerable:true,permissionMode:'unattended'});
 assert.ok(unattended.ok);const unattendedConfig=JSON.parse(unattended.message);
 assert.equal(unattendedConfig.approvalPolicy,'never');assert.equal(unattendedConfig.sandbox,'danger-full-access');
 let mismatched=0;const wrong=await adapter.runTurn(a,input('wrong-thread',async()=>{mismatched++;return true;}));assert.equal(mismatched,0);assert.equal(JSON.parse(wrong.message).code,-32602);
 const steering=adapter.runTurn(a,input('steer',async()=>true));let steerResult;
 for(let i=0;i<100;i++){steerResult=await adapter.steer(a.localUuid,{content:'change direction',clientMessageId:'client-steer'});if(steerResult.status==='accepted')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(steerResult?.status,'accepted');const steered=await steering;assert.equal(steered.ok,true);assert.equal(steered.message,'steered:change direction');
 assert.deepEqual(steered.steersSeen,['client-steer'],'echoed steer followed by a final answer is reported as seen');
 const lateRun=adapter.runTurn(a,input('steer',async()=>true));let lateResult;
 for(let i=0;i<100;i++){lateResult=await adapter.steer(a.localUuid,{content:'late answer',clientMessageId:'late-steer'});if(lateResult.status==='accepted')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(lateResult?.status,'accepted');assert.equal((await lateRun).steersSeen,undefined,'an accepted steer without an echo keeps the fallback turn');
 const loopProgress=[];const loop=await adapter.runTurn(a,{...input('loop',async()=>true),steerable:true,onProgress:text=>loopProgress.push(text)});
 assert.ok(loop.ok);assert.match(loop.message,/执行保护提示：同一对象已重复查看 5 次/);assert.ok(loopProgress.includes('检测到重复工具循环，已在当前会话内调整方向'));
 const discussion=adapter.runTurn(a,{prompt:'steer',steerable:true,discussionOnly:true,workspacePath:dir,fullAccess:false,isolateMemory:true,onProgress:()=>{},timeoutMs:5000});let discussionSteer;
 for(let i=0;i<100;i++){discussionSteer=await adapter.steer(a.localUuid,{content:'new group input'});if(discussionSteer.status==='accepted')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(discussionSteer?.status,'accepted');assert.equal((await discussion).message,'steered:new group input');
 const abort=new AbortController();let entered;const ready=new Promise(r=>entered=r);
 const pending=adapter.runTurn(a,input('command',async request=>{entered();await new Promise(r=>request.signal.addEventListener('abort',r,{once:true}));return false;},abort.signal));
 await ready;abort.abort();assert.equal((await pending).cancelled,true);
 // Real app-server protocol -> scheduler -> durable Message Store, with and
 // without native sub-agents. Both deliver exactly one participant reply.
 const store=new LocalStore(path.join(dir,'messages'));await store.init();
 try{
  const [agent]=await store.syncDiscoveredAgents([{...a,version:'fixture'}]);
  const me=await store.currentUser();
  for(const mode of ['legacy-message','native-subagents']){
   const conversation=await store.createConversation({name:mode,memberIds:[agent.userId]});
   await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'input-'+mode,senderId:me.userId,content:'这个技能会自动同步吗？'});
   const scheduler=new LocalScheduler({idleRetryLimit:0,store,
    registry:{runTurn:(_a,input)=>adapter.runTurn(a,{...input,prompt:mode,split:undefined,onPermission:async()=>true,timeoutMs:2000})},
    syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:dir,sharesKnowledge:false}),
    resolveDiscovered:()=>a,isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
   await scheduler.runAgentTurn(conversation,agent);
   const messages=await store.listMessages(conversation.conversationId);
   const replies=messages.filter(message=>message.senderId===agent.userId&&!message.internal&&!message.failed);
   assert.equal(replies.length,1,mode+': exactly one visible final reply');
   assert.equal(replies[0].content,screenshotReply,mode+': full screenshot reply reaches Message Store');
   assert.equal(replies[0].type,'USER');
   assert.ok(replies[0].steps.some(step=>step.includes('Checking the skill directories.')),mode+': activity summary remains durable');
  }
 }finally{await store.close();}
 console.log('codex approval: real RPC route, accept/deny, full diff, native turn/steer, cross-thread rejection and cancellation passed');
}finally{await rm(dir,{recursive:true,force:true});}
