// Local data migration for renaming "task" to "conversation": touches only ADing's own data files, migrates the online pending-sync queue too,
// runs before any reads, and repeated runs give the same result.
import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { migrateLegacyTaskNaming } from "../dist/store/legacy-rename.js";
import { CloudStore } from "../dist/store/cloud.js";

const me = { userId: "u_me", username: "sampleuser", displayName: "示例用户" };
const codex = { localUuid: "codex@mac", kind: "codex", name: "Codex", version: "1.0" };
const T0 = "2026-09-13T23:00:00Z";
const dir = await mkdtemp(path.join(os.tmpdir(), "ading-legacy-"));
let sequence = 0;
const rootFor = () => path.join(dir, `root-${++sequence}`);
let passed = 0;

/** Implements only the APIs used by replay and full pull */
function fakeCloud() {
  const state = { online: true, calls: [], conversations: new Map() };
  const ok = (data) => ({ ok: true, data });
  const api = async (method, route, body) => {
    state.calls.push({ method, route, body });
    if (!state.online) return { ok: false, kind: "network", status: 0, message: "offline" };
    const p = new URL(route, "http://cloud.test").pathname.replace("/api/v1", "");
    let m;
    if (p === "/workspaces" && method === "GET") return ok([{ workspaceId: "w_inbox", name: "无工作区", kind: "INBOX", gmtCreated: T0, gmtModified: T0 }]);
    if (["/agents", "/friends"].includes(p) && method === "GET") return ok([]);
    if (p === "/conversations" && method === "GET") return ok([...state.conversations.values()]);
    if (p === "/conversations" && method === "POST") {
      const conversation = {
        conversationId: body.conversationId, name: body.name, type: body.type, creator: me.userId, owner: me.userId, lastSeq: 0,
        workspaceId: "w_inbox", status: "ACTIVE", paused: false, autoTitle: body.autoTitle, extra: body.extra,
        members: body.members.map((member) => ({ userId: member.userId, role: member.role, lastReadSeq: 0, paused: false, resumeOnContinue: false })),
        gmtCreated: T0, gmtModified: T0
      };
      state.conversations.set(conversation.conversationId, conversation);
      return ok(conversation);
    }
    if ((m = p.match(/^\/conversations\/([^/]+)\/messages$/)) && method === "GET") return ok([]);
    if ((m = p.match(/^\/conversations\/([^/]+)$/))) {
      if (method === "DELETE") { state.conversations.delete(m[1]); return ok(null); }
      const conversation = state.conversations.get(m[1]);
      if (!conversation) return { ok: false, kind: "rejected", status: 404, code: "CONVERSATION_001", message: "missing" };
      return ok(conversation);
    }
    // Writes such as members, read positions and profile always succeed
    if (method !== "GET") return ok(null);
    throw new Error(`Unexpected request ${method} ${route}`);
  };
  return { state, api };
}

async function open(cloud, root, logs = []) {
  const store = new CloudStore({
    root,
    user: me,
    api: cloud.api,
    agentUserId: async (agent) => `u_${agent.kind}`,
    retryMs: 60_000,
    log: (event, data) => { logs.push({ event, data }); },
    uploadFile: async () => undefined
  });
  await store.init();
  return store;
}

/** Apply the rename rules in reverse, turning data written by the new version back into its pre-rename form */
function toLegacy(value) {
  if (Array.isArray(value)) return value.map(toLegacy);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key.replace(/Conversations/g, "Tasks").replace(/Conversation/g, "Task").replace(/^conversations/, "tasks").replace(/^conversation/, "task"),
      toLegacy(item)
    ]));
  }
  return value;
}

/**
 * Old online cache: first create a conversation offline with the new version (leaving it pending in the queue), then rename files back to old names:
 * tasks.json, field taskId, queue kind task / task-delete.
 */
async function legacyCloudRoot() {
  const root = rootFor();
  const offline = fakeCloud();
  offline.state.online = false;
  const store = await open(offline, root);
  await store.syncDiscoveredAgents([codex]);
  const conversation = await store.createConversation({ name: "旧任务", memberIds: ["u_codex"] });
  await store.close();

  const conversations = JSON.parse(await readFile(path.join(root, "conversations.json"), "utf8"));
  await writeFile(path.join(root, "tasks.json"), JSON.stringify(toLegacy(conversations), null, 2));
  await rm(path.join(root, "conversations.json"));
  const queue = [
    { id: "q_1", key: `task:${conversation.conversationId}`, op: { kind: "task", taskId: conversation.conversationId }, createdAt: T0 },
    { id: "q_2", key: "task-delete:t_gone", op: { kind: "task-delete", taskId: "t_gone" }, createdAt: T0 }
  ];
  await writeFile(path.join(root, "sync-queue.json"), JSON.stringify(queue, null, 2));
  return { root, conversationId: conversation.conversationId };
}

// The user's own JSON in the attachments directory stays untouched: field names, format, and numbers beyond the safe integer range must not change
{
  const root = rootFor();
  await mkdir(path.join(root, "attachments", "f_1"), { recursive: true });
  await mkdir(path.join(root, "memories"), { recursive: true });
  await mkdir(path.join(root, "messages"), { recursive: true });
  const upload = '{"taskId":  12345678901234567890,\n "type": "task"}\n';
  const uploadLines = '{"taskId": 1}\n{"scope":"task"}\n';
  await writeFile(path.join(root, "attachments", "f_1", "data.json"), upload);
  await writeFile(path.join(root, "attachments", "f_1", "log.jsonl"), uploadLines);
  await writeFile(path.join(root, "tasks.json"), JSON.stringify({ t_1: { taskId: "t_1", name: "新任务" } }, null, 2));
  await writeFile(path.join(root, "messages", "t_1.jsonl"), JSON.stringify({ messageId: "m_1", taskId: "t_1", seq: 1 }) + "\n");
  await writeFile(path.join(root, "memories", "task-t_1.jsonl"), JSON.stringify({ scope: "task", ownerId: "t_1" }) + "\n");

  assert.equal(await migrateLegacyTaskNaming(root), true);
  assert.equal(await readFile(path.join(root, "attachments", "f_1", "data.json"), "utf8"), upload, "JSON in attachments must not be rewritten");
  assert.equal(await readFile(path.join(root, "attachments", "f_1", "log.jsonl"), "utf8"), uploadLines, "JSONL in attachments must not be rewritten");
  assert.equal(existsSync(path.join(root, "tasks.json")), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "conversations.json"), "utf8")), { t_1: { conversationId: "t_1", name: "新会话" } });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "messages", "t_1.jsonl"), "utf8")), { messageId: "m_1", conversationId: "t_1", seq: 1 });
  assert.deepEqual(await readdir(path.join(root, "memories")), ["conversation-t_1.jsonl"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "memories", "conversation-t_1.jsonl"), "utf8")), { scope: "conversation", ownerId: "t_1" });
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false, "Atomic writes leave no temp files");

  // Idempotent: running again changes nothing
  const snapshot = async () => Promise.all(["conversations.json", "messages/t_1.jsonl", "memories/conversation-t_1.jsonl", "attachments/f_1/data.json"]
    .map((name) => readFile(path.join(root, name), "utf8")));
  const before = await snapshot();
  assert.equal(await migrateLegacyTaskNaming(root), false);
  assert.deepEqual(await snapshot(), before);
  passed++;
}

// Old migration already ran (no tasks.json anymore), the queue still has old kinds, and memory files were not renamed: migrate the rest anyway and merge with existing new files without duplicates
{
  const root = rootFor();
  await mkdir(path.join(root, "memories"), { recursive: true });
  await writeFile(path.join(root, "conversations.json"), "{}");
  await writeFile(path.join(root, "sync-queue.json"), JSON.stringify([
    { id: "q_1", key: "task:t_1", op: { kind: "task", conversationId: "t_1" }, createdAt: T0 },
    { id: "q_2", key: "task-delete:t_2", op: { kind: "task-delete", conversationId: "t_2" }, createdAt: T0 }
  ], null, 2));
  const older = JSON.stringify({ memoryId: "y_1", scope: "conversation", ownerId: "t_1" });
  const newer = JSON.stringify({ memoryId: "y_2", scope: "conversation", ownerId: "t_1" });
  await writeFile(path.join(root, "memories", "task-t_1.jsonl"), JSON.stringify({ memoryId: "y_1", scope: "task", ownerId: "t_1" }) + "\n");
  await writeFile(path.join(root, "memories", "conversation-t_1.jsonl"), `${older}\n${newer}\n`);

  assert.equal(await migrateLegacyTaskNaming(root), true);
  const queue = JSON.parse(await readFile(path.join(root, "sync-queue.json"), "utf8"));
  assert.deepEqual(queue.map((entry) => [entry.key, entry.op.kind]), [["task:t_1", "conversation"], ["conversation-delete:t_2", "conversation-delete"]]);
  assert.deepEqual(await readdir(path.join(root, "memories")), ["conversation-t_1.jsonl"]);
  assert.equal(await readFile(path.join(root, "memories", "conversation-t_1.jsonl"), "utf8"), `${older}\n${newer}\n`, "Entries already merged from the old file are not duplicated");
  assert.equal(await migrateLegacyTaskNaming(root), false);
  passed++;
}

// Online: old task / task-delete entries in the queue replay correctly after migration instead of being silently dropped as done
{
  const { root, conversationId } = await legacyCloudRoot();
  const cloud = fakeCloud();
  cloud.state.conversations.set("t_gone", { conversationId: "t_gone", members: [] });
  const store = await open(cloud, root);
  await store.sync();
  assert.equal(store.pendingCount(), 0);
  assert.ok(cloud.state.calls.some((call) => call.method === "POST" && call.route.endsWith("/conversations") && call.body.conversationId === conversationId),
    "Old task replays as conversation creation");
  assert.ok(cloud.state.calls.some((call) => call.method === "DELETE" && call.route.endsWith("/conversations/t_gone")), "Old task-delete replays as conversation deletion");
  assert.equal(existsSync(path.join(root, "sync-rejected.jsonl")), false);
  const [listed] = await store.listConversations();
  assert.equal(listed.conversationId, conversationId, "Cache reads the migrated data");
  await store.close();
  const saved = JSON.parse(await readFile(path.join(root, "sync-queue.json"), "utf8"));
  assert.deepEqual(saved, []);
  passed++;
}

// Replay hits an unknown kind: record as rejected and log it, never treat as synced
{
  const root = rootFor();
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "sync-state.json"), JSON.stringify({ pulledAt: T0, agents: {} }));
  await writeFile(path.join(root, "sync-queue.json"), JSON.stringify([
    { id: "q_1", key: "mystery:1", op: { kind: "mystery", id: "1" }, createdAt: T0 }
  ]));
  const logs = [];
  const cloud = fakeCloud();
  const store = await open(cloud, root, logs);
  await store.sync();
  await store.close();
  const rejected = (await readFile(path.join(root, "sync-rejected.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rejected.map((entry) => entry.key), ["mystery:1"], "Unknown operations go into the rejected log");
  assert.ok(logs.some((entry) => entry.event === "cloud-sync-unknown-op" && entry.data.kind === "mystery"), "Log states which unknown operation it was");
  passed++;
}

// When the first open needs a full pull, migration happens before writing the snapshot: old memories are still renamed and the old tasks.json is not left behind
{
  const root = rootFor();
  await mkdir(path.join(root, "memories"), { recursive: true });
  await writeFile(path.join(root, "tasks.json"), JSON.stringify({ t_old: { taskId: "t_old", name: "旧的" } }));
  await writeFile(path.join(root, "memories", "task-t_old.jsonl"), JSON.stringify({ scope: "task", ownerId: "t_old" }) + "\n");
  const store = await open(fakeCloud(), root);
  await store.close();
  assert.equal(existsSync(path.join(root, "tasks.json")), false);
  assert.deepEqual(await readdir(path.join(root, "memories")), ["conversation-t_old.jsonl"]);
  passed++;
}

// An earlier version already wrote the cloud snapshot (conversations.json alongside the old tasks.json): the snapshot wins, and remaining old data is still fully migrated
{
  const root = rootFor();
  await mkdir(path.join(root, "memories"), { recursive: true });
  await writeFile(path.join(root, "conversations.json"), JSON.stringify({ t_new: { conversationId: "t_new" } }));
  await writeFile(path.join(root, "tasks.json"), JSON.stringify({ t_old: { taskId: "t_old" } }));
  await writeFile(path.join(root, "agent-sessions.json"), JSON.stringify({ a: { taskId: "t_new" } }));
  await writeFile(path.join(root, "memories", "task-t_new.jsonl"), JSON.stringify({ scope: "task", ownerId: "t_new" }) + "\n");
  assert.equal(await migrateLegacyTaskNaming(root), true);
  assert.equal(existsSync(path.join(root, "tasks.json")), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "conversations.json"), "utf8")), { t_new: { conversationId: "t_new" } });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "agent-sessions.json"), "utf8")), { a: { conversationId: "t_new" } });
  assert.deepEqual(await readdir(path.join(root, "memories")), ["conversation-t_new.jsonl"]);
  assert.equal(await migrateLegacyTaskNaming(root), false);
  passed++;
}

console.log(`legacy-rename: ${passed} groups passed`);
