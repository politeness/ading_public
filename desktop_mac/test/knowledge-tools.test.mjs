import {configureCodexSessionRoot} from '../dist/agents/codex-session-home.js';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {knowledgeTools,runKnowledgeTool,withKnowledgeGuidance} from '../dist/knowledge/tools.js';
import {KnowledgeService} from '../dist/knowledge/service.js';
import {startParallelMcp,adingMcpNeeded} from '../dist/agents/parallel-mcp.js';
import {StreamPermissions} from '../dist/agents/stream-permissions.js';
import {ExecutionAgent} from '../dist/agents/execution-agent.js';
import {CodexAdapter} from '../dist/agents/codex.js';
import {LocalStore} from '../dist/store/local.js';
import {LocalScheduler} from '../dist/orchestration/local-scheduler.js';
import {SkillCapture} from '../dist/skills/capture.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-knowledge-tools-'));
configureCodexSessionRoot(path.join(dir,'codex-sessions'));
const signal=new AbortController().signal;
const base={prompt:'fixture',workspacePath:dir,fullAccess:false,onProgress:()=>{}};
let calls=0,approvals=0;
const callback=async(name,args)=>{calls++;return {name,args};};
try {
  assert.deepEqual(knowledgeTools().map(tool=>tool.name),['ading_skill','ading_memory']);
  for(const args of [{action:'list'},{action:'get'}])assert.equal((await runKnowledgeTool({...base,discussionOnly:true,onKnowledgeTool:callback},'ading_skill',args,signal)).args.action,args.action);
  for(const args of [{action:'create'},{action:'import'},{action:'update'},{action:'delete'},'list',{}])await assert.rejects(runKnowledgeTool({...base,discussionOnly:true,onKnowledgeTool:callback},'ading_skill',args,signal),/只读|read-only/);
  for(const action of ['append','update','delete'])await assert.rejects(runKnowledgeTool({...base,fullAccess:true,communicationOnly:true,onKnowledgeTool:callback},'ading_memory',{action},signal),/只读|read-only/);
  await runKnowledgeTool({...base,fullAccess:true,onKnowledgeTool:callback,onPermission:async()=>{approvals++;return true;}},'ading_memory',{action:'append'},signal);
  assert.equal(approvals,1,'one app approval for mutation');
  await runKnowledgeTool({...base,fullAccess:true,permissionMode:'unattended',onKnowledgeTool:callback,onPermission:async()=>{throw Error('must inherit unattended')}},'ading_memory',{action:'append'},signal);
  assert.equal(approvals,1);
  assert.match(withKnowledgeGuidance({...base,onKnowledgeTool:callback},['/scoped/SKILL.md']).prompt,/中央|central/);
  assert.ok(adingMcpNeeded({...base,onKnowledgeTool:callback,discussionOnly:true}));
  const mcp=await startParallelMcp({...base,onKnowledgeTool:callback,discussionOnly:true});
  try {
    const config=JSON.parse(mcp.config).mcpServers.ading;
    const call=async(method,params={})=>(await fetch(config.url,{method:'POST',headers:{...config.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
    const tools=(await call('tools/list')).result.tools;
    assert.deepEqual(tools.map(tool=>tool.name),['ading_skill','ading_memory'],'discussion exposes scoped knowledge only');
    const read=await call('tools/call',{name:'ading_skill',arguments:{action:'list'}});assert.equal(read.result.isError,undefined);
    const before=calls;
    const denied=await call('tools/call',{name:'ading_skill',arguments:{action:'import',sourcePath:'/fixture'}});assert.equal(denied.result.isError,true);assert.equal(calls,before,'denied writes never reach central service');
  }finally{mcp.close();}
  for(const [action,expected] of [['list','allow'],['get','allow'],['import','deny'],[undefined,'deny']]) {
    const sent=[];const permissions=new StreamPermissions({...base,discussionOnly:true,onKnowledgeTool:callback},()=>{});
    permissions.start({write:value=>{sent.push(value);return true;},end:()=>{},waitingForApproval:()=>{}});
    permissions.line({type:'control_response',response:{subtype:'success',request_id:sent[0].request_id}});
    permissions.line({type:'control_request',request_id:'knowledge',request:{subtype:'can_use_tool',tool_name:'mcp__ading__ading_skill',input:action?{action}:{}}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sent.at(-1).response.response.behavior,expected,'native MCP permission gate '+action);
    permissions.close();
  }
  class FixtureExecution extends ExecutionAgent {
    seen=[];refreshes=0;
    async readNativeConfiguration(){return {model:'fixture'};}
    async executeTurn(_agent,input){
      this.seen.push(input);
      if(input.onParallelWork) {
        const page=await input.onParallelWork({sharedInstruction:'fixture knowledge inheritance',jobs:[{id:'child',instruction:'use scoped central tools',outputs:[]}]},signal);
        assert.equal(page.results[0].ok,true);
      }
      await input.onKnowledgeTool('ading_skill',{action:'list'},signal);
      return {ok:true,threadId:'fixture-thread',message:'done',steps:[],metrics:{iterations:1,sideEffects:false}};
    }
  }
  const execution=new FixtureExecution();
  const childCalls=[];
  await execution.runTurn({kind:'codex',localUuid:'fixture',executablePath:'fixture'},{...base,fullAccess:true,permissionMode:'unattended',onKnowledgeTool:async(name,args)=>{childCalls.push([name,args]);return [];},refreshKnowledge:async()=>{execution.refreshes++;return ['/scoped/SKILL.md'];},parallelWork:{key:'task:agent',limit:2,executionSlot:false,allowSplit:true,sessionBudget:3}});
  assert.equal(execution.seen.length,2,'top-level and child provider executions');
  assert.equal(execution.refreshes,2,'each actual lane refreshes newest native copies');
  assert.equal(childCalls.length,2);
  assert.ok(execution.seen.every(input=>input.prompt.includes('/scoped/SKILL.md')&&input.onKnowledgeTool),'child receives shared knowledge handler and skill path');
  const bin=path.join(dir,'codex');
  await writeFile(bin,`#!/usr/bin/env node
const readline=require('node:readline');const send=e=>console.log(JSON.stringify(e));let config;const thread='migrated-thread',turn='turn';
if(!process.argv.includes('app-server'))process.exit(4);
readline.createInterface({input:process.stdin}).on('line',line=>{const e=JSON.parse(line);
 if(e.method==='initialize')send({id:e.id,result:{}});
 if(e.method==='config/read')send({id:e.id,result:{config:{model:'fixture'}}});
 if(e.method==='thread/start'||e.method==='thread/resume'){if(e.method==='thread/resume'&&e.params.threadId==='old-provider-thread')process.exit(8);config=e.params;send({id:e.id,result:{thread:{id:thread}}});}
 if(e.method==='turn/start'){
 send({id:e.id,result:{turn:{id:turn}}});let owner=thread,active=turn;const text=e.params.input[0].text;
 if(text.includes('native-child-')){
  owner='native-child';active='native-child-turn';
  if(text.includes('native-child-parentproof')||text.includes('native-child-ended'))send({method:'thread/started',params:{thread:{id:owner,parentThreadId:thread}}});
  if(text.includes('native-child-sourceproof'))send({method:'thread/started',params:{thread:{id:owner,source:{subAgent:{thread_spawn:{parent_thread_id:thread}}}}}});
  if(text.includes('native-child-collabproof'))send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',status:'completed',senderThreadId:thread,receiverThreadIds:[owner]}}});
  if(text.includes('native-child-unrelated'))send({method:'thread/started',params:{thread:{id:owner,parentThreadId:'unrelated-parent'}}});
  send({method:'turn/started',params:{threadId:owner,turn:{id:active}}});
  send({method:'item/completed',params:{threadId:owner,turnId:active,item:{id:'child-final',type:'agentMessage',phase:'final_answer',text:'child text must not become parent result'}}});
  if(text.includes('native-child-ended'))send({method:'turn/completed',params:{threadId:owner,turn:{id:active,status:'completed'}}});
 }
 send({id:100,method:'item/tool/call',params:{threadId:owner,turnId:active,callId:'call',namespace:'ading',tool:'ading_skill',arguments:{action:'list'}}});
}
 if(e.id===100){send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',id:'final',phase:'final_answer',text:JSON.stringify({config,result:e.result,error:e.error})}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});}
});
`);await chmod(bin,0o755);
  const codex=new CodexAdapter();
  const outcome=await codex.runTurn({kind:'codex',localUuid:'knowledge-codex',executablePath:bin},{...base,discussionOnly:true,onKnowledgeTool:callback,runtimeConfig:{model:'fixture'},timeoutMs:2000});
  assert.equal(outcome.ok,true,outcome.error);
  const native=JSON.parse(outcome.message);
  assert.equal(native.config.dynamicTools[0].type,'namespace');assert.equal(native.config.dynamicTools[0].name,'ading');
  const registered=native.config.dynamicTools[0].tools;
  assert.ok(registered.every(tool=>tool.type==='function'));
  assert.ok(registered.some(tool=>tool.name==='ading_skill')&&registered.some(tool=>tool.name==='ading_memory'));
  assert.equal(native.result.success,true,'namespaced native knowledge tool call dispatches');
  for(const mode of ['native-child-parentproof','native-child-sourceproof','native-child-collabproof','native-child-unrelated','native-child-ended']) {
    const before=calls;
    const child=await codex.runTurn({kind:'codex',localUuid:'child-'+mode,executablePath:bin},{...base,prompt:mode,discussionOnly:true,onKnowledgeTool:callback,runtimeConfig:{model:'fixture'},timeoutMs:2000});
    assert.equal(child.ok,true,child.error);const reply=JSON.parse(child.message);
    const expected=!mode.includes('unrelated')&&!mode.includes('ended');
    assert.equal(reply.result?.success===true,expected,'only proven active native descendants receive shared knowledge tools: '+mode);
    assert.equal(calls-before,expected?1:0,'foreign native calls never enter the central service');
    assert.ok(!child.message.includes('child text must not become parent result'),'native child final messages remain separate');
  }

  const store=new LocalStore(path.join(dir,'store'));await store.init();
  try {
    const w1=await store.createWorkspace({name:'one',path:path.join(dir,'one')});
    const w2=await store.createWorkspace({name:'two',path:path.join(dir,'two')});await mkdir(w1.path,{recursive:true});await mkdir(w2.path,{recursive:true});
    const [agent]=await store.syncDiscoveredAgents([{kind:'codex',localUuid:'known',executablePath:bin,version:'fixture'}]);
    const me=await store.currentUser();
    const conversation=await store.createConversation({name:'knowledge',memberIds:[agent.userId],workspaceId:w1.workspaceId});
    const resolve=async conversation=>({workspacePath:conversation.workspaceId===w1.workspaceId?w1.path:w2.path,sharesKnowledge:true,knowledgeOwnerId:conversation.workspaceId});
    const recorded=[];
    const service=new KnowledgeService(store,{invalidate:()=>{},ensureSynced:async(res,kinds)=>{recorded.push([res.knowledgeOwnerId,kinds]);return [];}},{kinds:()=>['codex','claude-code','qoder','qoder-cn'],resolveWorkspace:resolve,fallback:()=>({workspacePath:dir,sharesKnowledge:false})});
    const context={conversation,agent,resolution:await resolve(conversation)};
    const created=await service.call(context,'ading_skill',{action:'create',scope:'global',name:'central-fixture',content:'rules'},signal);
    assert.equal(created.sync.synced,true);assert.ok(recorded.some(([id])=>id===w1.workspaceId)&&recorded.some(([id])=>id===w2.workspaceId),'all discovered Agents in workspaces without chats are synchronized too');
    assert.ok(recorded.every(([,kinds])=>kinds.length===4));
    const other=await store.createSkill({scope:'workspace',ownerId:w2.workspaceId,name:'private',description:'',content:'private',authorKind:'human'});
    await assert.rejects(service.call(context,'ading_skill',{action:'get',skillId:other.skillId},signal),/作用域|scope/);
    await assert.rejects(service.call(context,'ading_memory',{action:'list',scope:'workspace',ownerId:w2.workspaceId},signal),/作用域|scope/);
    await assert.rejects(service.call(context,'ading_memory',{action:'append',scope:'user',content:'unrequested'},signal),/用户明确|user explicitly/);
    const authorized={...base,fullAccess:true,onKnowledgeTool:(name,args,signal)=>service.call(context,name,args,signal),onPermission:async()=>true};
    const personal=await runKnowledgeTool(authorized,'ading_memory',{action:'append',scope:'user',content:'explicit personal request',userRequested:true},signal);
    assert.equal(personal.result.authorKind,'human');assert.equal(personal.result.authorUserId,me.userId);
    const personalBefore=(await store.listMemories('user',me.userId)).length;
    await assert.rejects(runKnowledgeTool({...authorized,onPermission:async()=>false},'ading_memory',{action:'append',scope:'user',content:'denied personal request',userRequested:true},signal),/未获授权|not authorized/);
    assert.equal((await store.listMemories('user',me.userId)).length,personalBefore);
    await assert.rejects(store.appendMemory({scope:'user',ownerId:me.userId,content:'automatic personal capture',authorKind:'agent',authorUserId:agent.userId}));
    const scopedMemory=await store.appendMemory({scope:'workspace',ownerId:w1.workspaceId,content:'workspace-only',authorKind:'human'});
    await assert.rejects(service.call(context,'ading_memory',{action:'delete',scope:'conversation',memoryId:scopedMemory.memoryId},signal),/作用域|scope/);
    const [reviewer]=await store.syncDiscoveredAgents([{kind:'qoder',localUuid:'capture-reviewer',executablePath:'/fixture/qoder',version:'fixture'}]);
    const captureConversation={...conversation,members:[...conversation.members,{userId:reviewer.userId,role:'ENGINEER'}]};
    let releaseCapture,enterCapture;const captureGate=new Promise(resolve=>{releaseCapture=resolve;});const captureEntered=new Promise(resolve=>{enterCapture=resolve;});
    const announcements=[];let completedSyncs=0;
    const capture=new SkillCapture(store,{}, {invalidate:()=>{},ensureSynced:async()=>{throw Error('production capture must use all-discovered callback');}}, {
      afterKnowledgeSaved:async()=>{await service.saved();enterCapture();await captureGate;completedSyncs++;},
      runInConversation:async(_conversation,speaker)=>({ok:true,threadId:'capture-thread',message:speaker.userId===agent.userId ? JSON.stringify({skill:{name:'capture-knowledge',description:'reuse this',content:'central-first rule'},facts:['verified project fact']}) : JSON.stringify({problems:[]}),steps:[],metrics:{iterations:0,sideEffects:false}}),
      post:async(_id,_sender,content)=>{announcements.push(content);return {};},resolveDiscovered:()=>({kind:'qoder',localUuid:'reviewer'})
    });
    const capturing=capture.afterTurn({...context,conversation:captureConversation,evidenceFromSeq:1,evidenceToSeq:1,steps:[],metrics:{iterations:10,sideEffects:true}});
    await captureEntered;
    assert.ok((await store.listMemories('workspace',w1.workspaceId)).some(entry=>entry.content==='verified project fact'),'facts are central before copy sync');
    assert.equal(announcements.length,0,'automatic success announcement waits for all-discovered sync');
    releaseCapture();await capturing;
    assert.equal(completedSyncs,2,'both facts and accepted skill wait for central sync callback');
    assert.ok((await store.listSkills([{scope:'workspace',ownerId:w1.workspaceId}])).some(skill=>skill.name==='capture-knowledge'));
    assert.ok(announcements.some(text=>/公共库|shared library/.test(text)));
    assert.ok(!announcements.some(text=>/同步给所有 Agent|synced to all Agents/.test(text)));
    const fail=new KnowledgeService(store,{invalidate:()=>{},ensureSynced:async()=>{throw Error('sync fixture denied');}},{kinds:()=>['codex'],resolveWorkspace:resolve,fallback:()=>({workspacePath:dir,sharesKnowledge:false})});
    const memory=await fail.call(context,'ading_memory',{action:'append',content:'central survives',scope:'conversation'},signal);
    assert.equal(memory.sync.centralSaved,true);assert.equal(memory.sync.synced,false);assert.equal(memory.sync.errors,undefined,"native copy errors stay in diagnostics, not Agent tool output");
    assert.ok((await store.listMemories('conversation',conversation.conversationId)).some(entry=>entry.content==='central survives'));
    await fail.saved();assert.deepEqual(fail.syncState().failures.map(failure=>[failure.category,failure.agents.join(),failure.detail]),[['skills','codex','sync fixture denied']]);
    const references=await fail.prepare(context);assert.ok(references.some(file=>file.endsWith("SKILL.md")),"central skill remains available when native sync fails");
    await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'migration-input',senderId:me.userId,content:'read knowledge'});
    await store.saveAgentSession({conversationId:conversation.conversationId,agentUserId:agent.userId,providerThreadId:'old-provider-thread',processedSeq:0,messageSyncedSeq:0,parallelToolsVersion:8,providerThreadGeneration:1});
    const inputs=[],logs=[];
    service.syncer.ensureSynced=async()=>{throw Error("unrelated antigravity global directory unavailable");};
    const scheduler=new LocalScheduler({idleRetryLimit:0,store,knowledge:service,
      registry:{runTurn:async(_agent,input)=>{inputs.push(input);const outcome=await codex.runTurn({..._agent,localUuid:'scheduler-native'},{...input,runtimeConfig:{model:'fixture'},timeoutMs:2000});if(outcome.ok){assert.equal(JSON.parse(outcome.message).result.success,true);return {...outcome,message:'knowledge ready'};}return outcome;}},
      syncer:{ensureSynced:async()=>{throw Error("current agent native copies unavailable");}},resolveWorkspace:resolve,resolveDiscovered:()=>({kind:'codex',localUuid:'known',executablePath:bin}),isAgentReady:()=>true,broadcast:()=>{},log:async(event,data)=>logs.push([event,data])});
    try {
      await scheduler.runAgentTurn(conversation,agent);
      for(let i=0;i<100&&inputs.length<1;i++)await new Promise(resolve=>setTimeout(resolve,10));
      for(let i=0;i<100&&(await store.getAgentSession(conversation.conversationId,agent.userId))?.providerThreadId!=='migrated-thread';i++)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(inputs.length,1);assert.equal(inputs[0].threadId,undefined,'old native session is migrated once for new dynamic tools');
      assert.ok(inputs[0].onKnowledgeTool&&inputs[0].refreshKnowledge);
      const saved=await store.getAgentSession(conversation.conversationId,agent.userId);assert.equal(saved.knowledgeToolsVersion,1,JSON.stringify({saved,logs}));
      assert.ok(logs.some(([event,data])=>event==='provider-thread-discarded'&&data.reason==='knowledge-tool-channel-version'));
      const nextMessage=await store.appendMessage({conversationId:conversation.conversationId,clientMessageId:'migration-second',senderId:me.userId,content:'read again'});
      await scheduler.runAgentTurn(await store.getConversation(conversation.conversationId),agent);
      for(let i=0;i<100&&inputs.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(inputs.length,2);assert.equal(inputs[1].threadId,'migrated-thread','later turns reuse the one migrated top-level session');
      await store.saveAgentSession({...await store.getAgentSession(conversation.conversationId,agent.userId),providerThreadId:'old-provider-thread',knowledgeToolsVersion:0});
      await scheduler.speakInConversation(await store.getConversation(conversation.conversationId),agent,'Read stored knowledge only');
      assert.equal(inputs.at(-1).threadId,undefined,'internal report/review also migrates old native sessions');
      assert.ok(inputs.at(-1).prompt.includes('read knowledge'),'internal migration restores original conversation context');
      assert.equal((await store.getAgentSession(conversation.conversationId,agent.userId)).knowledgeToolsVersion,1);
      await scheduler.speakInConversation(await store.getConversation(conversation.conversationId),agent,'Read again');
      assert.equal(inputs.at(-1).threadId,'migrated-thread','internal later turn resumes');
      await store.saveAgentSession({...await store.getAgentSession(conversation.conversationId,agent.userId),providerThreadId:'old-provider-thread',knowledgeToolsVersion:0});
      const brainstorm={...await store.getConversation(conversation.conversationId),brainstorm:{phase:'ideas',leaderId:agent.userId,revision:1,round:1}};
      await scheduler.runBrainstormTurn(brainstorm,agent);
      assert.equal(inputs.at(-1).threadId,undefined,'brainstorm also migrates old native sessions');
      assert.equal((await store.getAgentSession(conversation.conversationId,agent.userId)).knowledgeToolsVersion,1);

    }finally{await scheduler.shutdown();}
  }finally{await store.close();}
  console.log('knowledge-tools: central scope, mutations, permissions, MCP, native namespaced tools, child inheritance and one-time session migration passed');
}finally{await rm(dir,{recursive:true,force:true});}
