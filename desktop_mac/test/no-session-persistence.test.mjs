import {configureCodexSessionRoot} from '../dist/agents/codex-session-home.js';
// Background sync turns leave no session records: each vendor runs real argument generation and process invocation with a fake CLI, with HOME pointing at a temp directory.
import assert from 'node:assert/strict';
import {lstat,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from './tmp.mjs';

const root=await mkdtemp(path.join(os.tmpdir(),'ading-no-persist-'));
configureCodexSessionRoot(path.join(root,'codex-sessions'));
const realHome=os.homedir(),home=path.join(root,'home'),workspace=path.join(root,'work');
const savedEnv=Object.fromEntries(['HOME','COPILOT_HOME','QWEN_HOME'].map(key=>[key,process.env[key]]));
process.env.HOME=home;delete process.env.COPILOT_HOME;process.env.QWEN_HOME=path.join(home,'.qwen');
await mkdir(process.env.QWEN_HOME,{recursive:true});await mkdir(workspace);
assert.equal(os.homedir(),home,'nothing below may resolve to the real home');
assert.notEqual(realHome,home);

const {ClaudeCodeAdapter}=await import('../dist/agents/claude.js');
const {QoderAdapter}=await import('../dist/agents/qoder.js');
const {QwenCodeAdapter}=await import('../dist/agents/qwen.js');
const {CodexAdapter}=await import('../dist/agents/codex.js');
const {KiroAdapter,CopilotAdapter}=await import('../dist/agents/acp-providers.js');
const {AntigravityAdapter}=await import('../dist/agents/antigravity.js');
const {isOwnSessionId,removeOwnSessionEntry}=await import('../dist/agents/session-discard.js');

const exists=target=>lstat(target).then(()=>true,()=>false);
let cliCount=0;
/** help: what --help prints, or null for a failing --help. Every other call is recorded with its argv. */
async function fakeCli({help,body}) {
  const dir=path.join(root,`cli-${++cliCount}`);await mkdir(dir);
  const file=path.join(dir,'cli.cjs'),log=path.join(dir,'calls.jsonl');
  await writeFile(file,`#!/usr/bin/env node
const fs=require('node:fs'),argv=process.argv.slice(2),help=${JSON.stringify(help)};
if(argv.includes('--help')){if(help===null)process.exit(1);process.stdout.write(help);process.exit(0);}
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv,cwd:process.cwd()})+'\\n');
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const lines=require('node:readline').createInterface({input:process.stdin});
${body}
`,{mode:0o755});
  return {file,calls:async()=>(await readFile(log,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}
const STREAM=`lines.on('line',line=>{const m=JSON.parse(line);
 if(m.type==='control_request'&&m.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
 else if(m.type==='user'){send({type:'system',subtype:'init',session_id:'stream-session',model:'fixture'});
  send({type:'result',subtype:'success',is_error:false,result:'done',session_id:'stream-session'});process.exit(0);}});`;
const CODEX=`send({type:'thread.started',thread_id:'019a0000-0000-7000-8000-000000000001'});
send({type:'item.completed',item:{id:'1',type:'agent_message',text:'done'}});send({type:'turn.completed',usage:{}});process.exit(0);`;
// A turn that fails after session/new still created a session, so it is removed too.
const acp=sessionId=>`if(argv[0]==='chat'&&argv[1]==='--delete-session'){process.exit(process.env.FAKE_DELETE_FAILS?1:0);}
const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
lines.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')reply(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true}});
 else if(m.method==='session/new')reply(m.id,{sessionId:${JSON.stringify(sessionId)}});
 else if(m.method==='session/load')reply(m.id,{sessionId:m.params.sessionId});
 else if(m.method==='session/prompt'){
  if(m.params.prompt[0].text==='fail'){send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'boom'}});return;}
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}}}});
  reply(m.id,{stopReason:'end_turn'});}});`;
const base={prompt:'work',workspacePath:workspace,fullAccess:true,permissionMode:'unattended',noComputerTools:true,onProgress:()=>{}};
const turn=(adapter,cli,input={})=>adapter.executeTurn({kind:adapter.kind,name:adapter.label,localUuid:`${adapter.kind}-${cliCount}`,executablePath:cli.file},{...base,...input});

try {
 // Flag families: listed in --help is passed, missing or unreadable help is left out without failing.
 const families=[
  {name:'Claude Code',make:()=>new ClaudeCodeAdapter(),body:STREAM,flag:'--no-session-persistence',helpFlag:'--no-session-persistence'},
  {name:'Qoder',make:()=>new QoderAdapter(),body:STREAM,flag:'--no-session-persistence',helpFlag:'--no-session-persistence'},
  {name:'Qwen Code',make:()=>new QwenCodeAdapter(),body:STREAM,flag:'--chat-recording=false',helpFlag:'--chat-recording',ordinary:'--chat-recording=true'},
  {name:'Codex',make:()=>new CodexAdapter(),body:CODEX,flag:'--ephemeral',helpFlag:'--ephemeral'}
 ];
 for(const {name,make,body,flag,helpFlag,ordinary} of families){
  const adapter=make();
  const supported=await fakeCli({help:`Options:\n  ${helpFlag}  Do not save\n`,body});
  let out=await turn(adapter,supported,{noSessionPersistence:true});
  assert.equal(out.ok,true,`${name}: ${JSON.stringify(out)}`);
  assert.ok((await supported.calls())[0].argv.includes(flag),`${name} passes ${flag}`);
  out=await turn(adapter,supported);
  assert.equal(out.ok,true,`${name}: ${JSON.stringify(out)}`);assert.ok(out.threadId,`${name} ordinary turn stays resumable`);
  const ordinaryArgs=(await supported.calls())[1].argv;
  assert.ok(!ordinaryArgs.includes(flag),`${name} ordinary turn does not pass ${flag}`);
  if(ordinary)assert.ok(ordinaryArgs.includes(ordinary),`${name} ordinary turn keeps recording`);
  for(const help of ['Options:\n  --print\n',null]){
   const older=await fakeCli({help,body});
   out=await turn(adapter,older,{noSessionPersistence:true});
   assert.equal(out.ok,true,`${name} without the flag still finishes: ${JSON.stringify(out)}`);
   assert.ok(!(await older.calls())[0].argv.some(arg=>arg.startsWith(helpFlag)),`${name} leaves out a flag the build does not list`);
  }
 }

 // Copilot: only this turn's session directory goes.
 {
  const states=path.join(home,'.copilot/session-state'),own='copilot-own',other=path.join(states,'copilot-other');
  const outside=path.join(root,'copilot-outside');await mkdir(outside);await writeFile(path.join(outside,'keep'),'x');
  const plant=async()=>{await mkdir(path.join(states,own),{recursive:true});await writeFile(path.join(states,own,'events.jsonl'),'{}');
   await rm(path.join(states,own,'link'),{force:true});await symlink(outside,path.join(states,own,'link'));
   await mkdir(other,{recursive:true});await writeFile(path.join(other,'events.jsonl'),'{}');};
  const adapter=new CopilotAdapter(),cli=await fakeCli({help:'Options:\n',body:acp(own)});
  await plant();
  let out=await turn(adapter,cli);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.threadId,own);
  assert.ok(await exists(path.join(states,own,'events.jsonl')),'an ordinary turn keeps its session');
  out=await turn(adapter,cli,{noSessionPersistence:true,threadId:own});
  assert.equal(out.ok,true,JSON.stringify(out));assert.ok(await exists(path.join(states,own)),'a resumed session is not this turn\'s');
  out=await turn(adapter,cli,{noSessionPersistence:true});
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.equal(await exists(path.join(states,own)),false,'its own session is removed');
  assert.ok(await exists(path.join(other,'events.jsonl')),'another session stays');
  assert.ok(await exists(path.join(outside,'keep')),'a symlink inside is not followed');
  assert.ok(!(await cli.calls()).some(call=>call.argv.includes('--delete-session')));
  await plant();
  out=await turn(adapter,cli,{noSessionPersistence:true,prompt:'fail'});
  assert.equal(out.ok,false);assert.equal(await exists(path.join(states,own)),false,'a failed turn also removes the session it created');
  // COPILOT_HOME replaces ~/.copilot.
  const custom=path.join(root,'copilot-home');process.env.COPILOT_HOME=custom;
  await mkdir(path.join(custom,'session-state',own),{recursive:true});await plant();
  out=await turn(adapter,cli,{noSessionPersistence:true});
  assert.equal(await exists(path.join(custom,'session-state',own)),false);assert.ok(await exists(path.join(states,own)),'the default directory is not used then');
  delete process.env.COPILOT_HOME;
  // An ID that could leave the directory removes nothing and does not fail the turn.
  const hostile=await fakeCli({help:'Options:\n',body:acp('../copilot-other')});
  out=await turn(adapter,hostile,{noSessionPersistence:true});
  assert.equal(out.ok,true,JSON.stringify(out));assert.ok(await exists(path.join(other,'events.jsonl')));
 }

 // Kiro: its own command when listed, then only this session's files.
 {
  const sessions=path.join(home,'.kiro/sessions/cli'),own='kiro-own';await mkdir(sessions,{recursive:true});
  const plant=()=>Promise.all(['.json','.jsonl','.lock'].map(suffix=>writeFile(path.join(sessions,own+suffix),'{}')));
  await writeFile(path.join(sessions,'kiro-other.json'),'{}');await writeFile(path.join(sessions,'kiro-other.jsonl'),'{}');
  const gone=async()=>{for(const suffix of ['.json','.jsonl','.lock'])assert.equal(await exists(path.join(sessions,own+suffix)),false,suffix);
   assert.ok(await exists(path.join(sessions,'kiro-other.json')));assert.ok(await exists(path.join(sessions,'kiro-other.jsonl')));};
  const adapter=new KiroAdapter(home);
  const listed=await fakeCli({help:'Options:\n  --delete-session <ID>\n',body:acp(own)});
  await plant();
  let out=await turn(adapter,listed);
  assert.equal(out.ok,true,JSON.stringify(out));assert.ok(await exists(path.join(sessions,`${own}.jsonl`)),'an ordinary turn keeps its session');
  assert.ok(!(await listed.calls()).some(call=>call.argv.includes('--delete-session')));
  out=await turn(adapter,listed,{noSessionPersistence:true,threadId:own});
  assert.ok(await exists(path.join(sessions,`${own}.jsonl`)),'a resumed session is not this turn\'s');
  assert.ok(!(await listed.calls()).some(call=>call.argv.includes('--delete-session')));
  out=await turn(adapter,listed,{noSessionPersistence:true});
  assert.equal(out.ok,true,JSON.stringify(out));
  const removal=(await listed.calls()).find(call=>call.argv.includes('--delete-session'));
  assert.deepEqual(removal.argv,['chat','--delete-session',own]);
  assert.equal(removal.cwd.endsWith(path.basename(workspace)),true,'Kiro scopes sessions by directory');
  await gone();
  const unlisted=await fakeCli({help:'Options:\n',body:acp(own)});
  await plant();
  out=await turn(adapter,unlisted,{noSessionPersistence:true});
  assert.equal(out.ok,true,JSON.stringify(out));assert.ok(!(await unlisted.calls()).some(call=>call.argv.includes('--delete-session')));
  await gone();
  // A failing command neither fails the turn nor stops the file removal.
  process.env.FAKE_DELETE_FAILS='1';
  await plant();
  out=await turn(adapter,listed,{noSessionPersistence:true});
  delete process.env.FAKE_DELETE_FAILS;
  assert.equal(out.ok,true,JSON.stringify(out));await gone();
  // A symlink named like the session is left alone, along with what it points at.
  const target=path.join(root,'kiro-target.json');await writeFile(target,'{}');
  await symlink(target,path.join(sessions,`${own}.json`));
  out=await turn(adapter,unlisted,{noSessionPersistence:true});
  assert.equal(out.ok,true,JSON.stringify(out));assert.ok(await exists(target));
  assert.ok((await lstat(path.join(sessions,`${own}.json`))).isSymbolicLink());
  await rm(path.join(sessions,`${own}.json`));
 }

 // Antigravity: no flag and no documented layout, so the run is unchanged and nothing is removed.
 {
  const conversations=path.join(home,'.gemini/antigravity-cli/conversations');await mkdir(conversations,{recursive:true});
  const stored=path.join(conversations,'agy-own.db');await writeFile(stored,'x');
  const adapter=new AntigravityAdapter(home);
  const cli=await fakeCli({help:'Options:\n',body:`lines.on('line',()=>{send({event:'init',conversation_id:'agy-own'});
   send({event:'result',result:{conversation_id:'agy-own',status:'SUCCESS',response:'done',usage:{}}});process.exit(0);});`});
  const out=await turn(adapter,cli,{noSessionPersistence:true});
  assert.equal(out.ok,true,JSON.stringify(out));assert.ok(await exists(stored),'an undocumented layout is not guessed at');
  assert.deepEqual((await cli.calls())[0].argv,adapter.buildArgs(base));
 }

 // The removal primitive itself.
 {
  const dir=path.join(root,'primitive');await mkdir(path.join(dir,'folder'),{recursive:true});await writeFile(path.join(dir,'file'),'x');await writeFile(path.join(root,'above'),'x');
  for(const bad of ['','.','..','../above','a/b','-rf','.hidden'])assert.equal(isOwnSessionId(bad),false,bad);
  for(const good of ['019a0000-0000-7000-8000-000000000001','sess_1.2'])assert.equal(isOwnSessionId(good),true,good);
  assert.equal(await removeOwnSessionEntry(dir,'../above','file'),false);assert.ok(await exists(path.join(root,'above')));
  assert.equal(await removeOwnSessionEntry(dir,'folder','file'),false,'wrong type stays');assert.equal(await removeOwnSessionEntry(dir,'file','directory'),false,'wrong type stays');
  assert.equal(await removeOwnSessionEntry(dir,'missing','file'),false);
  assert.equal(await removeOwnSessionEntry(dir,'file','file'),true);assert.equal(await removeOwnSessionEntry(dir,'folder','directory'),true);
 }
 // Qoder's per-session debug log has no switch: the turn removes its own, nothing else, ordinary turns keep theirs.
 {
  const adapter=new QoderAdapter(),cli=await fakeCli({help:'Options:\n  --no-session-persistence  Do not save\n',body:STREAM});
  const workspace=path.join(home,'Application Support.A_b');await mkdir(workspace,{recursive:true});
  const root=path.join(home,'.qoder/logs/sessions',(await realpath(workspace)).replace(/[^A-Za-z0-9]/g,'-'));
  const own=path.join(root,'stream-session'),other=path.join(root,'other-session');
  await mkdir(own,{recursive:true});await mkdir(other,{recursive:true});
  await turn(adapter,cli,{workspacePath:workspace});
  assert.ok(await exists(own),'an ordinary turn keeps its log');
  await turn(adapter,cli,{workspacePath:workspace,noSessionPersistence:true});
  assert.ok(!await exists(own),'the turn removes its own log');
  assert.ok(await exists(other),'other sessions stay');
  await rm(other,{recursive:true});await mkdir(own,{recursive:true});
  await turn(adapter,cli,{workspacePath:workspace,noSessionPersistence:true});
  assert.ok(!await exists(root),'an emptied log directory goes too');
 }
 console.log('no-session-persistence: flags, older CLIs, ordinary turns, own-session removal and temp HOME passed');
} finally {
 for(const [key,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 await rm(root,{recursive:true,force:true});
}
