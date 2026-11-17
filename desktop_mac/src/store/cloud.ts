import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tm, type MainMessageKey } from "../i18n";
import path from "node:path";
import type { AccountUser, ApiMethod, ApiResult } from "../account/session";
import { newId } from "./ids";
import { migratedAgentName } from "../agents/default-names";
import { agentKindFromCloud } from "./cloud-agent-type";
import { kindFromCloud, uploadFile } from "./attachments";
import { migrateLegacyTaskNaming } from "./legacy-rename";
import { LocalStore, type SyncedSnapshot } from "./local";
import { SerialQueue } from "./serial-queue";
import type { CreateConversationInput, Store } from "./store";

/**
 * Online data layer: the cloud is authoritative, with a per-account cache kept locally.
 *
 * It works by wrapping LocalStore as a cache:
 *   - business rules (Leader assignment, member pausing, message sequence numbers…) are all still executed by LocalStore,
 *     so standalone and online share the same code instead of a second copy here;
 *   - every write lands in the local cache first so the UI sees the result immediately, and is recorded in the **pending sync queue**;
 *   - the queue is replayed to the cloud in order. Offline, the queue stays local (even across restarts) and is uploaded automatically once online.
 *
 * The queue keeps only one "sync it" entry per object (task, workspace): the scheduler changes tasks frequently,
 * and replay reads the latest cached state to align with the cloud, much cheaper than replaying each change, with the same result.
 * Each message is replayed individually: they are ordered, and are themselves idempotent by messageId.
 *
 * Phase one only syncs tasks, members, messages, workspaces, and the user's own profile; contacts, skills, memory, and agent sessions stay cache-only
 * (see section 9 of docs/cloud-data-design.md).
 */

export type CloudApi = (method: ApiMethod, route: string, body?: object) => Promise<ApiResult>;

export interface CloudStoreOptions {
  /** This account's cache directory */
  root: string;
  user: AccountUser;
  api: CloudApi;
  /** When a new local agent is discovered, register it in the cloud first and return its cloud userId */
  agentUserId?: (agent: DiscoveredAgent) => Promise<string | undefined>;
  /**
   * This computer's terminal_id in the cloud. Used to split the account's agents into "this computer's" and "other computers'";
   * empty before this computer is registered in the cloud, when they can't be told apart, so other computers' agents aren't synced yet.
   */
  localComputerId?: () => string | undefined;
  log?: (event: string, data?: Record<string, unknown>) => unknown;
  /** How long to wait before retrying when the cloud is unreachable */
  retryMs?: number;
  /** PUT the attachment file to the signed URL; replaced in tests, uploads directly to OSS by default */
  uploadFile?: (url: string, file: string, contentType: string) => Promise<void>;
}

export interface ProfileSync {
  displayName: string;
  avatarUrl: string;
  phone: string;
  email: string;
}

type SyncOp =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "workspace-delete"; workspaceId: string }
  /** fields are settings changed locally to upload; read and processed watermarks are always aligned. No fields means upload the whole local state (new tasks, queues left by older versions) */
  | { kind: "conversation"; conversationId: string; fields?: ConversationField[] }
  | { kind: "conversation-delete"; conversationId: string }
  | { kind: "message"; conversationId: string; messageId: string; seq: number }
  | { kind: "profile"; profile: ProfileSync }
  | { kind: "contact"; userId: string }
  /** Remove a human from the group. Unlike agents, can't align by "delete if missing locally": someone a friend just added who hasn't synced locally would be wrongly removed */
  | { kind: "member-remove"; conversationId: string; userId: string };

interface QueueEntry {
  id: string;
  /** Keep only one not-yet-replaying entry per key in the queue */
  key: string;
  op: SyncOp;
  createdAt: string;
}

type Outcome = "done" | "retry" | "rejected";

interface RemoteWorkspace {
  workspaceId: string;
  name: string;
  path?: string;
  kind: string;
  gmtCreated?: string;
  gmtModified?: string;
}

interface RemoteMember {
  userId: string;
  displayName?: string;
  isAgent?: boolean;
  role: MemberRole;
  lastReadSeq: number;
  lastProcessedSeq?: number | null;
  firstUnreadMentionSeq?: number | null;
  paused?: boolean;
  resumeOnContinue?: boolean;
  ownerPaused?: boolean;
}

interface RemoteConversation {
  shared?: boolean;
  conversationId: string;
  name: string;
  type: ConversationType;
  creator: string;
  owner: string;
  lastSeq: number;
  members: RemoteMember[];
  workspaceId: string;
  status?: ConversationStatus;
  paused?: boolean;
  autoTitle?: boolean;
  seedKey?: string;
  extra?: ConversationExtra;
  gmtCreated?: string;
  gmtModified?: string;
}

interface RemoteMessage {
  messageId: string;
  conversationId: string;
  seq: number;
  senderId: string;
  content: string;
  type: MessageType;
  mentions?: string[];
  replyTo?: string;
  status?: MessageStatus;
  internal?: boolean;
  report?: boolean;
  failed?: boolean;
  extra?: MessageExtra;
  attachments?: RemoteAttachment[];
  gmtCreated?: string;
}

interface RemoteAttachment {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  /** IMAGE / VIDEO / FILE */
  kind: string;
}

/** Result of POST /conversations/{id}/attachments: PUT the file to uploadUrl */
interface AttachmentTicket {
  uploadUrl: string;
  contentType: string;
  uploaded: boolean;
}

/** Runtime state of the desktop scheduler; the cloud stores and returns it without parsing */
type ConversationExtra = Pick<Conversation, "permanent" | "charter" | "workPlan" | "brainstorm" | "followUp" | "workspacePath">;
const CONVERSATION_EXTRA_FIELDS = ["permanent", "charter", "workPlan", "brainstorm", "followUp", "workspacePath"] as const;
const CONVERSATION_SETTINGS = ["name", "owner", "workspaceId", "status", "paused", "autoTitle", ...CONVERSATION_EXTRA_FIELDS] as const;
type ConversationField = (typeof CONVERSATION_SETTINGS)[number] | "members";
type MessageExtra = Pick<Message, "steps" | "agentReply" | "coordination" | "quote">;

interface RemoteAgent {
  owner?: string;
  userId: string;
  username?: string;
  displayName: string;
  isAgent?: boolean;
  avatarUrl?: string;
  persona?: string;
  agentType?: string;
  agentVersion?: string;
  /** Host computer, and the state that computer published (see backend AgentStateService) */
  computerId?: string;
  computerName?: string;
  computerOnline?: boolean;
  readiness?: string;
  /** Current model reported by that computer; only the account's own agents have it */
  model?: RemoteAgentModel | null;
}

const READINESS: readonly AgentReadiness[] = ["unknown", "missing", "found", "unauthorized", "ready", "exhausted", "error"];

/** Cloud record of agent contact state: a contact is a friend relationship; nickname and persona are stored in the users table */
type RemoteAgentState = Record<string, { contact: boolean; displayName: string; persona?: string }>;

const API = "/api/v1";
/** Cloud error codes meaning "it's already like that": treated as success on replay */
const ALREADY_DONE = new Set(["CONVERSATION_005", "CONVERSATION_006"]);
/** UI copy for cloud error codes; unlisted ones use the cloud's original Chinese text directly */
const ERROR_TEXT: Record<string, MainMessageKey> = {
  FRIEND_001: "main.friends.queryBlank",
  FRIEND_002: "main.friends.userMissing",
  FRIEND_003: "main.friends.self",
  FRIEND_004: "main.friends.notPerson",
  FRIEND_005: "main.friends.requestGone",
  MSG_008: "main.friends.noLongerFriends",
  MSG_009: "main.message.blocked",
  TASK_016: "main.store.agentPrivate",
  CONVERSATION_016: "main.store.agentPrivate",
  CONVERSATION_017: "main.store.ownerPaused",
  CONVERSATION_018: "main.store.cannotRemoveAgentOwner"
};
const PAGE = 1000;

export class CloudStore implements Store {
  readonly mode: StoreMode = "remote";

  private readonly cache: LocalStore;
  private readonly listeners = new Set<(event: StoreEvent) => void>();
  private readonly retryMs: number;
  private queue: QueueEntry[] = [];
  private inFlight: QueueEntry | undefined;
  private flushing: Promise<void> | undefined;
  private identitySyncs = 0;
  private contactRevision = 0;
  private contactWrites = 0;
  private flushAgain = false;
  private timer: NodeJS.Timeout | undefined;
  private timerDueAt = 0;
  private queueWrites: Promise<void> = Promise.resolve();
  private online: boolean | undefined;
  private readonly rejectedMessageIds = new Set<string>();
  private closed = false;
  private unsubscribeCache: (() => void) | undefined;
  /** Cloud agent contact state from the most recent full pull, used to restore agents registered on this computer for the first time */
  private remoteAgents: RemoteAgentState = {};
  /** Pending friend requests (received and sent), re-pulled on every FRIENDS_CHANGED */
  private friendRequests: FriendPerson[] = [];
  /** Cloud sequence number already pulled per conversation (local and cloud number independently, see pullConversationMessages) */
  private cursors: Record<string, number> = {};
  /** Cloud read position already merged locally per conversation (cloud sequence number); no need to ask the cloud again if unchanged */
  private remoteReadApplied: Record<string, number> = {};
  /**
   * Tasks not yet fully imported and their history boundary (cloud sequence number an Agent has replied to or processed).
   * Persisted with the cursor, so after a failed page or crash restart, the continued pull still skips history by the same boundary; cleared only when done.
   */
  private importing: Record<string, number> = {};
  /**
   * Messages pulled but not yet confirmed as handed to the scheduler: task → message ID → cloud sequence number.
   * Persisted before appending to the local cache; deleted only after main records it in the local "unprocessed" ledger (oweMessage) and confirms with ackDispatched;
   * if it crashes midway, local cache dedup would block this message, so restart hands it over again from here.
   */
  private dispatching: Record<string, Record<string, number>> = {};
  /** Pending-dispatch messages already returned in this run; not returned twice in the same process */
  private readonly handedOut = new Set<string>();
  private readonly pulling = new SerialQueue();
  private readonly cursorWrites = new SerialQueue();

  constructor(private readonly options: CloudStoreOptions) {
    this.retryMs = options.retryMs ?? 15_000;
    this.cache = new LocalStore(options.root, {
      identity: {
        userId: options.user.userId,
        username: options.user.username,
        displayName: options.user.displayName
      },
      agentUserId: options.agentUserId
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * If the cache has never been fetched from the cloud (first sign-in, cache deleted), do a full pull first;
   * if unreachable, start offline with an empty cache and queue changes as usual.
   * Don't pull while the queue still has unuploaded changes, so stale cloud data doesn't overwrite them.
   */
  async init(): Promise<void> {
    await mkdir(this.options.root, { recursive: true });
    // Old data from before "task" was renamed "conversation" must be migrated before reading the queue or writing the full snapshot:
    // otherwise the in-memory queue keeps the old structure and gets written back as is, and a snapshot writing conversations.json first would make the migration be skipped
    await migrateLegacyTaskNaming(this.options.root);
    this.queue = await this.readQueue();
    await this.readRejectedMessageIds();
    const state = await this.readState();
    this.remoteAgents = state.agents ?? {};
    ({ cursors: this.cursors, importing: this.importing, dispatching: this.dispatching } = await this.readCursors());
    if (!state.pulledAt && this.queue.length === 0) {
      const snapshot = await this.pullSnapshot();
      if (snapshot) {
        await LocalStore.writeSnapshot(this.options.root, snapshot);
        // Fully pulled messages are exactly the cloud's, so align the cursor directly
        this.cursors = Object.fromEntries(snapshot.conversations.map((conversation) => [conversation.conversationId, conversation.lastSeq]));
        this.importing = {};
        this.dispatching = {};
        await this.writeCursors();
        this.remoteAgents = snapshot.agents;
        await this.writeState({ pulledAt: new Date().toISOString(), agents: snapshot.agents });
        this.setOnline(true);
      }
    }
    await this.cache.init();
    this.unsubscribeCache = this.cache.subscribe((event) => this.emit(event));
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDueAt = 0;
    this.unsubscribeCache?.();
    // Wait a bit for the one currently replaying at most; unfinished ones stay in the queue and continue next launch
    await Promise.race([this.flushing ?? Promise.resolve(), delay(2_000)]);
    await this.queueWrites;
    await this.pulling.drain();
    await this.cursorWrites.drain();
    await this.cache.close();
    this.listeners.clear();
  }

  /** Number of changes not yet synced to the cloud */
  pendingCount(): number {
    return this.queue.length;
  }

  /** Try uploading the queue now; returns when done (or definitely unreachable) */
  async sync(): Promise<void> {
    await this.flush();
  }

  /** Re-upload profile changes made offline; the last one wins */
  async enqueueProfile(profile: ProfileSync): Promise<void> {
    await this.enqueue("profile", { kind: "profile", profile }, { replace: true });
  }

  // -------------------------------------------------------------------------
  // Read-only and parts not in the cloud in phase one: go straight to the cache
  // -------------------------------------------------------------------------

  currentUser(): Promise<UserRef> { return this.cache.currentUser(); }
  listContacts(): Promise<UserRef[]> { return this.cache.listContacts(); }
  listKnownAgents(): Promise<UserRef[]> { return this.cache.listKnownAgents(); }
  getUser(userId: string): Promise<UserRef | null> { return this.cache.getUser(userId); }

  // ---- Contacts: a contact is a cloud friend relationship; nickname and persona are stored in the cloud users table ----

  async updateContact(userId: string, patch: Parameters<Store["updateContact"]>[1]): Promise<UserRef> {
    return this.editContact(async () => {
      const user = await this.cache.updateContact(userId, patch);
      if (user.isAgent) await this.markContact(userId);
      return user;
    });
  }

  async updateAgent(userId: string, patch: Parameters<Store["updateAgent"]>[1]): Promise<UserRef> {
    return this.editContact(async () => {
      const user = await this.cache.updateAgent(userId, patch);
      await this.markContact(userId);
      return user;
    });
  }

  async deleteContact(userId: string): Promise<void> {
    const user = await this.cache.getUser(userId);
    if (user && !user.isAgent) {
      // Deleting a human friend must notify them too, so don't queue while offline: tell the user it's unreachable
      await this.friendCall("DELETE", `${API}/friends/${enc(userId)}`);
      await this.refreshPeople();
      return;
    }
    await this.editContact(async () => {
      await this.cache.deleteContact(userId);
      await this.markContact(userId);
    });
  }

  // ---- Human friends: search, request, and accept all need a live cloud connection, not the pending sync queue ----

  /** Pull human friends and friend requests once. Keep the current state if unreachable */
  async refreshPeople(): Promise<boolean> {
    const friends = await this.pull<RemoteAgent[]>(`${API}/friends`);
    if (!friends) return false;
    const requests = await this.pull<FriendPerson[]>(`${API}/friends/requests`);
    if (!requests) return false;
    await this.cache.syncPeople(friends.filter((friend) => !friend.isAgent).map(toPerson));
    this.friendRequests = requests.map((request) => ({ ...request, avatarUrl: request.avatarUrl ?? undefined }));
    this.emit({ type: "friends" });
    return true;
  }

  listFriendRequests(): FriendPerson[] {
    return this.friendRequests;
  }

  async searchPeople(query: string): Promise<FriendPerson[]> {
    return (await this.friendCall("GET", `${API}/friends/search?q=${enc(query.trim())}`)) as FriendPerson[];
  }

  async requestFriend(userId: string): Promise<FriendPerson["relation"]> {
    const data = await this.friendCall("POST", `${API}/friends/requests/${enc(userId)}`) as { relation: FriendPerson["relation"] };
    await this.refreshPeople();
    return data.relation;
  }

  /** Ask the Agent's host computer to re-detect; HTTP success only means the request was dispatched. */
  async requestAgentVerification(userId: string): Promise<void> {
    const result = await this.api("POST", `${API}/agents/${enc(userId)}/verify`);
    if (result.ok) return;
    if (result.kind !== "rejected") throw new Error(tm("main.friends.offline"));
    if (result.code === "AGENT_009") throw new Error(tm("main.agent.remoteOffline"));
    if (result.code === "NODE_006") throw new Error(tm("main.control.presenceUnknown"));
    throw new Error(cloudErrorText(result));
  }

  async acceptFriend(userId: string): Promise<void> {
    await this.friendCall("POST", `${API}/friends/requests/${enc(userId)}/accept`);
    await this.refreshPeople();
  }

  /** Decline their request, or withdraw one I sent */
  async dismissFriendRequest(userId: string): Promise<void> {
    await this.friendCall("DELETE", `${API}/friends/requests/${enc(userId)}`);
    await this.refreshPeople();
  }

  /** The owner pauses or resumes others' conversations using their Agent; the cloud verifies ownership and the result is reflected in the local cache immediately */
  async setOwnerPaused(conversationId: string, paused: boolean): Promise<void> {
    await this.friendCall("PUT", `${API}/conversations/${enc(conversationId)}/owner-pause`, { paused });
    const remote = await this.friendCall("GET", `${API}/conversations/${enc(conversationId)}`) as RemoteConversation;
    await this.cache.syncConversationMembers(conversationId, remote.members);
  }

  async shareAgent(agentId: string, recipientId: string, shared: boolean): Promise<void> {
    await this.friendCall(shared ? "POST" : "DELETE", `${API}/friends/agents/${enc(agentId)}/shares/${enc(recipientId)}`);
    await this.refreshAgents();
  }

  private async friendCall(method: ApiMethod, route: string, body?: object): Promise<unknown> {
    const result = await this.api(method, route, body);
    await this.options.log?.("cloud-friends-call", {
      method, route, ok: result.ok, ...(result.ok ? {} : { code: result.code, status: result.status, message: result.message })
    });
    if (result.ok) return result.data;
    if (result.kind !== "rejected") throw new Error(tm("main.friends.offline"));
    throw new Error(cloudErrorText(result));
  }

  /**
   * Resync agents from all computers under the account: **contact** agents on other computers go into the local list (with their host computer and published state),
   * while local ones only refresh the contact profile backup. Called once on connecting to cloud push and on each AGENTS_CHANGED.
   *
   * Only contacts are shared across devices. Agents discovered on the explore page belong only to that computer; other computers can't see them until they're added as contacts,
   * and naturally can't add them either — adding a contact is done on the agent's host computer.
   *
   * Cross-computer collaboration relies on syncing — messages synced over are like typing there, and agent state syncs back the same way.
   * If the pull fails, keep the current state until the next sync.
   */
  async refreshAgents(): Promise<boolean> {
    const contactRevision = this.contactRevision;
    const here = this.options.localComputerId?.();
    if (!here) return false;
    const ownedAgents = await this.pull<RemoteAgent[]>(`${API}/agents`);
    const agents = ownedAgents ? [...ownedAgents] : null;
    if (!agents) return false;
    const friends = await this.pull<RemoteAgent[]>(`${API}/friends`);
    if (!friends) return false;
    for (const friend of friends) if (friend.isAgent && !agents.some(agent => agent.userId === friend.userId)) agents.push(friend);
    const shares = await this.pull<Record<string, string[]>>(`${API}/friends/agent-shares`);
    const contacts = new Set(friends.map((friend) => friend.userId));
    this.remoteAgents = Object.fromEntries(agents.map((agent) => [agent.userId, {
      contact: contacts.has(agent.userId),
      displayName: agent.displayName,
      ...(agent.persona ? { persona: agent.persona } : {})
    }]));
    const state = await this.readState();
    await this.writeState({ pulledAt: state.pulledAt ?? new Date().toISOString(), agents: this.remoteAgents });
    // Local agents follow the local state, even if the cloud records them elsewhere; never treat them as remote
    const localAgents = (await this.cache.listKnownAgents()).filter((agent) => !agent.remote);
    const local = new Set(localAgents.map((agent) => agent.userId));
    // Contact profiles of local agents (nickname, persona, whether a contact) are shared across devices; the cloud database is authoritative and local is only a cache.
    // Exception: local changes not yet uploaded; wait for them to upload first so stale cloud values don't overwrite them
    const cloudById = new Map(agents.map((agent) => [agent.userId, agent]));
    for (const agent of localAgents) {
      const cloud = cloudById.get(agent.userId);
      // A pull can predate a local edit even after its upload left the queue.
      if (this.contactWrites || this.contactRevision !== contactRevision ||
          !cloud || this.queue.some((entry) => entry.key === `contact:${agent.userId}`)) continue;
      const patch: { displayName?: string; persona?: string; sharedWith?: string[]; enabled?: boolean } = {};
      if (shares) patch.sharedWith = shares[agent.userId] ?? [];
      if (cloud.displayName !== agent.displayName) patch.displayName = cloud.displayName;
      const persona = cloud.persona ?? "";
      if (persona !== (agent.persona ?? "")) patch.persona = persona;
      const contact = contacts.has(agent.userId);
      if (contact !== (agent.enabled !== false)) patch.enabled = contact;
      if (!Object.keys(patch).length) continue;
      await this.cache.updateContact(agent.userId, patch);
      await this.options.log?.("cloud-agent-profile-applied", { userId: agent.userId, patch });
    }
    const remote: UserRef[] = [];
    for (const agent of agents) {
      if (!agent.computerId || agent.computerId === here || local.has(agent.userId)) continue;
      // Only contacts are shared: agents on that computer not yet added as contacts aren't synced over
      if (!contacts.has(agent.userId)) continue;
      const kind = agentKindFromCloud(agent.agentType);
      if (!kind) continue;
      remote.push({
        userId: agent.userId,
        displayName: agent.displayName,
        isAgent: true,
        kind,
        ...(agent.agentVersion ? { version: agent.agentVersion } : {}),
        ...(agent.persona ? { persona: agent.persona } : {}),
        owner: agent.owner ?? this.options.user.userId,
        sharedWith: shares?.[agent.userId] ?? [],
        enabled: true,
        remote: {
          computerId: agent.computerId,
          computerName: agent.computerName ?? "",
          online: agent.computerOnline === true,
          readiness: READINESS.includes(agent.readiness as AgentReadiness) ? agent.readiness as AgentReadiness : "unknown",
          ...(agent.model ? { model: remoteAgentModel(agent.model) } : {})
        }
      });
    }
    await this.cache.syncRemoteAgents(remote);
    await this.options.log?.("cloud-agents-synced", { total: agents.length, remote: remote.map((agent) => ({ userId: agent.userId, computer: agent.remote?.computerName, online: agent.remote?.online, readiness: agent.remote?.readiness })) });
    return true;
  }

  /**
   * Register agents discovered on this computer. The first time this computer registers an agent under this account (first sign-in, cache deleted),
   * contact state, nickname, and persona follow the cloud; already registered ones follow the local state and won't be reverted by an old cloud snapshot.
   */
  async syncDiscoveredAgents(agents: DiscoveredAgent[]): Promise<UserRef[]> {
    this.identitySyncs++;
    try {
    await this.flushing;
    const knownAgents = await this.cache.listKnownAgents();
    const known = new Set(knownAgents.map((agent) => agent.userId));
    // Local agents still named with the old default name get the new default name during cache registration; upload it to the cloud afterwards so other devices follow
    const renamed = new Set(knownAgents
      .filter((agent) => !agent.remote && migratedAgentName(agent.kind, agent.displayName))
      .map((agent) => agent.userId));
    const result = await this.cache.syncDiscoveredAgents(agents);
    const repairs = await this.cache.pendingAgentIdentityRepairs();
    for (const repair of repairs) if (renamed.has(repair.from)) renamed.add(repair.to);
    if (repairs.length) {
      for (const repair of repairs) known.add(repair.to);
      // Queue entries reference cached messages/conversations by ID; their
      // sender/member identities were repaired without creating duplicate messages.
      for (const entry of this.queue) {
        if (entry.op.kind !== "contact") continue;
        const previousUserId = entry.op.userId;
        const repair = repairs.find(item => item.from === previousUserId);
        if (repair) { entry.op.userId = repair.to; entry.key = `contact:${repair.to}`; }
      }
      for (const repair of repairs) await this.markContact(repair.to);
      for (const conversation of await this.cache.listConversations()) {
        if (!conversation.members.some(member => repairs.some(item => member.userId === item.to))) continue;
        await this.markConversation(conversation.conversationId, ["members"]);
        let afterSeq = 0;
        for (;;) {
          const page = await this.cache.listMessages(conversation.conversationId, { afterSeq, limit: 1000 });
          if (!page.length) break;
          afterSeq = page[page.length - 1].seq;
          for (const message of page) {
          if (!this.rejectedMessageIds.has(message.messageId)) continue;
          await this.enqueue(`message:${message.messageId}`, { kind: "message", conversationId: conversation.conversationId, messageId: message.messageId, seq: message.seq });
          await appendFile(this.file("sync-rejected.jsonl"), JSON.stringify({ recoveredMessageId: message.messageId }) + "\n", "utf8");
          this.rejectedMessageIds.delete(message.messageId);
          this.emit({ type: "message-delivery", conversationId: conversation.conversationId, messageId: message.messageId, status: "SENDING" });
          }
        }
      }
      await this.writeQueue();
      await this.cache.acknowledgeAgentIdentityRepairs(repairs);
    }
    for (const agent of result) {
      const remote = this.remoteAgents[agent.userId];
      if (known.has(agent.userId) || !remote) continue;
      const migrated = migratedAgentName(agent.kind, remote.displayName);
      if (migrated) renamed.add(agent.userId);
      await this.cache.updateContact(agent.userId, {
        enabled: remote.contact,
        displayName: migrated ?? remote.displayName,
        ...(remote.persona !== undefined ? { persona: remote.persona } : {})
      });
    }
    for (const agent of result) if (renamed.has(agent.userId)) await this.markContact(agent.userId);
    return result;
    } finally {
      if (--this.identitySyncs === 0 && this.queue.length && !this.closed) this.schedule(0);
    }
  }

  listWorkspaces(): Promise<Workspace[]> { return this.cache.listWorkspaces(); }
  getWorkspace(workspaceId: string): Promise<Workspace | null> { return this.cache.getWorkspace(workspaceId); }
  inboxWorkspace(): Promise<Workspace> { return this.cache.inboxWorkspace(); }
  listConversations(): Promise<Conversation[]> { return this.cache.listConversations(); }
  getConversation(conversationId: string): Promise<Conversation | null> { return this.cache.getConversation(conversationId); }
  async listMessages(conversationId: string, options?: Parameters<Store["listMessages"]>[1]): Promise<Message[]> {
    const messages = await this.cache.listMessages(conversationId, options);
    return messages.map((message) => ({ ...message, status: this.deliveryStatus(message) }));
  }

  getAgentSession(conversationId: string, agentUserId: string): Promise<AgentSessionRef | null> {
    return this.cache.getAgentSession(conversationId, agentUserId);
  }
  saveAgentSession(session: AgentSessionRef): Promise<void> { return this.cache.saveAgentSession(session); }

  listSkills(refs?: ScopeRef[]): Promise<Skill[]> { return this.cache.listSkills(refs); }
  knowledgeRoot(): Promise<string> { return this.cache.knowledgeRoot(); }
  getSkill(skillId: string): Promise<Skill | null> { return this.cache.getSkill(skillId); }
  importSkill(input: Parameters<Store["importSkill"]>[0]): Promise<Skill> { return this.cache.importSkill(input); }
  createSkill(input: Parameters<Store["createSkill"]>[0]): Promise<Skill> { return this.cache.createSkill(input); }
  updateSkill(skillId: string, patch: Parameters<Store["updateSkill"]>[1]): Promise<Skill> {
    return this.cache.updateSkill(skillId, patch);
  }
  deleteSkill(skillId: string): Promise<void> { return this.cache.deleteSkill(skillId); }
  bumpSkillUse(skillId: string): Promise<void> { return this.cache.bumpSkillUse(skillId); }
  exportKnowledge(): ReturnType<Store["exportKnowledge"]> { return this.cache.exportKnowledge(); }
  applyCloudSkill(...args: Parameters<Store["applyCloudSkill"]>): Promise<void> { return this.cache.applyCloudSkill(...args); }
  applyCloudMemory(entry: MemoryEntry): Promise<void> { return this.cache.applyCloudMemory(entry); }
  createProposal(input: Parameters<Store["createProposal"]>[0]): Promise<SkillProposal> {
    return this.cache.createProposal(input);
  }
  listProposals(states?: ProposalState[]): Promise<SkillProposal[]> { return this.cache.listProposals(states); }
  getProposal(proposalId: string): Promise<SkillProposal | null> { return this.cache.getProposal(proposalId); }
  recordReview(proposalId: string, review: SkillReview): Promise<SkillProposal> {
    return this.cache.recordReview(proposalId, review);
  }
  setProposalState(proposalId: string, state: ProposalState, blockedReason?: string): Promise<SkillProposal> {
    return this.cache.setProposalState(proposalId, state, blockedReason);
  }
  listMemories(scope: MemoryScope, ownerId: string, options?: Parameters<Store["listMemories"]>[2]): Promise<MemoryEntry[]> {
    return this.cache.listMemories(scope, ownerId, options);
  }
  appendMemory(entry: Parameters<Store["appendMemory"]>[0]): Promise<MemoryEntry> { return this.cache.appendMemory(entry); }
  updateMemory(memoryId: string, patch: Parameters<Store["updateMemory"]>[1]): Promise<MemoryEntry> {
    return this.cache.updateMemory(memoryId, patch);
  }
  deleteMemory(memoryId: string): Promise<void> { return this.cache.deleteMemory(memoryId); }

  subscribe(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Writes that sync to the cloud: write the cache first, then queue
  // -------------------------------------------------------------------------

  async createWorkspace(input: { name: string; path: string }): Promise<Workspace> {
    const workspace = await this.cache.createWorkspace(input);
    await this.markWorkspace(workspace.workspaceId);
    return workspace;
  }

  async updateWorkspace(workspaceId: string, patch: Parameters<Store["updateWorkspace"]>[1]): Promise<Workspace> {
    const workspace = await this.cache.updateWorkspace(workspaceId, patch);
    await this.markWorkspace(workspaceId);
    return workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const before = await this.cache.getWorkspace(workspaceId);
    await this.cache.deleteWorkspace(workspaceId);
    if (!before || before.kind === "inbox") return;
    // Deleting a workspace in the cloud also moves tasks to "no workspace", so tasks don't need separate syncing
    await this.enqueue(
      `workspace-delete:${workspaceId}`,
      { kind: "workspace-delete", workspaceId },
      { drop: (entry) => entry.key === `workspace:${workspaceId}` }
    );
  }

  async pauseAllConversations(): Promise<number> {
    const changed = await this.cache.pauseAllConversations();
    if (changed) for (const conversation of await this.cache.listConversations()) await this.markConversation(conversation.conversationId, ["paused", "members"]);
    return changed;
  }

  async setConversationPaused(conversationId: string, paused: boolean): Promise<Conversation> {
    return this.afterConversation(conversationId, await this.cache.setConversationPaused(conversationId, paused), ["paused", "members"]);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const conversation = await this.cache.createConversation(input);
    return this.afterConversation(conversation.conversationId, conversation);
  }

  async addMember(conversationId: string, userId: string, role: MemberRole): Promise<Conversation> {
    return this.afterConversation(conversationId, await this.cache.addMember(conversationId, userId, role), ["members"]);
  }

  async setMemberRole(conversationId: string, userId: string, role: MemberRole): Promise<Conversation> {
    return this.afterConversation(conversationId, await this.cache.setMemberRole(conversationId, userId, role), ["members"]);
  }

  async setMemberPaused(conversationId: string, userId: string, paused: boolean): Promise<Conversation> {
    return this.afterConversation(conversationId, await this.cache.setMemberPaused(conversationId, userId, paused), ["members"]);
  }

  async removeMember(conversationId: string, userId: string): Promise<Conversation> {
    const user = await this.cache.getUser(userId);
    const conversation = await this.cache.removeMember(conversationId, userId);
    const me = (await this.cache.currentUser()).userId;
    // Only our own local agents are removed by the alignment step; humans, agents on other computers, and others' shared agents all need queuing
    if (user && (!user.isAgent || user.remote || (user.owner ?? me) !== me)) {
      await this.enqueue(`member-remove:${conversationId}:${userId}`, { kind: "member-remove", conversationId, userId });
    }
    return this.afterConversation(conversationId, conversation, ["members"]);
  }

  async updateConversation(conversationId: string, patch: Parameters<Store["updateConversation"]>[1]): Promise<Conversation> {
    const before = structuredClone(await this.cache.getConversation(conversationId));
    const after = await this.cache.updateConversation(conversationId, patch);
    // The settings dialog saves all fields together: upload only those that really changed; unchanged fields must not overwrite the cloud with local values
    const fields = CONVERSATION_SETTINGS.filter((field) => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]));
    return fields.length ? this.afterConversation(conversationId, after, fields) : after;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.cache.deleteConversation(conversationId);
    if (this.dispatching[conversationId]) {
      delete this.dispatching[conversationId];
      await this.writeCursors();
    }
    // Unuploaded changes and messages no longer need uploading
    await this.enqueue(
      `conversation-delete:${conversationId}`,
      { kind: "conversation-delete", conversationId },
      {
        drop: (entry) =>
          entry.key === `task:${conversationId}` || (entry.op.kind === "message" && entry.op.conversationId === conversationId)
      }
    );
  }

  async appendMessage(input: Parameters<Store["appendMessage"]>[0]): Promise<Message> {
    await this.requireCanSpeak(input.conversationId, input.senderId, input.content);
    const message = await this.cache.appendMessage(input);
    await this.enqueue(`message:${message.messageId}`, {
      kind: "message",
      conversationId: message.conversationId,
      messageId: message.messageId,
      seq: message.seq
    });
    this.emit({ type: "message-delivery", conversationId: message.conversationId, messageId: message.messageId, status: "SENDING" });
    return { ...message, status: "SENDING" };
  }

  importAttachment(source: string, name?: string): Promise<Attachment> {
    return this.cache.importAttachment(source, name);
  }

  importAttachmentData(name: string, mimeType: string, bytes: Uint8Array): Promise<Attachment> {
    return this.cache.importAttachmentData(name, mimeType, bytes);
  }

  /** Attachments you sent are already local; ones sent from other devices (phone) are downloaded from OSS into the cache on first use */
  attachmentFile(conversationId: string, attachment: Pick<Attachment, "attachmentId" | "name">): Promise<string> {
    return this.cache.attachments.ensure(attachment, async () => {
      const result = await this.api(
        "GET", `${API}/conversations/${enc(conversationId)}/attachments/${enc(attachment.attachmentId)}/url`
      );
      if (!result.ok) throw new Error(result.message);
      return (result.data as { url: string }).url;
    });
  }

  /** Direct chats with deleted friends: history is kept, but no more sending (the cloud also rejects it) */
  private async requireCanSpeak(conversationId: string, senderId: string, content: string): Promise<void> {
    const me = (await this.cache.currentUser()).userId;
    const conversation = await this.cache.getConversation(conversationId);
    if (senderId !== me || !conversation) return;
    let toPeople = false;
    for (const member of conversation.members) {
      if (member.userId === me) continue;
      const user = await this.cache.getUser(member.userId);
      if (!user || user.isAgent) continue;
      toPeople = true;
      if (conversation.type === "DIRECT" && user.friend === false) throw new Error(tm("main.friends.noLongerFriends"));
    }
    // Messages to other humans pass the cloud's blocked-terms check. Messages are written locally first then queued for upload, so a rejection only ends up in the sync failure log,
    // so ask first before sending and tell the user on the spot. If it can't be checked (unreachable or other reasons), send as usual; the cloud checks again on receipt
    if (!toPeople) return;
    const checked = await this.api("POST", `${API}/conversations/${enc(conversationId)}/messages/check`, { content });
    if (!checked.ok && checked.kind === "rejected" && checked.code === "MSG_009") throw new Error(tm("main.message.blocked"));
  }

  // -------------------------------------------------------------------------
  // Pull messages written by other devices from the cloud (e.g. sent remotely from a phone)
  // -------------------------------------------------------------------------

  /**
   * Another device changed the task name (manual rename, or auto-titled by the agent's host computer); sync it to this device.
   *
   * Task name, permanent flag, goal and instructions, and member roles are shared across devices. Fields not yet uploaded locally are left alone so the just-changed value isn't reverted;
   * once local changes upload, the cloud holds the local value and they converge. Workspace, collaboration progress, and pause state are each computer's own runtime state and aren't merged.
   */
  private async applyRemoteConversationName(remote: RemoteConversation): Promise<void> {
    await this.cache.rememberPeople(remotePeople(remote));
    const local = await this.cache.getConversation(remote.conversationId);
    if (!local) return;
    // Read merging is independent of pending local renames, member changes, etc.
    const me = (await this.cache.currentUser()).userId;
    await this.syncRemoteRead(remote.conversationId, remote.members.find((member) => member.userId === me)?.lastReadSeq);
    const pending = this.queue.filter((entry) => entry.key === `task:${remote.conversationId}`).map((entry) => entry.op);
    if (!remote.name || pending.some((op) => op.kind === "conversation" && !op.fields)) return;
    const dirty = new Set(pending.flatMap((op) => op.kind === "conversation" ? op.fields ?? [] : []));
    // Friend chats are written by several people together: when others add people, remove people, or change the Leader, follow along here
    if (!dirty.has("members")) await this.cache.syncConversationMembers(remote.conversationId, remote.members);
    const patch: Parameters<Store["updateConversation"]>[1] = {};
    if (!dirty.has("name") && local.name !== remote.name) patch.name = remote.name;
    if (!dirty.has("autoTitle") && !!local.autoTitle !== (remote.autoTitle === true)) patch.autoTitle = remote.autoTitle === true;
    if (!!local.shared !== !!remote.shared) patch.shared = !!remote.shared;
    if (!dirty.has("permanent") && !!local.permanent !== !!remote.extra?.permanent) patch.permanent = !!remote.extra?.permanent;
    if (!dirty.has("charter")) {
      const charter = remote.extra?.charter;
      // The internal collaboration strategy belongs only to the leading Agent's host computer; don't follow other computers' changes
      if (charter && !sameCharterText(local.charter, charter)) patch.charter = { ...charter, mode: local.charter?.mode };
      // Missing in the cloud but present locally: the cloud was wholesale overwritten by an old version and lost it (conversations saved by the UI always have a charter); upload it back
      else if (!charter && charterHasText(local.charter)) await this.markConversation(remote.conversationId, ["charter"]);
    }
    if (!Object.keys(patch).length) return;
    await this.cache.updateConversation(remote.conversationId, patch);
    await this.options.log?.("cloud-conversation-renamed", { conversationId: remote.conversationId, from: local.name, to: remote.name, changed: Object.keys(patch) });
  }

  /** On a push that a task changed: sync the task name over */
  async refreshConversation(conversationId: string): Promise<void> {
    const remote = await this.pull<RemoteConversation>(`${API}/conversations/${enc(conversationId)}`);
    if (remote) await this.applyRemoteConversationName(remote);
  }

  /** Reconcile all task names on reconnect: rename pushes during disconnects are missed, this step fills them in */
  async refreshConversationNames(): Promise<void> {
    const conversations = await this.pull<RemoteConversation[]>(`${API}/conversations?limit=${PAGE}`);
    for (const remote of conversations ?? []) await this.applyRemoteConversationName(remote);
  }

  /**
   * Pull cloud messages in a task that aren't local yet, and return the messages newly appended locally.
   *
   * Local and cloud sequence numbers are independent: append one by one in cloud order to the local end, deduping by message ID;
   * messages written locally get deduped when pulled back after uploading. If the task isn't local (a conversation created on a phone), import it first.
   * History messages in an imported task that Agents already replied to or processed only go into local data and aren't returned to the scheduler,
   * otherwise a fully re-pulled old task with a missing cache would execute long-ago questions again.
   * When importing spans several pages, the boundary is persisted before importing and cleared only after the last page:
   * if a page fails or the process crashes midway, next time the task is already local and the pull continues by the same boundary.
   * Pulls for the same task run serially, so simultaneous push and reconnect triggers won't append twice.
   */
  async pullConversationMessages(conversationId: string): Promise<Message[]> {
    return this.pulling.run(conversationId, async () => {
      if (this.closed) return [];
      // Imported task: the cloud already has the sequence an Agent replied to or processed; earlier messages count as processed
      let handledSeq: number | undefined = this.importing[conversationId];
      const agentIds = new Set<string>();
      const local = await this.cache.getConversation(conversationId);
      if (local && handledSeq !== undefined) {
        // Import unfinished last time: identify Agents from local task members and keep advancing the boundary
        for (const member of local.members) {
          if ((await this.cache.getUser(member.userId))?.isAgent) agentIds.add(member.userId);
        }
      }
      if (!local) {
        // A task just deleted locally whose deletion hasn't uploaded must not be imported back from the cloud
        if (this.queue.some((entry) => entry.op.kind === "conversation-delete" && entry.op.conversationId === conversationId)) {
          if (this.dispatching[conversationId]) {
            delete this.dispatching[conversationId];
            await this.writeCursors();
          }
          return [];
        }
        const remote = await this.pull<RemoteConversation>(`${API}/conversations/${enc(conversationId)}`);
        if (!remote) return [];
        await this.cache.rememberPeople(remotePeople(remote));
        for (const member of remote.members) {
          if (member.isAgent || (await this.cache.getUser(member.userId))?.isAgent) agentIds.add(member.userId);
        }
        handledSeq = Math.max(handledSeq ?? 0, ...remote.members.filter((member) => agentIds.has(member.userId)).map((member) => member.lastProcessedSeq ?? 0));
        // Record the boundary before writing the task: an intermediate state with the task local but the boundary not persisted would treat history as new messages
        this.importing[conversationId] = handledSeq;
        await this.writeCursors();
        await this.cache.importConversation(toLocalConversation(remote));
        await this.options.log?.("cloud-conversation-imported", { conversationId, name: remote.name });
      }
      const before = this.cursors[conversationId] ?? 0;
      let cursor = before;
      const added: Message[] = [];
      let complete = false;
      for (;;) {
        let page: RemoteMessage[] | undefined;
        try {
          page = await this.pull<RemoteMessage[]>(
            `${API}/conversations/${enc(conversationId)}/messages?afterSeq=${cursor}&limit=${PAGE}`
          );
        } catch (error) {
          // Return earlier pages for dispatch even if a later request fails.
          await this.options.log?.("cloud-message-page-failed", { conversationId, error: String(error) });
          break;
        }
        if (!page) break;
        await this.cache.syncMessageTimes(conversationId, page.map((remote) => ({
          messageId: remote.messageId, createdAt: remote.gmtCreated
        })));
        const fresh: RemoteMessage[] = [];
        for (const remote of page) {
          cursor = Math.max(cursor, remote.seq);
          if (handledSeq !== undefined && agentIds.has(remote.senderId)) handledSeq = Math.max(handledSeq, remote.seq);
          if (!(await this.cache.hasMessage(conversationId, remote.messageId))) fresh.push(remote);
        }
        // Record "pending dispatch" before writing the local cache: if it crashes after appending but before handing to the scheduler, restart can hand it over again.
        // History before the import boundary needn't execute, so it's not recorded; the boundary rises with paging and is persisted together.
        const owed = fresh.filter((remote) => handledSeq === undefined || remote.seq > handledSeq);
        if (owed.length || (handledSeq !== undefined && fresh.length)) {
          const entries = (this.dispatching[conversationId] ??= {});
          for (const remote of owed) entries[remote.messageId] = remote.seq;
          if (handledSeq !== undefined) this.importing[conversationId] = handledSeq;
          await this.writeCursors();
        }
        for (const remote of fresh) {
          const message = toLocalMessage(remote);
          added.push(await this.cache.appendMessage({
            createdAt: message.createdAt,
            conversationId,
            clientMessageId: message.messageId,
            senderId: message.senderId,
            content: message.content,
            type: message.type,
            mentions: message.mentions,
            replyTo: message.replyTo,
            quote: message.quote,
            internal: message.internal,
            agentReply: message.agentReply,
            coordination: message.coordination,
            steps: message.steps,
            report: message.report,
            failed: message.failed,
            attachments: message.attachments
          }));
        }
        if (page.length < PAGE) {
          complete = true;
          break;
        }
      }
      const importing = handledSeq !== undefined;
      if (importing) {
        if (complete) delete this.importing[conversationId];
        else this.importing[conversationId] = handledSeq!;
      }
      // Before the final boundary position is history Agents already replied to; no longer pending dispatch
      const entries = this.dispatching[conversationId] ?? {};
      let dropped = false;
      for (const [messageId, seq] of Object.entries(entries)) {
        if (handledSeq && seq <= handledSeq) {
          delete entries[messageId];
          dropped = true;
        }
      }
      // Pending dispatch left by the last run: hand over again if still in the local cache; drop it if not cached and the cursor has passed it (task deleted)
      const addedIds = new Set(added.map((message) => message.messageId));
      const leftover = Object.keys(entries).filter((messageId) => !addedIds.has(messageId) && !this.handedOut.has(messageId));
      const recovered = leftover.length ? await this.cache.getMessages(conversationId, leftover) : [];
      const found = new Set(recovered.map((message) => message.messageId));
      for (const messageId of leftover) {
        if (!found.has(messageId) && entries[messageId] <= cursor) {
          delete entries[messageId];
          dropped = true;
        }
      }
      if (this.dispatching[conversationId] && !Object.keys(entries).length) delete this.dispatching[conversationId];
      if (cursor !== before || importing || dropped) {
        this.cursors[conversationId] = cursor;
        await this.writeCursors();
      }
      if (recovered.length) {
        await this.options.log?.("cloud-messages-redispatched", { conversationId, messageIds: recovered.map((message) => message.messageId) });
      }
      if (added.length) {
        await this.options.log?.("cloud-messages-pulled", {
          conversationId, cloudFrom: before, cloudTo: cursor, added: added.map((m) => ({ messageId: m.messageId, seq: m.seq, senderId: m.senderId }))
        });
      }
      const pending = added.filter((message) => entries[message.messageId] !== undefined);
      if (pending.length < added.length) {
        await this.options.log?.("cloud-history-imported", { conversationId, handledSeq, skipped: added.length - pending.length });
      }
      const result = [...recovered, ...pending];
      for (const message of result) this.handedOut.add(message.messageId);
      return result;
    });
  }

  /**
   * Messages returned by the pull have been recorded in the local "unprocessed" ledger (or confirmed not needing handover). Only removed from pending dispatch once the caller confirms;
   * the pull itself doesn't assume messages were dispatched.
   */
  async ackDispatched(messages: Pick<Message, "conversationId" | "messageId">[]): Promise<void> {
    let changed = false;
    for (const { conversationId, messageId } of messages) {
      this.handedOut.delete(messageId);
      const entries = this.dispatching[conversationId];
      if (entries?.[messageId] === undefined) continue;
      delete entries[messageId];
      if (!Object.keys(entries).length) delete this.dispatching[conversationId];
      changed = true;
    }
    if (changed) await this.writeCursors();
  }

  /** Socket hints, reconnects and the periodic reconciliation all share this incremental path. */
  async pullAllConversationMessages(): Promise<Message[]> {
    const added: Message[] = [];
    let afterId = 0;
    while (!this.closed) {
      let result: ApiResult;
      try {
        result = await this.api("GET", `${API}/conversations/sync-cursors?afterId=${afterId}&limit=${PAGE}`);
      } catch (error) {
        await this.options.log?.("cloud-reconcile-page-failed", { afterId, error: String(error) });
        break;
      }
      if (!result.ok) return added;
      const page = result.data as { syncId: number; conversationId: string; lastSeq: number; lastReadSeq?: number }[];
      if (!Array.isArray(page)) {
        await this.options.log?.("cloud-reconcile-invalid-page", { afterId });
        break;
      }
      for (const conversation of page) await this.pullIfBehind(conversation, added);
      if (page.length < PAGE) break;
      const next = page.at(-1)!.syncId;
      if (!Number.isSafeInteger(next) || next <= afterId) {
        await this.options.log?.("cloud-reconcile-invalid-cursor", { afterId });
        break;
      }
      afterId = next;
    }
    return added;
  }

  private async pullIfBehind(conversation: { conversationId: string; lastSeq: number; lastReadSeq?: number }, added: Message[]): Promise<void> {
    if (this.closed) return;
    // Tasks not fully imported are pulled again even if the cursor caught up, to confirm the end and clear the import boundary;
    // messages not confirmed dispatched last run likewise need another pull to be handed over
    if (conversation.lastSeq <= (this.cursors[conversation.conversationId] ?? 0) &&
        this.importing[conversation.conversationId] === undefined &&
        !Object.keys(this.dispatching[conversation.conversationId] ?? {}).some((messageId) => !this.handedOut.has(messageId)) &&
        await this.cache.getConversation(conversation.conversationId)) {
      await this.syncRemoteRead(conversation.conversationId, conversation.lastReadSeq);
      return;
    }
    try {
      added.push(...await this.pullConversationMessages(conversation.conversationId));
    } catch (error) {
      // Deleted/revoked or temporarily failing conversations cannot starve other deliveries.
      await this.options.log?.("cloud-conversation-pull-failed", { conversationId: conversation.conversationId, error: String(error) });
    }
    await this.syncRemoteRead(conversation.conversationId, conversation.lastReadSeq);
  }

  /**
   * After another terminal reads, merge the cloud read position locally. Reads may happen even without sequence changes; disconnects and missed pushes are filled in by periodic reconciliation.
   * Local and cloud sequence numbers are independent and can't be compared directly: first ask the cloud which message is at that position, then take its local sequence.
   * If this message isn't local yet (not pulled), try again next time. No need to ask if everything is already read locally.
   */
  private async syncRemoteRead(conversationId: string, remoteSeq: number | undefined): Promise<void> {
    if (!remoteSeq || remoteSeq <= (this.remoteReadApplied[conversationId] ?? 0)) return;
    try {
      const me = (await this.cache.currentUser()).userId;
      const conversation = await this.cache.getConversation(conversationId);
      const mine = conversation?.members.find((member) => member.userId === me);
      if (!conversation || !mine || mine.lastReadSeq >= conversation.lastSeq) return;
      const [remote] = await this.pull<RemoteMessage[]>(`${API}/conversations/${enc(conversationId)}/messages?beforeSeq=${remoteSeq + 1}&limit=1`) ?? [];
      if (!remote) return;
      const [local] = await this.cache.getMessages(conversationId, [remote.messageId]);
      if (!local) return;
      await this.cache.syncConversationReadState(conversationId, [{ userId: me, lastReadSeq: local.seq }]);
      this.remoteReadApplied[conversationId] = remoteSeq;
    } catch (error) {
      await this.options.log?.("cloud-read-sync-failed", { conversationId, error: String(error) });
    }
  }

  async markRead(conversationId: string, userId: string, seq: number): Promise<void> {
    await this.cache.markRead(conversationId, userId, seq);
    await this.markConversation(conversationId, []);
  }

  async markProcessed(conversationId: string, agentUserId: string, seq: number): Promise<void> {
    await this.cache.markProcessed(conversationId, agentUserId, seq);
    await this.markConversation(conversationId, []);
  }

  // Unprocessed user messages only concern local Agents; kept in the local cache, not uploaded
  oweMessage(conversationId: string, messageId: string): Promise<void> {
    return this.cache.oweMessage(conversationId, messageId);
  }

  settleOwed(conversationId: string, messageIds?: string[]): Promise<void> {
    return this.cache.settleOwed(conversationId, messageIds);
  }

  listOwedMessages(conversationId?: string): Promise<Message[]> {
    return this.cache.listOwedMessages(conversationId);
  }

  // -------------------------------------------------------------------------
  // Pending sync queue
  // -------------------------------------------------------------------------

  private async afterConversation(conversationId: string, conversation: Conversation, fields?: ConversationField[]): Promise<Conversation> {
    await this.markConversation(conversationId, fields);
    return conversation;
  }

  /** Omitted fields means whole upload, [] only aligns watermarks; changed fields of the same queued task are unioned */
  private markConversation(conversationId: string, fields?: ConversationField[]): Promise<void> {
    const key = `task:${conversationId}`;
    const pending = this.queue.find((entry) => entry.key === key && entry !== this.inFlight)?.op;
    const queued = pending?.kind === "conversation" ? pending : undefined;
    const merged = !fields || (queued && !queued.fields) ? undefined : [...new Set([...(queued?.fields ?? []), ...fields])];
    return this.enqueue(key, { kind: "conversation", conversationId, ...(merged ? { fields: merged } : {}) }, { replace: true });
  }

  private async editContact<T>(write: () => Promise<T>): Promise<T> {
    this.contactRevision++;
    this.contactWrites++;
    try { return await write(); }
    finally { this.contactWrites--; this.contactRevision++; }
  }

  private markContact(userId: string): Promise<void> {
    return this.enqueue(`contact:${userId}`, { kind: "contact", userId });
  }

  private markWorkspace(workspaceId: string): Promise<void> {
    return this.enqueue(`workspace:${workspaceId}`, { kind: "workspace", workspaceId });
  }

  private async enqueue(
    key: string,
    op: SyncOp,
    options: { drop?: (entry: QueueEntry) => boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (options.drop) {
      const drop = options.drop;
      this.queue = this.queue.filter((entry) => entry === this.inFlight || !drop(entry));
    }
    const pending = this.queue.find((entry) => entry.key === key && entry !== this.inFlight);
    if (pending) {
      if (options.replace) pending.op = op;
    } else {
      this.queue.push({ id: newId("message"), key, op, createdAt: new Date().toISOString() });
    }
    await this.writeQueue();
    // A failed read request may also set the state to offline; a new write must guarantee at least one upload retry.
    this.schedule(this.online === false ? this.retryMs : 0);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    const dueAt = Date.now() + ms;
    if (this.timer && this.timerDueAt <= dueAt) return;
    clearTimeout(this.timer);
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDueAt = 0;
      void this.flush();
    }, ms);
  }

  private flush(): Promise<void> {
    if (this.identitySyncs) return Promise.resolve();
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    const run = (async () => {
      try {
        do {
          this.flushAgain = false;
          while (!this.closed) {
            const entry = this.queue[0];
            if (!entry) break;
            this.inFlight = entry;
            let outcome: Outcome;
            try {
              outcome = await this.replay(entry.op);
            } catch (error) {
              await this.options.log?.("cloud-sync-error", { key: entry.key, error: String(error) });
              outcome = "retry";
            } finally {
              this.inFlight = undefined;
            }
            if (outcome === "retry") {
              this.setOnline(false);
              this.schedule(this.retryMs);
              return;
            }
            if (outcome === "rejected") await this.recordRejected(entry);
            this.queue = this.queue.filter((item) => item !== entry);
            await this.writeQueue();
            if (entry.op.kind === "message") {
              this.emit({ type: "message-delivery", conversationId: entry.op.conversationId, messageId: entry.op.messageId, status: outcome === "rejected" ? "FAILED" : "SENT" });
            }
          }
        } while (this.flushAgain && !this.closed);
        if (!this.closed && this.queue.length === 0) this.setOnline(true);
      } finally {
        // With an empty queue this runs synchronously: finally executes before the assignment below.
        // So only clear the marker if it still points to this run; otherwise a stale marker stays "syncing" forever and nothing uploads again
        queueMicrotask(() => {
          if (this.flushing === run) this.flushing = undefined;
        });
      }
    })();
    this.flushing = run;
    return run;
  }

  /**
   * Changes the cloud explicitly rejects (e.g. this task was deleted elsewhere while offline) aren't retried, otherwise they'd fail forever.
   * Recorded in the sync log and kept for viewing.
   */
  private async recordRejected(entry: QueueEntry): Promise<void> {
    await appendFile(
      path.join(this.options.root, "sync-rejected.jsonl"),
      JSON.stringify({ ...entry, rejectedAt: new Date().toISOString() }) + "\n",
      "utf8"
    );
    if (entry.op.kind === "message") this.rejectedMessageIds.add(entry.op.messageId);
    await this.options.log?.("cloud-sync-rejected", { key: entry.key });
  }

  private deliveryStatus(message: Message): MessageStatus {
    if (this.queue.some((entry) => entry.op.kind === "message" && entry.op.messageId === message.messageId)) return "SENDING";
    return this.rejectedMessageIds.has(message.messageId) ? "FAILED" : message.status;
  }

  private async readRejectedMessageIds(): Promise<void> {
    try {
      const journal = await readFile(this.file("sync-rejected.jsonl"), "utf8");
      for (const line of journal.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as QueueEntry & { recoveredMessageId?: string };
          if (entry.recoveredMessageId) { this.rejectedMessageIds.delete(entry.recoveredMessageId); continue; }
          if (entry.op?.kind === "message") this.rejectedMessageIds.add(entry.op.messageId);
        } catch { /* A damaged journal line must not prevent startup. */ }
      }
    } catch { /* No rejected writes yet. */ }
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.emit({ type: "connection", online });
  }

  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One subscriber throwing shouldn't affect others
      }
    }
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  private async replay(op: SyncOp): Promise<Outcome> {
    switch (op.kind) {
      case "workspace":
        return this.replayWorkspace(op.workspaceId);
      case "workspace-delete":
        return this.outcome(await this.api("DELETE", `${API}/workspaces/${enc(op.workspaceId)}`));
      case "conversation":
        return this.replayConversation(op);
      case "conversation-delete":
        return this.outcome(await this.api("DELETE", `${API}/conversations/${enc(op.conversationId)}`));
      case "message":
        return this.replayMessage(op);
      case "profile":
        return this.outcome(await this.api("PUT", `${API}/profile`, op.profile));
      case "contact":
        return this.replayContact(op.userId);
      case "member-remove":
        return this.outcome(await this.api("DELETE", `${API}/conversations/${enc(op.conversationId)}/members/${enc(op.userId)}`));
      default: {
        // Unrecognized operations (e.g. old names not migrated) must not be silently dequeued as synced: record as rejected, kept in the rejected log for inspection
        await this.options.log?.("cloud-sync-unknown-op", { kind: String((op as { kind?: unknown }).kind) });
        return "rejected";
      }
    }
  }

  private api(method: ApiMethod, route: string, body?: object): Promise<ApiResult> {
    return this.options.api(method, route, body);
  }

  private outcome(result: ApiResult): Outcome {
    if (result.ok) return "done";
    if (result.kind !== "rejected") return "retry";
    if (result.code && ALREADY_DONE.has(result.code)) return "done";
    // An invalid token must wait for re-sign-in; don't drop it as "the cloud doesn't want this change"
    return result.status === 401 ? "retry" : "rejected";
  }

  private async replayWorkspace(workspaceId: string): Promise<Outcome> {
    const workspace = await this.cache.getWorkspace(workspaceId);
    // Already deleted (deletion has its own entry), or it's "no workspace" (the cloud has its own)
    if (!workspace || workspace.kind === "inbox" || !workspace.path) return "done";
    const body = { name: workspace.name, path: workspace.path };
    const created = this.outcome(await this.api("POST", `${API}/workspaces`, { workspaceId, ...body }));
    if (created !== "done") return created;
    return this.outcome(await this.api("PUT", `${API}/workspaces/${enc(workspaceId)}`, body));
  }

  private async replayContact(userId: string): Promise<Outcome> {
    const agent = await this.cache.getUser(userId);
    if (!agent?.isAgent) return "done";
    const profile = this.outcome(await this.api("PUT", `${API}/agents/${enc(userId)}`, {
      displayName: agent.displayName,
      ...(agent.persona !== undefined ? { persona: agent.persona } : {})
    }));
    if (profile !== "done") return profile;
    // Empty enabled counts as added, consistent with LocalStore.listContacts
    return this.outcome(await this.api(agent.enabled === false ? "DELETE" : "POST", `${API}/friends/${enc(userId)}`));
  }

  /**
   * Upload locally changed fields to the cloud: create if missing; read and processed watermarks are always filled in.
   * Unchanged fields aren't uploaded: multiple computers and members each have a cache, and a whole upload would overwrite settings others just changed with a stale copy.
   */
  private async replayConversation(op: Extract<SyncOp, { kind: "conversation" }>): Promise<Outcome> {
    const { conversationId } = op;
    const conversation = await this.cache.getConversation(conversationId);
    if (!conversation) return "done";
    const route = `${API}/conversations/${enc(conversationId)}`;
    const workspaceId = await this.remoteWorkspaceId(conversation.workspaceId);

    let fetched = await this.api("GET", route);
    let dirty = op.fields && new Set(op.fields);
    if (!fetched.ok && fetched.kind === "rejected" && fetched.code === "CONVERSATION_001") {
      dirty = undefined;
      fetched = await this.api("POST", `${API}/conversations`, {
        conversationId,
        type: conversation.type,
        name: conversation.name ?? "未命名任务",
        members: conversation.members.map((member) => ({ userId: member.userId, role: member.role })),
        workspaceId,
        autoTitle: Boolean(conversation.autoTitle),
        seedKey: conversation.seedKey,
        extra: conversationExtra(conversation)
      });
    }
    if (!fetched.ok) return this.outcome(fetched);
    const remote = fetched.data as RemoteConversation;

    const changed = (field: ConversationField) => !dirty || dirty.has(field);
    const settings = {
      ...(changed("name") ? { name: conversation.name } : {}),
      ...(changed("owner") ? { owner: conversation.owner } : {}),
      ...(changed("workspaceId") ? { workspaceId } : {}),
      ...(changed("status") ? { status: conversation.status } : {}),
      ...(changed("paused") ? { paused: conversation.paused } : {}),
      ...(changed("autoTitle") ? { autoTitle: Boolean(conversation.autoTitle) } : {}),
      ...(CONVERSATION_EXTRA_FIELDS.some(changed) ? { extra: mergedExtra(conversation, remote.extra, changed) } : {})
    };
    if (Object.keys(settings).length) {
      const updated = this.outcome(await this.api("PUT", route, { ...settings, touch: false }));
      if (updated !== "done") return updated;
    }

    const remoteMembers = new Map(remote.members.map((member) => [member.userId, member]));
    const me = (await this.cache.currentUser()).userId;
    const isAgent = async (userId: string) => {
      const user = await this.cache.getUser(userId);
      return !!user?.isAgent && (user.owner ?? me) === me && !user.remote;
    };
    for (const member of conversation.members) {
      const current = remoteMembers.get(member.userId);
      if (!current && !changed("members")) continue;
      if (!current) {
        const added = this.outcome(await this.api("POST", `${route}/members`, { userId: member.userId, role: member.role }));
        if (added !== "done") return added;
      }
      const roleChanged = changed("members") && Boolean(current) && conversation.type === "GROUP" && current?.role !== member.role;
      const pausedChanged = changed("members") && Boolean(current?.paused) !== Boolean(member.paused);
      const resumeChanged = changed("members") && Boolean(current?.resumeOnContinue) !== Boolean(member.resumeOnContinue);
      if (roleChanged || pausedChanged || resumeChanged) {
        const patched = this.outcome(await this.api("PUT", `${route}/members/${enc(member.userId)}`, {
          ...(roleChanged ? { role: member.role } : {}),
          paused: Boolean(member.paused),
          resumeOnContinue: Boolean(member.resumeOnContinue)
        }));
        if (patched !== "done") return patched;
      }
      // Read and processed positions can only be reported for yourself and your own agents; a friend's positions are reported from their side
      if (member.userId !== me && !(await isAgent(member.userId))) continue;
      const sender = `?senderId=${enc(member.userId)}`;
      if (member.lastReadSeq > (current?.lastReadSeq ?? 0)) {
        const read = this.outcome(await this.api("PUT", `${route}/messages/read${sender}`, { seq: member.lastReadSeq }));
        if (read !== "done") return read;
      }
      const remoteProcessed = current?.lastProcessedSeq ?? current?.lastReadSeq ?? 0;
      if (member.lastProcessedSeq !== undefined && member.lastProcessedSeq > remoteProcessed) {
        const processed = this.outcome(
          await this.api("PUT", `${route}/messages/processed${sender}`, { seq: member.lastProcessedSeq })
        );
        if (processed !== "done") return processed;
      }
    }
    if (changed("members")) for (const [userId, member] of remoteMembers) {
      if (userId === remote.owner || conversation.members.some((local) => local.userId === userId)) continue;
      // Human removals are queued separately (member-remove); here only align your own agents, so people a friend just added aren't removed
      if (!member.isAgent || !(await isAgent(userId))) continue;
      const removed = this.outcome(await this.api("DELETE", `${route}/members/${enc(userId)}`));
      if (removed !== "done") return removed;
    }
    return "done";
  }

  private async replayMessage(op: Extract<SyncOp, { kind: "message" }>): Promise<Outcome> {
    const [message] = await this.cache.listMessages(op.conversationId, { afterSeq: op.seq - 1, limit: 1 });
    // The task was deleted, or the cache was rebuilt: no need to upload this one
    if (!message || message.messageId !== op.messageId) return "done";
    const me = (await this.cache.currentUser()).userId;
    const query = message.senderId === me ? "" : `?senderId=${enc(message.senderId)}`;
    // Register attachments and upload to OSS first, then send the message; on failure retry the whole thing; registration and upload are idempotent by attachment ID
    for (const attachment of message.attachments ?? []) {
      const uploaded = await this.uploadAttachment(op.conversationId, query, attachment);
      if (uploaded !== "done") return uploaded;
    }
    const result = await this.api("POST", `${API}/conversations/${enc(op.conversationId)}/messages${query}`, {
      messageId: message.messageId,
      content: message.content,
      type: message.type,
      mentions: message.mentions,
      replyTo: message.replyTo,
      internal: Boolean(message.internal),
      report: Boolean(message.report),
      failed: Boolean(message.failed),
      extra: messageExtra(message),
      ...(message.attachments?.length ? { attachments: message.attachments.map((item) => item.attachmentId) } : {})
    });
    if (result.ok) {
      const remote = result.data as RemoteMessage;
      // In phase one only one computer writes, so cloud-assigned sequences should match local; record mismatches for now, handle multi-computer in phase two
      if (remote.seq !== message.seq) {
        await this.options.log?.("cloud-seq-mismatch", { conversationId: op.conversationId, local: message.seq, remote: remote.seq });
      }
      // Read and processed positions may have synced before this message: at that point the cloud didn't have it yet, so positions were clamped to the cloud's max sequence at the time.
      // If this task has no more messages pending upload, align positions once more
      const conversation = await this.cache.getConversation(op.conversationId);
      const pointerAhead = conversation?.members.some(
        (member) => member.lastReadSeq >= message.seq || (member.lastProcessedSeq ?? 0) >= message.seq
      );
      const laterMessage = this.queue.some(
        (entry) => entry !== this.inFlight && entry.op.kind === "message" && entry.op.conversationId === op.conversationId
      );
      if (pointerAhead && !laterMessage) await this.markConversation(op.conversationId, []);
    }
    return this.outcome(result);
  }

  private async uploadAttachment(conversationId: string, query: string, attachment: Attachment): Promise<Outcome> {
    const result = await this.api("POST", `${API}/conversations/${enc(conversationId)}/attachments${query}`, {
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size
    });
    if (!result.ok) return this.outcome(result);
    const ticket = result.data as AttachmentTicket;
    if (ticket.uploaded) return "done";
    let file: string;
    try {
      file = await this.cache.attachments.ensure(attachment);
    } catch {
      // The file in the local attachments directory was deleted; retrying will never upload it
      await this.options.log?.("cloud-attachment-missing", { conversationId, attachmentId: attachment.attachmentId });
      return "rejected";
    }
    try {
      await (this.options.uploadFile ?? uploadFile)(ticket.uploadUrl, file, ticket.contentType);
      return "done";
    } catch (error) {
      await this.options.log?.("cloud-attachment-upload-failed", {
        conversationId, attachmentId: attachment.attachmentId, error: error instanceof Error ? error.message : String(error)
      });
      return "retry";
    }
  }

  /** "No workspace" has separate IDs locally and in the cloud; omit it when sending to the cloud, which assigns its own "no workspace" */
  private async remoteWorkspaceId(workspaceId: string): Promise<string | undefined> {
    const workspace = await this.cache.getWorkspace(workspaceId);
    return workspace && workspace.kind !== "inbox" ? workspaceId : undefined;
  }

  // -------------------------------------------------------------------------
  // Full pull
  // -------------------------------------------------------------------------

  private async pullSnapshot(): Promise<(SyncedSnapshot & { agents: RemoteAgentState }) | undefined> {
    const workspaces = await this.pull<RemoteWorkspace[]>(`${API}/workspaces`);
    if (!workspaces) return undefined;
    const ownedAgents = await this.pull<RemoteAgent[]>(`${API}/agents`);
    const agents = ownedAgents ? [...ownedAgents] : null;
    if (!agents) return undefined;
    const friends = await this.pull<RemoteAgent[]>(`${API}/friends`);
    if (!friends) return undefined;
    for (const friend of friends) if (friend.isAgent && !agents.some(agent => agent.userId === friend.userId)) agents.push(friend);
    const contacts = new Set(friends.map((friend) => friend.userId));
    const conversations = await this.pull<RemoteConversation[]>(`${API}/conversations?limit=${PAGE}`);
    if (!conversations) return undefined;
    const messages: Record<string, Message[]> = {};
    for (const conversation of conversations) {
      const all: Message[] = [];
      let afterSeq = 0;
      for (;;) {
        const page = await this.pull<RemoteMessage[]>(
          `${API}/conversations/${enc(conversation.conversationId)}/messages?afterSeq=${afterSeq}&limit=${PAGE}`
        );
        if (!page) return undefined;
        all.push(...page.map(toLocalMessage));
        if (page.length < PAGE) break;
        afterSeq = page[page.length - 1].seq;
      }
      messages[conversation.conversationId] = all;
    }
    return {
      workspaces: workspaces.map(toLocalWorkspace),
      conversations: conversations.map(toLocalConversation),
      messages,
      agents: Object.fromEntries(agents.map((agent) => [agent.userId, {
        contact: contacts.has(agent.userId),
        displayName: agent.displayName,
        ...(agent.persona ? { persona: agent.persona } : {})
      }]))
    };
  }

  private async pull<T>(route: string): Promise<T | undefined> {
    const result = await this.api("GET", route);
    if (result.ok) {
      this.setOnline(true);
      if (this.queue.length && !this.flushing) this.schedule(0);
      return result.data as T;
    }
    if (result.kind === "rejected" && result.status !== 401) {
      throw new Error(tm("main.store.cloudFetchFailed", { message: result.message }));
    }
    this.setOnline(false);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Persist queue and sync state
  // -------------------------------------------------------------------------

  private async readQueue(): Promise<QueueEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file("sync-queue.json"), "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeQueue(): Promise<void> {
    this.queueWrites = this.queueWrites
      .catch(() => undefined)
      .then(() => writeAtomic(this.file("sync-queue.json"), JSON.stringify(this.queue, null, 2)));
    return this.queueWrites;
  }

  private async readState(): Promise<{ pulledAt?: string; agents?: RemoteAgentState }> {
    try {
      return JSON.parse(await readFile(this.file("sync-state.json"), "utf8"));
    } catch {
      return {};
    }
  }

  private writeState(state: { pulledAt: string; agents: RemoteAgentState }): Promise<void> {
    return writeAtomic(this.file("sync-state.json"), JSON.stringify(state, null, 2));
  }

  private async readCursors(): Promise<{ cursors: Record<string, number>; importing: Record<string, number>; dispatching: Record<string, Record<string, number>> }> {
    try {
      const parsed = JSON.parse(await readFile(this.file("cloud-cursors.json"), "utf8"));
      // Old cursors lack the time-fix version: scan once from zero, only correcting times of existing messages without re-executing.
      if (parsed?.version !== 2 || !parsed.cursors || typeof parsed.cursors !== "object") return { cursors: {}, importing: {}, dispatching: {} };
      const importing = parsed.importing && typeof parsed.importing === "object" ? parsed.importing : {};
      const dispatching = parsed.dispatching && typeof parsed.dispatching === "object" ? parsed.dispatching : {};
      return { cursors: parsed.cursors, importing, dispatching };
    } catch {
      return { cursors: {}, importing: {}, dispatching: {} };
    }
  }

  private writeCursors(): Promise<void> {
    return this.cursorWrites.run("cursors", () => writeAtomic(this.file("cloud-cursors.json"), JSON.stringify({ version: 2, cursors: this.cursors, importing: this.importing, dispatching: this.dispatching }, null, 2)));
  }

  private file(name: string): string {
    return path.join(this.options.root, name);
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${newId("message")}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

/** Cloud times include a timezone; stored locally in toISOString format so sorting and comparison are consistent */
function iso(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function conversationExtra(conversation: Conversation): ConversationExtra {
  return {
    permanent: !!conversation.permanent,
    charter: conversation.charter,
    workPlan: conversation.workPlan,
    brainstorm: conversation.brainstorm,
    followUp: conversation.followUp,
    workspacePath: conversation.workspacePath
  };
}

/** On the cloud extra, replace only locally changed fields; keep the collaboration mode written by the leading computer if absent locally */
function mergedExtra(conversation: Conversation, remote: ConversationExtra | undefined, changed: (field: ConversationField) => boolean): ConversationExtra {
  const local = conversationExtra(conversation);
  const merged: ConversationExtra = { ...remote };
  for (const field of CONVERSATION_EXTRA_FIELDS) if (changed(field)) Object.assign(merged, { [field]: local[field] });
  if (changed("charter") && local.charter && !local.charter.mode && remote?.charter?.mode) merged.charter = { ...local.charter, mode: remote.charter.mode };
  return merged;
}

function charterHasText(charter: Conversation["charter"]): boolean {
  return !!(charter?.goal || charter?.instructions || charter?.boundary || charter?.doneWhen);
}

function sameCharterText(a: Conversation["charter"], b: Conversation["charter"]): boolean {
  return (["goal", "instructions", "boundary", "doneWhen"] as const).every((key) => (a?.[key] ?? "") === (b?.[key] ?? ""));
}

function messageExtra(message: Message): MessageExtra {
  return { steps: message.steps, agentReply: message.agentReply, coordination: message.coordination, quote: message.quote };
}

function toLocalWorkspace(remote: RemoteWorkspace): Workspace {
  return {
    workspaceId: remote.workspaceId,
    name: remote.name,
    ...(remote.path ? { path: remote.path } : {}),
    kind: remote.kind === "INBOX" ? "inbox" : "folder",
    createdAt: iso(remote.gmtCreated),
    updatedAt: iso(remote.gmtModified ?? remote.gmtCreated)
  };
}

function toLocalConversation(remote: RemoteConversation): Conversation {
  const extra = remote.extra ?? {};
  return {
    permanent: !!extra.permanent,
    shared: !!remote.shared,
    conversationId: remote.conversationId,
    type: remote.type,
    name: remote.name,
    ...(remote.autoTitle ? { autoTitle: true } : {}),
    workspaceId: remote.workspaceId,
    creator: remote.creator,
    owner: remote.owner,
    lastSeq: remote.lastSeq,
    members: remote.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      lastReadSeq: member.lastReadSeq,
      ...(member.lastProcessedSeq !== undefined && member.lastProcessedSeq !== null
        ? { lastProcessedSeq: member.lastProcessedSeq }
        : {}),
      ...(member.firstUnreadMentionSeq ? { firstUnreadMentionSeq: member.firstUnreadMentionSeq } : {}),
      paused: Boolean(member.paused),
      ...(member.resumeOnContinue ? { resumeOnContinue: true } : {}),
      ...(member.ownerPaused ? { ownerPaused: true } : {})
    })),
    ...(extra.workspacePath ? { workspacePath: extra.workspacePath } : {}),
    ...(extra.charter ? { charter: extra.charter } : {}),
    ...(extra.workPlan ? { workPlan: extra.workPlan } : {}),
    ...(extra.brainstorm ? { brainstorm: extra.brainstorm } : {}),
    ...(extra.followUp ? { followUp: extra.followUp } : {}),
    ...(remote.seedKey ? { seedKey: remote.seedKey } : {}),
    status: remote.status ?? "ACTIVE",
    paused: Boolean(remote.paused),
    createdAt: iso(remote.gmtCreated),
    updatedAt: iso(remote.gmtModified ?? remote.gmtCreated)
  };
}

function toLocalMessage(remote: RemoteMessage): Message {
  const extra = remote.extra ?? {};
  return {
    ...(remote.internal ? { internal: true } : {}),
    ...(extra.agentReply ? { agentReply: extra.agentReply } : {}),
    ...(extra.coordination ? { coordination: extra.coordination } : {}),
    messageId: remote.messageId,
    conversationId: remote.conversationId,
    seq: remote.seq,
    senderId: remote.senderId,
    content: remote.content,
    type: remote.type,
    mentions: remote.mentions ?? [],
    ...(remote.replyTo ? { replyTo: remote.replyTo } : {}),
    ...(extra.quote ? { quote: extra.quote } : {}),
    status: remote.status ?? "SENT",
    ...(extra.steps?.length ? { steps: extra.steps } : {}),
    ...(remote.report ? { report: true } : {}),
    ...(remote.failed ? { failed: true } : {}),
    ...(remote.attachments?.length ? { attachments: remote.attachments.map(toLocalAttachment) } : {}),
    createdAt: iso(remote.gmtCreated)
  };
}

function toLocalAttachment(remote: RemoteAttachment): Attachment {
  return {
    attachmentId: remote.attachmentId,
    name: remote.name,
    mimeType: remote.mimeType,
    size: remote.size,
    kind: kindFromCloud(remote.kind, remote.mimeType)
  };
}

/** Cloud empty fields are null; treat as absent locally */
function remoteAgentModel(model: RemoteAgentModel): RemoteAgentModel {
  return {
    ...(model.selected ? { selected: model.selected } : {}),
    ...(model.selectedLabel ? { selectedLabel: model.selectedLabel } : {}),
    ...(model.nativeModel ? { nativeModel: model.nativeModel } : {})
  };
}

/** Convert a cloud human profile into a local contact */
function toPerson(remote: RemoteAgent): UserRef {
  return {
    userId: remote.userId,
    ...(remote.username ? { username: remote.username } : {}),
    displayName: remote.displayName,
    ...(remote.avatarUrl ? { avatarUrl: remote.avatarUrl } : {}),
    isAgent: false
  };
}

/** Humans appearing in the task (excluding agents); record names even of people in the group who aren't friends */
function remotePeople(remote: RemoteConversation): UserRef[] {
  return remote.members
    .filter((member) => member.isAgent === false && member.displayName)
    .map((member) => ({ userId: member.userId, displayName: member.displayName!, isAgent: false }));
}

function cloudErrorText(result: Extract<ApiResult, { ok: false }>): string {
  const key = result.code ? ERROR_TEXT[result.code] : undefined;
  return key ? tm(key) : result.message;
}
