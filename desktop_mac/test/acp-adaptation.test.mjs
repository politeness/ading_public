import assert from 'node:assert/strict';
import {writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp} from './tmp.mjs';
import {CopilotAdapter} from '../dist/agents/acp-providers.js';

const adapter = new CopilotAdapter();
const select = (id, category, currentValue, values) => ({id, category, type:'select', currentValue,
  options:[{group:'supported', name:'Supported', options:values.map(value=>({value,name:value}))}]});
const initial = () => ({configOptions:[select('vendor-model','model','old',['old','new']),
  select('vendor-effort','thought_level','low',['low'])]});
const root = await mkdtemp(path.join(os.tmpdir(),'ading-acp-config-'));
try {
  // A restored session must honor the requested model, then re-read effort
  // choices from the model change response instead of using the old choices.
  const state=initial(), calls=[];
  await adapter.configureSession(async(method,params)=>{
    calls.push({method,...params});
    return {configOptions:[select('vendor-model','model','new',['old','new']),
      select('vendor-effort','thought_level',params.configId==='vendor-effort'?'high':'low',['low','high'])]};
  },'resumed',state,{runtimeConfig:{model:'new',reasoningEffort:'high'}});
  assert.deepEqual(calls.map(({method,sessionId,configId,value})=>[method,sessionId,configId,value]),[
    ['session/set_config_option','resumed','vendor-model','new'],
    ['session/set_config_option','resumed','vendor-effort','high']]);
  assert.equal(state.configOptions[1].currentValue,'high');
  await assert.rejects(adapter.configureSession(async()=>initial(),'s',initial(),{runtimeConfig:{model:'new'}}),/new/);
  await assert.rejects(adapter.configureSession(async(method,params)=>({configOptions:[
    select('vendor-model','model',params.configId==='vendor-effort'?'old':'new',['old','new']),
    select('vendor-effort','thought_level',params.configId==='vendor-effort'?'high':'low',['low','high'])
  ]}),'s',initial(),{runtimeConfig:{model:'new',reasoningEffort:'high'}}),/new/);
  await assert.rejects(adapter.configureSession(async()=>{throw Error('must not request')},'s',initial(),{runtimeConfig:{model:'missing'}}),/missing/);
  const legacy={models:{currentModelId:'old',availableModels:[{modelId:'new'}]}};
  let legacyCall;
  await adapter.configureSession(async(method,params)=>{legacyCall={method,...params};return {}},'s',legacy,{runtimeConfig:{model:'new'}});
  assert.deepEqual(legacyCall,{method:'session/set_model',sessionId:'s',modelId:'new'});
  assert.equal(legacy.models.currentModelId,'new');
  await adapter.configureSession(async()=>{throw Error('must not request')},'s',{}, {runtimeConfig:{model:'launch-flag-model'}});

  const cli=path.join(root,'acp-fixture.cjs');
  await writeFile(cli,`#!/usr/bin/env node
const send=v=>console.log(JSON.stringify({jsonrpc:'2.0',...v}));
const record=v=>process.env.ACP_FIXTURE_LOG&&require('node:fs').appendFileSync(process.env.ACP_FIXTURE_LOG,JSON.stringify(v)+'\\n');
let prompt;
const options=(model,effort)=>[{id:'model',category:'model',type:'select',currentValue:model,options:[{value:model,name:model}]},{id:'effortLevel',category:'thought_level',type:'select',currentValue:effort,options:[{value:effort,name:effort}]}];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);record(m);
 if(m.method===undefined&&m.id==='p1'){send({id:prompt,result:{stopReason:'end_turn'}});return;}
 if(m.method==='session/cancel'){send({id:prompt,result:{stopReason:'cancelled'}});return;}
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 else if(m.method==='session/new'&&process.env.ACP_FIXTURE_SIGNED_OUT)send({id:m.id,error:{code:-32000,message:'Authentication required'}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'s',configOptions:options('new','high')}});
 else if(m.method==='session/load')send({id:m.id,error:m.params.sessionId==='internal-failure'?{code:-32603,message:'Internal error',data:{message:'Invalid tool schema: properties is required',token:'secret-fixture'}}:{code:-32000,message:'Authentication required'}});
 else if(m.method==='session/prompt'&&['perm-fallback','hang'].includes(m.params.prompt[0].text)){
  prompt=m.id;
  const fallback=m.params.prompt[0].text==='perm-fallback';
  send({id:fallback?'p1':'p2',method:'session/request_permission',params:{sessionId:'s',toolCall:{toolCallId:'t',kind:'edit',title:'Edit file'},
   options:fallback?[{optionId:'aa',kind:'allow_always'},{optionId:'ra',kind:'reject_always'}]:[{optionId:'ao',kind:'allow_once'},{optionId:'ro',kind:'reject_once'}]}});
 }
 else if(m.method==='session/prompt'){
  send({method:'session/update',params:{sessionId:'child',update:{sessionUpdate:'config_option_update',configOptions:options('child','low')}}});
  send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'config_option_update',configOptions:options('new','medium')}}});
  send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OK'}}}});
  send({id:m.id,result:{stopReason:'end_turn'}});
 }
});
`,{mode:0o755});
  const agent={kind:'copilot',name:'Copilot',localUuid:'acp-configuration-test',executablePath:cli};
  const snapshots=[], base={workspacePath:root,prompt:'test',fullAccess:false,onProgress:()=>{},
    runtimeConfig:{model:'new',reasoningEffort:'high',fastMode:false},onRuntimeConfig:value=>snapshots.push(value)};
  const result=await adapter.executeTurn(agent,base);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.message,'OK');
  assert.deepEqual(snapshots,[{model:'new',reasoningEffort:'high',observed:true},{model:'new',reasoningEffort:'medium',observed:true}]);
  const unauthenticated=await adapter.executeTurn(agent,{...base,threadId:'resumed'});
  assert.equal(unauthenticated.ok,false);assert.equal(unauthenticated.error,'Authentication required');
  const internal=await adapter.executeTurn(agent,{...base,threadId:'internal-failure'});
  assert.equal(internal.ok,false);assert.match(internal.error,/session\/load/);assert.match(internal.error,/properties is required/);assert.ok(!internal.error.includes('secret-fixture'));
  assert.deepEqual(adapter.busyIds(),[]);

  // Login status must not prompt the model: initialize + session/new decides it,
  // and the process belongs to the caller's runner.
  const fixtureLog=path.join(root,'acp-fixture.log'), methods=async()=>{
    const lines=(await readFile(fixtureLog,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse);
    await rm(fixtureLog,{force:true});return lines;};
  process.env.ACP_FIXTURE_LOG=fixtureLog;
  const {ProcessRunner}=await import('../dist/agents/process-runner.js');
  const statusRunner=new ProcessRunner();
  const signedIn=await adapter.probeAuth(agent,options=>statusRunner.run('status',options));
  assert.equal(signedIn.ok,true,signedIn.text);
  assert.deepEqual((await methods()).map(m=>m.method),['initialize','session/new']);
  // The model list comes from the same no-prompt session; nothing reaches the model.
  assert.deepEqual(await adapter.listModels(agent),[{id:'new',label:'new',description:undefined}]);
  assert.deepEqual((await methods()).map(m=>m.method),['initialize','session/new']);
  process.env.ACP_FIXTURE_SIGNED_OUT='1';
  await assert.rejects(adapter.listModels(agent),/Authentication required/);
  await methods();
  const signedOut=await adapter.probeAuth(agent,options=>statusRunner.run('status',options));
  delete process.env.ACP_FIXTURE_SIGNED_OUT;
  assert.equal(signedOut.ok,false);assert.equal(signedOut.text,'Authentication required');
  assert.ok(!(await methods()).some(m=>m.method==='session/prompt'));
  assert.deepEqual(statusRunner.busyIds(),[]);

  // Never fall back to allow_always; rejection may use reject_always. With no
  // usable option the reply is an error, never a turn-level "cancelled".
  await adapter.executeTurn(agent,{...base,prompt:'perm-fallback',fullAccess:true,permissionMode:'unattended'});
  assert.match((await methods()).find(m=>m.id==='p1').error.message,/allow_once/);
  await adapter.executeTurn(agent,{...base,prompt:'perm-fallback'});
  assert.deepEqual((await methods()).find(m=>m.id==='p1').result,{outcome:{outcome:'selected',optionId:'ra'}});

  // Cancelling sends session/cancel, answers the pending approval "cancelled",
  // and lets the agent end the turn instead of killing it first.
  let asked;const approval=new Promise(resolve=>{asked=resolve;});
  const hanging=adapter.executeTurn({...agent,localUuid:'acp-cancel-test'},{...base,prompt:'hang',fullAccess:true,permissionMode:'ask',
    onPermission:({signal})=>{asked();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(true),{once:true}));}});
  await approval;
  assert.equal(adapter.cancel('acp-cancel-test'),true);
  const cancelled=await hanging;
  assert.equal(cancelled.ok,false);assert.equal(cancelled.cancelled,true);
  const sent=await methods();
  assert.deepEqual(sent.find(m=>m.id==='p2').result,{outcome:{outcome:'cancelled'}});
  assert.deepEqual(sent.find(m=>m.method==='session/cancel').params,{sessionId:'s'});
  assert.deepEqual(adapter.busyIds(),[]);
  delete process.env.ACP_FIXTURE_LOG;
  console.log('ACP configuration and authentication regressions passed');
} finally {await rm(root,{recursive:true,force:true});}
