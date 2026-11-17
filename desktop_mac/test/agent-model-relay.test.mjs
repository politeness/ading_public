import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { AgentModelRelay } from "../dist/store/agent-model-relay.js";
import { AgentModels } from "../dist/agents/agent-models.js";
import { AgentModelCache } from "../dist/agents/model-cache.js";
import { CloudPush } from "../dist/store/cloud-push.js";
import { LocalStore } from "../dist/store/local.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "ading-agent-model-relay-"));
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const ME = "u_owner", AGENT = "u_agent";
const LIST = [{ id: "a", label: "Model A", efforts: ["low"], defaultEffort: "low" }, { id: "b", label: "Model B" }];

/** One computer: real LocalStore, AgentModels, and relay; same account, relaying to each other through the server */
async function computer(name, server, { agents = [], users = [], listModels = async () => LIST } = {}) {
  const root = path.join(dir, name);
  const store = new LocalStore(root);
  await store.init();
  const discovered = new Map();
  const changed = [];
  const lists = [];
  const registered = await store.syncDiscoveredAgents(agents);
  for (const user of registered) discovered.set(user.userId, agents.find(agent => agent.localUuid === user.localUuid));
  const remote = new Map(users.map(user => [user.userId, user]));
  const viewed = {
    getUser: async id => remote.get(id) ?? store.getUser(id),
    currentUser: async () => ({ userId: ME }),
    updateAgent: (id, patch) => store.updateAgent(id, patch)
  };
  const models = new AgentModels({
    discovered: id => discovered.get(id),
    registry: { supportsModelList: () => true, listModels: async agent => { lists.push(agent.kind); return listModels(agent); } },
    cache: new AgentModelCache(path.join(root, "agent-model-cache.json")),
    store: () => viewed,
    relay: () => relay,
    changed: () => changed.push(name),
    log: () => undefined
  });
  const relay = new AgentModelRelay({
    send: (type, payload) => server.report(name, type, payload),
    catalog: id => models.localCatalog(id),
    set: (id, modelId) => models.setLocal(id, modelId),
    timeoutMs: 100
  });
  server.computers.set(name, relay);
  return { name, store, models, relay, discovered, remote, changed, lists, agents };
}

/** Fake server: only relays and decides online status; permission checks are covered by AgentModelRelayServiceTest */
function fakeServer(agentComputer) {
  const server = {
    computers: new Map(), offline: new Set(), packets: [], connected: true,
    report(from, type, payload) {
      server.packets.push({ from, type, payload });
      if (!server.connected) return false;
      if (type === "AGENT_MODEL_REQUEST") {
        if (server.offline.has(agentComputer)) {
          setImmediate(() => server.computers.get(from).receive("AGENT_MODEL_RESULT", { requestId: payload.requestId, agentUserId: payload.agentUserId, error: "AGENT_009" }));
          return true;
        }
        const command = { ...payload, requesterTerminalId: from, expiresAt: Date.now() + 1000 };
        setImmediate(() => server.computers.get(agentComputer)?.receive(type, command));
      } else if (type === "AGENT_MODEL_RESULT") {
        const { requesterTerminalId, ...reply } = payload;
        setImmediate(() => server.computers.get(requesterTerminalId)?.receive(type, reply));
      }
      return true;
    }
  };
  return server;
}

const discoveredAgent = { kind: "codex", localUuid: "codex@mac", version: "1", executablePath: "/fixture/codex", runtimeDefaults: { model: "a", reasoningEffort: "xhigh" } };
const remoteUser = (userId, model, extra = {}) => ({ userId, displayName: "小c", isAgent: true, kind: "codex", owner: ME,
  remote: { computerId: "d_mac", computerName: "M1", online: true, readiness: "ready", ...(model ? { model } : {}) }, ...extra });

try {
  const server = fakeServer("mac");
  const mac = await computer("mac", server, { agents: [discoveredAgent] });
  const agentId = [...mac.discovered.keys()][0];
  const m5 = await computer("m5", server, { users: [remoteUser(agentId, {})] });

  // Another online computer views the list: it asks the CLI on the Agent's computer; nothing runs locally
  const listed = await m5.models.catalog(agentId);
  assert.deepEqual(listed.models.map(model => model.id), ["a", "b"]);
  assert.equal(listed.nativeModel, "a");
  assert.equal(listed.selected, undefined);
  assert.deepEqual(mac.lists, ["codex"]);
  assert.deepEqual(m5.lists, []);

  // The setting takes effect on the Agent's computer and isn't stored on the requesting one; effort is mapped via the vendor list, same rules as local settings
  await m5.models.set(agentId, "a");
  const applied = await mac.store.getUser(agentId);
  assert.equal(applied.modelConfig.model, "a");
  assert.equal(applied.modelConfig.source, "ADing");
  assert.equal(applied.modelConfig.reasoningEffort, "low");
  assert.ok(mac.changed.includes("mac"), "re-report after setting so other computers can see it");
  assert.deepEqual(m5.changed, []);

  // Survives rediscovery and restart
  await mac.store.syncDiscoveredAgents([{ ...discoveredAgent, version: "2" }]);
  assert.equal((await mac.store.getUser(agentId)).modelConfig.model, "a");
  const reopened = new LocalStore(path.join(dir, "mac"));
  await reopened.init();
  assert.equal((await reopened.getUser(agentId)).modelConfig.model, "a");

  // The reported current value carries the display name; only the cache is read, the CLI isn't run
  const before = mac.lists.length;
  assert.deepEqual(await mac.models.snapshot(await mac.store.getUser(agentId)), { selected: "a", selectedLabel: "Model A", nativeModel: "Model A" });
  assert.equal(mac.lists.length, before);

  // Revert to following; the requester's reads change accordingly
  await m5.models.set(agentId, null);
  assert.equal((await mac.store.getUser(agentId)).modelConfig, undefined);
  assert.equal((await m5.models.catalog(agentId)).selected, undefined);
  assert.deepEqual(await mac.models.snapshot(await mac.store.getUser(agentId)), { nativeModel: "Model A" });

  // The Agent's computer just restarted: setting works without a list in memory; choosing a model outside the list is rejected and the reason goes back to the requester
  const restarted = await computer("mac", server, { agents: [discoveredAgent] });
  await m5.models.set(agentId, "b");
  assert.equal((await restarted.store.getUser(agentId)).modelConfig.model, "b");
  await assert.rejects(m5.models.set(agentId, "nope"), /nope/);
  assert.equal((await restarted.store.getUser(agentId)).modelConfig.model, "b");

  // That computer is offline: show the current value, send no request, setting not allowed
  m5.remote.set(agentId, { ...remoteUser(agentId, { selected: "b", selectedLabel: "Model B", nativeModel: "Model A" }), remote: { ...remoteUser(agentId, {}).remote, online: false, model: { selected: "b", selectedLabel: "Model B", nativeModel: "Model A" } } });
  server.packets.length = 0;
  assert.deepEqual(await m5.models.catalog(agentId), { supported: true, models: [], readOnly: true, selected: "b", nativeModel: "Model A", selectedLabel: "Model B" });
  await assert.rejects(m5.models.set(agentId, "a"), /不在线/);
  assert.equal(server.packets.length, 0);

  // Locally still considered online but the server says offline: reuse the error display; the current value stays
  m5.remote.set(agentId, remoteUser(agentId, { selected: "b", selectedLabel: "Model B" }));
  server.offline.add("mac");
  const failed = await m5.models.catalog(agentId);
  assert.equal(failed.supported, true);
  assert.deepEqual(failed.models, []);
  assert.equal(failed.selected, "b");
  assert.equal(failed.selectedLabel, "Model B");
  assert.match(failed.error, /不在线/);
  server.offline.clear();

  // List can't be read: the error comes from that computer, and the requester reuses the existing error display
  const brokenServer = fakeServer("broken");
  const broken = await computer("broken", brokenServer, { agents: [{ ...discoveredAgent, localUuid: "codex@broken" }], listModels: async () => { throw new Error("未登录"); } });
  const brokenId = [...broken.discovered.keys()][0];
  const asking = await computer("asking", brokenServer, { users: [remoteUser(brokenId, {})] });
  const brokenCatalog = await asking.models.catalog(brokenId);
  assert.equal(brokenCatalog.supported, true);
  assert.deepEqual(brokenCatalog.models, []);
  assert.equal(brokenCatalog.error, "未登录");

  // Agents on old clients (no model state) and borrowed ones: no entry and no requests
  m5.remote.set("u_old", remoteUser("u_old", undefined));
  m5.remote.set("u_borrowed", remoteUser("u_borrowed", {}, { owner: "u_friend" }));
  server.packets.length = 0;
  for (const id of ["u_old", "u_borrowed"]) {
    assert.deepEqual(await m5.models.catalog(id), { supported: false, models: [] });
    await assert.rejects(m5.models.set(id, "a"), /不在这台电脑/);
  }
  assert.equal(server.packets.length, 0);

  // The relay itself: timeouts, disconnects, and send failures all fail explicitly; replies meant for others don't count
  const lonely = new AgentModelRelay({ send: () => true, catalog: async () => ({}), set: async () => undefined, timeoutMs: 20 });
  await assert.rejects(lonely.request(AGENT, { action: "catalog" }), /没有响应/);
  const packets = [];
  const asker = new AgentModelRelay({ send: (type, payload) => { packets.push(payload); return true; }, catalog: async () => ({}), set: async () => undefined, timeoutMs: 200 });
  const pending = asker.request(AGENT, { action: "set", modelId: "a" });
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  asker.receive("AGENT_MODEL_RESULT", { requestId: packets[0].requestId, agentUserId: "u_other", ok: true });
  await tick();
  assert.equal(settled, false, "another Agent's reply can't complete this request");
  asker.disconnect();
  await assert.rejects(pending, /连接已断开/);
  const unsent = new AgentModelRelay({ send: () => false, catalog: async () => ({}), set: async () => undefined });
  await assert.rejects(unsent.request(AGENT, { action: "catalog" }), /连接已断开/);
  const closed = new AgentModelRelay({ send: () => true, catalog: async () => ({}), set: async () => undefined });
  closed.close();
  await assert.rejects(closed.request(AGENT, { action: "catalog" }), /连接已断开/);
  for (const [error, text] of [["AGENT_009", /不在线/], ["NODE_006", /无法确认/], ["AGENT_002", /无法从这台电脑/]]) {
    packets.length = 0;
    const rejected = asker.request(AGENT, { action: "catalog" });
    asker.receive("AGENT_MODEL_RESULT", { requestId: packets[0].requestId, agentUserId: AGENT, error });
    await assert.rejects(rejected, text);
  }

  // Executing side: duplicate deliveries run once; expired ones and those without a requester don't run
  const calls = [], replies = [];
  const worker = new AgentModelRelay({ send: (type, payload) => { replies.push(payload); return true; }, catalog: async () => ({ supported: false, models: [] }), set: async (id, modelId) => { calls.push([id, modelId]); } });
  const command = { requestId: "r1", agentUserId: AGENT, action: "set", modelId: "a", requesterTerminalId: "d_m5", expiresAt: Date.now() + 1000 };
  worker.receive("AGENT_MODEL_REQUEST", command);
  worker.receive("AGENT_MODEL_REQUEST", command);
  worker.receive("AGENT_MODEL_REQUEST", { ...command, requestId: "r2", expiresAt: Date.now() - 1 });
  worker.receive("AGENT_MODEL_REQUEST", { ...command, requestId: "r3", requesterTerminalId: undefined });
  await tick();
  assert.deepEqual(calls, [[AGENT, "a"]]);
  assert.deepEqual(replies, [{ requestId: "r1", agentUserId: AGENT, requesterTerminalId: "d_m5", ok: true }]);

  // The push channel hands both frame types to the relay, not to the normal frame log
  const pushed = [], logged = [];
  const push = new CloudPush({ credentials: async () => ({ enabled: false }), onConversationChanged: () => undefined, onConnected: () => undefined, onAgentModelRelay: (type, payload) => pushed.push([type, payload.requestId]), log: (event) => logged.push(event) });
  push.handle(JSON.stringify({ type: "AGENT_MODEL_REQUEST", payload: { requestId: "x" } }));
  push.handle(JSON.stringify({ type: "AGENT_MODEL_RESULT", payload: { requestId: "y" } }));
  assert.deepEqual(pushed, [["AGENT_MODEL_REQUEST", "x"], ["AGENT_MODEL_RESULT", "y"]]);
  assert.deepEqual(logged, []);
  console.log("agent-model relay tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
