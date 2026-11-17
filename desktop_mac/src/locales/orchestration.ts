import type { Catalog } from "../i18n.js";

export const orchestrationMessages = {
  "orch.app.exiting": { zh: "应用正在退出", en: "ADing is quitting" },
  "orch.conversation.notFound": { zh: "会话不存在", en: "Conversation not found" },
  "orch.conversation.noReadyAgent": { zh: "当前没有可用的 Agent，请检查连接或配额后重试", en: "No Agent is available. Check the connection or quota and try again." },
  "orch.conversation.agentUnavailable": { zh: "{name} 当前不可用", en: "{name} is currently unavailable" },
  "orch.conversation.agentUnavailablePickLeader": { zh: "{name} 当前不可用，请选择可用的 Leader", en: "{name} is currently unavailable. Choose an available Leader." },
  "orch.report.directNotNeeded": { zh: "单聊会话不需要汇报", en: "Direct chats don't need a report" },
  "orch.report.conversationEnded": { zh: "会话已结束，不能汇报", en: "The conversation has ended, so no report can be made" },
  "orch.report.alreadyLatest": { zh: "最新一条消息已经是汇报", en: "The latest message is already a report" },
  "orch.report.noLeader": { zh: "这个会话还没有 Agent Leader", en: "This conversation doesn't have an Agent Leader yet" },
  "orch.report.leaderPaused": { zh: "{name} 已在这个会话中暂停", en: "{name} is paused in this conversation" },
  "orch.report.conversationPaused": { zh: "会话已暂停，请先继续会话再汇报", en: "The conversation is paused. Resume it before requesting a report." },
  "orch.report.leaderChanged": { zh: "Leader 已切换，请重新点击汇报", en: "The Leader has changed. Request the report again." },
  "orch.report.cancelled": { zh: "汇报已取消", en: "Report cancelled" },
  "orch.report.conversationChanged": { zh: "会话状态已经变化，汇报已取消", en: "The conversation status changed, so the report was cancelled" },
  "orch.report.empty": { zh: "{name} 没有生成汇报", en: "{name} didn't produce a report" },
  "orch.report.messageCancelled": { zh: "消息处理已取消", en: "Message processing was cancelled" },
  "orch.report.notGenerated": { zh: "未生成汇报，或执行已取消", en: "No report was generated, or the run was cancelled" },
  "orch.report.runCancelled": { zh: "当前执行已取消，汇报请求已取消", en: "The current run was cancelled, so the report request was cancelled" },
  "orch.report.memberRemoved": { zh: "成员已移除，汇报请求已取消", en: "The member was removed, so the report request was cancelled" },
  "orch.progress.inboxHandling": { zh: "正在处理新消息，原工作继续运行", en: "Handling new messages; the original work continues" },
} as const satisfies Catalog;
