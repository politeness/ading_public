import { requireConversationWriter, requireConversationController } from "./permissions/conversation-write";
import { LinkPreviews } from "./links/preview";
import {SkillFallback} from "./knowledge/skill-fallback";
import { AppUnread, windowCanRead } from "./notifications/unread";
import { bestEffortSync } from "./knowledge/sync-failure";
import path from "node:path";
import { ACCESS_DENIED, collectAccessDiagnostics } from "./support/access-diagnostics";
import { mkdir, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  shell,
  type IpcMainInvokeEvent
} from "electron";
import { pathToFileURL } from "node:url";
import { isAttachmentId, MAX_ATTACHMENTS } from "./store/attachments";
import { PermissionGrants } from "./permissions/grants";
import { loadMainLanguage, setMainLanguage, tm } from "./i18n";
import { PermissionDialogs } from "./permissions/dialog";
import {resolveRuntimeConfig} from "./agents/runtime-config";
import { PermissionPolicy } from "./permissions/policy";
import { createLeaderPermissionReviewer } from "./permissions/leader-review";
import { ProbeSession } from "./agents/probe-session";
import { AgentRegistry } from "./agents/registry";
import { prepareCliEnvironment } from "./agents/runtime-environment";
import { canAgentParticipate, classifyReadiness } from "./agents/readiness";
import {
  describeError as describeForLog,
  log,
  startLog,
  supportLogArchive,
  supportLogSnapshots
} from "./orchestration/diagnostics";
import { applySeed, isSeedDoc, type AgentsByKind } from "./orchestration/seed";
import { ConversationScheduler } from "./orchestration/conversation-scheduler";
import { MessageDelivery, shouldDispatchRemoteUserMessage, shouldDispatchRemoteAgentMessage } from "./orchestration/message-delivery";
import {missingOutputs} from "./agents/parallel-work";
import {
  resolveWorkspace,
  resolveArtifactPath,
  type WorkspaceResolution
} from "./orchestration/workspace";
import { SkillCapture } from "./skills/capture";
import { SkillSyncer } from "./skills/sync";
import {KnowledgeService,KnowledgeRemovalRecordError} from "./knowledge/service";
import {MemoryNotifier} from "./knowledge/memory-notify";
import {KnowledgeCloudSync} from "./knowledge/cloud-sync";
import {configureContextWindowCache} from "./agents/context-window-cache";
import {AgentModelCache} from "./agents/model-cache";
import {AgentModels} from "./agents/agent-models";
import { LocalStore } from "./store/local";
import { newId } from "./store/ids";
import type { CreateConversationInput, Store } from "./store/store";
import { SupportReportQueue } from "./support/report";
import { apiBaseUrl, resolveSupportEndpoints } from "./support/endpoints";
import { AccountSession, type AccountResult } from "./account/session";
import { machineIdentity } from "./account/machine";
import type { ComputerRegistration } from "./account/session";
import { CloudStore } from "./store/cloud";
import { CloudPush } from "./store/cloud-push";
import { ConversationControl, controlLocalThenRemote, executeConversationControl, type ConversationAction } from "./store/conversation-control";
import { AgentModelRelay } from "./store/agent-model-relay";
import { CloudReconciler } from "./store/cloud-reconciler";
import { SleepGuard } from "./platform/sleep-guard";
import { readPreferences, writePreference } from "./platform/preferences";
import { AccountProfiles } from "./account/profiles";
import { describeRelease } from "./shared/release";
import { DeveloperContactQueue } from "./support/developer";
import { AppUpdater, postAnonymous, UPDATE_CHECK_ROUTE, type UpdateCheckBody, type CheckResult } from "./update/updater";
import { compareVersions, isValidVersion } from "./update/version";
import { appBundleOf, installBlocker, launchInstaller, removeTree, rollbackBundle, stageUpdate } from "./update/installer";
import { recoverMisplacedLogs } from "./support/log-recovery";
import { defaultAgentName } from "./agents/default-names";
import { buildTelemetryBody, describeTelemetry, ForegroundTelemetry, postTelemetryAnonymously, TELEMETRY_ROUTE, type TelemetryResult } from "./support/telemetry";
import { AttachmentSaveDirectory, saveAttachmentFile } from "./support/save-attachment";
import { AUTOMATION_TARGETS, checkComputerPermissions, onComputerPermissionMissing, onComputerToolLog, requestAutomation, requestComputerPermission, type ComputerPermissionKind } from "./agents/computer-tools";
import { setClientVersion } from "./agents/client-info";
import { CLOUD_AGENT_TYPE } from "./store/cloud-agent-type";
import { RemoteRuntime, RuntimeUplink, type RuntimeEvent } from "./store/runtime-relay";
import { HEALTHY_AFTER_MS, releaseKey, UpdateHealth } from "./update/health";
import { p } from "./prompt-language";

/**
 * Electron main process.
 *
 * It does only three things: open windows, assemble runtime dependencies, and wire IPC to app modules.
 * Conversation scheduling lives in LocalScheduler, and all data reads/writes go through the Store interface; the main process no longer carries
 * business rules such as who speaks next, how prompts are assembled, or how group chats hand off.
 */

/**
 * Headless mode (`pnpm headless`).
 *
 * The app must keep working when nobody is at the computer: no windows, discover Agents on startup,
 * apply the task sheet, and watch it for changes — add a conversation to .ading/seed.json
 * and it starts on its own.
 *
 * This works because the orchestration layer is plain Node; only the window layer depends on Electron.
 *
 * One hard rule: this mode **never opens any window**. Task turns run directly just like in desktop mode;
 * stopping is handled by task state and process cancellation.
 */
const HEADLESS = process.argv.includes("--headless");

/**
 * URL used to show images and play videos in chat: ading-attachment://file/<conversationId>/<attachmentId>/<fileName>.
 * Only files inside the attachments directory can be read; in the online edition, files missing locally (sent from a phone) are downloaded first.
 * Must be declared before app ready so videos can play while downloading (stream).
 */
const ATTACHMENT_SCHEME = "ading-attachment";
protocol.registerSchemesAsPrivileged([
  { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
]);

async function serveAttachment(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const [conversationId = "", attachmentId = "", name = ""] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.host !== "file" || !isAttachmentId(attachmentId) || !name) return new Response(null, { status: 400 });
    const file = await store.attachmentFile(conversationId === "_" ? "" : conversationId, { attachmentId, name });
    return await net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
  } catch (error) {
    void log("attachment-serve-failed", { url: request.url, error: describeForLog(error) });
    return new Response(null, { status: 404 });
  }
}

/** Reads the package.json bundled into the app: channel and build time are written there */
function appManifest(): { adingChannel?: string; adingBuildTime?: string; adingApiBaseUrl?: string } {
  try {
    return JSON.parse(
      readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")
    ) as { adingChannel?: string; adingBuildTime?: string; adingApiBaseUrl?: string };
  } catch {
    return {};
  }
}

/**
 * An unhandled promise rejection must not take down the whole app.
 *
 * Since Node 15 it is fatal by default and the process exits. The ADing main process has a lot of "fire and forget"
 * background work (task naming, analytics, log archiving, pending-sync queue); if any of them misses a catch, the user's running
 * agent turn disappears along with the app, and **nothing is left in the logs**, so reports can't explain why.
 * Catch it here and log it: background failures should not interrupt foreground tasks.
 *
 * uncaughtException is deliberately not handled: such errors often leave state untrustworthy, continuing is more dangerous than exiting,
 * and Electron shows its own error dialog to the user.
 */
process.on("unhandledRejection", (reason) => {
  void log("unhandled-rejection", { error: describeForLog(reason) });
});

// The version reported in vendor handshakes follows the actually running version, not hard-coded (see agents/client-info.ts)
setClientVersion(app.getVersion());

// In dev, Electron shows the app as "Electron" by default; packaged builds use productName. Both launch modes are unified here.
// This name also determines the userData directory (~/Library/Application Support/ADing), so:
//   1. Use ASCII, not Chinese — paths containing Chinese get garbled when inherited via open / LaunchServices,
//      and logs were once written into a garbled directory because of it (see support/log-recovery.ts); ASCII avoids this class of problem at the root.
//   2. Don't follow the UI language — otherwise every language switch would move the data directory.
//   3. Use a different name for the dev build (ADing Dev) — the data directory is separated too, so test tasks created during development don't land in
//      the data in daily use, and both versions can be installed and open at the same time. Channel detection and describeRelease below
//      use the same source.
const channel = process.env.ADING_CHANNEL ?? appManifest().adingChannel;
app.setName(channel === "develop" ? "ADing Dev" : "ADing");
// Channel and build time come from the package.json bundled into the app; in dev runs the build time is the moment of launch.
const release = describeRelease(
  {
    version: app.getVersion(),
    adingChannel: channel,
    adingBuildTime: appManifest().adingBuildTime
  }
);
// Dev server URL baked in when packaging the dev build (not in the repo, see scripts/package-local.mjs); environment variable takes precedence.
if (release.channel === "develop" && !process.env.ADING_API_BASE_URL?.trim() && appManifest().adingApiBaseUrl) {
  process.env.ADING_API_BASE_URL = appManifest().adingApiBaseUrl;
}
// `--version` only prints the version and never enters the GUI startup path: a full startup probes node, and if the probe
// hits a node shim pointing at this app, the app would relaunch itself endlessly.
if (process.argv.slice(1).some(argument => argument === "--version" || argument === "-v")) {
  console.log(release.displayVersion);
  app.exit(0);
}
/** Upper bound for waiting on agent child processes to stop: must cover the 3 seconds between SIGTERM and SIGKILL. */
const AGENT_EXIT_TIMEOUT_MS = 8000;

/**
 * Stop all agents and wait until they have actually exited.
 *
 * Extracted into its own function because quitting isn't the only user: when auto-update is wired in, before restarting to install we must likewise
 * clean up agents first — agents are detached, independent process groups and don't go away when the app process does.
 *
 * Note that cancel sends SIGTERM first and only adds SIGKILL 3 seconds later, so we must wait for actual exit rather than
 * blindly waiting a fixed duration: too short lets things through before SIGKILL takes effect, too long needlessly slows shutdown.
 */
async function stopAgentsGracefully(): Promise<void> {
  if (scheduler) await scheduler.shutdown();
  registry.cancelEverything();
  const stubborn = await registry.waitForAllExit(AGENT_EXIT_TIMEOUT_MS);
  // Anything still hanging on by the deadline has already received SIGKILL on its process group; just record it here, don't block.
  if (stubborn.length > 0) await log("shutdown-stubborn-agents", { stubborn });
}

// Multiple builds share one local store; only one may own the desktop node.
const ownsInstance=app.requestSingleInstanceLock();
if(!ownsInstance)app.exit(0);
app.on("second-instance",()=>{const window=BrowserWindow.getAllWindows()[0];if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});

configureContextWindowCache(path.join(app.getPath("userData"),"agent-context-capacity.json"));
const registry = new AgentRegistry({openExternal:url=>shell.openExternal(url), openApp:async appPath=>{
  const error=await shell.openPath(appPath); if(error)throw new Error(error);
}});
let unreadNotification:Notification|undefined;
let lastUnreadBadge="";
const appUnread=new AppUnread({
  badge:text=>{lastUnreadBadge=text;if(!HEADLESS){app.dock?.setBadge(text);if(!text){unreadNotification?.close();unreadNotification=undefined;}}},
  active:()=>HEADLESS||BrowserWindow.getAllWindows().some(window=>windowCanRead(window)),
  notify:({count,conversationId,friendRequests,mention})=>{
    if(HEADLESS||!Notification.isSupported())return;
    unreadNotification?.close();
    const body=mention ? (mention.sender ? tm("main.notification.mention",{sender:mention.sender,name:mention.name,preview:mention.preview??""}) : tm("main.notification.mentionGeneric",{name:mention.name})) : friendRequests ? tm("main.notification.friendRequests",{count:friendRequests}) : tm("main.notification.unread",{count});
    // Only make a sound when @-mentioned; ordinary unread messages stay quiet
    const notification=new Notification({title:app.getName(),body,silent:!mention});
    unreadNotification=notification;
    notification.on("show",()=>{if(unreadNotification===notification)app.dock?.setBadge(lastUnreadBadge);});
    notification.on("failed",(_event,error)=>void log("notification-failed",{error}));
    notification.on("click",()=>{
      if(unreadNotification!==notification)return;
      const window=BrowserWindow.getAllWindows()[0]??createMainWindow();
      const open=()=>{if(friendRequests)window.webContents.send("app:open-friend-requests");else if(conversationId)window.webContents.send("app:open-conversation",conversationId);};
      if(window.webContents.isLoadingMainFrame())window.webContents.once("did-finish-load",open);else open();
      if(window.isMinimized())window.restore();window.show();window.focus();
    });
    notification.show();
  },
  error:error=>void log("unread-refresh-failed",{error:describeForLog(error)})
});
let store: Store;
let permissionDialogs: PermissionDialogs;
let permissionPolicy: PermissionPolicy;
let syncer: SkillSyncer;
let knowledge: KnowledgeService;
let memoryNotify: MemoryNotifier | undefined;
let skillFallback:SkillFallback|undefined;
let capture: SkillCapture;
let scheduler: ConversationScheduler;
/** Cloud push channel for the online edition: messages from other devices (phones) reach this computer through it */
let cloudPush: CloudPush | undefined;
let conversationControl: ConversationControl | undefined;
let agentModelRelay: AgentModelRelay | undefined;
let cloudReconciler: CloudReconciler<Message[]> | undefined;
/** Settings → Permissions → "Keep the computer awake while running tasks", on by default; read back from preferences.json on startup */
let keepAwake = true;
const preferencesFile = () => path.join(app.getPath("userData"), "preferences.json");
/** Blocks idle sleep while an Agent is running; when the system really goes to sleep, go offline proactively and reconnect on wake. See platform/sleep-guard.ts */
const sleepGuard = new SleepGuard({
  // Only look at Agents currently running in the scheduler's run snapshot (sign-in, install, and connection checks don't count): computed fresh each time, released naturally on finish, failure, or cancel
  busy: () => (scheduler?.runtimeSnapshot().agents.length ?? 0) > 0,
  keepAwake: () => keepAwake,
  blocker: {
    start: () => powerSaveBlocker.start("prevent-app-suspension"),
    stop: (id) => { if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id); }
  },
  onSleep: () => {
    cloudReconciler?.pause();
    cloudPush?.pause();
  },
  onWake: () => {
    cloudPush?.resume();
    cloudReconciler?.resume();
    messageDelivery?.wake();
  },
  log: (event, data) => log(event, data)
});
/** Entry point in the current data session that hands user messages to the scheduler (backfill, re-trigger after restart), with retry on failure */
let messageDelivery: MessageDelivery | undefined;
/**
 * Syncs execution progress across computers (activity feed, "AI working"), see store/runtime-relay.ts.
 * uplink: reports this computer's scheduler events; remoteRuntime: converts events reported by other computers into events this UI understands.
 */
let runtimeUplink: RuntimeUplink | undefined;
const remoteRuntime = new RemoteRuntime((agentUserId) => discoveredByUserId.has(agentUserId));
const remoteActivityExpiry = setInterval(() => emitRuntimeEvents(remoteRuntime.expire()), 1000);
remoteActivityExpiry.unref?.();

function emitRuntimeEvents(events: RuntimeEvent[]): void {
  for (const event of events) {
    broadcast(event.channel, event.payload);
    // The activity feed produces several entries per second, so don't log each one; log busy/idle changes like start and finish, needed to debug "why does it always show working"
    if (event.channel === "agent:busy") void log("remote-turn-activity", event.payload);
  }
}
/**
 * Data session: one data layer, plus the scheduler, skill sync and collection, and permissions bound to it.
 * Offline edition and each account get their own; on sign-in/sign-out the old one is closed and a new one built in-process, without restarting the app.
 */
type DataTarget = { kind: "local" } | { kind: "account"; userId: string };
let dataTarget: DataTarget = { kind: "local" };
let unsubscribeStore: (() => void) | undefined;
let knowledgeCloud: KnowledgeCloudSync | undefined;
/** While switching data sessions, data-dependent IPC queues here until the new session is ready */
let dataReady: Promise<void> = Promise.resolve();
let supportReports: SupportReportQueue;
let developerContacts: DeveloperContactQueue;
let account: AccountSession;
let accountProfiles: AccountProfiles;
let updater: AppUpdater | undefined;
let updateHealth: UpdateHealth | undefined;
/** A new version already copied out of the installer, verified, and ready to swap in */
let stagedUpdate: { version: string; sha256: string; app: string } | undefined;
/** The version being prepared (version@sha256) */
let preparingUpdate: string | undefined;
/** Reason auto-install isn't possible; the UI switches to "Open installer" based on it */
let installBlockReason: string | undefined;
/** Replacement to perform on quit. relaunch=true: the user clicked "Restart to update" or confirmed a rollback */
let pendingInstall: { staged: string; relaunch: boolean; update?: { version: string; sha256: string } } | undefined;
let supportUploadWorker: Worker | undefined;
const enabledSupportUploads = new Set<"report" | "developer">();
/** Agents discovered on this computer: userId -> discovery info (executable path, etc.) */
const discoveredByUserId = new Map<string, DiscoveredAgent>();

interface SupportUploadTarget {
  name: "report" | "developer";
  pendingDirectory: string;
  endpoint?: string;
}


function startSupportUploadWorker(targets: SupportUploadTarget[]): boolean {
  const configured = targets.filter((target): target is Required<SupportUploadTarget> =>
    Boolean(target.endpoint?.trim())
  );
  configured.forEach((target) => enabledSupportUploads.add(target.name));
  if (configured.length === 0) {
    void log("support-uploader-disabled", { reason: "support endpoints are empty" });
    return false;
  }
  supportUploadWorker = new Worker(path.join(__dirname, "support/upload-worker.js"), {
    workerData: { targets: configured }
  });
  supportUploadWorker.on("message", (result) => {
    void log("support-upload-result", result as Record<string, unknown>);
    broadcast("support:upload-result", result);
  });
  supportUploadWorker.on("error", (error) => {
    void log("support-uploader-error", { error: describeForLog(error) });
  });
  supportUploadWorker.unref();
  return true;
}

/** Identity attached to feedback and contact; OSS separates directories by userId, and the offline edition without an account uses the computer ID. Failing to get an ID must not block reporting. */
async function supportIdentity(): Promise<{ userId?: string; terminalId?: string }> {
  const userId = dataTarget.kind === "account" ? dataTarget.userId : undefined;
  try {
    return { userId, terminalId: (await machineIdentity()).fingerprint };
  } catch {
    return { userId };
  }
}

function dataRoot(target: DataTarget): string {
  if (target.kind === "local") return path.join(app.getPath("userData"), "data");
  // Account data is isolated per account. Until CloudStore is ready, a local directory holds it; afterwards this only holds a cache of cloud data
  return path.join(app.getPath("userData"), "accounts", target.userId.replace(/[^\w-]/g, "_"), "data");
}

function createStore(target: DataTarget): Store {
  if (target.kind === "local") return new LocalStore(dataRoot(target));
  const status = account.status();
  if (!status.signedIn || status.user.userId !== target.userId) {
    throw new Error(tm("main.account.stateChanged"));
  }
  // Online edition: the cloud is authoritative; this computer keeps only this account's cache and pending-sync queue
  return new CloudStore({
    root: dataRoot(target),
    user: status.user,
    // Conversation synchronization also includes work addressed to this terminal's shared Agents.
    api: (method, route, body) => route.startsWith("/api/v1/conversations") && account.computer()
      ? account.nodeApi(method, route, body)
      : account.api(method, route, body),
    agentUserId: registerAgentInCloud,
    localComputerId: () => account.computer()?.terminalId,
    log: (event, data) => log(event, data)
  });
}

/**
 * Builds a complete data session for the target. All parts are built in local variables first and only replace the current session if all succeed;
 * a failure midway closes any data layer already opened, leaving nothing half-built.
 */
async function openDataSession(target: DataTarget): Promise<void> {
  const root = dataRoot(target);
  const nextStore = createStore(target);
  await nextStore.init();
  try {
    const knowledgeAgents=async()=>{
        const usable=new Map<AgentKind,DiscoveredAgent>();
        for(const user of await nextStore.listKnownAgents()) {
          const found=discoveredByUserId.get(user.userId);
          if(found&&user.enabled!==false&&!usable.has(found.kind)&&isAgentReadyToParticipate(user))usable.set(found.kind,found);
        }
        return [...usable.values()];
      };
    const nextSkillFallback=new SkillFallback({
      enabled:channel!=="develop",root:()=>nextStore.knowledgeRoot(),agents:knowledgeAgents,
      runTurn:(agent,input)=>registry.runTurn(agent,input),
      onFailures:failures=>nextKnowledge.setSkillFallbackFailures(failures),
      onPending:pending=>nextKnowledge.setSkillFallbackPending(pending),
      onCopied:async()=>{await nextKnowledge.refresh();},log:(event,data)=>log(event,data)
    });
    const nextSyncer = new SkillSyncer(nextStore, registry, { writeNativeSkills: channel !== "develop",fallback:nextSkillFallback });
    const nextMemoryNotify=new MemoryNotifier({
      store:nextStore,
      enabled:channel!=="develop",
      agents:knowledgeAgents,
      runTurn:(agent,input)=>registry.runTurn(agent,input),
      onFailures:failures=>nextKnowledge.setMemorySyncFailures(failures),
      log:(event,data)=>log(event,data)
    });
    const nextKnowledge=new KnowledgeService(nextStore,nextSyncer,{
      kinds:()=>[...new Set([...discoveredByUserId.values()].map(agent=>agent.kind))],
      resolveWorkspace:async conversation=>resolveWorkspace(conversation,await nextStore.getWorkspace(conversation.workspaceId),scratchRoot()),
      fallback:()=>({workspacePath:path.join(root,"knowledge-runtime"),sharesKnowledge:false}),
      onSyncState:state=>broadcast("knowledge:sync-state",state),
      memoryNotify:nextMemoryNotify,
      skillFallback:nextSkillFallback,
      cleanLegacyMemoryCopies:channel!=="develop",
      skillPaths:async(resolution,kinds)=>{
        const targets=[...await registry.resolveSkillTargets("global",resolution.workspacePath,kinds),...await registry.resolveSkillTargets("workspace",resolution.workspacePath,kinds)];
        return targets.map(target=>({kind:target.agentKind,paths:[target.dirPath,target.filePath,target.compatibilityFilePath].filter((item):item is string=>!!item)}));
      }
    });
    const nextDialogs = new PermissionDialogs(new PermissionGrants(path.join(root, "permission-grants.json")));
    const nextPolicy = new PermissionPolicy(path.join(root, "permission-policy.json"),{
      manual:(conversation,agent,request)=>HEADLESS ? Promise.resolve(false) : nextDialogs.request(conversation,agent,request),
      review:createLeaderPermissionReviewer({store:nextStore,registry,resolveDiscovered:id=>discoveredByUserId.get(id),isAgentReady:isAgentReadyToParticipate,resolveWorkspace:resolveFor}),
      audit:async(conversation,agent,mode,allowed)=>{await log("permission-policy-decision",{conversation:conversation.conversationId,agent:agent.userId,mode,allowed});}
    });
    await nextPolicy.get();
    let nextCapture: SkillCapture;
    const nextScheduler = new ConversationScheduler({
      // One persisted top-level provider conversation per Agent/task. Parallelism
      // uses its bounded child-task channel, native subagents, or different Agents.
      maxConcurrentWorkPerAgent: 1,
      validateWorkOutputs: async (work,workspacePath) => missingOutputs(work.outputs.map(output=>path.resolve(workspacePath,output))),
      getPermissionMode: () => nextPolicy.get(),
      requestPermission: (conversation, agent, request) => nextPolicy.request(conversation,agent,request),
      store: nextStore,
      registry,
      syncer: nextSyncer,
      knowledge:nextKnowledge,
      resolveWorkspace: resolveFor,
      resolveDiscovered: (userId) => discoveredByUserId.get(userId),
      isAgentReady: isAgentReadyToParticipate,
      isAgentPending: isAgentAwaitingVerification,
      agentUnavailableReason: agent => {
        const readiness = agent.kind && verifyCache.get(agent.kind)?.readiness;
        if (readiness === "exhausted") return p("Agent 额度已耗尽；请改派有额度的成员。若必须使用此成员，请主人补充额度或等待额度恢复。", "The Agent's quota is used up; reassign to a member who has quota. If this member must be used, ask the task owner to add quota or wait for it to recover.");
        if (readiness === "unauthorized") return p("Agent 登录授权已失效；请改派其他成员，或请主人重新登录该 Agent 后检查连接。", "The Agent's login authorization has expired; reassign to another member, or ask the task owner to log in to this Agent again and check the connection.");
        if (agent.kind && (verifyingAgentCounts.get(agent.kind) ?? 0) > 0) return p("Agent 正在检测连接；请等待检测结束后重新评估，暂不重复派单。", "The Agent is checking its connection; wait for the check to finish and re-evaluate, and don't dispatch again for now.");
        return p("Agent 连接检测未通过；请改派可用成员，或请主人在 Agent 设置中重新检测连接。", "The Agent's connection check failed; reassign to an available member, or ask the task owner to recheck the connection in Agent settings.");
      },
      onAgentFailure: async (agent, error) => {
        if (!agent.kind) return;
        recordAccessDenied(agent.kind, error, "turn");
        const state = classifyReadiness(true, { ok: false, text: error });
        // Explicit quota / sign-in failures go offline immediately; ordinary transient errors must not wrongly block an entire Agent vendor.
        if (state.readiness !== "exhausted" && state.readiness !== "unauthorized") return;
        verifyCache.set(agent.kind, { ...state, checkedAt: new Date().toISOString() });
        await saveVerifyCache();
        broadcast("store:event", { type: "agents" });
      },
      broadcast: (channel, payload) => {
        broadcast(channel, payload);
        // When online, this computer's agent execution progress is synced to the account's other computers (the offline edition has no uplink and does nothing)
        runtimeUplink?.push(channel, payload);
        if (channel === "agent:busy") sleepGuard.schedule();
      },
      systemAsleep: () => sleepGuard.sleeping,
      whenAwake: () => sleepGuard.whenAwake(),
      log,
      afterTurn: (context) => nextCapture.afterTurn(context)
    });
    nextCapture = new SkillCapture(nextStore, registry, nextSyncer, {
      afterKnowledgeSaved:()=>nextKnowledge.saved(),
      // Review continues on the agent's own thread in this conversation — all the context is there
      runInConversation: (conversation, agent, prompt) =>
        nextScheduler.speakInConversation(conversation, agent, prompt),
      // Proposals and review comments are posted as real group messages, visible to people and carried in later increments
      post: (conversationId, senderId, content, type) =>
        nextStore.appendMessage({
          conversationId,
          clientMessageId: newId("message"),
          senderId,
          content,
          type: type ?? "SKILL"
        }),
      // Agents that aren't ready don't take part in auto-summary/review either, so their CLI isn't started secretly in the background.
      resolveDiscovered: (userId) => {
        const discovered = discoveredByUserId.get(userId);
        if (!discovered) return undefined;
        return canAgentParticipate(verifyCache.get(discovered.kind)?.readiness, {
          discovered: true,
          verifying: (verifyingAgentCounts.get(discovered.kind) ?? 0) > 0
        })
          ? discovered
          : undefined;
      }
    });
    // The online edition stores skills and memories in the cloud; the offline edition has no account and doesn't sync
    const nextKnowledgeCloud=nextStore instanceof CloudStore ? new KnowledgeCloudSync({store:nextStore,api:(method,route,body)=>account.api(method,route,body),log:(event,data)=>log(event,data),onStatus:failure=>nextKnowledge.setCloudFailure(failure),onPulled:async()=>{nextMemoryNotify.changed();await nextKnowledge.refresh();}}) : undefined;
    // Store change events are forwarded to the renderer as-is:
    // in the offline edition LocalStore emits them; in the online edition CloudStore emits them after writing the local cache (including push-triggered backfills), so UI code doesn't need to distinguish
    const nextUnsubscribe = nextStore.subscribe((event) => {
      broadcast("store:event", event);
      nextMemoryNotify.onStoreEvent(event);
      if (event.type === "conversation") {
        void nextScheduler.syncOwnerPauses(event.conversationId).catch(error => log("owner-pause-sync-failed", { conversationId: event.conversationId, error: String(error) }));
      }
      if(event.type==="skills"||event.type==="memories"){
        // Don't refresh per item when writing cloud content: pulling hundreds at once would queue hundreds of rounds; onPulled refreshes once after the whole round
        if(!nextKnowledgeCloud?.applyingCloudChanges)void nextKnowledge.refresh().catch(error=>log("knowledge-sync-failed",{error:String(error)}));
        nextKnowledgeCloud?.schedule();
      }
    });

    store = nextStore;
    appUnread.bind(nextStore);
    syncer = nextSyncer;
    knowledge=nextKnowledge;
    memoryNotify=nextMemoryNotify;
    skillFallback=nextSkillFallback;
    permissionDialogs = nextDialogs;
    permissionPolicy = nextPolicy;
    scheduler = nextScheduler;
    for (const conversation of await nextStore.listConversations()) {
      await nextScheduler.syncOwnerPauses(conversation.conversationId);
    }
    capture = nextCapture;
    unsubscribeStore = nextUnsubscribe;
    knowledgeCloud = nextKnowledgeCloud;
    nextKnowledgeCloud?.start();
    dataTarget = target;
    const delivery = new MessageDelivery({
      deliver: (message, interrupted) => interrupted ? nextScheduler.redeliverUserMessage(message) : nextScheduler.receiveRemoteUserMessage(message),
      stillOwed: async (message) => Boolean((await nextStore.listOwedMessages?.(message.conversationId))?.some((item) => item.messageId === message.messageId)),
      asleep: () => sleepGuard.sleeping,
      log: (event, data) => log(event, data)
    });
    messageDelivery = delivery;
    if (nextStore instanceof CloudStore) startCloudPush(nextStore, nextScheduler, delivery);
    // User messages left unfinished from the last run (crash or quit mid-processing, or written locally but not yet handed to the scheduler): re-trigger them; the scheduler simply clears ones already processed
    const owed = await Promise.resolve(nextStore.listOwedMessages?.() ?? [])
      .catch(async (error) => { await log("owed-messages-read-failed", { error: describeForLog(error) }); return [] as Message[]; });
    if (owed.length) await log("owed-messages-redelivered", { messages: owed.map((message) => ({ conversationId: message.conversationId, messageId: message.messageId, seq: message.seq })) });
    for (const message of owed) void delivery.deliver(message, true);
  } catch (error) {
    await nextStore.close().catch(() => undefined);
    throw error;
  }
  await log("data-session-opened", { target: target.kind });
}

/** Closes the current data session. Running agents are terminated immediately without waiting for them to wrap up */
async function closeDataSession(): Promise<void> {
  appUnread.bind();
  conversationControl?.close();
  conversationControl = undefined;
  agentModelRelay?.close();
  agentModelRelay = undefined;
  messageDelivery?.stop();
  messageDelivery = undefined;
  cloudPush?.stop();
  cloudPush = undefined;
  cloudConnected = false;
  const reconciler = cloudReconciler;
  cloudReconciler = undefined;
  await reconciler?.stop();
  runtimeUplink?.reset();
  runtimeUplink = undefined;
  emitRuntimeEvents(remoteRuntime.clear());
  unsubscribeStore?.();
  unsubscribeStore = undefined;
  await knowledgeCloud?.stop();
  knowledgeCloud = undefined;
  skillFallback?.dispose();skillFallback=undefined;
  memoryNotify?.dispose();
  memoryNotify = undefined;
  registry.cancelEverything();
  await scheduler.shutdown().catch((error) => log("data-session-shutdown-failed", { error: describeForLog(error) }));
  await store.close().catch((error) => log("data-session-close-failed", { error: describeForLog(error) }));
  sleepGuard.schedule();
}

/**
 * Online edition: connect to the cloud push channel. When phones or other devices send messages, backfill them into local data,
 * and hand user-sent messages to the local scheduler so local agents work just as if the message were sent on this computer.
 * Messages this computer wrote itself are deduplicated by message ID when pulled back, so they aren't executed twice.
 */
function startCloudPush(cloudStore: CloudStore, sessionScheduler: ConversationScheduler, delivery: MessageDelivery): void {
  void registerComputerNow();
  const control = new ConversationControl({
    send: (type, payload) => cloudPush?.send(type, payload) ?? false,
    run: async (conversationId, action) => {
      // A task first seen through a remote control is imported here; its pulled
      // user messages must not be dropped. Pause means the owner stopped it, so
      // they are settled without running; resume hands them to the scheduler.
      const imported = (await cloudStore.getConversation(conversationId)) ? [] : await cloudStore.pullConversationMessages(conversationId);
      const conversation = await cloudStore.getConversation(conversationId);
      if (!conversation) throw new Error("Conversation unavailable");
      await log("conversation-control-received", { conversationId, action });
      await executeConversationControl(sessionScheduler, conversationId, action).catch(async error => {
        await log("conversation-control-failed", { conversationId, action, error: describeForLog(error) });
        throw error;
      });
      if (imported.length) {
        if (action === "resume") await handleAdded(imported);
        else await cloudStore.ackDispatched(imported);
      }
      broadcast("store:event", { type: "conversation", conversationId });
      await log("conversation-control-completed", { conversationId, action });
    }
  });
  conversationControl = control;
  const modelRelay = new AgentModelRelay({
    send: (type, payload) => cloudPush?.send(type, payload) ?? false,
    catalog: (agentUserId) => agentModels().localCatalog(agentUserId),
    set: (agentUserId, modelId) => agentModels().setLocal(agentUserId, modelId)
  });
  agentModelRelay = modelRelay;
  // User messages returned by backfill are first recorded in the local "unfinished" ledger, then dispatch is confirmed and they go to the scheduler:
  // a crash before recording means backfill delivers them again after restart; after recording, they are cleared only once processed (the Agent's processed watermark passes them), otherwise re-triggered after restart
  const handleAdded = async (added: Message[]) => {
    const skipped: Message[] = [];
    for (const message of added) {
      if (cloudReconciler !== reconciler || quitting) return;
      // Shared Agents also receive messages from people other than their owner.
      // Cloud reads already enforce conversation access; Agent replies must not loop back as user input.
      const sender = await cloudStore.getUser(message.senderId);
      if (!shouldDispatchRemoteUserMessage(message, sender)) {
        skipped.push(message);
        // Assignments, results, and discussion replies handed to this computer by Agents on other computers: passed to the scheduler in order, which picks only local Agents to handle them
        if (shouldDispatchRemoteAgentMessage(message, sender)) {
          await sessionScheduler.receiveRemoteAgentMessage(message)
            .catch((error) => log("remote-agent-message-failed", { conversationId: message.conversationId, messageId: message.messageId, error: describeForLog(error) }));
        }
        continue;
      }
      control.forget(message.conversationId);
      await log("remote-user-message", { conversationId: message.conversationId, messageId: message.messageId, seq: message.seq });
      try {
        await cloudStore.oweMessage(message.conversationId, message.messageId);
        await cloudStore.ackDispatched([message]);
      } catch (error) {
        await log("remote-user-message-failed", { conversationId: message.conversationId, error: describeForLog(error) });
        continue;
      }
      await delivery.deliver(message);
    }
    if (skipped.length) await cloudStore.ackDispatched(skipped);
  };
  const pull = (work: () => Promise<Message[]>, what: Record<string, unknown>) => {
    void work().then(handleAdded).catch((error) => log("cloud-pull-failed", { ...what, error: describeForLog(error) }));
  };
  const reconciler = new CloudReconciler({
    pull: () => cloudStore.pullAllConversationMessages(),
    apply: handleAdded,
    onError: (error) => void log("cloud-reconcile-failed", { error: describeForLog(error) })
  });
  cloudReconciler = reconciler;
  // Data session switched while asleep (in DarkWake): don't connect or pull yet; deal with it on wake
  if (sleepGuard.sleeping) reconciler.pause();
  reconciler.start();
  cloudPush = new CloudPush({
    credentials: async () => {
      if (!account.computer() && !(await registerComputerNow())) throw new Error("Terminal registration unavailable");
      const result = await account.nodeApi("POST", "/api/v1/mqtt/credentials");
      if (!result.ok) throw new Error("MQTT credentials unavailable");
      return result.data as import("./store/mqtt-push").MqttCredentials;
    },
    onConversationChanged: (conversationId) => pull(() => cloudStore.pullConversationMessages(conversationId), { conversationId }),
    // Task names are shared across clients like messages: if another client renames it, follow here
    onConversationUpdated: (conversationId) => void cloudStore.refreshConversation(conversationId)
      .catch((error) => log("cloud-conversation-refresh-failed", { conversationId, error: describeForLog(error) })),
    onConnected: () => {
      cloudConnected = true;
      reconciler.request();
      runtimeUplink?.reportBusy();
      // Agent status is synced like messages: on connect, publish local ones and pull those from other computers
      void publishAgentStates();
      void syncRemoteAgents(cloudStore);
      void syncPeople(cloudStore);
      void cloudStore.refreshConversationNames()
        .catch((error) => log("cloud-conversation-names-failed", { error: describeForLog(error) }));
    },
    onAgentsChanged: () => void syncRemoteAgents(cloudStore),
    onAgentVerificationRequested: (agentUserId) => {
      void (async () => {
        const agent = await cloudStore.getUser(agentUserId);
        if (!agent?.isAgent || agent.remote || !agent.kind || !discoveredByUserId.has(agentUserId)) {
          await log("agent-verify-request-ignored", { agentUserId, reason: "not-local" });
          return;
        }
        await log("agent-verify-requested", { agentUserId, kind: agent.kind });
        await verifyAgent(agent.kind);
        // Checks initiated by the UI get a return value; this one was triggered by a phone or another computer and nobody awaits the result,
        // so without a notification the traffic lights in the local contacts list would stay stale
        broadcast("store:event", { type: "agents" });
      })().catch((error) => log("agent-verify-request-failed", { agentUserId, error: describeForLog(error) }));
    },
    onFriendsChanged: () => { void syncPeople(cloudStore); void syncRemoteAgents(cloudStore); },
    onConversationControl: (type, payload) => control.receive(type, payload),
    onAgentModelRelay: (type, payload) => modelRelay.receive(type, payload),
    onTurnProgress: (payload) => emitRuntimeEvents(remoteRuntime.apply(payload)),
    onDisconnected: () => {
      cloudConnected = false;
      void sessionScheduler.teamAvailabilityChanged().catch((error) => log("team-availability-failed", { error: describeForLog(error) }));
      control.disconnect();
      modelRelay.disconnect();
      emitRuntimeEvents(remoteRuntime.clear());
    },
    log: (event, data) => log(event, data)
  });
  runtimeUplink = new RuntimeUplink((frame) => {
    const sent = cloudPush?.send("TURN_PROGRESS", frame) ?? false;
    if (frame.busy !== undefined) void log("turn-activity-sent", { ...frame, sent });
  });
  if (sleepGuard.sleeping) cloudPush.pause();
  cloudPush.start();
}

/**
 * Members on this computer are paused/resumed here first; members on other
 * computers are controlled on their own computers through the server.
 */
async function controlConversation(conversationId: string, action: ConversationAction): Promise<number> {
  const conversation = await store.getConversation(conversationId);
  if (!conversation) throw new Error(tm("main.store.conversationMissing"));
  const me = await store.currentUser();
  const ownerViewing = !conversation.members.some(member => member.userId === me.userId);
  if (store instanceof CloudStore && ownerViewing && action === "resume") {
    await store.setOwnerPaused(conversationId, false);
  }
  const members = await Promise.all(conversation.members.map(member => store.getUser(member.userId)));
  const remote = members.filter(user => user?.isAgent && user.remote);
  const runLocal = () => action === "pause"
    ? scheduler.stopConversation(conversationId)
    : scheduler.resumeConversation(conversationId).then(() => 0);
  if (!(store instanceof CloudStore) || (!remote.length && !ownerViewing)) return runLocal();
  const hasLocal = members.some(user => user?.isAgent && !user.remote);
  return controlLocalThenRemote(action, {
    // Refresh the pause/resume button even if the remote part then fails.
    local: hasLocal ? () => runLocal().finally(() => broadcast("store:event", { type: "conversation", conversationId })) : undefined,
    remote: async localOk => {
      // Stop local work first even if the persistent cloud pause cannot be saved.
      if (store instanceof CloudStore && ownerViewing && action === "pause") await store.setOwnerPaused(conversationId, true);
      if (!remote.length) return;
      if (!conversationControl) throw new Error(tm("main.control.disconnected"));
      await conversationControl.request(conversationId, action, hasLocal ? localOk : undefined);
      if (action === "pause") {
        // The receipt is from execution nodes after cancellation settled. It also
        // repairs an otherwise stale busy indicator if a progress hint was lost.
        for (const agent of remote) emitRuntimeEvents(remoteRuntime.apply({ conversationId, agentUserId: agent!.userId, busy: false }));
      }
    }
  });
}

/** Pulls human friends and friend requests */
async function syncPeople(cloudStore: CloudStore): Promise<void> {
  await cloudStore.refreshPeople()
    .catch((error) => log("cloud-people-sync-failed", { error: describeForLog(error) }));
}

/** Pulls agents on all of the account's computers; those on other computers go into the local list */
async function syncRemoteAgents(cloudStore: CloudStore): Promise<void> {
  await cloudStore.refreshAgents()
    .catch((error) => log("cloud-agents-sync-failed", { error: describeForLog(error) }));
  // Other computers coming online or going offline, or Agent traffic-light changes, can all change which computer coordinates
  await scheduler.teamAvailabilityChanged().catch((error) => log("team-availability-failed", { error: describeForLog(error) }));
}

/**
 * Online edition: publish local agent status to the cloud so the account's other computers can set their traffic lights.
 *
 * The principle of cross-computer collaboration is syncing every client — syncing a message there equals typing it there, and agent status is synced the same way;
 * other computers judge availability with the same rules as the offline edition. What's published is the state this computer uses to judge "can it work":
 * missing if not discovered, otherwise the latest check result. Multiple changes in a short time are merged into one;
 * if it can't be sent (offline, computer not registered yet), wait for the next change or reconnect.
 */
let agentStatePublishTimer: NodeJS.Timeout | undefined;
function scheduleAgentStatePublish(): void {
  if (!(store instanceof CloudStore)) return;
  clearTimeout(agentStatePublishTimer);
  agentStatePublishTimer = setTimeout(() => void publishAgentStates(), 500);
}

let agentModelsInstance: AgentModels | undefined;
function agentModels(): AgentModels {
  return agentModelsInstance ??= new AgentModels({
    discovered: (userId) => discoveredByUserId.get(userId),
    registry,
    cache: new AgentModelCache(path.join(app.getPath("userData"), "agent-model-cache.json")),
    store: () => store,
    relay: () => agentModelRelay,
    changed: scheduleAgentStatePublish,
    log: (event, data) => log(event, data)
  });
}

async function publishAgentStates(): Promise<void> {
  if (!(store instanceof CloudStore) || !account.computer()) return;
  const agents = (await store.listKnownAgents()).filter((agent) => agent.isAgent && !agent.remote && agent.kind);
  if (!agents.length) return;
  const states = await Promise.all(agents.map(async (agent) => ({
    userId: agent.userId,
    readiness: discoveredByUserId.has(agent.userId) ? verifyCache.get(agent.kind!)?.readiness ?? "unknown" : "missing",
    // Version is part of agent status too: after an upgrade, other computers only see the new version on the details page
    ...(agent.version ? { agentVersion: agent.version } : {}),
    model: await agentModels().snapshot(agent)
  })));
  const result = await account.nodeApi("PUT", "/api/v1/terminals/me/agent-states", { agents: states });
  if (result.ok) await log("agent-states-published", { states, changed: result.data });
  else await log("agent-states-publish-failed", { states, reason: result.message, kind: result.kind });
}

/** Busy/idle snapshot of the local scheduler, plus agents working on other computers */
function withRemoteRuntime(snapshot: AgentRuntimeSnapshot): AgentRuntimeSnapshot {
  const remote = remoteRuntime.snapshot();
  return remote.length ? { ...snapshot, agents: [...snapshot.agents, ...remote] } : snapshot;
}

function sameTarget(a: DataTarget, b: DataTarget): boolean {
  return a.kind === b.kind && (a.kind === "local" || (b.kind === "account" && a.userId === b.userId));
}

/**
 * Switch data sessions on sign-in / sign-out: tell the UI to show a waiting overlay → close the old session → open the new session → tell the UI to refetch.
 * The app process and window stay up. If the new session can't open, fall back to the previous session, and failing that to the offline edition;
 * it must never be stuck in a state that's neither offline nor online.
 */
async function switchDataSession(target: DataTarget): Promise<void> {
  let release!: () => void;
  const waiting = dataReady;
  dataReady = new Promise<void>((resolve) => { release = resolve; });
  try {
    await waiting;
    if (sameTarget(dataTarget, target)) return;
    const previous = dataTarget;
    broadcast("data:switching", { target: target.kind });
    try {
      await closeDataSession();
      try {
        await openDataSession(target);
      } catch (error) {
        await log("data-session-open-failed", { target: target.kind, error: describeForLog(error) });
        await openDataSession(previous).catch(() => openDataSession({ kind: "local" }));
        throw error;
      } finally {
        // Local agents belong to this computer, independent of sign-in state: register them as soon as the new data layer opens (reusing existing discovery results, no re-probing)
        const discovery = catalogDiscovery ?? await probeSession.stable(() => registry.discoverAll()).catch(() => undefined);
        if (discovery) {
          catalogDiscovery = discovery;
          await applyDiscovery(discovery).catch((error) => log("data-session-discovery-failed", { error: describeForLog(error) }));
        }
      }
    } finally {
      broadcast("data:switched", { target: dataTarget.kind });
    }
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    // Follows the app name: the dev build is called ADing Dev, so windows can be told apart when it's open alongside the release build
    title: app.getName(),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
    backgroundColor: "#e9effc",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Only allow the page's own reload (switching language or account data both rely on location.reload()); block all other navigation
  window.webContents.on("will-navigate", (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });

  const sendActive=()=>{
    if(!window.webContents.isDestroyed())window.webContents.send("app:window-active",windowCanRead(window));
    if(windowCanRead(window)){appUnread.refresh();foregroundTelemetry.check("focus");}
  };
  window.on("focus",sendActive).on("blur",sendActive).on("show",sendActive).on("hide",sendActive).on("minimize",sendActive).on("restore",sendActive);
  void window.loadFile(path.join(__dirname, "../src/index.html"));
  return window;
}

/**
 * Restores the last sign-in state in the background, then re-verifies with the refresh token, notifying the UI as each step concludes.
 * Must never be put on the startup wait chain: decrypting the session may wait for the user to click a keychain authorization,
 * and if the user doesn't click, the offline edition must still open and work normally.
 */
let computerRegistering: Promise<ComputerRegistration | undefined> | undefined;

/**
 * Registers this computer with the cloud (idempotent by a hash of the hardware UUID). Registers only once at a time; returns empty on failure.
 * Failure doesn't affect sign-in or use: if the server is unreachable, register on the next sign-in or launch.
 */
function registerComputerNow(): Promise<ComputerRegistration | undefined> {
  computerRegistering ??= (async () => {
    try {
      const result = await account.registerComputer({ ...(await machineIdentity()), ...clientVersions() });
      if (result.ok) {
        await log("computer-registered", { terminalId: result.computer.terminalId, name: result.computer.name });
        return result.computer;
      }
      await log("computer-register-failed", { kind: result.kind, message: result.message });
    } catch (error) {
      await log("computer-register-failed", { error: describeForLog(error) });
    }
    return undefined;
  })().finally(() => {
    computerRegistering = undefined;
  });
  return computerRegistering;
}

async function registerComputerInBackground(): Promise<void> {
  await registerComputerNow();
}

/**
 * Online edition: register locally discovered agents with the cloud using the computer token (idempotent by computer + local ID), using the cloud's userId,
 * so task members and message senders match up in the cloud. Returns empty when unreachable, and a locally generated ID is used for now.
 */
async function registerAgentInCloud(agent: DiscoveredAgent): Promise<string | undefined> {
  const computer = account.computer() ?? (await registerComputerNow());
  if (!computer) return undefined;
  const result = await account.nodeApi("POST", "/api/v1/agents/register", {
    localUuid: agent.localUuid,
    agentType: CLOUD_AGENT_TYPE[agent.kind],
    agentVersion: agent.version,
    displayName: defaultAgentName(agent.kind, agent.name)
  });
  if (!result.ok) {
    await log("agent-cloud-register-failed", { kind: agent.kind, reason: result.message });
    return undefined;
  }
  const userId = (result.data as { userId?: unknown } | null)?.userId;
  return typeof userId === "string" ? userId : undefined;
}

/**
 * The server doesn't offer the online edition in this region (mainland China): the session has already signed out, so switch back to the offline edition and say so.
 * Offline edition data is left untouched; if several requests are rejected at the same time, notify only once.
 */
let regionNoticeShown = false;
async function leaveOnlineForRegion(_message: string): Promise<void> {
  await switchDataSession({ kind: "local" }).catch((error) => log("data-session-switch-failed", { error: describeForLog(error) }));
  broadcast("account:changed", account.status());
  if (regionNoticeShown) return;
  regionNoticeShown = true;
  await dialog.showMessageBox({ type: "info", message: tm("main.account.regionTitle") }).catch(() => undefined);
  regionNoticeShown = false;
}

async function restoreAccountInBackground(): Promise<void> {
  try {
    const restored = await account.init();
    await log("account-restored", { signedIn: restored.signedIn });
    if (restored.signedIn) {
      await switchDataSession({ kind: "account", userId: restored.user.userId });
      broadcast("account:changed", restored);
    }
    const checked = await account.revalidate();
    await log("account-revalidated", { signedIn: checked.signedIn });
    if (restored.signedIn && !checked.signedIn) {
      await switchDataSession({ kind: "local" });
    }
    broadcast("account:changed", checked);
    if (checked.signedIn) void registerComputerInBackground();
  } catch (error) {
    await log("account-restore-failed", { error: describeForLog(error) });
  }
}

/** After a successful sign-in, notify all windows so the top bar switches between "Sign in" and "Sign out". */
function publishAccount(result: AccountResult): AccountResult {
  if (result.ok) broadcast("account:changed", result.status);
  return result;
}

/**
 * Check for updates: staged rollout by account / computer, decided on the server. When signed in, send the token (refreshed automatically when expired);
 * when not signed in or the token is revoked, check anonymously — anonymous checks can still hit a rollout by computer ID.
 * Set ADING_UPDATE_DISABLED=1 to disable (e.g. to avoid interruptions while debugging).
 */
function startAppUpdater(): void {
  if (HEADLESS || process.env.ADING_UPDATE_DISABLED === "1") return;
  void loadRequiredVersion();
  const baseUrl = apiBaseUrl(release.channel);
  const request = async (body: UpdateCheckBody): Promise<CheckResult> => {
    if (account.status().signedIn) {
      const result = await account.api("POST", UPDATE_CHECK_ROUTE, body);
      if (result.ok) return result;
      if (result.kind !== "signed-out") return { ok: false, message: result.message };
    }
    return postAnonymous(baseUrl, body);
  };
  updater = new AppUpdater({
    channel: release.channel,
    arch: process.arch,
    currentVersion: release.displayVersion,
    directory: path.join(updatesDirectory(), "packages"),
    machineId: async () => (await machineIdentity()).fingerprint,
    request,
    isRejected: (update) => updateHealth?.isRejected(releaseKey(update)) ?? false,
    onState: (state) => void onUpdaterState(state),
    log: (event, data) => void log(event, data)
  });
  updater.start();
}

/**
 * Device analytics: reported only while the window is in the foreground and someone is using it, at most once per hour; the ops console's DAU is based on it.
 * Not reported when running in the background, with the window closed, when locked, or after long inactivity.
 * When signed in, send the token (the backend uses it to identify the account); report anonymously when the token is invalid or not signed in; phone and email come from the current identity's profile.
 */
const FOREGROUND_IDLE_SECONDS = 900;
const foregroundTelemetry = new ForegroundTelemetry({
  foreground: () => !HEADLESS && BrowserWindow.getAllWindows().some((window) => windowCanRead(window))
    && powerMonitor.getSystemIdleState(FOREGROUND_IDLE_SECONDS) === "active",
  send: sendDeviceTelemetry
});

/** Device parameters, reported with registration and analytics; the ops console uses them to see versions */
function clientVersions(): { appVersion: string; osVersion: string } {
  const system = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform;
  return { appVersion: release.displayVersion, osVersion: `${system} ${process.getSystemVersion()}` };
}

async function sendDeviceTelemetry(reason: string): Promise<TelemetryResult> {
  try {
    const status = account.status();
    const profile = status.signedIn ? await accountProfiles.get(status.user) : await store.currentUser();
    const body = buildTelemetryBody({
      fingerprint: (await machineIdentity()).fingerprint,
      platform: process.platform,
      phone: profile?.phone,
      email: profile?.email,
      readyAgents: (await buildAgentCatalog()).filter((agent) => agent.readiness === "ready").map((agent) => agent.kind),
      ...clientVersions()
    });
    await log("telemetry-start", { ...describeTelemetry(body), signedIn: status.signedIn, reason });
    let result: TelemetryResult;
    if (status.signedIn) {
      const remote = await account.api("POST", TELEMETRY_ROUTE, body);
      result = remote.ok ? { ok: true } : remote.kind === "signed-out"
        ? await postTelemetryAnonymously(apiBaseUrl(release.channel), body)
        : { ok: false, message: remote.message };
    } else {
      result = await postTelemetryAnonymously(apiBaseUrl(release.channel), body);
    }
    await log("telemetry-done", result.ok ? { ok: true } : { ok: false, message: result.message });
    return result;
  } catch (error) {
    await log("telemetry-done", { ok: false, message: describeForLog(error) });
    return { ok: false, message: describeForLog(error) };
  }
}

function updatesDirectory(): string {
  return path.join(app.getPath("userData"), "updates");
}

/**
 * staging and rollback hold complete .app bundles. The directory names carry .noindex so Spotlight doesn't index them as apps,
 * and users searching for "阿钉" only see the one installed in Applications.
 */
function stagingRoot(): string {
  return path.join(updatesDirectory(), "staging.noindex");
}

function rollbackDirectory(): string {
  return path.join(updatesDirectory(), "rollback.noindex");
}

/** Version-specific staging directory. One per version, so installing a new version doesn't require deleting the old one first */
function stagingDirectory(version: string): string {
  // Version strings only contain digits, letters, dots, and hyphens, but they come from the server, so still don't use them directly as paths
  return path.join(stagingRoot(), version.replace(/[^0-9A-Za-z.-]/g, "_"));
}

/**
 * The rollback copy is kept only while the new version hasn't proven itself: once it has run healthily once (a full 60 seconds or a normal quit) it's deleted,
 * so auto-update doesn't leave an extra copy of ADing on the user's computer. Crashes that appear later no longer get one-click rollback.
 * Copies that older versions left in staging/ and rollback/ without .noindex are cleaned up as well.
 */
async function discardRollback(): Promise<void> {
  for (const directory of [
    rollbackDirectory(),
    path.join(updatesDirectory(), "rollback"),
    path.join(updatesDirectory(), "staging")
  ]) {
    await removeTree(directory).catch((error) =>
      log("update-rollback-discard-failed", { directory, error: describeForLog(error) }));
  }
}

/**
 * All work under updates/staging.noindex is queued and run one at a time.
 *
 * The updater's state callback is "fire and forget" (`void onUpdaterState(state)` in onState),
 * so cleaning up old staging and preparing new staging run concurrently. When they operate on the same directory tree,
 * one recursive delete has just listed a directory when the other deletes the files inside, and the former's final rmdir hits ENOTEMPTY and fails,
 * leaving half a tree, after which every update check reports the same error (that's what happened to the 0.5.0 OTA on 2026-09-22).
 * Serializing eliminates this overlap at the source; jitter inside a single operation is covered by removeTree's retries.
 */
let stagingQueue: Promise<unknown> = Promise.resolve();
function queueStagingWork<T>(work: () => Promise<T>): Promise<T> {
  const next = stagingQueue.then(work, work);
  // The queue itself must not stop because of one failure; each caller handles its own failures
  stagingQueue = next.catch(() => undefined);
  return next;
}

/** Deletes all staging except these versions (an empty array deletes everything) */
async function pruneStaging(keep: string[]): Promise<void> {
  const root = stagingRoot();
  const kept = new Set(keep.map(version => path.basename(stagingDirectory(version))));
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const name of entries) {
    if (!kept.has(name)) await removeTree(path.join(root, name)).catch(() => undefined);
  }
}

/** Only a packaged app has a replaceable .app; in dev (pnpm start) returns undefined */
function runningBundle(): string | undefined {
  return app.isPackaged ? appBundleOf(process.execPath) : undefined;
}

/** An Agent is running or queued */
function agentsAreBusy(): boolean {
  const runtime = scheduler.runtimeSnapshot();
  return runtime.agents.length > 0 || (runtime.queued?.length ?? 0) > 0;
}

/**
 * Installing a new version interrupts the user, so ask first. Both install paths (one-click restart, manual install) share this one dialog,
 * so the buttons and wording of the two don't diverge. Defaults to "Later": most of the time this dialog interrupts the user rather than being something they asked for.
 */
async function confirmInterruption(
  event: Electron.IpcMainInvokeEvent,
  texts: { message: string; detail: string; confirm: string }
): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: [texts.confirm, tm("main.update.later")],
    defaultId: 1,
    cancelId: 1,
    message: texts.message,
    detail: texts.detail
  };
  const window = BrowserWindow.fromWebContents(event.sender);
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

/**
 * Forced upgrade: the minimum version required. Below it the UI is blocked entirely and local Agents take no work until the new version is installed.
 *
 * Stored on disk so going offline or restarting can't bypass it; only the server's verdict lifts it — cleared only when the server says "no update"
 * or "update available but not forced" (the forced version was withdrawn). Left unchanged when the check fails.
 */
let requiredVersion: string | undefined;
const requiredVersionFile = () => path.join(updatesDirectory(), "required.json");

async function loadRequiredVersion(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(requiredVersionFile(), "utf8")) as { version?: unknown };
    const version = typeof saved.version === "string" ? saved.version : "";
    if (isValidVersion(version) && compareVersions(version, release.displayVersion) > 0) {
      requiredVersion = version;
      await log("update-required-restored", { requiredVersion, current: release.displayVersion });
      publishUpdateState();
    } else {
      await rm(requiredVersionFile(), { force: true });
    }
  } catch {
    // No record means not forced
  }
}

async function noteRequiredVersion(state: AppUpdateState): Promise<void> {
  let next = requiredVersion;
  if (state.phase === "up-to-date") next = undefined;
  if (state.phase === "downloading" || state.phase === "ready") {
    const wanted = state.update.mandatory ? state.update.requiredVersion : undefined;
    next = wanted && compareVersions(wanted, release.displayVersion) > 0 ? wanted : undefined;
  }
  if (next === requiredVersion) return;
  requiredVersion = next;
  await log("update-required-changed", { requiredVersion: next ?? null, current: release.displayVersion });
  if (next) {
    await mkdir(updatesDirectory(), { recursive: true });
    await writeFile(requiredVersionFile(), JSON.stringify({ version: next }), "utf8");
  } else {
    await rm(requiredVersionFile(), { force: true });
  }
  // Whether local Agents can take work has changed, so the contacts list traffic lights need refreshing too
  broadcast("store:event", { type: "agents" });
}

/** State for the UI: adds "can restart-to-update in one click" to the download result */
function decorateUpdateState(state: AppUpdateState): AppUpdateState {
  const required = requiredVersion ? { required: requiredVersion } : {};
  if (state.phase !== "ready") return { ...state, ...required };
  const key = releaseKey(state.update);
  const install = preparingUpdate === key
    ? "preparing"
    : stagedUpdate && releaseKey(stagedUpdate) === key ? "restart" : "manual";
  return { ...state, ...required, install, ...(install === "manual" && installBlockReason ? { installNote: installBlockReason } : {}) };
}

function publishUpdateState(): void {
  broadcast("update:state", decorateUpdateState(updater?.state() ?? { phase: "idle" }));
}

async function onUpdaterState(state: AppUpdateState): Promise<void> {
  await noteRequiredVersion(state).catch((error) => log("update-required-save-failed", { error: describeForLog(error) }));
  if (state.phase === "ready") {
    // Let prepareInstall first decide "can this machine replace automatically", then send the state to the UI.
    // Sending an "undecided" state before it makes the UI treat install as manual and pop up "Open installer" —
    // verification takes several seconds and the dialog text doesn't refresh itself, so the user is told something false: on 2026-09-23, 0.6.0 showed
    // this dialog on every upgrade, even though that machine could replace automatically, and clicking it went through one-click restart install.
    await prepareInstall(state);
    publishUpdateState();
    return;
  }
  // Version withdrawn, switched to another version, or errored with no usable package: the previously prepared copy is discarded
  if (state.phase !== "checking" && (stagedUpdate || installBlockReason)) {
    stagedUpdate = undefined;
    installBlockReason = undefined;
    await queueStagingWork(() => pruneStaging([]));
  }
  publishUpdateState();
}

/** Copy out and verify the new package right after download, so quitting only needs one rename, minimizing the window where "the app isn't there" */
async function prepareInstall(state: Extract<AppUpdateState, { phase: "ready" }>): Promise<void> {
  const key = releaseKey(state.update);
  if ((stagedUpdate && releaseKey(stagedUpdate) === key) || preparingUpdate === key) return;
  stagedUpdate = undefined;
  const bundle = runningBundle();
  // "Verifying" must be claimed before the first await: the UI may fetch state at any moment in between
  // (updates:state on startup, updates:check when clicking Check in "About"),
  // and getting "undecided" would be treated as manual, giving the false message "this computer can't replace automatically".
  preparingUpdate = key;
  publishUpdateState();
  installBlockReason = await installBlocker(bundle);
  if (installBlockReason || !bundle) {
    preparingUpdate = undefined;
    void log("update-install-unavailable", { reason: installBlockReason });
    publishUpdateState();
    return;
  }
  try {
    // The whole preparation (including its internal deletes) owns the staging directory exclusively and doesn't overlap with cleaning old versions
    const staged = await queueStagingWork(async () => {
      // Clear other versions' staging first: one .app on disk is over 300 MB, no need to keep it
      await pruneStaging([state.update.version]);
      return stageUpdate({
        dmg: state.file,
        version: state.update.version,
        workDir: stagingDirectory(state.update.version),
        currentBundle: bundle
      });
    });
    // The version changed again during preparation, so this copy can't be used
    const now = updater?.state();
    if (now?.phase === "ready" && releaseKey(now.update) === key) {
      stagedUpdate = { version: state.update.version, sha256: state.update.sha256, app: staged };
      void log("update-staged", { version: state.update.version, staged });
    }
  } catch (error) {
    installBlockReason = tm("main.update.stageFailed", { error: error instanceof Error ? error.message : String(error) });
    void log("update-stage-failed", { version: state.update.version, error: describeForLog(error) });
  } finally {
    preparingUpdate = undefined;
    publishUpdateState();
  }
}

/**
 * Called before the app quits. If the user clicked "Restart to update", swap and reopen;
 * otherwise, if a new version is prepared, swap it in too ("takes effect on next launch"), but don't reopen.
 */
async function runPendingInstall(): Promise<void> {
  const bundle = runningBundle();
  const ready = updater?.state();
  const plan = pendingInstall
    ?? (stagedUpdate && ready?.phase === "ready" && releaseKey(ready.update) === releaseKey(stagedUpdate)
      ? { staged: stagedUpdate.app, relaunch: false, update: { version: stagedUpdate.version, sha256: stagedUpdate.sha256 } }
      : undefined);
  if (!bundle) return;
  if (!plan) return renameBundleIfNeeded(bundle);
  if (plan.update) await updateHealth?.markInstalled(plan.update, release.displayVersion);
  const target = path.join(path.dirname(bundle), path.basename(plan.staged));
  await launchInstaller({
    directory: updatesDirectory(),
    pid: process.pid,
    current: bundle,
    target,
    staged: plan.staged,
    backup: path.join(rollbackDirectory(), path.basename(bundle)),
    relaunch: plan.relaunch
  });
  await log("update-install-launched", { current: bundle, target, staged: plan.staged, relaunch: plan.relaunch });
}

/**
 * The app bundle uses an English name (ADing.app / ADing Dev.app), so no Chinese directory is left on the user's computer.
 * The 0.7.0 installer installed new versions under the old name, so upgraded versions still live in "阿钉.app": rename on quit without interrupting use.
 * Leave it alone when installed in a read-only location (opened directly from the install disk, App Translocation).
 */
async function renameBundleIfNeeded(bundle: string): Promise<void> {
  const target = path.join(path.dirname(bundle), `${app.getName()}.app`);
  if (bundle === target || (await installBlocker(bundle))) return;
  if (await stat(target).then(() => true, () => false)) {
    await log("app-rename-skipped", { bundle, target, reason: "target exists" });
    return;
  }
  await launchInstaller({
    directory: updatesDirectory(), pid: process.pid, current: bundle, target, staged: "", backup: "", relaunch: false
  });
  await log("app-rename-launched", { from: bundle, to: target });
}

/**
 * The new version installed by OTA quit shortly after launch twice in a row: ask whether to roll back to the pre-update version.
 * Rollback uses the same replacement script, just with the "new package" being the old one in rollback.noindex/, swapping the two.
 */
async function offerRollbackIfNeeded(check: { offerRollback: boolean; previous?: string; rejectKey?: string }): Promise<void> {
  const bundle = runningBundle();
  if (!check.offerRollback || !bundle || !check.rejectKey || !updateHealth) return;
  const backup = await rollbackBundle(rollbackDirectory());
  if (!backup || (await installBlocker(bundle))) return;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: [tm("main.update.rollbackTo", { version: check.previous ?? tm("main.update.previousVersion") }), tm("main.update.keepUsing")],
    defaultId: 0,
    cancelId: 1,
    message: tm("main.update.crashedMessage", { version: release.displayVersion }),
    detail: tm("main.update.crashedDetail")
  });
  if (response !== 0) return;
  await updateHealth.reject(check.rejectKey);
  pendingInstall = { staged: backup, relaunch: true };
  await log("update-rollback-requested", { from: release.displayVersion, to: check.previous });
  app.quit();
}

/** The "Automation" page in System Settings: items previously set to "Don't Allow" can only be re-enabled here */
const AUTOMATION_SETTINGS_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

/** The respective System Settings pages for these two permissions */
const PERMISSION_SETTINGS_PANE: Record<ComputerPermissionKind, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
};

/**
 * Which system authorizations ADing has requested on this computer. The screen recording system prompt appears only once per app;
 * after "Deny", requesting again shows nothing — so remember it and send the user straight to System Settings next time instead of nothing happening on click.
 * After clearing system records with tccutil reset this still remembers, so that one time the prompt and System Settings appear together; only happens after a manual reset.
 */
function permissionRequestsFile(): string {
  return path.join(app.getPath("userData"), "data", "permission-requests.json");
}

async function permissionRequested(kind: ComputerPermissionKind): Promise<boolean> {
  try { return (JSON.parse(await readFile(permissionRequestsFile(), "utf8")) as Record<string, unknown>)[kind] === true; }
  catch { return false; }
}

/** Shows the system prompt and records that this item was requested */
async function requestPermissionAndRemember(kind: ComputerPermissionKind): Promise<void> {
  await requestComputerPermission(kind)
    .catch((error: unknown) => log("computer-permission-request-failed", { kind, error: describeForLog(error) }));
  try {
    const file = permissionRequestsFile();
    const saved = await readFile(file, "utf8").then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => ({}));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ...saved, [kind]: true }, null, 2), "utf8");
  } catch (error) {
    await log("computer-permission-remember-failed", { kind, error: describeForLog(error) });
  }
}

/**
 * The first time an Agent fails an operation due to a missing system permission, send the user to grant it.
 *
 * ADing has no permission-management UI of its own: permissions belong to the system. This does just two things —
 * first triggers the system's own authorization prompt (macOS shows it only on the first request, and the user can allow it right there),
 * then shows a window explaining why it's needed; confirming jumps straight to the corresponding System Settings page.
 * If the system already prompted and the user didn't allow it then, the first step fails silently and the jump is the only way out.
 */
async function grantComputerPermission(kind: ComputerPermissionKind): Promise<void> {
  await requestPermissionAndRemember(kind);
  const name = kind === "screenRecording" ? tm("main.systemPermission.screenRecording") : tm("main.systemPermission.accessibility");
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: [tm("main.systemPermission.openSettings"), tm("main.systemPermission.later")],
    defaultId: 0,
    cancelId: 1,
    message: tm("main.systemPermission.message", { name }),
    detail: kind === "screenRecording" ? tm("main.systemPermission.screenRecordingDetail") : tm("main.systemPermission.accessibilityDetail")
  });
  await log("computer-permission-prompted", { kind, openedSettings: response === 0 });
  if (response === 0) await shell.openExternal(PERMISSION_SETTINGS_PANE[kind]);
}

/** Before deleting or changing a path, first record the old knowledge copies to withdraw; if that can't be recorded, cancel entirely and wrap the underlying English system error (EACCES, etc.) in a bilingual explanation */
async function removeKnowledgeScope<T>(kind:"conversation"|"workspace",ownerId:string,resolution:Parameters<KnowledgeService["removeScope"]>[2],operation:()=>Promise<T>):Promise<T> {
  try { return await knowledge.removeScope(kind,ownerId,resolution,operation); }
  catch(error) {
    if(error instanceof KnowledgeRemovalRecordError)throw new Error(tm("main.knowledge.removalRecordFailed",{error:error.message}));
    throw error;
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

/**
 * Task sheet: hand the "who does what" arrangement to the app instead of having someone type it again every time.
 *
 * File lookup order: ADING_SEED environment variable → current directory → .ading/seed.json in the parent directory.
 * `pnpm start` runs inside desktop_mac, so the parent is exactly the repo root —
 * a project can carry its own task sheet that travels with the code.
 *
 * None of this may throw: a malformed task sheet at worst doesn't take effect; it must not stop the app from starting.
 */
let seedApplied = false;
let startingUp = true;
let quitting = false;
let quitComplete = false;

async function seedCandidates(): Promise<string[]> {
  const cwd = process.cwd();
  return [
    process.env.ADING_SEED,
    path.join(cwd, ".ading", "seed.json"),
    path.join(cwd, "..", ".ading", "seed.json")
  ].filter((value): value is string => Boolean(value));
}

async function maybeApplySeed(): Promise<void> {
  if (quitting || seedApplied) return;
  seedApplied = true;

  let raw: string | null = null;
  let from = "";
  for (const candidate of await seedCandidates()) {
    raw = await readFile(candidate, "utf8").catch(() => null);
    if (raw !== null) {
      from = candidate;
      break;
    }
  }
  if (raw === null) {
    await log("seed-none", { looked: await seedCandidates() });
    return;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    broadcast("seed:done", { error: p(`任务单不是合法 JSON：${String(error)}`, `The task sheet isn't valid JSON: ${String(error)}`) });
    return;
  }
  if (!isSeedDoc(doc)) {
    broadcast("seed:done", { error: p("任务单缺少 version 字段", "The task sheet is missing the version field") });
    return;
  }

  const agents: AgentsByKind = new Map();
  for (const [userId, discovered] of discoveredByUserId) {
    if (!agents.has(discovered.kind)) agents.set(discovered.kind, userId);
  }

  try {
    const result = await applySeed(store, agents, doc);
    await log("seed", { from, ...result });
    broadcast("seed:done", { from, ...result });

    // The opening message is already stored as sent by the person, but it didn't go through messages:send,
    // so the orchestrator hasn't been woken up — trigger it once here
    for (const conversationId of result.startedConversationIds) {
      const conversation = await store.getConversation(conversationId);
      if (!conversation) continue;
      const messages = await store.listMessages(conversationId, { limit: 1 });
      const opening = messages[messages.length - 1];
      if (!opening) continue;
      if (!startingUp) await scheduler.dispatch(conversation, opening);
    }
  } catch (error) {
    await log("seed-failed", { error: describeForLog(error) });
    broadcast("seed:done", { error: describeSeedError(error) });
  }
}

function describeSeedError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Agent integration
// ---------------------------------------------------------------------------

/**
 * Last connectivity check results. On startup, show the short-term cache first, then automatically run checks in parallel once the window is stable;
 * users can also explicitly recheck, and real task failures update the status. Sign-in and installation clear the corresponding cache.
 */
const verifyCache = new Map<
  AgentKind,
  { readiness: AgentReadiness; detail?: string; recovery?: AgentRecovery; checkedAt: string }
>();
const probeSession = new ProbeSession();
let catalogDiscovery: Awaited<ReturnType<AgentRegistry["discoverAll"]>> | undefined;
const verifyingAgentCounts = new Map<AgentKind, number>();
const VERIFY_CACHE_MAX_AGE_MS = 60 * 60_000;

/** MQTT connected: status and messages published by other computers arrive in real time */
let cloudConnected = false;
function isAgentReadyToParticipate(agent: UserRef): boolean {
  if (!agent.kind) return false;
  // Local Agents take no work until a forced upgrade completes; messages already received are kept and processed normally after the new version is installed
  if (requiredVersion && !agent.remote) return false;
  // Agents on other computers: that computer is online, and judged by the same rule using the status that computer published.
  // A computer being offline means all agents on it are unavailable, handled exactly like a local red-light agent
  // When this computer isn't connected to the cloud, other computers' status is stale and their messages can't be received: use only local Agents
  if (agent.remote) return cloudConnected && agent.remote.online && canAgentParticipate(agent.remote.readiness, { discovered: true, verifying: false });
  return canAgentParticipate(verifyCache.get(agent.kind)?.readiness, {
    discovered: discoveredByUserId.has(agent.userId),
    verifying: (verifyingAgentCounts.get(agent.kind) ?? 0) > 0
  });
}

/**
 * A local Agent's availability isn't settled yet: being checked, not yet checked, or installed locally but not yet registered in the current data layer (just signed in, just switched data sessions).
 * Messages arriving in this state are recorded by the scheduler and dispatched once the check makes it available, rather than dropped as unavailable.
 * Not installed locally, forced upgrade incomplete, and agents on other computers don't count.
 */
function isAgentAwaitingVerification(agent: UserRef): boolean {
  if (!agent.kind || agent.remote || requiredVersion) return false;
  if (catalogDiscovery && !catalogDiscovery.agents.some((item) => item.kind === agent.kind)) return false;
  if (!discoveredByUserId.has(agent.userId)) return true;
  return (verifyingAgentCounts.get(agent.kind) ?? 0) > 0 || !verifyCache.has(agent.kind);
}

function beginAgentVerification(kind: AgentKind): void {
  verifyingAgentCounts.set(kind, (verifyingAgentCounts.get(kind) ?? 0) + 1);
}

function endAgentVerification(kind: AgentKind): void {
  const remaining = (verifyingAgentCounts.get(kind) ?? 1) - 1;
  if (remaining > 0) verifyingAgentCounts.set(kind, remaining);
  else verifyingAgentCounts.delete(kind);
}

function verifyCacheFile(): string {
  return path.join(app.getPath("userData"), "data", "agent-readiness.json");
}

async function loadVerifyCache(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(verifyCacheFile(), "utf8")) as Partial<
      Record<AgentKind, { readiness?: AgentReadiness; detail?: string; recovery?: AgentRecovery; checkedAt?: string }>
    >;
    const now = Date.now();
    for (const kind of ["codex", "claude-code", "qoder", "qoder-cn", "qwen-code", "kiro", "copilot", "antigravity"] as AgentKind[]) {
      const entry = parsed[kind];
      const checkedAt = entry?.checkedAt;
      if (!entry?.readiness || !checkedAt) continue;
      if (now - new Date(checkedAt).getTime() > VERIFY_CACHE_MAX_AGE_MS) continue;
      const readiness = (entry.readiness === "error" || entry.readiness === "unauthorized") && entry.detail?.trim()
        ? classifyReadiness(true, { ok: false, text: entry.detail ?? "" }).readiness
        : entry.readiness;
      verifyCache.set(kind, {
        readiness,
        detail: entry.detail,
        recovery: readiness==='ready'?undefined:entry.recovery,
        checkedAt
      });
    }
  } catch {
    // On first launch or when the old cache is corrupt, just recheck.
  }
}

async function saveVerifyCache(): Promise<void> {
  try {
    const file = verifyCacheFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(Object.fromEntries(verifyCache), null, 2), "utf8");
  } catch {
    // Failing to write the cache doesn't affect the Agent's own work.
  }
  scheduleAgentStatePublish();
}

/**
 * Data for the Agent integration page.
 *
 * The skeleton is "which vendors we support" — **independent of whether they're installed locally**. Installation only decides the light's color.
 * This is the core of this version's design: an empty list shouldn't leave people confused; it should tell them what's supported, what's missing, and what to click next.
 */
async function buildAgentCatalog(refresh = false): Promise<AgentStatus[]> {
  if (refresh) catalogDiscovery = await probeSession.stable(() => registry.discoverAll());
  const discovery = catalogDiscovery ?? await probeSession.stable(() => registry.discoverAll());
  catalogDiscovery = discovery;
  const byKind = new Map(discovery.agents.map((item) => [item.kind, item]));
  const noticeByKind = new Map(
    discovery.setupNotices.map((notice) => [notice.kind, notice])
  );
  const known = await store.listKnownAgents();

  return registry.describeAll().map((meta) => {
    const found = byKind.get(meta.kind);
    const user = known.find((item) => item.kind === meta.kind && !item.remote);
    const cached = verifyCache.get(meta.kind);
    const classified = classifyReadiness(
      Boolean(found),
      cached ? { ok: cached.readiness === "ready", text: cached.detail ?? "" } : undefined
    );

    return {
      kind: meta.kind,
      label: meta.label,
      installed: Boolean(found),
      executablePath: found?.executablePath,
      version: found?.version,
      // If the cache has a more specific verdict (e.g. unauthorized), use it;
      // classifyReadiness is only a fallback when never checked
      readiness: found && cached ? cached.readiness : classified.readiness,
      // When no usable CLI is found but there's a "file exists but won't run" reason, put it in detail so it shows on hover
      detail: found ? (cached?.detail ?? found.executablePath) : discovery.probeFailures?.[meta.kind],
      recovery: found ? cached?.recovery : undefined,
      installHint: meta.installHint,
      loginHint: meta.loginHint,
      logoutHint: meta.logoutHint,
      docsUrl: meta.docsUrl,
      userId: user?.userId,
      added: user ? user.enabled !== false : false,
      displayName: user?.displayName,
      // Not installed, but the vendor App exists — this row should say "open Code once in Claude",
      // rather than asking them to install something they already have
      setupNotice: found ? undefined : noticeByKind.get(meta.kind),
      cliMissing: !found && (discovery.cliMissing ?? []).includes(meta.kind),
      checkedAt: cached?.checkedAt
    } satisfies AgentStatus;
  });
}

/** When a vendor CLI is denied reading/writing its own directory, record the scene in the diagnostics log (see support/access-diagnostics.ts). Doesn't block the caller */
function recordAccessDenied(kind: AgentKind, error: string, during: "verify" | "turn"): void {
  if (!ACCESS_DENIED.test(error)) return;
  void collectAccessDiagnostics(kind)
    .then((details) => log("agent-access-denied", { during, error: error.slice(0, 500), ...details }))
    .catch((cause) => log("agent-access-denied", { during, kind, error: error.slice(0, 500), diagnosticsFailed: describeForLog(cause) }));
}

/** Runs a real connectivity check for one vendor. Results are cached on disk briefly to avoid spending model quota again on every restart. */
function verifyAgent(kind: AgentKind): Promise<AgentStatus[]> {
  return probeSession.single(kind, async () => {
    beginAgentVerification(kind);
    try {
      const result = await probeSession.stable(async () => {
        const epoch = probeSession.epoch;
        const discovery = await registry.discoverAll();
        const found = discovery.agents.find(item => item.kind === kind);
        if (!found || !probeSession.isCurrent(epoch)) return { discovery, found, outcome: undefined };
        const known = await store.listKnownAgents();
        const modelConfig = known.find(agent => agent.kind === kind && !agent.remote)?.modelConfig;
        let outcome = await registry.verify(found, modelConfig);
        // One bounded retry for transport failures and errors the vendor itself calls temporary
        // (e.g. Qoder's "temporarily could not read your saved login (EPERM). Retry the previous command.");
        // never retry explicit quota/auth errors.
        if (probeSession.isCurrent(epoch) && !outcome.ok && classifyReadiness(true, outcome).readiness === "error" &&
            /超时|超过.*秒|timeout|timed?\s*out|ECONN|ENOTFOUND|network|fetch failed|connection.*(reset|closed)|temporar|retry the previous|\bE(PERM|ACCES|BUSY|AGAIN)\b/i.test(outcome.text)) {
          await log("verify-retry", { kind, reason: outcome.text.slice(0, 120) });
          await new Promise(resolve => setTimeout(resolve, 800));
          if (probeSession.isCurrent(epoch)) outcome = await registry.verify(found, modelConfig);
        }
        return { discovery, found, outcome };
      });
      catalogDiscovery = result.discovery;
      if (!result.found || !result.outcome) {
        verifyCache.delete(kind);
        await log("verify", { kind, result: "missing" });
      } else {
        const { readiness, detail } = classifyReadiness(true, result.outcome);
        verifyCache.set(kind, { readiness, detail: detail ?? result.found.executablePath,
          recovery:result.outcome.ok?undefined:result.outcome.recovery, checkedAt: new Date().toISOString() });
        await log("verify", { kind, readiness, detail: detail?.slice(0, 200) });
        if (!result.outcome.ok) recordAccessDenied(kind, result.outcome.text, "verify");
      }
      await saveVerifyCache();
      return buildAgentCatalog();
    } finally {
      endAgentVerification(kind);
      await scheduler.pauseUnavailableAgents(kind);
      await scheduler.resumeReadyAgents();
      await scheduler.teamAvailabilityChanged();
      memoryNotify?.catchUp(kind);skillFallback?.catchUp(kind);
    }
  });
}

/** Discovers local agents and registers them in the Store, returning the registered user list */
async function refreshDiscovery(): Promise<UserRef[]> {
  if (quitting) return [];
  const result = await probeSession.stable(() => registry.discoverAll());
  catalogDiscovery = result;
  return applyDiscovery(result);
}

/**
 * Registers locally discovered agents in the **current** data layer and rebuilds the userId → local agent map.
 * Must be done again for the new data layer after switching data sessions: otherwise the map still points to the old layer's userIds,
 * the new data layer doesn't have these agents, and they can't be added in the UI.
 */
async function applyDiscovery(result: NonNullable<typeof catalogDiscovery>): Promise<UserRef[]> {
  const discovered = result.agents;
  const known=await store.listKnownAgents();
  for(const agent of discovered) {
    const previous=known.find(user=>user.localUuid===agent.localUuid);
    // The last selection read from the vendor app survives a restart, so the very
    // first turn after launch still uses it instead of the CLI's own default.
    // The user's ADing selection stays out of it: this value is what the vendor app says.
    agent.runtimeDefaults=await resolveRuntimeConfig({
      remembered:previous?.runtimeDefaults,native:async()=>agent.runtimeDefaults});
  }
  const users = await store.syncDiscoveredAgents(discovered);
  discoveredByUserId.clear();
  for (const user of users) {
    const match = discovered.find((d) => d.localUuid === user.localUuid);
    if (match) discoveredByUserId.set(user.userId, match);
  }
  await knowledge.refresh().catch(error=>log("knowledge-sync-failed",{error:String(error)}));
  memoryNotify?.catchUp();skillFallback?.catchUp();
  // Installing or uninstalling is also an agent status change and must be synced to other computers like check results
  scheduleAgentStatePublish();
  // Messages that arrived before registration (backfilled right after sign-in) are waiting for this step: agents already checked as available get them dispatched now
  void scheduler.resumeReadyAgents().catch((error) => log("agent-resume-failed", { error: describeForLog(error) }));
  await log("discovery", {
    found: discovered.map((d) => ({
      kind: d.kind,
      version: d.version,
      path: d.executablePath
    })),
    // Finding none at all is the most common "why is nothing happening", so flag it separately
    empty: discovered.length === 0
  });
  return users;
}

/**
 * Root of temporary directories for "quick" conversations.
 *
 * Deliberately not the user's home directory: agents can run commands and modify files in the working directory,
 * and handing over all of $HOME is too broad. Each quick conversation gets **its own slot** under here (by conversationId),
 * not a shared directory — two unrelated things sharing a working directory would overwrite each other's files.
 */
const SCRATCH_DIR_NAME = "inbox";

function adingRoot(): string {
  return path.join(app.getPath("documents"), "ADing");
}

function scratchRoot(): string {
  return path.join(adingRoot(), SCRATCH_DIR_NAME);
}

/**
 * Translates a conversation into "where to work and which layers of shared knowledge are visible".
 *
 * Every place that runs an agent gets this from here; don't assemble paths separately —
 * scattered rules inevitably lead to "inbox checked here but not there".
 */
async function resolveFor(
  conversation: Conversation
): Promise<WorkspaceResolution> {
  const workspace = await store.getWorkspace(conversation.workspaceId);
  const resolution = resolveWorkspace(conversation, workspace, scratchRoot());
  // The agent's cwd must really exist, otherwise codex won't start at all
  await mkdir(resolution.workspacePath, { recursive: true }).catch(() => undefined);
  return resolution;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  // While switching data sessions, data-dependent requests wait until the new session is ready, to avoid reading half-old, half-new data
  const dataChannel = /^(app:bootstrap|lists:|workspaces:|agents:|contacts:|friends:|conversations:|messages:|skills:|memories:|permissions:|sync:)/;
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (dataChannel.test(channel)) await dataReady;
      if (/^conversations:(add-member|set-role|report|remove-member|update|delete|archive)$/.test(channel)) {
        await requireConversationWriter(store, args[0]);
      } else if (channel === "conversations:stop" || channel === "conversations:resume") {
        await requireConversationController(store, args[0]);
      } else if (channel === "messages:send") {
        await requireConversationWriter(store, args[0].conversationId);
      }
      return listener(event, ...args);
    });
  };
  handle("lists:page", async (_event, kind: string, ids: string[]) => {
    if (!["contacts", "conversations", "switcher"].includes(kind) || !Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error(tm("main.list.invalidPage"));
    const requested = [...new Set(ids)].slice(0, kind === "switcher" ? 10 : 100);
    if (kind === "contacts") {
      const contacts = new Map((await store.listContacts()).map(item => [item.userId, item]));
      return requested.flatMap(id => contacts.has(id) ? [contacts.get(id)!] : []);
    }
    const conversations = await Promise.all(requested.map(id => store.getConversation(id)));
    return conversations.filter(item => item !== null);
  });
  handle("permissions:get-mode",()=>permissionPolicy.get());
  handle("permissions:set-mode",(_event,mode:PermissionMode)=>permissionPolicy.set(mode));
  handle("app:bootstrap", async (event) => ({
    windowActive:windowCanRead(BrowserWindow.fromWebContents(event.sender)),
    permissionMode: await permissionPolicy.get(),
    mode: store.mode,
    me: await store.currentUser(),
    contacts: await store.listContacts(),
    workspaces: await store.listWorkspaces(),
    conversations: await store.listConversations(),
    runtime: withRemoteRuntime(scheduler.runtimeSnapshot())
  }));
  handle("account:onboarding", (_event, steps?: number) => {
    if (steps !== undefined && (!Number.isInteger(steps) || steps < 0 || steps > 255)) throw new Error("Invalid onboarding progress");
    return account.api(steps === undefined ? "GET" : "POST", "/api/v1/auth/onboarding", steps === undefined ? undefined : { completedSteps: steps });
  });
  handle("account:status", async () => {
    const previous = account.status();
    const status = await account.refreshRegionPermissions();
    // If the permission query finds the token invalid, sign-in state and the data layer still fall back to offline together.
    if (previous.signedIn && !status.signedIn) {
      await switchDataSession({ kind: "local" });
      broadcast("account:changed", status);
    }
    return status;
  });
  // The computer registered in the cloud for this machine. The UI uses it to label local agents with their computer, distinguishing them from same-named agents on other computers
  handle("account:computer", () => {
    const computer = account.computer();
    return computer ? { computerId: computer.terminalId, name: computer.name } : null;
  });
  handle("account:login", async (_event, username: unknown, password: unknown) => {
    const result = await account.login(String(username ?? ""), String(password ?? ""));
    if (!result.ok || !result.status.signedIn) return result;
    try {
      await switchDataSession({ kind: "account", userId: result.status.user.userId });
    } catch (error) {
      // Account data can't be opened: fall back to signed out, keeping sign-in state and data consistent
      await account.logout();
      broadcast("account:changed", account.status());
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: tm("main.account.switchFailed", { message }) } satisfies AccountResult;
    }
    void registerComputerInBackground();
    return publishAccount(result);
  });
  // Registration doesn't change sign-in state; no broadcast needed
  handle("account:register", async (_event, username: unknown, password: unknown) =>
    account.register(String(username ?? ""), String(password ?? ""))
  );
  handle("account:logout", async () => {
    const status = await account.logout();
    await switchDataSession({ kind: "local" }).catch((error) =>
      log("data-session-switch-failed", { error: describeForLog(error) })
    );
    broadcast("account:changed", status);
    return status;
  });
  // The signed-in account's own profile is authoritative in the cloud, with a local cache (separate from the offline edition's own profile); there is no such profile when signed out
  handle("account:profile", async () => {
    const status = account.status();
    if (!status.signedIn) return null;
    const remote = await account.api("GET", "/api/v1/profile");
    // Use the local cache when the cloud is unreachable
    if (!remote.ok) return accountProfiles.get(status.user);
    const profile = remote.data as { displayName?: string; avatarUrl?: string; phone?: string; email?: string };
    return accountProfiles
      .update(status.user, {
        displayName: profile.displayName || status.user.displayName,
        avatarUrl: profile.avatarUrl ?? "",
        phone: profile.phone ?? "",
        email: profile.email ?? ""
      })
      .catch(() => accountProfiles.get(status.user));
  });
  handle("account:update-profile", async (_event, patch: Record<string, unknown>) => {
    const status = account.status();
    if (!status.signedIn) throw new Error(tm("main.account.expired"));
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    // First validate with the same rules as the cloud and save to the local cache, then upload; if unreachable, add to the pending-sync queue and upload once online
    const saved = await accountProfiles.update(status.user, {
      displayName: text(patch?.displayName),
      avatarUrl: text(patch?.avatarUrl),
      phone: text(patch?.phone),
      email: text(patch?.email)
    });
    const body = {
      displayName: saved.displayName,
      avatarUrl: saved.avatarUrl ?? "",
      phone: saved.phone ?? "",
      email: saved.email ?? ""
    };
    const remote = await account.api("PUT", "/api/v1/profile", body);
    if (!remote.ok) {
      if (remote.kind === "rejected") throw new Error(remote.message);
      if (store instanceof CloudStore) await store.enqueueProfile(body);
    }
    return saved;
  });
  /**
   * Changes the account password. The password lives only in the cloud and isn't cached locally, so this must succeed online right away;
   * it can't go into the pending-sync queue like the profile — an old password uploaded late from the queue would change the account to a value the user doesn't know.
   */
  handle("account:change-password", async (_event, current: string, next: string) => {
    const status = account.status();
    if (!status.signedIn) throw new Error(tm("main.account.expired"));
    const changed = await account.changePassword(current, next);
    if (!changed.ok) throw new Error(changed.message);
    // Changing the password invalidates this computer's token; re-register to get a new one, or online push can't connect
    void registerComputerInBackground();
    return true;
  });
  // Number of changes not yet synced to the cloud; not applicable to the offline edition
  handle("sync:pending", () => (store instanceof CloudStore ? store.pendingCount() : 0));
  const linkPreviews = new LinkPreviews();
  handle("app:link-preview", (_event, url: string) => linkPreviews.get(url));
  handle("app:open-external", async (_event, rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(tm("main.link.httpOnly"));
    }
    await shell.openExternal(url.toString());
  });

  handle("app:reveal-artifact", async (_event, target: string, conversationId?: string) => {
    if (typeof target !== "string") throw new Error(tm("main.file.invalidPath"));
    const conversation = typeof conversationId === "string" ? await store.getConversation(conversationId) : null;
    const resolution = conversation ? resolveWorkspace(conversation, await store.getWorkspace(conversation.workspaceId), scratchRoot()) : undefined;
    const file = resolveArtifactPath(target, resolution);
    if (!file) throw new Error(tm("main.file.invalidPath"));
    await stat(file);
    shell.showItemInFolder(file);
  });

  // ---- Version updates ----
  handle("app:info", () => ({ version: release.displayVersion, channel: release.channel }));
  handle("app:set-language", (_event, language: unknown) => setMainLanguage(language));
  handle("power:get-keep-awake", () => keepAwake);
  handle("power:set-keep-awake", (_event, value: unknown) => {
    keepAwake = value !== false;
    writePreference(preferencesFile(), "keepAwake", keepAwake);
    sleepGuard.refresh();
    return keepAwake;
  });
  /**
   * "System authorizations" under Settings → Permissions: which system authorizations ADing already has on this computer. **Query only, never show any prompt**.
   * When another computer dispatches work remotely, nobody is at this computer to click the system prompt and the task gets stuck, so check and authorize while someone is present.
   */
  handle("permissions:check", async () => {
    const result = await checkComputerPermissions();
    void log("permissions-checked", result);
    return {
      accessibility: result.accessibility,
      screenRecording: result.screenRecording,
      screenRecordingRequested: await permissionRequested("screenRecording"),
      automation: AUTOMATION_TARGETS.map((target) => ({ bundleId: target.bundleId, name: target.name, status: result.automation[target.bundleId] }))
    };
  });
  /** The user clicked an item's button in "System authorizations": user-initiated, so only now may the system prompt be shown */
  handle("permissions:grant", async (_event, item: unknown) => {
    if (item === "accessibility" || item === "screenRecording") {
      // Only show the system prompt: it also registers ADing in the System Settings list and has its own "Open System Settings" button,
      // which the user clicks themselves. ADing no longer opens System Settings separately, to avoid two windows stacking.
      // The exception is screen recording that was already requested: the system won't prompt again, so we can only send the user to System Settings.
      const askedBefore = item === "screenRecording" && await permissionRequested(item);
      await requestPermissionAndRemember(item);
      if (askedBefore) await shell.openExternal(PERMISSION_SETTINGS_PANE[item]);
      void log("permission-grant-requested", { item });
      return null;
    }
    const target = AUTOMATION_TARGETS.find((candidate) => candidate.bundleId === item);
    if (!target) throw new Error(`unknown permission item: ${String(item)}`);
    const status = await requestAutomation(target.bundleId);
    void log("automation-grant-requested", { bundleId: target.bundleId, status });
    // Items previously set to "Don't Allow" won't be asked again by the system; they can only be enabled under "Automation" in System Settings
    if (status === "denied") await shell.openExternal(AUTOMATION_SETTINGS_PANE);
    return status;
  });
  /** Authorized or previously denied items: open the corresponding System Settings page and let the user turn it on or off */
  handle("permissions:open-settings", async (_event, item: unknown) => {
    const pane = item === "accessibility" || item === "screenRecording" ? PERMISSION_SETTINGS_PANE[item]
      : AUTOMATION_TARGETS.some((target) => target.bundleId === item) ? AUTOMATION_SETTINGS_PANE : undefined;
    if (!pane) throw new Error(`unknown permission item: ${String(item)}`);
    await shell.openExternal(pane);
    void log("permission-settings-opened", { item });
    return null;
  });
  handle("telemetry:ready", () => foregroundTelemetry.markReady());
  handle("updates:state", () => decorateUpdateState(updater?.state() ?? { phase: "idle" }));
  handle("updates:check", async () => decorateUpdateState(await (updater?.check() ?? { phase: "idle" as const })));
  /** Restart now and switch to the new version. If tasks are running, ask first — interrupting a task costs more than installing a few minutes later */
  handle("updates:install", async (event) => {
    const state = updater?.state();
    if (state?.phase !== "ready" || !stagedUpdate || releaseKey(stagedUpdate) !== releaseKey(state.update)) {
      throw new Error(tm("main.update.notReady"));
    }
    if (agentsAreBusy() && !(await confirmInterruption(event, {
      message: tm("main.update.conversationsRunning"),
      detail: tm("main.update.conversationsRunningDetail"),
      confirm: tm("main.update.restart")
    }))) return { started: false };
    pendingInstall = {
      staged: stagedUpdate.app,
      relaunch: true,
      update: { version: stagedUpdate.version, sha256: stagedUpdate.sha256 }
    };
    void log("update-install-requested", { version: stagedUpdate.version });
    app.quit();
    return { started: true };
  });
  /**
   * Manual install: open the installer the updater itself downloaded and verified, **and quit ADing**.
   *
   * Without quitting this path doesn't work: when dragging ADing from the installer into Applications, macOS says
   * "The item 'ADing' is in use" and refuses to overwrite, so the user would have to quit the app first and drag again.
   * This path is already the fallback when auto-replace is unavailable (dev, package on a read-only volume, no write permission),
   * and those are exactly the times not to make the user take another detour.
   *
   * Accepts only the updater's own state.file, never a path passed from the renderer.
   */
  handle("updates:open-package", async (event) => {
    const state = updater?.state();
    if (state?.phase !== "ready") throw new Error(tm("main.update.noDownload"));
    if (!(await confirmInterruption(event, {
      message: tm("main.update.manualMessage"),
      detail: agentsAreBusy()
        ? `${tm("main.update.manualBusyNote")}\n\n${tm("main.update.manualDetail")}`
        : tm("main.update.manualDetail"),
      confirm: tm("main.update.quitToInstall")
    }))) return { started: false };
    const error = await shell.openPath(state.file);
    if (error) throw new Error(error);
    void log("update-manual-install", { version: state.update.version, file: state.file });
    // Give Finder a moment to mount and show the window, so the user doesn't see a blank screen first
    setTimeout(() => app.quit(), 1200);
    return { started: true };
  });

  // ---- Help and support ----
  handle("support:capture-screenshot", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return null;
    const captured = await window.webContents.capturePage();
    const size = captured.getSize();
    const image = size.width > 1400
      ? captured.resize({ width: 1400, quality: "good" })
      : captured;
    const data = image.toJPEG(82);
    return {
      name: `阿钉截图-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
      mimeType: "image/jpeg",
      dataUrl: `data:image/jpeg;base64,${data.toString("base64")}`
    } satisfies SupportImagePayload;
  });

  handle(
    "support:submit-report",
    async (_event, input: SupportReportInput) => {
      const logs = await supportLogSnapshots();
      const logArchive = await supportLogArchive();
      const result = await supportReports.enqueue(input, {
        appVersion: release.displayVersion,
        platform: process.platform,
        arch: process.arch,
        mode: store.mode,
        ...(await supportIdentity()),
        logs,
        logArchive
      });
      const backgroundUpload = Boolean(supportUploadWorker);
      if (backgroundUpload) supportUploadWorker?.postMessage("wake");
      await log("support-report-queued", {
        reportId: result.reportId,
        logFiles: logArchive?.fileCount ?? 0,
        logArchiveBytes: logArchive?.packedBytes ?? 0
      });
      return { ...result, backgroundUpload };
    }
  );

  handle(
    "support:contact-developer",
    async (_event, input: DeveloperContactInput) => {
      const result = await developerContacts.enqueue(input, {
        appVersion: release.displayVersion,
        platform: process.platform,
        arch: process.arch,
        mode: store.mode,
        ...(await supportIdentity())
      });
      const backgroundUpload = enabledSupportUploads.has("developer");
      if (backgroundUpload) supportUploadWorker?.postMessage("wake");
      await log("developer-contact-queued", { contactId: result.contactId });
      return { ...result, backgroundUpload };
    }
  );


  // ---- Workspaces ----
  handle("workspaces:list", () => store.listWorkspaces());
  handle(
    "workspaces:create",
    (_event, input: { name: string; path: string }) =>
      store.createWorkspace(input)
  );
  handle(
    "workspaces:update",
    async (_event, workspaceId: string, patch: Record<string, unknown>) => {
      const workspace=await store.getWorkspace(workspaceId);
      if(!workspace?.path||!("path" in patch))return store.updateWorkspace(workspaceId,patch);
      return removeKnowledgeScope("workspace",workspaceId,{workspacePath:workspace.path,sharesKnowledge:true,knowledgeOwnerId:workspaceId},()=>store.updateWorkspace(workspaceId,patch));
    }
  );
  handle("workspaces:delete", async (_event, workspaceId: string) => {
    const workspace=await store.getWorkspace(workspaceId);
    if(!workspace?.path)return store.deleteWorkspace(workspaceId);
    return removeKnowledgeScope("workspace",workspaceId,{workspacePath:workspace.path,sharesKnowledge:true,knowledgeOwnerId:workspaceId},()=>store.deleteWorkspace(workspaceId));
  });
  /** Pick a directory to create a workspace. Creates it right after picking, saving the "pick a directory then fill a form" two steps */
  // ---- Attachments: copy into the local attachments directory first; messages carry only metadata ----
  const importAttachments = async (paths: string[]) => {
    const attachments: Attachment[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    for (const file of paths.slice(0, MAX_ATTACHMENTS)) {
      try {
        attachments.push(await store.importAttachment(file));
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        rejected.push({
          name: path.basename(file),
          reason: code === "ATTACHMENT_TOO_LARGE" ? tm("main.attachment.tooLarge") : code === "ATTACHMENT_NOT_FILE" ? tm("main.attachment.notFile") : describeForLog(error)
        });
      }
    }
    if (paths.length > MAX_ATTACHMENTS) rejected.push({ name: "", reason: tm("main.attachment.tooMany") });
    return { attachments, rejected };
  };
  handle("attachments:pick", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: tm("main.attachment.pickTitle"),
      properties: ["openFile" as const, "multiSelections" as const]
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return { attachments: [], rejected: [] };
    return importAttachments(result.filePaths);
  });
  // Files dragged into the input box
  handle("attachments:import-paths", (_event, paths: string[]) =>
    importAttachments(Array.isArray(paths) ? paths.filter((item) => typeof item === "string") : []));
  // Pasted screenshots: no original file, only content
  handle("attachments:import-data", (_event, name: string, mimeType: string, bytes: Uint8Array) =>
    store.importAttachmentData(String(name || "image.png"), String(mimeType || ""), bytes));
  // Open with the system default app; in the online edition, attachments from other clients are downloaded first
  handle("attachments:open", async (_event, conversationId: string | null, attachment: Attachment) => {
    const file = await store.attachmentFile(conversationId ?? "", attachment);
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });
  handle("attachments:save", async (event, conversationId: string | null, attachment: Attachment) => {
    const attachmentStore = store;
    const parent = BrowserWindow.fromWebContents(event.sender);
    const directory = new AttachmentSaveDirectory(path.join(app.getPath("userData"), "attachment-save.json"), app.getPath("downloads"));
    return saveAttachmentFile({
      name: attachment.name,
      sourceFile: () => attachmentStore.attachmentFile(conversationId ?? "", attachment),
      chooseDestination: async name => {
        const options = {
          title: tm("main.attachment.downloadTitle"), buttonLabel: tm("main.attachment.downloadButton"),
          nameFieldLabel: tm("main.attachment.fileName"), defaultPath: await directory.defaultPath(name)
        };
        const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        return result.canceled ? undefined : result.filePath;
      },
      // The image is already saved; a preference error must not report export failure.
      onSaved: destination => directory.remember(destination).catch(error =>
        log("attachment-save-directory-failed", { error: describeForLog(error) }))
    });
  });

  handle("workspaces:pick", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: tm("main.workspace.pickTitle"),
      properties: ["openDirectory" as const, "createDirectory" as const],
      buttonLabel: tm("main.workspace.pickButton")
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return null;
    return store.createWorkspace({ name: path.basename(dir) || dir, path: dir });
  });

  handle("agents:discover", async () => {
    // No longer auto-create one-on-one chats — a task's granularity is one thing, not "a chat window with someone".
    // Conversations are created explicitly by the user, since several things can be going on with the same agent at once.
    const users = await refreshDiscovery();
    await maybeApplySeed().catch(() => undefined);
    return {
      agents: users,
      conversations: await store.listConversations()
    };
  });

  /**
   * The action for "vendor App installed, but the command line isn't working".
   *
   * Only does deterministic things: open the vendor App and let the user finish its own enablement flow inside it.
   *
   * There used to be another branch here: lift the sandbox for an agent with write permission and let it
   * "install Qoder CLI with the official script". I removed it, for three reasons:
   *   1. It granted very broad permission (fullAccess) for a very narrow, definite goal (running one install command),
   *      and "don't use sudo, don't touch project files" was just a sentence in the prompt, not a constraint.
   *   2. The executor is nondeterministic: if installation fails halfway, nobody can say what state the machine is in.
   *   3. Circular dependency: on a new machine with only Qoder installed, there's no usable helper to install it.
   * If needed, "have Xiao C install Qoder" should be a normal conversation task in ADing —
   * that way there's a full conversation record and it can be interrupted any time with the task's pause and stop buttons,
   * rather than a full delegation hidden behind a button.
   */
  handle("agents:enable-setup", async (_event, kind: AgentKind) => {
    const target: Partial<Record<AgentKind, string>> = {
      "claude-code": "/Applications/Claude.app"
    };
    const appPath = target[kind];
    if (!appPath) {
      throw new Error(tm("main.agent.manualInstall"));
    }
    const error = await shell.openPath(appPath);
    if (error) throw new Error(error);
    verifyCache.delete(kind);
    await saveVerifyCache();
    return {
      ok: true,
      message: tm("main.agent.claudeOpened")
    };
  });

  handle("agents:model-catalog", (_event, userId: string): Promise<AgentModelCatalog> => agentModels().catalog(userId));
  handle("agents:set-model", (_event, userId: string, modelId: string | null) => agentModels().set(userId, modelId));
  handle(
    "agents:update",
    (_event, userId: string, patch: Record<string, unknown>) =>
      store.updateAgent(userId, patch)
  );
  handle(
    "contacts:update",
    (_event, userId: string, patch: Record<string, unknown>) =>
      store.updateContact(userId, patch)
  );
  handle("contacts:list", () => store.listContacts());
  handle("contacts:delete", (_event, userId: string) =>
    store.deleteContact(userId)
  );

  // ---- Human friends (online edition only; the offline edition has no account, the entry is hidden, and this always returns empty) ----
  const cloud = (): CloudStore => {
    if (!(store instanceof CloudStore)) throw new Error(tm("main.friends.offline"));
    return store;
  };
  handle("friends:share-agent", (_event, agentId: string, recipientId: string, shared: boolean) => cloud().shareAgent(String(agentId), String(recipientId), shared === true));
  handle("friends:requests", () => store instanceof CloudStore ? store.listFriendRequests() : []);
  handle("friends:search", (_event, query: string) => cloud().searchPeople(String(query ?? "")));
  handle("friends:request", (_event, userId: string) => cloud().requestFriend(String(userId)));
  handle("friends:accept", (_event, userId: string) => cloud().acceptFriend(String(userId)));
  handle("friends:dismiss", (_event, userId: string) => cloud().dismissFriendRequest(String(userId)));

  // ---- Agent integration page ----
  /** The instant part: which vendors are supported, installed or not, what version. Pure file system, no processes */
  handle("agents:catalog", (_event, refresh = false) => buildAgentCatalog(refresh === true));
  /** The slow part: actually send a minimal call to confirm sign-in and that parameters are accepted */
  handle("agents:verify", (_event, kind: AgentKind) => verifyAgent(kind));
  handle("agents:refresh-one", async (_event, userId: string) => {
    const agent = await store.getUser(userId);
    if (!agent?.isAgent || !agent.kind) throw new Error(tm("main.store.agentMissing"));
    if (agent.remote) {
      if (!(store instanceof CloudStore)) throw new Error(tm("main.friends.offline"));
      await store.requestAgentVerification(userId);
      return { requested: true, catalog: null };
    }
    return { requested: false, catalog: await verifyAgent(agent.kind) };
  });
  handle("agents:auth-status", (_event, kind: AgentKind) =>
    registry.authStatus(kind)
  );
  handle(
    "agents:install",
    async (_event, kind: AgentKind, confirmed: boolean) => {
      const result = await registry.install(kind, confirmed, (text, download) =>
        broadcast("agent:lifecycle-progress", { kind, action: "install", text, download })
      );
      if (result.ok) {
        verifyCache.delete(kind);
        await saveVerifyCache();
      }
      // An App can be installed even when its separate CLI installation failed.
      if (confirmed) await refreshDiscovery();
      return result;
    }
  );
  handle(
    "agents:login",
    async (_event, kind: AgentKind, confirmed: boolean) => {
      const result = await registry.login(kind, confirmed, (text) =>
        broadcast("agent:lifecycle-progress", { kind, action: "login", text })
      );
      if(result.ok){
        broadcast("agent:lifecycle-progress", {kind,action:"login",text:tm("main.agent.loginVerifying")});
        verifyCache.delete(kind);
        await saveVerifyCache();
        await refreshDiscovery();
        result.verification=(await verifyAgent(kind)).find(status=>status.kind===kind);
      }
      return result;
    }
  );
  handle(
    "agents:cancel-lifecycle",
    (_event, kind: AgentKind, action: AgentLifecycleAction) =>
      registry.cancelLifecycle(kind, action)
  );
  /**
   * Add as contact / remove.
   *
   * Removing doesn't delete data — it may have a bunch of conversations and threads under it, and deleting would break history.
   * It's only removed from contacts and the member picker.
   */
  handle(
    "agents:set-added",
    async (_event, kind: AgentKind, added: boolean) => {
      const known = await store.listKnownAgents();
      // Adds this computer's agent of this type; same-type agents on other computers are added by their own computers
      const user = known.find((item) => item.kind === kind && !item.remote);
      if (!user) throw new Error(tm("main.agent.notDiscovered"));
      await store.updateAgent(user.userId, { enabled: added });
      return buildAgentCatalog();
    }
  );

  handle("agents:cancel", async (_event, agentUserId: string) => {
    const agent = await store.getUser(agentUserId);
    const discovered = discoveredByUserId.get(agentUserId);
    if (!agent?.kind || !discovered) return false;
    return registry.cancel(agent.kind, discovered.localUuid);
  });

  handle("conversations:list", () => store.listConversations());
  handle("conversations:get", (_event, id: string) =>
    store.getConversation(id)
  );
  handle(
    "conversations:create",
    (event, input: CreateConversationInput) => scheduler.createConversation(input, event.sender)
  );
  handle(
    "conversations:add-member",
    (_event, id: string, userId: string, role: MemberRole) =>
      store.addMember(id, userId, role)
  );
  handle(
    "conversations:set-role",
    (_event, id: string, userId: string, role: MemberRole) =>
      store.setMemberRole(id, userId, role)
  );
  handle("conversations:report", (event, id: string) =>
    scheduler.reportConversation(id, event.sender)
  );
  handle(
    "conversations:remove-member",
    (_event, id: string, userId: string) => scheduler.removeMember(id, userId)
  );
  handle(
    "conversations:update",
    async (_event, id: string, patch: Record<string, unknown>) => {
      const conversation=await store.getConversation(id);
      if(!conversation||!("workspaceId" in patch||"workspacePath" in patch))return scheduler.updateConversation(id,patch);
      return removeKnowledgeScope("conversation",id,await resolveFor(conversation),()=>scheduler.updateConversation(id,patch));
    }
  );
  handle("conversations:delete", async (_event, id: string) => {
    await scheduler.cancelRunningTurns(id);
    const conversation=await store.getConversation(id);
    const oldResolution=conversation ? await resolveFor(conversation) : undefined;
    if(oldResolution)await removeKnowledgeScope("conversation",id,oldResolution,()=>store.deleteConversation(id));
    else await store.deleteConversation(id);
    await permissionDialogs.clearConversation(id);
  });
  handle("conversations:stop", (_event, id: string) => controlConversation(id, "pause"));
  handle("conversations:stopped", async () => [...new Set([
    ...(await store.listConversations()).filter(conversation => conversation.paused).map(conversation => conversation.conversationId),
    ...scheduler.stoppedConversationIds(), ...(conversationControl?.stoppedIds() ?? [])
  ])]);
  handle("conversations:resume", (_event, id: string) => controlConversation(id, "resume"));

  handle(
    "messages:list",
    (_event, conversationId: string, options?: Record<string, number>) =>
      store.listMessages(conversationId, options)
  );

  handle(
    "messages:send",
    async (
      event,
      input: {
        conversationId: string;
        clientMessageId: string;
        content: string;
        mentions?: string[];
        replyTo?: string;
        quote?: MessageQuote;
        attachments?: Attachment[];
      }
    ) => {
      conversationControl?.forget(input.conversationId);
      return scheduler.sendUserMessage(input, event.sender);
    }
  );

  handle(
    "messages:mark-read",
    async (event, conversationId: string, seq: number) => {
      const window=BrowserWindow.fromWebContents(event.sender);
      if(!windowCanRead(window))return false;
      const current=store,me=await current.currentUser();
      if(current!==store||!windowCanRead(window))return false;
      await current.markRead(conversationId, me.userId, seq);
      // markRead doesn't emit a store event, so the Dock badge must be recalculated here, or it stays at the pre-read count
      appUnread.refresh();
      return true;
    }
  );

  handle("skills:list", (_event, refs?: ScopeRef[]) =>
    store.listSkills(refs)
  );
  handle("skills:import",async(event,input:{scope:Scope;ownerId?:string;sourceKind:"zip"|"directory";skillId?:string})=>{
    if(input.scope!=="global"&&input.scope!=="workspace")throw new Error(tm("main.knowledge.invalidScope"));
    if(input.scope==="workspace"&&(!input.ownerId||!(await store.getWorkspace(input.ownerId))))throw new Error(tm("main.knowledge.invalidScope"));
    const parent=BrowserWindow.fromWebContents(event.sender);
    const options={title:tm("main.knowledge.importTitle"),properties:[input.sourceKind==="directory" ? "openDirectory" as const : "openFile" as const],...(input.sourceKind==="zip" ? {filters:[{name:"ZIP",extensions:["zip"]}]} : {})};
    const picked=parent ? await dialog.showOpenDialog(parent,options) : await dialog.showOpenDialog(options);
    if(picked.canceled||!picked.filePaths[0])return null;
    const me=await store.currentUser();
    const skill=await store.importSkill({sourcePath:picked.filePaths[0],skillId:input.skillId,scope:input.scope,ownerId:input.scope==="workspace" ? input.ownerId : undefined,authorKind:"human",authorUserId:me.userId});
    await knowledge.saved();
    return skill;
  });
  handle("skills:retry-sync",async()=>{await knowledgeCloud?.sync();memoryNotify?.retry();skillFallback?.retry();const result=await knowledge.refresh();return {synced:result.synced,...knowledge.syncState()};});
  handle("skills:sync-state",()=>knowledge.syncState());
  handle(
    "skills:create",
    async (
      _event,
      input: {
        name: string;
        description: string;
        scope: Scope;
        ownerId?: string;
        content: string;
        targets?: AgentKind[];
      }
    ) => {
      const me = await store.currentUser();
      const skill = await store.createSkill({
        ...input,
        // Skills people create in ADing can afterwards only be proposed for update by agents, not changed automatically
        authorKind: "human",
        authorUserId: me.userId
      });
      syncer.invalidate();
      await knowledge.saved();
      return skill;
    }
  );
  handle(
    "skills:update",
    async (_event, skillId: string, patch: Record<string, unknown>) => {
      const skill = await store.updateSkill(skillId, patch);
      syncer.invalidate();
      await knowledge.saved();
      return skill;
    }
  );
  handle("skills:delete", async (_event, skillId: string) => {
    await store.deleteSkill(skillId);
    syncer.invalidate();
    await knowledge.saved();
  });

  handle("skills:list-proposals", (_event, states?: ProposalState[]) =>
    store.listProposals(states)
  );

  /** A person decides on a pending proposal */
  handle(
    "skills:resolve-proposal",
    async (_event, proposalId: string, accept: boolean) => {
      const proposal = await store.getProposal(proposalId);
      if (!proposal) throw new Error(tm("main.store.proposalMissing"));
      if (!accept) {
        return store.setProposalState(proposalId, "rejected");
      }
      const me = await store.currentUser();
      if (proposal.kind === "update" && proposal.targetSkillId) {
        const target = await store.getSkill(proposal.targetSkillId);
        if (!target || target.scope !== proposal.scope || target.ownerId !== proposal.ownerId || target.name.trim() !== proposal.name.trim()) throw new Error(tm("main.skill.ownershipChanged"));
        await store.updateSkill(proposal.targetSkillId, {
          description: proposal.description,
          content: proposal.content
        });
      } else {
        await store.createSkill({
          name: proposal.name,
          description: proposal.description,
          scope: proposal.scope,
          ownerId: proposal.ownerId,
          content: proposal.content,
          // Ones a person decided to include can afterwards still only be updated by a person
          authorKind: "human",
          authorUserId: me.userId,
          targets: proposal.targets
        });
      }
      syncer.invalidate();
      await knowledge.saved();
      return store.setProposalState(proposalId, "applied");
    }
  );

  /**
   * Manually push everything to a conversation's working directory.
   * Global skills also sync automatically to each discovered Agent's user-level directory.
   */
  handle(
    "skills:sync",
    async (_event, conversationId: string, alsoWriteUserLevel?: boolean) => {
      const conversation = await store.getConversation(conversationId);
      if (!conversation) throw new Error(tm("main.store.conversationMissing"));
      const kinds = [...new Set([...discoveredByUserId.values()].map((d) => d.kind))];
      syncer.invalidate();
      await knowledge.saved();
      return bestEffortSync(async()=>syncer.ensureSynced(await resolveFor(conversation), kinds),[]);
    }
  );

  /** Withdraw: remove the managed blocks ADing wrote into each agent's rules files */
  handle("skills:unsync", async (_event, conversationId: string) => {
    const conversation = await store.getConversation(conversationId);
    if (!conversation) throw new Error(tm("main.store.conversationMissing"));
    const kinds = [...new Set([...discoveredByUserId.values()].map((d) => d.kind))];
    const { workspacePath } = await resolveFor(conversation);
    return bestEffortSync(()=>syncer.unsyncAll(workspacePath, kinds),[]);
  });

  /**
   * When completing a conversation, promote the selected items to a longer-lived place.
   *
   * This is the **only** entry point for cross-conversation knowledge transfer — what isn't selected really sinks with the conversation.
   * State the cost clearly so people choose carefully; if everything were kept automatically, nobody would trust the shared library for long.
   */
  handle(
    "conversations:archive",
    async (
      _event,
      conversationId: string,
      keep: Array<
        | { as: "skill"; name: string; description: string; content: string; global?: boolean }
        | { as: "workspace-fact"; content: string }
        | { as: "user-fact"; content: string }
      >
    ) => {
      const conversation = await store.getConversation(conversationId);
      if (!conversation) throw new Error(tm("main.store.conversationMissing"));
      const me = await store.currentUser();
      const resolution = await resolveFor(conversation);

      for (const item of keep) {
        if (item.as === "skill") {
          // Quick conversations have no workspace to attach to and can only go global; proper workspaces attach under the workspace by default
          const toGlobal = item.global || !resolution.sharesKnowledge;
          await store.createSkill({
            name: item.name,
            description: item.description,
            scope: toGlobal ? "global" : "workspace",
            ownerId: toGlobal ? undefined : resolution.knowledgeOwnerId,
            content: item.content,
            // What a person decided to keep can afterwards also only be updated by a person
            authorKind: "human",
            authorUserId: me.userId
          });
          continue;
        }
        if (item.as === "workspace-fact") {
          if (!resolution.sharesKnowledge || !resolution.knowledgeOwnerId) {
            throw new Error(tm("main.conversation.inboxNoWorkspace"));
          }
          await store.appendMemory({
            scope: "workspace",
            ownerId: resolution.knowledgeOwnerId,
            content: item.content,
            authorKind: "human",
            authorUserId: me.userId
          });
          continue;
        }
        await store.appendMemory({
          scope: "user",
          ownerId: me.userId,
          content: item.content,
          authorKind: "human",
          authorUserId: me.userId
        });
      }

      syncer.invalidate();
      await knowledge.saved();
      return store.updateConversation(conversationId, { status: "DONE" });
    }
  );

  handle(
    "memories:list",
    (_event, scope: MemoryScope, ownerId: string, limit?: number) =>
      store.listMemories(scope, ownerId, { limit })
  );
  /** A person records one manually. This is the only path that can write personal memories */
  handle(
    "memories:append",
    async (
      _event,
      input: { scope: MemoryScope; ownerId: string; content: string; pinned?: boolean }
    ) => {
      const me = await store.currentUser();
      const entry=await store.appendMemory({
        ...input,
        authorKind: "human",
        authorUserId: me.userId
      });
      await knowledge.saved();
      return entry;
    }
  );
  handle(
    "memories:update",
    async (_event, memoryId: string, patch: Record<string, unknown>) => {
      const entry=await store.updateMemory(memoryId, patch);
      await knowledge.saved();
      return entry;
    }
  );
  handle("memories:delete", async (_event, memoryId: string) => {
    await store.deleteMemory(memoryId);
    await knowledge.saved();
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // Language for main-process dialogs: use the last saved choice first; the renderer syncs again once the window is up.
  loadMainLanguage(preferencesFile());
  keepAwake = readPreferences(preferencesFile()).keepAwake !== false;
  protocol.handle(ATTACHMENT_SCHEME, serveAttachment);
  let resumeTimer: NodeJS.Timeout | undefined;
  powerMonitor.on("suspend", () => {
    clearTimeout(resumeTimer);
    probeSession.suspend();
    registry.cancelChecks();
    sleepGuard.suspend();
    void log("checks-suspended");
  });
  powerMonitor.on("resume", () => {
    clearTimeout(resumeTimer);
    sleepGuard.resume("resume");
    // Only continue checks interrupted by sleep. No periodic or idle wake-up checks.
    resumeTimer = setTimeout(() => { probeSession.resume(); void log("checks-resumed"); }, 1500);
  });
  // DarkWake doesn't unlock the screen or involve user input: in case resume is missed, these two signals show the computer is really awake
  powerMonitor.on("unlock-screen", () => sleepGuard.resume("unlock-screen"));
  powerMonitor.on("user-did-become-active", () => sleepGuard.resume("user-did-become-active"));
  // When the window stays in the foreground there are no new focus events; this periodic check catches up on reporting across the hour
  foregroundTelemetry.start();
  // Packaged builds always write logs to userData/logs and don't accept an inherited ADING_LOG: when OTA reopens,
  // `open` passes the previous process's ADING_LOG along, and Chinese paths get garbled, so logs end up in a different directory.
  // Dev runs (pnpm start) can still set the location with ADING_LOG.
  const inheritedLog = process.env.ADING_LOG;
  if (app.isPackaged) {
    process.env.ADING_LOG = path.join(app.getPath("userData"), "logs", "last-run.log");
  }
  // In dev there's no icon from the .app bundle, so make the Dock match the packaged build too.
  if (!app.isPackaged && app.dock) {
    app.dock.setIcon(path.join(__dirname, "../build/icon.png"));
  }
  await startLog({
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron,
    appVersion: release.displayVersion,
    cwd: process.cwd(),
    logPath: process.env.ADING_LOG,
    ...(inheritedLog && inheritedLog !== process.env.ADING_LOG ? { ignoredInheritedLogPath: inheritedLog } : {})
  });
  if (app.isPackaged) {
    const recovered = await recoverMisplacedLogs({
      appSupportDirectory: app.getPath("appData"),
      appName: path.basename(app.getPath("userData")),
      logDirectory: path.dirname(process.env.ADING_LOG!)
    }).catch((error: unknown) => {
      void log("log-recovery-failed", { error: describeForLog(error) });
      return [];
    });
    if (recovered.length) await log("log-recovered", { files: recovered });
  }
  // The first time an Agent's computer-use tool fails due to a missing system permission, show the system authorization prompt for the user to set it
  // (there's no separate settings page); each permission is proactively prompted at most once per launch, without repeated nagging.
  const promptedPermissions = new Set<ComputerPermissionKind>();
  onComputerToolLog((event, data) => { void log(event, data); });
  onComputerPermissionMissing((kind, message) => {
    void log("computer-permission-missing", { kind, message, prompted: !promptedPermissions.has(kind) });
    if (promptedPermissions.has(kind)) return;
    promptedPermissions.add(kind);
    void grantComputerPermission(kind);
    broadcast("computer:permission-missing", { kind, message });
  });
  updateHealth = new UpdateHealth(updatesDirectory());
  await updateHealth.load();
  const launchCheck = await updateHealth.recordLaunch(release.displayVersion)
    .catch(() => ({ offerRollback: false }));
  // It already ran healthily last time (including a normal quit), so the rollback copy isn't needed; don't delete on quit, to avoid racing the post-quit replacement script for the directory
  if (updateHealth.hasHealthyLaunch()) void discardRollback();
  const healthyTimer = setTimeout(() => void updateHealth?.markHealthy()
    .then(() => discardRollback())
    .catch(() => undefined), HEALTHY_AFTER_MS);
  (healthyTimer as { unref?: () => void }).unref?.();
  const cliRuntime = await prepareCliEnvironment({
    baseEnv: process.env,
    home: app.getPath("home"),
    runtimeDirectory: path.join(app.getPath("userData"), "runtime"),
    executablePath: process.execPath
  });
  process.env.PATH = cliRuntime.env.PATH;
  await log("cli-runtime-ready", { nodeVersion: cliRuntime.nodeVersion, bundled: cliRuntime.bundled });
  registry.cancelEverything();
  await openDataSession({ kind: "local" });
  await log("conversation-execution-initialized");
  await loadVerifyCache();
  const supportPendingDirectory = path.join(app.getPath("userData"), "support", "pending");
  const developerPendingDirectory = path.join(
    app.getPath("userData"), "support", "developer", "pending"
  );
  supportReports = new SupportReportQueue(supportPendingDirectory);
  developerContacts = new DeveloperContactQueue(developerPendingDirectory);
  const supportEndpoints = resolveSupportEndpoints(release.channel);
  startSupportUploadWorker([
    {
      name: "report",
      pendingDirectory: supportPendingDirectory,
      endpoint: supportEndpoints.report
    },
    {
      name: "developer",
      pendingDirectory: developerPendingDirectory,
      endpoint: supportEndpoints.contact
    }
  ]);
  account = new AccountSession({
    channel: release.channel,
    baseUrl: apiBaseUrl(release.channel),
    file: path.join(app.getPath("userData"), "account", "session.bin"),
    log: (event, detail) => void log(event, detail),
    onRegionBlocked: (message) => void leaveOnlineForRegion(message),
    // Use the async API: the sync API freezes the main process while waiting for keychain authorization
    secrets: {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptStringAsync(plain),
      decrypt: async (data) => (await safeStorage.decryptStringAsync(data)).result
    }
  });
  accountProfiles = new AccountProfiles(path.join(app.getPath("userData"), "account", "profiles.json"));
  void restoreAccountInBackground();
  startAppUpdater();
  await log("store-ready", {
    mode: store.mode,
    workspaces: (await store.listWorkspaces()).map((w) => ({
      name: w.name,
      kind: w.kind,
      path: w.path
    })),
    conversations: (await store.listConversations()).length
  });

  registerIpc();

  // Discovery and the task sheet are no longer tied to the "Search local Agents" button —
  // the button has been removed, and applying the task sheet can't depend on the user clicking something
  await refreshDiscovery().catch(() => undefined);
  await maybeApplySeed().catch(() => undefined);

  startingUp = false;

  if (HEADLESS) {
    await runHeadless();
    return;
  }

  createMainWindow();
  void offerRollbackIfNeeded(launchCheck).catch((error) =>
    log("update-rollback-check-failed", { error: describeForLog(error) }));

  app.on("activate", () => {
    cloudReconciler?.request();
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

/**
 * Headless main loop.
 *
 * On startup run discovery + task sheet once, then watch the task sheet file —
 * new conversations start automatically. Polling instead of fs.watch: save methods across platforms and editors
 * vary widely (some write a temp file then rename), and watch misses events.
 */
async function runHeadless(): Promise<void> {
  await log("headless-start", {});
  await refreshDiscovery();
  await maybeApplySeed().catch(() => undefined);

  let lastSeen = "";
  const tick = async (): Promise<void> => {
    await dataReady;
    let raw: string | null = null;
    for (const candidate of await seedCandidates()) {
      raw = await readFile(candidate, "utf8").catch(() => null);
      if (raw !== null) break;
    }
    if (raw === null || raw === lastSeen) return;
    lastSeen = raw;
    // The task sheet is idempotent by key; reapplying only starts the new ones
    seedApplied = false;
    await maybeApplySeed().catch(() => undefined);
  };

  await tick();
  setInterval(() => void tick().catch(() => undefined), 15_000);
  await log("headless-ready", { watching: await seedCandidates() });
}

app.on("before-quit", (event) => {
  if (quitComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  probeSession.suspend();
  void (async () => {
    try {
      updater?.stop();
      conversationControl?.close();
      agentModelRelay?.close();
      messageDelivery?.stop();
      cloudPush?.stop();
      await cloudReconciler?.stop();
      await stopAgentsGracefully();
      await supportUploadWorker?.terminate();
      appUnread.bind();
      if (store) await store.close();
      // A normal quit doesn't count as a crash
      await updateHealth?.markHealthy().catch(() => undefined);
      sleepGuard.dispose();
      foregroundTelemetry.dispose();
      await runPendingInstall().catch((error) =>
        log("update-install-launch-failed", { error: describeForLog(error) }));
      quitComplete = true;
      app.quit();
    } catch (error) {
      registry.cancelEverything();
      quitting = false;
      probeSession.resume();
      await log("shutdown-failed", { error: String(error) });
      dialog.showErrorBox(tm("main.quit.failedTitle"), tm("main.quit.failedMessage", { error: String(error) }));
    }
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
