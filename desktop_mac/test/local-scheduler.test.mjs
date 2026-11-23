import assert from "node:assert/strict";
import { LocalScheduler } from "../dist/orchestration/local-scheduler.js";

let passed = 0;
function check(name, condition, detail) {
  assert.ok(condition, `${name}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
  passed += 1;
}

const me = { userId: "me", displayName: "我", isAgent: false };
const ready = {
  userId: "agent-ready",
  displayName: "小c",
  isAgent: true,
  kind: "codex"
};
const unavailable = {
  userId: "agent-unavailable",
  displayName: "小q",
  isAgent: true,
  kind: "qoder"
};
const human = { userId: "human", displayName: "同事", isAgent: false };
const users = new Map([me, ready, unavailable, human].map((user) => [user.userId, user]));
const conversation = {
  conversationId: "task-1",
  type: "DIRECT",
  name: "验证独立调度器",
  workspaceId: "workspace-1",
  creator: me.userId,
  owner: me.userId,
  lastSeq: 1,
  members: [me, ready, unavailable, human].map((user) => ({
    userId: user.userId,
    role: user.userId === me.userId ? "LEADER" : "ENGINEER",
    lastReadSeq: 0
  })),
  charter: { goal: "确认消息经过调度器到达 Agent" },
  status: "ACTIVE",
  paused: false,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z"
};
const incoming = {
  messageId: "message-1",
  conversationId: conversation.conversationId,
  seq: 1,
  senderId: me.userId,
  content: "开始",
  type: "USER",
  mentions: [],
  status: "SENT",
  createdAt: "2026-09-04T00:00:00.000Z"
};

const appended = [];
const reads = [];
const updates = [];
const broadcasts = [];
let receivedPrompt = "";

const store = {
  currentUser: async () => me,
  getUser: async (userId) => users.get(userId) ?? null,
  getWorkspace: async () => ({
    workspaceId: "workspace-1",
    name: "无工作区",
    kind: "inbox"
  }),
  getAgentSession: async () => null,
  saveAgentSession: async () => {},
  listMemories: async () => [],
  listMessages: async () => [incoming, ...appended],
  markProcessed: async (conversationId, userId, seq) => reads.push({ conversationId, userId, seq }),
  appendMessage: async (input) => {
    const message = { ...incoming, ...input, messageId: `reply-${appended.length + 1}`, seq: 2 };
    appended.push(message);
    return message;
  },
  listConversations: async () => [conversation],
  getConversation: async () => conversation,
  updateConversation: async (_conversationId, patch) => {
    updates.push(patch);
    return { ...conversation, ...patch };
  },
  setConversationPaused: async (_conversationId, paused) => {
    updates.push({ paused });
    conversation.paused = paused;
    return conversation;
  },
  setMemberPaused: async (_conversationId, userId, paused) => {
    const member = conversation.members.find((item) => item.userId === userId);
    if (member) member.paused = paused;
    updates.push({ userId, paused });
    return conversation;
  }
};

const registry = {
  runTurn: async (_agent, input) => {
    receivedPrompt = input.prompt;
    return {
      ok: true,
      message: "收到",
      threadId: "thread-1",
      steps: ["完成"],
      metrics: { iterations: 1, sideEffects: false }
    };
  },
  cancel: async () => true
};

const scheduler = new LocalScheduler({idleRetryLimit:0,
  store,
  registry,
  syncer: { ensureSynced: async () => [] },
  resolveWorkspace: async () => ({
    workspacePath: "/tmp/ading-scheduler-test",
    sharesKnowledge: false
  }),
  resolveDiscovered: (userId) =>
    userId === ready.userId
      ? { kind: "codex", localUuid: "codex@test" }
      : undefined,
  isAgentReady: (agent) => agent.userId === ready.userId,
  broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  log: async () => {}
});

const targets = await scheduler.pickTargets(conversation, incoming);
check("Only ready Agents are selected", targets.length === 1 && targets[0].userId === ready.userId, targets);
check(
  "Paused tasks select no Agent",
  (await scheduler.pickTargets({ ...conversation, paused: true }, incoming)).length === 0
);
check(
  "Individually paused Agents are not selected",
  (await scheduler.pickTargets({
    ...conversation,
    members: conversation.members.map((member) =>
      member.userId === ready.userId ? { ...member, paused: true } : member
    )
  }, incoming)).length === 0
);

await scheduler.runAgentTurn(conversation, ready);
check("Turn reply is stored normally", appended.at(-1)?.content === "收到", appended);
check("Agent read watermark advances normally", reads.at(-1)?.seq === incoming.seq, reads);
check(
  "Direct chat passes the message without injecting the task goal",
  receivedPrompt.includes("开始") &&
    !receivedPrompt.includes("会话目标：确认消息经过调度器到达 Agent")
);
// User text gets no speaker prefix: it is sent as-is to the vendor as this turn's input, and with a prefix
// what the user sees in the vendor's own UI would no longer be their original words.
check("User's original words get no \"User:\" prefix", !receivedPrompt.includes("用户：开始"));
const busyBroadcasts = broadcasts.filter(event => event.channel === "agent:busy");
check(
  "Busy state is broadcast in pairs",
  busyBroadcasts.length === 2 &&
    busyBroadcasts[0].payload.busy === true &&
    busyBroadcasts[1].payload.busy === false,
  broadcasts
);

await scheduler.stopConversation(conversation.conversationId);
check(
  "Stop is persisted and stays paused after restart",
  conversation.paused === true,
  updates
);

conversation.paused = false;
conversation.members.find((member) => member.userId === ready.userId).role = "LEADER";
await assert.rejects(() => scheduler.reportConversation(conversation.conversationId), /单聊会话不需要汇报/);
check("Direct-chat tasks cannot request a Leader report", true);
conversation.type = "GROUP";
const report = await scheduler.reportConversation(conversation.conversationId);
check("Leader report is stored as an ordinary chat message", report.content === "收到", report);
check(
  "Leader receives the phase-report instruction and discussion log",
  receivedPrompt.includes("阶段汇报") && receivedPrompt.includes("我：开始"),
  receivedPrompt
);
check("Prompts sent to Agents do not say \"master\" and use the task initiator's name", !receivedPrompt.includes("主人"), receivedPrompt.slice(0, 200));
{
  const { addressOwner } = await import("../dist/orchestration/owner-name.js");
  check("\"Master\" replaced with the nickname", addressOwner("请主人确认，主人的原始消息", "示例用户") === "请示例用户确认，示例用户的原始消息");
  check("Neutral address when there is no name", addressOwner("请主人确认", "") === "请会话发起人确认");
}
conversation.paused = true;
await assert.rejects(() => scheduler.reportConversation(conversation.conversationId), /最新一条消息已经是汇报/);
check("Old paused flag does not block an explicit report request", conversation.paused === false, conversation);
conversation.paused = false;
await assert.rejects(() => scheduler.reportConversation(conversation.conversationId), /最新一条消息已经是汇报/);
check("Cannot report consecutively when the latest message is already a report", true);

// Messages arriving while the Agent is busy must not be lost: record the watermark first and merge them into a follow-up push after the current turn.
const queueConversation = {
  ...conversation,
  conversationId: "conversation-queue",
  lastSeq: 1,
  members: [
    { userId: me.userId, role: "LEADER", lastReadSeq: 1 },
    { userId: ready.userId, role: "ENGINEER", lastReadSeq: 0 }
  ],
  paused: false
};
const firstQueueMessage = { ...incoming, conversationId: queueConversation.conversationId };
const queueMessages = [firstQueueMessage];
const queuePrompts = [];
const queueReplies = [];
const queueBroadcasts = [];
let releaseFirstTurn;
const firstTurnGate = new Promise((resolve) => {
  releaseFirstTurn = resolve;
});
let queueRunCount = 0;

const queueStore = {
  currentUser: async () => me,
  getUser: async (userId) => users.get(userId) ?? null,
  getWorkspace: async () => ({
    workspaceId: "workspace-1",
    name: "无工作区",
    kind: "inbox"
  }),
  getAgentSession: async () => null,
  saveAgentSession: async () => {},
  listMemories: async () => [],
  listMessages: async (_conversationId, options = {}) =>
    queueMessages.filter((message) => message.seq > (options.afterSeq ?? 0)),
  markProcessed: async (_conversationId, userId, seq) => {
    const member = queueConversation.members.find((item) => item.userId === userId);
    if (member) member.lastReadSeq = Math.max(member.lastReadSeq, seq);
  },
  appendMessage: async (input) => {
    const message = {
      ...incoming,
      ...input,
      messageId: `queue-reply-${queueReplies.length + 1}`,
      conversationId: queueConversation.conversationId,
      seq: ++queueConversation.lastSeq
    };
    queueMessages.push(message);
    queueReplies.push(message);
    return message;
  },
  listConversations: async () => [queueConversation],
  getConversation: async () => queueConversation,
  updateConversation: async (_conversationId, patch) => Object.assign(queueConversation, patch)
};
const queueScheduler = new LocalScheduler({idleRetryLimit:0,concurrentInbox:true,
  store: queueStore,
  registry: {
    runTurn: async (_agent, input) => {
      queueRunCount += 1;
      const turn = queueRunCount;
      queuePrompts.push(input.prompt);
      if (turn === 1) await firstTurnGate;
      return {
        ok: true,
        message: turn === 1 ? "第一轮完成" : turn === 2 ? "已补看新消息" : "SKIP",
        steps: [],
        metrics: { iterations: 1, sideEffects: false }
      };
    },
    cancel: async () => true
  },
  syncer: { ensureSynced: async () => [] },
  resolveWorkspace: async () => ({
    workspacePath: "/tmp/ading-scheduler-queue-test",
    sharesKnowledge: false
  }),
  resolveDiscovered: (userId) =>
    userId === ready.userId
      ? { kind: "codex", localUuid: "codex@test" }
      : undefined,
  isAgentReady: (agent) => agent.userId === ready.userId,
  broadcast: (channel, payload) => queueBroadcasts.push({ channel, payload }),
  log: async () => {}
});

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

await queueScheduler.dispatch(queueConversation, firstQueueMessage);
check("First message immediately triggers an idle Agent", await eventually(() => queueRunCount === 1));

const messageWhileBusy = {
  ...incoming,
  messageId: "message-while-busy",
  conversationId: queueConversation.conversationId,
  seq: ++queueConversation.lastSeq,
  content: "忙碌时到达的新消息"
};
queueMessages.push(messageWhileBusy);
await queueScheduler.dispatch(queueConversation, messageWhileBusy);
check("Message channel has replied while the original execution is unfinished", await eventually(() => queueRunCount === 2 && queueReplies.length === 1), queueRunCount);

releaseFirstTurn();
const firstTurnSettled = await eventually(() => queueReplies.length === 2);
await new Promise((resolve) => setTimeout(resolve, 50));
check(
  "Messages already handled by the message channel are not reprocessed after the Agent finishes",
  firstTurnSettled && queueRunCount === 2 && queueReplies.length === 2,
  { queueRunCount, queueReplies }
);
check(
  "Message channel prompt includes new messages that arrived while busy",
  queuePrompts[1]?.includes("忙碌时到达的新消息"),
  queuePrompts[1]
);
const queueBusyBroadcasts = queueBroadcasts.filter(event => event.channel === "agent:busy");
check(
  "The Agent always has only one busy state during the follow-up push",
  queueBusyBroadcasts.length >= 2 &&
    queueBusyBroadcasts[0].payload.busy === true &&
    queueBusyBroadcasts.at(-1).payload.busy === false,
  queueBroadcasts
);

// In default single-session mode, user interjections are injected into the running provider turn without cancelling the process or starting another top-level session.
const redirectConversation = {
  ...queueConversation,
  conversationId: "conversation-direction-change",
  lastSeq: 1,
  members: [
    { userId: me.userId, role: "LEADER", lastReadSeq: 1 },
    { userId: ready.userId, role: "ENGINEER", lastReadSeq: 0 }
  ]
};
const redirectMessages = [{ ...incoming, conversationId: redirectConversation.conversationId, content: "先处理原任务" }];
const redirectReplies = [];
const redirectPrompts = [];
const redirectSteers = [];
let redirectSession = null;
let redirectRunCount = 0;
let redirectCancelCount = 0;
let finishSteered;
const redirectStore = {
  currentUser: async () => me,
  getUser: async (userId) => users.get(userId) ?? null,
  getWorkspace: async () => ({workspaceId:"workspace-1",name:"无工作区",kind:"inbox"}),
  getAgentSession: async () => redirectSession,
  saveAgentSession: async (session) => { redirectSession = session; },
  listMemories: async () => [],
  listMessages: async (_conversationId, options = {}) => redirectMessages.filter(message => message.seq > (options.afterSeq ?? 0)),
  markProcessed: async (_conversationId, userId, seq) => {
    const member=redirectConversation.members.find(item=>item.userId===userId);
    if(member)member.lastReadSeq=Math.max(member.lastReadSeq,seq);
  },
  appendMessage: async (input) => {
    const message={...incoming,...input,conversationId:redirectConversation.conversationId,messageId:`redirect-reply-${redirectReplies.length+1}`,seq:++redirectConversation.lastSeq};
    redirectMessages.push(message);redirectReplies.push(message);return message;
  },
  listConversations: async () => [redirectConversation],
  getConversation: async () => redirectConversation,
  updateConversation: async (_conversationId,patch) => Object.assign(redirectConversation,patch)
};
const redirectScheduler = new LocalScheduler({idleRetryLimit:0,teamMonitorIntervalMs:0,
  store:redirectStore,
  registry:{
    runTurn:async(_agent,input)=>{
      redirectRunCount++;redirectPrompts.push(input.prompt);
      if(redirectRunCount===2)return {ok:true,message:"已核对两条追发指示",threadId:"same-provider-thread",steps:[],metrics:{iterations:1,sideEffects:false}};
      return new Promise(resolve=>{finishSteered=()=>resolve({ok:true,message:"已按新方向完成",threadId:"same-provider-thread",steps:["partial work preserved"],metrics:{iterations:1,sideEffects:true}});});
    },
    steer:async(_kind,localUuid,input)=>{redirectSteers.push({localUuid,input});if(redirectSteers.length===2)setImmediate(()=>finishSteered?.());return {status:"accepted"};},
    cancel:()=>{redirectCancelCount++;return true;}
  },
  syncer:{ensureSynced:async()=>[]},
  resolveWorkspace:async()=>({workspacePath:"/tmp/ading-scheduler-direction-test",sharesKnowledge:false}),
  resolveDiscovered:userId=>userId===ready.userId?{kind:"codex",localUuid:"codex@test"}:undefined,
  isAgentReady:agent=>agent.userId===ready.userId,broadcast:()=>{},log:async()=>{}
});
await redirectScheduler.dispatch(redirectConversation,redirectMessages[0]);
check("Direction-change test has entered the first turn",await eventually(()=>redirectRunCount===1));
const redirectMessage={...incoming,messageId:"direction-change",conversationId:redirectConversation.conversationId,seq:++redirectConversation.lastSeq,content:"先别做旧方案，改为并行检查三张图"};
redirectMessages.push(redirectMessage);
await redirectScheduler.dispatch(redirectConversation,redirectMessage);
const secondRedirect={...incoming,messageId:"direction-change-2",conversationId:redirectConversation.conversationId,seq:++redirectConversation.lastSeq,content:"另外检查输出边界，不要重复第一条插话"};
redirectMessages.push(secondRedirect);
await redirectScheduler.dispatch(redirectConversation,secondRedirect);
check("Consecutive new instructions are injected into the current turn without cancelling the process",redirectCancelCount===0&&redirectSteers.length===2,{redirectCancelCount,redirectSteers});
check("Interjection received by the current turn while the follow-up review turn loses nothing",await eventually(()=>redirectRunCount===2&&redirectReplies.some(reply=>reply.content==="已核对两条追发指示")));
check("Review turn replays both follow-up messages",redirectPrompts[1]?.includes("改为并行检查三张图")&&redirectPrompts[1]?.includes("另外检查输出边界"),redirectPrompts[1]);
check("Direction change reuses the same provider session",redirectSession?.providerThreadId==="same-provider-thread",redirectSession);
check("steer input contains the latest instruction and the native sub-Agent parallel boundary",redirectSteers[0]?.input.content.includes("改为并行检查三张图")&&redirectSteers[0]?.input.content.includes("原生子 Agent"),redirectSteers[0]);
check("Consecutive steers send only new content by watermark",redirectSteers[1]?.input.content.includes("另外检查输出边界")&&!redirectSteers[1]?.input.content.includes("改为并行检查三张图"),redirectSteers[1]);
check("Interjections are not written as failed messages",!redirectReplies.some(reply=>reply.failed),redirectReplies);

// Reports must queue while the Leader is busy; after a task stops, even a late return from below must not write back or advance read state.
const reportQueueConversation = {
  ...conversation,
  conversationId: "conversation-report-queue",
  type: "GROUP",
  lastSeq: 1,
  paused: false,
  members: [
    { userId: me.userId, role: "ENGINEER", lastReadSeq: 1 },
    { userId: ready.userId, role: "LEADER", lastReadSeq: 0 }
  ]
};
const reportQueueMessages = [{ ...incoming, conversationId: reportQueueConversation.conversationId }];
const reportQueueReplies = [];
const reportQueuePrompts = [];
let reportQueueRunCount = 0;
let releaseBusyLeader;
const busyLeaderGate = new Promise((resolve) => { releaseBusyLeader = resolve; });
let releaseStoppedLeader;
const stoppedLeaderGate = new Promise((resolve) => { releaseStoppedLeader = resolve; });
const reportQueueStore = {
  currentUser: async () => me,
  getUser: async (userId) => users.get(userId) ?? null,
  getWorkspace: async () => ({
    workspaceId: "workspace-1",
    name: "无工作区",
    kind: "inbox"
  }),
  getAgentSession: async () => null,
  saveAgentSession: async () => {},
  listMemories: async () => [],
  listMessages: async (_conversationId, options = {}) =>
    reportQueueMessages.filter((message) => message.seq > (options.afterSeq ?? 0)),
  markProcessed: async (_conversationId, userId, seq) => {
    const member = reportQueueConversation.members.find((item) => item.userId === userId);
    if (member) member.lastReadSeq = Math.max(member.lastReadSeq, seq);
  },
  appendMessage: async (input) => {
    const message = {
      ...incoming,
      ...input,
      conversationId: reportQueueConversation.conversationId,
      messageId: `report-queue-reply-${reportQueueReplies.length + 1}`,
      seq: ++reportQueueConversation.lastSeq
    };
    reportQueueMessages.push(message);
    reportQueueReplies.push(message);
    return message;
  },
  listConversations: async () => [reportQueueConversation],
  getConversation: async () => reportQueueConversation,
  updateConversation: async (_conversationId, patch) => Object.assign(reportQueueConversation, patch),
  setConversationPaused: async (_conversationId, paused) => Object.assign(reportQueueConversation, { paused })
};
const reportQueueScheduler = new LocalScheduler({idleRetryLimit:0,concurrentInbox:true,
  store: reportQueueStore,
  registry: {
    runTurn: async (_agent, input) => {
      reportQueueRunCount += 1;
      const turn = reportQueueRunCount;
      reportQueuePrompts.push(input.prompt);
      if (turn === 1) await busyLeaderGate;
      if (turn === 3) await stoppedLeaderGate;
      return {
        ok: true,
        message: turn === 2 ? "阶段汇报" : "正常回复",
        steps: [],
        metrics: { iterations: 1, sideEffects: false }
      };
    },
    cancel: async () => true
  },
  syncer: { ensureSynced: async () => [] },
  resolveWorkspace: async () => ({
    workspacePath: "/tmp/ading-scheduler-report-queue-test",
    sharesKnowledge: false
  }),
  resolveDiscovered: (userId) =>
    userId === ready.userId
      ? { kind: "codex", localUuid: "codex@test" }
      : undefined,
  isAgentReady: (agent) => agent.userId === ready.userId,
  broadcast: () => {},
  log: async () => {}
});

const busyLeaderTurn = reportQueueScheduler.runAgentTurn(reportQueueConversation, ready);
check("Leader first enters an ordinary reply", await eventually(() => reportQueueRunCount === 1));
let queuedReportSettled = false;
const queuedReport = reportQueueScheduler.reportConversation(reportQueueConversation.conversationId).then((message) => {
  queuedReportSettled = true;
  return message;
});
await new Promise((resolve) => setImmediate(resolve));
check("Leader generates a report independently while busy", await eventually(() => queuedReportSettled && reportQueueRunCount === 2));
releaseBusyLeader();
const queuedReportMessage = await queuedReport;
await busyLeaderTurn;
check(
  "Leader's concurrent report keeps the actual content",
  reportQueueRunCount === 2 && queuedReportMessage.content === "阶段汇报",
  { reportQueueRunCount, queuedReportMessage }
);
check(
  "Queued report still receives the phase-report instruction",
  reportQueuePrompts[1]?.includes("阶段汇报"),
  reportQueuePrompts[1]
);

const repliesBeforeStop = reportQueueReplies.length;
const readBeforeStop = reportQueueConversation.members.find(
  (member) => member.userId === ready.userId
)?.lastReadSeq;
reportQueueConversation.paused = false;
reportQueueMessages.push({
  ...incoming,
  messageId: "message-stop-race",
  conversationId: reportQueueConversation.conversationId,
  seq: ++reportQueueConversation.lastSeq,
  content: "停止前刚到的消息"
});
const stoppedTurn = reportQueueScheduler.runAgentTurn(reportQueueConversation, ready);
check("Stop race test has entered the Agent", await eventually(() => reportQueueRunCount === 3));
await reportQueueScheduler.stopConversation(reportQueueConversation.conversationId);
releaseStoppedLeader();
await stoppedTurn;
check(
  "Late Agent results after stop are not written to chat",
  reportQueueReplies.length === repliesBeforeStop,
  reportQueueReplies
);
check(
  "Unfinished messages after stop do not advance the read watermark",
  reportQueueConversation.members.find((member) => member.userId === ready.userId)?.lastReadSeq === readBeforeStop
);

// New tasks with a title and goal generate an opening message immediately; reopening pushes offline unread messages.
const createdConversation = {
  ...conversation,
  conversationId: "conversation-created",
  name: "立即开始",
  lastSeq: 0,
  members: [
    { userId: me.userId, role: "LEADER", lastReadSeq: 0 },
    { userId: ready.userId, role: "ENGINEER", lastReadSeq: 0 }
  ],
  charter: { goal: "不要等待第一条消息" },
  paused: false
};
const createdMessages = [];
const createdPrompts = [];
let createdRunCount = 0;
const creationStore = {
  currentUser: async () => me,
  getUser: async (userId) => users.get(userId) ?? null,
  getWorkspace: async () => ({
    workspaceId: "workspace-1",
    name: "无工作区",
    kind: "inbox"
  }),
  createConversation: async () => createdConversation,
  listConversations: async () => [createdConversation],
  getConversation: async () => createdConversation,
  updateConversation: async (_conversationId, patch) => Object.assign(createdConversation, patch),
  setConversationPaused: async (_conversationId, paused) => Object.assign(createdConversation, { paused }),
  getAgentSession: async () => null,
  saveAgentSession: async () => {},
  listMemories: async () => [],
  listMessages: async (_conversationId, options = {}) =>
    createdMessages.filter((message) => message.seq > (options.afterSeq ?? 0)),
  markProcessed: async (_conversationId, userId, seq) => {
    const member = createdConversation.members.find((item) => item.userId === userId);
    if (member) member.lastReadSeq = Math.max(member.lastReadSeq, seq);
  },
  appendMessage: async (input) => {
    const message = {
      ...incoming,
      ...input,
      conversationId: createdConversation.conversationId,
      messageId: `created-message-${createdMessages.length + 1}`,
      seq: ++createdConversation.lastSeq
    };
    createdMessages.push(message);
    return message;
  }
};
const creationScheduler = new LocalScheduler({idleRetryLimit:0,
  store: creationStore,
  registry: {
    runTurn: async (_agent, input) => {
      createdRunCount += 1;
      createdPrompts.push(input.prompt);
      return {
        ok: true,
        message: "SKIP",
        steps: [],
        metrics: { iterations: 1, sideEffects: false }
      };
    },
    cancel: async () => true
  },
  syncer: { ensureSynced: async () => [] },
  resolveWorkspace: async () => ({
    workspacePath: "/tmp/ading-scheduler-create-test",
    sharesKnowledge: false
  }),
  resolveDiscovered: (userId) =>
    userId === ready.userId
      ? { kind: "codex", localUuid: "codex@test" }
      : undefined,
  isAgentReady: (agent) => agent.userId === ready.userId,
  broadcast: () => {},
  log: async () => {}
});

await creationScheduler.createConversation({
  name: createdConversation.name,
  memberIds: [ready.userId],
  charter: createdConversation.charter
});
check(
  "Creating a task with a title and goal triggers the Agent immediately",
  await eventually(() => createdRunCount === 1)
);
check(
  "Creating a task saves only the original goal the user entered",
  createdMessages[0]?.content === "不要等待第一条消息",
  createdMessages[0]
);

createdConversation.paused = true;
const offlineMessage = {
  ...incoming,
  conversationId: createdConversation.conversationId,
  messageId: "offline-message",
  seq: ++createdConversation.lastSeq,
  content: "应用关闭期间没处理的消息"
};
createdMessages.push(offlineMessage);
await creationScheduler.resumeConversation(createdConversation.conversationId);
check("Explicitly continuing a historical task unpauses it", createdConversation.paused === false, createdConversation);
check(
  "Explicitly continuing a historical task pushes the Agent's unread messages",
  await eventually(
    () =>
      createdRunCount === 2 &&
      createdPrompts[1]?.includes("应用关闭期间没处理的消息")
  ),
  createdPrompts
);

// A final reply remains participant speech even when the transport fails after
// receiving it. Legacy DIRECT metadata must never invoke Leader control logic.
for(const role of ['ENGINEER','LEADER']){
 for(const failed of [false,true]){
  const raw='不会自动同步。技能只在 Codex 目录安装。\n'+(failed?'{"control":{action:stop}}':'{"control":{"action":"stop","reason":"只是JSON示例"}}');
  const direct={...conversation,conversationId:`reply-delivery-${role}-${failed}`,type:'DIRECT',lastSeq:1,paused:false,
   members:[{userId:me.userId,role:'ENGINEER',lastReadSeq:0},{userId:ready.userId,role,lastReadSeq:0}]};
  const input={...incoming,conversationId:direct.conversationId,seq:1};
  const replies=[];const processed=[];
  const replyStore={...store,getConversation:async()=>direct,listConversations:async()=>[direct],
   listMessages:async(_id,options)=>[input,...replies].filter(m=>!options?.afterSeq||m.seq>options.afterSeq),
   markProcessed:async(_id,_agent,seq)=>processed.push(seq),
   appendMessage:async data=>{
    const message={...input,...data,messageId:data.clientMessageId,seq:++direct.lastSeq,internal:data.internal||data.type==='SYSTEM'||undefined};
    replies.push(message);return message;
   }};
  const run=new LocalScheduler({idleRetryLimit:0,store:replyStore,
   registry:{runTurn:async()=>failed
    ? {ok:false,error:'Protocol reply decoding failed',partialMessage:raw,steps:['已收到最终正文'],cancelled:false,metrics:{iterations:1,sideEffects:false}}
    : {ok:true,message:raw,steps:['已收到最终正文'],metrics:{iterations:1,sideEffects:false}}},
   syncer:{ensureSynced:async()=>[]},resolveWorkspace:async()=>({workspacePath:'/tmp/ading-reply-delivery-test',sharesKnowledge:false}),
   resolveDiscovered:()=>({kind:'codex',localUuid:'codex-reply-test'}),isAgentReady:()=>true,broadcast:()=>{},log:async()=>{}});
  await run.runAgentTurn(direct,ready);
  const visible=replies.filter(m=>m.senderId===ready.userId&&!m.internal&&!m.failed);
  check(`${role}/${failed}: final body enters the message window exactly once`,visible.length===1&&visible[0].content===raw,replies);
  check(`${role}/${failed}: real body uses the ordinary message type`,visible[0]?.type==='USER',visible);
  check(`${role}/${failed}: direct-chat JSON does not apply group control`,direct.paused===false);
  if(failed){
   check(`${role}: parse failure keeps a separate failure activity`,replies.some(m=>m.failed&&m.internal),replies);
   check(`${role}: parse failure does not advance the processed watermark`,processed.length===0,processed);
  }
 }
}

console.log(`local-scheduler: ${passed} passed, 0 failed`);
