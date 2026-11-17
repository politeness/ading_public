/**
 * Demo data for landing-page screenshots.
 *
 * Loads src/index.html directly in the browser, with this fake window.ading standing in for the main process.
 * The UI is the real ADing UI; only the data is a made-up demo scenario. Injected by run.mjs.
 */
(() => {
  const english = new URL(location.href).searchParams.get("lang") === "en";
  const l = (zh, en) => english ? en : zh;
  try { localStorage.setItem("ading.language", english ? "en" : "zh-CN"); } catch {}
  const t = (m) => `2026-09-16T0${Math.floor(m / 60) + 1}:${String(m % 60).padStart(2, "0")}:00Z`;
  const me = { userId: "u_me", displayName: l("老板", "Owner"), isAgent: false };
  const agents = [
    { userId: "a_c", displayName: "小c", isAgent: true, kind: "codex", enabled: true, added: true },
    { userId: "a_cc", displayName: "小cc", isAgent: true, kind: "claude-code", enabled: true, added: true },
    { userId: "a_q", displayName: "小q", isAgent: true, kind: "qoder", enabled: true, added: true },
    { userId: "a_qcn", displayName: "小q-cn", isAgent: true, kind: "qoder-cn", enabled: true, added: true }
  ];
  const contacts = agents;
  const workspaces = [
    { workspaceId: "w_inbox", name: l("无工作区", "No workspace"), kind: "inbox" },
    { workspaceId: "w_site", name: "ading-site", kind: "folder", path: "/Users/boss/work/ading-site" }
  ];
  const base = { creator: me.userId, owner: me.userId, status: "ACTIVE", createdAt: t(0), paused: false };
  const member = (userId, role = "ENGINEER") => ({ userId, role, lastReadSeq: 99 });
  const tasks = [
    { ...base, taskId: "t_site", name: l("官网改版", "Website refresh"), type: "GROUP", workspaceId: "w_site", lastSeq: 8, updatedAt: t(40),
      members: [member(me.userId), member("a_c", "LEADER"), member("a_cc"), member("a_q")] },
    { ...base, taskId: "t_bug", name: l("修复登录页闪退", "Fix login crash"), type: "GROUP", workspaceId: "w_site", lastSeq: 3, updatedAt: t(20),
      members: [member(me.userId), member("a_cc", "LEADER"), member("a_qcn")] },
    { ...base, taskId: "t_direct", name: l("登录页闪退 + 周报", "Login crash + weekly report"), type: "DIRECT", workspaceId: "w_inbox", lastSeq: 4, updatedAt: t(10),
      members: [member(me.userId), member("a_cc")] }
  ];
  let seq = 0;
  const msg = (taskId, senderId, content, minute, extra = {}) => ({
    messageId: `m_${taskId}_${++seq}`, taskId, seq, senderId, content, type: "USER",
    mentions: [], status: "SENT", createdAt: t(minute), ...extra
  });
  const messages = {
    t_site: [
      msg("t_site", "u_me", l("官网要改版：换新标语、修好 Homebrew 安装命令、加上十大功能介绍。@小c 你来带队，大家先讨论方案再动手。", "Refresh the website: update the tagline, fix the Homebrew command, and add ten feature highlights. @Cody, lead the team—discuss the plan before anyone starts."), 0, { mentions: ["a_c"] }),
      msg("t_site", "a_c", l("收到。我先拆一下：\n1. 文案与页面结构 —— 小cc\n2. 截图与标注 —— 小q\n3. Homebrew 命令验证 —— 我自己\n\n有不同意见现在提。", "Got it. Here's the split:\n1. Copy and page structure — Cleo\n2. Screenshots and callouts — Quinn\n3. Homebrew verification — me\n\nRaise any concerns now."), 2),
      msg("t_site", "a_cc", l("同意。建议每个功能都按「使用场景 → 使用说明 → 截图」来写，还没上线的统一用一张「敬请期待」插画。", "Agreed. Each feature should follow Use case → How it works → Screenshot. Use one consistent Coming soon illustration for unfinished features."), 4),
      msg("t_site", "a_q", l("截图我用演示数据生成，标注用编号圆点，不遮住关键按钮。", "I'll generate screenshots with demo data and use numbered callouts that do not cover key controls."), 5),
      msg("t_site", "a_c", l("方案定了，开工。做完我统一 review，再向老板汇报。", "Plan approved. Start work. I'll review everything and report back to the Owner."), 7),
      msg("t_site", "a_cc", l("文案初稿已写到 site/index.html，第 1–4 项完成。我的额度快用完了。", "The first draft is in site/index.html and features 1–4 are done. I'm nearly out of quota."), 30),
      msg("t_site", "u_me", l("@小q 小cc 的额度快用完了，剩下的文案你接着写，前面的讨论都在群里。", "@Quinn, Cleo is nearly out of quota. Continue the remaining copy; the earlier discussion is all here."), 32, { mentions: ["a_q"] }),
      msg("t_site", "a_q", l("好的，前面的方案和初稿我都看过了，接着写第 5–10 项。", "Understood. I've read the plan and draft, and I'll continue with features 5–10."), 33)
    ],
    t_bug: [
      msg("t_bug", "u_me", l("登录页在 Safari 上闪退，帮我查一下。", "The login page crashes in Safari. Please investigate."), 15),
      msg("t_bug", "a_cc", l("已复现，是 Keychain 回调里重复释放了窗口。@小q-cn 请复核我的修复。", "Reproduced. The Keychain callback releases the window twice. @Quincy, please review my fix."), 18, { mentions: ["a_qcn"] })
    ],
    t_direct: [
      msg("t_direct", "u_me", l("小cc，早。今天先帮我看看登录页那个闪退？", "Morning, Cleo. Can you look at the login crash first today?"), 8),
      msg("t_direct", "a_cc", l("早！我刚复现了，是 Keychain 回调里重复释放了窗口。我先写个修复，再补一条回归测试，大概十分钟。", "Morning! I reproduced it—the Keychain callback releases the window twice. I'll fix it and add a regression test. About ten minutes."), 9),
      msg("t_direct", "u_me", l("好，改完顺便把这周的周报也整理一下 🙏", "Great. Please put together this week's report after the fix. 🙏"), 10),
      msg("t_direct", "a_cc", l("没问题，修复提交后我就开始整理周报，弄好了在这里@你。", "Sure. Once the fix is done, I'll prepare the weekly report and @mention you here."), 11)
    ]
  };
  const catalog = agents.map((a) => ({
    kind: a.kind, label: { codex: "Codex", "claude-code": "Claude Code", qoder: "Qoder", "qoder-cn": "Qoder CN" }[a.kind],
    installed: true, added: true, readiness: "ready", version: "", userId: a.userId, displayName: a.displayName,
    installHint: "", loginHint: "", docsUrl: ""
  }));
  let permissionMode = "leader";
  const listeners = {};
  const bridge = {
    bootstrap: async () => ({
      mode: "local", me, contacts, workspaces, tasks, permissionMode,
      runtime: { revision: 1, queued: [], agents: [] }
    }),
    getPermissionMode: async () => permissionMode,
    setPermissionMode: async (mode) => (permissionMode = mode),
    accountStatus: async () => ({ signedIn: false }),
    accountProfile: async () => null,
    listContacts: async () => contacts,
    listTasks: async () => tasks,
    getTask: async (id) => tasks.find((task) => task.taskId === id),
    listWorkspaces: async () => workspaces,
    listMessages: async (id) => messages[id] ?? [],
    listProposals: async () => [],
    listSkills: async () => [],
    listMemories: async () => [],
    agentCatalog: async () => catalog,
    verifyAgent: async () => catalog,
    markRead: async () => {},
    updateState: async () => ({ phase: "idle" }),
    syncPending: async () => 0,
    sendMessage: async () => { throw new Error(l("演示模式", "Demo mode")); }
  };
  const noop = async () => {};
  bridge.onStoreEvent = bridge.onAgentProgress = bridge.onAgentBusy = bridge.onAgentQueue = undefined;
  for (const name of ["onStoreEvent", "onAgentProgress", "onAgentBusy", "onAgentQueue", "onAgentLifecycleProgress",
    "onSupportUploadResult", "onAccountChanged", "onDataSwitching", "onDataSwitched", "onUpdateState"]) {
    bridge[name] = (callback) => { listeners[name] = callback; };
  }
  window.ading = new Proxy(bridge, { get: (target, key) => (key in target ? target[key] : noop) });
  window.adingDemo = {
    busy: (taskId, agentUserId, revision) => listeners.onAgentBusy?.({ taskId, agentUserId, busy: true, revision }),
    progress: (taskId, agentUserId, text, revision) =>
      listeners.onAgentProgress?.({ taskId, agentUserId, text, revision })
  };
})();
