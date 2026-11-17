/**
 * Store — the data-layer boundary between standalone and online modes.
 *
 * The interface is designed for "the harder mode" (online: multiple accounts, concurrency, needs seq and read positions),
 * with standalone as a degenerate implementation. Designing the other way round would miss fields like seq and lastReadSeq,
 * and going online would mean a rewrite instead of adding an implementation.
 *
 * Upper layers (scheduler, IPC handlers, renderer) only know this interface, not whether there's a backend.
 */

import type { PackageFile } from "../knowledge/bundle-files";
export interface CreateConversationInput {
  /** The raw first message from the chat input; must not be replaced by a title or system template. */
  initialMessage?: string;
  initialMentions?: string[];
  /** Attachments on the first message (already placed in the local attachments directory) */
  initialAttachments?: Attachment[];
  autoTitle?: boolean;
  permanent?: boolean;
  leaderId?: string;
  name: string;
  memberIds: string[];
  workspaceId?: string;
  workspacePath?: string;
  charter?: Charter;
  /** Stable identifier from the task order, used to dedupe repeated applications */
  seedKey?: string;
}

export interface Store {
  readonly mode: StoreMode;

  init(): Promise<void>;
  close(): Promise<void>;

  // ---- Identity ----
  /** Standalone returns a fixed local user; online returns the signed-in account */
  currentUser(): Promise<UserRef>;

  // ---- Contacts ----
  /** Contacts = agents a person explicitly added. Discovered but not added ones aren't here */
  listContacts(): Promise<UserRef[]>;
  /** All agents registered on this computer, added or not. Used by the Agent onboarding page */
  listKnownAgents(): Promise<UserRef[]>;
  getUser(userId: string): Promise<UserRef | null>;

  /** Shared contact profile entry for humans and Agents; changing username isn't allowed */
  updateContact(
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
  ): Promise<UserRef>;
  /** Remove from contacts; the Agent's discovery record and past tasks are kept. */
  deleteContact(userId: string): Promise<void>;

  /**
   * Register agents discovered on this computer, idempotent by localUuid.
   * Idempotency is a hard requirement: desktop rediscovers on every startup,
   * and without it codex would become a new employee on every restart.
   */
  syncDiscoveredAgents(agents: DiscoveredAgent[]): Promise<UserRef[]>;

  updateAgent(
    userId: string,
    patch: Partial<
      Pick<UserRef, "displayName" | "persona" | "sharedWith" | "enabled" | "modelConfig">
    >
  ): Promise<UserRef>;

  // ---- Workspaces ----
  /** "Scratch" goes last; the rest are sorted by most recent use */
  listWorkspaces(): Promise<Workspace[]>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  /** The single global "Scratch" workspace. init() guarantees it exists */
  inboxWorkspace(): Promise<Workspace>;
  createWorkspace(input: { name: string; path: string }): Promise<Workspace>;
  updateWorkspace(
    workspaceId: string,
    patch: Partial<Pick<Workspace, "name" | "path">>
  ): Promise<Workspace>;
  /**
   * Delete a workspace. Its conversations are moved to "Scratch" instead of disappearing —
   * chat history is a person's asset and shouldn't be deleted as a side effect of tidying directories.
   * The workspace's own skills and facts are deleted with it, since their anchor is gone.
   */
  deleteWorkspace(workspaceId: string): Promise<void>;

  // ---- Conversations ----
  listConversations(): Promise<Conversation[]>;
  getConversation(conversationId: string): Promise<Conversation | null>;
  /** Batch-close tasks left over from before startup, without changing task order or update time. */
  pauseAllConversations(): Promise<number>;
  /** Only toggle the running state; don't disguise a state change as new chat activity or change task order. */
  setConversationPaused(conversationId: string, paused: boolean): Promise<Conversation>;

  /**
   * Create a new conversation.
   *
   * Deliberately **not** idempotent as "one direct chat per agent" — a task's granularity is one piece of work,
   * and several can be open with the same agent at once, each with its own thread and memory.
   *
   * Without workspaceId it lands in "Scratch". This is how "a workspace isn't required" is implemented:
   * not an empty field, but a real holding place with clear semantics.
   */
  createConversation(input: CreateConversationInput): Promise<Conversation>;

  addMember(conversationId: string, userId: string, role: MemberRole): Promise<Conversation>;
  /** Change roles. Separate from addMember: adding people and changing roles are two things; combining them collides with "already in conversation" */
  setMemberRole(
    conversationId: string,
    userId: string,
    role: MemberRole
  ): Promise<Conversation>;
  setMemberPaused(conversationId: string, userId: string, paused: boolean): Promise<Conversation>;
  removeMember(conversationId: string, userId: string): Promise<Conversation>;
  updateConversation(
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
  ): Promise<Conversation>;
  /** Delete a task with its chat history and Agent session references, without touching the workspace directory. */
  deleteConversation(conversationId: string): Promise<void>;

  // ---- Messages ----
  /**
   * Append a message and assign a seq.
   * clientMessageId is the idempotency key: timeout retries pass the same one and won't create two.
   */
  appendMessage(input: {
    /** Keep the original send time when syncing from the cloud; omitted when sending locally. */
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
    /** Attachments already placed in the local attachments directory (importAttachment); content may be empty when there are attachments */
    attachments?: Attachment[];
  }): Promise<Message>;

  // ---- Attachments ----
  /** Copy a local file into the attachments directory and return an attachment that can be sent with a message */
  importAttachment(source: string, name?: string): Promise<Attachment>;
  /** Content with no original file, like pasted screenshots */
  importAttachmentData(name: string, mimeType: string, bytes: Uint8Array): Promise<Attachment>;
  /**
   * Local path of an attachment. In online mode, if not yet local (sent from another device), it's downloaded from the cloud first,
   * so it may be slow; both viewing and handing to an agent go through here.
   */
  attachmentFile(conversationId: string, attachment: Pick<Attachment, "attachmentId" | "name">): Promise<string>;

  listMessages(
    conversationId: string,
    options?: { afterSeq?: number; beforeSeq?: number; limit?: number }
  ): Promise<Message[]>;

  markRead(conversationId: string, userId: string, seq: number): Promise<void>;
  markProcessed(conversationId: string, agentUserId: string, seq: number): Promise<void>;

  // ---- Unprocessed user messages ----
  /**
   * Record user messages before handing them to Agents; cleared automatically once the responsible Agents' processed watermark passes them;
   * after a crash or exit, restart retriggers from this record. Shared by standalone and online (online keeps it in the local cache).
   */
  oweMessage?(conversationId: string, messageId: string): Promise<void>;
  /** Definitely no longer needs processing (user paused, no local Agent in the task, etc.); without IDs clears the whole task */
  settleOwed?(conversationId: string, messageIds?: string[]): Promise<void>;
  listOwedMessages?(conversationId?: string): Promise<Message[]>;

  // ---- Agent session resume ----
  getAgentSession(
    conversationId: string,
    agentUserId: string
  ): Promise<AgentSessionRef | null>;

  saveAgentSession(session: AgentSessionRef): Promise<void>;

  // ---- Shared skill library ----
  /** Central library identity, also used to scope ownership of native replicas. */
  knowledgeRoot(): Promise<string>;
  listSkills(refs?: ScopeRef[]): Promise<Skill[]>;
  getSkill(skillId: string): Promise<Skill | null>;
  /** Import or replace a complete directory/ZIP into the authoritative central library. */
  importSkill(input: {
    sourcePath: string;
    skillId?: string;
    scope: Scope;
    ownerId?: string;
    name?: string;
    description?: string;
    authorKind: SkillAuthorKind;
    authorUserId?: string;
    targets?: AgentKind[];
  }): Promise<Skill>;
  createSkill(input: {
    name: string;
    description: string;
    scope: Scope;
    ownerId?: string;
    content: string;
    authorKind: SkillAuthorKind;
    authorUserId?: string;
    targets?: AgentKind[];
  }): Promise<Skill>;
  updateSkill(
    skillId: string,
    patch: Partial<
      Pick<Skill, "name" | "description" | "content" | "enabled" | "targets">
    >
  ): Promise<Skill>;
  deleteSkill(skillId: string): Promise<void>;
  /** +1 per hit, so auto skills nobody uses for a long time naturally retire */
  bumpSkillUse(skillId: string): Promise<void>;

  /** All skills (with full skill packages) and all memories, for cloud knowledge comparison */
  exportKnowledge(): Promise<{ skills: Array<{ skill: Skill; files: PackageFile[] }>; memories: MemoryEntry[] }>;
  /** Write a skill pulled from the cloud: keep its ID and times, write the skill package as is */
  applyCloudSkill(skill: Skill, files: PackageFile[]): Promise<void>;
  /** Write a memory pulled from the cloud: replace if the same ID exists, otherwise add */
  applyCloudMemory(entry: MemoryEntry): Promise<void>;

  // ---- Skill proposals and peer review ----
  createProposal(input: {
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
    /** State fixed at proposal time: updates to human-written skills go straight to the human queue, skipping agent peer review */
    state: ProposalState;
    blockedReason?: string;
  }): Promise<SkillProposal>;
  listProposals(states?: ProposalState[]): Promise<SkillProposal[]>;
  getProposal(proposalId: string): Promise<SkillProposal | null>;
  recordReview(proposalId: string, review: SkillReview): Promise<SkillProposal>;
  setProposalState(
    proposalId: string,
    state: ProposalState,
    blockedReason?: string
  ): Promise<SkillProposal>;

  // ---- Memory ----
  /** since is for incremental injection: only items added after this time */
  listMemories(
    scope: MemoryScope,
    ownerId: string,
    options?: { since?: string; limit?: number }
  ): Promise<MemoryEntry[]>;
  appendMemory(entry: {
    scope: MemoryScope;
    ownerId: string;
    content: string;
    authorKind: SkillAuthorKind;
    authorUserId?: string;
    sourceMessageId?: string;
    pinned?: boolean;
  }): Promise<MemoryEntry>;
  updateMemory(
    memoryId: string,
    patch: Partial<Pick<MemoryEntry, "content" | "pinned">>
  ): Promise<MemoryEntry>;
  deleteMemory(memoryId: string): Promise<void>;

  // ---- Change subscription ----
  /**
   * Standalone: LocalStore emits after writing; online: CloudStore emits after writing the local cache (including pulls triggered by MQTT pushes).
   * The renderer only subscribes here, so the UI code is identical in both modes.
   */
  subscribe(listener: (event: StoreEvent) => void): () => void;
}
