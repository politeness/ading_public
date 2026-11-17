const alphabet = new Intl.Collator("zh-CN-u-co-pinyin", { sensitivity: "base", numeric: true });

export function compareContacts(left: UserRef, right: UserRef): number {
  return alphabet.compare(left.displayName, right.displayName) || left.userId.localeCompare(right.userId);
}

export function compareMembers(left: UserRef, right: UserRef): number {
  return Number(right.isAgent) - Number(left.isAgent) || compareContacts(left, right);
}

export function recentConversations(conversations: Conversation[]): Conversation[] {
  const time = (conversation: Conversation) => Date.parse(conversation.updatedAt) || Date.parse(conversation.createdAt) || 0;
  return [...conversations].sort((left, right) => time(right) - time(left) || left.conversationId.localeCompare(right.conversationId));
}

export function matchesContact(contact: UserRef, query: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const needle = normalize(query);
  const name = normalize(contact.displayName);
  let index = 0;
  for (const char of name) if (char === needle[index]) index++;
  return index === needle.length;
}
