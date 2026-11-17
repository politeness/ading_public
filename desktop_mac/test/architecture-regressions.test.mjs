import { mkdtemp } from "./tmp.mjs";
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { LocalStore } from '../dist/store/local.js';
import { LocalScheduler } from '../dist/orchestration/local-scheduler.js';
import { SkillCapture } from '../dist/skills/capture.js';

const root = await mkdtemp('/tmp/ading-architecture-tests-');
let passed = 0;
function check(condition) { assert.ok(condition); passed++; }
const gate = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
async function fixture(label) {
  const directory = await mkdtemp(`${root}/${label}-`);
  const store = new LocalStore(directory);
  await store.init();
  const me = await store.currentUser();
  const [agent] = await store.syncDiscoveredAgents([{
    kind: 'codex', localUuid: 'review-agent', name: 'Review Agent', version: 'test',
    executablePath: '/unused', nodeName: 'review'
  }]);
  const conversation = await store.createConversation({ name: label, memberIds: [agent.userId] });
  return { directory, store, me, agent, conversation };
}
function runtime(f, runTurn, ensureSynced = async () => []) {
  let cancelCalls = 0;
  const scheduler = new LocalScheduler({idleRetryLimit:0,
    store: f.store,
    registry: { runTurn, cancel: () => { cancelCalls++; return false; } },
    syncer: { ensureSynced },
    resolveWorkspace: async () => ({ workspacePath: root, sharesKnowledge: false }),
    resolveDiscovered: () => ({ kind: 'codex', localUuid: 'review-agent' }),
    isAgentReady: () => true,
    broadcast: () => {}, log: async () => {}
  });
  return { scheduler, cancelCalls: () => cancelCalls };
}
const outcome = (message = '收到') => ({ ok: true, message, steps: [], metrics: { iterations: 1, sideEffects: false } });
const send = (f, id, content) => f.store.appendMessage({ conversationId: f.conversation.conversationId, senderId: f.me.userId, clientMessageId: id, content });

{
  const f = await fixture('skill-scope');
  const [reviewer] = await f.store.syncDiscoveredAgents([{ kind: 'qoder', localUuid: 'reviewer', name: 'Reviewer', version: 'test', executablePath: '/unused', nodeName: 'review' }]);
  const a = await f.store.createWorkspace({ name: '项目 A', path: `${f.directory}/a` });
  const b = await f.store.createWorkspace({ name: '项目 B', path: `${f.directory}/b` });
  const oldSkill = await f.store.createSkill({ name: '构建规则', description: '项目 A 的规则', scope: 'workspace', ownerId: a.workspaceId, content: '只适用于 A', authorKind: 'agent', authorUserId: f.agent.userId });
  const conversation = await f.store.createConversation({ name: '在 B 中沉淀技能', memberIds: [f.agent.userId, reviewer.userId], workspaceId: b.workspaceId });
  const capture = new SkillCapture(f.store, {}, { invalidate() {}, ensureSynced: async () => [] }, {
    runInConversation: async (_conversation, agent) => outcome(agent.userId === f.agent.userId ? JSON.stringify({ skill: { name: '构建规则', description: '项目 B 的规则', content: '只适用于 B' }, facts: [] }) : JSON.stringify({ problems: [] })),
    post: async () => {}, resolveDiscovered: () => ({ kind: 'qoder', localUuid: 'reviewer' })
  });
  await capture.afterTurn({ conversation, agent: f.agent, resolution: { workspacePath: `${f.directory}/b`, sharesKnowledge: true, knowledgeOwnerId: b.workspaceId }, evidenceFromSeq: 1, evidenceToSeq: 1, steps: [], metrics: { iterations: 10, sideEffects: true } });
  const result = await f.store.getSkill(oldSkill.skillId);
  check(result.ownerId === a.workspaceId && result.content === '只适用于 A');
  await f.store.close();
}

{
  const f = await fixture('concurrent');
  await f.store.listMessages(f.conversation.conversationId);
  const results = await Promise.allSettled([send(f, 'same-id', '同一请求'), send(f, 'same-id', '同一请求')]);
  const disk = (await readFile(`${f.directory}/messages/${f.conversation.conversationId}.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
  check(results.every(r => r.status === 'fulfilled') && disk.length === 1);
  await f.store.close();
}
{
  const f = await fixture('unread');
  await send(f, 'first', '第一条');
  const entered = gate(), release = gate();
  const prompts = [];
  const { scheduler } = runtime(f, async (_a, input) => { prompts.push(input.prompt); entered.resolve(); await release.promise; return outcome(); });
  const running = scheduler.runAgentTurn(f.conversation, f.agent);
  await entered.promise;
  const second = await send(f, 'second', '忙时新增的指令');
  await scheduler.dispatch(f.conversation, second);
  release.resolve();
  await running;
  for(let i=0;i<100 && scheduler.runtimeSnapshot().agents.length;i++)await new Promise(r=>setTimeout(r,5));
  check(prompts.length >= 2 && prompts.slice(1).every(p=>p.includes('忙时新增的指令')));
  check(f.conversation.members.find(m => m.userId === f.agent.userId).lastReadSeq === 0);
  await f.store.close();
}
{
  const f = await fixture('pause-before-spawn');
  await send(f, 'first', '开始');
  const entered = gate(), release = gate();
  const launches = [];
  const { scheduler, cancelCalls } = runtime(f, async () => { launches.push({ paused: f.conversation.paused }); return outcome('SKIP'); }, async () => { entered.resolve(); await release.promise; return []; });
  const running = scheduler.runAgentTurn(f.conversation, f.agent);
  await entered.promise;
  const stopped = await scheduler.stopConversation(f.conversation.conversationId);
  release.resolve();
  await running;
  check(launches.length === 0);
  await f.store.close();
}
{
  const f = await fixture('paused-auxiliary');
  await f.store.setConversationPaused(f.conversation.conversationId, true);
  let launches = 0;
  const { scheduler } = runtime(f, async () => { launches++; return outcome(); });
  await scheduler.speakInConversation(f.conversation, f.agent, '自动技能复核');
  check(launches === 0);
  await f.store.close();
}

{
  const f = await fixture('journal-delimiter');
  await send(f, 'first', '完整记录');
  await f.store.close();
  const file = `${f.directory}/messages/${f.conversation.conversationId}.jsonl`;
  await writeFile(file, (await readFile(file, 'utf8')).trimEnd());
  const recovered = new LocalStore(f.directory);
  await recovered.init();
  await recovered.appendMessage({ conversationId: f.conversation.conversationId, senderId: f.me.userId, clientMessageId: 'after-restart', content: '重启后新增' });
  check((await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse).length === 2);
  await recovered.close();
}
{
  const f = await fixture('pause-resume-stale-turn');
  await send(f, 'first', '开始');
  const entered = gate(), release = gate();
  let launches = 0;
  const { scheduler } = runtime(f, async () => { launches++; return outcome('不该发布'); }, async () => { entered.resolve(); await release.promise; return []; });
  const running = scheduler.runAgentTurn(f.conversation, f.agent);
  await entered.promise;
  await scheduler.stopConversation(f.conversation.conversationId);
  await f.store.setConversationPaused(f.conversation.conversationId, false);
  release.resolve(); await running;
  check(launches === 0);
  await f.store.close();
}
{
  const f = await fixture('busy-through-message-write');
  await send(f, 'first', '开始');
  const entered=gate(), release=gate();
  const append=f.store.appendMessage.bind(f.store);
  f.store.appendMessage=async input => {
    if(input.senderId===f.agent.userId) { entered.resolve(); await release.promise; }
    return append(input);
  };
  const { scheduler }=runtime(f, async (_agent,input) => { input.onProgress('正在整理结果'); return outcome('最终结果'); });
  const running=scheduler.runAgentTurn(f.conversation,f.agent);
  await entered.promise;
  check(scheduler.runtimeSnapshot().agents.some(a=>a.agentUserId===f.agent.userId && a.busy));
  release.resolve(); await running;
  check(!scheduler.runtimeSnapshot().agents.some(a=>a.agentUserId===f.agent.userId));
  check((await f.store.listMessages(f.conversation.conversationId)).some(m=>m.content==='最终结果'));
  await f.store.close();
}
{
  const f = await fixture('send-resumes-only-current-conversation');
  const other = await f.store.createConversation({name:'其他任务',memberIds:[f.agent.userId]});
  const unread = await send(f, 'old', '之前未处理的消息');
  await f.store.pauseAllConversations();
  const prompts = [], turns = [];
  const { scheduler } = runtime(f, async (_agent, input) => { prompts.push(input.prompt); return outcome('收到新指令'); });
  const run = scheduler.runAgentTurn.bind(scheduler);
  scheduler.runAgentTurn = (...args) => { const promise = run(...args); turns.push(promise); return promise; };
  await scheduler.dispatch(await f.store.getConversation(f.conversation.conversationId), unread);
  check(turns.length === 0);
  await scheduler.sendUserMessage({conversationId:f.conversation.conversationId,clientMessageId:'new',content:'现在继续讨论'});
  await Promise.all(turns);
  check((await f.store.getConversation(f.conversation.conversationId)).paused === false);
  check((await f.store.getConversation(other.conversationId)).paused === true);
  check(prompts.length === 1 && prompts[0].includes('之前未处理的消息') && prompts[0].includes('现在继续讨论'));
  check((await f.store.listMessages(f.conversation.conversationId)).some(m => m.content === '收到新指令'));

  await scheduler.stopConversation(f.conversation.conversationId);
  await f.store.setMemberPaused(f.conversation.conversationId, f.agent.userId, true);
  await scheduler.sendUserMessage({conversationId:f.conversation.conversationId,clientMessageId:'member-paused',content:'不要恢复单独暂停的成员'});
  check((await f.store.getConversation(f.conversation.conversationId)).members.find(m => m.userId === f.agent.userId).paused === true && turns.length === 1);

  await scheduler.stopConversation(f.conversation.conversationId);
  f.store.appendMessage = async () => { throw new Error('写入失败'); };
  await assert.rejects(scheduler.sendUserMessage({conversationId:f.conversation.conversationId,clientMessageId:'failed',content:'不能唤醒'}), /写入失败/);
  check(!scheduler.engagedConversations.has(f.conversation.conversationId) && turns.length === 1);
  await f.store.close();
}
{
  const f = await fixture('remove-running-member');
  const [otherAgent] = await f.store.syncDiscoveredAgents([{kind:'qoder',localUuid:'other-agent',name:'Other',version:'test',executablePath:'/unused',nodeName:'review'}]);
  f.conversation = await f.store.createConversation({name:'成员移除',memberIds:[f.agent.userId,otherAgent.userId]});
  await send(f,'begin','开始');
  const entered=gate(), release=gate();
  const {scheduler,cancelCalls}=runtime(f,async()=>{entered.resolve();await release.promise;return outcome('移除后不应发布');});
  const running=scheduler.runAgentTurn(f.conversation,f.agent);
  await entered.promise;
  await assert.rejects(scheduler.removeMember(f.conversation.conversationId,f.me.userId));
  check(cancelCalls()===0);
  const next=await scheduler.removeMember(f.conversation.conversationId,f.agent.userId);
  check(!next.members.some(m=>m.userId===f.agent.userId) && cancelCalls()===1);
  check(next.members.filter(m=>m.role==='LEADER').length===1);
  release.resolve();await running;
  check(!(await f.store.listMessages(f.conversation.conversationId)).some(m=>m.content==='移除后不应发布'));
  await f.store.close();
}
{
  // When switching data sessions, conversation-related IPC must wait for the new data to be ready; this was missed once during the Task→Conversation rename
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const dataChannel = new RegExp(source.match(/const dataChannel = \/(.+)\/;/)[1]);
  const channels = [...source.matchAll(/handle\("((?:conversations|messages):[^"]+)"/g)].map(m => m[1]);
  check(channels.some(channel => channel.startsWith('conversations:')));
  for (const channel of channels) check(dataChannel.test(channel));
  // Blocking navigation must not also block the page's own reload: switching language and switching account data both rely on location.reload()
  const navigation = source.match(/on\("will-navigate",(.+)\);/)[1];
  check(/url !== window\.webContents\.getURL\(\)/.test(navigation) && /preventDefault/.test(navigation));
}
console.log(`architecture-regressions: ${passed} passed`);
