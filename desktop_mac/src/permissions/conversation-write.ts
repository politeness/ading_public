import type { Store } from "../store/store";
import { tm } from "../i18n";

/** Human UI actions require membership; Agent execution uses the scheduler directly. */
export async function requireConversationWriter(store: Pick<Store, "getConversation" | "currentUser">, id: string): Promise<void> {
  const conversation = await store.getConversation(id);
  if (!conversation) throw new Error(tm("main.store.conversationMissing"));
  const me = await store.currentUser();
  if (!conversation.members.some(member => member.userId === me.userId)) throw new Error(tm("main.store.senderNotMember"));
}

/** Pause/resume is also available to an Agent owner viewing a shared conversation. */
export async function requireConversationController(store: Pick<Store, "getConversation" | "currentUser" | "getUser">, id: string): Promise<void> {
  const conversation = await store.getConversation(id);
  if (!conversation) throw new Error(tm("main.store.conversationMissing"));
  const me = await store.currentUser();
  if (conversation.members.some(member => member.userId === me.userId)) return;
  const users = await Promise.all(conversation.members.map(member => store.getUser(member.userId)));
  if (!users.some(user => user?.isAgent && user.owner === me.userId)) throw new Error(tm("main.store.senderNotMember"));
}
