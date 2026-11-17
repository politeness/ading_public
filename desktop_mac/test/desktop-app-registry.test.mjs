import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {AgentRegistry} from '../dist/agents/registry.js';
import {ClaudeCodeAdapter} from '../dist/agents/claude.js';
import {QwenCodeAdapter} from '../dist/agents/qwen.js';
import {AgentLifecycleService} from '../dist/agents/lifecycle.js';
import {desktopAppPaths,findDesktopApp} from '../dist/agents/desktop-apps.js';
import {KiroAdapter,CopilotAdapter} from '../dist/agents/acp-providers.js';
import {QoderAdapter} from '../dist/agents/qoder.js';
import {QoderCnAdapter} from '../dist/agents/qoder-cn.js';
import {AntigravityAdapter} from '../dist/agents/antigravity.js';

const root=await mkdtemp(path.join(os.tmpdir(),'ading-app-registry-'));
const previousHome=process.env.HOME;
try {
 process.env.HOME=root;
 const agent={kind:'qwen-code',localUuid:'fixture',name:'Qwen Code',version:'fixture',executablePath:'/fixture/qwen',nodeName:'fixture'};
 const registry=new AgentRegistry(),calls=[];
 registry.lifecycle.install=async(kind,confirmed,report)=>{calls.push(kind);report?.('CLI progress',{receivedBytes:10,totalBytes:20});return {kind,action:'install',ok:confirmed,requiresUserAction:!confirmed,message:'fixture'};};
 registry.adapterFor=()=>({discover:async()=>[agent]});
 assert.equal((await registry.install('qwen-code',true)).ok,true);
 assert.deepEqual(calls,[],'reuse an existing CLI, including an App-bundled runtime');
 registry.adapterFor=()=>({discover:async()=>[]});
 for(const kind of ['codex','claude-code','qoder','qoder-cn','qwen-code','copilot','kiro','antigravity']) {
  const progress=[];
  assert.equal((await registry.install(kind,true,(...args)=>progress.push(args))).ok,true);
  assert.equal(calls.at(-1),kind);
  assert.deepEqual(progress,[['CLI progress',{receivedBytes:10,totalBytes:20}]]);
 }
 calls.length=0;
 await registry.install('qwen-code',false);
 assert.deepEqual(calls,['qwen-code'],'unconfirmed request only checks CLI confirmation');
 registry.lifecycle.install=async()=>({kind:'copilot',action:'install',ok:false,requiresUserAction:false,message:'CLI failed'});
 assert.equal((await registry.install('copilot',true)).message,'CLI failed','CLI failure must not trigger an App fallback');
 registry.lifecycle.install=async()=>{throw Error('CLI exception');};
 // The visible message is the error text itself, without an "Error: " prefix.
 assert.equal((await registry.install('copilot',true)).message,'CLI exception');

 let release,installs=0;
 registry.lifecycle.install=()=>{installs++;return new Promise(resolve=>{release=resolve;});};
 const first=registry.install('qwen-code',true),second=registry.install('qwen-code',true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(installs,1);release({kind:'qwen-code',action:'install',ok:true});await Promise.all([first,second]);
 const claude=new ClaudeCodeAdapter();
 await mkdir(path.join(root,'Applications/Claude.app'),{recursive:true});
 assert.equal(await claude.setupNotice(),null,'Claude App does not force opening Code before CLI installation');
 assert.equal(await claude.vendorAppInstalled(),true);

 const app=path.join(root,'Applications/Qwen Code Desktop.app');
 await mkdir(path.join(app,'Contents'),{recursive:true});
 await writeFile(path.join(app,'Contents/Info.plist'),'fixture');
 const opened=[];
 const login=new AgentRegistry({openApp:async file=>{opened.push(file);}});
 login.requireDiscovered=async()=>agent;
 login.adapterFor=()=>({});
 login.lifecycle.login=async()=>{throw new Error('Qwen desktop setup must not enter CLI login');};
 const result=await login.login('qwen-code',true);
 assert.deepEqual(opened,[app]);assert.equal(result.ok,false);assert.equal(result.awaitingUserAction,true);assert.equal(result.requiresUserAction,true);
 const qwen=new QwenCodeAdapter();
 assert.ok(qwen.extraCandidates().includes(path.join(app,'Contents/Resources/runtime/qwen-code/bin/qwen')));
 const cancelled=new AgentLifecycleService('/fixture/npm',path.join(root,'prefix'));
 cancelled.runner.run=async()=>({stdout:'',stderr:'',failure:'',cancelled:true,exitCode:null});
 assert.equal((await cancelled.install('copilot',true)).ok,false,'cancelled CLI supplement is never successful');
 const browser=[],progress=[];
 const deviceLogin=new AgentRegistry({openExternal:async url=>{browser.push(url);}});
 deviceLogin.requireDiscovered=async()=>({...agent,kind:'copilot'});
 deviceLogin.adapterFor=()=>({label:'Copilot',loginAuthorizationUrl:text=>text.includes('https://github.com/login/device')?'https://github.com/login/device':undefined});
 deviceLogin.lifecycle.login=async(_agent,_confirmed,report)=>{
   report('Use code ABCD-1234 at https://github.com/login/device');
   report('Use code EFGH-5678 at https://github.com/login/device');
   return {kind:'copilot',action:'login',ok:true,message:'done'};
 };
 await deviceLogin.login('copilot',true,line=>progress.push(line));
 assert.equal(browser.length,1);
 assert.ok(progress.some(line=>line.includes('ABCD-1234')));
 assert.ok(progress.some(line=>line.includes('EFGH-5678')),'repeated URL must not hide a new device code');
 const authService=new AgentLifecycleService();let probes=0;
 authService.authStatus=async()=>{probes++;throw Error('must not send a second model request');};
 authService.runner.run=async()=>({stdout:'Logged in',stderr:'',failure:'',cancelled:false,exitCode:0});
 assert.equal((await authService.login({...agent,kind:'copilot'},true)).ok,true);
 authService.runner.run=async()=>({stdout:'',stderr:'',failure:'',cancelled:true,exitCode:null});
 assert.equal((await authService.login({...agent,kind:'copilot'},true)).ok,false);
 assert.equal(probes,0);
 const kiroStatus=new AgentLifecycleService();
 kiroStatus.runner.run=async(_id,options)=>{assert.deepEqual(options.args,['whoami','--format','json']);return {stdout:'{"user":"fixture"}',stderr:'',failure:'',cancelled:false,exitCode:0};};
 assert.equal((await kiroStatus.authStatus({...agent,kind:'kiro'})).state,'signed-in');
 // Installed official apps are only detected, so their bundled CLI can be reused.
 assert.deepEqual(desktopAppPaths('qwen-code',['/fixture/apps']),['/fixture/apps/Qwen Code Desktop.app']);
 // "Vendor app installed" and bundled-CLI discovery read the same single list.
 for(const adapter of [new KiroAdapter(root),new CopilotAdapter(),new QoderAdapter(),new QoderCnAdapter(),new AntigravityAdapter(root),new QwenCodeAdapter(),new ClaudeCodeAdapter()])
  assert.deepEqual(adapter.desktopAppPaths(),desktopAppPaths(adapter.kind),adapter.kind);
 assert.ok(desktopAppPaths('kiro').some(file=>file.endsWith('/Kiro CLI.app')));
 assert.ok(desktopAppPaths('qoder-cn').some(file=>file.endsWith('/Qoder CN IDE.app')));
 const apps=path.join(root,'Apps');await mkdir(path.join(apps,'Kiro.app/Contents'),{recursive:true});
 assert.equal(await findDesktopApp('kiro',[apps]),undefined,'a bundle without Info.plist is not an app');
 await writeFile(path.join(apps,'Kiro.app/Contents/Info.plist'),'');
 assert.equal(await findDesktopApp('kiro',[apps]),path.join(apps,'Kiro.app'));
 console.log('desktop-app-registry: CLI-first for eight providers, existing runtime reuse, failure isolation, single flight and native Qwen setup passed');
} finally {
 if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
 await rm(root,{recursive:true,force:true});
}
