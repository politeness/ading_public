import type { Store } from "../store/store";

/**
 * Cross-computer team rules shared by every scheduler entry point.
 *
 * Each computer only runs (and may only speak for) its own Agents. One computer
 * coordinates a group task: the one hosting the Leader. When the Leader cannot
 * take part (its computer is offline, it is red, or it is paused), the first
 * available Agent by member id stands in, so the remaining team keeps working
 * instead of waiting. Every computer derives the same choice from the same
 * synced member list and published Agent states, without an extra election.
 * The stored Leader setting is never changed: the stand-in only lasts while
 * the Leader is unavailable.
 */
export interface TeamPresence {
  /** Can take part now: a ready local Agent, or a ready Agent on another computer that is online. */
  present(agent: UserRef): boolean;
  /** A local Agent still being checked keeps its role until the check finishes, avoiding a needless hand-over. */
  pending?(agent: UserRef): boolean;
}

export async function actingLeaderView(
  conversation: Conversation,
  getUser: (userId: string) => Promise<UserRef | null>,
  presence: TeamPresence
): Promise<Conversation> {
  if (conversation.type !== "GROUP") return conversation;
  const leader = conversation.members.find(member => member.role === "LEADER");
  if (!leader) return conversation;
  const user = await getUser(leader.userId);
  if (!user?.isAgent) return conversation;
  if (!leader.paused && !leader.ownerPaused && (presence.present(user) || presence.pending?.(user))) return conversation;
  const ordered = [...conversation.members].sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  let acting: string | undefined;
  for (const member of ordered) {
    if (member.userId === leader.userId || member.paused || member.ownerPaused || member.role === "OBSERVER") continue;
    const candidate = await getUser(member.userId);
    if (candidate?.isAgent && presence.present(candidate)) { acting = member.userId; break; }
  }
  if (!acting) return conversation;
  return {
    ...conversation,
    members: conversation.members.map(member => member.userId === acting ? { ...member, role: "LEADER" as const }
      : member.userId === leader.userId ? { ...member, role: "ENGINEER" as const } : member)
  };
}

const TEAM_VIEW = Symbol("ading.teamView");

function isConversation(value: unknown): value is Conversation {
  return !!value && typeof value === "object" && typeof (value as Conversation).conversationId === "string" &&
    Array.isArray((value as Conversation).members) && typeof (value as Conversation).type === "string";
}

/**
 * The scheduler's view of the store: conversations carry the acting Leader.
 * Writes go to the real store unchanged; the scheduler never writes member roles.
 */
export function teamStore(store: Store, presence: TeamPresence): Store {
  if ((store as unknown as Record<symbol, unknown>)[TEAM_VIEW]) return store;
  const view = (value: unknown): Promise<unknown> | unknown => {
    if (isConversation(value)) return actingLeaderView(value, id => store.getUser(id), presence);
    if (Array.isArray(value) && value.some(isConversation)) return Promise.all(value.map(item => isConversation(item) ? actingLeaderView(item, id => store.getUser(id), presence) : item));
    return value;
  };
  return new Proxy(store, {
    get(target, key) {
      if (key === TEAM_VIEW) return true;
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        return result instanceof Promise ? result.then(view) : result;
      };
    }
  });
}

/**
 * Discussion turns of Agents on another computer travel as hidden messages:
 * the coordinating computer asks, the Agent's own computer runs the turn and
 * answers. The marker is an identification tag, not user-facing text.
 * Keep it in sync with TEAM_RELAY_PREFIX in ui/message-visibility.ts.
 */
export const TEAM_RELAY_PREFIX = "ading-team-relay:";

export interface BrainstormRelayRequest {
  kind: "brainstorm-request";
  requestId: string;
  agentId: string;
  state: Omit<BrainstormState, "responses">;
}

export interface BrainstormRelayResponse {
  kind: "brainstorm-response";
  requestId: string;
  revision: number;
  phase: BrainstormState["phase"];
  result: BrainstormState["responses"][string];
}

export type TeamRelay = BrainstormRelayRequest | BrainstormRelayResponse;

export function encodeTeamRelay(relay: TeamRelay): string {
  return TEAM_RELAY_PREFIX + JSON.stringify(relay);
}

export function decodeTeamRelay(content: string | undefined): TeamRelay | undefined {
  if (!content?.startsWith(TEAM_RELAY_PREFIX)) return undefined;
  try {
    const relay = JSON.parse(content.slice(TEAM_RELAY_PREFIX.length)) as TeamRelay;
    if (relay?.kind === "brainstorm-request" && typeof relay.requestId === "string" && typeof relay.agentId === "string" && relay.state) return relay;
    if (relay?.kind === "brainstorm-response" && typeof relay.requestId === "string" && relay.result) return relay;
  } catch { /* Not a relay. */ }
  return undefined;
}

export function isTeamRelay(message: Pick<Message, "content" | "internal">): boolean {
  return !!message.internal && !!message.content?.startsWith(TEAM_RELAY_PREFIX);
}
