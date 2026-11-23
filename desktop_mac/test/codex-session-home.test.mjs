import assert from 'node:assert/strict';
import {mkdtemp} from './tmp.mjs';
import {chmod,lstat,mkdir,readFile,readlink,readdir,rename,rm,symlink,utimes,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {configureCodexSessionRoot,prepareCodexSessionHome,codexSessionConfigArgs} from '../dist/agents/codex-session-home.js';
import {codexChildEnvironment} from '../dist/agents/codex-environment.js';
import {CodexAdapter} from '../dist/agents/codex.js';

const root=await mkdtemp(path.join(os.tmpdir(),'ading-codex-home-'));
const source=path.join(root,'native'),target=path.join(root,'ading');
const savedHome=process.env.CODEX_HOME,savedSqlite=process.env.CODEX_SQLITE_HOME;
const id='123e4567-e89b-42d3-a456-426614174000';
const other='123e4567-e89b-42d3-a456-426614174001';
const isolatedHomes=new Set();
const relative=`sessions/2026/11/22/rollout-2026-11-22T10-00-00-${id}.jsonl`;
try {
  process.env.CODEX_HOME=source;process.env.CODEX_SQLITE_HOME=source;
  configureCodexSessionRoot(target);
  await mkdir(path.join(source,'sessions/2026/11/22'),{recursive:true});
  await mkdir(path.join(source,'skills'));await mkdir(path.join(source,'memories'));
  for(const [name,text] of Object.entries({'auth.json':'{"fixture":1}','config.toml':'model="fixture"','AGENTS.md':'native rules',
    'state_5.sqlite':'native database','session_index.jsonl':'native index','history.jsonl':'native history',
    [relative]:'original rollout', [relative.replace(id,other)]:'unrelated rollout'})) await writeFile(path.join(source,name),text);
  const initial=await prepareCodexSessionHome();
  assert.notEqual(initial.path,source);
  const inherited=codexChildEnvironment(initial.env);
  assert.equal(inherited.CODEX_HOME,source);
  assert.equal(inherited.CODEX_SQLITE_HOME,source);
  assert.equal(inherited.ADING_CODEX_NATIVE_HOME,undefined);
  assert.equal(codexChildEnvironment({...initial.env,CODEX_HOME:"/explicit-home"}).CODEX_HOME,"/explicit-home");
  assert.equal(initial.env.CODEX_SQLITE_HOME,initial.path);
  assert.deepEqual(codexSessionConfigArgs(initial.env),['-c',`sqlite_home=${JSON.stringify(initial.path)}`]);
  assert.equal(await readlink(path.join(initial.path,'config.toml')),path.join(source,'config.toml'));
  assert.equal(await readFile(path.join(initial.path,'auth.json'),'utf8'),'{"fixture":1}');
  for(const name of ['sessions','archived_sessions'])assert.ok(!(await lstat(path.join(initial.path,name))).isSymbolicLink());
  for(const name of ['state_5.sqlite','session_index.jsonl','history.jsonl'])assert.ok(!(await readdir(initial.path)).includes(name));
  await writeFile(path.join(source,'config.toml'),'model="changed"');
  assert.equal(await readFile(path.join(initial.path,'config.toml'),'utf8'),'model="changed"');
  await Promise.all(Array.from({length:8},()=>prepareCodexSessionHome(id)));
  assert.equal(await readFile(path.join(initial.path,relative),'utf8'),'original rollout');
  assert.ok(!(await lstat(path.join(initial.path,relative))).isSymbolicLink());
  assert.equal((await readdir(path.dirname(path.join(initial.path,relative)))).length,1);
  await writeFile(path.join(initial.path,relative),'private continuation');
  await prepareCodexSessionHome(id);
  assert.equal(await readFile(path.join(initial.path,relative),'utf8'),'private continuation');
  assert.equal(await readFile(path.join(source,relative),'utf8'),'original rollout');
  const rootBefore=(await readdir(root)).sort(),sessionsBefore=await readdir(path.join(initial.path,'sessions'));
  const escaped=await prepareCodexSessionHome('../../escape');
  assert.equal(escaped.path,initial.path);
  assert.deepEqual((await readdir(root)).sort(),rootBefore);
  assert.deepEqual(await readdir(path.join(initial.path,'sessions')),sessionsBefore);
  assert.deepEqual(await readdir(path.join(initial.path,'archived_sessions')),[]);
  // Refresh by older Codex versions which replace rather than follow a link.
  await writeFile(path.join(root,'refreshed-auth'),'refreshed');
  await rename(path.join(root,'refreshed-auth'),path.join(initial.path,'auth.json'));
  await initial.settle();
  assert.equal(await readFile(path.join(source,'auth.json'),'utf8'),'refreshed');
  assert.equal(await readlink(path.join(initial.path,'auth.json')),path.join(source,'auth.json'));
  assert.ok(!(await readdir(initial.path)).some(name=>name.includes('.ading-')));
  const conflict=await prepareCodexSessionHome();
  await writeFile(path.join(root,'stale-auth'),'stale');
  await rename(path.join(root,'stale-auth'),path.join(initial.path,'auth.json'));
  await writeFile(path.join(source,'auth.json'),'new native login');
  await conflict.settle();
  assert.equal(await readFile(path.join(initial.path,'auth.json'),'utf8'),'new native login');
  // Both execution transports and the memory-isolated path get private storage.
  const fake=path.join(root,'fake'),capture=path.join(root,'capture');
  await writeFile(fake,`#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({env:process.env,args:process.argv.slice(2)}));
const id=${JSON.stringify(id)},send=x=>console.log(JSON.stringify(x));
if(!process.argv.includes('app-server')){send({type:'thread.started',thread_id:id});send({type:'item.completed',item:{type:'agent_message',text:'ok'}});send({type:'turn.completed'});}
else {const io=require('node:readline').createInterface({input:process.stdin});io.on('close',()=>process.exit(0));io.on('line',line=>{const e=JSON.parse(line);if(e.method==='initialize')send({id:e.id,result:{}});if(e.method==='config/read')send({id:e.id,result:{config:{}}});if(e.method==='thread/start'||e.method==='thread/resume')send({id:e.id,result:{thread:{id}}});if(e.method==='turn/start'){send({id:e.id,result:{turn:{id:'turn'}}});send({method:'turn/completed',params:{threadId:id,turn:{id:'turn',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'ok'}]}}});}});}
`);await chmod(fake,0o700);
  const adapter=new CodexAdapter(),agent={kind:'codex',localUuid:'test',executablePath:fake,version:'fixture'};
  for(const steerable of [false,true])for(const isolateMemory of [false,true]) {
    const result=await adapter.executeTurn(agent,{prompt:'test',workspacePath:root,fullAccess:true,permissionMode:'unattended',onProgress:()=>{},threadId:id,steerable,isolateMemory});
    assert.equal(result.ok,true,JSON.stringify(result));
    const seen=JSON.parse(await readFile(capture,'utf8'));
    if(isolateMemory)isolatedHomes.add(seen.env.CODEX_HOME);
    assert.equal(seen.env.CODEX_SQLITE_HOME,initial.path);
    assert.notEqual(seen.env.CODEX_HOME,source);
    assert.ok(seen.args.includes(`sqlite_home=${JSON.stringify(initial.path)}`));
    if(isolateMemory){
      assert.ok(!(await readdir(seen.env.CODEX_HOME)).includes('AGENTS.md'));
      assert.equal(await readlink(path.join(seen.env.CODEX_HOME,'sessions')),path.join(initial.path,'sessions'));
    }
  }
  // A plain auth.json left behind by a crash before settle: native wins unless
  // the private copy was written after the native one last changed.
  const homeFor=native=>path.join(target,createHash('sha256').update(path.resolve(native)).digest('hex').slice(0,16));
  const crashed=path.join(root,'crashed');
  await mkdir(crashed);await writeFile(path.join(crashed,'auth.json'),'native');
  process.env.CODEX_HOME=crashed;
  const crashedHome=(await prepareCodexSessionHome()).path,stranded=path.join(crashedHome,'auth.json');
  const past=new Date(Date.now()-3600_000),now=new Date();
  const strand=async(text,privateTime,nativeTime)=>{
    await rm(stranded);await writeFile(stranded,text);await utimes(stranded,privateTime,privateTime);
    if(nativeTime)await utimes(path.join(crashed,'auth.json'),nativeTime,nativeTime);
  };
  await strand('stale',past,now);
  await prepareCodexSessionHome();
  assert.equal(await readFile(path.join(crashed,'auth.json'),'utf8'),'native');
  assert.equal(await readlink(stranded),path.join(crashed,'auth.json'));
  await strand('unsettled refresh',now,past);
  await Promise.all([prepareCodexSessionHome(),prepareCodexSessionHome()]);
  assert.equal(await readFile(path.join(crashed,'auth.json'),'utf8'),'unsettled refresh');
  assert.equal(await readlink(stranded),path.join(crashed,'auth.json'));
  await rm(path.join(crashed,'auth.json'));await strand('after logout',now);
  await prepareCodexSessionHome();
  assert.equal(await lstat(path.join(crashed,'auth.json')).catch(()=>undefined),undefined);
  assert.equal(await readlink(stranded),path.join(crashed,'auth.json'));
  assert.ok(!(await readdir(crashedHome)).some(name=>name.includes('.ading-')));
  // Directories Codex created privately before the native side had them are
  // merged into the native home without replacing native entries, then linked.
  const forked=path.join(root,'forked'),forkedHome=homeFor(forked);
  await mkdir(path.join(forked,'rules'),{recursive:true});await writeFile(path.join(forked,'rules/default.rules'),'native rule');
  await mkdir(path.join(forkedHome,'skills/.system'),{recursive:true});await writeFile(path.join(forkedHome,'skills/.system/SKILL.md'),'system skill');
  await mkdir(path.join(forkedHome,'rules'),{recursive:true});
  await writeFile(path.join(forkedHome,'rules/default.rules'),'private rule');await writeFile(path.join(forkedHome,'rules/extra.rules'),'extra rule');
  process.env.CODEX_HOME=forked;
  await Promise.all(Array.from({length:4},()=>prepareCodexSessionHome()));
  for(const name of ['skills','rules','agents','plugins','memories','memories_v2']) {
    assert.equal(await readlink(path.join(forkedHome,name)),path.join(forked,name));
    assert.ok((await lstat(path.join(forked,name))).isDirectory());
  }
  assert.equal(await readFile(path.join(forked,'skills/.system/SKILL.md'),'utf8'),'system skill');
  assert.equal(await readFile(path.join(forked,'rules/default.rules'),'utf8'),'native rule');
  assert.equal(await readFile(path.join(forked,'rules/extra.rules'),'utf8'),'extra rule');
  const aside=await readdir(path.join(forkedHome,'.ading-diverged'));
  assert.equal(aside.length,1);assert.ok(aside[0].startsWith('rules-'));
  assert.equal(await readFile(path.join(forkedHome,'.ading-diverged',aside[0],'default.rules'),'utf8'),'private rule');
  // A later native skill sync is visible through the link.
  await mkdir(path.join(forked,'skills/synced'));await writeFile(path.join(forked,'skills/synced/SKILL.md'),'synced');
  assert.equal(await readFile(path.join(forkedHome,'skills/synced/SKILL.md'),'utf8'),'synced');
  // The native Codex home itself is never created from scratch.
  const absent=path.join(root,'absent');
  process.env.CODEX_HOME=absent;
  const absentHome=(await prepareCodexSessionHome()).path;
  assert.equal(await lstat(absent).catch(()=>undefined),undefined);
  assert.ok(!(await readdir(absentHome)).includes('skills'));
  console.log('codex-session-home: private storage, selective atomic import, configuration/auth reuse, refresh conflicts, crash leftovers, shared directory merge, both transports and memory isolation passed');
} finally {
  if(savedHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=savedHome;
  if(savedSqlite===undefined)delete process.env.CODEX_SQLITE_HOME;else process.env.CODEX_SQLITE_HOME=savedSqlite;
  await rm(root,{recursive:true,force:true});
  for(const home of isolatedHomes)await rm(home,{recursive:true,force:true});
}
