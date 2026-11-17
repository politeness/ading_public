// LocalStore end to end. This one needs neither Electron nor macOS,
// and covers exactly the spots where "a mistake costs the most": seq has no gaps, and memory scopes are isolated.
import { mkdtempSync } from "./tmp.mjs";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const { LocalStore } = await import(path.resolve("dist/store/local.js"));

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++; else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};
const fresh = () => mkdtempSync(path.join(tmpdir(), "ading-store-"));

// ---------------------------------------------------------------------------
// Fresh install
// ---------------------------------------------------------------------------
{
  const store = new LocalStore(fresh());
  await store.init();

  const inbox = await store.inboxWorkspace();
  check("creates the \"No workspace\" inbox by default", inbox.kind === "inbox" && inbox.name === "无工作区", inbox);
  check("Inbox has no directory", inbox.path === undefined);

  const me = await store.currentUser();
  const ws = await store.createWorkspace({ name: "ading", path: "/tmp/ading" });

  // Inbox always sorts last: it is the fallback and should not grab attention
  const list = await store.listWorkspaces();
  check("Inbox sorts last", list[list.length - 1].kind === "inbox", list.map((w) => w.kind));

  check("the same directory cannot have two workspaces",
    await store.createWorkspace({ name: "x", path: "/tmp/ading" }).then(() => false, () => true));

  // ---- Conversation ownership ----
  const inWs = await store.createConversation({ name: "修复扣款", memberIds: ["u_agent"], workspaceId: ws.workspaceId });
  const loose = await store.createConversation({ name: "查个报错", memberIds: ["u_agent"] });
  check("goes to the specified workspace when given", inWs.workspaceId === ws.workspaceId);
  check("falls into Inbox when not specified", loose.workspaceId === inbox.workspaceId, loose.workspaceId);
  check("workspaceId is never empty", !!inWs.workspaceId && !!loose.workspaceId);
  check("a conversation must have a name",
    await store.createConversation({ name: "  ", memberIds: ["u_agent"] }).then(() => false, () => true));

  // You can start several things with the same agent: they must never be deduplicated into one
  const again = await store.createConversation({ name: "另一件事", memberIds: ["u_agent"] });
  check("creating again with the same members is a new conversation", again.conversationId !== loose.conversationId, [again.conversationId, loose.conversationId]);

  // ---- seq is monotonic with no gaps ----
  for (let i = 0; i < 5; i++) {
    await store.appendMessage({
      conversationId: inWs.conversationId, clientMessageId: `c${i}`, senderId: me.userId, content: `第 ${i} 条`
    });
  }
  const msgs = await store.listMessages(inWs.conversationId);
  check("seq is continuous from 1", msgs.map((m) => m.seq).join(",") === "1,2,3,4,5", msgs.map((m) => m.seq));

  // A timeout retry passes the same clientMessageId; it must not become two messages
  const first = await store.appendMessage({ conversationId: inWs.conversationId, clientMessageId: "c0", senderId: me.userId, content: "重复" });
  check("clientMessageId is idempotent", first.seq === 1, first.seq);
  check("idempotent append does not bump seq", (await store.listMessages(inWs.conversationId)).length === 5);

  // Another conversation's seq starts from 1 on its own, independent of the others
  await store.appendMessage({ conversationId: loose.conversationId, clientMessageId: "x0", senderId: me.userId, content: "另一个会话" });
  check("each conversation numbers its own messages", (await store.listMessages(loose.conversationId))[0].seq === 1);

  const disposable = await store.createConversation({ name: "待删除", memberIds: ["u_agent"] });
  await store.appendMessage({ conversationId: disposable.conversationId, clientMessageId: "d0", senderId: me.userId, content: "会被删掉" });
  await store.saveAgentSession({
    conversationId: disposable.conversationId,
    agentUserId: "u_agent",
    providerThreadId: "thread-delete",
    workspacePath: "/tmp/delete"
  });
  await store.appendMemory({ scope: "conversation", ownerId: disposable.conversationId, content: "任务记忆", authorKind: "human", authorUserId: me.userId });
  await store.deleteConversation(disposable.conversationId);
  check("task no longer exists after deleting it", (await store.getConversation(disposable.conversationId)) === null);
  check("chat history no longer exists after deleting the task", (await store.listMessages(disposable.conversationId)).length === 0);
  check("Agent session reference no longer exists after deleting the task", (await store.getAgentSession(disposable.conversationId, "u_agent")) === null);
  check("task memory no longer exists after deleting the task", (await store.listMemories("conversation", disposable.conversationId)).length === 0);

  // ---- Memory scopes ----
  check("agents may not write personal memory",
    await store.appendMemory({ scope: "user", ownerId: me.userId, content: "老板喜欢 X", authorKind: "agent", authorUserId: "u_agent" })
      .then(() => false, () => true));
  await store.appendMemory({ scope: "user", ownerId: me.userId, content: "我用 pnpm", authorKind: "human", authorUserId: me.userId });
  await store.appendMemory({ scope: "workspace", ownerId: ws.workspaceId, content: "这个项目用 RocketMQ", authorKind: "agent", authorUserId: "u_agent" });
  await store.appendMemory({ scope: "conversation", ownerId: inWs.conversationId, content: "先修 A 再修 B", authorKind: "agent", authorUserId: "u_agent" });

  check("agents can write workspace facts directly",
    (await store.listMemories("workspace", ws.workspaceId)).length === 1);
  // This is the implementation-level guarantee that "different conversations must never leak into each other"
  check("another workspace cannot read it",
    (await store.listMemories("workspace", inbox.workspaceId)).length === 0);
  check("another conversation cannot read this conversation's facts",
    (await store.listMemories("conversation", loose.conversationId)).length === 0);

  // Watermark for incremental injection
  // since is inclusive to avoid dropping writes in the same millisecond.
  await new Promise((r) => setTimeout(r, 5));
  const mark = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await store.appendMemory({ scope: "workspace", ownerId: ws.workspaceId, content: "后来加的", authorKind: "agent", authorUserId: "u_agent" });
  const delta = await store.listMemories("workspace", ws.workspaceId, { since: mark });
  check("since returns only the delta", delta.length === 1 && delta[0].content === "后来加的", delta.map((m) => m.content));

  // ---- Deleting a workspace: conversations are kept, skills and facts go with it ----
  const skill = await store.createSkill({
    name: "MQ 幂等", description: "接回调时", scope: "workspace",
    ownerId: ws.workspaceId, content: "要去重", authorKind: "agent"
  });
  await store.deleteWorkspace(ws.workspaceId);
  const moved = await store.getConversation(inWs.conversationId);
  check("conversations are not deleted with it", moved !== null);
  check("conversations are moved into Inbox", moved.workspaceId === inbox.workspaceId, moved.workspaceId);
  check("chat history is still there", (await store.listMessages(inWs.conversationId)).length === 5);
  check("workspace skills are deleted with it", (await store.getSkill(skill.skillId)) === null);
  check("workspace facts are deleted with it", (await store.listMemories("workspace", ws.workspaceId)).length === 0);
  check("Inbox cannot be deleted", await store.deleteWorkspace(inbox.workspaceId).then(() => false, () => true));
}

// ---------------------------------------------------------------------------
// Discovered != added
// ---------------------------------------------------------------------------
{
  const store = new LocalStore(fresh());
  await store.init();
  const [codex] = await store.syncDiscoveredAgents([
    { localUuid: "codex@x", kind: "codex", name: "Codex", version: "1", executablePath: "/x", nodeName: "x" }
  ]);
  check("registered as soon as discovered", (await store.listKnownAgents()).length === 1);
  check("but not yet a contact", (await store.listContacts()).length === 0, await store.listContacts());
  check("newly discovered has enabled false", codex.enabled === false);

  await store.updateAgent(codex.userId, { enabled: true });
  check("becomes a contact after adding", (await store.listContacts()).length === 1);
  await store.updateAgent(codex.userId, { enabled: false });
  check("leaves contacts after removing", (await store.listContacts()).length === 0);
  check("removing does not delete data", (await store.listKnownAgents()).length === 1);

  // Rediscovery must not kick out an agent the user already added
  await store.updateAgent(codex.userId, { enabled: true });
  await store.syncDiscoveredAgents([
    { localUuid: "codex@x", kind: "codex", name: "Codex", version: "2", executablePath: "/x", nodeName: "x" }
  ]);
  check("rediscovery does not override the added state", (await store.listContacts()).length === 1);
  check("rediscovery updates the version",
    (await store.listKnownAgents())[0].version === "2");

  const edited = await store.updateContact(codex.userId, {
    displayName: "小c",
    avatarUrl: "data:image/png;base64,eA=="
  });
  check("contact profile can change the nickname", edited.displayName === "小c");
  check("contact profile can save a custom avatar", edited.avatarUrl?.startsWith("data:image/png"));
  await store.deleteContact(codex.userId);
  check("leaves contacts after deleting", (await store.listContacts()).length === 0);
  check("deleting a contact keeps the Agent discovery record", (await store.listKnownAgents()).length === 1);
}

// ---------------------------------------------------------------------------
// Current human profile: the title bar, navigation avatar and message avatars share this one record
// ---------------------------------------------------------------------------
{
  const dir = fresh();
  const store = new LocalStore(dir);
  await store.init();
  const me = await store.currentUser();
  check("standalone default username matches the nickname", me.username === me.displayName);
  check("standalone default name is ading", me.username === "ading" && me.displayName === "ading", me);
  await store.updateContact(me.userId, {
    displayName: "老板",
    avatarUrl: "data:image/png;base64,eA==",
    phone: "13800138000",
    email: "boss@example.com"
  });
  await store.close();

  const reopened = new LocalStore(dir);
  await reopened.init();
  const saved = await reopened.currentUser();
  check("own nickname can be read back after saving", saved.displayName === "老板");
  check("own avatar can be read back after saving", saved.avatarUrl === "data:image/png;base64,eA==");
  check("human phone number can be read back after saving", saved.phone === "13800138000");
  check("human email can be read back after saving", saved.email === "boss@example.com");
  await reopened.close();
}

// ---------------------------------------------------------------------------
// A conversation can have only one leader
// ---------------------------------------------------------------------------
{
  const store = new LocalStore(fresh());
  await store.init();
  const me = await store.currentUser();
  const conversation = await store.createConversation({ name: "带队", memberIds: ["u_a", "u_b"] });
  check("the human is the leader when the conversation is created",
    conversation.members.find((m) => m.userId === me.userId).role === "LEADER");

  const after = await store.setMemberRole(conversation.conversationId, "u_a", "LEADER");
  const leaders = after.members.filter((m) => m.role === "LEADER");
  check("only one leader remains after changing leader", leaders.length === 1, after.members);
  check("the new leader is the one just set", leaders[0].userId === "u_a");
  check("the old leader is demoted to engineer",
    after.members.find((m) => m.userId === me.userId).role === "ENGINEER");
  check("giving up leadership does not affect the owner", after.owner === me.userId);

  // Setting someone to a non-LEADER role should not affect others
  const back = await store.setMemberRole(conversation.conversationId, "u_b", "REVIEWER");
  check("setting a reviewer does not affect the leader",
    back.members.filter((m) => m.role === "LEADER").length === 1, back.members);
}

// ---------------------------------------------------------------------------
// Each task has exactly one Agent Leader, and an individual Agent can be paused
// ---------------------------------------------------------------------------
{
  const store = new LocalStore(fresh());
  await store.init();
  const [first, second] = await store.syncDiscoveredAgents([
    { localUuid: "codex@leader", kind: "codex", name: "小c", version: "1", executablePath: "/c", nodeName: "x" },
    { localUuid: "claude@member", kind: "claude-code", name: "小cc", version: "1", executablePath: "/cc", nodeName: "x" }
  ]);
  const conversation = await store.createConversation({ name: "Agent 带队", memberIds: [first.userId, second.userId] });
  const agentIds = new Set([first.userId, second.userId]);
  check(
    "a new task has only one Agent Leader",
    conversation.members.filter((member) => agentIds.has(member.userId) && member.role === "LEADER").length === 1,
    conversation.members
  );
  const switched = await store.setMemberRole(conversation.conversationId, second.userId, "LEADER");
  check(
    "still only one Agent Leader after changing Leader",
    switched.members.filter((member) => agentIds.has(member.userId) && member.role === "LEADER").length === 1 &&
      switched.members.find((member) => member.userId === second.userId)?.role === "LEADER",
    switched.members
  );
  const beforePause = switched.updatedAt;
  const pausedAgent = await store.setMemberPaused(conversation.conversationId, first.userId, true);
  check(
    "can pause just one Agent in a task",
    pausedAgent.members.find((member) => member.userId === first.userId)?.paused === true,
    pausedAgent.members
  );
  check("pausing a single Agent does not change task ordering", pausedAgent.updatedAt === beforePause, pausedAgent);
  await store.close();
}

// ---------------------------------------------------------------------------
// Close historical tasks in bulk at startup
// ---------------------------------------------------------------------------
{
  const dir = fresh();
  const store = new LocalStore(dir);
  await store.init();
  const first = await store.createConversation({ name: "历史任务一", memberIds: ["u_a"] });
  const second = await store.createConversation({ name: "历史任务二", memberIds: ["u_b"] });
  await store.updateConversation(second.conversationId, { paused: true });
  const before = new Map((await store.listConversations()).map((conversation) => [conversation.conversationId, conversation.updatedAt]));

  const count = await store.pauseAllConversations();
  const paused = await store.listConversations();
  check("startup close counts only tasks that were active", count === 1, count);
  check("all historical tasks are paused after startup", paused.every((conversation) => conversation.paused), paused);
  check(
    "bulk close does not change task sort time",
    paused.every((conversation) => conversation.updatedAt === before.get(conversation.conversationId)),
    paused
  );

  const firstUpdatedAt = first.updatedAt;
  await store.setConversationPaused(first.conversationId, false);
  await store.setConversationPaused(first.conversationId, true);
  const afterToggle = await store.getConversation(first.conversationId);
  check(
    "pausing and resuming a single task does not change sort time",
    afterToggle.updatedAt === firstUpdatedAt,
    afterToggle
  );
  check("single task state toggle is persisted correctly in the end", afterToggle.paused === true, afterToggle);

  await store.close();
  const reopened = new LocalStore(dir);
  await reopened.init();
  check(
    "paused state of historical tasks is written to disk",
    (await reopened.listConversations()).every((conversation) => conversation.paused)
  );
}

// ---------------------------------------------------------------------------
// Default names: first registration uses 小c / 小cc / 小q / 小q-cn; names the user changed are left alone
// ---------------------------------------------------------------------------
{
  const store = new LocalStore(fresh());
  await store.init();
  const agents = await store.syncDiscoveredAgents([
    { localUuid: "codex@n", kind: "codex", name: "Codex", version: "1", executablePath: "/x", nodeName: "n" },
    { localUuid: "claude-code@n", kind: "claude-code", name: "Claude Code", version: "1", executablePath: "/x", nodeName: "n" },
    { localUuid: "qoder@n", kind: "qoder", name: "Qoder", version: "1", executablePath: "/x", nodeName: "n" },
    { localUuid: "qoder-cn@n", kind: "qoder-cn", name: "Qoder CN", version: "1", executablePath: "/x", nodeName: "n" }
  ]);
  check("new Agents use default names", JSON.stringify(agents.map(a => a.displayName)) === JSON.stringify(["小c", "小cc", "小q", "小q-cn"]), agents.map(a => a.displayName));
  await store.updateContact(agents[2].userId, { displayName: "我的 Qoder" });
  const [again] = await store.syncDiscoveredAgents([
    { localUuid: "qoder@n", kind: "qoder", name: "Qoder", version: "2", executablePath: "/x", nodeName: "n" }
  ]);
  check("rediscovery does not overwrite names the user changed", again.displayName === "我的 Qoder", again.displayName);
}

console.log(`store: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
