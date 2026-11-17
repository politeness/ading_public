/** Operational context is durable, but is not a participant's chat message. */
export function isOperationalMessage(message: Message): boolean {
  return isSelfAssignmentReceipt(message) || !!message.internal || !!message.failed || (message.type === "SYSTEM" &&
    /^((?:任务|会话)未停止、尚未完成交付|(?:任务|会话)尚未停止，但已连续跟进|上条回复已保留。生成期间|(?:任务|会话)指示已更新。|The (?:task|conversation) hasn't stopped and hasn't been delivered|The (?:task|conversation) hasn't stopped, but \d+ follow-ups|The previous reply was kept\. New messages arrived|(?:Task|Conversation) instructions updated\.)/.test(message.content));
}

/** Remove application receipt wrappers only when coordination metadata identifies them. */
export function agentChatContent(message: Message): string {
  const c = message.coordination;
  if (!c || message.type !== "TASK") return message.content;
  let content = message.content;
  if (message.senderId === c.assigneeId && ["accepted", "revision"].includes(c.phase)) {
    const wrapper = c.phase === "accepted"
      ? /^[^\n]+ (?:已同意方案，(?:进入|开始)执行：|agreed to the plan and is starting execution:)[ \t]*\n?/
      : /^[^\n]+ (?:提出分工(?:问题，待 Leader 讨论|异议)：|(?:raised a question about the assignment, pending Leader discussion|objected to the assignment):)[ \t]*\n?/;
    content = content.replace(wrapper, "");
  }
  if (c.phase === "proposal" && c.workId) {
    // The system wrote this message in the UI language at that time, so recognize both Chinese and English
    for (const [marker, prefixPattern] of [
      [`工作 ${c.workId}：`, /^(?:Leader 开始承担|请 [^\n]+ 评估并确认)$/],
      [`work ${c.workId}: `, /^(?:The Leader is taking on|[^\n]+, please evaluate and confirm) $/]
    ] as const) {
      const boundary = content.indexOf(marker);
      if (boundary >= 0 && prefixPattern.test(content.slice(0, boundary))) {
        content = content.slice(boundary + marker.length);
        break;
      }
    }
  }
  return content;
}

/** System-generated self-assignment receipts belong in the activity feed. */
function isSelfAssignmentReceipt(message: Message): boolean {
  return message.type === "TASK" && message.coordination?.phase === "accepted" &&
    message.senderId === message.coordination.assigneeId && !message.agentReply &&
    /^(?:Leader 开始承担(?:工作 |分工：)|The Leader is taking on (?:work |an assignment: ))/.test(message.content);
}

/** Same marker as TEAM_RELAY_PREFIX in orchestration/team.ts: hidden cross-computer discussion requests and answers. */
const TEAM_RELAY_PREFIX = "ading-team-relay:";
export function isTeamRelayMessage(message: Message): boolean {
  return !!message.internal && message.content.startsWith(TEAM_RELAY_PREFIX);
}
