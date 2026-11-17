import {requireConversationWriter, requireConversationController} from "../dist/permissions/conversation-write.js";
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStore} from '../dist/store/local.js';
import {ConversationScheduler} from '../dist/orchestration/conversation-scheduler.js';
import {MessageDelivery, shouldDispatchRemoteUserMessage} from '../dist/orchestration/message-delivery.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'ading-shared-agent-message-'));
const store = new LocalStore(dir);
let scheduler, delivery;
try {
  await store.init();
  const me = await store.currentUser();
  const recipient = {userId: 'share-recipient', displayName: 'Share recipient', isAgent: false, friend: true};
  await store.syncPeople([recipient]);
  const [agent] = await store.syncDiscoveredAgents([{kind: 'qwen-code', localUuid: 'shared-qwen'}]);
  await store.updateContact(agent.userId, {sharedWith: [recipient.userId]});
  const seed = await store.createConversation({name: 'Shared Agent', memberIds: [agent.userId]});
  // Execution terminals import the recipient's conversation without adding the Agent's owner as a human member.
  const conversation = await store.importConversation({...seed, conversationId: 'shared-recipient-conversation', owner: recipient.userId, creator: recipient.userId,
    members: [{userId: recipient.userId, role: 'ENGINEER', lastReadSeq: 0}, {userId: agent.userId, role: 'LEADER', lastReadSeq: 0}]});
  assert.ok(!conversation.members.some(m => m.userId === me.userId));
  await assert.rejects(requireConversationWriter(store, conversation.conversationId), /成员|member/, 'the owner cannot interfere through human IPC');
  await requireConversationWriter(store, seed.conversationId);
  await requireConversationController(store, conversation.conversationId);
  await assert.rejects(requireConversationController({...store, getConversation: async () => conversation, currentUser: async () => ({userId:'stranger'}), getUser: id => store.getUser(id)}, conversation.conversationId), /成员|member/);

  const prompts = [];
  let blockNext = false;
  let cancelled = false;
  scheduler = new ConversationScheduler({idleRetryLimit: 0, teamMonitorIntervalMs: 0, store,
    registry: {runTurn: async (_d, input) => {prompts.push(input.prompt); if (blockNext) { await new Promise(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', resolve, {once:true}); }); cancelled = true; return {ok:false,message:'cancelled',steps:[],metrics:{iterations:0,sideEffects:false}}; } return {ok: true, threadId: 'shared-thread', message: 'Hello from shared Qwen', steps: [], metrics: {iterations: 0, sideEffects: false}};}, cancel: () => true},
    syncer: {ensureSynced: async () => []}, resolveWorkspace: async () => ({workspacePath: dir, sharesKnowledge: false}),
    resolveDiscovered: () => ({kind: 'qwen-code', localUuid: 'shared-qwen'}), isAgentReady: () => true,
    broadcast: () => {}, log: async () => {}});
  delivery = new MessageDelivery({deliver: message => scheduler.receiveRemoteUserMessage(message), stillOwed: async () => true, log: () => {}});
  const incoming = await store.appendMessage({conversationId: conversation.conversationId, clientMessageId: 'recipient-hello', senderId: recipient.userId, content: 'hello from the person using the shared Agent'});
  assert.equal(shouldDispatchRemoteUserMessage(incoming, await store.getUser(incoming.senderId)), true, 'the recipient is accepted even though they are not this computer\'s owner');
  const receive = async message => {
    if (!shouldDispatchRemoteUserMessage(message, await store.getUser(message.senderId))) return false;
    await store.oweMessage(message.conversationId, message.messageId);
    await delivery.deliver(message);
    return true;
  };
  await receive(incoming);
  const until = async predicate => {for (let i = 0; i < 400 && !(await predicate()); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(await predicate());};
  await until(async () => (await store.getConversation(conversation.conversationId)).members.find(m => m.userId === agent.userId).lastProcessedSeq >= incoming.seq);
  const reply = (await store.listMessages(conversation.conversationId)).find(m => m.senderId === agent.userId);
  assert.equal(reply.content, 'Hello from shared Qwen');
  assert.ok(prompts[0].includes(incoming.content));
  assert.equal(await receive(reply), false, 'Agent USER replies are not delivered as human input');
  assert.equal(await receive({...incoming, internal: true}), false, 'internal messages are not delivered');
  assert.equal(await receive({...incoming, type: 'SYSTEM'}), false, 'system messages are not delivered');
  assert.equal(await receive({...incoming, senderId: 'unknown-person'}), false, 'an unknown sender is not classified as a person');
  assert.equal(shouldDispatchRemoteUserMessage({...incoming, senderId: me.userId}, me), true, 'the owner\'s phone messages still work');
  await receive(incoming);
  await scheduler.redeliverUserMessage(incoming);
  assert.equal(prompts.length, 1, 'duplicate delivery and restart recovery do not re-execute the message');
  assert.equal((await store.listOwedMessages()).length, 0);
  blockNext = true;
  const runningMessage = await store.appendMessage({conversationId: conversation.conversationId, clientMessageId:'pause-work', senderId:recipient.userId, content:'work until owner pauses'});
  await receive(runningMessage);
  await until(() => prompts.length === 2);
  let current = await store.getConversation(conversation.conversationId);
  await store.syncConversationMembers(conversation.conversationId, current.members.map(member => ({...member, ownerPaused:member.userId===agent.userId})));
  await scheduler.syncOwnerPauses(conversation.conversationId);
  await until(() => cancelled && !scheduler.runtimeSnapshot().agents.some(a => a.busy));
  const later = await store.appendMessage({conversationId:conversation.conversationId, clientMessageId:'while-paused', senderId:recipient.userId, content:'must wait for owner'});
  await receive(later);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(prompts.length, 2, 'owner-pause prevents new execution while cached messages arrive');
  blockNext = false;
  current = await store.getConversation(conversation.conversationId);
  await store.syncConversationMembers(conversation.conversationId, current.members.map(member => ({...member, ownerPaused:false})));
  await scheduler.syncOwnerPauses(conversation.conversationId);
  await until(() => prompts.length > 2);
  console.log('shared-agent-message: recipient input runs shared Qwen without the owner in the conversation, replies do not loop, duplicate delivery does not rerun');
} finally {
  delivery?.stop();
  await scheduler?.shutdown();
  await store.close();
  await rm(dir, {recursive: true, force: true});
}
