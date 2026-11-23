/**
 * ADing domain types.
 *
 * This file deliberately has no import / export — it's an "ambient global declaration",
 * usable directly by both the main process and renderer without importing.
 *
 * Browser and Node entrypoints have separate compiler configurations.
 * Shared data shapes remain ambient declarations; UI components use browser ES modules.
 *
 * ============================================================
 * Data boundary between standalone and online modes
 * ============================================================
 * These domain types are identical in both modes. Data access is separated by two Store implementations:
 *   LocalStore   standalone: data on local disk, no account, no network
 *   CloudStore   online: the cloud is authoritative; locally keeps a per-account cache and a pending sync queue
 *
 * Scheduling differs: standalone is scheduled by LocalScheduler in the desktop process; online by
 * conductor on the server, with desktop nodes only executing Agent turns dispatched to them.
 * Both share the domain model and scheduling rule boundaries, but multiple desktop clients never compete for scheduling.
 */

type StoreMode = "local" | "remote";

interface AgentQueueEntry { agentUserId: string; conversationId: string; waitingForConversationId?: string; messageState?: "processing" | "waiting" | "handled"; }

interface AgentRuntimeSnapshot {
  queued?: AgentQueueEntry[];
  revision: number;
  agents: Array<{ agentUserId: string; conversationId: string; busy: boolean; text?: string }>;
}

type ConversationType = "DIRECT" | "GROUP";

/** Roles within a conversation. With 2+ members a primary is needed; LEADER is what the phase-two turn engine calls on */
type MemberRole = "LEADER" | "ENGINEER" | "REVIEWER" | "OBSERVER";

type MessageType = "USER" | "SYSTEM" | "TASK" | "SKILL";
type PermissionMode = "manual" | "leader" | "unattended";

type MessageStatus = "SENDING" | "SENT" | "FAILED";

/** The three CLI agents supported locally. Whichever is installed appears; uninstalled ones don't error */
type AgentKind = "codex" | "claude-code" | "qoder" | "qoder-cn" | "qwen-code" | "kiro" | "copilot" | "antigravity";

interface UserRef {
  sharedWith?: string[];
  /** Reserved per-Agent app override; discovery must never overwrite it. */
  modelConfig?: AgentRuntimeSettings;
  runtimeDefaults?: AgentRuntimeSettings;
  userId: string;
  /** Login username. It's an identity key; the contact profile page only shows it and doesn't allow changes */
  username?: string;
  displayName: string;
  /** Standalone stores it as a data URL first; online the backend replaces it with an object storage address */
  avatarUrl?: string;
  /** Human-only profile fields. Agents keep the field slots too, but they display empty and aren't editable */
  phone?: string;
  email?: string;
  isAgent: boolean;
  /** agent-only */
  kind?: AgentKind;
  version?: string;
  persona?: string;
  /** userId of the human who owns the agent */
  owner?: string;
  /** Stable local identifier of the agent, for idempotent registration */
  localUuid?: string;
  /**
   * Whether a person explicitly added it as a contact.
   *
   * "Discover" and "add" are two things: installed doesn't mean wanted. Discovery only lights the indicator on the Agent page;
   * a person decides whether to add it. Unadded ones don't enter the member picker or appear in contacts.
   *
   * undefined counts as true — this field was added later; agents in old data were all added automatically,
   * and after upgrading a person's contacts must not vanish.
   */
  enabled?: boolean;
  /**
   * Online mode: this agent is on another computer under the same account. Local agents don't have this field; standalone never does.
   *
   * Cross-computer collaboration relies on syncing: messages sync over as if typed on that computer, and that computer's scheduler drives it;
   * its state is published by that computer and synced via the cloud. So the local scheduler **never drives or handles** it,
   * only lights the indicator in the UI using the same rules as offline mode: that computer is online, and its detection result is ready.
   */
  remote?: RemoteComputer;
  /**
   * Other humans in online mode: true means friend; false means an unfriended person or someone only seen in the same group,
   * used only to show name and avatar, not in the contact list. Agents, yourself, and standalone mode don't have this field.
   */
  friend?: boolean;
}

/**
 * Another human seen when adding friends in online mode: shared by search results and friend requests.
 * relation: FRIEND already friends; OUTGOING I requested; INCOMING they requested me; NONE no relation yet
 */
interface FriendPerson {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  relation: "FRIEND" | "OUTGOING" | "INCOMING" | "NONE";
  /** Request time; empty for search results */
  requestedAt?: string;
}

/** The computer hosting a remote agent, and the agent state that computer published */
interface RemoteComputer {
  /** Cloud terminal_id; distinguishes same-named agents (each of two computers has a 小c) */
  computerId: string;
  computerName: string;
  online: boolean;
  readiness: AgentReadiness;
  /** Current model reported by that computer. Older clients don't report it; in that case model settings aren't offered */
  model?: RemoteAgentModel;
}

/** Current model reported by the Agent's host computer; the list must be asked from that computer live */
interface RemoteAgentModel {
  selected?: string;
  selectedLabel?: string;
  nativeModel?: string;
}

// ---------------------------------------------------------------------------
// Agent onboarding status
// ---------------------------------------------------------------------------

/**
 * Whether an agent is currently usable.
 *
 * The key is what ready means: **it actually ran successfully just now**, not "the executable is there".
 * Installed but not signed in is the most common trap; looking only at the file system would misjudge it as usable,
 * and then a person adds it to a conversation, sends a message, it fails, and only then do they find out.
 */
type AgentReadiness =
  /** Not checked yet */
  | "unknown"
  /** Executable not found on this computer */
  | "missing"
  /** Found, but connectivity not checked yet */
  | "found"
  /** Ran, but it says not signed in / not authorized */
  | "unauthorized"
  /** Ran successfully; can be added as a contact */
  | "ready"
  /** Signed in, but the account currently has no available quota */
  | "exhausted"
  /** Ran and failed, but it doesn't look like a sign-in problem (unrecognized arguments, version too old, etc.) */
  | "error";

type AgentAuthState = "signed-in" | "signed-out" | "unknown";

interface AgentAuthStatus {
  kind: AgentKind;
  state: AgentAuthState;
  /** Brief description returned by the vendor CLI; never contains credentials like tokens. */
  detail: string;
}

interface AgentDownloadProgress { receivedBytes: number; totalBytes?: number; }

type AgentLifecycleAction = "install" | "login" | "logout";

interface AgentLifecycleResult {
  kind: AgentKind;
  action: AgentLifecycleAction;
  ok: boolean;
  /** Sign-in usually needs confirmation in a browser; callers prompt the user accordingly. */
  requiresUserAction: boolean;
  unsupported?: boolean;
  /** A native app was opened for interactive setup; not a login failure/success. */
  awaitingUserAction?: boolean;
  message: string;
  auth?: AgentAuthStatus;
  /** Real model recheck after sign-in; signing in successfully doesn't mean the model is usable. */
  verification?: AgentStatus;
}

/** Vendor failures are interpreted by adapters; the shared UI only presents recovery actions. */
interface AgentRecovery {
  action: "login";
  label: string;
  statusText: string;
  message: string;
}

interface SupportImagePayload {
  name: string;
  mimeType: string;
  dataUrl: string;
}

interface SupportReportInput {
  occurredAt: string;
  description: string;
  screenshot?: SupportImagePayload;
  images: SupportImagePayload[];
}

interface DeveloperContactAttachment {
  name: string;
  mimeType: string;
  base64: string;
}

interface DeveloperContactInput {
  subject: string;
  content: string;
  replyTo: string;
  attachments?: DeveloperContactAttachment[];
}

interface DeveloperContactContext {
  appVersion: string;
  platform: string;
  arch: string;
  mode: StoreMode;
  /** Signed-in account; absent in standalone mode. OSS directories are split by it */
  userId?: string;
  /** This computer's identifier (terminals.fingerprint). Without an account, OSS directories are split by it */
  terminalId?: string;
}

interface DeveloperContactResult {
  contactId: string;
  status: "pending-send" | "sent";
  filePath: string;
  backgroundUpload: boolean;
}

/** Client update state, corresponding one-to-one with UpdateState in src/update/updater.ts */
interface AppUpdateInfo {
  version: string;
  url: string;
  sizeBytes?: number;
  sha256: string;
  signed: boolean;
  teamId?: string;
  /** Forced upgrade: a skipped version is mandatory; can't continue without upgrading to requiredVersion */
  mandatory: boolean;
  requiredVersion?: string;
  fullPackageRequired: boolean;
  /** This version is pushed only to the gray list */
  gray: boolean;
  notes?: string;
  releasedAt?: string;
}

/** required is filled in by the main process: the remembered forced-upgrade version (kept even offline); the UI blocks entirely based on it */
type AppUpdateState = { required?: string } & (
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date"; checkedAt: string }
  | { phase: "downloading"; update: AppUpdateInfo; receivedBytes: number; totalBytes?: number }
  | {
      phase: "ready";
      update: AppUpdateInfo;
      file: string;
      checkedAt: string;
      /**
       * Filled in by the main process: restart allows one-click restart to update; preparing is verifying the installer;
       * manual can only open the installer to install by hand (reason in installNote)
       */
      install?: "restart" | "preparing" | "manual";
      installNote?: string;
    }
  | { phase: "error"; message: string; checkedAt: string });

interface SupportUploadResult {
  target: "report" | "developer";
  file: string;
  ok: boolean;
  /** true means the backend rejects this content; moved to failed/ and won't be retried */
  permanent?: boolean;
  httpStatus?: number;
  error?: string;
  /** Backend receipt; includes the OSS address when an issue report succeeds */
  receipt?: unknown;
}

interface SupportLogArchive {
  name: string;
  /** base64 of the tar.gz. The backend decodes it and uploads to OSS; the desktop never touches OSS credentials */
  base64: string;
  fileCount: number;
  rawBytes: number;
  packedBytes: number;
}

interface SupportReportContext {
  appVersion: string;
  platform: string;
  arch: string;
  mode: StoreMode;
  /** Signed-in account; absent in standalone mode. OSS directories are split by it */
  userId?: string;
  /** This computer's identifier (terminals.fingerprint). Without an account, OSS directories are split by it */
  terminalId?: string;
  logs: Array<{
    name: string;
    content: string;
  }>;
  /** Archive of the full logs; absent if collection failed, which doesn't affect reporting */
  logArchive?: SupportLogArchive;
}

interface SupportReportResult {
  reportId: string;
  status: "pending-upload" | "uploaded";
  filePath: string;
  backgroundUpload: boolean;
}

interface AgentStatus {
  kind: AgentKind;
  /** Human-readable name, e.g. "Claude Code" */
  label: string;
  installed: boolean;
  executablePath?: string;
  version?: string;
  readiness: AgentReadiness;
  /** Diagnostic evidence: the CLI's own words or a detected path. A red light with no reason still leaves people not knowing what to do */
  detail?: string;
  recovery?: AgentRecovery;
  /** Install command given when not installed */
  installHint: string;
  /** Sign-in command given when not signed in */
  loginHint: string;
  /** Sign-out command available when signed in; not provided if the CLI doesn't support it */
  logoutHint?: string;
  docsUrl: string;
  /** Its userId, if already registered */
  userId?: string;
  /** Already added as a contact */
  added: boolean;
  /**
   * Specific description and action for the red light "vendor app installed, but the command line ADing can call isn't working yet".
   * When present, this row shows its message and actionLabel instead of the generic install command —
   * telling someone to npm install something they already installed is the most annoying prompt.
   */
  setupNotice?: AgentSetupNotice;
  /** Vendor desktop app installed but CLI not: show "CLI not installed", action is "Install CLI" */
  cliMissing?: boolean;
  displayName?: string;
  checkedAt?: string;
}

interface ConversationMember {
  resumeOnContinue?: boolean;
  userId: string;
  role: MemberRole;
  lastReadSeq: number;
  /** Agent input watermark, independent of the human chat read receipt. */
  lastProcessedSeq?: number;
  /** First unread message that @-mentions this human, for notification; empty if none */
  firstUnreadMentionSeq?: number;
  /** Pause scheduling of this Agent only in the current task; doesn't affect its participation in other tasks. */
  paused?: boolean;
  /** A shared Agent paused by its owner: other humans can't send messages; only the owner can resume. */
  ownerPaused?: boolean;
}

/**
 * Workspace — what conversations belong to, and the unit for sharing skills and facts.
 *
 * Why it exists: workspace-level shared knowledge only holds if conversations in the same workspace
 * **are about the same thing**. "This project uses RocketMQ" holds for every conversation under ading,
 * but is wrong for another project. So the sharing scope needs an explicit anchor, not a guess from directory paths.
 *
 * There are only two kinds; the difference isn't in fields but in semantics:
 *   folder  a proper workspace bound to a directory. Has shared skills and facts.
 *   inbox   "Scratch" — something for an agent to do quickly that belongs to no project.
 *           Exactly one globally, can't be deleted, always last in the list.
 *
 * inbox deliberately **has no** shared fact pool: two scratch conversations are unrelated,
 * and injecting A's facts into B is exactly the "different tasks must never cross-talk" problem to prevent.
 * What's learned in scratch conversations survives only if a person explicitly promotes it to a "global skill" or "about me" when archiving.
 */
type WorkspaceKind = "folder" | "inbox";

interface Workspace {
  workspaceId: string;
  name: string;
  /** Required for folder; empty for inbox, where each conversation uses its own temporary directory */
  path?: string;
  kind: WorkspaceKind;
  createdAt: string;
  updatedAt: string;
}

/**
 * Group charter: for the leader to "steer direction", there must first be a written direction to check against.
 * Without it, the leader can only judge drift by feel, and rulings by feel can't convince anyone or be reproduced.
 * This is configuration a person sets, not automatically captured memory — the two are deliberately stored separately.
 */
interface Charter {
  instructions?: string;
  /** What this conversation should achieve */
  goal?: string;
  /** Discussion boundary; going beyond it counts as drifting off topic */
  boundary?: string;
  /** What counts as done */
  doneWhen?: string;
}

type ConversationStatus = "ACTIVE" | "DONE" | "ARCHIVED";

/**
 * Task — **a conversation**, with granularity "one piece of work", not "a chat window with someone".
 *
 * This differs from ordinary chat tools: with the same agent, or the same group of agents,
 * several conversations can be open at once, one per piece of work. The granularity matches the agent's own session.
 *
 * Two hard constraints follow:
 *   1. No "one direct chat per agent" idempotency — that would squeeze multiple pieces of work into one window
 *   2. A task has only one persistent context ledger; each Agent's sequential turns reuse its own
 *      provider thread, concurrent work may only branch from this task's context, and results must be written back to the same ledger.
 */
interface WorkItem {
  id: string;
  assignment: string;
  /** Candidates sorted by capability fit; selection among them is by idle / completed duration only. */
  candidates: string[];
  dependsOn: string[];
  outputs: string[];
  acceptance: string;
  /** Don't modify the work-scope requirements of the original being checked; independent reports are allowed, tool approval is handled by global policy. */
  readOnly: boolean;
  /** Exact method and scope were already reviewed by this assignee in the task brainstorm. */
  preAgreed?: boolean;
  /** Scheduler-set continuation after a Leader stopped and corrected this exact work. */
  resumeAfterInterrupt?: boolean;
  /** Number of Leader-directed restarts of this logical work item. */
  interventions?: number;
  status: "queued" | "active" | "review" | "done" | "blocked";
  assigneeId?: string;
  assignmentId?: string;
  evidence?: string;
  startedAt?: string;
  completedAt?: string;
}

interface BrainstormState {
  phase: "frame" | "ideas" | "synthesize" | "review" | "decide" | "probe" | "ready" | "waiting";
  revision: number;
  round: number;
  probes: number;
  afterProbe?: "ideas" | "synthesize";
  attempts: number;
  leaderId: string;
  inputSeq: number;
  participants: string[];
  responses: Record<string, { ok: boolean; control?: LeaderControl; reason?: string; durationMs?: number }>;
  /** Per-agent provider time observed in this task's discussion only. */
  turnDurationsMs?: Record<string, number[]>;
  /** Leader already completed the parallel read-only evidence pass for this revision. */
  evidenceReady?: boolean;
  /** Detect repeated requests that add no new issue; this is not a round limit. */
  lastRevisionReason?: string;
  stalledRevisions?: number;
  /** Peers that explicitly confirmed the latest reviewed concrete method. */
  confirmedParticipants?: string[];
  reason?: string;
}

interface Conversation {
  /** Account-specific read-only view of a shared Agent conversation. */
  shared?: boolean;
  permanent?: boolean;
  brainstorm?: BrainstormState;
  /** Quick creation: awaiting a semantic name from the first responding agent. */
  autoTitle?: boolean;
  followUp?: { fingerprint: string; attempts: number; state: "retrying" | "blocked"; reason: string };
  workPlan?: WorkItem[];
  conversationId: string;
  type: ConversationType;
  /** Conversation name. Every type has one; a direct chat is also a conversation */
  name?: string;
  /**
   * The owning workspace. **Never empty** — conversations belonging to no project go into the inbox workspace
   * instead of null. That way "resolving the scope of skills and memories" is always one path with no branches.
   */
  workspaceId: string;
  creator: string;
  owner: string;
  /** Per-conversation message sequence generator. Maintained by LocalStore in standalone, by conductor online */
  lastSeq: number;
  lastMessage?: Message;
  members: ConversationMember[];
  /**
   * Overrides the directory the agent works in. When empty it's resolved from the workspace:
   * folder uses the workspace's own directory, inbox uses this conversation's dedicated temporary directory under "Scratch".
   * Only set it when a conversation should run in a subdirectory.
   */
  workspacePath?: string;
  charter?: Charter;
  /**
   * Stable identifier carried when created from a "task order".
   * It's what makes "running the same task order ten times creates only one conversation" possible —
   * deduping by name would create duplicates after the user renames it.
   */
  seedKey?: string;
  status: ConversationStatus;
  /**
   * A person's veto. While paused the orchestrator doesn't trigger any agent turns —
   * it's a second entry point to the same mechanism as the leader's stop, and the person's overrides the leader's.
   */
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Message {
  /** Scheduler context and diagnostics; shown in the process feed, never as chat. */
  internal?: boolean;
  /** Original provider reply and input watermark, retained even when a control is rejected. */
  agentReply?: { turnId: string; inputSeq: number; raw: string; newerInput: boolean; lane?: "inbox" | "brainstorm" };
  coordination?: {
    workId?: string;
    /** Don't modify the original being checked; not a tool-disable switch. */
    readOnly?: boolean;
    protocolAttempts?: number;
    id: string;
    assigneeId: string;
    phase: "proposal" | "accepted" | "revision" | "result" | "rejected";
    brief: string;
  };
  messageId: string;
  conversationId: string;
  /** Monotonically increasing with no gaps within a conversation. Clients detect lost messages via seq === local max + 1 */
  seq: number;
  senderId: string;
  content: string;
  type: MessageType;
  /** userIds that were @-mentioned */
  mentions: string[];
  replyTo?: string;
  /** Snapshot of the original message kept when replying: shown even if the original isn't in the loaded history */
  quote?: MessageQuote;
  status: MessageStatus;
  /** What the agent actually did this turn. In collaboration this matters more than the conclusion and is the basis for mutual review */
  steps?: string[];
  /** Generated by the task Leader in response to the "Report" button; used to prevent consecutive duplicate reports. */
  report?: boolean;
  failed?: boolean;
  /** Images, videos, files. Only metadata; files are in the local attachments directory (also in OSS online), looked up by attachmentId */
  attachments?: Attachment[];
  createdAt: string;
}

interface MessageQuote {
  senderId: string;
  /** One-line preview, already truncated */
  text: string;
}

type AttachmentKind = "image" | "video" | "file";

/** Result of picking files: those copied into the attachments directory, and those not accepted (too large, not a file, etc.) */
interface AttachmentImport {
  attachments: Attachment[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Message attachment. attachmentId is generated by the sending side; the same one is used across standalone and online, phone and computer.
 * The file itself isn't put in the message: standalone keeps it in the local attachments directory, online also uploads it to OSS, and other devices download on demand.
 */
interface Attachment {
  attachmentId: string;
  /** Original file name, used for display and saving */
  name: string;
  mimeType: string;
  /** Size in bytes */
  size: number;
  kind: AttachmentKind;
}

/**
 * An agent's CLI resume token in a conversation.
 * The unique key is (conversationId, agentUserId) — each conversation has its own thread, never shared,
 * otherwise what's said in group A would leak into group B.
 */
interface AgentRuntimeSettings {
  /** Native context capacity metadata; never an argument that changes vendor configuration. */
  contextWindowTokens?: number;
  model?: string;
  reasoningEffort?: string;
  /** undefined inherits native settings; false explicitly disables Fast. */
  fastMode?: boolean;
  serviceTier?: string;
  source?: string;
  notice?: string;
  /**
   * True when these values were observed in a provider response rather than
   * chosen by the user. An observed snapshot says what actually ran, so it may
   * be displayed and stored, but it must never be sent back as an argument of a
   * later turn: doing so freezes whatever default the vendor CLI happened to
   * pick and silently overrides the selection the user keeps in its own app.
   */
  observed?: boolean;
}

/** A selectable model. Missing efforts or supportsFast means the vendor didn't provide them, not that they're unsupported. */
interface AgentModelOption {
  /** Model identifier passed to the CLI */
  id: string;
  label: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  supportsFast?: boolean;
}

interface AgentModelCatalog {
  /** This Agent's model can be set: it's on this computer or another computer of the same account, and its CLI can list models */
  supported: boolean;
  models: AgentModelOption[];
  /** Model the user chose in ADing; absent means follow the original app */
  selected?: string;
  /** Display name of selected when the list can't be read */
  selectedLabel?: string;
  /** Host computer is offline: show the current value only */
  readOnly?: boolean;
  /** The original app's current model */
  nativeModel?: string;
  error?: string;
}

interface AgentSessionRef {
  /** Semantic exclusions applied when this provider transcript was built. */
  groupContext?: { anchorSeq: number; excludedSeqs: number[] };
  runtimeConfig?: AgentRuntimeSettings;
  /** The provider thread's running token total after the last turn, to tell what the next turn alone used. */
  tokenUsageTotal?: TurnMetrics["tokenUsage"];
  parallelTools?: boolean;
  /**
   * Contract version of the shared child-task channel this thread was built
   * under. Recorded on every save, including turns that offer no child-task
   * channel: a missing value has to mean "written by an older build", never
   * "the last turn happened not to need the tool", or a task alternating
   * between negotiation and execution rebuilds its thread every round.
   */
  parallelToolsVersion?: number;
  knowledgeToolsVersion?: number;
  /**
   * Digest of the collaboration protocol already delivered into this provider
   * thread. The protocol is thousands of tokens and does not change between
   * turns, so it is sent once per thread and only re-sent when it actually
   * differs - the same watermark pattern as memorySyncedAt below.
   */
  protocolDigest?: string;
  /** Digests of every protocol section this provider thread has already received. */
  protocolDigests?: string[];
  /** Which plan and assignment entries this provider thread already has. */
  deliveredState?: { plan?: { items: Record<string, string>; turns: number }; board?: { items: Record<string, string>; turns: number } };
  /** How many top-level provider threads this task has spent on this Agent. */
  providerThreadGeneration?: number;
  recovery?: { attempts: number; state: "retrying" | "blocked"; error: string; freshContext: boolean };
  conversationId: string;
  agentUserId: string;
  providerThreadId?: string;
  /** Last task-message sequence already present in this provider thread. */
  messageSyncedSeq?: number;
  workspacePath?: string;
  /**
   * Watermark for memory injection.
   *
   * A full snapshot is injected when the thread is created; afterwards each turn injects only items added after this time —
   * the same pattern as lastReadSeq for messages.
   * With full injection every turn, codex's thread keeps all history and the same memory text would pile up dozens of times.
   */
  memorySyncedAt?: string;
  /** Whether this provider transcript was created without personal memory. */
  memoryIsolated?: boolean;
}

// ---------------------------------------------------------------------------
// Skill / Memory
// ---------------------------------------------------------------------------

/**
 * Scope a skill belongs to. Only two levels — the agent's own mechanisms have no "conversation-level" concept,
 * and forcing it would rely on prompt injection, back to fighting the agent.
 * Besides, a skill is "how to do things" and shouldn't vary by conversation; conversation-level things belong to memory.
 *
 *   workspace  shared under a project directory, written to that directory's rules file
 *   global     global for this computer / account, written to the agent's user-level rules file
 */
type Scope = "workspace" | "global";

interface ScopeRef {
  scope: Scope;
  /**
   * For workspace it's the workspaceId, **not the directory path**.
   * Using a path as the anchor couldn't distinguish "two workspaces in the same directory",
   * and would lose a whole layer of skills after the user moves the directory.
   */
  ownerId?: string;
}

/** Who established this skill. Determines whether it can be auto-updated */
type SkillAuthorKind = "human" | "agent";

interface Skill {
  skillId: string;
  name: string;
  /** Claude Code uses it to decide when to trigger; in codex it's a subheading */
  description: string;
  scope: Scope;
  ownerId?: string;
  /** Markdown body */
  content: string;
  /** The validated central package is authoritative; replicas must retain every file. */
  source?: SkillPackageSource;
  /** Stable native directory name; imported package names remain recognizable. */
  directoryName?: string;
  enabled: boolean;
  /**
   * Principle: auto-created ones may be auto-updated; human-created ones need a human to start an update.
   * Agents may still propose changes to human-established skills, but those always go to the human queue.
   */
  authorKind: SkillAuthorKind;
  /** When established by an agent, records which agent, for traceability */
  authorUserId?: string;
  /** Empty = distributed to all agents */
  targets?: AgentKind[];
  /** Hit count, so auto skills nobody uses for a long time naturally retire */
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SkillPackageSource {
  directory: string;
  fingerprint: string;
  files: Array<{ path: string; size: number; sha256: string; mode?: number }>;
}

// ---------------------------------------------------------------------------
// Skill proposals and peer review
// ---------------------------------------------------------------------------

type ProposalKind = "create" | "update";

type ProposalState =
  /** Waiting for other agents in the conversation to vote */
  | "reviewing"
  /** Unanimously approved, written to the shared library */
  | "applied"
  /** Someone objected, or no agent can vote; awaiting a human decision */
  | "needs_human"
  /** Rejected by a human */
  | "rejected";

/**
 * pass    no substantive problem found; can be included
 * blocked problems found; needs a human decision
 * unclear reply can't be parsed — counts as neither approval nor objection; left to a human to read the original
 */
type ReviewVerdict = "pass" | "blocked" | "unclear";

interface SkillReview {
  reviewerUserId: string;
  verdict: ReviewVerdict;
  /** Specific problems found. An empty array means it thinks it can be included */
  problems: string[];
  /** If it's only a wording problem, the reviewer's suggested rewrite */
  suggestion?: string;
  /** What it actually said in the group */
  raw: string;
  reviewedAt: string;
}

/**
 * A proposal pending entry into the shared library.
 *
 * Flow: an agent finishes a turn meeting the threshold → a proposal is captured → other agents in the conversation each vote
 *   unanimous agree              → written and distributed automatically
 *   any object / no one can vote → needs_human, with a system message posted in the group awaiting a human decision
 */
interface SkillProposal {
  proposalId: string;
  kind: ProposalKind;
  /** For update, points to the skill being changed */
  targetSkillId?: string;
  proposerUserId: string;
  conversationId: string;

  name: string;
  description: string;
  scope: Scope;
  ownerId?: string;
  content: string;
  targets?: AgentKind[];

  /** seq range of the messages that triggered this capture, as evidence for review */
  evidenceFromSeq: number;
  evidenceToSeq: number;
  /** What the agent actually did this turn */
  evidenceSteps: string[];

  state: ProposalState;
  reviews: SkillReview[];
  /** One-sentence explanation shown to people when needs_human */
  blockedReason?: string;
  createdAt: string;
  resolvedAt?: string;
}

/**
 * LEADER control directives.
 *
 * Just writing "you are the leader and may interrupt" in the prompt isn't enough — the agent will dutifully say
 * "I suggest we stop here", but that's just a message with no force, and others keep talking.
 * To really steer, its output must be able to change system state, so it gets a set of structured directives
 * that the orchestrator actually executes when it reads them.
 */
type LeaderAction = "interrupt" | "brainstorm" | "batch" | "plan" | "review" | "organize" | "stop" | "assign" | "refocus" | "accept" | "revise" | "blocked";

interface LeaderControl {
  action: LeaderAction;
  decision?: "revise" | "ask" | "probe" | "agree";
  /** One decision can review multiple deliveries and schedule the next batch. No nesting. */
  actions?: LeaderControl[];
  work?: Pick<WorkItem, "id" | "assignment" | "candidates" | "dependsOn" | "outputs" | "acceptance" | "readOnly" | "preAgreed">[];
  workId?: string;
  verdict?: "pass" | "retry";
  evidence?: string;
  assignmentId?: string;
  assignments?: { to: string; assignment: string }[];
  /** Member userId named for assign */
  to?: string;
  /** Work assigned for assign. Deliberately not called task — Task is already the "a conversation" entity */
  assignment?: string;
  /** New topic for refocus */
  topic?: string;
  reason?: string;
}

/** Threshold for automatic capture. Below it, the agent is never even asked "anything worth recording?" */
interface CaptureThreshold {
  /** codex item.completed count, approximating OpenClaw's "model iteration count" */
  minIterations: number;
  /** This turn must have run commands or changed files; pure chat isn't captured */
  requireSideEffects: boolean;
}

/**
 * Three layers of memory, each anchored to something that really exists in the product:
 *   user          about the person — across all conversations, written only by the person; agents may not write
 *   workspace     facts about this project — shared by all conversations in this workspace; agents may capture automatically
 *   task  facts and decisions in this conversation — only in this conversation
 *
 * The workspace layer applies only to folder workspaces. inbox (Scratch) has no shared fact pool,
 * because its conversations are unrelated and sharing would cross-contaminate them.
 *
 * All three layers are injected incrementally, using the AgentSessionRef.memorySyncedAt watermark.
 */
type MemoryScope = "user" | "workspace" | "conversation";

interface MemoryEntry {
  updatedAt?: string;
  memoryId: string;
  scope: MemoryScope;
  /** userId for user; workspaceId for workspace; conversationId for conversation */
  ownerId: string;
  content: string;
  /** Who recorded it. Human-recorded and agent-captured must be distinguishable */
  authorKind: SkillAuthorKind;
  authorUserId?: string;
  /** Which message it was captured from, for traceability and undo */
  sourceMessageId?: string;
  /** Pinned memories are always injected, not subject to the "most recent N only" limit */
  pinned: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Store change events
// ---------------------------------------------------------------------------

type StoreEvent =
  | { type: "message"; conversationId: string; message: Message }
  | { type: "message-times"; conversationId: string; times: { messageId: string; createdAt: string }[] }
  | { type: "message-delivery"; conversationId: string; messageId: string; status: MessageStatus }
  | { type: "conversation"; conversationId: string }
  | { type: "contacts" }
  /** Online mode: friend requests changed (new request received, accepted, or withdrawn) */
  | { type: "friends" }
  | { type: "agents" }
  | { type: "workspaces" }
  | { type: "skills" }
  | { type: "proposals" }
  | { type: "memories"; scope: MemoryScope; ownerId: string }
  | { type: "connection"; online: boolean };

// ---------------------------------------------------------------------------
// Local agent discovery results (shape before registration into Store)
// ---------------------------------------------------------------------------

interface DiscoveredAgent {
  runtimeDefaults?: AgentRuntimeSettings;
  localUuid: string;
  kind: AgentKind;
  name: string;
  version: string;
  executablePath: string;
  nodeName: string;
}

/** Vendor app discovered, but local capabilities ADing can call are still missing */
interface AgentSetupNotice {
  kind: AgentKind;
  name: string;
  message: string;
  actionLabel: string;
}

/** How much ran this turn and whether it touched the outside world. Used to judge whether a skill is worth capturing */
interface TurnMetrics {
  /** Number of completed items, approximating "model iteration count" */
  iterations: number;
  /** Ran commands or changed files */
  sideEffects: boolean;
  /** Provider-reported usage for this ADing turn, including ephemeral child contexts. */
  tokenUsage?: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
  /** Cost for providers that bill in credits and report token counts as zero. */
  providerCredits?: {
    /** Charged to the account. */
    spent: number;
    /** Before any plan discount, so the discount stays visible. */
    listPrice: number;
  };
  /** Highest share of the context window this turn reached, 0-1. Near 1 means
   * the run was about to pay for a compaction round. */
  contextUsagePeak?: number;
}

/** Result of one agent turn */
type AgentTurnOutcome =
  | {
      ok: true;
      threadId: string;
      message: string;
      steps: string[];
      metrics: TurnMetrics;
      /** clientMessageIds of steering input the provider echoed into this turn's
       * model input before the final reply. Accepted-but-unechoed steers are absent. */
      steersSeen?: string[];
    }
  | {
      ok: false;
      /** Visible provider text retained after an interrupted turn; never execute its control. */
      partialMessage?: string;
      threadId?: string;
      error: string;
      /** Availability changed before any provider execution; the scheduler may defer pending checks. */
      notStarted?: "agent-unavailable";
      /** The smallest request still overflowed; rebuilding cannot help. */
      contextBudgetExhausted?: boolean;
      steps: string[];
      cancelled: boolean;
      metrics: TurnMetrics;
    };
