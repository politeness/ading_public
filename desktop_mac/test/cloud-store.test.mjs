import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { CloudStore } from "../dist/store/cloud.js";
import { LocalScheduler } from "../dist/orchestration/local-scheduler.js";

let passed = 0;
const me = { userId: "u_me", username: "sampleuser", displayName: "示例用户" };
const codex = { localUuid: "codex@mac", kind: "codex", name: "Codex", version: "1.0" };
const T0 = "2026-09-13T23:00:00Z";

/** Fake cloud: implements only the APIs CloudStore uses, behaving like conductor; can switch offline at any time */
function fakeCloud() {
  const state = {
    online: true,
    calls: [],
    workspaces: new Map([["w_inbox", { workspaceId: "w_inbox", name: "无工作区", kind: "INBOX", gmtCreated: T0, gmtModified: T0 }]]),
    conversations: new Map(),
    messages: new Map(),
    reject: new Map(),
    profile: undefined,
    agents: new Map(),
    friends: new Set(),
    attachments: new Map(),
    downloadBase: "http://oss.test/get/"
  };
  const ok = (data) => ({ ok: true, data });
  const rejected = (code, status = 400) => ({ ok: false, kind: "rejected", status, code, message: code });
  const api = async (method, route, body) => {
    state.calls.push({ method, route, body });
    if (!state.online) return { ok: false, kind: "network", status: 0, message: "offline" };
    const url = new URL(route, "http://cloud.test");
    const p = url.pathname.replace("/api/v1", "");
    const sender = url.searchParams.get("senderId") ?? me.userId;
    let m;
    if (p === "/workspaces" && method === "GET") return ok([...state.workspaces.values()]);
    if (p === "/workspaces" && method === "POST") {
      if (!state.workspaces.has(body.workspaceId)) state.workspaces.set(body.workspaceId, { ...body, kind: "FOLDER", gmtCreated: T0, gmtModified: T0 });
      return ok(state.workspaces.get(body.workspaceId));
    }
    if ((m = p.match(/^\/workspaces\/([^/]+)$/))) {
      if (method === "DELETE") { state.workspaces.delete(m[1]); return ok(null); }
      Object.assign(state.workspaces.get(m[1]), body);
      return ok(state.workspaces.get(m[1]));
    }
    if (p === "/conversations/sync-cursors" && method === "GET") {
      const after = Number(url.searchParams.get("afterId") ?? 0);
      return ok([...state.conversations.values()].map((c, i) => ({ syncId: i + 1, conversationId: c.conversationId, lastSeq: c.lastSeq, lastReadSeq: c.members.find(m => m.userId === me.userId)?.lastReadSeq ?? 0 }))
        .filter(c => c.syncId > after).slice(0, Number(url.searchParams.get("limit"))));
    }
    if (p === "/conversations" && method === "GET") return ok([...state.conversations.values()]);
    if (p === "/conversations" && method === "POST") {
      const conversation = {
        conversationId: body.conversationId, name: body.name, type: body.type, creator: me.userId, owner: me.userId, lastSeq: 0,
        workspaceId: body.workspaceId ?? "w_inbox", status: "ACTIVE", paused: false, autoTitle: body.autoTitle, extra: body.extra,
        members: body.members.map((member) => ({ userId: member.userId, role: member.role, lastReadSeq: 0, paused: false, resumeOnContinue: false })),
        gmtCreated: T0, gmtModified: T0
      };
      state.conversations.set(conversation.conversationId, conversation);
      return ok(conversation);
    }
    if ((m = p.match(/^\/conversations\/([^/]+)$/))) {
      const conversation = state.conversations.get(m[1]);
      if (method === "DELETE") { state.conversations.delete(m[1]); return ok(null); }
      if (!conversation) return rejected("CONVERSATION_001");
      if (method === "GET") return ok(conversation);
      for (const key of ["name", "owner", "status", "paused", "autoTitle", "extra"]) if (body[key] !== undefined) conversation[key] = body[key];
      return ok(conversation);
    }
    if ((m = p.match(/^\/conversations\/([^/]+)\/members$/))) {
      const conversation = state.conversations.get(m[1]);
      if (conversation.members.some((member) => member.userId === body.userId)) return rejected("CONVERSATION_005");
      conversation.members.push({ userId: body.userId, role: body.role, lastReadSeq: 0, paused: false, resumeOnContinue: false });
      return ok(null);
    }
    if ((m = p.match(/^\/conversations\/([^/]+)\/members\/([^/]+)$/))) {
      const conversation = state.conversations.get(m[1]);
      if (method === "DELETE") { conversation.members = conversation.members.filter((member) => member.userId !== m[2]); return ok(null); }
      const member = conversation.members.find((item) => item.userId === m[2]);
      if (body.role) member.role = body.role;
      if (body.paused !== undefined) member.paused = body.paused;
      if (body.resumeOnContinue !== undefined) member.resumeOnContinue = body.resumeOnContinue;
      return ok(null);
    }
    if ((m = p.match(/^\/conversations\/([^/]+)\/messages$/))) {
      const list = state.messages.get(m[1]) ?? [];
      if (method === "GET" && url.searchParams.has("beforeSeq")) return ok(list.filter((message) => message.seq < Number(url.searchParams.get("beforeSeq"))).slice(-Number(url.searchParams.get("limit") ?? 100)));
      if (method === "GET") return ok(list.filter((message) => message.seq > Number(url.searchParams.get("afterSeq") ?? 0)));
      if (state.reject.has(body.messageId)) return rejected(state.reject.get(body.messageId));
      const conversation = state.conversations.get(m[1]);
      if (!conversation) return rejected("CONVERSATION_001");
      const existing = list.find((message) => message.messageId === body.messageId);
      if (existing) return ok(existing);
      // Same as the backend: attachments must be registered and fully uploaded before they can be sent with a message
      const attachments = (body.attachments ?? []).map((id) => state.attachments.get(id));
      if (attachments.some((item) => !item || !item.uploaded || item.conversationId !== m[1] || item.uploader !== sender)) return rejected("FILE_006");
      const message = {
        ...body, conversationId: m[1], seq: ++conversation.lastSeq, senderId: sender, status: "SENT", gmtCreated: T0,
        ...(attachments.length ? { attachments: attachments.map(({ attachmentId, name, mimeType, size }) => ({ attachmentId, name, mimeType, size, kind: mimeType.startsWith("image/") ? "IMAGE" : "FILE" })) } : {})
      };
      list.push(message);
      state.messages.set(m[1], list);
      return ok(message);
    }
    if ((m = p.match(/^\/conversations\/([^/]+)\/attachments$/)) && method === "POST") {
      const existing = state.attachments.get(body.attachmentId);
      if (existing && (existing.conversationId !== m[1] || existing.uploader !== sender)) return rejected("FILE_001");
      const attachment = existing ?? { ...body, conversationId: m[1], uploader: sender, uploaded: false };
      state.attachments.set(body.attachmentId, attachment);
      return ok({ uploadUrl: `http://oss.test/put/${body.attachmentId}`, contentType: body.mimeType, uploaded: attachment.uploaded });
    }
    if ((m = p.match(/^\/conversations\/([^/]+)\/attachments\/([^/]+)\/url$/)) && method === "GET") {
      return ok({ url: `${state.downloadBase}${m[2]}` });
    }
    if ((m = p.match(/^\/conversations\/([^/]+)\/messages\/(read|processed)$/))) {
      const conversation = state.conversations.get(m[1]);
      const member = conversation.members.find((item) => item.userId === sender);
      const seq = Math.min(body.seq, conversation.lastSeq);
      if (m[2] === "read") member.lastReadSeq = Math.max(member.lastReadSeq, seq);
      else member.lastProcessedSeq = seq;
      return ok(null);
    }
    if (p === "/profile" && method === "PUT") { state.profile = body; return ok(body); }
    if (p === "/agents" && method === "GET") return ok([...state.agents.values()]);
    if ((m = p.match(/^\/agents\/([^/]+)$/)) && method === "PUT") {
      const agent = state.agents.get(m[1]) ?? { userId: m[1], isAgent: true };
      state.agents.set(m[1], { ...agent, ...body });
      return ok(state.agents.get(m[1]));
    }
    if (p === "/friends" && method === "GET") return ok([...state.friends].map((id) => state.agents.get(id) ?? { userId: id }));
    if ((m = p.match(/^\/friends\/([^/]+)$/))) {
      if (method === "POST") state.friends.add(m[1]);
      else state.friends.delete(m[1]);
      return ok(null);
    }
    throw new Error(`Unexpected request ${method} ${route}`);
  };
  return { state, api };
}

const dir = await mkdtemp(path.join(os.tmpdir(), "ading-cloud-"));
let sequence = 0;
const rootFor = () => path.join(dir, `account-${++sequence}`, "data");
async function open(cloud, root = rootFor(), retryMs = 60_000) {
  const store = new CloudStore({
    root,
    user: me,
    api: cloud.api,
    agentUserId: async (agent) => `u_${agent.kind.replace("-", "_")}`,
    retryMs,
    // Fake OSS: records what was uploaded and marks it as uploaded
    uploadFile: async (url, file, contentType) => {
      if (cloud.state.failUploads) throw new Error("oss down");
      const id = url.split("/").pop();
      const attachment = cloud.state.attachments.get(id);
      attachment.uploaded = true;
      attachment.content = await readFile(file, "utf8");
      attachment.uploadedAs = contentType;
    }
  });
  await store.init();
  return store;
}

// A task stop is synchronized to another client and survives local restart.
{
  const cloud=fakeCloud(),root=rootFor();
  const store=await open(cloud,root);let peer,restarted;
  try {
    await store.syncDiscoveredAgents([codex]);
    const conversation=await store.createConversation({name:'Stopped task',memberIds:['u_codex']});
    const scheduler=new LocalScheduler({store,registry:{cancel:()=>true},broadcast:()=>{},log:async()=>{},resolveDiscovered:()=>undefined});
    await scheduler.stopConversation(conversation.conversationId);
    await store.sync();
    assert.equal(cloud.state.conversations.get(conversation.conversationId).paused,true);
    peer=await open(cloud);
    assert.equal((await peer.getConversation(conversation.conversationId)).paused,true,'other client receives stopped state');
    await store.close();
    restarted=await open(cloud,root);
    assert.equal((await restarted.getConversation(conversation.conversationId)).paused,true,'restart preserves stopped state');
    passed++;
  } finally {await store.close();await peer?.close();await restarted?.close();}
}

// The current model reported by another computer syncs along with the Agent; empty cloud fields do not enter local data, and agents that never reported (old clients) lack this field
{
  const cloud=fakeCloud();
  for(const [userId,model] of [['u_new',{selected:'b',selectedLabel:null,nativeModel:'Model A'}],['u_old',null]]){
    cloud.state.friends.add(userId);
    cloud.state.agents.set(userId,{userId,displayName:userId,isAgent:true,agentType:'CODEX',owner:me.userId,computerId:'d_other',computerName:'M5',computerOnline:true,readiness:'ready',model});
  }
  const store=new CloudStore({root:rootFor(),user:me,localComputerId:()=>'d_here',agentUserId:async()=>'u_local',api:cloud.api});
  try {
    await store.init();
    await store.refreshAgents();
    assert.deepEqual((await store.getUser('u_new')).remote.model,{selected:'b',nativeModel:'Model A'});
    assert.equal('model' in (await store.getUser('u_old')).remote,false);
    passed++;
  } finally {await store.close();}
}

// A stale background friends response must not undo adding/removing Copilot.
for (const enabled of [true,false]) {
  const cloud=fakeCloud();
  if(!enabled)cloud.state.friends.add('u_copilot');
  cloud.state.agents.set('u_copilot',{userId:'u_copilot',displayName:'小cp',isAgent:true,agentType:'COPILOT',computerId:'d_here'});
  let hold=false,entered,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const waiting=new Promise(resolve=>{entered=resolve;});
  const store=new CloudStore({root:rootFor(),user:me,localComputerId:()=> 'd_here',agentUserId:async()=> 'u_copilot',api:async(method,route,body)=>{
    const result=await cloud.api(method,route,body);
    if(hold&&method==='GET'&&route==='/api/v1/friends'){entered();await gate;}
    return result;
  }});
  try {
    await store.init();
    await store.syncDiscoveredAgents([{kind:'copilot',localUuid:'copilot@mac',version:'1.0.105',executablePath:'/fixture/copilot'}]);
    await store.refreshAgents();await store.sync();
    hold=true;const refresh=store.refreshAgents();await waiting;
    await store.updateAgent('u_copilot',{enabled});await store.sync();
    assert.equal(store.pendingCount(),0,'contact upload has already completed');
    assert.equal(cloud.state.friends.has('u_copilot'),enabled);
    release();await refresh;
    assert.equal((await store.listContacts()).some(a=>a.userId==='u_copilot'),enabled,'old snapshot cannot undo the Copilot contact edit');
    assert.equal((await store.getUser('u_copilot')).enabled,enabled);
    hold=false;
    if(enabled)cloud.state.friends.delete('u_copilot');else cloud.state.friends.add('u_copilot');
    await store.refreshAgents();
    assert.equal((await store.getUser('u_copilot')).enabled,!enabled,'a new pull still accepts later changes from another device');
    passed++;
  } finally {release();await store.close();}
}

// First open: rebuild the cache by fully pulling from the cloud; use the cloud's "No workspace", and restore scheduler state and message extras as-is
{
  const cloud = fakeCloud();
  cloud.state.conversations.set("t_remote", {
    conversationId: "t_remote", name: "云端任务", type: "DIRECT", creator: "u_me", owner: "u_me", lastSeq: 1, workspaceId: "w_inbox",
    status: "ACTIVE", paused: false, autoTitle: false, extra: { charter: { goal: "从云端来" } },
    members: [
      { userId: "u_me", role: "ENGINEER", lastReadSeq: 1, paused: false, resumeOnContinue: false },
      { userId: "u_codex", role: "ENGINEER", lastReadSeq: 0, lastProcessedSeq: 1, paused: false, resumeOnContinue: false }
    ],
    gmtCreated: T0, gmtModified: "2026-09-13T23:30:00Z"
  });
  cloud.state.messages.set("t_remote", [{
    messageId: "m_1", conversationId: "t_remote", seq: 1, senderId: "u_me", content: "云端的消息", type: "USER", mentions: [],
    status: "SENT", internal: false, report: false, failed: false, extra: { steps: ["读需求"] }, gmtCreated: T0
  }]);
  const store = await open(cloud);
  assert.equal((await store.inboxWorkspace()).workspaceId, "w_inbox");
  assert.equal((await store.currentUser()).userId, "u_me", "The cached \"me\" is the signed-in account");
  const [conversation] = await store.listConversations();
  assert.equal(conversation.charter.goal, "从云端来");
  assert.equal(conversation.updatedAt, "2026-09-13T23:30:00.000Z", "Cloud timestamps are normalized to local ISO format");
  assert.equal(conversation.members[1].lastProcessedSeq, 1);
  const [message] = await store.listMessages("t_remote");
  assert.equal(message.content, "云端的消息");
  assert.deepEqual(message.steps, ["读需求"]);
  await store.close();
  passed++;
}

// Offline writes work as usual: multiple edits to the same task merge into one entry, the queue survives restart; once online, upload in order without duplicates
{
  const cloud = fakeCloud();
  const root = rootFor();
  const store = await open(cloud, root);
  const [agent] = await store.syncDiscoveredAgents([codex]);
  assert.equal(agent.userId, "u_codex", "agent uses the cloud userId");
  const events = [];
  store.subscribe((event) => { if (event.type === "connection") events.push(event.online); });

  cloud.state.online = false;
  const conversation = await store.createConversation({ name: "离线任务", memberIds: ["u_codex"] });
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_offline_1", senderId: "u_me", content: "第一条" });
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_offline_2", senderId: "u_codex", content: "第二条", steps: ["看了代码"] });
  await store.updateConversation(conversation.conversationId, { charter: { goal: "离线改的目标" } });
  await store.sync();
  assert.equal(store.pendingCount(), 3, "One task entry, two message entries");
  assert.deepEqual(events, [false]);
  await store.close();

  cloud.state.online = true;
  const reopened = await open(cloud, root);
  assert.equal(reopened.pendingCount(), 3, "Queue survives restart and is not overwritten by cloud data");
  await reopened.sync();
  assert.equal(reopened.pendingCount(), 0);
  const remote = cloud.state.conversations.get(conversation.conversationId);
  assert.equal(remote.extra.charter.goal, "离线改的目标");
  assert.equal(remote.workspaceId, "w_inbox", "The local \"No workspace\" maps to the cloud's own \"No workspace\"");
  const messages = cloud.state.messages.get(conversation.conversationId);
  assert.deepEqual(messages.map((message) => [message.seq, message.senderId, message.content]), [
    [1, "u_me", "第一条"],
    [2, "u_codex", "第二条"]
  ]);
  assert.deepEqual(messages[1].extra.steps, ["看了代码"]);
  await reopened.sync();
  assert.equal(cloud.state.calls.filter((call) => call.method === "POST" && call.route === "/api/v1/conversations").length, 1, "Task is created only once");
  assert.equal(messages.length, 2, "Messages are not duplicated");
  await reopened.close();
  passed++;
}

// Changes the cloud explicitly rejects: discard and record in the sync log without blocking later ones
{
  const cloud = fakeCloud();
  const root = rootFor();
  const store = await open(cloud, root);
  await store.syncDiscoveredAgents([codex]);
  const conversation = await store.createConversation({ name: "会有一条被拒", memberIds: ["u_codex"] });
  cloud.state.reject.set("m_bad", "MSG_005");
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_bad", senderId: "u_me", content: "云端不收" });
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_good", senderId: "u_me", content: "正常" });
  await store.sync();
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(cloud.state.messages.get(conversation.conversationId).map((message) => message.messageId), ["m_good"]);
  assert.match(await readFile(path.join(root, "sync-rejected.jsonl"), "utf8"), /m_bad/);
  const statuses = Object.fromEntries((await store.listMessages(conversation.conversationId)).map((message) => [message.messageId, message.status]));
  assert.equal(statuses.m_bad, "FAILED", "After cloud rejection, must not pretend locally that it was sent");
  assert.equal(statuses.m_good, "SENT");
  await store.close();
  const reopened = await open(cloud, root);
  assert.equal((await reopened.listMessages(conversation.conversationId)).find((message) => message.messageId === "m_bad")?.status, "FAILED", "Still shows send failure after restart");
  await reopened.close();
  passed++;
}

// When pulling temporarily fails, new messages must still get an upload timer even if the queue was empty; upload immediately once pulling recovers.
{
  const cloud = fakeCloud();
  const store = await open(cloud, rootFor(), 30);
  await store.syncDiscoveredAgents([codex]);
  const conversation = await store.createConversation({ name: "拉取失败后发送", memberIds: ["u_codex"] });
  await store.sync();
  const events = [];
  store.subscribe((event) => { if (event.type === "message-delivery") events.push([event.messageId, event.status]); });

  cloud.state.online = false;
  assert.equal(await store.pull("/api/v1/friends"), undefined);
  const message = await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_recover", senderId: "u_me", content: "请同步到云端" });
  assert.equal(message.status, "SENDING");
  assert.equal((await store.listMessages(conversation.conversationId)).at(-1).status, "SENDING");
  assert.ok(store.timer, "New writes while offline must also schedule a retry");
  cloud.state.online = true;
  assert.deepEqual(await store.pull("/api/v1/friends"), []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.pendingCount(), 0, "Uploads automatically after read requests recover, without waiting for manual sync or restart");
  assert.equal(cloud.state.messages.get(conversation.conversationId)?.at(-1)?.messageId, "m_recover");
  assert.equal((await store.listMessages(conversation.conversationId)).at(-1).status, "SENT");
  assert.deepEqual(events, [["m_recover", "SENDING"], ["m_recover", "SENT"]]);
  await store.close();
  passed++;
}

// Deleting a task while offline: its not-yet-uploaded changes and messages are dropped, and only the deletion is uploaded
{
  const cloud = fakeCloud();
  cloud.state.online = false;
  const store = await open(cloud);
  await store.syncDiscoveredAgents([codex]);
  const conversation = await store.createConversation({ name: "建了又删", memberIds: ["u_codex"] });
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_gone", senderId: "u_me", content: "不用传了" });
  await store.deleteConversation(conversation.conversationId);
  assert.equal(store.pendingCount(), 1);
  cloud.state.online = true;
  await store.sync();
  assert.equal(store.pendingCount(), 0);
  assert.equal(cloud.state.calls.some((call) => call.method === "POST" && call.route.includes(conversation.conversationId)), false);
  assert.equal(cloud.state.calls.some((call) => call.method === "POST" && call.route === "/api/v1/conversations"), false);
  assert.ok(cloud.state.calls.some((call) => call.method === "DELETE" && call.route === `/api/v1/conversations/${conversation.conversationId}`));
  await store.close();
  passed++;
}

// Profile edited twice offline: only one entry stays in the queue, and the last edit wins once online
{
  const cloud = fakeCloud();
  const store = await open(cloud);
  cloud.state.online = false;
  await store.sync();
  await store.enqueueProfile({ displayName: "第一次", avatarUrl: "", phone: "", email: "" });
  await store.enqueueProfile({ displayName: "第二次", avatarUrl: "", phone: "123", email: "" });
  assert.equal(store.pendingCount(), 1);
  cloud.state.online = true;
  await store.sync();
  assert.deepEqual(cloud.state.profile, { displayName: "第二次", avatarUrl: "", phone: "123", email: "" });
  await store.close();
  passed++;
}

// Offline read position ahead of messages: the cloud truncates it when the task syncs first, so realign once messages are uploaded
{
  const cloud = fakeCloud();
  const store = await open(cloud);
  await store.syncDiscoveredAgents([codex]);
  cloud.state.online = false;
  await store.sync();
  const conversation = await store.createConversation({ name: "位置对齐", memberIds: ["u_codex"] });
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_read_1", senderId: "u_me", content: "第一条" });
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_read_2", senderId: "u_codex", content: "回复" });
  await store.markRead(conversation.conversationId, "u_me", 2);
  await store.markProcessed(conversation.conversationId, "u_codex", 1);
  cloud.state.online = true;
  await store.sync();
  assert.equal(store.pendingCount(), 0);
  const members = Object.fromEntries(cloud.state.conversations.get(conversation.conversationId).members.map((member) => [member.userId, member]));
  assert.equal(members.u_me.lastReadSeq, 2, "Read position matches local");
  assert.equal(members.u_codex.lastProcessedSeq, 1, "Processed position matches local");
  await store.close();
  passed++;
}

// Global read state: push, pending sync, out-of-order snapshots, catch-up after disconnect.
{
  const cloud = fakeCloud();
  const store = await open(cloud);
  try {
    await store.syncDiscoveredAgents([codex]);
    const c = await store.createConversation({ name: "全局已读", memberIds: ["u_codex"] });
    for (let i = 1; i <= 4; i++) await store.appendMessage({ conversationId: c.conversationId, clientMessageId: `m_global_read_${i}`, senderId: "u_codex", content: `reply ${i}`, mentions: ["u_me"] });
    await store.sync();
    const remote = cloud.state.conversations.get(c.conversationId);
    const mine = remote.members.find(m => m.userId === "u_me");
    const read = async () => (await store.getConversation(c.conversationId)).members.find(m => m.userId === "u_me");
    const events = [];
    const off = store.subscribe(event => events.push(event));
    mine.lastReadSeq = 2;
    await store.refreshConversation(c.conversationId);
    assert.equal((await read()).lastReadSeq, 2);
    assert.equal((await read()).firstUnreadMentionSeq, 3, "only unread mentions beyond the global watermark remain");
    assert.ok(events.some(e => e.type === "conversation" && e.conversationId === c.conversationId), "receipt refreshes UI and badge");
    cloud.state.online = false;
    await store.markRead(c.conversationId, "u_me", 3);
    cloud.state.online = true;
    mine.lastReadSeq = 2;
    await store.refreshConversation(c.conversationId);
    assert.equal((await read()).lastReadSeq, 3, "stale cloud state cannot undo pending local reads");
    mine.lastReadSeq = 4;
    await store.refreshConversation(c.conversationId);
    assert.equal((await read()).lastReadSeq, 4, "pending local changes do not block newer global reads");
    assert.equal((await read()).firstUnreadMentionSeq, undefined);
    await store.appendMessage({ conversationId: c.conversationId, clientMessageId: "m_global_read_5", senderId: "u_codex", content: "reply 5" });
    await store.sync();
    mine.lastReadSeq = 5;
    await store.pullAllConversationMessages();
    assert.equal((await read()).lastReadSeq, 5, "reconciliation applies reads even when no new messages arrived");
    off();
    passed++;
  } finally { await store.close(); }
}

// Contacts are the cloud friend relationships: after rebuilding the cache, locally registered agents regain contact status, nickname and persona; offline changes upload once online
{
  const cloud = fakeCloud();
  const claude = { localUuid: "claude-code@mac", kind: "claude-code", name: "Claude Code", version: "1.0" };
  cloud.state.agents.set("u_codex", { userId: "u_codex", displayName: "小c", persona: "严谨", isAgent: true });
  cloud.state.agents.set("u_claude_code", { userId: "u_claude_code", displayName: "Claude Code", isAgent: true });
  cloud.state.friends.add("u_codex");
  const root = rootFor();
  const store = await open(cloud, root);
  const agents = Object.fromEntries((await store.syncDiscoveredAgents([codex, claude])).map((agent) => [agent.userId, agent]));
  assert.equal(agents.u_codex.enabled, true, "Cloud friends are restored as contacts");
  assert.equal(agents.u_codex.displayName, "小c");
  assert.equal(agents.u_codex.persona, "严谨");
  assert.equal(agents.u_claude_code.enabled, false);
  assert.equal(store.pendingCount(), 0, "State restored from the cloud is not uploaded back");

  cloud.state.online = false;
  await store.sync();
  await store.updateAgent("u_claude_code", { enabled: true, displayName: "小cc" });
  await store.deleteContact("u_codex");
  assert.equal(store.pendingCount(), 2);
  cloud.state.online = true;
  await store.sync();
  assert.deepEqual([...cloud.state.friends], ["u_claude_code"]);
  assert.equal(cloud.state.agents.get("u_claude_code").displayName, "小cc");
  await store.close();

  const reopened = await open(cloud, root);
  const [again] = await reopened.syncDiscoveredAgents([codex]);
  assert.equal(again.enabled, false, "Already-registered agents follow local data and are not reverted by an old cloud snapshot");
  await reopened.close();
  passed++;
}

// Remote messages from the phone: messages other devices wrote to the cloud are pulled to the end locally and deduplicated by message ID; messages written locally are not duplicated when pulled back;
// conversations newly created on the phone are imported entirely when they first receive a message
{
  const cloud = fakeCloud();
  const store = await open(cloud);
  await store.syncDiscoveredAgents([codex]);
  const conversation = await store.createConversation({ name: "远程控制", memberIds: ["u_codex"] });
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_desk_1", senderId: "u_me", content: "电脑上发的" });
  await store.sync();
  assert.deepEqual(await store.pullConversationMessages(conversation.conversationId), [], "Messages written locally are deduplicated when pulled back");

  const phone = (conversationId, messageId, content) => {
    const remoteConversation = cloud.state.conversations.get(conversationId);
    const list = cloud.state.messages.get(conversationId) ?? [];
    list.push({ messageId, conversationId, seq: ++remoteConversation.lastSeq, senderId: "u_me", content, type: "USER", mentions: [], status: "SENT", gmtCreated: T0 });
    cloud.state.messages.set(conversationId, list);
  };
  phone(conversation.conversationId, "m_phone_1", "手机上发的");
  const added = await store.pullConversationMessages(conversation.conversationId);
  assert.deepEqual(added.map((m) => [m.messageId, m.seq, m.content]), [["m_phone_1", 2, "手机上发的"]]);
  assert.equal(added[0].createdAt, new Date(T0).toISOString(), "Delayed catch-up still shows send time, not receive time");
  assert.deepEqual(await store.pullConversationMessages(conversation.conversationId), [], "No new messages after the cursor means nothing more is appended");
  assert.equal(store.pendingCount(), 0, "Pulled messages are not uploaded back to the cloud");

  // agent replies are written locally and uploaded; phone and computer messages interleave and still are not duplicated when pulled back
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_codex_1", senderId: "u_codex", content: "收到" });
  phone(conversation.conversationId, "m_phone_2", "再来一条");
  await store.sync();
  assert.deepEqual((await store.pullConversationMessages(conversation.conversationId)).map((m) => m.messageId), ["m_phone_2"]);
  assert.deepEqual((await store.listMessages(conversation.conversationId)).map((m) => m.messageId), ["m_desk_1", "m_phone_1", "m_codex_1", "m_phone_2"]);

  // Conversation newly created on the phone: no local task exists, so import it during catch-up and file it under "No workspace"
  cloud.state.conversations.set("t_phone", {
    conversationId: "t_phone", name: "手机上建的", type: "DIRECT", creator: "u_me", owner: "u_me", lastSeq: 0, workspaceId: null,
    status: "ACTIVE", paused: false, autoTitle: false,
    members: [
      { userId: "u_me", role: "ENGINEER", lastReadSeq: 0, paused: false, resumeOnContinue: false },
      { userId: "u_codex", role: "ENGINEER", lastReadSeq: 0, paused: false, resumeOnContinue: false }
    ],
    gmtCreated: T0, gmtModified: T0
  });
  phone("t_phone", "m_phone_3", "帮我看看");
  const all = await store.pullAllConversationMessages();
  assert.deepEqual(all.map((m) => [m.conversationId, m.messageId, m.seq]), [["t_phone", "m_phone_3", 1]]);
  const imported = await store.getConversation("t_phone");
  assert.equal(imported.name, "手机上建的");
  assert.equal(imported.workspaceId, (await store.inboxWorkspace()).workspaceId);
  assert.deepEqual(await store.pullAllConversationMessages(), [], "Tasks already caught up are not requested again");
  await store.close();
  passed++;
}

// Attachments: register and upload to OSS before sending the message; on upload failure the whole entry stays queued for retry, never sending a message missing its attachment
{
  const cloud = fakeCloud();
  const store = await open(cloud);
  await store.syncDiscoveredAgents([codex]);
  const conversation = await store.createConversation({ name: "看图", memberIds: ["u_codex"] });
  const source = path.join(dir, "设计稿.png");
  await writeFile(source, "png-bytes");
  const attachment = await store.importAttachment(source);
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.name, "设计稿.png");

  cloud.state.failUploads = true;
  await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: "m_pic", senderId: "u_me", content: "", attachments: [attachment] });
  await store.sync();
  assert.equal((cloud.state.messages.get(conversation.conversationId) ?? []).length, 0, "Attachment not uploaded, so the message is held back");
  assert.equal(store.pendingCount(), 1, "Stays in the queue awaiting retry");

  cloud.state.failUploads = false;
  await store.sync();
  const [sent] = cloud.state.messages.get(conversation.conversationId);
  assert.deepEqual(sent.attachments.map((item) => item.attachmentId), [attachment.attachmentId]);
  const uploaded = cloud.state.attachments.get(attachment.attachmentId);
  assert.equal(uploaded.content, "png-bytes", "Uploads the copy in the attachments directory");
  assert.equal(uploaded.uploadedAs, "image/png", "Content-Type matches registration");
  const order = cloud.state.calls.filter((call) => call.method === "POST" && call.route.includes(conversation.conversationId)).map((call) => call.route.split("/").pop());
  assert.deepEqual(order.slice(-2), ["attachments", "messages"], "Registers the attachment before sending the message");
  assert.equal(store.pendingCount(), 0);
  await store.close();
  passed++;
}

// Agent final image and document links use the same private attachment transport, attributed
// to the Agent, and a separate client can download them without the source path.
{
  const cloud = fakeCloud();
  const store = await open(cloud);
  let peer;
  const server = http.createServer((request, response) => {
    const attachment = cloud.state.attachments.get(request.url.slice(1));
    response.end(attachment?.content ?? '');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    cloud.state.downloadBase = `http://127.0.0.1:${server.address().port}/`;
    const [agent] = await store.syncDiscoveredAgents([codex]);
    const conversation = await store.createConversation({ name: 'Agent image delivery', memberIds: [agent.userId] });
    await store.appendMessage({ conversationId: conversation.conversationId, clientMessageId: 'image-request', senderId: me.userId, content: '直接把图发上来' });
    await store.sync();
    const source = path.join(dir, 'agent-screenshot.svg');
    const imageBytes = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';
    await writeFile(source, imageBytes);
    const document = path.join(dir, 'agent-report.pdf');
    const documentBytes = '%PDF-1.7\nattachment transport fixture';
    await writeFile(document, documentBytes);
    cloud.state.failUploads = true;
    const scheduler = new LocalScheduler({ idleRetryLimit: 0, teamMonitorIntervalMs: 0, store,
      registry: { runTurn: async () => ({ ok: true, message: `这是截图：![预览](<${source}>)\n[报告](<${document}>)`, steps: [], metrics: { iterations: 1, sideEffects: false } }) },
      syncer: { ensureSynced: async () => [] }, resolveWorkspace: async () => ({ workspacePath: dir, sharesKnowledge: false }),
      resolveDiscovered: () => codex, isAgentReady: () => true, broadcast: () => {}, log: async () => {} });
    await scheduler.runAgentTurn(conversation, agent);
    await store.sync();
    assert.equal(cloud.state.messages.get(conversation.conversationId).length, 1, 'upload failure never publishes a reply with missing images');
    cloud.state.failUploads = false;
    await store.sync();
    const sent = cloud.state.messages.get(conversation.conversationId).at(-1);
    assert.equal(sent.senderId, agent.userId);
    assert.equal(sent.content, '这是截图：预览\n报告');
    assert.equal(sent.attachments.length, 2);
    const uploaded = cloud.state.attachments.get(sent.attachments[0].attachmentId);
    assert.equal(uploaded.uploader, agent.userId, 'upload ticket and message use the same Agent sender');
    assert.equal(uploaded.content, imageBytes);
    peer = await open(cloud);
    await peer.pullConversationMessages(conversation.conversationId);
    const received = (await peer.listMessages(conversation.conversationId)).find(m => m.messageId === sent.messageId);
    assert.equal(received.content.includes(source), false);
    assert.equal(received.attachments[0].kind, 'image', 'phone/desktop receive native image metadata');
    assert.equal(await readFile(await peer.attachmentFile(conversation.conversationId, received.attachments[0]), 'utf8'), imageBytes);
    assert.equal(received.attachments[1].kind, 'file');
    assert.equal(received.attachments[1].mimeType, 'application/pdf');
    assert.equal(await readFile(await peer.attachmentFile(conversation.conversationId, received.attachments[1]), 'utf8'), documentBytes);
    passed++;
  } finally {
    await peer?.close();
    await store.close();
    await new Promise(resolve => server.close(resolve));
  }
}

// Attachments from another client (phone): pulled messages carry metadata, downloaded locally on first use, then the local copy is used
{
  const cloud = fakeCloud();
  let downloads = 0;
  const server = http.createServer((request, response) => {
    downloads++;
    response.end(`content of ${request.url}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cloud.state.downloadBase = `http://127.0.0.1:${server.address().port}/get/`;
  const store = await open(cloud);
  await store.syncDiscoveredAgents([codex]);
  const conversation = await store.createConversation({ name: "手机发图", memberIds: ["u_codex"] });
  await store.sync();
  cloud.state.attachments.set("f_phone", { attachmentId: "f_phone", name: "照片.jpg", mimeType: "image/jpeg", size: 20, conversationId: conversation.conversationId, uploader: "u_me", uploaded: true });
  await cloud.api("POST", `/api/v1/conversations/${conversation.conversationId}/messages`, { messageId: "m_phone_pic", content: "", type: "USER", attachments: ["f_phone"] });

  const [pulled] = await store.pullConversationMessages(conversation.conversationId);
  assert.equal(pulled.content, "");
  assert.deepEqual(pulled.attachments, [{ attachmentId: "f_phone", name: "照片.jpg", mimeType: "image/jpeg", size: 20, kind: "image" }]);

  const [first, second] = await Promise.all([
    store.attachmentFile(conversation.conversationId, pulled.attachments[0]),
    store.attachmentFile(conversation.conversationId, pulled.attachments[0])
  ]);
  assert.equal(first, second);
  assert.equal(downloads, 1, "Two concurrent requests download only once");
  assert.equal(await readFile(first, "utf8"), "content of /get/f_phone");
  assert.ok(first.endsWith(path.join("f_phone", "照片.jpg")), "Local file keeps its original name so the agent can recognize it");
  await store.attachmentFile(conversation.conversationId, pulled.attachments[0]);
  assert.equal(downloads, 1, "Already-downloaded files use the local copy");

  // Deleting a task also deletes its attachments
  await store.deleteConversation(conversation.conversationId);
  await assert.rejects(readFile(first, "utf8"));
  server.close();
  await store.close();
  passed++;
}

// Lost push + concurrent polling: a message is returned for dispatch only once, including after restart.
{
  const cloud = fakeCloud(); const root = rootFor(); let store = await open(cloud, root);
  try {
    await store.syncDiscoveredAgents([codex]);
    const c = await store.createConversation({ name: "missed notification", memberIds: ["u_codex"] });
    await store.sync();
    await cloud.api("POST", `/api/v1/conversations/${c.conversationId}/messages`, { messageId: "m_missed", content: "retry", type: "USER" });
    const pulls = await Promise.all([store.pullAllConversationMessages(), store.pullConversationMessages(c.conversationId)]);
    assert.equal(pulls.flat().filter(m => m.messageId === "m_missed").length, 1);
    await store.ackDispatched(pulls.flat());
    await store.close(); store = await open(cloud, root);
    assert.deepEqual(await store.pullAllConversationMessages(), [], "persisted cursor and message ID prevent replay after restart");
    // Exercise keyset pagination without creating a thousand local conversations.
    const original = cloud.api;
    const routes = [];
    const target = cloud.state.conversations.get(c.conversationId);
    const paging = { ...cloud, api: async (method, route, body) => {
      if (route.includes("/sync-cursors?")) {
        routes.push(route);
        const after = new URL(route, "http://test").searchParams.get("afterId");
        return { ok: true, data: after === "0"
          ? Array.from({length:1000},(_,i) => ({syncId:i+1,conversationId:c.conversationId,lastSeq:target.lastSeq}))
          : [{syncId:1001,conversationId:c.conversationId,lastSeq:target.lastSeq}] };
      }
      return original(method,route,body);
    }};
    await store.close(); store = await open(paging,root);
    assert.deepEqual(await store.pullAllConversationMessages(), []);
    assert.equal(routes.length,2); assert.ok(routes[1].includes("afterId=1000"));
    passed++;
  } finally { await store.close(); }
}

// A failed later summary page must still deliver messages fetched on earlier pages.
{
  const cloud = fakeCloud(); const root = rootFor(); let store = await open(cloud, root);
  try {
    await store.syncDiscoveredAgents([codex]);
    const c = await store.createConversation({ name: "partial reconciliation", memberIds: ["u_codex"] });
    await store.sync(); await store.close();
    await cloud.api("POST", `/api/v1/conversations/${c.conversationId}/messages`, { messageId: "m_partial", content: "keep this", type: "USER" });
    const original = cloud.api;
    const flaky = { ...cloud, api: async (method,route,body) => {
      if (route.includes("/sync-cursors?")) {
        if (!route.includes("afterId=0&")) throw new Error("later page disconnected");
        return {ok:true,data:Array.from({length:1000},(_,i)=>({syncId:i+1,conversationId:c.conversationId,lastSeq:1}))};
      }
      return original(method,route,body);
    }};
    store = await open(flaky,root);
    const partial = await store.pullAllConversationMessages();
    assert.deepEqual(partial.map(m=>m.messageId),["m_partial"]);
    await store.ackDispatched(partial);
    passed++;
  } finally { await store.close(); }
}

// Receive times persisted before upgrade: going offline does not lose the chance to fix them; reconnecting only fixes times, without resending or rerunning old messages.
{
  const cloud = fakeCloud();
  const root = rootFor();
  let store = await open(cloud, root);
  try {
    await store.syncDiscoveredAgents([codex]);
    const c = await store.createConversation({ name: "发送时间", memberIds: ["u_codex"] });
    const sentAt = "2026-10-26T06:50:00.000Z";
    await store.appendMessage({ conversationId: c.conversationId, clientMessageId: "m_local_time", senderId: "u_me", content: "本机离线发送", createdAt: sentAt });
    await store.sync();
    const remoteLocal = cloud.state.messages.get(c.conversationId)[0];
    remoteLocal.gmtCreated = "2026-10-26T14:50:05+08:00";
    await cloud.api("POST", `/api/v1/conversations/${c.conversationId}/messages`, { messageId: "m_delayed_time", content: "白天发送", type: "USER" });
    cloud.state.messages.get(c.conversationId)[1].gmtCreated = "2026-10-26T14:51:49+08:00";
    const [received] = await store.pullConversationMessages(c.conversationId);
    assert.equal(received.createdAt, "2026-10-26T06:51:49.000Z", "Cloud timestamps with time zones are normalized to UTC");
    await store.markRead(c.conversationId, 2);
    await store.sync();
    await store.close();

    const journal = path.join(root, "messages", `${c.conversationId}.jsonl`);
    const oldMessages = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    oldMessages[1].createdAt = "2026-10-26T14:04:01.870Z";
    await writeFile(journal, oldMessages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    await writeFile(path.join(root, "cloud-cursors.json"), JSON.stringify({ [c.conversationId]: 2 }));

    cloud.state.online = false;
    store = await open(cloud, root);
    assert.deepEqual(await store.pullAllConversationMessages(), []);
    assert.equal((await store.listMessages(c.conversationId))[1].createdAt, oldMessages[1].createdAt);
    const events = [];
    store.subscribe((event) => events.push(event));
    cloud.state.online = true;
    assert.deepEqual(await store.pullAllConversationMessages(), [], "Correcting existing messages does not hand them to the scheduler again");
    const fixed = await store.listMessages(c.conversationId);
    assert.equal(fixed[0].createdAt, sentAt, "Local send time is earlier than server storage time, so keep the original local send time");
    assert.deepEqual(fixed[1], { ...oldMessages[1], createdAt: "2026-10-26T06:51:49.000Z" }, "Only the time changes; content, order and other fields are kept");
    assert.equal((await store.getConversation(c.conversationId)).members.find((m) => m.userId === "u_me").lastReadSeq, 2);
    assert.equal(events.filter((e) => e.type === "message").length, 0);
    assert.deepEqual(events.find((e) => e.type === "message-times").times, [{ messageId: "m_delayed_time", createdAt: "2026-10-26T06:51:49.000Z" }]);
    assert.equal(store.pendingCount(), 0, "Time correction does not create an upload queue");
    await store.close();
    store = await open(cloud, root);
    assert.equal((await store.listMessages(c.conversationId))[1].createdAt, "2026-10-26T06:51:49.000Z", "Correction persists after restart");
    assert.deepEqual(await store.pullAllConversationMessages(), []);
    passed++;
  } finally { await store.close(); }
}

// After upgrade the cursor resets and everything is pulled again: old tasks missing from the local cache are imported; history already replied to or processed by an Agent only goes into the cache and is not handed to the scheduler again.
{
  const cloud = fakeCloud();
  const root = rootFor();
  let store = await open(cloud, root);
  try {
    await store.syncDiscoveredAgents([codex]);
    await store.close();
    // Old-format cursor (no version): always pull from zero after upgrade
    await writeFile(path.join(root, "cloud-cursors.json"), JSON.stringify({ t_old: 4 }));
    store = await open(cloud, root);
    const remoteTask = (conversationId, lastProcessedSeq, history) => {
      cloud.state.conversations.set(conversationId, {
        conversationId, name: conversationId, type: "DIRECT", creator: "u_me", owner: "u_me", lastSeq: history.length, workspaceId: null,
        status: "ACTIVE", paused: false, autoTitle: false,
        members: [
          { userId: "u_me", role: "ENGINEER", lastReadSeq: history.length, paused: false, resumeOnContinue: false },
          { userId: "u_codex", role: "ENGINEER", lastReadSeq: 0, lastProcessedSeq, paused: false, resumeOnContinue: false }
        ],
        gmtCreated: T0, gmtModified: T0
      });
      cloud.state.messages.set(conversationId, history.map(([messageId, senderId], i) => ({
        messageId, conversationId, seq: i + 1, senderId, content: messageId, type: "USER", mentions: [], status: "SENT", gmtCreated: T0
      })));
    };
    // Old task: asked, Agent answered, and the last message also has a reply
    remoteTask("t_old", null, [["m_old_ask", "u_me"], ["m_old_reply", "u_codex"], ["m_old_ask_2", "u_me"], ["m_old_reply_2", "u_codex"]]);
    // Relying only on the cloud processed watermark: Agent processed up to 1, the message after it has no reply yet
    remoteTask("t_processed", 1, [["m_done", "u_me"], ["m_waiting", "u_me"]]);
    // After the reply the user sent another message with no Agent response yet: still must run
    remoteTask("t_followup", null, [["m_q", "u_me"], ["m_a", "u_codex"], ["m_followup", "u_me"]]);
    const added = await store.pullAllConversationMessages();
    assert.deepEqual(added.map((m) => m.messageId).sort(), ["m_followup", "m_waiting"], "Only messages no Agent has responded to are handed to the scheduler");
    assert.deepEqual((await store.listMessages("t_old")).map((m) => m.messageId), ["m_old_ask", "m_old_reply", "m_old_ask_2", "m_old_reply_2"], "History goes into the local cache as usual");
    assert.deepEqual(await store.pullAllConversationMessages(), [], "Nothing returned once caught up");
    passed++;
  } finally { await store.close(); }
}

// Import spanning multiple pages fails on page two and then restarts: resumed pulling still skips replied history using the import-time boundary, and truly new messages run as usual.
{
  const cloud = fakeCloud();
  const root = rootFor();
  const original = cloud.api;
  let pages = 0, failNext = true;
  // Fake cloud paginates by limit; the second page request fails once during import
  const api = async (method, route, body) => {
    const url = new URL(route, "http://cloud");
    if (method === "GET" && url.pathname === "/api/v1/conversations/t_big/messages") {
      if (++pages === 2 && failNext) {
        failNext = false;
        return { ok: false, kind: "rejected", status: 500, code: "SYS_001", message: "page failed" };
      }
      const result = await original(method, route, body);
      return result.ok ? { ...result, data: result.data.slice(0, Number(url.searchParams.get("limit"))) } : result;
    }
    return original(method, route, body);
  };
  const create = async () => {
    const store = new CloudStore({ root, user: me, api, agentUserId: async (agent) => `u_${agent.kind}`, retryMs: 60_000 });
    await store.init();
    return store;
  };
  let store = await create();
  try {
    await store.syncDiscoveredAgents([codex]);
    const history = Array.from({ length: 1500 }, (_, i) => {
      const senderId = i % 2 ? "u_codex" : "u_me";
      return { messageId: `m_big_${i + 1}`, conversationId: "t_big", seq: i + 1, senderId, content: `${i + 1}`, type: "USER", mentions: [], status: "SENT", gmtCreated: T0 };
    });
    cloud.state.conversations.set("t_big", {
      conversationId: "t_big", name: "t_big", type: "DIRECT", creator: "u_me", owner: "u_me", lastSeq: history.length, workspaceId: null,
      status: "ACTIVE", paused: false, autoTitle: false,
      members: [
        { userId: "u_me", role: "ENGINEER", lastReadSeq: history.length, paused: false, resumeOnContinue: false },
        { userId: "u_codex", role: "ENGINEER", lastReadSeq: 0, lastProcessedSeq: null, paused: false, resumeOnContinue: false }
      ],
      gmtCreated: T0, gmtModified: T0
    });
    cloud.state.messages.set("t_big", history);
    assert.deepEqual(await store.pullAllConversationMessages(), [], "First page is all replied history");
    assert.equal((await store.getConversation("t_big")).lastSeq, 1000, "Second page failed; only the first page was imported");
    const saved = JSON.parse(await readFile(path.join(root, "cloud-cursors.json"), "utf8"));
    assert.equal(saved.cursors.t_big, 1000);
    assert.equal(saved.importing.t_big, 1000, "Import boundary persisted");
    await store.close();
    // User sent another message during restart, no Agent response yet
    history.push({ messageId: "m_big_new", conversationId: "t_big", seq: 1501, senderId: "u_me", content: "new", type: "USER", mentions: [], status: "SENT", gmtCreated: T0 });
    cloud.state.conversations.get("t_big").lastSeq = 1501;
    store = await create();
    const added = await store.pullAllConversationMessages();
    assert.deepEqual(added.map((m) => m.messageId), ["m_big_new"], "Remaining history skips the scheduler; new messages run as usual");
    assert.equal((await store.getConversation("t_big")).lastSeq, 1501, "Full history enters the local cache");
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "cloud-cursors.json"), "utf8")).importing, {}, "Import boundary cleared after pulling completes");
    assert.deepEqual(await store.pullAllConversationMessages(), []);
    passed++;
  } finally { await store.close(); }
}

// A registration failure must not permanently strand a provisional local identity.
{
  const cloud = fakeCloud(), root = rootFor();
  let registered = false, previous;
  const original = cloud.api;
  const api = async (method, route, body) => {
    if (method === 'POST' && route === '/api/v1/conversations' && body.members.some(m => m.userId === previous)) {
      return {ok:false,kind:'rejected',status:404,code:'AGENT_001',message:'Agent missing'};
    }
    return original(method, route, body);
  };
  const create = async () => {const store=new CloudStore({root,user:me,api,agentUserId:async()=>registered?'u_canonical':undefined,retryMs:60000});await store.init();return store;};
  let store = await create();
  try {
    const [agent] = await store.syncDiscoveredAgents([codex]); previous=agent.userId;
    await store.updateContact(previous,{enabled:true,displayName:'preserved contact',persona:'preserved persona'});
    const c=await store.createConversation({name:'preserve history',memberIds:[previous]});
    await store.appendMessage({conversationId:c.conversationId,clientMessageId:'m_identity_human',senderId:me.userId,content:'original human text'});
    await store.appendMessage({conversationId:c.conversationId,clientMessageId:'m_identity_agent',senderId:previous,content:previous,mentions:[previous]});
    await store.saveAgentSession({conversationId:c.conversationId,agentUserId:previous,providerThreadId:'native-session-preserved'});
    await store.sync();
    assert.ok((await store.listMessages(c.conversationId)).every(m=>m.status==='FAILED'));
    registered=true;
    const [fixed]=await store.syncDiscoveredAgents([codex]);assert.equal(fixed.userId,'u_canonical');
    assert.equal(fixed.enabled,true);assert.equal(fixed.displayName,'preserved contact');assert.equal(fixed.persona,'preserved persona');
    await store.sync();
    assert.ok((await store.getConversation(c.conversationId)).members.some(m=>m.userId==='u_canonical'));
    const messages=await store.listMessages(c.conversationId);
    assert.ok(messages.every(m=>m.status!=='FAILED'));
    assert.equal(messages[1].senderId,'u_canonical');assert.equal(messages[1].content,previous,'message bytes are preserved');
    assert.deepEqual(messages[1].mentions,['u_canonical']);
    assert.equal((await store.getAgentSession(c.conversationId,'u_canonical')).providerThreadId,'native-session-preserved');
    assert.equal(cloud.state.messages.get(c.conversationId).length,2,'both messages uploaded once');
    assert.ok(cloud.state.friends.has('u_canonical'),'the repaired identity stays in contacts');
    await store.close();store=await create();
    assert.ok((await store.listMessages(c.conversationId)).every(m=>m.status!=='FAILED'),'recovery survives restart');
    await store.syncDiscoveredAgents([codex]);await store.sync();
    assert.equal(cloud.state.messages.get(c.conversationId).length,2,'recovery is idempotent');
    passed++;
  } finally {await store.close();}
}

// Crash after appending to the local cache but before handing to the scheduler: after restart the same message is handed over again; nothing returned after dispatch is confirmed
{
  const cloud = fakeCloud(); const root = rootFor(); let store = await open(cloud, root);
  try {
    await store.syncDiscoveredAgents([codex]);
    const c = await store.createConversation({ name: "dispatch crash", memberIds: ["u_codex"] });
    await store.sync();
    await cloud.api("POST", `/api/v1/conversations/${c.conversationId}/messages`, { messageId: "m_crash", content: "do it", type: "USER" });
    // Crash while writing the local cache: pending dispatch was persisted first and the cursor did not move
    const append = store.cache.appendMessage.bind(store.cache);
    store.cache.appendMessage = async () => { throw new Error("crash during append"); };
    await assert.rejects(store.pullConversationMessages(c.conversationId), /crash during append/);
    const onDisk = JSON.parse(await readFile(path.join(root, "cloud-cursors.json"), "utf8"));
    assert.equal(onDisk.dispatching[c.conversationId].m_crash, 1, "Pending dispatch persisted before appending");
    store.cache.appendMessage = append;
    await store.close(); store = await open(cloud, root);
    // This append succeeds and is returned to main, but crashes before reaching the scheduler (no confirmation)
    assert.deepEqual((await store.pullAllConversationMessages()).map((m) => m.messageId), ["m_crash"]);
    assert.deepEqual(await store.pullAllConversationMessages(), [], "Not returned twice within the same run");
    await store.close(); store = await open(cloud, root);
    const again = await store.pullAllConversationMessages();
    assert.deepEqual(again.map((m) => m.messageId), ["m_crash"], "After restart local cache dedup cannot block it: still pending dispatch, so hand it over again");
    assert.deepEqual(await store.pullConversationMessages(c.conversationId), [], "Push-triggered single-task catch-up does not return duplicates either");
    await store.ackDispatched(again);
    assert.equal(JSON.parse(await readFile(path.join(root, "cloud-cursors.json"), "utf8")).dispatching[c.conversationId], undefined, "Removed from disk after confirmation");
    await store.close(); store = await open(cloud, root);
    assert.deepEqual(await store.pullAllConversationMessages(), [], "Not returned after restart once dispatch is confirmed");
    assert.equal((await store.listMessages(c.conversationId)).filter((m) => m.messageId === "m_crash").length, 1);
    // Imported task: history before the boundary does not enter pending dispatch, while unreplied new messages are still protected
    cloud.state.conversations.set("t_imp", {
      conversationId: "t_imp", name: "导入", type: "DIRECT", creator: "u_me", owner: "u_me", lastSeq: 3, workspaceId: "w_inbox",
      status: "ACTIVE", paused: false, autoTitle: false,
      members: [
        { userId: "u_me", role: "ENGINEER", lastReadSeq: 3, paused: false, resumeOnContinue: false },
        { userId: "u_codex", role: "ENGINEER", lastReadSeq: 0, paused: false, resumeOnContinue: false, isAgent: true }
      ],
      gmtCreated: T0, gmtModified: T0
    });
    cloud.state.messages.set("t_imp", [
      { messageId: "m_imp_old", conversationId: "t_imp", seq: 1, senderId: "u_me", content: "old", type: "USER", mentions: [], status: "SENT", gmtCreated: T0 },
      { messageId: "m_imp_reply", conversationId: "t_imp", seq: 2, senderId: "u_codex", content: "done", type: "USER", mentions: [], status: "SENT", gmtCreated: T0 },
      { messageId: "m_imp_new", conversationId: "t_imp", seq: 3, senderId: "u_me", content: "new", type: "USER", mentions: [], status: "SENT", gmtCreated: T0 }
    ]);
    assert.deepEqual((await store.pullAllConversationMessages()).map((m) => m.messageId), ["m_imp_new"]);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(root, "cloud-cursors.json"), "utf8")).dispatching.t_imp), ["m_imp_new"]);
    await store.close(); store = await open(cloud, root);
    const imported = await store.pullAllConversationMessages();
    assert.deepEqual(imported.map((m) => m.messageId), ["m_imp_new"], "Unconfirmed new messages after import are handed over again after restart; history is not");
    await store.ackDispatched(imported);
    // Task deleted locally: pending dispatch is cleared with it
    await cloud.api("POST", `/api/v1/conversations/t_imp/messages`, { messageId: "m_imp_more", content: "more", type: "USER" });
    await store.pullConversationMessages("t_imp");
    await store.deleteConversation("t_imp");
    assert.equal(JSON.parse(await readFile(path.join(root, "cloud-cursors.json"), "utf8")).dispatching.t_imp, undefined);
    passed++;
  } finally { await store.close(); }
}

// Two computers share a conversation: one changes settings, and the other's stale cache must not overwrite them and must catch up
{
  const cloud = fakeCloud();
  const a = await open(cloud);
  const b = await open(cloud);
  const puts = () => cloud.state.calls.filter((call) => call.method === "PUT" && /\/conversations\/[^/]+$/.test(call.route));
  try {
    await a.syncDiscoveredAgents([codex]);
    await b.syncDiscoveredAgents([codex]);
    const created = await a.createConversation({ name: "狗剩吧", type: "GROUP", memberIds: ["u_codex", "u_friend"] });
    const id = created.conversationId;
    await a.sync();
    await b.pullConversationMessages(id);
    assert.equal((await b.getConversation(id)).charter, undefined);

    await a.updateConversation(id, { permanent: true, charter: { goal: "无", instructions: "别发了" } });
    await a.setMemberRole(id, "u_codex", "LEADER");
    await a.sync();

    // B has not received the push yet and only processes messages and marks read: only align watermarks, do not write settings
    const before = puts().length;
    await b.markRead(id, me.userId, 0);
    await b.markProcessed(id, "u_codex", 0);
    await b.sync();
    assert.equal(puts().length, before, "Watermark sync does not write conversation settings");
    assert.deepEqual(cloud.state.conversations.get(id).extra.charter, { goal: "无", instructions: "别发了" });
    assert.equal(cloud.state.conversations.get(id).extra.permanent, true);
    assert.equal(cloud.state.conversations.get(id).members.find((m) => m.userId === "u_codex").role, "LEADER", "Stale role is not written back");

    // B catches up on settings after receiving the push
    await b.refreshConversation(id);
    const synced = await b.getConversation(id);
    assert.equal(synced.permanent, true);
    assert.equal(synced.charter.goal, "无");
    assert.equal(synced.members.find((m) => m.userId === "u_codex").role, "LEADER");

    // When the settings dialog saves all fields together, only truly changed fields are uploaded; the permanent flag just changed on the other computer is not overwritten
    await a.updateConversation(id, { permanent: false });
    await a.sync();
    await b.updateConversation(id, { name: "狗剩吧2", permanent: true, charter: synced.charter });
    await b.sync();
    const remote = cloud.state.conversations.get(id);
    assert.equal(remote.name, "狗剩吧2");
    assert.equal(remote.extra.permanent, false, "Fields B did not touch are not uploaded (B's local value true comes from a stale cache)");
    await a.refreshConversation(id);
    assert.equal((await a.getConversation(id)).name, "狗剩吧2");
    assert.equal((await a.getConversation(id)).permanent, false);

    // Fields not yet uploaded locally are not overwritten by the cloud; other fields catch up as usual
    cloud.state.online = false;
    await a.updateConversation(id, { charter: { goal: "本机新目标" } });
    cloud.state.online = true;
    cloud.state.conversations.get(id).name = "别处改名";
    cloud.state.conversations.get(id).extra = { ...cloud.state.conversations.get(id).extra, charter: { goal: "云端旧目标" } };
    await a.refreshConversation(id);
    assert.equal((await a.getConversation(id)).charter.goal, "本机新目标");
    assert.equal((await a.getConversation(id)).name, "别处改名");
    await a.sync();
    assert.equal(cloud.state.conversations.get(id).extra.charter.goal, "本机新目标");
    assert.equal(cloud.state.conversations.get(id).name, "别处改名", "Only charter is uploaded; the old name is not sent back");

    // Collaboration strategy belongs only to the leading computer: A's mode is not dropped when B changes the goal, and does not follow to B
    await a.updateConversation(id, { charter: { goal: "本机新目标", mode: "execution" } });
    await a.sync();
    await b.refreshConversation(id);
    assert.equal((await b.getConversation(id)).charter.goal, "本机新目标");
    assert.equal((await b.getConversation(id)).charter.mode, undefined);
    await b.updateConversation(id, { charter: { goal: "B 的目标" } });
    await b.sync();
    assert.deepEqual(cloud.state.conversations.get(id).extra.charter, { goal: "B 的目标", mode: "execution" });
    await a.refreshConversation(id);
    assert.deepEqual((await a.getConversation(id)).charter, { goal: "B 的目标", mode: "execution" });

    // Cloud charter was wholly overwritten and lost by an old client: a computer with a copy uploads it back and the cloud recovers
    delete cloud.state.conversations.get(id).extra.charter;
    await a.refreshConversation(id);
    await a.sync();
    assert.equal(cloud.state.conversations.get(id).extra.charter.goal, "B 的目标");

    assert.equal(a.pendingCount(), 0);
    passed++;
  } finally { await a.close(); await b.close(); }
}

console.log(`cloud-store: ${passed} passed, 0 failed`);
