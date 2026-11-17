import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from './tmp.mjs';
import { AntigravityAdapter } from '../dist/agents/antigravity.js';
import { classifyReadiness } from '../dist/agents/readiness.js';
import { setMainLanguage } from '../dist/i18n.js';
import { AgentLifecycleService } from '../dist/agents/lifecycle.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'ading-antigravity-adaptation-'));
const cli = path.join(root, 'agy-fixture.cjs');
await writeFile(cli, `#!/usr/bin/env node
const send = value => console.log(JSON.stringify(value));
const args = process.argv.slice(2);
const id = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'parent';
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const prompt = JSON.parse(line).message.content;
 // The connection check prompt (either language) answers as a signed-out CLI.
 if (prompt === 'startup' || prompt === 'auth' || /connection check|连接检测/.test(prompt)) {
  send({event:'result',result:{conversation_id:'',status:'ERROR',response:'',error:prompt !== 'startup' ? 'authentication failed or timed out' : 'invalid model selection: unknown-fixture'}});
  if (prompt !== 'startup') console.error('Error: authentication required. Run agy to log in.');
  process.exitCode=1; return;
 }
 send({event:'result',result:{conversation_id:'unowned',status:'SUCCESS',response:'FOREIGN BEFORE INIT'}});
 send({event:'init',conversation_id:id});
 send({event:'step_update',step_update:{conversation_id:'child',step_type:'agent_response',text_delta:'FOREIGN'}});
 send({event:'result',result:{conversation_id:'child',status:'ERROR',error:'FOREIGN ERROR'}});
 send({event:'step_update',step_update:{conversation_id:id,step_type:'agent_response',text_delta:'partial'}});
 send({event:'step_update',step_update:{conversation_id:id,step_type:'agent_response',text_delta:{malformed:true}}});
 if (prompt === 'tool') {
  for (const state of ['ACTIVE','DONE']) send({event:'step_update',step_update:{conversation_id:id,step_index:4,step_type:'tool',state,tool_info:{name:'run_command',...(state === 'DONE' ? {error:{type:'execution',message:'fixture failure'}} : {})}}});
 }
 if (prompt === 'CANCELED' || prompt === 'INTERRUPTED') {send({event:'result',result:{conversation_id:id,status:prompt,response:''}});return;}
 if (prompt === 'incomplete') return;
 send({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'complete',usage:{input_tokens:12,output_tokens:6,cache_read_tokens:5,thinking_tokens:4,total_tokens:18}}});
 // An unrelated empty-ID error after init must not change the owned result.
 send({event:'result',result:{conversation_id:'',status:'ERROR',error:'FOREIGN AFTER INIT'}});
});
`, { mode: 0o755 });

try {
 const adapter = new AntigravityAdapter(root);
 const agent = {kind:'antigravity',name:'Antigravity',localUuid:'antigravity-adaptation',executablePath:cli};
 const base = {workspacePath:root,prompt:'tool',fullAccess:true,onProgress:()=>{}};
 const configDirectory = path.join(root, '.agents');
 await mkdir(configDirectory);
 const hookFile = path.join(configDirectory, 'hooks.json');
 const originalHooks = JSON.stringify({hooks:{SessionStart:[{command:'echo own-hook'}]}});
 await writeFile(hookFile, originalHooks);
 for (const threadId of [undefined, 'resume-fixture']) {
  const failed = await adapter.executeTurn(agent, {...base,prompt:'startup',threadId});
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'invalid model selection: unknown-fixture');
  assert.equal(failed.threadId, threadId);
  // The signed-out text follows the UI language; text-only callers still classify it in both.
  for (const [language, visible, foreign] of [['en', /authentication required/i, /[一-鿿]/], ['zh-CN', /未登录/, /Authentication/]]) {
   setMainLanguage(language);
   const auth = await adapter.executeTurn(agent, {...base,prompt:'auth',threadId});
   assert.equal(auth.ok, false);
   assert.match(auth.error, visible);
   assert.doesNotMatch(auth.error, foreign);
   assert.equal(classifyReadiness(true, {ok:auth.ok,text:auth.error}).readiness, 'unauthorized');
  }
  setMainLanguage('zh-CN');
  assert.equal(classifyReadiness(true, {ok:failed.ok,text:failed.error}).readiness, 'error');
  const audit = [], progress = [];
  const success = await adapter.executeTurn(agent, {...base,threadId,onAudit:e=>audit.push(e),onProgress:t=>progress.push(t)});
  assert.equal(success.ok, true, JSON.stringify(success));
  assert.equal(success.threadId, threadId || 'parent');
  assert.equal(success.message, 'complete');
  assert.equal(success.metrics.iterations, 1);
  assert.equal(success.metrics.tokenUsage.cachedInputTokens, 5);
  assert.equal(success.metrics.tokenUsage.reasoningOutputTokens, 4);
  assert.deepEqual(progress, ['run_command']);
  assert.deepEqual(audit.map(e=>[e.kind,e.phase,e.failed]), [['run_command','ACTIVE',false],['run_command','DONE',true]]);
 }
 for (const prompt of ['CANCELED', 'INTERRUPTED']) {
  const cancelled = await adapter.executeTurn(agent, {...base,prompt});
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.partialMessage, 'partial');
 }
 const incomplete = await adapter.executeTurn(agent, {...base,prompt:'incomplete'});
 assert.equal(incomplete.ok, false);
 assert.equal(incomplete.partialMessage, 'partial');
 // The connection check carries a stable signedOut flag; readiness and auth status use it, not the text.
 const verified = await adapter.verify(agent);
 assert.equal(verified.ok, false);
 assert.equal(verified.signedOut, true);
 assert.equal(classifyReadiness(true, {...verified, text:'opaque'}).readiness, 'unauthorized');
 const lifecycle = new AgentLifecycleService();
 lifecycle.antigravity = { verify: async () => ({ ok:false, text:'opaque', signedOut:true }) };
 assert.equal((await lifecycle.authStatus(agent)).state, 'signed-out');
 const args = adapter.buildArgs({...base,threadId:'resume-fixture',runtimeConfig:{model:'native-model',reasoningEffort:'high',fastMode:false}});
 assert.deepEqual(args.slice(-6), ['--model','native-model','--effort','high','--conversation','resume-fixture']);
 assert.throws(()=>adapter.buildArgs({...base,runtimeConfig:{fastMode:true}}), /Fast/);
 assert.equal(await readFile(hookFile, 'utf8'), originalHooks);
 await assert.rejects(readFile(path.join(configDirectory, 'mcp_config.json')), {code:'ENOENT'});
 assert.deepEqual(adapter.busyIds(), []);
 console.log('antigravity-adaptation: passed');
} finally {
 setMainLanguage('zh-CN');
 await rm(root, { recursive: true, force: true });
}
