/** Copying ADing central-library knowledge into an Agent's native directory failed. category: skills, memories, removal (withdrawing copies of deleted scopes); cloud and OSS sync (agents is empty, not tied to a specific Agent) */
interface KnowledgeSyncFailure { category:"skills"|"memories"|"removal"|"cloud"; agents:AgentKind[]; detail:string; sync?:{stage:"copy"|"helper"|"verification";code:string;path:string}; permission?:{code:"EPERM"|"EACCES";path:string;directory:string;platform:string;directoryWritable?:boolean}; }
interface KnowledgeSyncPending {agents:AgentKind[];status:"waiting"|"running"|"repairing";}
interface KnowledgeSyncState { failures:KnowledgeSyncFailure[]; pending?:KnowledgeSyncPending[]; }

interface BootstrapPayload {
  windowActive?:boolean;
  permissionMode?: PermissionMode;
  runtime?: AgentRuntimeSnapshot;
  mode: StoreMode;
  me: UserRef;
  contacts: UserRef[];
  workspaces: Workspace[];
  conversations: Conversation[];
}

/** What the user checks to keep when archiving a conversation */
type KeepItem =
  | {
      as: "skill";
      name: string;
      description: string;
      content: string;
      global?: boolean;
    }
  | { as: "workspace-fact"; content: string }
  | { as: "user-fact"; content: string };


interface AgentSetupResult {
  ok: boolean;
  cancelled?: boolean;
  message: string;
}

interface AgentProgressPayload {
  revision?: number;
  agentUserId: string;
  conversationId: string;
  text: string;
}

interface AgentBusyPayload {
  revision?: number;
  agentUserId: string;
  conversationId: string;
  busy: boolean;
}

interface AccountUser {
  userId: string;
  username: string;
  displayName: string;
}

type AccountStatus =
  | { signedIn: false }
  | { signedIn: true; user: AccountUser; canAddFriend?: boolean; onboardingEligible?: boolean };

type AccountResult =
  | { ok: true; status: AccountStatus }
  | { ok: false; message: string };

/** The signed-in account's own profile. userId belongs to the account; the UI must not use it to replace the local identity */
interface AccountProfileView {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  phone?: string;
  email?: string;
}

interface AdingBridge {
  listPage(kind: "contacts", ids: string[]): Promise<UserRef[]>;
  listPage(kind: "conversations" | "switcher", ids: string[]): Promise<Conversation[]>;
  onWindowActive(callback:(active:boolean)=>void):void;
  onOpenFriendRequests?(callback:()=>void):void;
  onOpenConversation(callback:(conversationId:string)=>void):void;
  onboardingProgress(completedSteps?: number): Promise<{ ok: boolean; data?: { version: number; completedSteps: number } }>;
  accountStatus(): Promise<AccountStatus>;
  /** This computer as registered in the cloud; empty in standalone mode or before registration completes */
  accountComputer(): Promise<{ computerId: string; name: string } | null>;
  /** "System permissions" under Settings → Permissions: query only, no prompts */
  checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean; screenRecordingRequested: boolean; automation: Array<{ bundleId: string; name: string; status: "granted" | "denied" | "notDetermined" | "notRunning" | "unknown" }> }>;
  /** User clicked "Grant": accessibility / screenRecording / an app's bundleId */
  grantPermission(item: string): Promise<string | null>;
  /** Open the System Settings page containing this item */
  openPermissionSettings(item: string): Promise<null>;
  accountLogin(username: string, password: string): Promise<AccountResult>;
  accountRegister(username: string, password: string): Promise<AccountResult>;
  accountLogout(): Promise<AccountStatus>;
  /** Number of changes not yet synced to the cloud in online mode; 0 in standalone mode */
  syncPending(): Promise<number>;
  accountProfile(): Promise<AccountProfileView | null>;
  updateAccountProfile(patch: { displayName?: string; avatarUrl?: string; phone?: string; email?: string }): Promise<AccountProfileView>;
  /** Change the account password. The password lives only in the cloud; fails immediately if the server is unreachable, never queued for sync */
  changeAccountPassword?(currentPassword: string, newPassword: string): Promise<boolean>;
  onAccountChanged(callback: (status: AccountStatus) => void): void;
  /** After sign-in / sign-out the main process starts switching the data session (standalone ↔ account) */
  onDataSwitching(callback: (payload: { target: "local" | "account" }) => void): void;
  /** The data session has finished switching; the UI should reload its data */
  onDataSwitched(callback: (payload: { target: "local" | "account" }) => void): void;

  getPermissionMode(): Promise<PermissionMode>;
  setPermissionMode(mode:PermissionMode): Promise<PermissionMode>;
  /** Settings → Permissions → "Keep the computer awake while running tasks" */
  getKeepAwake(): Promise<boolean>;
  setKeepAwake(enabled: boolean): Promise<boolean>;
  bootstrap(): Promise<BootstrapPayload>;
  linkPreview(url: string): Promise<{ title: string; description: string; siteName: string; image?: string } | null>;
  openExternal(url: string): Promise<void>;
  revealArtifact(target: string, conversationId?: string): Promise<void>;
  captureSupportScreenshot(): Promise<SupportImagePayload | null>;
  submitSupportReport(input: SupportReportInput): Promise<SupportReportResult>;
  contactDeveloper(input: DeveloperContactInput): Promise<DeveloperContactResult>;
  /** Currently running version (dev builds include build time) and channel, shown in Settings → About */
  appInfo(): Promise<{ version: string; channel: "develop" | "pre" | "release" }>;
  setLanguage(language: "zh-CN" | "en"): Promise<"zh-CN" | "en">;
  updateState(): Promise<AppUpdateState>;
  checkForUpdates(): Promise<AppUpdateState>;
  /** Open the downloaded and verified installer (Finder mounts the DMG; the user drags it into Applications to install) and quit ADing; started=false if the user cancels in the confirmation dialog */
  openUpdatePackage(): Promise<{ started: boolean }>;
  /** Quit, swap in the new version, and reopen; if tasks are running the main process asks for confirmation first, started=false on cancel */
  installUpdate(): Promise<{ started: boolean }>;
  onUpdateState(callback: (state: AppUpdateState) => void): void;
  /** Startup Agent discovery and detection finished; device telemetry may now report when the window comes to the foreground */
  telemetryReady?(): Promise<void>;
  onComputerPermissionMissing?(callback: (payload: { kind: "accessibility" | "screenRecording"; message: string }) => void): void;
  enableAgentSetup(kind: AgentKind): Promise<AgentSetupResult>;
  agentAuthStatus(kind: AgentKind): Promise<AgentAuthStatus>;
  installAgent(kind: AgentKind, confirmed: boolean): Promise<AgentLifecycleResult>;
  loginAgent(kind: AgentKind, confirmed: boolean): Promise<AgentLifecycleResult>;
  cancelAgentLifecycle(kind: AgentKind, action: AgentLifecycleAction): Promise<boolean>;
  agentModelCatalog(userId: string): Promise<AgentModelCatalog>;
  /** modelId null means revert to following the original app */
  setAgentModel(userId: string, modelId: string | null): Promise<UserRef>;
  updateAgent(
    userId: string,
    patch: Partial<Pick<UserRef, "displayName" | "persona">>
  ): Promise<UserRef>;
  updateContact(
    userId: string,
    patch: Partial<
      Pick<
        UserRef,
        "displayName" | "avatarUrl" | "phone" | "email"
      >
    >
  ): Promise<UserRef>;
  listContacts(): Promise<UserRef[]>;
  deleteContact(userId: string): Promise<void>;
  shareAgent(agentId: string, recipientId: string, shared: boolean): Promise<void>;
  /** Online mode: pending friend requests (received and sent); empty in standalone mode */
  listFriendRequests(): Promise<FriendPerson[]>;
  /** Find a person by exact username, email, or phone number */
  searchPeople(query: string): Promise<FriendPerson[]>;
  /** Send a friend request; returns the resulting relationship (FRIEND directly if they already requested me) */
  requestFriend(userId: string): Promise<FriendPerson["relation"]>;
  acceptFriend(userId: string): Promise<void>;
  /** Decline their request, or withdraw one I sent */
  dismissFriendRequest(userId: string): Promise<void>;
  cancelAgent(agentUserId: string): Promise<boolean>;
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(input: { name: string; path: string }): Promise<Workspace>;
  updateWorkspace(
    workspaceId: string,
    patch: Partial<Pick<Workspace, "name" | "path">>
  ): Promise<Workspace>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  /** Open the system folder picker and create a workspace from the selection; returns null on cancel */
  pickWorkspace(): Promise<Workspace | null>;

  listConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  clearConversationPermissions(id: string): Promise<void>;
  createConversation(input: {
    initialMessage?: string;
    initialMentions?: string[];
    autoTitle?: boolean;
    permanent?: boolean;
    leaderId?: string;
    name: string;
    memberIds: string[];
    workspaceId?: string;
    workspacePath?: string;
    charter?: Charter;
  }): Promise<Conversation>;
  addMember(id: string, userId: string, role: MemberRole): Promise<Conversation>;
  setMemberRole(id: string, userId: string, role: MemberRole): Promise<Conversation>;
  reportConversation(id: string): Promise<Message>;
  removeMember(id: string, userId: string): Promise<Conversation>;
  updateConversation(
    id: string,
    patch: Partial<
      Pick<
        Conversation,
        | "name"
        | "owner"
        | "workspaceId"
        | "workspacePath"
        | "permanent"
        | "charter"
        | "status"
        | "paused"
      >
    >
  ): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  stopConversation(id: string): Promise<number>;
  listStoppedConversations(): Promise<string[]>;
  resumeConversation(id: string): Promise<void>;
  archiveConversation(id: string, keep: KeepItem[]): Promise<Conversation>;
  listMessages(
    conversationId: string,
    options?: { afterSeq?: number; beforeSeq?: number; limit?: number }
  ): Promise<Message[]>;
  sendMessage(input: {
    conversationId: string;
    clientMessageId: string;
    content: string;
    mentions?: string[];
    replyTo?: string;
    quote?: MessageQuote;
    attachments?: Attachment[];
  }): Promise<Message>;
  markRead(conversationId: string, seq: number): Promise<boolean>;

  /** Pick files and copy them into the attachments directory; those over the limit are listed in rejected */
  pickAttachments(): Promise<AttachmentImport>;
  importAttachmentPaths(paths: string[]): Promise<AttachmentImport>;
  importAttachmentData(name: string, mimeType: string, bytes: Uint8Array): Promise<Attachment>;
  /** Empty conversationId: attachments not yet sent */
  openAttachment(conversationId: string | null, attachment: Attachment): Promise<void>;
  /** Save the original attachment to a user-selected path; false when cancelled. */
  saveAttachment(conversationId: string | null, attachment: Attachment): Promise<boolean>;
  pathForFile(file: File): string;

  agentCatalog(refresh?: boolean): Promise<AgentStatus[]>;
  verifyAgent(kind: AgentKind): Promise<AgentStatus[]>;
  refreshAgentStatus(userId: string): Promise<{ requested: boolean; catalog: AgentStatus[] | null }>;
  setAgentAdded(kind: AgentKind, added: boolean): Promise<AgentStatus[]>;

  listSkills(refs?: ScopeRef[]): Promise<Skill[]>;
  createSkill(input:{name:string;description:string;scope:Scope;ownerId?:string;content:string;targets?:AgentKind[]}):Promise<Skill>;
  updateSkill(skillId:string,patch:Partial<Pick<Skill,"name"|"description"|"content"|"enabled"|"targets">>):Promise<Skill>;
  importSkill(input:{scope:Scope;ownerId?:string;sourceKind:"zip"|"directory";skillId?:string}):Promise<Skill|null>;
  retryKnowledgeSync():Promise<KnowledgeSyncState & {synced:boolean}>;
  knowledgeSyncState?():Promise<KnowledgeSyncState>;
  deleteSkill(skillId: string): Promise<void>;
  listProposals(states?: ProposalState[]): Promise<SkillProposal[]>;
  resolveProposal(proposalId: string, accept: boolean): Promise<SkillProposal>;
  listMemories(
    scope: MemoryScope,
    ownerId: string,
    limit?: number
  ): Promise<MemoryEntry[]>;
  appendMemory(input: {
    scope: MemoryScope;
    ownerId: string;
    content: string;
    pinned?: boolean;
  }): Promise<MemoryEntry>;
  deleteMemory(memoryId: string): Promise<void>;
  updateMemory(memoryId:string,patch:Partial<Pick<MemoryEntry,"content"|"pinned">>):Promise<MemoryEntry>;
  /** Pushes the latest failure list after each sync to Agent native directories; an empty list means recovered */
  onKnowledgeSyncState?(callback:(payload:KnowledgeSyncState)=>void):void;
  onStoreEvent(callback: (event: StoreEvent) => void): void;
  onAgentProgress(callback: (payload: AgentProgressPayload) => void): void;
  onAgentQueue?(callback: (payload: {revision: number; queued: AgentQueueEntry[]}) => void): void;
  onAgentBusy(callback: (payload: AgentBusyPayload) => void): void;
  onAgentLifecycleProgress(
    callback: (payload: {
      kind: AgentKind;
      action: AgentLifecycleAction;
      text: string;
      download?: AgentDownloadProgress;
    }) => void
  ): void;
  onSupportUploadResult(callback: (payload: SupportUploadResult) => void): void;
}
