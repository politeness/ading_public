import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentRegistry} from '../dist/agents/registry.js';
import {QoderAdapter} from '../dist/agents/qoder.js';
import {QoderCnAdapter} from '../dist/agents/qoder-cn.js';

const root=await mkdtemp(path.join(os.tmpdir(),'ading-recovery-'));
const keys=['QODER_CONFIG_DIR','QODERCN_CONFIG_DIR','QODER_APP_CONFIG_DIR','QODERCN_APP_CONFIG_DIR','QODER_MODEL','QODERCN_MODEL'];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
process.env.QODER_CONFIG_DIR=root;process.env.QODERCN_CONFIG_DIR=root;
delete process.env.QODER_APP_CONFIG_DIR;delete process.env.QODERCN_APP_CONFIG_DIR;
process.env.QODER_MODEL='byok:custom-id';process.env.QODERCN_MODEL='byok:custom-id';
try {
 for(const Adapter of [QoderAdapter,QoderCnAdapter]){
  const adapter=new Adapter(),kind=adapter.kind,host=kind==='qoder'?'qoder.com':'qoder.cn';
  const state=path.join(root,kind+'.state'),calls=path.join(root,kind+'.calls'),executable=path.join(root,kind);
  const url=`https://${host}/device/selectAccounts?challenge=test&nonce=test`;
  await writeFile(state,'old');
  await writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),state=${JSON.stringify(state)},calls=${JSON.stringify(calls)};
if(args.includes('--help'))console.log('--tools --strict-mcp-config --setting-sources --no-session-persistence --list-models');
else if(args[0]==='status')console.log(JSON.stringify({logged_in:true}));
else if(args[0]==='login'){
 fs.appendFileSync(calls,'login\\n');
 if(fs.readFileSync(state,'utf8')==='failed'){console.error('login failed');process.exit(1);}
 console.log(${JSON.stringify(url)});console.error(${JSON.stringify(url)});
 const timer=setInterval(()=>{if(fs.readFileSync(state,'utf8')==='approved'){clearInterval(timer);console.log('Login successful');}},20);
}else if(args.includes('--list-models'))console.log(fs.readFileSync(state,'utf8')==='approved'?'MODEL\\nCustom (custom-id)':'MODEL\\nOfficial');
else console.log(JSON.stringify({type:'result',subtype:'success',result:args[args.indexOf('--model')+1]==='custom-id'?'OK':'WRONG MODEL',session_id:'test'}));
`,{mode:0o700});
  const agent={kind,localUuid:kind+'@test',name:kind,executablePath:executable};
  adapter.discover=async()=>[agent];
  let opens=0,mode='approve',opened;
  const registry=new AgentRegistry({openExternal:async target=>{
   opens++;assert.equal(target,url);
   opened?.();
   if(mode==='failure')throw Error('browser unavailable');
   if(mode==='approve')await writeFile(state,'approved');
  }});
  registry.adapters.splice(0,registry.adapters.length,adapter);
  for(const malicious of [url.replace('https:','http:'),url.replace(host,host+'.evil.test'),url.replace('/device/selectAccounts','/other'),url.replace(host,'user@'+host),url.replace(host,host+':8443'),url.replace(host,host==='qoder.com'?'qoder.cn':'qoder.com')])assert.equal(adapter.loginAuthorizationUrl(malicious),undefined);
  assert.equal(adapter.loginAuthorizationUrl('  '+url+'  '),url);
  const first=await registry.verify(agent);
  assert.equal(first.ok,false);assert.equal(first.recovery.action,'login');
  assert.equal((await registry.authStatus(kind)).state,'signed-in','old account is still signed in');
  assert.equal((await registry.login(kind,false)).ok,false);assert.equal(opens,0);
  const a=registry.login(kind,true),b=registry.login(kind,true);
  assert.equal(a,b,'duplicate repair requests share one login');
  assert.equal((await a).ok,true);assert.equal(opens,1,'stdout and stderr URLs open once');
  assert.equal((await readFile(calls,'utf8')).trim(),'login');
  assert.deepEqual(await registry.verify(agent),{ok:true,text:'OK'},'repair makes the selected custom model usable');
  await writeFile(state,'failed');
  assert.equal((await registry.login(kind,true)).ok,false,'failed login cannot inherit success from the old account');
  await writeFile(state,'old');mode='failure';
  assert.equal((await registry.login(kind,true)).ok,false,'browser failure is recoverable, not success');
  mode='wait';let seen=new Promise(resolve=>{opened=resolve;});
  const cancelled=registry.login(kind,true);await seen;
  registry.cancelLifecycle(kind,'login');assert.equal((await cancelled).ok,false);
  mode='approve';assert.equal((await registry.login(kind,true)).ok,true,'retry works after cancellation');
  let release;const discovering=new Promise(resolve=>{release=resolve;});
  adapter.discover=async()=>{await discovering;return [agent];};
  const before=opens,early=registry.login(kind,true);
  assert.equal(registry.cancelLifecycle(kind,'login'),true);release();
  assert.equal((await early).ok,false);assert.equal(opens,before,'cancel during discovery must not open a browser later');
 }
 console.log('qoder-recovery: both adapters, official URL isolation, old-account mismatch, one login, real model reprobe, failed/cancelled login and retry passed');
}finally{
 for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
 await rm(root,{recursive:true,force:true});
}
