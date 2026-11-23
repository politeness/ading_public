import {configureCodexSessionRoot} from '../dist/agents/codex-session-home.js';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handshakeArgs, handshakeCommand, withHandshakeDirectory } from '../dist/agents/handshake.js';
import { execFileSync } from 'node:child_process';
import { ClaudeCodeAdapter } from '../dist/agents/claude.js';
import { QoderAdapter } from '../dist/agents/qoder.js';
import { QoderCnAdapter } from '../dist/agents/qoder-cn.js';
import { CodexAdapter } from '../dist/agents/codex.js';
import { classifyReadiness } from '../dist/agents/readiness.js';

const help = '--tools --strict-mcp-config --setting-sources --no-session-persistence --safe-mode --ignore-user-config --ephemeral --list-models';
const after = (args, key) => args[args.indexOf(key) + 1];
for (const kind of ['claude-code', 'qoder', 'qoder-cn', 'codex']) {
  const args = handshakeArgs(kind, '/test/isolated', help);
  assert.ok(!args.includes('--resume'));
  assert.throws(() => handshakeArgs(kind, '/test/isolated', ''), /不支持轻量检测/);
  if (kind === 'codex') {
    assert.ok(!args.includes('--ignore-user-config') && args.includes('--ephemeral'));
    assert.ok(args.includes('notify=[]'), 'probes do not run notification commands');
    assert.ok(args.includes('features.shell_tool=false') && args.includes('features.hooks=false'));
    assert.equal(after(args, '-C'), '/test/isolated');
  } else {
    assert.equal(after(args, '--tools'), '');
    assert.equal(after(args, '--setting-sources'), '');
    assert.deepEqual(JSON.parse(after(args, '--mcp-config')), {mcpServers:{}});
    assert.equal(JSON.parse(after(args, '--settings')).disableAllHooks, true);
    assert.ok(args.includes('--no-session-persistence'));
    if (kind === 'claude-code') assert.ok(args.includes('--safe-mode') && args.includes('--no-chrome'));
    else assert.equal(after(args, '--cwd'), '/test/isolated');
  }
}
// One-off calls ask a different question: all four must pass the question through as-is and still not persist.
// The two qoder variants override verificationArgs; if ask is dropped they still ask the connectivity-check line,
// and task naming would get back an "OK" as the name -- this catches that omission.
for (const kind of ['claude-code', 'qoder', 'qoder-cn', 'codex']) {
  const ask = { prompt: '给这件事起个名字：把票据按月份归档' };
  const args = handshakeArgs(kind, '/test/isolated', help, ask);
  assert.ok(args.includes(ask.prompt), `${kind} carries the question to ask`);
  assert.ok(!args.some(arg => String(arg).includes('这是连接检测')), `${kind} no longer asks the connectivity-check line`);
  if (kind === 'codex') assert.ok(args.includes('--ephemeral'), 'codex still does not persist');
  else assert.ok(args.includes('--no-session-persistence'), `${kind} still does not persist`);
}

let failedDirectory;
await assert.rejects(withHandshakeDirectory('codex', async cwd => {
  failedDirectory = cwd;
  assert.deepEqual(await readdir(cwd), []);
  // The directory name records who is handshaking, so leftovers can be traced
  assert.ok(path.basename(cwd).startsWith('ading-handshake-codex-'), `Handshake directory name must include the Agent identifier: ${path.basename(cwd)}`);
  throw new Error('probe failed');
}), /probe failed/);
await assert.rejects(access(failedDirectory));
const root = await mkdtemp(path.join(os.tmpdir(), 'ading-handshake-test-'));
configureCodexSessionRoot(path.join(root,'codex-sessions'));
assert.deepEqual(handshakeCommand('/cli', ['--help'], 'linux'), {executablePath:'/cli',args:['--help']});
if (process.platform === 'darwin') {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'Documents'));
  const protectedFile = path.join(root, 'Documents', 'private.txt');
  await writeFile(protectedFile, 'must not be read');
  const command = handshakeCommand('/bin/cat', [protectedFile], 'darwin', root);
  assert.throws(() => execFileSync(command.executablePath, command.args, {stdio:'pipe'}));
  const normal = handshakeCommand('/bin/echo', ['OK'], 'darwin', root);
  assert.equal(execFileSync(normal.executablePath, normal.args, {encoding:'utf8'}).trim(), 'OK');
}
const executable = path.join(root, 'fake-cli');
await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--help')) console.log(${JSON.stringify(help)});
else if(args[0]==='app-server') {
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);
    if(request.id)console.log(JSON.stringify({id:request.id,result:request.method==='config/read'?{config:{model_provider:'custom',mcp_servers:{fixture:{command:'never-run'},'with.dot':{command:'never-run'}}}}:{}}));
  });
}
else {
  if(!process.cwd().includes('ading-handshake-')) process.exit(2);
  const record={cwd:process.cwd(),args};
  fs.writeFileSync(${JSON.stringify(path.join(root, 'record.json'))},JSON.stringify(record));
  if(args.includes('--list-models')) console.log('MODEL\\nCustom ('+(process.env.TEST_QODER_MODEL || 'custom-model')+')');
  else if(process.env.TEST_QODER_FAILURE || (process.env.TEST_QODER_MODEL && args[args.indexOf('--model')+1]!==process.env.TEST_QODER_MODEL)) {
    console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'quota exhausted'}));
  } else if(args[0]==='exec') {
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'OK'}}));
  } else console.log(JSON.stringify({type:'result',subtype:'success',result:'OK',session_id:'test'}));
}
`, {mode:0o700});
const {readFile} = await import('node:fs/promises');
const envKeys=['CLAUDE_CONFIG_DIR','ANTHROPIC_MODEL','CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_DISABLE_FAST_MODE','QODER_CONFIG_DIR','QODERCN_CONFIG_DIR','QODER_APP_CONFIG_DIR','QODERCN_APP_CONFIG_DIR','QODER_MODEL','QODERCN_MODEL','TEST_QODER_MODEL','TEST_QODER_FAILURE'];
const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
process.env.QODER_CONFIG_DIR=root;process.env.QODERCN_CONFIG_DIR=root;
delete process.env.QODER_APP_CONFIG_DIR;delete process.env.QODERCN_APP_CONFIG_DIR;
delete process.env.QODER_MODEL;delete process.env.QODERCN_MODEL;
process.env.CLAUDE_CONFIG_DIR=root;
delete process.env.ANTHROPIC_MODEL;
delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE;
try {
const claude = new ClaudeCodeAdapter();
const claudeAgent = {kind:claude.kind,localUuid:'claude-probe',executablePath:executable};
for (const model of ['fable-test', 'opus-test']) {
  await writeFile(path.join(root,'settings.json'),JSON.stringify({model,effortLevel:'high',fastMode:false}));
  assert.deepEqual(await claude.verify(claudeAgent),{ok:true,text:'OK'});
  const {args}=JSON.parse(await readFile(path.join(root,'record.json'),'utf8'));
  assert.equal(after(args,'--model'),model,'each probe re-reads the native selection');
  assert.equal(after(args,'--effort'),'high');
  assert.deepEqual(JSON.parse(after(args,'--settings')),{disableAllHooks:true,fastMode:false});
  assert.equal(args.filter(arg=>arg==='--settings').length,1);
}
assert.deepEqual(await claude.verify(claudeAgent,{model:'override-test'}),{ok:true,text:'OK'});
assert.equal(after(JSON.parse(await readFile(path.join(root,'record.json'),'utf8')).args,'--model'),'override-test');
await claude.askOnce(claudeAgent,'name this task');
assert.equal(after(JSON.parse(await readFile(path.join(root,'record.json'),'utf8')).args,'-p'),'name this task');
await rm(path.join(root,'settings.json'));
for(const Adapter of [ClaudeCodeAdapter, QoderAdapter, QoderCnAdapter, CodexAdapter]) {
  const adapter = new Adapter();
  const result = await adapter.verify({kind:adapter.kind,localUuid:adapter.kind,executablePath:executable});
  assert.deepEqual(result, {ok:true,text:'OK'});
  const record=JSON.parse(await readFile(path.join(root,'record.json'),'utf8'));
  if(adapter.kind==='codex') {
    assert.ok(record.args.includes('mcp_servers={"fixture"={enabled=false},"with.dot"={enabled=false}}'));
    assert.ok(!record.args.includes('--ignore-user-config'), 'custom provider and routing must survive verification');
  }
  await assert.rejects(access(record.cwd));
}
for(const Adapter of [QoderAdapter,QoderCnAdapter]) {
  const adapter=new Adapter(),agent={kind:adapter.kind,localUuid:adapter.kind,executablePath:executable};
  const envKey=adapter.kind==='qoder-cn'?'QODERCN_MODEL':'QODER_MODEL';
  process.env[envKey]='byok:custom-model';process.env.TEST_QODER_MODEL='custom-model';
  assert.deepEqual(await adapter.verify(agent),{ok:true,text:'OK'},'probe uses the selected BYOK model instead of exhausted official default');
  let record=JSON.parse(await readFile(path.join(root,'record.json'),'utf8'));
  assert.equal(after(record.args,'--model'),'custom-model');
  assert.equal(after(record.args,'--tools'),'');assert.equal(after(record.args,'--setting-sources'),'');
  assert.equal(JSON.parse(after(record.args,'--settings')).disableAllHooks,true);
  assert.ok(record.args.includes('--no-session-persistence'));
  await assert.rejects(access(record.cwd));
  process.env.TEST_QODER_MODEL='override';
  assert.deepEqual(await adapter.verify(agent,{model:'byok:override'}),{ok:true,text:'OK'},'ADing override wins over native selection');
  process.env.TEST_QODER_FAILURE='1';
  const exhausted=await adapter.verify(agent,{model:'byok:override'});
  assert.equal(classifyReadiness(true,exhausted).readiness,'exhausted','real quota failures from the selected custom model remain visible');
  delete process.env.TEST_QODER_FAILURE;
  process.env[envKey]='byok:missing';
  const missing=await adapter.verify(agent);
  assert.match(missing.text,/CLI 未找到当前自定义模型/);
  assert.equal(classifyReadiness(true,missing).readiness,'error');
  assert.equal(missing.recovery.action,'login');
  assert.equal(missing.recovery.statusText,'模型未同步');
  record=JSON.parse(await readFile(path.join(root,'record.json'),'utf8'));
  assert.ok(record.args.includes('--list-models'),'missing BYOK never invokes the default model');
  await assert.rejects(access(record.cwd));
  delete process.env[envKey];delete process.env.TEST_QODER_MODEL;
}
} finally {
  for(const key of envKeys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
  await rm(root,{recursive:true,force:true});
}
console.log('handshake: all four adapters passed (isolated cwd, no tools/hooks/MCP, cleanup, fail-closed compatibility)');
