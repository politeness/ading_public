import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,chmod,access,readdir} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtemp} from './tmp.mjs';
import {KiroAdapter,CopilotAdapter,removeStaleKiroProfiles} from '../dist/agents/acp-providers.js';
import {AntigravityAdapter} from '../dist/agents/antigravity.js';
import {startNativeToolBridge,stdioMcpServer} from '../dist/agents/native-tool-bridge.js';
import {startParallelMcp} from '../dist/agents/parallel-mcp.js';
import {AgentRegistry} from '../dist/agents/registry.js';
const exec=promisify(execFile),root=await mkdtemp(path.join(os.tmpdir(),'ading-new-agents-'));
const cli=path.join(root,'fake-acp.cjs');
await writeFile(cli,`#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
const update=(sessionId,text)=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
let session='parent', prompt, method, approval;
rl.on('line',async line=>{const m=JSON.parse(line);
if(m.method==='initialize')reply(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true,mcpCapabilities:{http:true}}});
else if(m.method==='session/new'||m.method==='session/load'){
 session=m.params.sessionId||'parent'; method=m.method; update(session,'REPLAY MUST NOT APPEAR');
 if(m.params.mcpServers?.length){const s=m.params.mcpServers[0];const call=async(method,params)=>{
 const r=await fetch(s.url,{method:'POST',headers:{'Content-Type':'application/json',...Object.fromEntries(s.headers.map(x=>[x.name,x.value]))},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return (await r.json()).result;};
 const list=await call('tools/list',{});
 if(process.argv.includes('--agent-engine=v2')){
  for(const tool of list.tools){if(['oneOf','allOf','anyOf'].some(key=>key in tool.inputSchema)){
   send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'Internal error',data:{message:'tools.1.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level'}}});return;
  }}
 }
 if(list.tools.some(t=>t.name==='ading_parallel')){
  const tool=list.tools.find(t=>t.name==='ading_parallel');
  if(tool.inputSchema.properties.jobs.items.required.join(',')!=='id,instruction,outputs')throw Error('Missing job constraints');
  if(!list.tools.some(t=>t.name==='computer_apps'))throw Error('Computer tools missing');
  for(const args of [{jobs:[{id:'fixture',instruction:'read only fixture',outputs:[]}]},{batchId:'fixture',cursor:0}]){
   const result=await call('tools/call',{name:'ading_parallel',arguments:args});if(result.isError)throw Error('Parallel call failed');
  }
 }
 if(list?.tools?.some(t=>t.name==='ading_memory')){const v=await call('tools/call',{name:'ading_memory',arguments:{action:'list'}});if(v.isError)throw Error('MCP call failed');}}

 reply(m.id,{sessionId:session,models:{currentModelId:'fixture',availableModels:[{modelId:'fixture'}]}});
}else if(m.method==='session/prompt'){
 prompt=m.id;if(m.params.prompt[0].text==='hang')return;
 update('child','CHILD MUST NOT APPEAR');
 send({jsonrpc:'2.0',id:999,method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'tool-1',kind:'execute',title:'shell',rawInput:{command:'write fixture'}},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}});
}else if(m.id===999){approval=m.result.outcome.optionId;update(session,method+':'+approval);reply(prompt,{stopReason:'end_turn'});}
});
`,{mode:0o755});
try {
 const catalog=new AgentRegistry().describeAll();
 for(const Adapter of [KiroAdapter,CopilotAdapter]){
  const a=new Adapter(root);assert.ok(catalog.some(x=>x.kind===a.kind));
  // Protocol tests use the real provider argument generation and process runner.
  const agent={kind:a.kind,name:a.label,localUuid:a.kind,executablePath:cli};
  const base={workspacePath:root,prompt:'work',fullAccess:true,onProgress:()=>{},runtimeConfig:{model:'fixture',fastMode:false}};
  let asks=0;
  let out=await a.executeTurn(agent,{...base,onPermission:async request=>{asks++;assert.equal(request.toolName,'execute');return true}});
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.message,'session/new:yes');assert.equal(asks,1);
  out=await a.executeTurn(agent,{...base,threadId:'resumed',onPermission:async()=>false});assert.equal(out.threadId,'resumed');assert.equal(out.message,'session/load:no');
  out=await a.executeTurn(agent,{...base,discussionOnly:true,onPermission:async()=>{throw Error('must not ask')}});assert.equal(out.message,'session/new:no');
  out=await a.executeTurn(agent,{...base,fullAccess:false,onPermission:async()=>true});assert.equal(out.message,'session/new:no');
  out=await a.executeTurn(agent,{...base,permissionMode:'unattended'});assert.equal(out.message,'session/new:yes');
  let calls=0;
  out=await a.executeTurn(agent,{...base,onKnowledgeTool:async(name,args)=>{calls++;assert.equal(name,'ading_memory');assert.equal(args.action,'list');return []},permissionMode:'unattended'});
  assert.equal(out.ok,true);assert.equal(calls,1);
  // Reproduce the reported Bedrock rejection against the actual MCP tools/list,
  // with the same parallel + knowledge + computer tools as an execution turn.
  const parallelArgs=[], onParallelWork=async args=>{parallelArgs.push(args);return {ok:true}};
  out=await a.executeTurn(agent,{...base,onParallelWork,onKnowledgeTool:async()=>[],permissionMode:'unattended'});
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.message,'session/new:yes');
  out=await a.executeTurn(agent,{...base,threadId:'resumed',onParallelWork,onKnowledgeTool:async()=>[],permissionMode:'unattended'});
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.message,'session/load:yes');
  assert.deepEqual(parallelArgs,[{jobs:[{id:'fixture',instruction:'read only fixture',outputs:[]}]},{batchId:'fixture',cursor:0},{jobs:[{id:'fixture',instruction:'read only fixture',outputs:[]}]},{batchId:'fixture',cursor:0}]);
  const abort=new AbortController();const run=a.executeTurn(agent,{...base,prompt:'hang',signal:abort.signal});
  await new Promise(r=>setTimeout(r,150));abort.abort();out=await run;assert.equal(out.cancelled,true);assert.deepEqual(a.busyIds(),[]);
  assert.equal((await a.executeTurn(agent,{...base,runtimeConfig:{fastMode:true}})).ok,false);
 }
 const a=new AntigravityAdapter();const base={workspacePath:root,prompt:'work',fullAccess:true,onProgress:()=>{}};
 assert.ok(!a.buildArgs({...base,permissionMode:'unattended'}).includes('--dangerously-skip-permissions'));
 assert.ok(a.buildArgs({...base,threadId:'resume-id'}).includes('resume-id'));
 assert.throws(()=>a.buildArgs({...base,runtimeConfig:{fastMode:true}}),/Fast/);
 // Antigravity's documented NDJSON contract through the actual process runner.
 const agy=path.join(root,'fake-agy.cjs');
 await writeFile(agy,`#!/usr/bin/env node
 const readline=require('node:readline');const args=process.argv.slice(2);
 const id=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:'agy-parent';
 const send=x=>console.log(JSON.stringify(x));
 readline.createInterface({input:process.stdin}).on('line',line=>{
 const text=JSON.parse(line).message.content;
 send(null);send({event:'result'});send({event:'result',result:{conversation_id:'early-child',status:'SUCCESS',response:'EARLY CHILD'}});
 send({event:'init',conversation_id:id,init:{}});
 if(text==='hang'){setInterval(()=>{},1000);return;}
 send({event:'step_update',step_update:{conversation_id:'child',step_type:'agent_response',text_delta:'CHILD'}});
 send({event:'result',result:{conversation_id:'child',status:'SUCCESS',response:'CHILD RESULT'}});
 send({event:'step_update',step_update:{conversation_id:id,step_type:'agent_response',text_delta:'partial'}});
 if(text==='incomplete')return;
 send({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'OK',usage:{input_tokens:10,output_tokens:2,total_tokens:12}}});
 });`,{mode:0o755});
 const agyAgent={kind:'antigravity',name:'Antigravity',localUuid:'agy-test',executablePath:agy};
 for(const threadId of [undefined,'resume-id']){
  const result=await a.executeTurn(agyAgent,{...base,threadId});assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.message,'OK');assert.equal(result.threadId,threadId||'agy-parent');assert.equal(result.metrics.tokenUsage.totalTokens,12);
 }
 const incomplete=await a.executeTurn(agyAgent,{...base,prompt:'incomplete'});assert.equal(incomplete.ok,false);assert.equal(incomplete.partialMessage,'partial');
 const abortAgy=new AbortController();const runningAgy=a.executeTurn(agyAgent,{...base,prompt:'hang',signal:abortAgy.signal});
 setTimeout(()=>abortAgy.abort(),150);assert.equal((await runningAgy).cancelled,true);assert.deepEqual(a.busyIds(),[]);
 assert.equal((await a.askOnce()).ok,false);assert.equal((await a.steer()).status,'unsupported');
 // Settings are selected from the native schema; credentials never enter snapshots.
 const modelFile=path.join(root,'.gemini/antigravity-cli/settings.json');await mkdir(path.dirname(modelFile),{recursive:true});
 const configured=new AntigravityAdapter(root);const ca={...agyAgent};
 assert.equal((await configured.initializeConfiguration(ca,root)).model,undefined);
 await writeFile(modelFile,JSON.stringify({model:'native-a',apiKey:'secret-fixture'}));
 let settings=await configured.initializeConfiguration(ca,root,{fastMode:false});
 assert.equal(settings.model,'native-a');assert.equal(settings.fastMode,false);assert.ok(!JSON.stringify(settings).includes('secret-fixture'));
 await writeFile(modelFile,JSON.stringify({model:'native-b'}));assert.equal((await configured.initializeConfiguration(ca,root)).model,'native-b');
 assert.equal((await configured.initializeConfiguration(ca,root,{model:'override',reasoningEffort:'high'})).model,'override');
 await writeFile(modelFile,'{broken');assert.ok((await configured.initializeConfiguration(ca,root)).notice);
 const configCli=path.join(root,'kiro-settings.cjs'),configFile=path.join(root,'kiro-settings.json');
 await writeFile(configCli,`#!/usr/bin/env node
const s=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(configFile)},'utf8'));console.log(JSON.stringify(s[process.argv[3]]??null));`,{mode:0o755});
 const ka=new KiroAdapter(root),kg={kind:'kiro',name:'Kiro',localUuid:'settings',executablePath:configCli};
 await writeFile(configFile,JSON.stringify({'chat.defaultModel':'a','chat.modelDefaults':{a:{output_config:{effort:'high'}},b:{reasoning:{effort:'low'}}}}));
 settings=await ka.initializeConfiguration(kg,root,{fastMode:false});assert.equal(settings.reasoningEffort,'high');assert.equal(settings.fastMode,false);
 await writeFile(configFile,JSON.stringify({'chat.defaultModel':'b','chat.modelDefaults':{b:{reasoning:{effort:'low'}}}}));
 assert.equal((await ka.initializeConfiguration(kg,root)).reasoningEffort,'low');
 // Device-flow sign-in page: only the official https start portal is opened.
 const kiroUrl='https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH';
 assert.equal(ka.loginAuthorizationUrl(`Open this URL: ${kiroUrl}.`),kiroUrl);
 for(const bad of [kiroUrl.replace('https:','http:'),kiroUrl.replace('view.awsapps.com','view.awsapps.com.evil.test'),kiroUrl.replace('view.awsapps.com','user@view.awsapps.com'),kiroUrl.replace('view.awsapps.com','view.awsapps.com:8443'),kiroUrl.replace('/start/','/other/'),'Code: ABCD-EFGH'])assert.equal(ka.loginAuthorizationUrl(bad),undefined,bad);
 // Native hook execution, isolation, cleanup, and real MCP dispatch.
 await mkdir(path.join(root,'.agents'),{recursive:true});
 const file=path.join(root,'.agents/hooks.json'),original='{ // preserve my comment\n "user-hook": {"enabled":false}\n}\n';await writeFile(file,original);
 let asks=0;
 const one=await startNativeToolBridge({...base,onPermission:async()=>{asks++;return true}});
 const two=await startNativeToolBridge({...base,fullAccess:false,onPermission:async()=>{throw Error('must not ask')}});
 try {
  const hook=JSON.parse(await readFile(file,'utf8'))['ading-runtime'].PreToolUse[0].hooks[0].command;
  const payload={toolCall:{name:'write_to_file',args:{TargetFile:'fixture'}},conversationId:'session',stepIdx:1};
  const call=async(env,body)=>{const {spawn}=await import('node:child_process');return new Promise((resolve,reject)=>{const p=spawn('/bin/sh',['-c',hook],{env,cwd:root});let out='';p.stdout.on('data',x=>out+=x);p.on('error',reject);p.on('close',code=>code?reject(Error('hook exit '+code)):resolve(JSON.parse(out)));p.stdin.end(JSON.stringify(body));})};
  assert.equal((await call(one.env,payload)).decision,'auto_approve');assert.equal(asks,1);
  assert.equal((await call(two.env,payload)).decision,'deny');
  assert.equal((await call(two.env,{...payload,toolCall:{name:'view_file'}})).decision,'auto_approve');
  assert.equal((await fetch(one.env.ADING_PERMISSION_URL,{method:'POST',body:'{}'})).status,403);
  await one.close();assert.ok((await readFile(file,'utf8')).includes('ading-runtime'));
 } finally {await one.close();await two.close();}
 assert.equal(await readFile(file,'utf8'),original);await assert.rejects(access(path.join(root,'.agents/mcp_config.json')));
 // Cleanup removes only our unchanged entries after unrelated user edits.
 const edited=await startNativeToolBridge(base);
 const changed=JSON.parse(await readFile(file,'utf8'));changed['new-user-hook']={enabled:true};await writeFile(file,JSON.stringify(changed));
 await edited.close();const cleaned=JSON.parse(await readFile(file,'utf8'));assert.ok(cleaned['new-user-hook']);assert.equal(cleaned['ading-runtime'],undefined);
 // Immediate reacquisition must wait for restoration instead of colliding.
 const closing=await startNativeToolBridge(base);const closePromise=closing.close();const replacement=await startNativeToolBridge(base);await closePromise;await replacement.close();
 // A lane resuming after the last release retired the lease must get a fresh helper, not the one being removed.
 const beforeRace=await readFile(file,'utf8');
 const leaving=await startNativeToolBridge(base);const joining=startNativeToolBridge(base);const leftPromise=leaving.close();const joined=await joining;await leftPromise;
 try {
  const hook=JSON.parse(await readFile(file,'utf8'))['ading-runtime']?.PreToolUse[0].hooks[0].command;assert.ok(hook);
  await access(/ '([^']+)' hook$/.exec(hook)[1]);await access(path.join(root,'.agents/mcp_config.json'));
 } finally {await joined.close();}
 assert.equal(await readFile(file,'utf8'),beforeRace);
 // Entries left by a crashed instance are taken over; a user's own same-name entry still conflicts.
 const mcpFile=path.join(root,'.agents/mcp_config.json'),gone=path.join(os.tmpdir(),'ading-native-tools-999999-Abc123/bridge.cjs');
 const deadDir=path.join(root,'ading-native-tools-999999-Xyz789');await mkdir(deadDir);await writeFile(path.join(deadDir,'bridge.cjs'),'');
 const staleHook={PreToolUse:[{matcher:'.*',hooks:[{type:'command',command:`ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${path.join(deadDir,'bridge.cjs')}' hook`,timeout:86400}]}]};
 await writeFile(file,JSON.stringify({'user-hook':{enabled:false},'ading-runtime':staleHook},null,2)+'\n');
 await writeFile(mcpFile,JSON.stringify({mcpServers:{ading:{command:process.execPath,args:[gone,'mcp'],env:{ELECTRON_RUN_AS_NODE:'1'},timeoutSeconds:86400}}},null,2)+'\n');
 const recovered=await startNativeToolBridge(base);
 assert.ok(!(await readFile(file,'utf8')).includes(deadDir));assert.ok(!(await readFile(mcpFile,'utf8')).includes(gone));
 await recovered.close();
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{'user-hook':{enabled:false}});await assert.rejects(access(mcpFile));
 const userOwned=JSON.stringify({mcpServers:{ading:{command:'my-ading',args:['serve']}}});await writeFile(mcpFile,userOwned);
 await assert.rejects(startNativeToolBridge(base),/ADing's entry name|同名/);assert.equal(await readFile(mcpFile,'utf8'),userOwned);
 await rm(mcpFile);await writeFile(file,original);
 for(const Adapter of [KiroAdapter,CopilotAdapter,AntigravityAdapter]){
  const a=new Adapter(root),target=await a.resolveSkillTarget('workspace',root);assert.ok(target);
  const sentinel=path.join(target.dirPath,'user-owned');await mkdir(sentinel,{recursive:true});await writeFile(path.join(sentinel,'SKILL.md'),'user');
  await a.syncSkills(target,[{skillId:'fixture',name:'Fixture',description:'fixture',content:'# fixture',enabled:true}]);
  await a.unsyncSkills(target);assert.equal(await readFile(path.join(sentinel,'SKILL.md'),'utf8'),'user');
 }
 // Per-turn Kiro profiles live only in the injected home and are removed after the turn;
 // a crashed owner's leftovers are cleaned, live owners' and user profiles are kept.
 const kiroAgents=path.join(root,'.kiro/agents');
 assert.deepEqual((await readdir(kiroAgents)).filter(n=>n.startsWith('ading-')),[]);
 const dead=99999999,uuid='00000000-0000-4000-8000-000000000000';
 for(const n of [`ading-${dead}-${uuid}.json`,`ading-${process.pid}-${uuid}.json`,'ading-mine.json','user.json'])await writeFile(path.join(kiroAgents,n),'{}');
 await removeStaleKiroProfiles(kiroAgents);
 assert.deepEqual((await readdir(kiroAgents)).sort(),[`ading-${process.pid}-${uuid}.json`,'ading-mine.json','user.json'].sort());
 await removeStaleKiroProfiles(path.join(root,'missing-kiro-agents'));
 console.log('new-agents: ACP ownership/resume/permissions/cancel, native hook isolation/cleanup, MCP dispatch, and skill ownership passed');
} finally { await rm(root,{recursive:true,force:true}); }
