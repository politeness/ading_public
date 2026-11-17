import assert from "node:assert/strict";
import { mkdtemp } from "./tmp.mjs";
import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { LocalStore } from "../dist/store/local.js";
import { CloudStore } from "../dist/store/cloud.js";

// Newly adapted Agents changed their default names: those still on the old default (not changed by the user) switch to the new default on registration, changed ones stay, and the cloud follows

let passed = 0;
const host = "mac";
const discovered = [
  { localUuid: `qwen-code@${host}`, kind: "qwen-code", name: "Qwen Code", version: "1" },
  { localUuid: `copilot@${host}`, kind: "copilot", name: "Copilot", version: "1" },
  { localUuid: `antigravity@${host}`, kind: "antigravity", name: "Antigravity", version: "1" },
  { localUuid: `kiro@${host}`, kind: "kiro", name: "Kiro", version: "1" }
];
const tempRoot = () => mkdtemp(path.join(os.tmpdir(), "ading-agent-name-"));

/** Write an agents.json left by an old version: qwen-code / copilot / antigravity still have old default names, kiro was renamed by the user */
async function seedLegacy(root, idOf) {
  const agents = Object.fromEntries(discovered.map((agent) => [agent.localUuid, {
    userId: idOf(agent),
    username: agent.kind,
    displayName: { "qwen-code": "小千", copilot: "小航", antigravity: "我的小引", kiro: "小k" }[agent.kind],
    isAgent: true,
    kind: agent.kind,
    version: "0",
    owner: "u_me",
    localUuid: agent.localUuid,
    enabled: true
  }]));
  await writeFile(path.join(root, "agents.json"), JSON.stringify(agents), "utf8");
}
const namesOf = (agents) => Object.fromEntries(agents.map((agent) => [agent.kind, agent.displayName]));

// Standalone: old default names become new defaults; renamed ones and those without a name change stay; registering again changes nothing (idempotent)
{
  const root = await tempRoot();
  const store = new LocalStore(root);
  await store.init();
  await seedLegacy(root, (agent) => `u_${agent.kind}`);
  await store.close?.();
  const reopened = new LocalStore(root);
  await reopened.init();
  const first = namesOf(await reopened.syncDiscoveredAgents(discovered));
  assert.deepEqual(first, { "qwen-code": "小qw", copilot: "小cp", antigravity: "我的小引", kiro: "小k" });
  const saved = JSON.parse(await readFile(path.join(root, "agents.json"), "utf8"));
  assert.equal(saved[`qwen-code@${host}`].displayName, "小qw", "rename written to the local store");
  assert.deepEqual(namesOf(await reopened.syncDiscoveredAgents(discovered)), first, "registering again gives the same result");
  // Once the user renames to anything other than the new default, it's never changed again
  await reopened.updateContact("u_copilot", { displayName: "Copilot 助手" });
  assert.equal(namesOf(await reopened.syncDiscoveredAgents(discovered)).copilot, "Copilot 助手");
  await reopened.close?.();
  passed++;
}

/** Fake cloud: handles only agent profiles and friends, recording what was PUT */
function fakeCloud(initial) {
  const state = { agents: new Map(initial.map((agent) => [agent.userId, agent])), friends: new Set(initial.map((agent) => agent.userId)), puts: [] };
  const ok = (data) => ({ ok: true, data });
  const api = async (method, route, body) => {
    const p = new URL(route, "http://cloud.test").pathname.replace("/api/v1", "");
    let m;
    if (p === "/agents" && method === "GET") return ok([...state.agents.values()]);
    if (p === "/friends" && method === "GET") return ok([...state.friends].map((userId) => ({ userId })));
    if ((m = p.match(/^\/agents\/([^/]+)$/)) && method === "PUT") {
      state.puts.push({ userId: m[1], ...body });
      state.agents.set(m[1], { ...state.agents.get(m[1]), ...body });
      return ok(state.agents.get(m[1]));
    }
    if ((m = p.match(/^\/friends\/([^/]+)$/))) return ok(null);
    return ok([]);
  };
  return { state, api };
}
const cloudAgent = (agent, displayName) => ({
  userId: `u_${agent.kind}`, displayName, isAgent: true, agentType: agent.kind.toUpperCase().replace("-", "_"), computerId: "d_here"
});
const openCloud = (cloud, root) => {
  const store = new CloudStore({
    root,
    user: { userId: "u_me", username: "me", displayName: "我" },
    api: cloud.api,
    agentUserId: async (agent) => `u_${agent.kind}`,
    localComputerId: () => "d_here",
    retryMs: 60_000
  });
  return store.init().then(() => store);
};

// Online, already registered on this computer: the local rename is uploaded to the cloud, and later cloud pulls don't overwrite it with the old name
{
  const root = await tempRoot();
  const cloud = fakeCloud([cloudAgent(discovered[0], "小千"), cloudAgent(discovered[1], "小航"), cloudAgent(discovered[3], "小k")]);
  const store = await openCloud(cloud, root);
  await seedLegacy(root, (agent) => `u_${agent.kind}`);
  await store.close();
  const reopened = await openCloud(cloud, root);
  await reopened.refreshAgents();
  assert.equal(namesOf(await reopened.syncDiscoveredAgents(discovered))["qwen-code"], "小qw");
  await reopened.sync();
  assert.equal(cloud.state.agents.get("u_qwen-code").displayName, "小qw", "cloud follows the change");
  assert.equal(cloud.state.agents.get("u_copilot").displayName, "小cp");
  assert.ok(!cloud.state.puts.some((put) => put.userId === "u_kiro"), "unmigrated ones aren't uploaded");
  await reopened.refreshAgents();
  assert.equal(namesOf(await reopened.listKnownAgents())["qwen-code"], "小qw", "still the new name after pulling from the cloud");
  await reopened.close();
  passed++;
}

// Online, first registration on this computer (cache deleted): the cloud still has the old default, which is also replaced with the new default and uploaded
{
  const root = await tempRoot();
  const cloud = fakeCloud([cloudAgent(discovered[0], "小千"), cloudAgent(discovered[2], "小引的好友名")]);
  const store = await openCloud(cloud, root);
  await store.refreshAgents();
  const names = namesOf(await store.syncDiscoveredAgents(discovered));
  assert.equal(names["qwen-code"], "小qw");
  assert.equal(names.antigravity, "小引的好友名", "names changed in the cloud stay as-is");
  await store.sync();
  assert.equal(cloud.state.agents.get("u_qwen-code").displayName, "小qw");
  assert.equal(cloud.state.agents.get("u_antigravity").displayName, "小引的好友名");
  await store.close();
  passed++;
}

console.log(`agent-name-migration: ${passed} passed, 0 failed`);
