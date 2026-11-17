import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStore } from "../dist/store/local.js";
import { ConversationScheduler } from "../dist/orchestration/conversation-scheduler.js";
import { ExecutionAgent } from "../dist/agents/execution-agent.js";

const root = await mkdtemp(path.join(os.tmpdir(), "ading-verification-queue-"));
const store = new LocalStore(root);
const logs = [], calls = [], attempts = [], schedulers = [];
let state = "checking", interruptNext = false, restoreBeforeResult = false;
class Agent extends ExecutionAgent {
  async readNativeConfiguration() {
    if (interruptNext) { interruptNext = false; state = "checking"; }
    return { model: "fixture", source: "native" };
  }
  async executeTurn(_agent, input) {
    calls.push(input.prompt);
    return { ok: true, message: "已处理", threadId: "fixture-thread", steps: [], metrics: { iterations: 1, sideEffects: false } };
  }
}
const adapter = new Agent();
async function eventually(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for the scheduler: ${JSON.stringify(logs.slice(-12))}`);
}
try {
  await store.init();
  const discovered = { kind: "codex", localUuid: "fixture", executablePath: "/mock", version: "test" };
  const [agent] = await store.syncDiscoveredAgents([discovered]);
  const me = await store.currentUser();
  const scheduler = new ConversationScheduler({
    store, idleRetryLimit: 0, teamMonitorIntervalMs: 0,
    syncer: { ensureSynced: async () => [] },
    resolveWorkspace: async () => ({ workspacePath: root, sharesKnowledge: false }),
    resolveDiscovered: id => id === agent.userId ? discovered : undefined,
    isAgentReady: () => state === "ready",
    isAgentPending: () => state === "checking",
    requestPermission: async () => false,
    broadcast: () => {}, log: async (event, data) => { logs.push({ event, ...data }); },
    registry: {
      adapterFor: () => adapter, cancel: () => true,
      runTurn: async (found, input) => {
        attempts.push(input.prompt);
        const result = await adapter.runTurn(found, input);
        if (restoreBeforeResult && !result.ok) {
          restoreBeforeResult = false;
          state = "ready";
          // The verification callback can finish before the scheduler records deferral.
          await scheduler.resumeReadyAgents();
        }
        return result;
      }
    }
  });
  schedulers.push(scheduler);
  const create = name => store.createConversation({ name, memberIds: [agent.userId], leaderId: agent.userId });
  const deliver = async (conversation, content) => {
    const message = await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: crypto.randomUUID(), senderId: me.userId, content });
    await scheduler.receiveRemoteUserMessage(message);
    return message;
  };
  const messages = conversation => store.listMessages(conversation.conversationId);
  const processed = async conversation => (await store.getConversation(conversation.conversationId)).members.find(member => member.userId === agent.userId).lastProcessedSeq ?? 0;
  const done = conversation => eventually(async () => (await messages(conversation)).some(message => message.senderId === agent.userId && message.content === "已处理"));

  const first = await create("first offline conversation"), second = await create("second offline conversation");
  await deliver(first, "offline one");
  const last = await deliver(first, "offline two");
  await deliver(second, "other offline conversation");
  assert.equal(calls.length, 0, "offline messages wait while verification is pending");
  assert.equal(await processed(first), 0, "waiting preserves the processed watermark");
  state = "ready";
  await scheduler.resumeReadyAgents();
  await done(first); await done(second);
  await eventually(async () => await processed(first) === last.seq);
  assert.equal(calls.length, 2, "each conversation resumes once after verification");
  assert.ok(calls.some(prompt => prompt.includes("offline one") && prompt.includes("offline two")), "the full offline batch reaches the Agent");
  await scheduler.resumeReadyAgents();
  assert.equal(calls.length, 2, "repeated verification callbacks do not duplicate completed messages");

  const race = await create("verification starts during model configuration");
  interruptNext = true;
  const before = calls.length;
  await deliver(race, "keep this message for after the check");
  await eventually(() => logs.some(log => log.event === "agent-turn-deferred" && log.conversation === race.conversationId && log.where === "execution"));
  assert.equal(calls.length, before, "the model was never called while verification was active");
  assert.equal(await processed(race), 0, "a deferred execution does not consume the message");
  assert.equal((await messages(race)).filter(message => message.failed).length, 0, "temporary verification does not create a failed reply");
  state = "ready";
  await scheduler.resumeReadyAgents();
  await done(race);
  assert.equal(calls.length, before + 1, "the deferred message executes exactly once when ready");

  const fast = await create("verification finishes before deferral is recorded");
  interruptNext = true; restoreBeforeResult = true;
  const fastBefore = calls.length;
  await deliver(fast, "recover even if the callback already happened");
  await done(fast);
  assert.equal(calls.length, fastBefore + 1, "a completed verification callback cannot strand the message");
  assert.equal((await messages(fast)).filter(message => message.failed).length, 0);

  const failedCheck = await create("unavailable verification consumes the offline batch");
  state = "checking";
  await deliver(failedCheck, "consume offline one if the check fails");
  const consumed = await deliver(failedCheck, "consume offline two if the check fails");
  const unqueued = await store.appendMessage({ conversationId: failedCheck.conversationId, clientMessageId: crypto.randomUUID(), senderId: me.userId, content: "a later message outside the pending batch" });
  const failedBefore = attempts.length;
  state = "unavailable";
  await scheduler.pauseUnavailableAgents("codex");
  await scheduler.resumeReadyAgents();
  assert.equal(attempts.length, failedBefore, "unavailable verification never invokes the provider");
  assert.equal(await processed(failedCheck), consumed.seq, "only the captured offline batch is consumed");
  assert.ok(await processed(failedCheck) < unqueued.seq, "later messages are not accidentally consumed");
  state = "ready";
  await scheduler.resumeReadyAgents();
  assert.equal(attempts.length, failedBefore, "restoring availability does not replay consumed offline messages");

  const stopped = await create("paused while awaiting verification");
  state = "checking";
  await deliver(stopped, "do not start after pause");
  await scheduler.stopConversation(stopped.conversationId);
  state = "ready";
  const stoppedBefore = calls.length;
  await scheduler.resumeReadyAgents();
  assert.equal(calls.length, stoppedBefore, "verification completion respects the user's stop");

  const unavailable = await create("genuine unavailability");
  state = "unavailable";
  const unavailableBefore = attempts.length;
  await deliver(unavailable, "no provider call without a usable Agent");
  await scheduler.resumeReadyAgents();
  assert.equal(attempts.length, unavailableBefore, "genuine unavailability is not blindly retried");
  assert.equal(await processed(unavailable), 1, "messages received with a completed unavailable status are consumed");
  state = "ready";
  await scheduler.resumeReadyAgents();
  assert.equal(attempts.length, unavailableBefore, "availability restoration alone does not replay the consumed message");
  await deliver(unavailable, "a new message after availability recovers");
  await done(unavailable);
  assert.equal(attempts.length, unavailableBefore + 1, "new messages can still trigger a recovered Agent");
  console.log("agent-verification-queue: passed offline batches, execution race, callback race, stop and unavailability");
} finally {
  for (const scheduler of schedulers) await scheduler.shutdown();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
