import assert from 'node:assert/strict';
import {mkdtemp} from './tmp.mjs';
import {mkdir,writeFile,readFile,chmod,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {QwenCodeAdapter,qwenProbeArgs} from '../dist/agents/qwen.js';
import {qwenNativeConfiguration} from '../dist/agents/qwen-config.js';
import {AgentRegistry} from '../dist/agents/registry.js';
import {AgentLifecycleService,parseAgentAuthStatus} from '../dist/agents/lifecycle.js';
import {classifyReadiness} from '../dist/agents/readiness.js';
import {parseStreamJson,retainStreamLine} from '../dist/agents/stream-json.js';
const root=await mkdtemp(path.join(os.tmpdir(),'ading-qwen-test-'));
const keys=['QWEN_HOME','QWEN_CODE_SYSTEM_SETTINGS_PATH','QWEN_CODE_SYSTEM_DEFAULTS_PATH','QWEN_CODE_TRUSTED_FOLDERS_PATH','OPENAI_MODEL','QWEN_MODEL','QWEN_OAUTH','OPENAI_API_KEY','OPENAI_BASE_URL','GEMINI_API_KEY','GEMINI_MODEL','GOOGLE_API_KEY','GOOGLE_MODEL','GOOGLE_CLOUD_PROJECT','ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_BASE_URL'];
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
try {
 for(const key of keys.slice(4))delete process.env[key];
 process.env.QWEN_HOME=path.join(root,'native');
 process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH=path.join(root,'system.json');
 process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH=path.join(root,'defaults.json');
 process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH=path.join(root,'trust.json');
 await mkdir(process.env.QWEN_HOME);await mkdir(path.join(root,'.qwen'));
 const settings=path.join(process.env.QWEN_HOME,'settings.json');
 await writeFile(settings,JSON.stringify({model:{name:'chosen',reasoningEffort:'high'},fastModel:'aux-model',security:{auth:{selectedType:'openai'},folderTrust:{enabled:true}},apiKey:'never-return-this'}));
 await writeFile(path.join(root,'comments.json'), '\ufeff{ // comment\n "url": "https://example.invalid/a/*b*/", "values": [1,2,], /* note */ }');
 const {readJsoncSettings}=await import('../dist/platform/jsonc-settings.js');
 assert.deepEqual(await readJsoncSettings(path.join(root,'comments.json')),{url:'https://example.invalid/a/*b*/',values:[1,2]});
 process.env.OPENAI_MODEL='env-model';
 const adapter=new QwenCodeAdapter();
 const agent={kind:'qwen-code',name:'Qwen Code',localUuid:'qwen-test',executablePath:path.join(root,'cli')};
 let config=await adapter.initializeConfiguration(agent,root,{fastMode:false});
 assert.deepEqual(config,{model:'chosen',reasoningEffort:'high',fastMode:false,source:'ading'});
 assert.ok(!JSON.stringify(config).includes('never-return-this'));
 await writeFile(path.join(root,'.qwen/settings.json'),JSON.stringify({model:{name:'project'}}));
 assert.equal((await qwenNativeConfiguration(root)).model,'chosen','untrusted project does not change model');
 await writeFile(process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH,JSON.stringify({[root]:'TRUST_FOLDER'}));
 assert.equal((await qwenNativeConfiguration(root)).model,'project');
 await writeFile(process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH,JSON.stringify({model:{name:'system'}}));
 assert.equal((await qwenNativeConfiguration(root)).model,'system');
 await writeFile(process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH,'{}');
 await writeFile(path.join(root,'.qwen/settings.json'),'{}');
 await writeFile(settings,JSON.stringify({model:{name:'changed'},security:{auth:{selectedType:'openai'}}}));
 assert.equal((await adapter.initializeConfiguration(agent,root)).model,'changed');
 assert.equal((await adapter.initializeConfiguration(agent,root,{model:'explicit'})).model,'explicit');
 await writeFile(settings,'{broken');
 assert.ok((await adapter.initializeConfiguration(agent,root)).notice);
 await writeFile(settings,JSON.stringify({security:{auth:{selectedType:'openai'}}}));
 assert.equal((await qwenNativeConfiguration(root)).model,'env-model');
 delete process.env.OPENAI_MODEL; await writeFile(settings,'{}');
 assert.equal(await qwenNativeConfiguration(root),undefined);
 for(const [raw,expected] of [['med','medium'],[' Extra-High ','xhigh'],['maximum','max'],['none','none'],['invalid',undefined]]){
  await writeFile(settings,JSON.stringify({model:{name:'$runtime|openai|chosen',reasoningEffort:raw}}));
  const native=await qwenNativeConfiguration(root);assert.equal(native.model,'chosen');assert.equal(native.reasoningEffort,expected);
 }
 await writeFile(settings,'{}');
 process.env.GOOGLE_API_KEY='fixture-only';process.env.GOOGLE_MODEL='vertex-model';
 assert.equal((await qwenNativeConfiguration(root)).model,'vertex-model');
 process.env.ANTHROPIC_API_KEY='fixture-only';process.env.ANTHROPIC_MODEL='anthropic-model';
 assert.equal((await qwenNativeConfiguration(root)).model,'vertex-model','incomplete Anthropic env must not mask valid Vertex configuration');
 delete process.env.GOOGLE_API_KEY;delete process.env.GOOGLE_MODEL;
 assert.equal(await qwenNativeConfiguration(root),undefined,'API key and model without required base URL must not invent a native selection');
 process.env.ANTHROPIC_BASE_URL='http://localhost/fixture';
 assert.equal((await qwenNativeConfiguration(root)).model,'anthropic-model');
 for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_BASE_URL'])delete process.env[key];

 agent.runtimeDefaults=undefined;
 assert.ok(new AgentRegistry().describeAll().some(a=>a.kind==='qwen-code'&&a.loginHint.includes('/auth')));
 const base={workspacePath:root,prompt:'hello',fullAccess:false,onProgress:()=>{}};
 const args=adapter.buildArgs({...base,discussionOnly:true,runtimeConfig:{model:'fixture',fastMode:false}},JSON.stringify({mcpServers:{ading:{type:'http',url:'http://127.0.0.1:123/mcp',headers:{Authorization:'Bearer fixture'}}}}));
 const after=(a,key)=>a[a.indexOf(key)+1];
 assert.equal(after(args,'--approval-mode'),'plan');
 assert.ok(args.includes('--safe-mode'));
 assert.ok(after(args,'--exclude-tools').includes('run_shell_command'));
 assert.ok(after(args,'--exclude-tools').includes('read_file'));
 assert.equal(JSON.parse(after(args,'--mcp-config')).mcpServers.ading.httpUrl,'http://127.0.0.1:123/mcp');
 assert.ok(!args.includes('--permission-mode')&&!args.includes('--verbose')&&!args.includes('--print'));
 assert.ok(qwenProbeArgs().includes('--chat-recording=false'));
 assert.equal(after(qwenProbeArgs(),'--max-tool-calls'),'0');
 assert.throws(()=>adapter.buildArgs({...base,runtimeConfig:{fastMode:true}}),/Fast/);
 assert.equal((await adapter.runTurn(agent,{...base,appRuntimeConfig:{fastMode:true}})).ok,false);
 assert.match((await adapter.runTurn(agent,{...base,appRuntimeConfig:{reasoningEffort:'none'}})).error,/none/);
 assert.equal(parseAgentAuthStatus('qwen-code',JSON.stringify({type:'result',is_error:true,error:{message:'No auth type is selected. Please configure an auth type'}})).state,'signed-out');
 assert.equal(classifyReadiness(true,{ok:false,text:'No auth type is selected. Please configure an auth type'}).readiness,'unauthorized');
 const login=await new AgentLifecycleService().login(agent,true);
 assert.ok(login.requiresUserAction&&login.unsupported&&login.message.includes('/auth'));
 const child=JSON.stringify({type:'result',parent_tool_use_id:'child',session_id:'child-session',result:'wrong'});
 assert.equal(retainStreamLine(child),undefined);
 assert.deepEqual(parseStreamJson(JSON.stringify({type:'result',session_id:'parent',result:'right'})+'\n'+child),{threadId:'parent',message:'right',error:undefined});
 await writeFile(agent.executablePath,`#!/usr/bin/env node
const readline=require('node:readline');const fs=require('node:fs');
const a=process.argv.slice(2),send=e=>console.log(JSON.stringify(e));
const id=a.includes('--resume')?a[a.indexOf('--resume')+1]:'parent';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const e=JSON.parse(line);
 if(e.request?.subtype==='initialize'){
  fs.writeFileSync(${JSON.stringify(path.join(root,'init.json'))},JSON.stringify(e.request));
  send({type:'control_response',response:{subtype:'success',request_id:e.request_id,response:{}}});
 }
 if(e.type==='user'){
  send({type:'system',subtype:'init',session_id:id,model:'fixture'});
  const prompt=e.message.content.split('\\n\\n')[0];
  if(prompt==='wait')return;
  if(prompt==='permission')send({type:'control_request',request_id:'p',request:{subtype:'can_use_tool',tool_name:'write_file',tool_use_id:'t',input:{file_path:'out.txt',content:'OK'}}});
  else {send({type:'result',parent_tool_use_id:'child',session_id:'child',result:'child'});setTimeout(()=>send({type:'result',session_id:id,result:'OK',usage:{input_tokens:10,output_tokens:2}}),20);}
 }
 if(e.type==='control_response')send({type:'result',session_id:id,result:e.response.response.behavior==='allow'?'allowed':'denied'});
});
`);await chmod(agent.executablePath,0o755);
 let out=await adapter.runTurn(agent,{...base,discussionOnly:true,runtimeConfig:{model:'fixture',reasoningEffort:'high'}});
 assert.equal(out.ok,true);assert.equal(out.threadId,'parent');assert.equal(out.message,'OK');
 assert.equal(JSON.parse(await readFile(path.join(root,'init.json'),'utf8')).effort,'high');
 assert.equal(out.metrics.tokenUsage.totalTokens,12);
 out=await adapter.runTurn(agent,{...base,threadId:'restored',discussionOnly:true});assert.equal(out.threadId,'restored');
 let asked=0;
 out=await adapter.runTurn(agent,{...base,prompt:'permission',fullAccess:true,onPermission:async r=>{asked++;assert.equal(r.toolName,'write_file');return true;}});
 assert.equal(asked,1);assert.equal(out.ok,true);assert.equal(out.message,'allowed');
 out=await adapter.runTurn(agent,{...base,prompt:'permission',fullAccess:true,onPermission:async()=>false});assert.equal(out.ok,false);
 out=await adapter.runTurn(agent,{...base,prompt:'permission',onPermission:async()=>{throw Error('read-only mutation must not prompt')}});assert.equal(out.ok,false);
 out=await adapter.runTurn(agent,{...base,prompt:'permission',fullAccess:true,permissionMode:'unattended',onPermission:async()=>{throw Error('unattended must not prompt')}});assert.equal(out.ok,true);
 const controller=new AbortController();const pending=adapter.runTurn(agent,{...base,prompt:'wait',signal:controller.signal});
 setTimeout(()=>controller.abort(),150);out=await pending;assert.equal(out.cancelled,true);assert.deepEqual(adapter.busyIds(),[]);
 const target=await adapter.resolveSkillTarget('workspace',root);target.ownerFingerprint='test-owner';
 const skill={skillId:'s_qwenfixture',name:'fixture',description:'fixture',content:'original',enabled:true};
 const files=await adapter.syncSkills(target,[skill]);assert.ok(files.length);
 await adapter.syncSkills(target,[{...skill,content:'updated'}]);assert.match(await readFile(files[0],'utf8'),/updated/);
 const privateDir=path.join(target.dirPath,'user-owned');await mkdir(privateDir);await writeFile(path.join(privateDir,'SKILL.md'),'keep');
 await adapter.unsyncSkills(target);await assert.rejects(access(files[0]));assert.equal(await readFile(path.join(privateDir,'SKILL.md'),'utf8'),'keep');
 console.log('qwen-code: configuration, protocol, permissions, resume, cancellation, lifecycle and knowledge passed');
} finally {for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
