import type { Store } from "../store/store";

/** Members that are not known Agents. A member that can't be looked up counts as a person,
 * so input from someone not yet synced is never dropped. */
export async function humanMemberIds(store: Pick<Store, "getUser">, conversation: Conversation): Promise<Set<string>> {
  const humans = new Set<string>();
  for (const member of conversation.members) if (!(await store.getUser(member.userId))?.isAgent) humans.add(member.userId);
  return humans;
}

/** A person's own message. Agent replies carry agentReply and are never a person's input, even
 * when the sending Agent isn't known on this computer yet (for example a shared Agent before the
 * Agent list has synced), which would otherwise make the Agent's reply look like new owner input. */
export function isHumanInput(message: Message, humans: Set<string>): boolean {
  return humans.has(message.senderId) && !message.agentReply;
}

/** Whether an Agent already replied to this input outside a plan discussion. Discussion turns
 * (lane "brainstorm") are intermediate and don't settle the input. */
export function inputAnswered(messages: Message[], seq: number): boolean {
  return messages.some(m => m.seq > seq && !!m.agentReply && m.agentReply.lane !== "brainstorm" && !m.failed && m.agentReply.inputSeq >= seq);
}

/** The latest person's chat message (not @-directed) that no Agent has answered yet. */
export function latestUnansweredInput(messages: Message[], humans: Set<string>): Message | undefined {
  const latest = [...messages].reverse().find(m => isHumanInput(m, humans) && m.type === "USER" && !m.internal && !m.failed && !m.report);
  if (!latest || latest.mentions?.length || inputAnswered(messages, latest.seq)) return undefined;
  return latest;
}
