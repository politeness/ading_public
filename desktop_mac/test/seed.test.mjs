// Task sheet. This is the "I plan it, the agent does it, nobody retypes it" channel;
// what matters most is idempotency and never overriding the human -- it runs on every startup
import { mkdtempSync } from "./tmp.mjs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const { LocalStore } = await import(path.resolve("dist/store/local.js"));
const { applySeed, isSeedDoc } = await import(path.resolve("dist/orchestration/seed.js"));

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++; else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

const doc = () => ({
  version: 1,
  workspaces: [{ key: "w", name: "ADing", path: "/tmp/ading-seed" }],
  agents: [
    { kind: "codex", displayName: "阿码", persona: "动手" },
    { kind: "claude-code", displayName: "阿评" }
  ],
  conversations: [{
    key: "t1", workspace: "w", name: "验证接入",
    charter: { goal: "确认能跑", boundary: "只在本目录", doneWhen: "三家都有结论" },
    members: [{ kind: "codex", role: "LEADER" }, { kind: "claude-code", role: "REVIEWER" }],
    opening: "开工"
  }]
});

const setup = async () => {
  const store = new LocalStore(mkdtempSync(path.join(tmpdir(), "ading-seed-")));
  await store.init();
  const [codex, claude] = await store.syncDiscoveredAgents([
    { localUuid: "codex@x", kind: "codex", name: "Codex", version: "1", executablePath: "/x", nodeName: "x" },
    { localUuid: "cc@x", kind: "claude-code", name: "Claude Code", version: "1", executablePath: "/y", nodeName: "x" }
  ]);
  return { store, agents: new Map([["codex", codex.userId], ["claude-code", claude.userId]]) };
};

// ---- apply once normally ----
{
  const { store, agents } = await setup();
  const r = await applySeed(store, agents, doc());
  check("workspace created", r.workspaces.length === 1, r);
  check("two agents configured", r.agents.length === 2, r.agents);
  check("conversation opened", r.conversations.length === 1, r);
  check("no problems", r.problems.length === 0, r.problems);

  const conversation = (await store.listConversations())[0];
  check("conversation carries seedKey", conversation.seedKey === "t1", conversation.seedKey);
  check("charter written", conversation.charter.goal === "确认能跑");
  const ws = await store.getWorkspace(conversation.workspaceId);
  check("assigned to the specified workspace", ws.path === "/tmp/ading-seed", ws);

  const leaders = conversation.members.filter((m) => m.role === "LEADER");
  check("exactly one leader", leaders.length === 1, conversation.members);
  check("leader is the one named in the task sheet", leaders[0].userId === agents.get("codex"), conversation.members);
  check("human remains owner after handing over leadership", conversation.owner === (await store.currentUser()).userId);
  check("reviewer role set",
    conversation.members.some((m) => m.role === "REVIEWER" && m.userId === agents.get("claude-code")));

  const codex = await store.getUser(agents.get("codex"));
  check("nickname changed", codex.displayName === "阿码", codex.displayName);
  check("persona written", codex.persona === "动手");
  // Being named in the task sheet = an explicit decision to "add as contact"
  check("named agent automatically becomes a contact", codex.enabled === true, codex);
  check("visible in the contact list",
    (await store.listContacts()).some((c) => c.userId === agents.get("codex")));

  const msgs = await store.listMessages(conversation.conversationId);
  check("opening message sent", msgs.length === 1 && msgs[0].content === "开工", msgs);
  // It must be sent by the human, otherwise the orchestrator will not treat it as "the boss has spoken"
  check("opening message sent as the human", msgs[0].senderId === (await store.currentUser()).userId);
  check("opening message @-mentions members", msgs[0].mentions.length === 2, msgs[0].mentions);
  check("returns the conversations to trigger", r.startedConversationIds[0] === conversation.conversationId);

  // ---- idempotent: runs on every app startup ----
  const again = await applySeed(store, agents, doc());
  check("rerun does not duplicate conversations", again.conversations.length === 0, again.conversations);
  check("rerun does not duplicate workspaces", again.workspaces.length === 0, again.workspaces);
  check("conversation count is still 1", (await store.listConversations()).length === 1);
  check("opening message not resent", (await store.listMessages(conversation.conversationId)).length === 1);
  check("skipped items are explained", again.skipped.length >= 2, again.skipped);

  // Still no duplicate after the human renames it -- dedup is by key, not name
  await store.updateConversation(conversation.conversationId, { name: "我改了个名" });
  const third = await applySeed(store, agents, doc());
  check("no duplicate after rename", third.conversations.length === 0, third.conversations);
  check("human's rename is not overwritten", (await store.getConversation(conversation.conversationId)).name === "我改了个名");
}

// ---- an agent is missing on this machine ----
{
  const { store } = await setup();
  const onlyCodex = new Map([["codex", (await store.listKnownAgents())[0].userId]]);
  const r = await applySeed(store, onlyCodex, doc());
  check("starts normally with one missing", r.conversations.length === 1, r);
  check("states clearly who is missing", r.skipped.some((s) => s.includes("claude-code")), r.skipped);

  const r2 = await applySeed(store, new Map(), { ...doc(), conversations: [{ ...doc().conversations[0], key: "t2" }] });
  check("skips the conversation when none are installed", r2.conversations.length === 0, r2);
  check("and explains why", r2.problems.some((p) => p.includes("一个都没装")), r2.problems);
}

// ---- bad input must not break startup ----
{
  const { store, agents } = await setup();
  const bad = await applySeed(store, agents, { version: 99 });
  check("unknown version is rejected", bad.problems.length === 1 && bad.conversations.length === 0, bad);
  check("empty task sheet does not error", (await applySeed(store, agents, { version: 1 })).problems.length === 0);
  check("isSeedDoc checks the version", isSeedDoc({ version: 1 }) === true);
  check("isSeedDoc rejects junk", isSeedDoc({}) === false && isSeedDoc(null) === false && isSeedDoc("x") === false);
}

// ---- the sample task sheet in the repo must be valid ----
{
  const real = JSON.parse(readFileSync(path.resolve("../.ading/seed.example.json"), "utf8"));
  check("repo task sheet parses", isSeedDoc(real));
  check("every conversation has a key", real.conversations.every((t) => t.key));
  check("keys are unique", new Set(real.conversations.map((t) => t.key)).size === real.conversations.length);
  check("every conversation points to an existing workspace",
    real.conversations.every((t) => !t.workspace || real.workspaces.some((w) => w.key === t.workspace)));
  check("every conversation has members", real.conversations.every((t) => t.members.length > 0));
  check("role values are valid",
    real.conversations.every((t) => t.members.every((m) => !m.role || ["LEADER", "ENGINEER", "REVIEWER", "OBSERVER"].includes(m.role))));
  // Command stays with the human's account (it relays what I draft), not delegated to an agent
  check("LEADER is not assigned to an agent",
    real.conversations.every((t) => t.members.every((m) => m.role !== "LEADER")),
    real.conversations.map((t) => t.members));
  check("every agent has a persona", (real.agents ?? []).every((a) => a.persona && a.displayName));
}

console.log(`seed: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
