import { defaultAgentName, migratedAgentName } from "../agents/default-names";
import { tm } from "../i18n";
import { log } from "../orchestration/diagnostics";
import {
  normalizeAvatarUrl,
  normalizeDisplayName,
  normalizeEmail,
  normalizePhone
} from "./profile-patch";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { p } from "../prompt-language";
import { readSkillPackage, readPackageDirectory, packageManifest, fingerprintPackageFiles, writePackageCandidate, type PackageFile } from "../knowledge/bundle-files";
import { parseSkillDocument, renderSkillDocument } from "../knowledge/skill-document";
import { skillSlug } from "../skills/skill-dir";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
  unlink,
  writeFile
} from "node:fs/promises";
import { AttachmentVault, normalizeAttachments } from "./attachments";
import { newId } from "./ids";
import { processedByAllOwners } from "./message-owners";
import { migrateLegacyTaskNaming } from "./legacy-rename";
import { SerialQueue } from "./serial-queue";
import type { CreateConversationInput, Store } from "./store";

/**
 * People using the standalone edition have no backend account and no backend users.user_id.
 * This fixed value is only used to link local task members and message senders; it is never shown or uploaded.
 */
const LOCAL_USER_REF = "local:me";
/** Default name of the standalone (not signed in) user, used for both username and nickname */
const DEFAULT_LOCAL_NAME = "ading";

/** Options used when the online edition treats LocalStore as the account's local cache; the standalone edition passes nothing */
export interface LocalStoreOptions {
  /** The "me" in the cache is the signed-in account, not the standalone edition's local:me */
  identity?: { userId: string; username: string; displayName: string };
  /**
   * Assigns a userId when a new agent is discovered locally. The online edition first registers the agent in the cloud and uses the cloud userId,
   * so task members and message senders match up in the cloud. When it returns nothing (e.g. offline), a locally generated ID is used.
   */
  agentUserId?: (agent: DiscoveredAgent) => Promise<string | undefined>;
}

/** Full data fetched back from the cloud, used to rebuild the online edition's cache */
export interface SyncedSnapshot {
  workspaces: Workspace[];
  conversations: Conversation[];
  messages: Record<string, Message[]>;
}

/**
 * Standalone implementation: all data is on local disk, no account, no network.
 *
 * The storage format is deliberately aligned with the online edition's table schema (same seq, lastReadSeq, idempotency keys),
 * so that a future "upgrade to online" pushes local data up instead of rewriting it.
 *
 * Messages are appended as JSONL rather than rewriting the whole file -- the previous version JSON.stringify'd the whole history
 * into localStorage; writes were O(n²) and it silently blew up at a few MB.
 *
 * Skills and memories are stored as human-readable files (skills are Markdown),
 * so users can edit them in an editor and manage them with git, which is a plus for a developer-oriented tool.
 */
export class LocalStore implements Store {
  readonly mode: StoreMode = "local";

  private readonly root: string;
  private readonly listeners = new Set<(event: StoreEvent) => void>();

  private profile: UserRef | null = null;
  /** localUuid -> agent. Keying by localUuid is how registration idempotency is implemented */
  private agents: Record<string, UserRef> = {};
  /**
   * Online edition: other real people (userId -> profile). friend is true for friends; false for removed friends or people only seen in the same group,
   * kept so chat history can still show their names and avatars. Always empty in the standalone edition.
   */
  private people: Record<string, UserRef> = {};
  private workspaces: Record<string, Workspace> = {};
  private conversations: Record<string, Conversation> = {};
  private agentSessions: Record<string, AgentSessionRef> = {};
  private skillIndex: Record<string, Omit<Skill, "content">> = {};
  private proposals: Record<string, SkillProposal> = {};
  /**
   * User messages handed to an Agent but not yet fully processed: task -> message IDs. Persisted before the message is written,
   * deleted only once the processed watermark of every local Agent that should handle it has passed it (markProcessed); after a crash or exit midway, a restart re-triggers based on this.
   */
  private owed: Record<string, string[]> = {};

  /** Conversation messages already loaded into memory, to avoid reading disk every time */
  private messageCache = new Map<string, Message[]>();
  private readonly messageQueue = new SerialQueue();
  private readonly memoryQueue = new SerialQueue();
  private readonly knowledgeQueue = new SerialQueue();
  private readonly fileQueue = new SerialQueue();
  private readonly messageLoads = new Map<string, Promise<Message[]>>();

  /** Attachment files: the standalone edition keeps them only here; the online edition keeps a copy in its cache directory too, and CloudStore handles upload and download */
  readonly attachments: AttachmentVault;

  constructor(rootDir: string, private readonly options: LocalStoreOptions = {}) {
    this.root = rootDir;
    this.attachments = new AttachmentVault(rootDir);
  }

  /**
   * Writes the cache files (workspaces, tasks, chat history) from the cloud's full data, then init.
   * Only called when the online edition is opened for the first time or its cache was deleted: a synced cache can be deleted at any time and fully restored.
   */
  static async writeSnapshot(rootDir: string, snapshot: SyncedSnapshot): Promise<void> {
    const messagesDir = path.join(rootDir, "messages");
    await mkdir(messagesDir, { recursive: true });
    const byId = <T>(items: T[], key: (item: T) => string) =>
      Object.fromEntries(items.map((item) => [key(item), item]));
    const writeAtomic = async (target: string, content: string) => {
      const temporary = `${target}.${newId("message")}.tmp`;
      await writeFile(temporary, content, "utf8");
      await rename(temporary, target);
    };
    for (const [conversationId, messages] of Object.entries(snapshot.messages)) {
      const ordered = [...messages].sort((a, b) => a.seq - b.seq);
      await writeAtomic(
        path.join(messagesDir, `${conversationId}.jsonl`),
        ordered.map((message) => JSON.stringify(message) + "\n").join("")
      );
    }
    await writeAtomic(
      path.join(rootDir, "workspaces.json"),
      JSON.stringify(byId(snapshot.workspaces, (workspace) => workspace.workspaceId), null, 2)
    );
    await writeAtomic(
      path.join(rootDir, "conversations.json"),
      JSON.stringify(byId(snapshot.conversations, (conversation) => conversation.conversationId), null, 2)
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    // Migrate local data from before "task" was renamed "conversation" in place (only once)
    await migrateLegacyTaskNaming(this.root);
    await mkdir(this.messagesDir(), { recursive: true });
    await mkdir(this.skillsDir(), { recursive: true });
    await mkdir(this.memoriesDir(), { recursive: true });
    if ((await lstat(this.skillsDir())).isSymbolicLink() || (await lstat(this.memoriesDir())).isSymbolicLink()) throw new Error(p("中央知识目录不允许符号链接", "Central knowledge directories must not be symbolic links"));

    this.profile = await this.readJson<UserRef | null>("profile.json", null);
    const identity = this.options.identity;
    if (!this.profile || (identity && this.profile.userId !== identity.userId)) {
      this.profile = identity
        ? { userId: identity.userId, username: identity.username, displayName: identity.displayName, isAgent: false }
        : {
            userId: LOCAL_USER_REF,
            username: DEFAULT_LOCAL_NAME,
            displayName: DEFAULT_LOCAL_NAME,
            isAgent: false
          };
      await this.writeJson("profile.json", this.profile);
    }

    this.agents = await this.readJson("agents.json", {} as Record<string, UserRef>);
    // Remote agents' online status is from the last sync; until resynced, treat them all as offline -- don't show a green light based on stale data
    for (const agent of Object.values(this.agents)) {
      if (agent.remote) agent.remote = { ...agent.remote, online: false };
    }
    this.workspaces = await this.readJson(
      "workspaces.json",
      {} as Record<string, Workspace>
    );
    this.conversations = await this.readJson(
      "conversations.json",
      {} as Record<string, Conversation>
    );
    await this.ensureWorkspaces();
    this.people = await this.readJson("people.json", {} as Record<string, UserRef>);
    // Tasks others pulled me into carry no workspace (workspaces are personal); on my side they go under "No workspace"
    const inbox = (await this.inboxWorkspace()).workspaceId;
    let homeless = false;
    for (const conversation of Object.values(this.conversations)) {
      if (conversation.workspaceId && this.workspaces[conversation.workspaceId]) continue;
      conversation.workspaceId = inbox;
      homeless = true;
    }
    if (homeless) await this.writeJson("conversations.json", this.conversations);
    this.agentSessions = await this.readJson(
      "agent-sessions.json",
      {} as Record<string, AgentSessionRef>
    );
    this.skillIndex = await this.readJson(
      path.join("skills", "index.json"),
      {} as Record<string, Omit<Skill, "content">>
    );
    await this.recoverSkillTransaction();
    // Legacy markdown files remain readable; upgrade each package through the same validated transaction.
    for (const meta of Object.values(this.skillIndex)) {
      if (!meta.source) {
        const content = await this.readText(path.join("skills", `${meta.skillId}.md`), "");
        await this.persistSkill({ ...meta, content });
      }
    }
    this.proposals = await this.readJson(
      "skill-proposals.json",
      {} as Record<string, SkillProposal>
    );
    this.owed = await this.readJson("owed-messages.json", {} as Record<string, string[]>);
    // The append-only message journal is authoritative after an interrupted metadata write.
    let recovered = false;
    for (const conversation of Object.values(this.conversations)) {
      const messages = await this.loadMessages(conversation.conversationId);
      const lastSeq = messages.at(-1)?.seq ?? 0;
      if (conversation.lastSeq !== lastSeq) {
        conversation.lastSeq = lastSeq;
        recovered = true;
      }
      for (const member of conversation.members) {
        if (member.lastReadSeq > lastSeq) {
          member.lastReadSeq = lastSeq;
          recovered = true;
        }
      }
    }
    if (recovered) await this.writeJson("conversations.json", this.conversations);
  }

  async close(): Promise<void> {
    await this.messageQueue.drain();
    await this.memoryQueue.drain();
    await this.knowledgeQueue.drain();
    await this.fileQueue.drain();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Identity and contacts
  // -------------------------------------------------------------------------

  async currentUser(): Promise<UserRef> {
    if (!this.profile) throw new Error(tm("main.store.notReady"));
    return this.profile;
  }

  /**
   * Contacts = agents **explicitly added by the person**.
   *
   * Discovered but not added ones aren't here -- they only appear on the Agent page, waiting for the person to click "Add".
   * undefined counts as true: this field was added later, and agents in old data were all added automatically,
   * so after upgrading, people's contacts must not vanish out of nowhere.
   */
  async listContacts(): Promise<UserRef[]> {
    // Include all real people (online edition); whether they're friends depends on friend: non-friends are only used to show names, not in the contact list
    return [...Object.values(this.agents).filter((agent) => agent.enabled !== false), ...Object.values(this.people)];
  }

  /** Everything registered locally, added or not. Used by the Agent page */
  async listKnownAgents(): Promise<UserRef[]> {
    return Object.values(this.agents);
  }

  /**
   * Online edition: syncs agents on other computers. Never called in the standalone edition.
   *
   * Stored in the same table as locally discovered agents, so contacts, member selection and task members can find them directly without a separate query;
   * keys with a `remote:` prefix keep them apart from local agents (keyed by localUuid), so the local discovery flow never touches them.
   * What's passed in is the current full set: anything not in it means that computer no longer registers it, so delete it.
   */
  async syncRemoteAgents(remote: UserRef[]): Promise<void> {
    const next: Record<string, UserRef> = {};
    for (const agent of remote) next[`remote:${agent.userId}`] = agent;
    let changed = false;
    for (const key of Object.keys(this.agents)) {
      if (key.startsWith("remote:") && !(key in next)) {
        delete this.agents[key];
        changed = true;
      }
    }
    for (const [key, agent] of Object.entries(next)) {
      if (JSON.stringify(this.agents[key]) !== JSON.stringify(agent)) {
        this.agents[key] = agent;
        changed = true;
      }
    }
    if (changed) {
      await this.writeJson("agents.json", this.agents);
      this.emit({ type: "contacts" });
    }
  }

  async getUser(userId: string): Promise<UserRef | null> {
    if (this.profile?.userId === userId) return this.profile;
    return Object.values(this.agents).find((a) => a.userId === userId) ?? this.people[userId] ?? null;
  }

  /**
   * Online edition: syncs real-person friends. What's passed in is the current full friend set; old friends not in it are marked friend: false and kept for display names.
   * Never called in the standalone edition.
   */
  async syncPeople(friends: UserRef[]): Promise<void> {
    const next: Record<string, UserRef> = {};
    for (const person of Object.values(this.people)) next[person.userId] = { ...person, friend: false };
    for (const friend of friends) {
      if (friend.isAgent || friend.userId === this.profile?.userId) continue;
      next[friend.userId] = { ...friend, isAgent: false, friend: true };
    }
    await this.replacePeople(next);
  }

  /** Online edition: records other real people appearing in tasks (non-friends in groups); known ones only get name and avatar refreshed, friend status unchanged */
  async rememberPeople(people: UserRef[]): Promise<void> {
    const next = { ...this.people };
    for (const person of people) {
      if (person.isAgent || person.userId === this.profile?.userId) continue;
      if (Object.values(this.agents).some((agent) => agent.userId === person.userId)) continue;
      const known = next[person.userId];
      next[person.userId] = known
        ? { ...known, displayName: person.displayName || known.displayName }
        : { ...person, isAgent: false, friend: false };
    }
    await this.replacePeople(next);
  }

  private async replacePeople(next: Record<string, UserRef>): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(this.people)) return;
    this.people = next;
    await this.writeJson("people.json", this.people);
    this.emit({ type: "contacts" });
  }

  /** Group membership includes every selected Agent's owner. */
  private withAgentOwners(memberIds: string[]): string[] {
    return [...new Set([...memberIds, ...Object.values(this.agents)
      .filter(agent => memberIds.includes(agent.userId) && agent.owner).map(agent => agent.owner!)])];
  }

  /** Every real person must own or be permitted to use all Agents; the cache checks first, and the cloud verifies the actual authorization again. */
  private requireAgentsPrivate(memberIds: string[]): void {
    const me = this.profile?.userId;
    const humans = memberIds.filter(id => id === me || Boolean(this.people[id]));
    for (const agent of Object.values(this.agents).filter(agent => memberIds.includes(agent.userId))) {
      if (humans.some(id => id !== agent.owner && !agent.sharedWith?.includes(id))) {
        throw new Error(tm("main.store.agentPrivate"));
      }
    }
  }

  async syncDiscoveredAgents(discovered: DiscoveredAgent[]): Promise<UserRef[]> {
    return this.fileQueue.run("agent-discovery", () => this.syncAgentIdentities(discovered));
  }

  private async syncAgentIdentities(discovered: DiscoveredAgent[]): Promise<UserRef[]> {
    const me = await this.currentUser();
    let changed = false;
    const result: UserRef[] = [];

    for (const agent of discovered) {
      let existing = this.agents[agent.localUuid];
      // One computer has only one Agent per type: if the ID rule changed ("type@hostname" -> "type@computer UUID") or the computer was renamed,
      // the old record of the same type swaps its ID in place; it's still the same Agent, so contacts, tasks and history stay connected.
      // The online edition registers again so the cloud also switches to the new ID (the cloud likewise updates in place by "same computer, same type"; userId unchanged).
      const renamedFrom = existing ? undefined : Object.keys(this.agents)
        .find((key) => !key.startsWith("remote:") && key.startsWith(`${agent.kind}@`));
      if (renamedFrom) {
        existing = this.agents[renamedFrom];
        delete this.agents[renamedFrom];
        existing.localUuid = agent.localUuid;
        this.agents[agent.localUuid] = existing;
        changed = true;
      }
      if (existing) {
        const registered = await this.options.agentUserId?.(agent);
        if (registered && registered !== existing.userId) {
          await this.repairAgentIdentity(existing.userId, registered);
          existing.userId = registered;
          changed = true;
        }
        if(JSON.stringify(existing.runtimeDefaults)!==JSON.stringify(agent.runtimeDefaults)) {
          existing.runtimeDefaults=agent.runtimeDefaults;changed=true;
        }
        if (existing.version !== agent.version) {
          existing.version = agent.version;
          changed = true;
        }
        // Default name changed: ones still using the old default name get the new default name (the online edition sends it to the cloud via CloudStore)
        const renamed = migratedAgentName(agent.kind, existing.displayName);
        if (renamed) {
          existing.displayName = renamed;
          changed = true;
        }
        result.push(existing);
        continue;
      }
      const created: UserRef = {
        runtimeDefaults:agent.runtimeDefaults,
        userId: (await this.options.agentUserId?.(agent)) ?? newId("user"),
        username: agent.kind,
        displayName: defaultAgentName(agent.kind, agent.name),
        isAgent: true,
        kind: agent.kind,
        version: agent.version,
        owner: me.userId,
        localUuid: agent.localUuid,
        // Discovered != added. Installed doesn't mean wanted; whether to add it is up to the person clicking on the Agent page
        enabled: false
      };
      this.agents[agent.localUuid] = created;
      result.push(created);
      changed = true;
    }

    if (changed) {
      await this.writeJson("agents.json", this.agents);
      this.emit({ type: "contacts" });
    }
    return result;
  }

  async pendingAgentIdentityRepairs(): Promise<Array<{ from: string; to: string }>> {
    return this.readJson("agent-id-repairs.json", []);
  }

  async acknowledgeAgentIdentityRepairs(repairs: Array<{ from: string; to: string }>): Promise<void> {
    const pending = await this.pendingAgentIdentityRepairs();
    await this.writeJson("agent-id-repairs.json", pending.filter(item =>
      !repairs.some(done => done.from === item.from && done.to === item.to)));
  }

  private async repairAgentIdentity(from: string, to: string): Promise<void> {
    const pending = await this.pendingAgentIdentityRepairs();
    if (!pending.some(item => item.from === from && item.to === to)) {
      await this.writeJson("agent-id-repairs.json", [...pending, { from, to }]);
    }
    // Only structured identity fields change. User text, provider payloads and
    // native session identifiers retain their original bytes.
    const fields = new Set(["userId", "senderId", "agentUserId", "owner", "creator", "leaderId"]);
    const arrays = new Set(["mentions", "participants", "confirmedParticipants", "memberIds", "agentIds"]);
    const replace = (value: any, key = ""): any => {
      if (typeof value === "string") return (fields.has(key) || arrays.has(key)) && value === from ? to : value;
      if (Array.isArray(value)) return value.map(item => replace(item, key));
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([k, item]) => [
        ["responses", "turnDurationsMs"].includes(key) && k === from ? to : k, replace(item, k)
      ]));
    };
    for (const id of Object.keys(this.conversations)) {
      await this.messageQueue.run(id, async () => {
        const messages = await this.loadMessages(id);
        const updated = messages.map(message => replace(message));
        if (JSON.stringify(messages) !== JSON.stringify(updated)) {
          await this.writeText(path.join("messages", `${id}.jsonl`), updated.map(message => JSON.stringify(message) + "\n").join(""));
          this.messageCache.set(id, updated);
        }
      });
      this.conversations[id] = replace(this.conversations[id]);
    }
    const sessions = Object.values(this.agentSessions).map(session => replace(session) as AgentSessionRef);
    this.agentSessions = Object.fromEntries(sessions.map(session => [sessionKey(session.conversationId, session.agentUserId), session]));
    await this.writeJson("conversations.json", this.conversations);
    await this.writeJson("agent-sessions.json", this.agentSessions);
  }

  async updateAgent(
    userId: string,
    patch: Partial<
      Pick<UserRef, "displayName" | "persona" | "sharedWith" | "enabled" | "modelConfig">
    >
  ): Promise<UserRef> {
    const entry = Object.values(this.agents).find((a) => a.userId === userId);
    if (!entry) throw new Error(tm("main.store.agentMissing"));
    return this.updateContact(userId, patch);
  }

  async updateContact(
    userId: string,
    patch: Partial<
      Pick<
        UserRef,
        | "displayName"
        | "avatarUrl"
        | "phone"
        | "email"
        | "sharedWith"
        | "persona"
        | "enabled"
        | "modelConfig"
      >
    >
  ): Promise<UserRef> {
    const entry =
      this.profile?.userId === userId
        ? this.profile
        : Object.values(this.agents).find((candidate) => candidate.userId === userId);
    if (!entry) throw new Error(tm("main.store.contactMissing"));

    if (patch.displayName !== undefined) {
      entry.displayName = normalizeDisplayName(patch.displayName);
    }
    if (patch.avatarUrl !== undefined) {
      entry.avatarUrl = normalizeAvatarUrl(patch.avatarUrl);
    }
    if (patch.phone !== undefined) {
      if (entry.isAgent) throw new Error(tm("main.store.agentNoPhone"));
      entry.phone = normalizePhone(patch.phone);
    }
    if (patch.email !== undefined) {
      if (entry.isAgent) throw new Error(tm("main.store.agentNoEmail"));
      entry.email = normalizeEmail(patch.email);
    }
    if (patch.sharedWith !== undefined) entry.sharedWith = patch.sharedWith;
    if (patch.persona !== undefined) {
      if (!entry.isAgent) throw new Error(tm("main.store.humanNoPersona"));
      entry.persona = patch.persona;
    }
    if (patch.enabled !== undefined) {
      if (!entry.isAgent) throw new Error(tm("main.store.humanNoAdded"));
      entry.enabled = patch.enabled;
    }
    if (patch.modelConfig !== undefined) {
      if (!entry.isAgent) throw new Error(tm("main.store.humanNoAdded"));
      // An empty object clears the selection in ADing and goes back to following the original app
      if (Object.keys(patch.modelConfig).length) entry.modelConfig = patch.modelConfig;
      else delete entry.modelConfig;
    }

    if (entry.isAgent) {
      await this.writeJson("agents.json", this.agents);
      this.emit({ type: "agents" });
    } else {
      await this.writeJson("profile.json", this.profile);
    }

    this.emit({ type: "contacts" });
    return entry;
  }

  async deleteContact(userId: string): Promise<void> {
    if (this.profile?.userId === userId) throw new Error(tm("main.store.cannotDeleteSelf"));
    const entry = Object.values(this.agents).find((candidate) => candidate.userId === userId);
    if (!entry) throw new Error(tm("main.store.contactMissing"));
    await this.updateContact(userId, { enabled: false });
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  /** Ensures "No workspace" (inbox) exists: tasks without a specified workspace all go here */
  private async ensureWorkspaces(): Promise<void> {
    if (Object.values(this.workspaces).some((workspace) => workspace.kind === "inbox")) return;
    const now = new Date().toISOString();
    const inbox: Workspace = {
      workspaceId: newId("workspace"),
      name: "无工作区",
      kind: "inbox",
      createdAt: now,
      updatedAt: now
    };
    this.workspaces[inbox.workspaceId] = inbox;
    await this.writeJson("workspaces.json", this.workspaces);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    // "Casual" always goes last: it's the fallback and shouldn't grab attention at the top of the list
    return Object.values(this.workspaces).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "inbox" ? 1 : -1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    return this.workspaces[workspaceId] ?? null;
  }

  async inboxWorkspace(): Promise<Workspace> {
    const inbox = Object.values(this.workspaces).find((w) => w.kind === "inbox");
    if (!inbox) throw new Error(tm("main.store.notReady"));
    return inbox;
  }

  async createWorkspace(input: { name: string; path: string }): Promise<Workspace> {
    const name = input.name.trim();
    const dir = input.path.trim();
    if (!name) throw new Error(tm("main.store.workspaceNameRequired"));
    if (!dir) throw new Error(tm("main.store.workspaceDirRequired"));
    const existing = Object.values(this.workspaces).find(
      (w) => w.kind === "folder" && w.path === dir
    );
    if (existing) throw new Error(tm("main.store.workspaceDirTaken", { name: existing.name }));

    const now = new Date().toISOString();
    const workspace: Workspace = {
      workspaceId: newId("workspace"),
      name,
      path: dir,
      kind: "folder",
      createdAt: now,
      updatedAt: now
    };
    this.workspaces[workspace.workspaceId] = workspace;
    await this.writeJson("workspaces.json", this.workspaces);
    this.emit({ type: "workspaces" });
    return workspace;
  }

  async updateWorkspace(
    workspaceId: string,
    patch: Partial<Pick<Workspace, "name" | "path">>
  ): Promise<Workspace> {
    const workspace = this.workspaces[workspaceId];
    if (!workspace) throw new Error(tm("main.store.workspaceMissing"));
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error(tm("main.store.workspaceNameRequired"));
      workspace.name = name;
    }
    if (patch.path !== undefined) {
      if (workspace.kind === "inbox") throw new Error(tm("main.store.inboxNoDir"));
      const dir = patch.path.trim();
      if (!dir) throw new Error(tm("main.store.workspaceDirRequired"));
      workspace.path = dir;
    }
    workspace.updatedAt = new Date().toISOString();
    await this.writeJson("workspaces.json", this.workspaces);
    this.emit({ type: "workspaces" });
    return workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaces[workspaceId];
    if (!workspace) return;
    if (workspace.kind === "inbox") throw new Error(tm("main.store.inboxNoDelete"));

    const inbox = await this.inboxWorkspace();
    // Conversations are not deleted along with it -- chat history is the person's asset and shouldn't be wiped as a side effect of tidying directories
    for (const conversation of Object.values(this.conversations)) {
      if (conversation.workspaceId === workspaceId) {
        conversation.workspaceId = inbox.workspaceId;
      }
    }
    // The workspace's own skills and facts must be deleted: their anchor is gone, and keeping them would only inject them into unrelated places
    for (const meta of Object.values(this.skillIndex)) {
      if (meta.scope === "workspace" && meta.ownerId === workspaceId) {
        await this.deleteSkill(meta.skillId);
      }
    }
    try {
      await unlink(
        path.join(
          this.memoriesDir(),
          `${memoryFileName("workspace", workspaceId)}.jsonl`
        )
      );
    } catch {
      // There was never a facts file; not an error
    }

    delete this.workspaces[workspaceId];
    await this.writeJson("workspaces.json", this.workspaces);
    await this.writeJson("conversations.json", this.conversations);
    this.emit({ type: "workspaces" });
    this.emit({ type: "skills" });
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  async listConversations(): Promise<Conversation[]> {
    return Object.values(this.conversations).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    return this.conversations[conversationId] ?? null;
  }

  async pauseAllConversations(): Promise<number> {
    const changed: string[] = [];
    for (const conversation of Object.values(this.conversations)) {
      let memberChanged = false;
      for (const member of conversation.members) {
        if (!member.paused && Object.values(this.agents).some(agent => agent.userId === member.userId)) {
          member.paused = true;
          member.resumeOnContinue = true;
          memberChanged = true;
        }
      }
      if (conversation.paused && !memberChanged) continue;
      conversation.paused = true;
      changed.push(conversation.conversationId);
    }
    if (!changed.length) return 0;
    await this.writeJson("conversations.json", this.conversations);
    for (const conversationId of changed) this.emit({ type: "conversation", conversationId });
    return changed.length;
  }

  async setConversationPaused(conversationId: string, paused: boolean): Promise<Conversation> {
    const conversation = this.requireConversation(conversationId);
    if (conversation.paused === paused) return conversation;
    conversation.paused = paused;
    if (!paused) {
      for (const member of conversation.members) {
        if (member.resumeOnContinue) {
          member.paused = false;
          delete member.resumeOnContinue;
        }
      }
    }
    await this.writeJson("conversations.json", this.conversations);
    this.emit({ type: "conversation", conversationId });
    return conversation;
  }

  /**
   * Creates a new conversation.
   *
   * Note there is **no** idempotency here -- a task's granularity is one piece of work, not a chat window.
   * Starting three things with the same agent means three tasks, three independent threads,
   * and three mutually isolated memories. This is the foundation for "different tasks must never get mixed up".
   */
  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const me = await this.currentUser();
    const name = input.name.trim();
    if (!name) throw new Error(tm("main.store.conversationNameRequired"));

    // Without a specified workspace it goes to "Casual". No empty fields: scope resolution must always have exactly one path
    const workspaceId =
      input.workspaceId && this.workspaces[input.workspaceId]
        ? input.workspaceId
        : (await this.inboxWorkspace()).workspaceId;

    const initial = [...new Set([me.userId, ...input.memberIds])];
    const unique = initial.length > 2 ? this.withAgentOwners(initial) : initial;
    if (unique.length < 2) throw new Error(tm("main.store.needMember"));
    this.requireAgentsPrivate(unique);
    const defaultAgentId = unique.find((userId) =>
      Object.values(this.agents).some((agent) => agent.userId === userId)
    );
    if (input.leaderId && (!unique.includes(input.leaderId) || !Object.values(this.agents).some(agent => agent.userId === input.leaderId))) {
      throw new Error(tm("main.store.leaderMustBeAgent"));
    }
    const firstAgentId = input.leaderId ?? defaultAgentId;

    const now = new Date().toISOString();
    const conversation: Conversation = {
      conversationId: newId("conversation"),
      // The type only describes the member count and no longer carries idempotency semantics
      type: unique.length === 2 ? "DIRECT" : "GROUP",
      name,
      autoTitle: input.autoTitle,
      permanent: input.permanent ?? false,
      workspaceId,
      creator: me.userId,
      owner: me.userId,
      lastSeq: 0,
      members: unique.map((userId) => ({
        userId,
        role:
          unique.length > 2 && (userId === firstAgentId || (!firstAgentId && userId === me.userId))
            ? "LEADER"
            : "ENGINEER",
        lastReadSeq: 0,
        paused: false
      })),
      workspacePath: input.workspacePath,
      charter: input.charter,
      seedKey: input.seedKey,
      status: "ACTIVE",
      paused: false,
      createdAt: now,
      updatedAt: now
    };
    this.conversations[conversation.conversationId] = conversation;
    await this.writeJson("conversations.json", this.conversations);
    this.emit({ type: "conversation", conversationId: conversation.conversationId });
    return conversation;
  }

  async addMember(
    conversationId: string,
    userId: string,
    role: MemberRole
  ): Promise<Conversation> {
    const conversation = this.requireConversation(conversationId);
    if (conversation.type === "DIRECT") throw new Error(tm("main.store.directNoAdd"));
    if (conversation.members.some((m) => m.userId === userId)) {
      throw new Error(tm("main.store.memberExists"));
    }
    const memberIds = this.withAgentOwners([...conversation.members.map(member => member.userId), userId]);
    this.requireAgentsPrivate(memberIds);
    const addingAgent = Object.values(this.agents).some(
      (agent) => agent.userId === userId
    );
    const hasAgentLeader = conversation.members.some(
      (member) =>
        member.role === "LEADER" &&
        Object.values(this.agents).some((agent) => agent.userId === member.userId)
    );
    conversation.members.push({
      userId,
      role: addingAgent && !hasAgentLeader ? "LEADER" : role,
      lastReadSeq: 0,
      paused: false
    });
    for (const ownerId of memberIds) if (!conversation.members.some(member => member.userId === ownerId)) {
      conversation.members.push({ userId: ownerId, role: "ENGINEER", lastReadSeq: 0, paused: false });
    }
    if (addingAgent && !hasAgentLeader) {
      for (const member of conversation.members) {
        if (member.userId !== userId && member.role === "LEADER") {
          member.role = "ENGINEER";
        }
      }
    }
    await this.touch(conversation);
    return conversation;
  }

  async setMemberRole(
    conversationId: string,
    userId: string,
    role: MemberRole
  ): Promise<Conversation> {
    const conversation = this.requireConversation(conversationId);
    if (conversation.type === "DIRECT") throw new Error(tm("main.store.directNoRole"));
    const member = conversation.members.find((m) => m.userId === userId);
    if (!member) throw new Error(tm("main.store.memberMissing"));

    const targetIsAgent = Object.values(this.agents).some(
      (agent) => agent.userId === userId
    );
    const hasAgent = conversation.members.some((item) =>
      Object.values(this.agents).some((agent) => agent.userId === item.userId)
    );
    if (role === "LEADER" && !targetIsAgent && hasAgent) {
      throw new Error(tm("main.store.ownerNotLeader"));
    }
    // The owner is represented by task.owner; as long as the task has an Agent, LEADER belongs exclusively to one of those Agents.
    if (role === "LEADER") {
      for (const other of conversation.members) {
        if (
          other.userId !== userId &&
          other.role === "LEADER"
        ) {
          other.role = "ENGINEER";
        }
      }
    } else if (targetIsAgent && member.role === "LEADER") {
      const successor = conversation.members.find(
        (other) =>
          other.userId !== userId &&
          Object.values(this.agents).some((agent) => agent.userId === other.userId)
      );
      if (!successor) throw new Error(tm("main.store.keepAgentLeader"));
      successor.role = "LEADER";
    }
    member.role = role;
    await this.touch(conversation);
    return conversation;
  }

  async setMemberPaused(
    conversationId: string,
    userId: string,
    paused: boolean
  ): Promise<Conversation> {
    const conversation = this.requireConversation(conversationId);
    const member = conversation.members.find((item) => item.userId === userId);
    if (!member) throw new Error(tm("main.store.memberMissing"));
    const isAgent = Object.values(this.agents).some((agent) => agent.userId === userId);
    if (!isAgent) throw new Error(tm("main.store.pauseAgentOnly"));
    if (member.paused === paused) return conversation;
    member.paused = paused;
    delete member.resumeOnContinue;
    await this.writeJson("conversations.json", this.conversations);
    this.emit({ type: "conversation", conversationId });
    return conversation;
  }

  async removeMember(conversationId: string, userId: string): Promise<Conversation> {
    const conversation = this.requireConversation(conversationId);
    if (conversation.type === "DIRECT") throw new Error(tm("main.store.directNoRemove"));
    if (conversation.owner === userId) throw new Error(tm("main.store.cannotRemoveOwner"));
    if (Object.values(this.agents).some(agent => agent.owner === userId && conversation.members.some(member => member.userId === agent.userId))) {
      throw new Error(tm("main.store.cannotRemoveAgentOwner"));
    }
    const removed = conversation.members.find((member) => member.userId === userId);
    conversation.members = conversation.members.filter((m) => m.userId !== userId);
    if (removed?.role === "LEADER") {
      const successor = conversation.members.find((member) =>
        Object.values(this.agents).some((agent) => agent.userId === member.userId)
      );
      if (successor) successor.role = "LEADER";
    }
    await this.touch(conversation);
    return conversation;
  }

  async updateConversation(
    conversationId: string,
    patch: Partial<
      Pick<
        Conversation,
        | "autoTitle"
        | "name"
        | "owner"
        | "workspaceId"
        | "workspacePath"
        | "permanent"
        | "shared"
        | "charter"
        | "workPlan"
        | "brainstorm"
        | "followUp"
        | "status"
        | "paused"
      >
    >
  ): Promise<Conversation> {
    const conversation = this.requireConversation(conversationId);
    if (patch.autoTitle !== undefined) conversation.autoTitle = patch.autoTitle;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error(tm("main.store.conversationNameRequired"));
      conversation.name = name;
    }
    if (patch.workspaceId !== undefined) {
      // "Move this conversation into a workspace". Existing dialogue and threads are untouched --
      // what changes is which layer of shared knowledge it can see from now on, not its history.
      if (!this.workspaces[patch.workspaceId]) throw new Error(tm("main.store.workspaceMissing"));
      conversation.workspaceId = patch.workspaceId;
    }
    if (patch.owner !== undefined) {
      if (!conversation.members.some((m) => m.userId === patch.owner)) {
        throw new Error(tm("main.store.newOwnerMustBeMember"));
      }
      conversation.owner = patch.owner;
    }
    if (patch.workspacePath !== undefined) {
      conversation.workspacePath = patch.workspacePath.trim() || undefined;
    }
    if (patch.workPlan !== undefined) conversation.workPlan = structuredClone(patch.workPlan);
    if (patch.brainstorm !== undefined) conversation.brainstorm = structuredClone(patch.brainstorm);
    if (patch.followUp !== undefined) conversation.followUp = structuredClone(patch.followUp);
    if (patch.shared !== undefined) conversation.shared = patch.shared;
    if (patch.permanent !== undefined) conversation.permanent = patch.permanent;
    if (patch.charter !== undefined) conversation.charter = patch.charter;
    if (patch.status !== undefined) conversation.status = patch.status;
    if (patch.paused !== undefined) conversation.paused = patch.paused;
    await this.touch(conversation);
    return conversation;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    return this.messageQueue.run(conversationId, () => this.deleteConversationLocked(conversationId));
  }

  private async deleteConversationLocked(conversationId: string): Promise<void> {
    this.requireConversation(conversationId);
    // Attachments are deleted along with chat history; get the list first, since it can't be found once the message file is deleted
    const attachmentIds = (await this.loadMessages(conversationId).catch(() => [] as Message[]))
      .flatMap((message) => message.attachments ?? [])
      .map((attachment) => attachment.attachmentId);
    delete this.conversations[conversationId];
    for (const [key, session] of Object.entries(this.agentSessions)) {
      if (session.conversationId === conversationId) delete this.agentSessions[key];
    }
    for (const [proposalId, proposal] of Object.entries(this.proposals)) {
      if (proposal.conversationId === conversationId) delete this.proposals[proposalId];
    }
    this.messageCache.delete(conversationId);
    await this.writeJson("conversations.json", this.conversations);
    await this.writeJson("agent-sessions.json", this.agentSessions);
    await this.writeJson("skill-proposals.json", this.proposals);
    if (this.owed[conversationId]) {
      delete this.owed[conversationId];
      await this.writeJson("owed-messages.json", this.owed);
    }
    try {
      await unlink(this.messagesFile(conversationId));
    } catch {
      // Tasks without chat history never had a message file.
    }
    await this.attachments.remove(attachmentIds);
    try {
      await unlink(
        path.join(this.memoriesDir(), `${memoryFileName("conversation", conversationId)}.jsonl`)
      );
    } catch {
      // Nothing to do when there's no task memory file.
    }
    this.emit({ type: "conversation", conversationId });
    this.emit({ type: "proposals" });
    this.emit({ type: "memories", scope: "conversation", ownerId: conversationId });
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async appendMessage(input: {
    createdAt?: string;
    internal?: boolean;
    agentReply?: Message["agentReply"];
    coordination?: Message["coordination"];
    conversationId: string;
    clientMessageId: string;
    senderId: string;
    content: string;
    type?: MessageType;
    mentions?: string[];
    replyTo?: string;
    quote?: MessageQuote;
    steps?: string[];
    report?: boolean;
    failed?: boolean;
    attachments?: Attachment[];
  }): Promise<Message> {
    return this.messageQueue.run(input.conversationId, () => this.appendMessageLocked(input));
  }

  importAttachment(source: string, name?: string): Promise<Attachment> {
    return this.attachments.importFile(source, name);
  }

  importAttachmentData(name: string, mimeType: string, bytes: Uint8Array): Promise<Attachment> {
    return this.attachments.importData(name, mimeType, bytes);
  }

  /** Attachments in the standalone edition are all selected locally, so the files are always in the attachments directory */
  attachmentFile(_conversationId: string, attachment: Pick<Attachment, "attachmentId" | "name">): Promise<string> {
    return this.attachments.ensure(attachment);
  }

  private async appendMessageLocked(input: Parameters<Store["appendMessage"]>[0]): Promise<Message> {
    const conversation = this.requireConversation(input.conversationId);
    const loaded = await this.loadMessages(input.conversationId);

    // Idempotent: retrying with the same clientMessageId won't create a second message or consume a seq
    const duplicate = loaded.find((m) => m.messageId === input.clientMessageId);
    if (duplicate) {
      if (duplicate.senderId !== input.senderId) {
        throw new Error(tm("main.store.messageIdTaken"));
      }
      await this.writeJson("conversations.json", this.conversations);
      // The journal may have committed before a metadata write failed. Re-emit on retry;
      // consumers deduplicate by messageId, so successful storage can still reach the UI.
      this.emit({type:"message",conversationId:conversation.conversationId,message:duplicate});
      return duplicate;
    }

    if (!conversation.members.some((m) => m.userId === input.senderId)) {
      throw new Error(tm("main.store.senderNotMember"));
    }
    const content = input.content;
    const attachments = normalizeAttachments(input.attachments);
    // Text may be omitted when only sending images or files
    if (!content.trim() && !attachments) throw new Error(tm("main.store.messageEmpty"));

    const memberIds = new Set(conversation.members.map((m) => m.userId));
    const mentions = (input.mentions ?? []).filter((id) => memberIds.has(id));

    const nextSeq = Math.max(conversation.lastSeq, loaded.at(-1)?.seq ?? 0) + 1;
    const message: Message = {
      internal: input.internal || input.type === "SYSTEM" || undefined,
      agentReply: input.agentReply,
      coordination: input.coordination,
      messageId: input.clientMessageId,
      conversationId: conversation.conversationId,
      seq: nextSeq,
      senderId: input.senderId,
      content,
      type: input.type ?? "USER",
      mentions,
      replyTo: input.replyTo,
      quote: input.quote,
      status: "SENT",
      steps: input.steps?.length ? input.steps : undefined,
      report: input.report || undefined,
      failed: input.failed || undefined,
      attachments,
      createdAt: input.createdAt === undefined ? new Date().toISOString() : new Date(input.createdAt).toISOString()
    };

    const journal = await open(this.messagesFile(conversation.conversationId), "a");
    try {
      await journal.writeFile(JSON.stringify(message) + "\n", "utf8");
      await journal.sync();
    } finally {
      await journal.close();
    }
    conversation.lastSeq = nextSeq;
    loaded.push(message);

    // The sender's own read position goes straight to the latest
    const sender = conversation.members.find((m) => m.userId === input.senderId);
    // A reply says nothing about inputs arriving while an Agent was working.
    const senderIsAgent = Object.values(this.agents).some(a => a.userId === input.senderId);
    if (sender && !senderIsAgent) { sender.lastReadSeq = message.seq; delete sender.firstUnreadMentionSeq; }
    // Only the real person on this machine needs notifying; others' notifications are computed by their own devices
    const me = await this.currentUser();
    const mentioned = !message.internal && message.senderId !== me.userId && mentions.includes(me.userId)
      ? conversation.members.find((m) => m.userId === me.userId) : undefined;
    if (mentioned && message.seq > mentioned.lastReadSeq) mentioned.firstUnreadMentionSeq ??= message.seq;
    if (!message.failed && !message.internal) conversation.lastMessage = message;

    conversation.updatedAt = message.createdAt;
    await this.writeJson("conversations.json", this.conversations);

    this.emit({
      type: "message",
      conversationId: conversation.conversationId,
      message
    });
    return message;
  }

  /** Used by the online edition to dedupe by message ID when backfilling cloud messages */
  async hasMessage(conversationId: string, messageId: string): Promise<boolean> {
    if (!this.conversations[conversationId]) return false;
    return (await this.loadMessages(conversationId)).some((m) => m.messageId === messageId);
  }

  /** Gets locally existing messages by message ID, ordered by local sequence number; missing ones are skipped */
  async getMessages(conversationId: string, messageIds: string[]): Promise<Message[]> {
    if (!this.conversations[conversationId]) return [];
    const wanted = new Set(messageIds);
    return (await this.loadMessages(conversationId)).filter((m) => wanted.has(m.messageId));
  }

  /** Fixes caches where old-version backfill wrote the receive time; earlier local send times are kept unchanged. */
  async syncMessageTimes(conversationId: string, times: { messageId: string; createdAt?: string }[]): Promise<void> {
    await this.messageQueue.run(conversationId, async () => {
      const conversation = this.conversations[conversationId];
      if (!conversation) return;
      const original = await this.loadMessages(conversationId);
      const byId = new Map(times.map((time) => [time.messageId, time.createdAt]));
      const changed: { messageId: string; createdAt: string }[] = [];
      const corrected = original.map((message) => {
        const value = byId.get(message.messageId);
        const time = value === undefined ? NaN : Date.parse(value);
        if (!Number.isFinite(time) || time >= Date.parse(message.createdAt)) return message;
        const createdAt = new Date(time).toISOString();
        changed.push({ messageId: message.messageId, createdAt });
        return { ...message, createdAt };
      });
      if (!changed.length) return;
      await this.writeText(path.join("messages", `${conversationId}.jsonl`), corrected.map((message) => JSON.stringify(message)).join("\n") + "\n");
      this.messageCache.set(conversationId, corrected);
      if (conversation.lastMessage) {
        conversation.lastMessage = corrected.find((message) => message.messageId === conversation.lastMessage!.messageId) ?? conversation.lastMessage;
      }
      await this.writeJson("conversations.json", this.conversations);
      // Time correction isn't a new message: it doesn't advance read/execution cursors or trigger task execution.
      this.emit({ type: "message-times", conversationId, times: changed });
    });
  }

  /**
   * Online edition: a task created in the cloud by another device (e.g. a phone) is imported into the cache when its first message is received.
   * Messages are then appended one by one in local order, so sequence numbers and read positions start from zero; ones without a workspace go to "Casual".
   */
  async importConversation(conversation: Conversation): Promise<Conversation> {
    const existing = this.conversations[conversation.conversationId];
    if (existing) return existing;
    const workspaceId =
      conversation.workspaceId && this.workspaces[conversation.workspaceId]
        ? conversation.workspaceId
        : (await this.inboxWorkspace()).workspaceId;
    const imported: Conversation = {
      ...conversation,
      workspaceId,
      lastSeq: 0,
      lastMessage: undefined,
      members: conversation.members.map((member) => ({
        ...member,
        lastReadSeq: 0,
        lastProcessedSeq: undefined
      }))
    };
    this.conversations[conversation.conversationId] = imported;
    await this.writeJson("conversations.json", this.conversations);
    this.emit({ type: "conversation", conversationId: conversation.conversationId });
    return imported;
  }

  /** Read state is an account-level watermark. What's passed in is the local sequence number, converted by CloudStore; an old remote snapshot can't overwrite local reads not yet uploaded. */
  async syncConversationReadState(conversationId: string, members: { userId: string; lastReadSeq?: number }[]): Promise<void> {
    const conversation = this.conversations[conversationId];
    if (!conversation) return;
    let changed = false;
    for (const remote of members) {
      const local = conversation.members.find(member => member.userId === remote.userId);
      if (!local || !Number.isSafeInteger(remote.lastReadSeq) || remote.lastReadSeq! <= local.lastReadSeq) continue;
      await this.markRead(conversationId, remote.userId, remote.lastReadSeq!);
      changed = true;
    }
    if (changed) this.emit({ type: "conversation", conversationId });
  }

  /**
   * Online edition: someone else changed the members in the cloud (a friend added someone to or removed someone from a group); sync to local.
   * Existing members keep their local read and processed positions; new ones start from zero.
   */
  async syncConversationMembers(conversationId: string, members: { userId: string; role: MemberRole; ownerPaused?: boolean }[]): Promise<void> {
    const conversation = this.conversations[conversationId];
    if (!conversation) return;
    const current = new Map(conversation.members.map((member) => [member.userId, member]));
    const next = members.map((member) => ({
      ...(current.get(member.userId) ?? { userId: member.userId, role: member.role, lastReadSeq: 0, paused: false }),
      ...(conversation.type === "GROUP" && member.role ? { role: member.role } : {}),
      ownerPaused: Boolean(member.ownerPaused)
    }));
    const same = next.length === conversation.members.length && next.every((member) => current.has(member.userId) && current.get(member.userId)?.role === member.role && Boolean(current.get(member.userId)?.ownerPaused) === member.ownerPaused);
    if (same) return;
    conversation.members = next;
    await this.writeJson("conversations.json", this.conversations);
    this.emit({ type: "conversation", conversationId });
  }

  async listMessages(
    conversationId: string,
    options: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}
  ): Promise<Message[]> {
    const all = await this.loadMessages(conversationId);
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);

    if (options.afterSeq !== undefined) {
      const after = options.afterSeq;
      return all.filter((m) => m.seq > after).slice(0, limit);
    }
    if (options.beforeSeq !== undefined) {
      const before = options.beforeSeq;
      return all.filter((m) => m.seq < before).slice(-limit);
    }
    return all.slice(-limit);
  }

  async markRead(
    conversationId: string,
    userId: string,
    seq: number
  ): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    const member = conversation.members.find((m) => m.userId === userId);
    if (!member) return;
    // Only increases, never decreases, so out-of-order requests can't pull the read position back
    if (seq <= member.lastReadSeq) return;
    member.lastReadSeq = seq;
    if (member.firstUnreadMentionSeq !== undefined && member.firstUnreadMentionSeq <= seq) {
      // Read has passed the first @: switch to the next one after the read position
      const next = (await this.loadMessages(conversationId)).find((m) => m.seq > seq && !m.internal && m.senderId !== userId && m.mentions?.includes(userId));
      if (next) member.firstUnreadMentionSeq = next.seq;
      else delete member.firstUnreadMentionSeq;
    }
    await this.writeJson("conversations.json", this.conversations);
  }

  async markProcessed(conversationId: string, agentUserId: string, seq: number): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    const member = conversation.members.find(m => m.userId === agentUserId);
    if (!member || seq <= (member.lastProcessedSeq ?? member.lastReadSeq)) return;
    member.lastProcessedSeq = Math.min(seq, conversation.lastSeq);
    await this.writeJson("conversations.json", this.conversations);
    // Persist the watermark first, then clear the ledger: on a crash in between, restart judges it processed by the watermark and won't rerun.
    // Clear only after every local Agent that should handle it is done: if in a group A finishes first and it crashes while B is still running, restart must re-trigger B from the ledger
    const owed = this.owed[conversationId];
    if (!owed?.length) return;
    const done: string[] = [];
    for (const message of await this.loadMessages(conversationId)) {
      if (message.seq > member.lastProcessedSeq! || !owed.includes(message.messageId)) continue;
      if (await processedByAllOwners(conversation, message, (userId) => this.getUser(userId))) done.push(message.messageId);
    }
    if (done.length) await this.settleOwed(conversationId, done);
  }

  /** Record user messages in the ledger before handing them to an Agent (by clientMessageId, called before the message is written) */
  async oweMessage(conversationId: string, messageId: string): Promise<void> {
    const owed = (this.owed[conversationId] ??= []);
    if (owed.includes(messageId)) return;
    owed.push(messageId);
    await this.writeJson("owed-messages.json", this.owed);
  }

  /** Processed, or definitely no longer needing processing (user paused, task has no local Agent); omitting IDs clears the whole task */
  async settleOwed(conversationId: string, messageIds?: string[]): Promise<void> {
    const owed = this.owed[conversationId];
    if (!owed) return;
    const rest = messageIds ? owed.filter((id) => !messageIds.includes(id)) : [];
    if (rest.length === owed.length) return;
    if (rest.length) this.owed[conversationId] = rest;
    else delete this.owed[conversationId];
    await this.writeJson("owed-messages.json", this.owed);
  }

  /**
   * User messages not yet fully processed, ordered by task and local sequence number. Entries recorded in the ledger whose message never got written (crash before writing)
   * or whose task no longer exists are cleaned up along the way.
   */
  async listOwedMessages(conversationId?: string): Promise<Message[]> {
    const result: Message[] = [];
    let changed = false;
    for (const [id, owed] of Object.entries(this.owed)) {
      if (conversationId !== undefined && id !== conversationId) continue;
      const messages = this.conversations[id] ? (await this.loadMessages(id)).filter((message) => owed.includes(message.messageId)) : [];
      // Only clean up wholesale at startup: when querying per task at runtime, we might hit the moment a ledger entry is recorded and the message is still being written
      if (conversationId === undefined && messages.length < owed.length) {
        changed = true;
        if (messages.length) this.owed[id] = messages.map((message) => message.messageId);
        else delete this.owed[id];
      }
      result.push(...messages);
    }
    if (changed) await this.writeJson("owed-messages.json", this.owed);
    return result;
  }

  // -------------------------------------------------------------------------
  // Agent session resumption
  // -------------------------------------------------------------------------

  async getAgentSession(
    conversationId: string,
    agentUserId: string
  ): Promise<AgentSessionRef | null> {
    return this.agentSessions[sessionKey(conversationId, agentUserId)] ?? null;
  }

  async listAgentSessions(conversationId: string): Promise<AgentSessionRef[]> {
    return Object.values(this.agentSessions).filter((session) => session.conversationId === conversationId);
  }

  async saveAgentSession(session: AgentSessionRef): Promise<void> {
    const key = sessionKey(session.conversationId, session.agentUserId);
    this.agentSessions[key] = { ...this.agentSessions[key], ...session };
    await this.writeJson("agent-sessions.json", this.agentSessions);
  }

  // -------------------------------------------------------------------------
  // Skill shared library
  //
  // There's only one layer, the shared library, with no agent-private layer -- all agents share the same copy.
  // Principle: automatically created ones may be updated automatically; ones created by people must have updates initiated by people.
  // -------------------------------------------------------------------------

  async listSkills(refs?: ScopeRef[]): Promise<Skill[]> {
    return this.knowledgeQueue.run("skills", async () => {
    const wanted = refs?.map((ref) => scopeKey(ref));
    const result: Skill[] = [];
    for (const meta of Object.values(this.skillIndex)) {
      if (
        wanted &&
        !wanted.includes(scopeKey({ scope: meta.scope, ownerId: meta.ownerId }))
      ) {
        continue;
      }
      const skill = await this.getSkillLocked(meta.skillId);
      if (skill) result.push(skill);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async knowledgeRoot(): Promise<string> { return path.resolve(this.root); }

  async getSkill(skillId: string): Promise<Skill | null> {
    return this.knowledgeQueue.run("skills", () => this.getSkillLocked(skillId));
  }

  private async getSkillLocked(skillId: string): Promise<Skill | null> {
    const meta = this.skillIndex[skillId];
    if (!meta) return null;
    if (!meta.source) return { ...meta, content: await this.readText(path.join("skills", `${skillId}.md`), "") };
    const directory = this.centralSkillDirectory(skillId);
    const files = await readSkillPackage(directory);
    const document = parseSkillDocument(Buffer.from(files.find(file => file.path === "SKILL.md")!.bytes).toString("utf8"));
    return { ...meta, ...document, source: { directory, fingerprint: fingerprintPackageFiles(files), files: packageManifest(files) } };
  }

  async importSkill(input: Parameters<Store["importSkill"]>[0]): Promise<Skill> {
    return this.knowledgeQueue.run("skills", async () => {
      this.validateSkillScope(input.scope, input.ownerId);
      const files = await readSkillPackage(input.sourcePath);
      const document = parseSkillDocument(Buffer.from(files.find(file => file.path === "SKILL.md")!.bytes).toString("utf8"));
      const current = input.skillId ? await this.getSkillLocked(input.skillId) : null;
      if (input.skillId && !current) throw new Error(tm("main.store.skillMissing"));
      if (current && (current.scope !== input.scope || current.ownerId !== input.ownerId)) throw new Error(p("不能改变技能包的归属范围", "A skill package's ownership scope cannot be changed"));
      const now = new Date().toISOString();
      const skill: Skill = { ...current, skillId: current?.skillId ?? newId("skill"), name: input.name?.trim() || document.name, description: input.description?.trim() || document.description, content: document.content,
        scope: input.scope, ownerId: input.ownerId, authorKind: current?.authorKind ?? input.authorKind, authorUserId: current?.authorUserId ?? input.authorUserId,
        targets: input.targets ?? current?.targets, enabled: current?.enabled ?? true, useCount: current?.useCount ?? 0, createdAt: current?.createdAt ?? now, updatedAt: now,
        directoryName: current?.directoryName ?? (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(document.name) ? document.name : undefined) };
      if (input.name || input.description) files.find(file => file.path === "SKILL.md")!.bytes = Buffer.from(renderSkillDocument(skill, Buffer.from(files.find(file => file.path === "SKILL.md")!.bytes).toString("utf8")));
      await this.persistSkill(skill, files);
      this.emit({ type: "skills" });
      return (await this.getSkillLocked(skill.skillId))!;
    });
  }

  async createSkill(input: {
    name: string;
    description: string;
    scope: Scope;
    ownerId?: string;
    content: string;
    authorKind: SkillAuthorKind;
    authorUserId?: string;
    targets?: AgentKind[];
  }): Promise<Skill> {
    return this.knowledgeQueue.run("skills", async () => {
    this.validateSkillScope(input.scope, input.ownerId);
    const now = new Date().toISOString();
    const skill: Skill = {
      skillId: newId("skill"),
      name: input.name.trim(),
      description: input.description.trim(),
      scope: input.scope,
      ownerId: input.ownerId,
      content: input.content,
      enabled: true,
      authorKind: input.authorKind,
      authorUserId: input.authorUserId,
      targets: input.targets,
      useCount: 0,
      createdAt: now,
      updatedAt: now
    };
    if (!skill.name) throw new Error(tm("main.store.skillNameRequired"));
    await this.persistSkill(skill);
    await log("skill-created",{id:skill.skillId,scope:skill.scope,version:skill.updatedAt});
    this.emit({ type: "skills" });
    return (await this.getSkillLocked(skill.skillId))!;
    });
  }

  async updateSkill(
    skillId: string,
    patch: Partial<
      Pick<Skill, "name" | "description" | "content" | "enabled" | "targets">
    >
  ): Promise<Skill> {
    return this.knowledgeQueue.run("skills", async () => {
    const current = await this.getSkillLocked(skillId);
    if (!current) throw new Error(tm("main.store.skillMissing"));
    const next: Skill = {
      ...current,
      description: patch.description ?? current.description,
      content: patch.content ?? current.content,
      enabled: patch.enabled ?? current.enabled,
      targets: patch.targets ?? current.targets,
      name: (patch.name ?? current.name).trim(),
      updatedAt: new Date().toISOString()
    };
    if (!next.name) throw new Error(tm("main.store.skillNameRequired"));
    await this.persistSkill(next);
    await log("skill-updated",{id:next.skillId,scope:next.scope,version:next.updatedAt});
    this.emit({ type: "skills" });
    return (await this.getSkillLocked(next.skillId))!;
    });
  }

  async deleteSkill(skillId: string): Promise<void> {
    return this.knowledgeQueue.run("skills", async () => {
    const meta = this.skillIndex[skillId];
    if (!meta) return;
    const next = { ...this.skillIndex }; delete next[skillId];
    await this.writeJson(path.join("skills", "index.json"), next);
    this.skillIndex = next;
    try { await rm(this.centralSkillDirectory(skillId), { recursive: true, force: true }); } catch(error) { await log("skill-deleted-package-cleanup-failed",{id:skillId,error:String(error)}); }
    try {
      await unlink(path.join(this.root, "skills", `${skillId}.md`));
    } catch {
      // The file was never there; not an error
    }
    this.emit({ type: "skills" });
    });
  }

  async bumpSkillUse(skillId: string): Promise<void> {
    return this.knowledgeQueue.run("skills", async () => {
    const meta = this.skillIndex[skillId];
    if (!meta) return;
    meta.useCount = (meta.useCount ?? 0) + 1;
    await this.writeJson(path.join("skills", "index.json"), this.skillIndex);
    });
  }

  async exportKnowledge(): ReturnType<Store["exportKnowledge"]> {
    const skills = await this.knowledgeQueue.run("skills", async () => {
      const out: Array<{ skill: Skill; files: PackageFile[] }> = [];
      for (const { skillId } of Object.values(this.skillIndex)) {
        const skill = await this.getSkillLocked(skillId);
        if (!skill) continue;
        const files = skill.source ? await readPackageDirectory(this.centralSkillDirectory(skillId)) : [{ path: "SKILL.md", bytes: Buffer.from(renderSkillDocument(skill)), mode: 0o644 }];
        out.push({ skill, files });
      }
      return out;
    });
    const memories = await this.memoryQueue.run("memories", async () => {
      const out: MemoryEntry[] = [];
      for (const file of await readdir(this.memoriesDir())) {
        if (!file.endsWith(".jsonl")) continue;
        for (const line of (await readFile(path.join(this.memoriesDir(), file), "utf8")).split("\n")) {
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line) as MemoryEntry); } catch { /* one broken line doesn't affect the others */ }
        }
      }
      return out;
    });
    return { skills, memories };
  }

  async applyCloudSkill(skill: Skill, files: PackageFile[]): Promise<void> {
    return this.knowledgeQueue.run("skills", async () => {
      this.validateSkillScope(skill.scope, skill.ownerId);
      await this.persistSkill({ ...skill, useCount: this.skillIndex[skill.skillId]?.useCount ?? 0 }, files);
      this.emit({ type: "skills" });
    });
  }

  async applyCloudMemory(entry: MemoryEntry): Promise<void> {
    this.validateMemoryScope(entry.scope, entry.ownerId);
    await this.memoryQueue.run("memories", async () => {
      if (await this.rewriteMemoryFileLocked(entry.memoryId, () => entry)) return;
      await mkdir(this.memoriesDir(), { recursive: true });
      await appendFile(path.join(this.memoriesDir(), `${memoryFileName(entry.scope, entry.ownerId)}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
    });
    this.emit({ type: "memories", scope: entry.scope, ownerId: entry.ownerId });
  }

  private validateSkillScope(scope: Scope, ownerId?: string): void {
    if ((scope !== "global" && scope !== "workspace") || (scope === "workspace" && !ownerId) || (scope === "global" && ownerId)) throw new Error(p("技能范围或归属无效", "The skill scope or owner is invalid"));
  }

  private centralSkillDirectory(skillId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(skillId)) throw new Error(p("技能标识无效", "The skill ID is invalid"));
    return path.join(this.skillsDir(), skillId);
  }

  private async recoverSkillTransaction(): Promise<void> {
    const journal = await this.readJson<{skillId:string;candidate:string;backup:string;had:boolean;fingerprint:string}|null>(path.join("skills",".ading-transaction.json"),null);
    if (!journal) return;
    const directory=this.centralSkillDirectory(journal.skillId);
    if(!/^\.candidate-[a-f0-9-]+$/.test(journal.candidate) || !/^\.backup-[a-f0-9-]+$/.test(journal.backup)) throw new Error(p("中央技能事务记录无效", "The central skill transaction record is invalid"));
    const candidate=path.join(this.skillsDir(),journal.candidate),backup=path.join(this.skillsDir(),journal.backup);
    const committed=this.skillIndex[journal.skillId]?.source?.fingerprint===journal.fingerprint;
    if(!committed) {
      // The index is the commit record. Preserve the previous bundle if the index was not committed.
      let backedUp=false;try { backedUp=(await lstat(backup)).isDirectory(); } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
      if(backedUp) { await rm(directory,{recursive:true,force:true}); await rename(backup,directory); }
      else if(!journal.had) await rm(directory,{recursive:true,force:true});
    }
    await rm(candidate,{recursive:true,force:true});await rm(backup,{recursive:true,force:true});
    await rm(path.join(this.skillsDir(),".ading-transaction.json"),{force:true});
  }

  private async persistSkill(skill: Skill, importedFiles?: PackageFile[]): Promise<void> {
    const directory = this.centralSkillDirectory(skill.skillId);
    const files = importedFiles ?? (skill.source ? await readPackageDirectory(directory) : [{ path: "SKILL.md", bytes: Buffer.from(renderSkillDocument(skill)), mode: 0o644 }]);
    if (!importedFiles && skill.source) {
      const document = files.find(file => file.path === "SKILL.md");
      if (!document) throw new Error(p("中央技能包缺少 SKILL.md", "The central skill package is missing SKILL.md"));
      const previous=Buffer.from(document.bytes).toString("utf8"),parsed=parseSkillDocument(previous);
      if(parsed.name!==skill.name || parsed.description!==skill.description || parsed.content!==skill.content) document.bytes = Buffer.from(renderSkillDocument(skill, previous));
    }
    const storedDocument=parseSkillDocument(Buffer.from(files.find(file => file.path === "SKILL.md")!.bytes).toString("utf8"));
    skill.directoryName ??= skillSlug(skill);
    if (Object.values(this.skillIndex).some(other => other.skillId !== skill.skillId && other.scope === skill.scope && other.ownerId === skill.ownerId && other.directoryName?.toLowerCase() === skill.directoryName!.toLowerCase())) throw new Error(p("中央库已有同名技能，请明确选择要更新的技能", "The central library already has a skill with this directory name; choose the skill to update"));
    const candidate = path.join(this.skillsDir(), `.candidate-${randomUUID()}`);
    const backup = path.join(this.skillsDir(), `.backup-${randomUUID()}`);
    await writePackageCandidate(candidate, files);
    skill.source = { directory, fingerprint: fingerprintPackageFiles(files), files: packageManifest(files) };
    const { content, ...meta } = skill; const next = { ...this.skillIndex, [skill.skillId]: meta };
    let had = false, committed = false;
    try {
      try { const st=await lstat(directory); if(st.isSymbolicLink() || !st.isDirectory()) throw new Error(p("中央技能目录无效", "The central skill directory is invalid")); had=true; } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
      await this.writeJson(path.join("skills",".ading-transaction.json"),{skillId:skill.skillId,candidate:path.basename(candidate),backup:path.basename(backup),had,fingerprint:skill.source.fingerprint});
      if (had) await rename(directory, backup);
      await rename(candidate, directory);
      try { await this.writeJson(path.join("skills", "index.json"), next); } catch(error) { await rm(directory,{recursive:true,force:true}); if(had) await rename(backup,directory); throw error; }
      this.skillIndex = next; committed = true;
      // The old body-only file is retained as a compatibility view, never read as the source again.
      try { await this.writeText(path.join("skills", `${skill.skillId}.md`), storedDocument.content); } catch(error) { await log("skill-compatibility-view-write-failed",{id:skill.skillId,error:String(error)}); }
    } finally {
      await rm(candidate,{recursive:true,force:true});
      if(committed) await rm(backup,{recursive:true,force:true});
      else if(had) { try { await lstat(directory); } catch { await rename(backup,directory).catch(()=>undefined); } }
      await rm(path.join(this.skillsDir(),".ading-transaction.json"),{force:true});
    }
  }

  // -------------------------------------------------------------------------
  // Skill proposals and peer review
  // -------------------------------------------------------------------------

  async createProposal(input: {
    kind: ProposalKind;
    targetSkillId?: string;
    proposerUserId: string;
    conversationId: string;
    name: string;
    description: string;
    scope: Scope;
    ownerId?: string;
    content: string;
    targets?: AgentKind[];
    evidenceFromSeq: number;
    evidenceToSeq: number;
    evidenceSteps: string[];
    state: ProposalState;
    blockedReason?: string;
  }): Promise<SkillProposal> {
    const proposal: SkillProposal = {
      ...input,
      proposalId: newId("proposal"),
      reviews: [],
      createdAt: new Date().toISOString()
    };
    this.proposals[proposal.proposalId] = proposal;
    await this.writeJson("skill-proposals.json", this.proposals);
    this.emit({ type: "proposals" });
    return proposal;
  }

  async listProposals(states?: ProposalState[]): Promise<SkillProposal[]> {
    return Object.values(this.proposals)
      .filter((proposal) => !states || states.includes(proposal.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getProposal(proposalId: string): Promise<SkillProposal | null> {
    return this.proposals[proposalId] ?? null;
  }

  async recordReview(
    proposalId: string,
    review: SkillReview
  ): Promise<SkillProposal> {
    const proposal = this.proposals[proposalId];
    if (!proposal) throw new Error(tm("main.store.proposalMissing"));
    proposal.reviews = proposal.reviews.filter(
      (item) => item.reviewerUserId !== review.reviewerUserId
    );
    proposal.reviews.push(review);
    await this.writeJson("skill-proposals.json", this.proposals);
    this.emit({ type: "proposals" });
    return proposal;
  }

  async setProposalState(
    proposalId: string,
    state: ProposalState,
    blockedReason?: string
  ): Promise<SkillProposal> {
    const proposal = this.proposals[proposalId];
    if (!proposal) throw new Error(tm("main.store.proposalMissing"));
    await log("skill-proposal-state",{id:proposalId,state,conversation:proposal.conversationId});
    proposal.state = state;
    proposal.blockedReason = blockedReason;
    if (state !== "reviewing") proposal.resolvedAt = new Date().toISOString();
    await this.writeJson("skill-proposals.json", this.proposals);
    this.emit({ type: "proposals" });
    return proposal;
  }

  // -------------------------------------------------------------------------
  // Memory
  //
  // Three layers: user (about the person, across all conversations), workspace (facts about this project),
  // task (facts and decisions in this conversation).
  // Files split by scope + ownerId, appended as JSONL -- write frequency is an order of magnitude higher than skills,
  // so the whole file can't be rewritten every time like skills.
  // -------------------------------------------------------------------------

  async listMemories(
    scope: MemoryScope,
    ownerId: string,
    options: { since?: string; limit?: number } = {}
  ): Promise<MemoryEntry[]> {
    this.validateMemoryScope(scope,ownerId);
    const raw = await this.readText(
      path.join("memories", `${memoryFileName(scope, ownerId)}.jsonl`),
      ""
    );
    const entries: MemoryEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry=JSON.parse(line) as MemoryEntry;
        if(entry.scope===scope && entry.ownerId===ownerId) entries.push(entry);
      } catch {
        // One broken line shouldn't make the whole memory unreadable
      }
    }
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // Incremental injection: only what was added after the watermark. Pinned ones are always given, regardless of watermark or count limits
    const since = options.since;
    const picked = since
      ? entries.filter((entry) => entry.pinned || (entry.updatedAt ?? entry.createdAt) >= since)
      : entries;

    const limit = options.limit ?? 200;
    if (picked.length <= limit) return picked;
    const pinned = picked.filter((entry) => entry.pinned);
    const rest = picked.filter((entry) => !entry.pinned).slice(-limit);
    return [...pinned, ...rest].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
  }

  async appendMemory(entry: {
    scope: MemoryScope;
    ownerId: string;
    content: string;
    authorKind: SkillAuthorKind;
    authorUserId?: string;
    sourceMessageId?: string;
    pinned?: boolean;
  }): Promise<MemoryEntry> {
    return this.memoryQueue.run("memories", () => this.appendMemoryLocked(entry));
  }

  private async appendMemoryLocked(entry: {
    scope: MemoryScope;
    ownerId: string;
    content: string;
    authorKind: SkillAuthorKind;
    authorUserId?: string;
    sourceMessageId?: string;
    pinned?: boolean;
  }): Promise<MemoryEntry> {
    this.validateMemoryScope(entry.scope,entry.ownerId);
    // Only people can write personal memory. An agent concluding "the boss likes X" after two observations easily overgeneralizes,
    // and this entry follows the person into every conversation, so if it's wrong it's wrong everywhere.
    if (entry.scope === "user" && entry.authorKind !== "human") {
      throw new Error(tm("main.store.userMemoryHumanOnly"));
    }
    const content = entry.content.trim();
    if (!content) throw new Error(tm("main.store.memoryEmpty"));

    const full: MemoryEntry = {
      memoryId: newId("memory"),
      scope: entry.scope,
      ownerId: entry.ownerId,
      content,
      authorKind: entry.authorKind,
      authorUserId: entry.authorUserId,
      sourceMessageId: entry.sourceMessageId,
      pinned: entry.pinned ?? false,
      createdAt: new Date().toISOString()
    };
    await mkdir(this.memoriesDir(), { recursive: true });
    await appendFile(
      path.join(
        this.memoriesDir(),
        `${memoryFileName(entry.scope, entry.ownerId)}.jsonl`
      ),
      JSON.stringify(full) + "\n",
      "utf8"
    );
    this.emit({ type: "memories", scope: entry.scope, ownerId: entry.ownerId });
    await log("memory-created", {id:full.memoryId,scope:full.scope,ownerId:full.ownerId,sourceMessageId:full.sourceMessageId});
    return full;
  }

  private validateMemoryScope(scope: MemoryScope, ownerId: string): void {
    if(!["user","workspace","conversation"].includes(scope) || typeof ownerId!=="string" || !ownerId.trim()) throw new Error(p("记忆范围或归属无效", "The memory scope or owner is invalid"));
  }

  async updateMemory(
    memoryId: string,
    patch: Partial<Pick<MemoryEntry, "content" | "pinned">>
  ): Promise<MemoryEntry> {
    const found = await this.rewriteMemoryFile(memoryId, (entry) => ({
      ...entry,
      content: patch.content?.trim() || entry.content,
      pinned: patch.pinned ?? entry.pinned,
      updatedAt: new Date().toISOString()
    }));
    if (!found) throw new Error(tm("main.store.memoryMissing"));
    await log("memory-updated", {id:found.memoryId,scope:found.scope,ownerId:found.ownerId,version:found.updatedAt});
    this.emit({ type: "memories", scope: found.scope, ownerId: found.ownerId });
    return found;
  }

  async deleteMemory(memoryId: string): Promise<void> {
    const found = await this.rewriteMemoryFile(memoryId, () => null);
    if (found) {
      this.emit({ type: "memories", scope: found.scope, ownerId: found.ownerId });
    }
  }

  /** Memories are split into files by scope; changing one means rewriting its whole file */
  private async rewriteMemoryFile(
    memoryId: string,
    transform: (entry: MemoryEntry) => MemoryEntry | null
  ): Promise<MemoryEntry | null> {
    return this.memoryQueue.run("memories", () => this.rewriteMemoryFileLocked(memoryId, transform));
  }

  private async rewriteMemoryFileLocked(
    memoryId: string,
    transform: (entry: MemoryEntry) => MemoryEntry | null
  ): Promise<MemoryEntry | null> {
    const { readdir } = await import("node:fs/promises");
    let files: string[] = [];
    try {
      files = await readdir(this.memoriesDir());
    } catch {
      return null;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = path.join(this.memoriesDir(), file);
      const raw = await readFile(full, "utf8").catch(() => "");
      if (!raw.includes(memoryId)) continue;

      let result: MemoryEntry | null = null;
      const kept: string[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let entry: MemoryEntry;
        try {
          entry = JSON.parse(line) as MemoryEntry;
        } catch {
          kept.push(line);
          continue;
        }
        if (entry.memoryId !== memoryId) {
          kept.push(line);
          continue;
        }
        const next = transform(entry);
        if (next) {
          result = next;
          kept.push(JSON.stringify(next));
        } else {
          result = entry;
        }
      }
      await this.writeText(path.relative(this.root, full), kept.join("\n") + (kept.length ? "\n" : ""));
      return result;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  subscribe(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One subscriber throwing shouldn't affect the others
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private requireConversation(conversationId: string): Conversation {
    const conversation = this.conversations[conversationId];
    if (!conversation) throw new Error(tm("main.store.conversationMissing"));
    return conversation;
  }

  private async touch(conversation: Conversation): Promise<void> {
    conversation.updatedAt = new Date().toISOString();
    await this.writeJson("conversations.json", this.conversations);
    this.emit({ type: "conversation", conversationId: conversation.conversationId });
  }

  private async loadMessages(conversationId: string): Promise<Message[]> {
    const cached = this.messageCache.get(conversationId);
    if (cached) return cached;
    const pending = this.messageLoads.get(conversationId);
    if (pending) return pending;
    const loading = this.readMessages(conversationId);
    this.messageLoads.set(conversationId, loading);
    try { return await loading; }
    finally { this.messageLoads.delete(conversationId); }
  }

  private async readMessages(conversationId: string): Promise<Message[]> {

    const raw = await this.readText(
      path.join("messages", `${conversationId}.jsonl`),
      ""
    );
    const messages: Message[] = [];
    const lines = raw.split("\n");
    let repaired = false;
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as Message);
      } catch (error) {
        // Only a torn final append is recoverable; preserve the original journal.
        if (index === lines.length - 1 && !raw.endsWith("\n")) {
          await this.writeText(path.join("messages", `${conversationId}.recovery-${Date.now()}.jsonl`), raw);
          await this.writeText(path.join("messages", `${conversationId}.jsonl`), lines.slice(0, index).join("\n") + (index ? "\n" : ""));
          repaired = true;
        } else {
          throw new Error(tm("main.store.chatCorrupted", { conversationId, line: index + 1 }), { cause: error });
        }
      }
    }
    // A complete last record may survive without its delimiter. Restore it before
    // the next append, otherwise two valid records would be concatenated.
    if (raw && !raw.endsWith("\n") && !repaired) {
      await this.writeText(path.join("messages", `${conversationId}.jsonl`), raw + "\n");
    }
    this.messageCache.set(conversationId, messages);
    const conversation = this.conversations[conversationId];
    if (conversation) conversation.lastMessage = messages.slice().reverse().find(m => !m.failed && !m.internal);
    return messages;
  }

  private messagesDir(): string {
    return path.join(this.root, "messages");
  }

  private messagesFile(conversationId: string): string {
    return path.join(this.messagesDir(), `${conversationId}.jsonl`);
  }

  private skillsDir(): string {
    return path.join(this.root, "skills");
  }

  private memoriesDir(): string {
    return path.join(this.root, "memories");
  }

  private async readJson<T>(relativePath: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(
        await readFile(path.join(this.root, relativePath), "utf8")
      ) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw new Error(tm("main.store.dataUnreadable", { path: relativePath }), { cause: error });
    }
  }

  private async readText(relativePath: string, fallback: string): Promise<string> {
    try {
      return await readFile(path.join(this.root, relativePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  /** Write a temp file first, then rename -- a crash midway won't leave half a JSON */
  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.writeText(relativePath, JSON.stringify(value, null, 2));
  }

  private async writeText(relativePath: string, content: string): Promise<void> {
    const target = path.join(this.root, relativePath);
    return this.fileQueue.run(target, async () => {
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${newId("message")}.tmp`;
      const file = await open(temporary, "wx");
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
      } finally { await file.close(); }
      try { await rename(temporary, target); }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    });
  }
}

function directKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

function directKeyOf(conversation: Conversation): string {
  const [first, second] = conversation.members.map((m) => m.userId);
  return directKey(first ?? "", second ?? "");
}

function sessionKey(conversationId: string, agentUserId: string): string {
  return `${conversationId}::${agentUserId}`;
}

function scopeKey(ref: ScopeRef): string {
  return `${ref.scope}:${ref.ownerId ?? ""}`;
}

export function memoryFileName(scope: MemoryScope, ownerId: string): string {
  const owner = ownerId.replace(/[^\w.-]/g, "_");
  return `${scope}-${owner}`;
}
