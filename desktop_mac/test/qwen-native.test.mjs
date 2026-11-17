// Explicit integration test against an installed Qwen CLI and a loopback API fixture.
// Usage: node test/qwen-native.test.mjs /absolute/path/to/qwen
// No external API, user configuration, or credentials are used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {QwenCodeAdapter} from '../dist/agents/qwen.js';
const executablePath=process.argv[2];assert.ok(executablePath&&path.isAbsolute(executablePath),'Pass an installed Qwen executable');
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-qwen-native-'));
const saved={...process.env};const requests=[];let scenario='text',knowledgeCalls=0,parallelCalls=0,overflowRequests=[];
const server=createServer(async(req,res)=>{
 try {
  let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);requests.push({...b,fixturePath:req.url});
  if(scenario==='cancel')return;
  if(scenario==='context-overflow') {
   overflowRequests.push(b);
   if(overflowRequests.length<3){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'Engine protocol predict request returned 400: prompt exceeds the context window',type:'invalid_request_error',code:'context_length_exceeded'}}));return;}
  }
  const invalid=(b.tools??[]).filter(t=>t.function?.parameters?.type==='object'&&!t.function.parameters.properties);
  if(invalid.length){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'Missing function.parameters.properties: '+invalid.map(t=>t.function.name).join(',')}}));return;}

  const toolResult=b.messages.some(m=>m.role==='tool');
  let delta={role:'assistant',content:'NATIVE_OK'},finish='stop';
  if(!toolResult&&!['text','context-overflow'].includes(scenario)){
   const name=scenario==='computer'?'mcp__ading__computer_apps':scenario==='knowledge'?'mcp__ading__ading_memory':scenario==='parallel'?'mcp__ading__ading_parallel':'write_file';
   const args=scenario==='computer'?{}:scenario==='knowledge'?{action:'list',scope:'user'}:scenario==='parallel'?{jobs:[{id:'fixture',instruction:'fixture',outputs:[]}]}:{file_path:path.join(dir,'result.txt'),content:'native output'};
   delta={role:'assistant',tool_calls:[{index:0,id:'call_fixture',type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls';
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:b.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:b.model,choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:20,completion_tokens:3,total_tokens:23}})+'\n\n');
  res.end('data: [DONE]\n\n');
 }catch(e){res.writeHead(500).end(String(e));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
 process.env.QWEN_HOME=path.join(dir,'native');await mkdir(process.env.QWEN_HOME);
 process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH=path.join(dir,'system.json');
 process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH=path.join(dir,'defaults.json');
 process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH=path.join(dir,'trust.json');
 process.env.ADING_QWEN_FIXTURE_KEY='loopback-only';
 await writeFile(path.join(process.env.QWEN_HOME,'settings.json'),JSON.stringify({security:{auth:{selectedType:'openai'}},model:{name:'fixture-model',baseUrl:`http://127.0.0.1:${server.address().port}/selected/v1`},modelProviders:{openai:[{id:'fixture-model',baseUrl:`http://127.0.0.1:${server.address().port}/first/v1`,envKey:'ADING_QWEN_FIXTURE_KEY'},{id:'fixture-model',baseUrl:`http://127.0.0.1:${server.address().port}/selected/v1`,envKey:'ADING_QWEN_FIXTURE_KEY'},{id:'alternate-model',baseUrl:`http://127.0.0.1:${server.address().port}/override/v1`,envKey:'ADING_QWEN_FIXTURE_KEY'}]},telemetry:{enabled:false}}));
 const adapter=new QwenCodeAdapter();
 const agent={kind:'qwen-code',localUuid:'qwen-native-test',name:'Qwen Code',executablePath};
 const base={workspacePath:dir,timeoutMs:25000,fullAccess:false,prompt:'Reply NATIVE_OK',onProgress:()=>{}};
 assert.equal((await adapter.verify(agent)).ok,true);assert.ok(requests.at(-1).tools===undefined||requests.at(-1).tools.length===0,'probe must not advertise tools');
 assert.ok(requests.at(-1).fixturePath.startsWith('/selected/'),'handshake must preserve native provider selection for duplicate model IDs');
 let out=await adapter.runTurn(agent,{...base,discussionOnly:true});assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.message,'NATIVE_OK');assert.ok(out.threadId);
 assert.ok(requests.at(-1).fixturePath.startsWith('/selected/'),'turn must preserve native provider selection for duplicate model IDs');
 const session=out.threadId;
 out=await adapter.runTurn(agent,{...base,discussionOnly:true,runtimeConfig:{model:'fixture-model',reasoningEffort:'high'}});assert.equal(out.ok,true,JSON.stringify(out));
 assert.equal(requests.at(-1).reasoning?.effort??requests.at(-1).reasoning_effort,'high','SDK effort must reach the model request');
 assert.ok(requests.at(-1).fixturePath.startsWith('/selected/'));
 out=await adapter.runTurn(agent,{...base,discussionOnly:true,appRuntimeConfig:{model:'alternate-model'}});assert.equal(out.ok,true,JSON.stringify(out));
 assert.equal(requests.at(-1).model,'alternate-model');assert.ok(requests.at(-1).fixturePath.startsWith('/override/'));
 out=await adapter.runTurn(agent,{...base,discussionOnly:true,threadId:session});assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.threadId,session);
 scenario='write';let permissions=0;
 out=await adapter.runTurn(agent,{...base,fullAccess:true,onPermission:async r=>{permissions++;assert.equal(r.toolName,'write_file');return true;}});
 assert.equal(out.ok,true,JSON.stringify(out));assert.equal(permissions,1);assert.equal(await readFile(path.join(dir,'result.txt'),'utf8'),'native output');
 await rm(path.join(dir,'result.txt'));
 out=await adapter.runTurn(agent,{...base,fullAccess:true,onPermission:async()=>false});assert.equal(out.ok,false);await assert.rejects(access(path.join(dir,'result.txt')));
 out=await adapter.runTurn(agent,{...base,onPermission:async()=>{throw Error('read-only must not request write approval')}});await assert.rejects(access(path.join(dir,'result.txt')));
 assert.ok(requests.at(-1).tools?.every(t=>['read_file','list_directory','glob','grep_search'].includes(t.function.name)),'read-only schemas must be restricted');
 scenario='knowledge';
 out=await adapter.runTurn(agent,{...base,fullAccess:true,onKnowledgeTool:async(name,args)=>{knowledgeCalls++;assert.equal(name,'ading_memory');assert.equal(args.action,'list');return []},onPermission:async()=>true});
 assert.equal(out.ok,true,JSON.stringify(out));assert.equal(knowledgeCalls,1);
 if(process.platform==='darwin'){
  // MCP schemas can be deferred: exercise the registered tool, not its presence in the first API request.
  scenario='computer';process.env.ADING_COMPUTER_HELPER=path.join(dir,'computer-helper');
  await writeFile(process.env.ADING_COMPUTER_HELPER,'#!/usr/bin/env node\nrequire("node:fs").writeFileSync('+JSON.stringify(path.join(dir,'computer-called'))+',process.argv[2]);console.log(JSON.stringify({ok:true,apps:[]}));',{mode:0o700});
  out=await adapter.runTurn(agent,{...base,fullAccess:true,onPermission:async()=>true});assert.equal(out.ok,true,JSON.stringify(out));assert.equal(await readFile(path.join(dir,'computer-called'),'utf8'),'apps');
 }
 scenario='parallel';
 out=await adapter.runTurn(agent,{...base,fullAccess:true,onParallelWork:async()=>{parallelCalls++;return {status:'completed',results:[]}},onPermission:async()=>true});
 assert.equal(out.ok,true,JSON.stringify(out));assert.equal(parallelCalls,1);
 // The real CLI echoes API failures as assistant text before its error result.
 // Exercise the adapter -> shared parser -> budget recovery chain, not a mock outcome.
 scenario='context-overflow';
 const history=['OLD_ONE '.repeat(100),'OLD_TWO '.repeat(100),'OLD_THREE '.repeat(100),'LATEST_REQUEST'];
 const dialogue=history.join('\n\n');
 out=await adapter.runTurn(agent,{...base,discussionOnly:true,prompt:'fixed rules\n\n'+dialogue,split:{app:'fixed rules',dialogue},contextMessages:history});
 assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.message,'NATIVE_OK');
 assert.equal(overflowRequests.length,3,'API-error echoes must not block silent shrinking retries');
 const payloads=overflowRequests.map(request=>JSON.stringify(request.messages));
 assert.ok(payloads[0].includes('OLD_ONE'));assert.ok(!payloads[1].includes('OLD_ONE'));assert.ok(!payloads[2].includes('OLD_TWO'));
 for(const payload of payloads){assert.ok(payload.includes('LATEST_REQUEST'));assert.ok(payload.includes('fixed rules'));assert.ok(!payload.includes('[API Error:'),'failed provider transcripts must not be resumed');}
 assert.deepEqual(history,['OLD_ONE '.repeat(100),'OLD_TWO '.repeat(100),'OLD_THREE '.repeat(100),'LATEST_REQUEST']);
 scenario='cancel';const controller=new AbortController();
 const pending=adapter.runTurn(agent,{...base,signal:controller.signal});setTimeout(()=>controller.abort(),1500);
 out=await pending;assert.equal(out.cancelled,true);assert.deepEqual(adapter.busyIds(),[]);
 console.log('qwen-native: installed CLI handshake, native provider selection, model override, effort, restricted schemas, resume, approved/denied write, MCP knowledge/parallel/computer, cancellation passed');
} finally {
 server.closeAllConnections();server.close();await rm(dir,{recursive:true,force:true});
 for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
}
