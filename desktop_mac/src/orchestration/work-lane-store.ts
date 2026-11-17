import type { Store } from "../store/store";

/** Keep one native provider session for the task's primary sequential lane.
 * Truly concurrent sibling lanes still need isolated provider sessions, while
 * every lane replays the same durable task ledger. */
export function workLaneStore(store: Store, conversationId: string, agentId: string, assignmentId: string, primary = false): Store {
  const sessionId = primary ? agentId : `${agentId}::assignment:${assignmentId}`;
  let processed = 0;
  return new Proxy(store, {
    get(target, key) {
      if (key === "getAgentSession") return async (tid: string, id: string) => {
        const session = await target.getAgentSession(tid, id === agentId ? sessionId : id);
        return session && {...session,agentUserId:id};
      };
      if (key === "saveAgentSession") return (session: AgentSessionRef) => target.saveAgentSession({...session,agentUserId:session.agentUserId === agentId ? sessionId : session.agentUserId});
      if (key === "markProcessed") return async (_tid: string, id: string, seq: number) => {
        if (id === agentId) processed = Math.max(processed,seq);
      };
      if (key === "getConversation") return async (tid: string) => {
        const conversation = await target.getConversation(tid);
        if (!conversation || tid !== conversationId) return conversation;
        const session=await target.getAgentSession(tid,sessionId);
        const watermark=Math.max(processed,session?.messageSyncedSeq??0);
        return {...conversation, members:conversation.members.map(m=>m.userId === agentId
          ? {...m,role:"ENGINEER" as const,lastProcessedSeq:watermark,lastReadSeq:0} : m)};
      };
      const value = Reflect.get(target,key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
