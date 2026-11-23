import assert from 'node:assert/strict';
import {chmod, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from './tmp.mjs';
import {ClaudeCodeAdapter} from '../dist/agents/claude.js';
import {QoderAdapter} from '../dist/agents/qoder.js';

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ading-cli-refresh-')));
const callsFile = path.join(root, 'calls.jsonl');
const cli = path.join(root, 'new-version', 'cli');
const missing = path.join(root, 'removed-version', 'cli');
await mkdir(path.dirname(cli));
await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.0.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--tools --strict-mcp-config --setting-sources --no-session-persistence'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
const resume = args.indexOf('--resume');
const session_id = resume >= 0 ? args[resume + 1] : 'probe';
console.log(JSON.stringify({type:'result',subtype:'success',result:'ok',session_id}));
`, {mode:0o755});
const calls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const makeAgent = kind => ({kind, localUuid:'fixture-contact', name:'Custom name', nodeName:'fixture',
  executablePath:missing, version:'1.0.0', runtimeDefaults:{model:'fixture-model',fastMode:false}});
const input = {prompt:'continue', workspacePath:root, fullAccess:false, noComputerTools:true,
  threadId:'original-session', runtimeConfig:{model:'fixture-model',fastMode:false}, onProgress:()=>{}};
function adapterFor(Adapter = ClaudeCodeAdapter) {
  const adapter = new Adapter();
  adapter.readNativeConfiguration = async () => undefined;
  adapter.candidatePaths = () => [missing, cli];
  const discover = adapter.discover.bind(adapter);
  let count = 0;
  adapter.discover = async () => { count++; return discover(); };
  return {adapter, count:()=>count};
}

try {
  for (const Adapter of [ClaudeCodeAdapter, QoderAdapter]) {
    const {adapter, count} = adapterFor(Adapter);
    const agent = makeAgent(adapter.kind), defaults = agent.runtimeDefaults;
    const turnInput = Adapter === QoderAdapter ? {...input,runtimeConfig:{model:'fixture-model'}} : input;
    if (Adapter === QoderAdapter) delete defaults.fastMode;
    const result = await adapter.runTurn(agent, turnInput);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.threadId, 'original-session');
    assert.equal(agent.executablePath, cli);
    assert.equal(agent.version, '2.0.0');
    assert.equal(agent.localUuid, 'fixture-contact');
    assert.equal(agent.name, 'Custom name');
    assert.equal(agent.runtimeDefaults, defaults);
    assert.equal(count(), 1);
    await adapter.runTurn(agent, turnInput);
    assert.equal(count(), 1, 'Healthy paths do not trigger discovery on every turn');
    const args = (await calls()).at(-1);
    assert.equal(args[args.indexOf('--resume') + 1], input.threadId);
    assert.equal(args[args.indexOf('--model') + 1], input.runtimeConfig.model);
  }
  for (const method of ['verify', 'askOnce']) {
    const {adapter, count} = adapterFor();
    const agent = makeAgent(adapter.kind);
    delete agent.runtimeDefaults;
    const result = method === 'verify' ? await adapter.verify(agent) : await adapter.askOnce(agent, 'hello');
    assert.equal(result.ok, true, result.text);
    assert.equal(agent.executablePath, cli);
    assert.equal(count(), 1);
  }
  {
    const {adapter, count} = adapterFor();
    const agents = [makeAgent(adapter.kind), {...makeAgent(adapter.kind),localUuid:'second-contact'}];
    const results = await Promise.all(agents.map(agent => adapter.runTurn(agent, input)));
    assert.ok(results.every(result => result.ok));
    assert.equal(count(), 1, 'Concurrent missing paths share discovery');
    assert.ok(agents.every(agent => agent.executablePath === cli));
  }
  {
    const {adapter, count} = adapterFor();
    adapter.candidatePaths = () => [missing];
    const result = await adapter.runTurn(makeAgent(adapter.kind), input);
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
    assert.equal(count(), 1, 'No replacement must fail without a retry loop');
  }
  {
    const {adapter, count} = adapterFor();
    const result = await adapter.runTurn({...makeAgent(adapter.kind),executablePath:cli},
      {...input,workspacePath:path.join(root,'missing-workspace')});
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
    assert.equal(count(), 0, 'A missing workspace is not a stale executable');
    await chmod(cli, 0o644);
    const denied = await adapter.runTurn({...makeAgent(adapter.kind),executablePath:cli}, input);
    assert.equal(denied.ok, false);
    assert.match(denied.error, /EACCES/);
    assert.equal(count(), 0, 'Permission errors are not hidden by rediscovery');
  }
  console.log('CLI executable refresh: execution, probes, identity, concurrency and error boundaries passed');
} finally {
  await rm(root, {recursive:true,force:true});
}
