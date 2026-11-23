import { parseLeaderControl } from "../orchestration/control";
/**
 * Which local Agents in the task should handle a message (ignoring ready state).
 * The scheduler picking recipients (pickTargets) and when the "unfinished" record is cleared (Store.markProcessed, retriggering after restart) share this one rule;
 * if they diverge: in a group, A finishes and clears the record, B crashes mid-run, and after restart B is never triggered again.
 */
export function owesMessage(conversation: Conversation, member: ConversationMember, user: UserRef | null | undefined, message: Message, sender?: UserRef | null): boolean {
  if (member.userId === message.senderId || member.paused || member.role === "OBSERVER") return false;
  // Agents on other computers are dispatched by that computer's scheduler
  if (!user?.isAgent || user.remote) return false;
  // Delegation messages go only to the designated recipients. Everything else reaches every Agent, like a
  // real group: each one reads it and decides from the prompt whether it is theirs to answer (or SKIPs).
  if (message.coordination) return message.mentions.includes(member.userId);
  // A person's message always reaches everyone. An Agent's message wakes the other members too in plain
  // chat, but the Leader carries the conversation once it runs work: replies made while a plan is under way,
  // replies that carry a scheduling control, and scheduler notices sent in an Agent's name wake only the
  // Leader and anyone @-mentioned. The others still read them in the history on their next turn.
  const fromAgent = !!message.agentReply || !!sender?.isAgent;
  if (fromAgent && conversation.type === "GROUP" && member.role !== "LEADER" &&
      (!message.agentReply || !!parseLeaderControl(message.agentReply.raw).control || !!conversation.workPlan?.some(work => work.status !== "done"))) {
    return message.mentions.includes(member.userId);
  }
  return true;
}

/** Whether every local Agent that should handle this message has done so (processed watermark past it); no such Agent also counts as done */
export async function processedByAllOwners(
  conversation: Conversation,
  message: Message,
  getUser: (userId: string) => Promise<UserRef | null>
): Promise<boolean> {
  for (const member of conversation.members) {
    if ((member.lastProcessedSeq ?? 0) >= message.seq) continue;
    if (owesMessage(conversation, member, await getUser(member.userId), message, await getUser(message.senderId))) return false;
  }
  return true;
}
