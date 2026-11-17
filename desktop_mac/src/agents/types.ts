import type { SkillTarget } from "../skills/target";

export type AgentRuntimeConfig = AgentRuntimeSettings;

export interface ToolPermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  blockedPath?: string;
  reason?: string;
  workspacePath?: string;
  signal: AbortSignal;
}

/**
 * AgentAdapter - abstracts "one agent turn" away from any specific CLI.
 *
 * Previously codex's path probing, command-line flags, JSONL parsing and event translation were scattered across main.ts,
 * so adding a second agent meant changing five places. With the interface, adding Claude Code is just one new file.
 *
 * This layer is **identical** in the standalone and online editions - the agent always runs locally,
 * reading local files and using local macOS permissions, which can't and shouldn't cross the network.
 */
export interface TurnInput {
  /** Keep the provider input channel open so human messages can steer this same top-level turn. */
  steerable?: boolean;
  /** Permission policy snapshot for this turn. Unattended execution can use the provider's native fast path. */
  permissionMode?: PermissionMode;
  /** Reserved app-level override, before native defaults. No settings UI required. */
  appRuntimeConfig?: AgentRuntimeConfig;
  /** Shared execution capacity of a task/Agent, independent of other tasks. */
  parallelWork?: {
    key:string;
    /** Maximum concurrent ephemeral child-task lanes. */
    limit:number;
    executionSlot:boolean;
    allowSplit:boolean;
    planBeforeExecution?:boolean;
    /** Parent plus ephemeral child contexts; only the parent is persisted as the task session. */
    sessionBudget?:number;
  };
  onParallelWork?: (args:unknown,signal:AbortSignal)=>Promise<unknown>;
  /** Shared central knowledge service; inherited by every execution sub-lane. */
  onKnowledgeTool?: (name:string,args:unknown,signal:AbortSignal)=>Promise<unknown>;
  /** Refresh native skills immediately before each top-level or child turn; returns the central skill files. */
  refreshKnowledge?: ()=>Promise<string[]>;
  hasPendingWork?: ()=>boolean;
  canStartWork?: ()=>boolean;
  onWorkFailure?: (error:string)=>Promise<void>;
  /** Negotiation / discussion turn: tools disabled; execution only happens in a separate turn after agreement. */
  discussionOnly?: boolean;
  /** Independent inbox: suppress expensive tools and external extensions. */
  communicationOnly?: boolean;
  isolateMemory?: boolean;
  /** ADing's own background maintenance turn: full tools, but no computer-control channel. */
  noComputerTools?: boolean;
  /** This turn leaves no session record and doesn't appear in the Agent's own history. Only for background tasks that needn't be continued */
  noSessionPersistence?: boolean;
  /** Set by the adapter after checking --help: this CLI build lacks the flag, so passing it would abort the turn. */
  noPersistFlagMissing?: boolean;
  /** Effective native configuration shared by all work lanes of a task. */
  runtimeConfig?: AgentRuntimeConfig;
  onRuntimeConfig?: (snapshot: AgentRuntimeConfig) => void;
  signal?: AbortSignal;
  /** Installed only in real execution turns; negotiation turns still disable tools entirely. */
  onPermission?: (request: ToolPermissionRequest) => Promise<boolean>;
  timeoutMs?: number;
  /** The fully assembled prompt (identity + incremental context + instructions). Used by adapters that don't support split delivery */
  prompt: string;
  /** Chronological complete messages, used to discard oldest history without cutting the latest request. */
  contextMessages?: string[];
  /**
   * Split-delivery version of the same content: app is ADing's own generated instructions, conversation is the conversation content.
   *
   * When the vendor supports it (Codex's app-server has developerInstructions), app goes into the system instruction channel
   * and only conversation is this turn's input - so in the vendor's own UI the user sees what they actually said,
   * not a big block of scaffolding assembled by ADing. The concatenation order matches prompt; both paths carry identical content.
   */
  split?: { app: string; dialogue: string };
  /** Continuation token from the previous turn; empty means a new session */
  threadId?: string;
  /** Directory the agent works in */
  workspacePath: string;
  /** Whether this is an execution turn with full tool access; with onPermission each item still needs approval. Unrelated to the assignment's readOnly. */
  fullAccess: boolean;
  /** Progress callback for live display like "Running command: ..." */
  onProgress: (text: string) => void;
  onAudit?: (event: {id?: string; kind: string; phase: string; failed?: boolean; parallelWorkId?:string}) => void;
}

/** Result of one minimal call, used to decide the light color */
export interface VerifyResult {
  ok: boolean;
  /** What the CLI said on failure. That exact text is the human-readable diagnostic */
  text: string;
  /** The adapter itself established that the CLI is signed out. A stable
   * signal that does not depend on matching the (localized) text. */
  signedOut?: boolean;
  recovery?: AgentRecovery;
}

export interface SteerInput {
  content:string;
  clientMessageId?:string;
}

export type SteerResult =
  | {status:"accepted"}
  | {status:"not-ready"|"unsupported"|"failed";error?:string};

export interface AgentAdapter {
  initializeConfiguration(agent:DiscoveredAgent,workspacePath:string,app?:AgentRuntimeConfig):Promise<AgentRuntimeConfig>;
  readonly supportsParallelWork?: boolean;
  /** Token usage in a turn's metrics is the running total of the provider thread, not this turn alone. */
  readonly cumulativeTokenUsage?: boolean;
  readonly kind: AgentKind;
  /** Human-readable name, e.g. "Claude Code" */
  readonly label: string;
  /** Install command shown when not installed */
  readonly installHint: string;
  /** Login command shown when not logged in */
  readonly loginHint: string;
  /** Logout command available when logged in; omitted if the CLI doesn't support it */
  readonly logoutHint?: string;
  readonly docsUrl: string;

  /**
   * Connectivity check: actually sends one minimal call, read-only, with a hard timeout.
   *
   * Why not read each vendor's credential files to decide login state: their locations and formats are undocumented,
   * and guessing wrong gives a wrong diagnosis. Ask the CLI itself; whatever it reports is the answer.
   */
  verify(agent: DiscoveredAgent, app?: AgentRuntimeConfig): Promise<VerifyResult>;

  /**
   * Ask one thing, get one answer, leave no trace: the same channel as the connectivity check (no tools, no extensions, session not persisted),
   * just with a different question. Used for internal calls like task naming that "shouldn't appear in the user's session history".
   */
  askOnce(agent: DiscoveredAgent, prompt: string): Promise<VerifyResult>;
  /** Asks the CLI which models the current account can use, without a model request. Vendors that can't list them don't implement this. */
  listModels?(agent: DiscoveredAgent): Promise<AgentModelOption[]>;
  /** Only the provider adapter recognizes its own official sign-in URL. */
  loginAuthorizationUrl?(line: string): string | undefined;

  /**
   * Probes where this agent's skills land for the given scope.
   * Returns null if it can't be found (directory missing or not writable) - never write to a guessed path.
   */
  resolveSkillTarget(
    scope: Scope,
    workspacePath: string
  ): Promise<SkillTarget | null>;

  /** Renders a shared-library skill into this vendor's shape and writes it. Returns the paths actually written */
  syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]>;

  /** Revoke: removes what ADing wrote, leaving the user's own content untouched */
  unsyncSkills(target: SkillTarget): Promise<string[]>;

  /** Finds this kind of agent on this machine; returns an empty array if none */
  discover(): Promise<DiscoveredAgent[]>;

  /** When the last discover found no usable CLI, why the files found won't run (for the Agent page hover tooltip) */
  lastDiscoveryFailure?(): string | undefined;

  /** The vendor desktop app (or its launcher stub) is present but there is no usable CLI - the UI shows "CLI not installed" based on this */
  vendorAppInstalled?(): Promise<boolean>;

  /** When the desktop app is found but can't be called yet, gives the user an actionable next step */
  setupNotice?(): Promise<AgentSetupNotice | null>;

  /** Runs one turn. Contract: never throws; on failure still hands back any threadId obtained */
  runTurn(agent: DiscoveredAgent, input: TurnInput): Promise<AgentTurnOutcome>;

  /** Passes new human input to the same still-running vendor session; must not start a new top-level session. */
  steer?(localUuid:string,input:SteerInput):Promise<SteerResult>;

  /** Stops the running task. Returns whether anything was actually stopped */
  cancel(localUuid: string): boolean;

  /** Whether this agent currently has a task running */
  isBusy(localUuid: string): boolean;

  /** Agents that currently have tasks running. Used to clean up child processes on app exit */
  busyIds(): string[];

  /** Waits until child processes actually exit; returns agents still running at the deadline. Must be awaited before exit and update */
  waitForExit(timeoutMs: number): Promise<string[]>;
}
