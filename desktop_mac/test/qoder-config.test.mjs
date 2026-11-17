import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {QoderAdapter} from '../dist/agents/qoder.js';import {QoderCnAdapter} from '../dist/agents/qoder-cn.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'qoder-config-')),old=process.env.QODER_CONFIG_DIR,oldCnModel=process.env.QODERCN_MODEL,oldCn=process.env.QODERCN_CONFIG_DIR,oldModel=process.env.QODER_MODEL;
process.env.QODER_CONFIG_DIR=dir;process.env.QODERCN_CONFIG_DIR=dir;delete process.env.QODER_MODEL;delete process.env.QODERCN_MODEL;
try{
 for(const [adapter,folder] of [[new QoderAdapter(),'.qoder'],[new QoderCnAdapter(),'.qoder-cn']]){
  const cwd=path.join(dir,folder);await mkdir(path.join(cwd,".qoder"),{recursive:true});
  await writeFile(path.join(dir,'settings.json'),JSON.stringify({model:{name:'native',reasoningEffort:'low',preferences:{native:{reasoning:{effort:'high'},functionSwitchSelections:{high_speed:'true',other:'keep'}}}}}));
  const native=await adapter.initializeConfiguration({},cwd);assert.equal(native.model,'native');assert.equal(native.reasoningEffort,'high');assert.equal(native.fastMode,true);
  const envKey=adapter.kind==='qoder-cn'?'QODERCN_MODEL':'QODER_MODEL';process.env[envKey]='env-model';assert.equal((await adapter.initializeConfiguration({},cwd)).model,'env-model');delete process.env[envKey];
  await writeFile(path.join(cwd,'.qoder','settings.local.json'),JSON.stringify({model:{preferences:{native:{reasoning:{effort:'max'},functionSwitchSelections:{high_speed:'false'}}}}}));
  const local=await adapter.initializeConfiguration({},cwd);assert.equal(local.reasoningEffort,'max');assert.equal(local.fastMode,false);
  for(const fastMode of [true,false]){
   const runtimeConfig=await adapter.initializeConfiguration({},cwd,{reasoningEffort:'medium',fastMode});
   const args=adapter.buildArgs({workspacePath:cwd,prompt:'test',fullAccess:true,runtimeConfig});
   assert.equal(args[args.indexOf('--model')+1],'native');assert.equal(args[args.indexOf('--reasoning-effort')+1],'medium');
   const settings=JSON.parse(args[args.indexOf('--settings')+1]);assert.equal(settings.model.preferences.native.functionSwitchSelections.high_speed,String(fastMode));assert.equal(settings.model.functionSwitchSelections.other,'keep');
  }
  await writeFile(path.join(cwd,'.qoder','settings.local.json'),JSON.stringify({model:{name:'different',preferences:{different:{generation:{reasoning:{enabled:false}},functionSwitchSelections:{fast_model:'false'}}}}}));
  const different=await adapter.initializeConfiguration({},cwd);assert.equal(different.model,'different');assert.equal(different.reasoningEffort,'none');assert.equal(different.fastMode,false,'do not inherit another model fast flag');
  assert.throws(()=>adapter.buildArgs({workspacePath:cwd,prompt:'test',runtimeConfig:{model:'unmapped',fastMode:true}}),/Fast/,'unsupported mapping must not silently claim success');
 }
 console.log('qoder-config: both providers, native preference precedence, generation, Fast on/off mapping and unsupported override passed');
}finally{if(old===undefined)delete process.env.QODER_CONFIG_DIR;else process.env.QODER_CONFIG_DIR=old;if(oldCn===undefined)delete process.env.QODERCN_CONFIG_DIR;else process.env.QODERCN_CONFIG_DIR=oldCn;if(oldCnModel===undefined)delete process.env.QODERCN_MODEL;else process.env.QODERCN_MODEL=oldCnModel;if(oldModel===undefined)delete process.env.QODER_MODEL;else process.env.QODER_MODEL=oldModel;await rm(dir,{recursive:true,force:true});}
