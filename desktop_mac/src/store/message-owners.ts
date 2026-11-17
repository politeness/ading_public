/**
 * Which local Agents in the task should handle a message (ignoring ready state).
 * The scheduler picking recipients (pickTargets) and when the "unfinished" record is cleared (Store.markProcessed, retriggering after restart) share this one rule;
 * if they diverge: in a group, A finishes and clears the record, B crashes mid-run, and after restart B is never triggered again.
 */
export function owesMessage(conversation: Conversation, member: ConversationMember, user: UserRef | null | undefined, message: Message): boolean {
  if (member.userId === message.senderId || member.paused || member.role === "OBSERVER") return false;
  // Agents on other computers are dispatched by that computer's scheduler
  if (!user?.isAgent || user.remote) return false;
  // Delegation messages go only to the designated recipients; ordinary chatter during task execution is collected by the leader
  if (message.coordination || message.mentions.length) return message.mentions.includes(member.userId);
  return !(conversation.type === "GROUP" && conversation.charter?.mode !== "discussion" && member.role !== "LEADER");
}

/** Whether every local Agent that should handle this message has done so (processed watermark past it); no such Agent also counts as done */
export async function processedByAllOwners(
  conversation: Conversation,
  message: Message,
  getUser: (userId: string) => Promise<UserRef | null>
): Promise<boolean> {
  for (const member of conversation.members) {
    if ((member.lastProcessedSeq ?? 0) >= message.seq) continue;
    if (owesMessage(conversation, member, await getUser(member.userId), message)) return false;
  }
  return true;
}
