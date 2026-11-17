import assert from 'node:assert/strict';
import {codexRuntimeConfig} from '../dist/agents/codex-config.js';
import {resolveRuntimeConfig,mergeRuntimeConfigSnapshot} from '../dist/agents/runtime-config.js';
import {ContextWindowCache} from '../dist/agents/context-window-cache.js';
import {ContextBudget,estimateInputTokens} from '../dist/agents/context-budget.js';
import {qwenContextWindow,localLoadedContext} from '../dist/agents/qwen-config.js';
import {setMainLanguage} from '../dist/i18n.js';
import {mkdtemp} from './tmp.mjs';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
const nativeCapacity=codexRuntimeConfig({model:'fixture',model_context_window:32000});
assert.equal(nativeCapacity.contextWindowTokens,32000);
assert.equal((await resolveRuntimeConfig({native:async()=>nativeCapacity})).contextWindowTokens,32000);
assert.equal((await resolveRuntimeConfig({app:{model:'other'},native:async()=>nativeCapacity})).contextWindowTokens,undefined,'capacity belongs to the selected model');
assert.equal(mergeRuntimeConfigSnapshot(nativeCapacity,{model:'other'}).contextWindowTokens,undefined);
const metrics={iterations:0,sideEffects:false};
const ok=(message='done')=>({ok:true,message,threadId:'native-thread',steps:[],metrics});
const overflow=()=>({ok:false,error:'prompt exceeds the context window: context_length_exceeded',threadId:'rejected-thread',steps:[],cancelled:false,metrics});
const make=messages=>({prompt:'rules\n\n'+messages.join('\n\n'),split:{app:'rules',dialogue:messages.join('\n\n')},contextMessages:messages,workspacePath:'/fixture/project',fullAccess:true,onProgress:()=>{throw Error('retries should stay silent');}});
{
 const budget=new ContextBudget(),calls=[];
 const messages=['old'.repeat(600),'middle'.repeat(200),'latest request'];
 const outcome=await budget.run(make(messages),2048,async input=>{calls.push(input);return ok();});
 assert.ok(outcome.ok);assert.equal(calls.length,1);assert.equal(calls[0].split.dialogue,'latest request');assert.deepEqual(messages,['old'.repeat(600),'middle'.repeat(200),'latest request']);
 assert.match(calls[0].split.app,/rules/);assert.ok(estimateInputTokens(calls[0].prompt)<1024);
}
{
 const calls=[];const budget=new ContextBudget();const original=make(['one','two','three','four','latest']);
 const outcome=await budget.run(original,100000,async input=>{calls.push(input);return calls.length<3?overflow():ok();});
 assert.ok(outcome.ok);assert.deepEqual(calls.map(x=>x.contextMessages.length),[5,3,2]);
 for(const input of calls)assert.equal(input.contextMessages.at(-1),'latest');
 assert.equal(calls[1].threadId,undefined);assert.equal(original.contextMessages.length,5);
}
{
 const calls=[];const outcome=await new ContextBudget().run(make(['a','latest']),100000,async input=>{calls.push(input);return overflow();});
 assert.equal(calls.length,2);assert.equal(outcome.ok,false);assert.match(outcome.error,/context_length_exceeded/);assert.equal(outcome.contextBudgetExhausted,true);assert.match(outcome.error,/最新消息|latest message/);
 const resumed=[];await new ContextBudget().run({...make(['delta']),threadId:'old'},100000,async input=>{resumed.push(input);return overflow();});assert.equal(resumed.length,1,'only scheduler may rebuild a resumed transcript');
 let count=0;await new ContextBudget().run(make(['a','b','c']),100000,async()=>{count++;return {...overflow(),metrics:{...metrics,sideEffects:true}};});assert.equal(count,1,'never replay side effects');
 const controller=new AbortController();controller.abort();count=0;
 await new ContextBudget().run({...make(['a','b']),signal:controller.signal},100000,async()=>{count++;return {...overflow(),cancelled:true};});assert.equal(count,1);
}
{
 setMainLanguage('en');let input;await new ContextBudget().run(make(['old'.repeat(1000),'latest']),2048,async value=>{input=value;return ok();});assert.ok(!/[一-鿿]/.test(input.split.app));setMainLanguage('zh');
}
// Real loopback HTTP fixture: loaded instance (4096) wins over architectural max (128K).
const server=createServer((req,res)=>{assert.equal(req.url,'/api/v1/models');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{key:'custom',max_context_length:128000,loaded_instances:[{id:'custom',config:{context_length:4096}}]}]}));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {assert.equal(await localLoadedContext(`http://127.0.0.1:${server.address().port}/v1`,'custom'),4096);assert.equal(await localLoadedContext(`http://127.0.0.1:${server.address().port}/v1`,'missing'),undefined);}
finally{await new Promise(resolve=>server.close(resolve));}
// Group framing and appended execution rules survive both budgeting and recovery.
{
 const dialogue='New messages:\n'+['old'.repeat(1000),'latest'].join('\n');
 let delivered;
 await new ContextBudget().run({...make(['old'.repeat(1000),'latest']),prompt:'fixed\n'+dialogue+'\nexecution-only instruction',split:{app:'fixed\nexecution-only instruction',dialogue}},2048,async input=>{delivered=input;return ok();});
 assert.equal(delivered.split.dialogue,'New messages:\nlatest');assert.match(delivered.prompt,/execution-only instruction/);assert.doesNotMatch(delivered.prompt,/oldold/);
}
const root=await mkdtemp(path.join(os.tmpdir(),'ading-context-window-'));
const keys=['QWEN_HOME','QWEN_CODE_SYSTEM_DEFAULTS_PATH','QWEN_CODE_SYSTEM_SETTINGS_PATH','QWEN_CODE_TRUSTED_FOLDERS_PATH'];const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
try {
 const file=path.join(root,'capacity.json');const cache=new ContextWindowCache(file);
 const agent={kind:'qwen-code',localUuid:'fixture-agent',executablePath:'/fixture/qwen',version:'test'};
 const input={...make(['latest']),workspacePath:root,runtimeConfig:{model:'model-a'}};
 let reads=0;
 const read=async()=>{reads++;return 4096;};
 assert.deepEqual(await Promise.all(Array.from({length:8},()=>cache.get(agent,input,read))),Array(8).fill(4096));
 assert.equal(reads,1,'concurrent first reads coalesce');
 await cache.get({...agent,localUuid:'fixture-agent::child-1'},input,read);assert.equal(reads,1,'children reuse the parent Agent capacity');
 const restarted=new ContextWindowCache(file);
 assert.equal(await restarted.get(agent,input,read),4096);assert.equal(reads,1,'capacity survives restart');
 const switched={...input,runtimeConfig:{model:'model-b'}};
 assert.equal(await restarted.get(agent,switched,async()=>{reads++;return 8192;}),8192);
 assert.equal(await restarted.get(agent,switched,read),8192);assert.equal(reads,2,'same new model reuses the new capacity');
 await restarted.get(agent,input,read);assert.equal(reads,3,'switching back refreshes selection metadata');
 await restarted.get({...agent,localUuid:'different-agent'},input,read);assert.equal(reads,4,'Agents do not overwrite one another');
 await restarted.get(agent,{...input,workspacePath:path.join(root,'other-project')},read);assert.equal(reads,5,'native project overrides are isolated');
 const unknown={...input,runtimeConfig:{model:'unknown'}};
 assert.equal(await restarted.get(agent,unknown,async()=>{reads++;return undefined;}),undefined);
 assert.equal(await new ContextWindowCache(file).get(agent,unknown,read),undefined);assert.equal(reads,6,'unknown capacity is cached rather than probing each send');
 let failed=0;const failedInput={...input,runtimeConfig:{model:'probe-failure'}};
 await assert.rejects(restarted.get(agent,failedInput,async()=>{failed++;throw Error('transient probe failure');}));
 await restarted.get(agent,failedInput,async()=>{failed++;return 4096;});assert.equal(failed,2,'probe exceptions do not poison the cache');
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const race=new ContextWindowCache(path.join(root,'race.json'));
 const old=race.get(agent,input,()=>pending);await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(await race.get(agent,switched,async()=>16384),16384);release(4096);await old;
 assert.equal(await new ContextWindowCache(path.join(root,'race.json')).get(agent,switched,async()=>{throw Error('stale result overwrote the new selection');}),16384);
 const files=await import('node:fs/promises');assert.ok(!(await files.readdir(root)).some(name=>name.endsWith('.candidate')),'atomic candidates are cleaned');
 process.env.QWEN_HOME=root;process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH=path.join(root,'defaults.json');process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH=path.join(root,'system.json');process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH=path.join(root,'trust.json');
 const project=path.join(root,'project');await mkdir(project);
 const settings={security:{auth:{selectedType:'openai'}},model:{name:'custom',baseUrl:'https://fixture.invalid/v1',generationConfig:{contextWindowSize:128000}},modelProviders:{openai:[{id:'custom',baseUrl:'https://other.invalid/v1',generationConfig:{contextWindowSize:999999}},{id:'custom',baseUrl:'https://fixture.invalid/v1',generationConfig:{contextWindowSize:4096}}]}};
 await writeFile(path.join(root,'settings.json'),JSON.stringify(settings));assert.equal(await qwenContextWindow(project),4096);
 delete settings.modelProviders.openai[1].generationConfig;await writeFile(path.join(root,'settings.json'),JSON.stringify(settings));assert.equal(await qwenContextWindow(project),undefined,'provider match must not inherit top-level window');
 settings.modelProviders={};await writeFile(path.join(root,'settings.json'),JSON.stringify(settings));assert.equal(await qwenContextWindow(project),128000);
}finally{for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];await rm(root,{recursive:true,force:true});}
console.log('context budget: whole-message trimming, silent decreasing retries, latest request protection, native window precedence, cancellation and side-effect isolation passed');
