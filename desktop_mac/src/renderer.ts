import { InfiniteList } from "./ui/infinite-list.js";
import { installOnboarding } from "./ui/onboarding.js";
import { localizedAgentName, storedAgentName, withLocalizedName } from "./ui/agent-names.js";
import { sidebarLabel } from "./ui/components.js";
import { isOperationalMessage, agentChatContent, isTeamRelayMessage } from "./ui/message-visibility.js";
import { iconSvg, mountIcons, type IconName } from "./ui/icons.js";
import { installTooltips } from "./ui/tooltips.js";
import { ALL_PEOPLE_LABELS, ALL_PEOPLE_MENTION, highlightMentions, resolveMentions, type MentionOption } from "./ui/mentions.js";
import { currentLanguage, installLanguage, intlLocale, switchLanguage, t, type Language } from "./ui/i18n.js";

installLanguage((language) => (window as typeof window & { ading: AdingBridge }).ading.setLanguage?.(language));
mountIcons();
installTooltips();
import { compareContacts, compareMembers, matchesContact, recentConversations } from "./ui/list-order.js";
import { OverlayController, closeOnBackdropClick } from "./ui/overlays.js";
import { RuntimeState, queueEntryText } from "./ui/runtime-state.js";
import { ScrollPosition } from "./ui/scroll-position.js";
import { MessageHistory } from "./ui/message-history.js";

// Settings -> Permissions -> agent review mode
const permissionModeInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[name='permission-mode']"));
let permissionMode:PermissionMode = "unattended";
function renderPermissionMode():void {
  for (const input of permissionModeInputs) input.checked = input.value === permissionMode;
}

/**
 * renderer -- UI only.
 *
 * Browser modules are built separately from the Electron Node entrypoints.
 *
 * It's also no longer responsible for "calling agents" -- who speaks and how the prompt is assembled all live in the main process.
 * The renderer sends a message, then waits for store events to push the new messages back;
 * the standalone and online editions are exactly the same at this layer.
 */

const bridge = (window as typeof window & { ading: AdingBridge }).ading;
for (const input of permissionModeInputs) input.addEventListener("change",async()=>{
  if (!input.checked) return;
  for (const item of permissionModeInputs) item.disabled=true;
  try {permissionMode=await bridge.setPermissionMode(input.value as PermissionMode);}
  catch(error){setStatus(t("app.permission.saveFailed",{error:describeError(error)}),"error");}
  finally {renderPermissionMode();for (const item of permissionModeInputs) item.disabled=false;}
});
// Settings -> Permissions -> Computer sleep: keep the computer awake while running tasks
const keepAwakeInput = document.querySelector<HTMLInputElement>("#settings-keep-awake")!;
keepAwakeInput.addEventListener("change",async()=>{
  keepAwakeInput.disabled=true;
  try {keepAwakeInput.checked=await bridge.setKeepAwake(keepAwakeInput.checked);}
  catch(error){keepAwakeInput.checked=!keepAwakeInput.checked;setStatus(t("app.power.saveFailed",{error:describeError(error)}),"error");}
  finally {keepAwakeInput.disabled=false;}
});
const sendModeStorageKey = "ading.send-mode";
const sidebarWidthStorageKey = "ading.chat-sidebar-width";
const sidebarCollapsedStorageKey = "ading.chat-sidebar-collapsed";
type SendMode = "command-enter" | "enter";

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

function el<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`UI element not found: ${selector}`);
  return found;
}

const conversationList = el<HTMLElement>("#contact-list");
const appShell = el<HTMLElement>("#app-shell");
const sidebarResizer = el<HTMLElement>("#sidebar-resizer");
const sidebarToggle = el<HTMLButtonElement>("#sidebar-toggle");
const currentUserRailAvatar = el<HTMLButtonElement>("#current-user-rail-avatar");
const supportEntry = el<HTMLButtonElement>("#support-entry");
const newGroupButton = el<HTMLButtonElement>("#new-group");
const conversationHeader = el<HTMLElement>("#conversation-header");
const conversationIdentity = el<HTMLElement>("#conversation-identity");
const conversationTitle = el<HTMLElement>("#conversation-title");
const conversationNameCenter = el<HTMLElement>("#conversation-name-center");
const conversationMeta = el<HTMLElement>("#conversation-meta");
const conversationAvatar = el<HTMLElement>("#conversation-avatar");
const conversationSwitcherButton = el<HTMLButtonElement>("#conversation-switcher-button");
const conversationSwitcherMenu = el<HTMLElement>("#conversation-switcher-menu");
const conversationAgentMenuButton = el<HTMLButtonElement>("#conversation-agent-menu-button");
const conversationAgentMenu = el<HTMLElement>("#conversation-agent-menu");
const conversationAgentCount = el<HTMLElement>("#conversation-agent-count");
const conversationAddMemberButton = el<HTMLButtonElement>("#conversation-add-member-button");
const conversationAddMemberMenu = el<HTMLElement>("#conversation-add-member-menu");
const conversationAddMemberSearch = el<HTMLInputElement>("#conversation-add-member-search");
const conversationAddMemberList = el<HTMLElement>("#conversation-add-member-list");
const settingsButton = el<HTMLButtonElement>("#agent-settings-button");
const statusBar = el<HTMLElement>("#discovery-status");
const statusText = el<HTMLElement>("#discovery-status-text");
const statusClose = el<HTMLButtonElement>("#discovery-status-close");
const attachmentImageDialog = el<HTMLDialogElement>("#attachment-image-dialog");
const attachmentImagePreview = el<HTMLImageElement>("#attachment-image-preview");
const attachmentImageViewport = el<HTMLElement>("#attachment-image-viewport");
const attachmentImageZoomIn = el<HTMLButtonElement>("#attachment-image-zoom-in");
const attachmentImageZoomOut = el<HTMLButtonElement>("#attachment-image-zoom-out");
const attachmentImageName = el<HTMLElement>("#attachment-image-name");
const attachmentImageError = el<HTMLElement>("#attachment-image-error");
const attachmentImageSave = el<HTMLButtonElement>("#attachment-image-save");
let previewedAttachment: { conversationId: string | null; attachment: Attachment } | undefined;
const messagesPane = el<HTMLElement>("#messages");
const mentionJumpButton = el<HTMLButtonElement>("#mention-jump");
const latestJumpButton = el<HTMLButtonElement>("#latest-jump");
const composerReply = el<HTMLElement>("#composer-reply");
const messageFilters = el<HTMLElement>("#message-filters");
const filterHumansButton = el<HTMLButtonElement>("#filter-humans");
const filterAgentsButton = el<HTMLButtonElement>("#filter-agents");
const toggleProcessButton = el<HTMLButtonElement>("#toggle-process");
const reportConversationButton = el<HTMLButtonElement>("#report-conversation");
const processPanel = el<HTMLElement>("#process-panel");
const processPanelClose = el<HTMLButtonElement>("#process-panel-close");
const processPanelTitle = el<HTMLElement>("#process-panel-title");
const processAgentFilters = el<HTMLElement>("#process-agent-filters");
const processFeed = el<HTMLElement>("#process-feed");
const composer = el<HTMLFormElement>("#composer");
const input = el<HTMLTextAreaElement>("#message-input");
const sendButton = el<HTMLButtonElement>("#send-button");
const stopButton = el<HTMLButtonElement>("#stop-button");
const attachButton = el<HTMLButtonElement>("#attach-button");
const composerAttachments = el<HTMLElement>("#composer-attachments");
/** Attachments in the composer not yet sent (already copied into the local attachments directory) */
let pendingAttachments: Attachment[] = [];
const MAX_PENDING_ATTACHMENTS = 9;
const conversationControlPending = new Set<string>();
/** Conversations paused and not yet resumed (the main-process scheduler is authoritative; refreshed with the conversation list) */
let stoppedConversations = new Set<string>();
const sendModeButton = el<HTMLButtonElement>("#send-mode-button");
const sendModeMenu = el<HTMLElement>("#send-mode-menu");
const sendModeOptions = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-send-mode]")
);

const settingsDialog = el<HTMLDialogElement>("#settings-dialog");
const settingsTitle = el<HTMLElement>("#settings-title");
const groupFields = el<HTMLElement>("#group-fields");
const groupNameInput = el<HTMLInputElement>("#group-name-input");
const conversationGoalInput = el<HTMLTextAreaElement>("#conversation-goal-input");
const conversationMemberSettings = el<HTMLElement>("#conversation-member-settings");
const conversationSettingsError = el<HTMLElement>("#conversation-settings-error");
const workspaceInput = el<HTMLInputElement>("#workspace-input");
const settingsWorkspace = el<HTMLSelectElement>("#settings-workspace");
const settingsWorkspaceHint = el<HTMLElement>("#settings-workspace-hint");
const memberEditor = el<HTMLElement>("#member-editor");
const settingsAddMembers = el<HTMLButtonElement>("#settings-add-members");
const settingsMembersTitle = el<HTMLElement>("#settings-members-title");
const settingsMemberSearch = el<HTMLInputElement>("#settings-member-search");
let addingConversationMembers = false;
let memberMutationPending = false;
const settingsClose = el<HTMLButtonElement>("#settings-close");
const settingsSave = el<HTMLButtonElement>("#settings-save");

const contactDetailDialog = el<HTMLDialogElement>("#contact-detail-dialog");
const contactDetailForm = el<HTMLFormElement>("#contact-detail-form");
const contactDetailTitle = el<HTMLElement>("#contact-detail-title");
const contactDetailClose = el<HTMLButtonElement>("#contact-detail-close");
const contactDetailAvatar = el<HTMLButtonElement>("#contact-detail-avatar");
const contactAvatarChange = el<HTMLButtonElement>("#contact-avatar-change");
const contactAvatarInput = el<HTMLInputElement>("#contact-avatar-input");
const contactDetailName = el<HTMLInputElement>("#contact-detail-name");
const contactDetailUsername = el<HTMLInputElement>("#contact-detail-username");
const contactDetailStatus = el<HTMLElement>("#contact-detail-status");
const contactDetailAgentKind = el<HTMLInputElement>("#contact-detail-agent-kind");
const contactDetailVersion = el<HTMLInputElement>("#contact-detail-version");
const contactDetailPhone = el<HTMLInputElement>("#contact-detail-phone");
const contactDetailEmail = el<HTMLInputElement>("#contact-detail-email");
const contactAgentKindField = el<HTMLElement>("#contact-agent-kind-field");
const contactAgentVersionField = el<HTMLElement>("#contact-agent-version-field");
const contactAgentComputerField = el<HTMLElement>("#contact-agent-computer-field");
const contactDetailComputer = el<HTMLInputElement>("#contact-detail-computer");
const contactAgentModelField = el<HTMLElement>("#contact-agent-model-field");
const contactDetailModel = el<HTMLSelectElement>("#contact-detail-model");
const contactDetailModelHint = el<HTMLElement>("#contact-detail-model-hint");
const contactPhoneField = el<HTMLElement>("#contact-phone-field");
const contactEmailField = el<HTMLElement>("#contact-email-field");
const contactDetailError = el<HTMLElement>("#contact-detail-error");
const contactDetailRefreshStatus = el<HTMLButtonElement>("#contact-detail-refresh-status");
const contactDetailSave = el<HTMLButtonElement>("#contact-detail-save");
const contactChangePassword = el<HTMLButtonElement>("#contact-change-password");
const passwordDialog = el<HTMLDialogElement>("#password-dialog");
const passwordForm = el<HTMLFormElement>("#password-form");
const passwordClose = el<HTMLButtonElement>("#password-close");
const passwordCurrent = el<HTMLInputElement>("#password-current");
const passwordNew = el<HTMLInputElement>("#password-new");
const passwordConfirm = el<HTMLInputElement>("#password-confirm");
const passwordError = el<HTMLElement>("#password-error");
const passwordSubmit = el<HTMLButtonElement>("#password-submit");
const avatarPreviewDialog = el<HTMLDialogElement>("#avatar-preview-dialog");
const avatarPreviewClose = el<HTMLButtonElement>("#avatar-preview-close");
const avatarPreviewImage = el<HTMLImageElement>("#avatar-preview-image");
const reportConfirmDialog = el<HTMLDialogElement>("#report-confirm-dialog");
const reportConfirmAction = el<HTMLButtonElement>("#report-confirm-action");
let reportConfirmationConversationId: string | null = null;
const reportingConversations = new Set<string>();
const deleteConfirmDialog = el<HTMLDialogElement>("#delete-confirm-dialog");
const deleteConfirmTitle = el<HTMLElement>("#delete-confirm-title");
const deleteConfirmCopy = el<HTMLElement>("#delete-confirm-copy");
const deleteConfirmClose = el<HTMLButtonElement>("#delete-confirm-close");
const deleteConfirmAction = el<HTMLButtonElement>("#delete-confirm-action");
const supportDialog = el<HTMLDialogElement>("#support-dialog");
const supportClose = el<HTMLButtonElement>("#support-close");
const supportTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-support-tab]")
);
const supportReportPanel = el<HTMLElement>("#support-report-panel");
const supportDeveloperPanel = el<HTMLElement>("#support-developer-panel");
const supportTipPanel = el<HTMLElement>("#support-tip-panel");
const supportReportOccurredAt = el<HTMLInputElement>("#support-report-occurred-at");
const supportReportDescription = el<HTMLTextAreaElement>("#support-report-description");
const supportCapturePreview = el<HTMLElement>("#support-capture-preview");
const supportCaptureStatus = el<HTMLElement>("#support-capture-status");
const supportAttachments = el<HTMLElement>("#support-attachments");
const supportAddImage = el<HTMLButtonElement>("#support-add-image");
const supportImageInput = el<HTMLInputElement>("#support-image-input");
const supportSubmitReport = el<HTMLButtonElement>("#support-submit-report");
const supportReportFeedback = el<HTMLElement>("#support-report-feedback");
const supportReportDone = el<HTMLElement>("#support-report-done");
const supportDoneDetail = el<HTMLElement>("#support-done-detail");
const supportDoneId = el<HTMLElement>("#support-done-id");
const supportReportAgain = el<HTMLButtonElement>("#support-report-again");
const supportDoneClose = el<HTMLButtonElement>("#support-done-close");
const supportDeveloperSubject = el<HTMLInputElement>("#support-developer-subject");
const supportDeveloperContent = el<HTMLTextAreaElement>("#support-developer-content");
const supportDeveloperReplyTo = el<HTMLInputElement>("#support-developer-reply-to");
const supportDeveloperAttachments = el<HTMLElement>("#support-developer-attachments");
const supportDeveloperAddFile = el<HTMLButtonElement>("#support-developer-add-file");
const supportDeveloperFileInput = el<HTMLInputElement>("#support-developer-file-input");
const supportEmailDeveloper = el<HTMLButtonElement>("#support-email-developer");
const supportDeveloperFeedback = el<HTMLElement>("#support-developer-feedback");
const supportDeveloperDone = el<HTMLElement>("#support-developer-done");
const supportDeveloperDoneDetail = el<HTMLElement>("#support-developer-done-detail");
const supportDeveloperDoneId = el<HTMLElement>("#support-developer-done-id");
const supportDeveloperAgain = el<HTMLButtonElement>("#support-developer-again");
const supportDeveloperDoneClose = el<HTMLButtonElement>("#support-developer-done-close");
const readonlyProfileDialog = el<HTMLDialogElement>("#readonly-profile-dialog");
const readonlyProfileClose = el<HTMLButtonElement>("#readonly-profile-close");
const readonlyProfileAvatar = el<HTMLElement>("#readonly-profile-avatar");
const readonlyProfileName = el<HTMLElement>("#readonly-profile-name");
const readonlyProfileSubtitle = el<HTMLElement>("#readonly-profile-subtitle");
const readonlyProfileGrid = el<HTMLElement>("#readonly-profile-grid");

const groupDialog = el<HTMLDialogElement>("#group-dialog");
const friendDialog = el<HTMLDialogElement>("#friend-dialog");
const friendClose = el<HTMLButtonElement>("#friend-close");
const friendSearchForm = el<HTMLFormElement>("#friend-search-form");
const friendSearchInput = el<HTMLInputElement>("#friend-search-input");
const friendSearchSubmit = el<HTMLButtonElement>("#friend-search-submit");
const friendSearchResults = el<HTMLElement>("#friend-search-results");
const friendRequestList = el<HTMLElement>("#friend-request-list");
const friendOutgoingTitle = el<HTMLElement>("#friend-outgoing-title");
const friendOutgoingList = el<HTMLElement>("#friend-outgoing-list");
const friendError = el<HTMLElement>("#friend-error");
const groupSelectAll = el<HTMLInputElement>("#group-select-all");
const conversationInstructions = el<HTMLTextAreaElement>("#conversation-instructions");
let groupLeaderId: string | undefined;
const groupMemberSearch = el<HTMLInputElement>("#group-member-search");
const groupMemberList = el<HTMLElement>("#group-member-list");
const groupClose = el<HTMLButtonElement>("#group-close");
const tabContacts = el<HTMLButtonElement>("#tab-contacts");
const tabConversations = el<HTMLButtonElement>("#tab-conversations");
const tabKnowledge = el<HTMLButtonElement>("#tab-knowledge");
const agentsEntry = el<HTMLButtonElement>("#agents-entry");
const accountLoginButton = el<HTMLButtonElement>("#account-login");
const accountLogoutButton = el<HTMLButtonElement>("#account-logout");
const accountDialog = el<HTMLDialogElement>("#account-dialog");
const accountForm = el<HTMLFormElement>("#account-form");
const accountTitle = el<HTMLElement>("#account-title");
const accountUsername = el<HTMLInputElement>("#account-username");
const accountPassword = el<HTMLInputElement>("#account-password");
const accountConfirmField = el<HTMLElement>("#account-confirm-field");
const accountConfirm = el<HTMLInputElement>("#account-confirm");
const accountFeedback = el<HTMLElement>("#account-feedback");
const accountSubmit = el<HTMLButtonElement>("#account-submit");
const accountSwitchHint = el<HTMLElement>("#account-switch-hint");
const accountSwitch = el<HTMLButtonElement>("#account-switch");
const accountClose = el<HTMLButtonElement>("#account-close");
const accountAgentsNotice = el<HTMLElement>("#account-agents-notice");
const logoutConfirmDialog = el<HTMLDialogElement>("#logout-confirm-dialog");
const duplicateNameDialog = el<HTMLDialogElement>("#duplicate-name-dialog");
const duplicateNameCopy = el<HTMLElement>("#duplicate-name-copy");
const duplicateNameClose = el<HTMLButtonElement>("#duplicate-name-close");
const duplicateNameKeep = el<HTMLButtonElement>("#duplicate-name-keep");
const duplicateNameRename = el<HTMLButtonElement>("#duplicate-name-rename");
/** The agent currently being asked about in the duplicate-name prompt */
let duplicateNameTarget: UserRef | null = null;
const logoutConfirmCopy = el<HTMLElement>("#logout-confirm-copy");
const logoutConfirmAction = el<HTMLButtonElement>("#logout-confirm-action");
const logoutConfirmClose = el<HTMLButtonElement>("#logout-confirm-close");
const dataSwitchOverlay = el<HTMLElement>("#data-switch-overlay");
const dataSwitchText = el<HTMLElement>("#data-switch-text");
const agentClose = el<HTMLButtonElement>("#agent-close");
const agentsBadge = el<HTMLElement>("#agents-badge");
const agentPane = el<HTMLElement>("#agent-pane");
const appToast = el<HTMLElement>("#app-toast");
const agentRows = el<HTMLElement>("#agent-rows");
const agentRecheck = el<HTMLButtonElement>("#agent-recheck");
const knowledgeBadge = el<HTMLElement>("#knowledge-badge");
const chatSidebar = el<HTMLElement>("#chat-sidebar");
const chatPane = el<HTMLElement>("#chat-pane");
const knowledgeSidebar = el<HTMLElement>("#knowledge-sidebar");
const knowledgePane = el<HTMLElement>("#knowledge-pane");
const scopeList = el<HTMLElement>("#scope-list");
const knowledgeTitle = el<HTMLElement>("#knowledge-title");
const knowledgeMeta = el<HTMLElement>("#knowledge-meta");
const knowledgeBody = el<HTMLElement>("#knowledge-body");
const knowledgeAdd = el<HTMLButtonElement>("#knowledge-add");
const knowledgeCreateSkill=el<HTMLButtonElement>("#knowledge-create-skill");
const knowledgeImportZip=el<HTMLButtonElement>("#knowledge-import-zip");
const knowledgeImportDirectory=el<HTMLButtonElement>("#knowledge-import-directory");
const knowledgeRetrySync=el<HTMLButtonElement>("#knowledge-retry-sync");
const knowledgeSyncNotice=el<HTMLElement>("#knowledge-sync-notice");
const knowledgeSyncText=el<HTMLElement>("#knowledge-sync-text");
const knowledgeSyncClose=el<HTMLButtonElement>("#knowledge-sync-close");
const groupConfirm = el<HTMLButtonElement>("#group-confirm");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let me: UserRef | null = null;
/** Standalone user profile. After sign-in the UI's me switches to the account profile, but the identity ID is always this one's */
let localMe: UserRef | null = null;
let accountStatus: AccountStatus = { signedIn: false };
/** This machine's computer registered in the cloud; empty in the standalone edition or before registration completes */
let localComputer: { computerId: string; name: string } | null = null;

/** Computer registration completes asynchronously after sign-in; re-fetch whenever the account changes or the agent list refreshes */
async function refreshLocalComputer(): Promise<void> {
  localComputer = accountStatus.signedIn
    ? await bridge.accountComputer().catch(() => null) as typeof localComputer
    : null;
}

/** The computer an agent is on. The standalone edition has no "other computers", so returns empty */
function agentComputerOf(agent: UserRef): { computerId: string; name: string } | undefined {
  if (!agent.isAgent) return undefined;
  if (agent.remote) return { computerId: agent.remote.computerId, name: agent.remote.computerName };
  return localComputer ?? undefined;
}

/**
 * Hover tooltip for list rows: the name of the computer the agent is on. Used to tell them apart when each of two computers has a "小c".
 * This is an exception to "list rows show no hover tooltip" -- the row only shows the name, and the computer is new information the name can't give.
 * Returns an empty string in the standalone edition, keeping no tooltip.
 */
function agentComputerLabel(agent: UserRef): string {
  return agentComputerOf(agent)?.name ?? "";
}
/** Discard stale profile-switch results: while reading the account profile, the user may have signed out, switched accounts or saved a new profile */
let identityGeneration = 0;
let mode: StoreMode = "local";
type MessageFilter = "all" | "humans" | "agents";
interface ProcessEvent {
  agentUserId: string;
  text: string;
  createdAt: string;
  error?: boolean;
}
let messageFilter: MessageFilter = "all";
let processPanelOpen = false;
let conversationAgentMenuOpen = false;
/** Feed filter; null means view all Agents. */
let processAgentFilterId: string | null = null;
const users = new Map<string, UserRef>();
/** Users actually in the contact list right now; users also keeps profiles of historical task members. */
const contactIds = new Set<string>();
let workspaces: Workspace[] = [];
/** Workspaces collapsed in the sidebar. Only in memory; closing the app restores them to expanded */
let conversations: Conversation[] = [];
const messageHistory = new MessageHistory((id, options) => bridge.listMessages(id, options));
const messagesByConversation = messageHistory.messages;
/** Each task maintains its Agents' actual running state independently. */
const runtimeState = new RuntimeState();
const busyAgents = runtimeState.busy;
let queuedAgents: AgentQueueEntry[] = [];
let queueRevision = -1;
/** (conversationId, agentUserId) -> latest progress text */
const progressText = runtimeState.progress;
/** Live process received during the current run; persisted steps are still restored from Message.steps. */
const liveProcessByConversation = new Map<string, ProcessEvent[]>();
/** After pause/failure, keep this round's feed; clear it only when the same Agent actually starts its next round. */
const liveProcessStateByConversation = new Map<string, Map<string,{state:"running"|"stopped";startedAt:string}>>();

let selectedId: string | null = null;
/** The task being edited in the settings dialog; doesn't force the user away from the currently open task. */
let editingConversationId: string | null = null;
/** The person currently selected on the contacts page. Contacts are an entry point, not the conversation itself. */
let selectedContactId: string | null = null;
/** When entering a group task via a direct chat's task switcher, keep this contact's perspective. */
let conversationSwitcherContactContextId: string | null = null;
/** A new task not yet persisted; created only when the first message is sent, to avoid empty tasks. */
let draftContactId: string | null = null;
/**
 * Each contact's current focused direct chat: clicking the contact lands on this one.
 *
 * Set as focus when a new direct chat is created; also set as focus when switching to a direct chat via "Switch task" --
 * switching to a group chat or another task doesn't change the focus; you can go back to those from the switcher menu.
 * Per the user's decision, only remembered during this run; reopening the app goes back to "the most recently created direct chat".
 */
const contactFocus = new Map<string, string>();

/** Draft created in a group chat reusing the current members; excludes the current user. */
let draftMemberIds: string[] | null = null;
let draftAutoTitle = false;
/** The leader designated by clicking the crown in the new-task dialog; carried along when the draft is persisted. */
let draftLeaderId: string | undefined;
let draftWorkspaceId: string | undefined;
let draftReturnConversationId: string | null = null;
let statusTimer = 0;
let agentStatusTimer = 0;
let sendMode: SendMode =
  localStorage.getItem(sendModeStorageKey) === "enter" ? "enter" : "command-enter";
const defaultSidebarWidth = window.innerWidth <= 960 ? 250 : 312;
let chatSidebarWidth = Number.parseInt(
  localStorage.getItem(sidebarWidthStorageKey) ?? String(defaultSidebarWidth),
  10
);
let chatSidebarCollapsed =
  localStorage.getItem(sidebarCollapsedStorageKey) === "true";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Electron's ipcRenderer.invoke wraps errors thrown by the main process:
  // "Error invoking remote method 'support:submit-report': Error: Please describe the problem in at least 5 characters"
  // The leading part is internal implementation; the user only needs to see the last sentence.
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:Uncaught )?Error:\s*/, "")
    .trim() || raw;
}

interface ReplyTarget { messageId: string; quote: MessageQuote; /** The @ auto-added at the start when replying; removed together when the reply is cancelled */ mentionLabel?: string; }
interface ComposerDraftState { text: string; attachments: Attachment[]; revision: number; mentions?: ReadonlyMap<string, string>; reply?: ReplyTarget; }
/** Members picked from the @ menu in each composer: display text -> userId */
const pickedMentions = new Map<string, Map<string, string>>();
const replyTargets = new Map<string, ReplyTarget>();
interface ChatNotice { text: string; tone: "info" | "error"; expiresAt?: number; }
const composerDrafts = new Map<string, ComposerDraftState>();
const chatNotices = new Map<string, ChatNotice>();
const failedDrafts = new Map<string, ComposerDraftState[]>();
let composerContext = "";
let dataGeneration = 0;
const statusRecover = document.createElement("button");
statusRecover.type = "button";
statusRecover.className = "status-recover";
statusClose.before(statusRecover);
function chatKey(id: string): string { return `conversation:${id}`; }
function currentComposerKey(): string {
  if (selectedId) return chatKey(selectedId);
  return `draft:${JSON.stringify([draftContactId, draftMemberIds ? [...draftMemberIds].sort() : null, draftWorkspaceId, draftLeaderId])}`;
}
function saveComposerDraft(): ComposerDraftState {
  const old = composerDrafts.get(composerContext);
  const changed = old?.text !== input.value || JSON.stringify(old?.attachments) !== JSON.stringify(pendingAttachments);
  const state = { text: input.value, attachments: [...pendingAttachments], revision: (old?.revision ?? 0) + (changed ? 1 : 0) };
  if (composerContext) composerDrafts.set(composerContext, state);
  return state;
}
/**
 * When a draft's member combination changes (e.g. adding people in the draft), move the composer content, pending attachments, failed drafts awaiting restore and notices
 * under the new combination's key; otherwise the composer would read the empty draft under the new combination and just-written content would be lost.
 * If the new key already has a draft, merge: current text first, the existing text appended as a new paragraph; attachments deduped by id, current ones first,
 * ones over the limit are dropped with a notice; failed drafts: current ones first; the notice: the current one wins.
 */
function moveComposerDraft(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  if (composerContext === fromKey) {
    saveComposerDraft();
    // The next syncComposerContext no longer writes the composer back to the old key, but reads the new key directly
    composerContext = "";
  }
  const source = composerDrafts.get(fromKey);
  composerDrafts.delete(fromKey);
  const target = composerDrafts.get(toKey);
  let overflow = false;
  if (source && target) {
    const texts = [source.text, target.text].filter((text, index, all) => text.trim() && all.indexOf(text) === index);
    const attachments = [...source.attachments];
    for (const item of target.attachments) {
      if (!attachments.some(existing => existing.attachmentId === item.attachmentId)) attachments.push(item);
    }
    overflow = attachments.length > MAX_PENDING_ATTACHMENTS;
    composerDrafts.set(toKey, { text: texts.join("\n\n"), attachments: attachments.slice(0, MAX_PENDING_ATTACHMENTS), revision: Math.max(source.revision, target.revision) + 1 });
  } else if (source) composerDrafts.set(toKey, source);
  const moved = pickedMentions.get(fromKey);
  if (moved) pickedMentions.set(toKey, new Map([...(pickedMentions.get(toKey) ?? []), ...moved]));
  pickedMentions.delete(fromKey);
  const failed = [...(failedDrafts.get(fromKey) ?? []), ...(failedDrafts.get(toKey) ?? [])];
  failedDrafts.delete(fromKey);
  if (failed.length) failedDrafts.set(toKey, failed);
  const notice = chatNotices.get(fromKey);
  chatNotices.delete(fromKey);
  if (overflow) chatNotices.set(toKey, { text: t("app.attachment.tooMany"), tone: "error", expiresAt: Date.now() + 10_000 });
  else if (notice) chatNotices.set(toKey, notice);
}
function syncComposerContext(): void {
  const key = currentComposerKey();
  if (composerContext !== key) {
    saveComposerDraft();
    composerContext = key;
    const draft = composerDrafts.get(key);
    input.value = draft?.text ?? "";
    pendingAttachments = [...(draft?.attachments ?? [])];
    renderComposerAttachments();
    autoGrowInput();
  }
  saveComposerDraft();
  renderChatNotice();
}
function renderChatNotice(): void {
  window.clearTimeout(statusTimer);
  const key = currentComposerKey();
  let notice = chatNotices.get(key);
  if (notice?.expiresAt && notice.expiresAt <= Date.now()) { chatNotices.delete(key); notice = undefined; }
  statusText.textContent = notice?.text ?? "";
  statusClose.hidden = !notice;
  statusBar.classList.toggle("error", notice?.tone === "error");
  statusBar.hidden = !notice;
  statusRecover.textContent = t("app.composer.restoreFailed");
  statusRecover.hidden = !failedDrafts.get(key)?.length;
  statusRecover.disabled = !!input.value || pendingAttachments.length > 0;
  if (notice?.expiresAt) {
    const saved = notice;
    statusTimer = window.setTimeout(() => {
      if (chatNotices.get(key) === saved) chatNotices.delete(key);
      if (currentComposerKey() === key) renderChatNotice();
    }, Math.max(0, notice.expiresAt - Date.now()));
  }
}
function setStatus(text: string, tone: "info" | "error" = "info", temporary = false, key = currentComposerKey()): void {
  if (text) chatNotices.set(key, { text, tone, ...((tone === "info" || temporary) ? { expiresAt: Date.now() + (temporary ? 10_000 : 6000) } : {}) });
  else chatNotices.delete(key);
  if (currentComposerKey() === key) renderChatNotice();
}
statusClose.addEventListener("click", () => {
  chatNotices.delete(currentComposerKey());
  renderChatNotice();
});
statusRecover.addEventListener("click", () => {
  if (input.value || pendingAttachments.length) return;
  const key = currentComposerKey();
  const draft = failedDrafts.get(key)?.shift();
  if (!draft) return;
  input.value = draft.text;
  if (draft.mentions?.size) pickedMentions.set(key, new Map(draft.mentions));
  if (draft.reply) replyTargets.set(key, draft.reply);
  pendingAttachments = [...draft.attachments];
  renderComposerAttachments();
  autoGrowInput();
  syncComposer();
  input.focus();
});

/** Temporary feedback on the Agent page takes no list space and is pinned at the bottom of the app. */
function setAgentStatus(
  text: string,
  tone: "info" | "error" = "info",
  autoHide = true
): void {
  appToast.textContent = text;
  appToast.classList.toggle("error", tone === "error");
  appToast.hidden = !text;
  window.clearTimeout(agentStatusTimer);
  if (autoHide && text) {
    agentStatusTimer = window.setTimeout(() => {
      appToast.hidden = true;
    }, 6000);
  }
}

function newClientMessageId(): string {
  return `m_${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 24)}`;
}

/** The Agent page's status list also has names (displayName); the English UI likewise switches them to English default names */
function localizedCatalog(list: AgentStatus[]): AgentStatus[] {
  return list.map((status) => status.displayName ? { ...status, displayName: localizedAgentName(status.kind, status.displayName) } : status);
}

function userName(userId: string): string {
  return users.get(userId)?.displayName ?? userId;
}

function conversationById(id: string): Conversation | undefined {
  return conversations.find((c) => c.conversationId === id);
}

function counterpart(conversation: Conversation): UserRef | undefined {
  if (conversation.type !== "DIRECT") return undefined;
  const otherId = conversation.members
    .map((m) => m.userId)
    .find((id) => id !== me?.userId);
  return otherId ? users.get(otherId) : undefined;
}

/** Placeholder name stored before auto-naming; only swapped to the current language for display. Storage keeps it as-is; the scheduler uses it to decide whether to name */
const AUTO_TITLE_PLACEHOLDER = "新会话";
/** Unnamed conversations created before the rename to "conversation" store "新任务" in the database */
const LEGACY_TITLE_PLACEHOLDER = "新任务";

function conversationName(conversation: Conversation): string {
  const stored = conversation.name?.trim();
  const explicit = stored === AUTO_TITLE_PLACEHOLDER || stored === LEGACY_TITLE_PLACEHOLDER ? t("app.conversation.draftName") : stored;
  if (conversation.type === "GROUP") return explicit || t("app.conversation.untitled");
  const contact = counterpart(conversation);
  if (!contact) return explicit || t("app.conversation.untitled");
  const oldDefaultNames = [
    contact.displayName,
    contact.kind ? AGENT_REAL_NAMES[contact.kind] : undefined
  ].filter((name): name is string => Boolean(name));
  return explicit && !oldDefaultNames.includes(explicit)
    ? explicit
    : t("app.conversation.directName", { name: contact.displayName });
}

function agentMembers(conversation: Conversation): UserRef[] {
  return conversation.members
    .map((m) => users.get(m.userId))
    .filter((u): u is UserRef => Boolean(u?.isAgent));
}

function ikkyuVisual(): string {
  return `<span class="ikkyu-status-visual" aria-hidden="true"><img class="ikkyu-status-static" src="./assets/ikkyu-approved-idle.png" alt="" draggable="false" /><img class="ikkyu-status-strip" src="./assets/ikkyu-approved-strip.png" alt="" draggable="false" /></span>`;
}

/**
 * The Ikkyu "thinking" animation: while an Agent is running, shown next to its status in the contact list and next to its name in the chat.
 * Purely decorative; screen readers rely on aria-label. No bubble (the row already has the name; a hover tooltip adds no new information).
 */
function thinkingIndicator(agentName: string): HTMLElement {
  const indicator = document.createElement("span");
  indicator.className = "ikkyu-thinking ikkyu-inline";
  indicator.setAttribute("role", "img");
  indicator.setAttribute("aria-label", t("app.agent.thinking", { name: agentName }));
  indicator.dataset.tooltip = "";
  indicator.innerHTML = ikkyuVisual();
  return indicator;
}

function agentBusyAnywhere(agentUserId: string): boolean {
  return [...busyAgents.keys()].some((key) => runtimeState.agentId(key) === agentUserId);
}

/** Contact list: attach / remove Ikkyu according to current running state, without redrawing the whole list (redrawing interrupts typing in the search box) */
function syncContactThinking(): void {
  for (const row of contactSearchResults.querySelectorAll<HTMLElement>(".contact-list-item[data-member-kind='agent']")) {
    const userId = row.dataset.userId ?? "";
    const busy = agentBusyAnywhere(userId);
    row.querySelector(".contact-button")?.classList.toggle("busy", busy);
    const signal = row.querySelector<HTMLElement>(".contact-list-signal");
    const existing = signal?.querySelector(".ikkyu-thinking");
    if (busy && signal && !existing) signal.append(thinkingIndicator(users.get(userId)?.displayName ?? "Agent"));
    if (!busy) existing?.remove();
  }
}

/** When the current conversation has an Agent working, consistently show Ikkyu next to the direct-chat and group-chat title. */
function syncHeaderThinking(): void {
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  const working = conversation ? busyAgentsIn(conversation.conversationId)[0] : undefined;
  const busy = Boolean(working);
  let indicator = conversationIdentity.querySelector<HTMLElement>(".ikkyu-thinking");
  if (busy && !indicator && working) {
    indicator = thinkingIndicator(working.displayName);
    conversationTitle.after(indicator);
  }
  if (working && indicator) indicator.setAttribute("aria-label", t("app.agent.thinking", { name: working.displayName }));
  if (!busy) indicator?.remove();
}

function hasRunningAgent(conversationId: string): boolean {
  return [...busyAgents.values()].includes(conversationId);
}

/** Conversation switcher list: reserve a slot before each entry, put Ikkyu there if an Agent in the conversation is running, without redrawing the whole menu */
function syncSwitcherThinking(): void {
  for (const slot of conversationSwitcherMenu.querySelectorAll<HTMLElement>(".conversation-switcher-activity")) {
    const conversationId = slot.closest<HTMLElement>(".conversation-switcher-item")?.dataset.conversationId ?? "";
    const working = busyAgentsIn(conversationId);
    const existing = slot.querySelector(".ikkyu-thinking");
    if (working.length && !existing) slot.append(thinkingIndicator(working.map((agent) => agent.displayName).join(", ")));
    if (!working.length) existing?.remove();
  }
}

function syncConversationActivity(): void {
  const running = selectedId ? hasRunningAgent(selectedId) : false;
  conversationHeader.classList.toggle("conversation-running", running);
  conversationHeader.classList.toggle("conversation-idle", !running);
  for (const row of conversationList.querySelectorAll<HTMLElement>(".conversation-list-item")) {
    const active = hasRunningAgent(row.dataset.conversationId ?? "");
    row.querySelector(".conversation-list-button")?.classList.toggle("busy", active);
    const title = row.querySelector<HTMLElement>(".conversation-title-line");
    const working = busyAgentsIn(row.dataset.conversationId ?? "");
    const indicator = title?.querySelector<HTMLElement>(".ikkyu-thinking");
    if (working.length && title) {
      const name = working.map(agent => agent.displayName).join(", ");
      if (!indicator) title.append(thinkingIndicator(name));
      else indicator.setAttribute("aria-label", t("app.agent.thinking", { name }));
    } else indicator?.remove();
  }
  syncSwitcherThinking();
  syncContactThinking();
  syncHeaderThinking();
}

function busyAgentsIn(conversationId: string): UserRef[] {
  const result: UserRef[] = [];
  for (const [key, cid] of busyAgents) {
    const agentUserId = runtimeState.agentId(key);
    if (cid !== conversationId) continue;
    const user = users.get(agentUserId);
    if (user) result.push(user);
  }
  return result;
}

function renderConversationAgentMenu(conversation?: Conversation): void {
  conversationAgentMenu.replaceChildren();
  const members = conversation?.members.filter((member) => users.get(member.userId)?.isAgent) ?? [];
  const canManage = conversation?.type === "GROUP" && members.length > 0;
  conversationAgentMenuButton.hidden = members.length === 0;
  conversationAgentMenuButton.disabled = !canManage;
  conversationAgentMenuButton.dataset.tooltip = canManage ? t("app.conversationAgents.title") : t("app.conversationAgents.directDisabled");
  // The badge number is hidden from screen readers; the count is carried by aria-label instead
  conversationAgentMenuButton.setAttribute("aria-label", `${conversationAgentMenuButton.dataset.tooltip} (${members.length})`);
  conversationAgentCount.textContent = String(members.length);
  conversationAgentMenu.hidden = !canManage || !conversationAgentMenuOpen;
  if (!conversation || !canManage) return;

  const head = document.createElement("div");
  head.className = "conversation-agent-menu-head";
  head.textContent = t("app.conversationAgents.title");
  conversationAgentMenu.append(head);

  for (const member of members) {
    const agent = users.get(member.userId);
    if (!agent) continue;
    const item = document.createElement("div");
    const avatar = document.createElement("span");
    const summary = document.createElement("span");
    const name = document.createElement("span");
    const signal = document.createElement("span");
    const actions = document.createElement("span");
    const leader = document.createElement("button");
    const busy = runtimeState.isBusy(conversation.conversationId, agent.userId);
    const readinessLight = agentReadinessLight(agent);

    item.className = "conversation-agent-menu-item";
    avatar.className = "conversation-agent-menu-avatar";
    renderContactAvatar(avatar, agent);
    summary.className = "conversation-agent-menu-summary";
    name.className = "conversation-agent-menu-name";
    name.textContent = agent.displayName;

    signal.className = "conversation-agent-menu-state";
    // Availability and pause intent do not prove execution has finished.
    // Keep showing activity through cancellation, result writing and follow-up work.
    const thinking = busy;
    signal.classList.toggle("replying", thinking);
    signal.title = thinking
      ? t("app.agent.working", { name: agent.displayName })
      : t("app.agent.idle", { name: agent.displayName });
    signal.setAttribute("role", "img");
    signal.setAttribute("aria-label", signal.title);
    signal.innerHTML = ikkyuVisual();
    summary.append(name, readinessLight, signal);

    actions.className = "conversation-agent-menu-actions";
    leader.type = "button";
    leader.className = "conversation-agent-leader";
    leader.classList.toggle("active", member.role === "LEADER");
    leader.innerHTML = iconSvg("leader");
    leader.setAttribute("aria-pressed", String(member.role === "LEADER"));
    leader.title = member.role === "LEADER" ? t("app.leader.current") : t("app.leader.set");
    leader.setAttribute("aria-label", `${agent.displayName} · ${leader.title}`);
    leader.addEventListener("click", (event) => {
      event.stopPropagation();
      if (member.role === "LEADER") return;
      leader.disabled = true;
      void bridge
        .setMemberRole(conversation.conversationId, agent.userId, "LEADER")
        .then(async () => {
          await refreshConversations();
          setStatus(t("app.leader.became", { name: agent.displayName }), "info", false, chatKey(conversation.conversationId));
        })
        .catch((error: unknown) => setStatus(describeError(error), "error", false, chatKey(conversation.conversationId)))
        .finally(() => {
          leader.disabled = false;
        });
    });

    actions.append(leader);
    item.append(avatar, summary, actions);
    conversationAgentMenu.append(item);
  }
}

/**
 * Message time.
 *
 * Showing only hours and minutes makes messages from days ago look just sent. So the date is omitted only for today:
 * yesterday shows "Yesterday", within this year add month and day, across years add the year too.
 */
// Creating Intl formatters is expensive and message lists format hundreds of times per render.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${intlLocale()}|${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) { formatter = new Intl.DateTimeFormat(intlLocale(), options); dateFormatters.set(key, formatter); }
  return formatter;
}

function formatTime(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  // Hours and minutes always in 24-hour format, not AM/PM depending on language
  const clock = dateFormatter({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  // Compute the difference in calendar days, not 24-hour periods: 23:00 last night and 01:00 this morning are two hours apart, but it really is yesterday
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);
  if (days <= 0) return clock;
  if (days === 1) return t("app.time.yesterday", { clock });
  const day = dateFormatter(at.getFullYear() === now.getFullYear()
    ? { month: "long", day: "numeric" }
    : { year: "numeric", month: "long", day: "numeric" }).format(at);
  return t("app.time.dated", { day, clock });
}

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;

function boundedSidebarWidth(width: number): number {
  const roomForChat = Math.max(
    SIDEBAR_MIN_WIDTH,
    window.innerWidth - (window.innerWidth <= 960 ? 68 : 76) - 360
  );
  return Math.round(
    Math.min(SIDEBAR_MAX_WIDTH, roomForChat, Math.max(SIDEBAR_MIN_WIDTH, width))
  );
}

function applyChatSidebarLayout(): void {
  chatSidebarWidth = boundedSidebarWidth(chatSidebarWidth);
  const baseTab = activeTab === "agents" ? tabBeforeAgents : activeTab;
  const collapsed = chatSidebarCollapsed &&
    (baseTab === "contacts" || baseTab === "conversations");
  appShell.style.setProperty(
    "--sidebar-width",
    `${collapsed ? 0 : chatSidebarWidth}px`
  );
  chatSidebar.classList.toggle("collapsed", collapsed);
  sidebarToggle.title = collapsed ? t("app.sidebar.expand") : t("app.sidebar.collapse");
  sidebarToggle.setAttribute("aria-label", sidebarToggle.title);
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarResizer.setAttribute("aria-valuenow", String(chatSidebarWidth));
}

function saveChatSidebarWidth(): void {
  localStorage.setItem(sidebarWidthStorageKey, String(chatSidebarWidth));
}

// ---------------------------------------------------------------------------
// Rendering: conversation list
// ---------------------------------------------------------------------------

function lastMessagePreview(conversationId: string): string {
  const list = messagesByConversation.get(conversationId);
  const cached = list
    ?.slice()
    .reverse()
    .find((message) => {
      if (isOperationalMessage(message)) return false;
      const content = displayedMessageContent(message);
      if (!content && message.attachments?.length) return true;
      return content.length > 0 && (conversationById(message.conversationId)?.type === "DIRECT" || !users.get(message.senderId)?.isAgent || content !== "SKIP");
    });
  const preview = conversationById(conversationId)?.lastMessage;
  const last = preview && !isOperationalMessage(preview) && (!cached || preview.seq > cached.seq) ? preview : cached;
  if (!last) return "";
  const content = displayedMessageContent(last) || attachmentSummary(last);
  const prefix =
    last.senderId === me?.userId ? t("app.preview.me") : t("app.preview.sender", { name: userName(last.senderId) });
  return `${prefix}${content.replace(/\s+/g, " ").slice(0, 22)}`;
}

/** The first unread message that @-mentions me; returns 0 if none */
function unreadMentionSeq(conversation: Conversation): number {
  const mine = conversation.members.find(member => member.userId === me?.userId);
  const seq = mine?.firstUnreadMentionSeq ?? 0;
  return seq > (mine?.lastReadSeq ?? 0) ? seq : 0;
}

function unreadCount(conversation: Conversation): number {
  const mine = conversation.members.find((m) => m.userId === me?.userId);
  if (!mine) return 0;
  return Math.max(0, conversation.lastSeq - (mine.lastReadSeq ?? 0));
}

function workspaceById(id: string): Workspace | undefined {
  return workspaces.find((w) => w.workspaceId === id);
}

/** A conversation's row in the sidebar */
function conversationButton(conversation: Conversation): HTMLElement {
  const id = conversation.conversationId;
  const name = conversationName(conversation);
  const busy = busyAgentsIn(id);

  const row = document.createElement("div");
  const button = document.createElement("button");
  const settings = document.createElement("button");
  const remove = document.createElement("button");
  const summary = document.createElement("span");
  const nameEl = document.createElement("span");
  const metaEl = document.createElement("span");

  row.className = "conversation-list-item";
  row.dataset.conversationId = id;
  button.type = "button";
  button.className = "contact-button conversation-list-button";
  button.setAttribute("aria-label", name);
  button.dataset.tooltip = "";
  if (id === selectedId) button.classList.add("active");
  if (busy.length) button.classList.add("busy");
  if (conversation.status !== "ACTIVE") button.classList.add("done");

  nameEl.className = "contact-name";
  nameEl.textContent = name;
  const category = document.createElement("span");
  const categoryKind = isSharedConversation(conversation) ? "shared" : conversation.permanent ? "permanent" : "temporary";
  category.className = `conversation-category ${categoryKind}`;
  category.innerHTML = iconSvg(categoryKind);
  category.setAttribute("aria-label", t(`app.conversation.category.${categoryKind}`));
  category.dataset.tooltip = t(`app.conversation.category.${categoryKind}`);
  const titleLine = document.createElement("span");
  titleLine.className = "conversation-title-line";
  titleLine.append(nameEl);
  if (busy.length) titleLine.append(thinkingIndicator(busy.map(agent => agent.displayName).join(", ")));

  metaEl.className = "contact-meta";
  metaEl.textContent = lastMessagePreview(id) || t("app.conversation.noMessages");
  if (id !== selectedId && unreadMentionSeq(conversation)) {
    const flag = document.createElement("span");
    flag.className = "mention-flag";
    flag.textContent = t("app.mentions.atMe");
    metaEl.prepend(flag);
  }

  summary.className = "contact-summary";
  const previewLine = document.createElement("span");
  previewLine.className = "conversation-preview-line";
  previewLine.append(metaEl);
  if (categoryKind !== "temporary") previewLine.append(category);
  summary.append(titleLine, previewLine);
  button.append(summary);

  const unread = unreadCount(conversation);
  if (unread > 0 && id !== selectedId) {
    const badge = document.createElement("span");
    badge.className = "unread";
    badge.textContent = unread > 99 ? "99+" : String(unread);
    button.append(badge);
  }

  settings.type = "button";
  settings.className = "conversation-item-settings";
  settings.title = t("app.conversation.settingsFor", { name });
  settings.setAttribute("aria-label", t("app.conversation.settingsFor", { name }));
  settings.innerHTML = iconSvg("settings");
  settings.addEventListener("click", (event) => {
    event.stopPropagation();
    openConversationSettings(id);
  });

  remove.type = "button";
  remove.className = "conversation-item-delete";
  remove.title = t("app.conversation.deleteNamed", { name });
  remove.setAttribute("aria-label", t("app.conversation.deleteNamed", { name }));
  remove.innerHTML = iconSvg("delete");
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    openDeleteConfirmation(
      t("app.conversation.deleteTitle"),
      t("app.conversation.deleteCopy", { name }),
      async () => {
        await bridge.deleteConversation(id);
        messageHistory.delete(id);
        renderedMessages.delete(id);
        if (selectedId === id) selectedId = null;
        await refreshConversations();
        if (!selectedId && conversations.length) {
          await selectConversation(conversations[0].conversationId, false);
        } else {
          renderHeader();
          renderMessages();
          syncComposer();
        }
        composerDrafts.delete(chatKey(id));
        chatNotices.delete(chatKey(id));
        failedDrafts.delete(chatKey(id));
        // The notice lands on the composer being viewed after deletion; the deleted conversation's notice was cleared along with it
        setStatus(t("app.conversation.deleted"));
      },
      chatKey(id)
    );
  });

  button.addEventListener("click", () => void selectConversation(id));
  settings.hidden = !isConversationMember(conversation);
  remove.hidden = !isConversationMember(conversation);
  row.append(button, settings, remove);
  return row;
}

/** Direct-chat conversations with this person, most recently active first. Conversations are only direct or group, no longer distinguished by which entry created them */
function directConversationsFor(userId: string): Conversation[] {
  return conversations
    .filter(
      (conversation) =>
        conversation.type === "DIRECT" && isConversationMember(conversation) &&
        conversation.members.some((member) => member.userId === userId)
    )
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
}

function conversationsForContact(userId: string): Conversation[] {
  return conversations
    .filter((conversation) => conversation.members.some((member) => member.userId === userId))
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
}

function beginContactConversation(contact: UserRef, workspaceId?: string): void {
  temporaryUnreadConversationId = undefined;
  // This path has nowhere for the user to enter a name, so the LLM summarizes one from the first message's meaning.
  draftAutoTitle = true;
  draftLeaderId = undefined;
  draftReturnConversationId = selectedId;
  selectedContactId = contact.userId;
  draftContactId = contact.userId;
  draftMemberIds = null;
  draftPermanent = false;
  draftWorkspaceId = workspaceId;
  selectedId = null;
  conversationSwitcherMenu.hidden = true;
  renderConversationList();
  renderHeader();
  renderMessages();
  syncComposer();
  input.focus();
}

/**
 * New task: once Agents are picked, enter a draft; the task is only really created when the first message is sent.
 *
 * The dialog no longer asks for name and goal -- the first message itself is the goal, and the title is named by the LLM from its meaning,
 * so no empty task with no content is left behind.
 */
function beginConversationDraft(memberIds: string[], leaderId?: string): void {
  if (!memberIds.length) return;
  temporaryUnreadConversationId = undefined;
  draftReturnConversationId = selectedId;
  draftPermanent = false;
  draftContactId = null;
  draftMemberIds = memberIds;
  draftWorkspaceId = undefined;
  // Naming relies on an agent; group chats with friends have no agent, so use the first message as the name
  draftAutoTitle = memberIds.some(id => users.get(id)?.isAgent);
  draftLeaderId = leaderId;
  selectedId = null;
  conversationSwitcherMenu.hidden = true;
  renderConversationList();
  renderHeader();
  renderMessages();
  syncComposer();
  input.focus();
}

/** Empty task lists open a ready-to-type draft, without persisting an empty task. */
function ensureDefaultConversationDraft(): void {
  if (conversations.length || selectedId || draftContactId || draftMemberIds?.length) return;
  const agents=[...users.values()].filter(user=>user.isAgent && contactIds.has(user.userId)).sort(compareContacts);
  if (!agents.length) return;
  draftMemberIds=agents.map(agent=>agent.userId);
  draftWorkspaceId=undefined;
  draftReturnConversationId=null;
  draftAutoTitle=true;
  draftLeaderId=undefined;
}

function beginGroupConversationWithSameMembers(conversation: Conversation): void {
  const memberIds = conversation.members
    .map((member) => member.userId)
    .filter((userId) => userId !== me?.userId);
  if (!memberIds.length) return;
  temporaryUnreadConversationId = undefined;
  // There's no entry for entering a name, so leave semantic naming to the LLM.
  draftAutoTitle = true;
  draftLeaderId = undefined;
  draftReturnConversationId = selectedId;
  draftPermanent = false;
  draftContactId = null;
  draftMemberIds = memberIds;
  draftWorkspaceId = conversation.workspaceId;
  selectedId = null;
  conversationSwitcherMenu.hidden = true;
  renderConversationList();
  renderHeader();
  renderMessages();
  syncComposer();
  input.focus();
}

/** Target of the top-right "Add members": an existing conversation, or a draft whose first message hasn't been sent */
function addMemberTargetIds(): string[] | null {
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  if (conversation) return conversation.members.map(member => member.userId).filter(id => id !== me?.userId);
  if (selectedId) return null;
  if (draftMemberIds?.length) return draftMemberIds;
  return draftContactId ? [draftContactId] : null;
}

const ADD_MEMBER_PAGE_SIZE = 40;
/** People already in the conversation when the panel opened. Order stays fixed while the panel is open: if it jumped on every check, the next click would easily hit someone else */
let addMemberPinnedIds = new Set<string>();
let addMemberVisibleCount = ADD_MEMBER_PAGE_SIZE;
let addMemberMatchCount = 0;

/** The reason this row can't be checked or unchecked */
function addMemberLockReason(user: UserRef, memberIds: string[]): string | null {
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  if (memberIds.includes(user.userId)) {
    if (conversation?.type === "DIRECT") return t("app.members.directFixed");
    if (conversation?.owner === user.userId) return t("app.members.ownerFixed");
    if (memberIds.some(id => users.get(id)?.isAgent && users.get(id)?.owner === user.userId)) return t("app.members.agentOwnerFixed");
    return !conversation && memberIds.length <= 1 ? t("app.members.lastFixed") : null;
  }
  const includeSelf = !selectedId || !!conversation?.members.some(member=>member.userId===me?.userId);
  return canJoinTogether(memberIds, user, includeSelf) ? null : joinBlockedReason(memberIds, user, includeSelf);
}

function renderAddMemberMenu(): void {
  const memberIds = addMemberTargetIds();
  if (!memberIds) return;
  const scrollTop = conversationAddMemberList.scrollTop;
  const pinned = (user: UserRef) => addMemberPinnedIds.has(user.userId);
  // Members not in contacts (e.g. people no longer friends) must also be listed, otherwise there's no way to remove them from the conversation
  const listed = [...users.values()].filter(user => contactIds.has(user.userId) && user.userId !== me?.userId);
  for (const id of memberIds) if (!listed.some(user => user.userId === id)) listed.push(users.get(id) ?? {userId:id,displayName:userName(id),isAgent:false} as UserRef);
  const matching = listed
    .filter(user => matchesContact(user, conversationAddMemberSearch.value))
    .sort((left, right) => Number(pinned(right)) - Number(pinned(left)) || compareMembers(left, right));
  addMemberMatchCount = matching.length;
  const rows: HTMLElement[] = [];
  let previous: UserRef | undefined;
  for (const user of matching.slice(0, addMemberVisibleCount)) {
    if (previous && (pinned(previous) !== pinned(user) || previous.isAgent !== user.isAgent)) rows.push(memberGroupDivider());
    previous = user;
    const checked = memberIds.includes(user.userId);
    const lockReason = addMemberLockReason(user, memberIds);
    const row = document.createElement("label");
    row.className = "conversation-agent-menu-item";
    row.dataset.userId = user.userId;
    row.classList.toggle("locked", !!lockReason);
    row.classList.toggle("blocked", !!lockReason && !checked);
    if (lockReason) {
      row.dataset.tooltip = lockReason;
      row.setAttribute("aria-disabled", "true");
    }
    const avatar = document.createElement("span");
    avatar.className = "conversation-agent-menu-avatar";
    renderContactAvatar(avatar, user);
    const summary = document.createElement("span");
    summary.className = "conversation-agent-menu-summary";
    const name = document.createElement("span");
    name.className = "conversation-agent-menu-name";
    name.textContent = user.displayName;
    // In online mode, hovering an agent shows its computer, to tell same-named agents apart
    const computerLabel = agentComputerLabel(user);
    if (computerLabel) name.dataset.tooltip = computerLabel;
    summary.append(name);
    if (user.isAgent) summary.append(agentReadinessLight(user));
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = user.userId;
    box.checked = checked;
    box.disabled = memberMutationPending || !!lockReason;
    box.setAttribute("aria-label", t(checked ? "app.members.removeNamed" : "app.members.addNamed", { name: user.displayName }));
    box.addEventListener("change", () => void (box.checked ? addMemberFromHeader(user) : removeMemberFromHeader(user)));
    row.append(avatar, summary, box);
    rows.push(row);
  }
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "contact-empty compact";
    empty.textContent = conversationAddMemberSearch.value ? t("app.members.noMatch") : t("app.members.noneToAdd");
    rows.push(empty);
  }
  conversationAddMemberList.replaceChildren(...rows);
  conversationAddMemberList.scrollTop = scrollTop;
}

/**
 * Group chats add people directly; direct chats can't add people, so open a group-chat draft with the other party and the newly added people,
 * leaving the original direct chat untouched. Adding during the draft stage just adds to the draft members.
 */
async function addMemberFromHeader(user: UserRef): Promise<void> {
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  if (conversation?.type === "GROUP") {
    await changeConversationMember(conversation.conversationId, () => bridge.addMember(conversation.conversationId, user.userId, "ENGINEER"), t("app.members.added", { name: user.displayName }));
  } else {
    const memberIds = addMemberTargetIds();
    if (!memberIds) return;
    // Adding people in a draft only changes the member combination, and written content goes along; group-chat drafts spun off from an existing direct chat are empty to begin with
    const draftKey = conversation ? null : currentComposerKey();
    if (conversation) {
      draftReturnConversationId = selectedId;
      draftWorkspaceId = conversation.workspaceId;
      draftLeaderId = undefined;
    }
    draftContactId = null;
    draftMemberIds = withAgentOwners([...memberIds, user.userId]);
    // Naming relies on an agent; group chats with friends have no agent, so use the first message as the name
    draftAutoTitle = draftMemberIds.some(id => users.get(id)?.isAgent);
    selectedId = null;
    if (draftKey) moveComposerDraft(draftKey, currentComposerKey());
    conversationSwitcherMenu.hidden = true;
    renderConversationList();
    renderHeader();
    renderMessages();
    syncComposer();
  }
  if (!conversationAddMemberMenu.hidden) renderAddMemberMenu();
}

/**
 * Group chats remove directly; drafts just drop from the members. When a draft spun off from a direct chat goes back to only the other party,
 * return to the original direct chat with written content carried over, so one wrong uncheck doesn't open an extra new direct chat.
 */
async function removeMemberFromHeader(user: UserRef): Promise<void> {
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  if (conversation?.type === "GROUP") {
    await changeConversationMember(conversation.conversationId, () => bridge.removeMember(conversation.conversationId, user.userId), t("app.members.removed", { name: user.displayName }));
  } else if (!conversation) {
    const remaining = (addMemberTargetIds() ?? []).filter(id => id !== user.userId);
    if (!remaining.length) return;
    const draftKey = currentComposerKey();
    const origin = draftReturnConversationId ? conversationById(draftReturnConversationId) : undefined;
    if (origin?.type === "DIRECT" && remaining.length === 1 && origin.members.some(member => member.userId === remaining[0])) {
      moveComposerDraft(draftKey, chatKey(origin.conversationId));
      await selectConversation(origin.conversationId);
    } else {
      draftContactId = null;
      draftMemberIds = remaining;
      if (draftLeaderId === user.userId) draftLeaderId = undefined;
      draftAutoTitle = remaining.some(id => users.get(id)?.isAgent);
      moveComposerDraft(draftKey, currentComposerKey());
      renderConversationList();
      renderHeader();
      renderMessages();
      syncComposer();
    }
  }
  if (!conversationAddMemberMenu.hidden) renderAddMemberMenu();
}

/**
 * Clicking a contact = go back to this person's current focused direct chat.
 *
 * The focus is chosen by the user: opening a new direct chat, or switching to a direct chat via "Switch task".
 * If none chosen yet (or that one no longer exists), land on the most recently created direct chat; only open a new one if there are none.
 */
async function openContact(contact: UserRef): Promise<void> {
  selectedContactId = contact.userId;
  const focused = contactFocus.get(contact.userId);
  const target = (focused && directConversationsFor(contact.userId).find(conversation => conversation.conversationId === focused && conversation.status === "ACTIVE"))
    ?? newestDirectConversationFor(contact.userId);
  if (target) {
    contactFocus.set(contact.userId, target.conversationId);
    await selectConversation(target.conversationId);
    return;
  }
  beginContactConversation(contact);
}

/** Landing spot when no focus has been chosen: the most recently **created** direct chat (by creation time, not most recently active) */
function newestDirectConversationFor(userId: string): Conversation | undefined {
  return directConversationsFor(userId)
    .filter(conversation => conversation.status === "ACTIVE")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

/** When switching to a conversation, only direct chats rewrite this contact's focus */
function rememberFocus(conversation: Conversation | undefined): void {
  if (!conversation || conversation.type !== "DIRECT") return;
  const other = counterpart(conversation);
  if (other) contactFocus.set(other.userId, conversation.conversationId);
}

/** Contacts are only for "finding people". Clicking in still lands in an independent conversation, so different tasks don't get crossed. */
const AGENT_CONTACT_ICONS: Record<AgentKind, string> = {
  codex: "./assets/agents/codex.png",
  "claude-code": "./assets/agents/claude-code.png",
  qoder: "./assets/agents/qoder.png",
  "qoder-cn": "./assets/agents/qoder-cn.png",
  "qwen-code": "./assets/agents/qwen-code.png",
  kiro: "./assets/agents/kiro.png", copilot: "./assets/agents/copilot.png", antigravity: "./assets/agents/antigravity.png"
};

const AGENT_REAL_NAMES: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  "qwen-code": "Qwen Code",
  kiro: "Kiro", copilot: "GitHub Copilot", antigravity: "Antigravity"
};

let detailContact: UserRef | null = null;
let pendingContactAvatar: string | undefined;
let pendingDeleteAction: (() => Promise<void>) | null = null;
let pendingDeleteContext = "";

function openDeleteConfirmation(
  title: string,
  copy: string,
  action: () => Promise<void>,
  context = currentComposerKey()
): void {
  deleteConfirmTitle.textContent = title;
  deleteConfirmCopy.textContent = copy;
  pendingDeleteAction = action;
  pendingDeleteContext = context;
  deleteConfirmAction.disabled = false;
  deleteConfirmAction.textContent = t("app.common.delete");
  deleteConfirmDialog.showModal();
}

function closeDeleteConfirmation(): void {
  pendingDeleteAction = null;
  if (deleteConfirmDialog.open) deleteConfirmDialog.close();
}

function renderContactAgentStatus(contact: UserRef, status?: AgentStatus): void {
  contactDetailStatus.replaceChildren();
  contactDetailStatus.hidden = !contact.isAgent;
  if (!contact.isAgent) return;

  const offline = !!contact.remote && !contact.remote.online;
  const described = agentSignal(contact);
  const lamp = document.createElement("span");
  lamp.className = `agent-lamp ${described.lamp}`;
  contactDetailStatus.className = `agent-signal contact-detail-status ${described.tone}`.trim();
  contactDetailStatus.title = status && !offline ? agentTooltip(status) : "";
  contactDetailStatus.append(
    lamp,
    document.createTextNode(status && !offline ? activeAgentStatusText(status) : described.text)
  );
  if (status && !offline) appendAgentFailureDetail(contactDetailStatus, status);
}

function openContactDetail(contact: UserRef): void {
  detailContact = contact;
  contactDetailTitle.textContent = t("app.contactDetail.title");
  const status = agentStatusOf(contact);
  pendingContactAvatar = contact.avatarUrl;
  renderContactAvatar(contactDetailAvatar, contact, pendingContactAvatar);
  contactAvatarInput.value = "";
  contactDetailName.value = contact.displayName;
  const borrowedAgent = accountStatus.signedIn && contact.isAgent && !!contact.owner && contact.owner !== me?.userId;
  contactDetailName.readOnly = borrowedAgent;
  contactDetailSave.hidden = borrowedAgent;
  contactDetailUsername.value = contact.username ??
    (contact.isAgent ? contact.kind ?? "agent" : contact.displayName);
  renderContactAgentStatus(contact, status);
  const agentOnlyFields = [
    contactAgentKindField,
    contactAgentVersionField
  ];
  // Computer: name plus computer ID. Hovering same-named agents in the list only shows the computer name; the full ID is here
  const computer = agentComputerOf(contact);
  contactAgentComputerField.hidden = !computer;
  contactDetailComputer.value = computer ? `${computer.name}（${computer.computerId}）` : "";
  const humanOnlyFields = [contactPhoneField, contactEmailField];
  for (const field of agentOnlyFields) {
    field.hidden = !contact.isAgent;
  }
  for (const field of humanOnlyFields) {
    field.hidden = contact.isAgent;
  }

  contactDetailAgentKind.value = contact.isAgent && contact.kind
    ? AGENT_REAL_NAMES[contact.kind]
    : "";
  contactDetailVersion.value = contact.isAgent
    ? contact.remote ? contact.version ?? "" : contact.version ?? status?.version ?? ""
    : "";
  contactDetailPhone.value = contact.isAgent ? "" : contact.phone ?? "";
  contactDetailEmail.value = contact.isAgent ? "" : contact.email ?? "";
  contactDetailPhone.disabled = contact.isAgent;
  contactDetailEmail.disabled = contact.isAgent;
  void loadContactModels(contact);
  contactDetailError.textContent = "";
  contactDetailRefreshStatus.hidden = !contact.isAgent;
  contactDetailRefreshStatus.disabled = false;
  contactDetailRefreshStatus.textContent = t("html.profile.refreshStatus");
  // Passwords belong to signed-in accounts: the standalone (not signed in) edition has no password, and other people's profile pages shouldn't have this entry either
  contactChangePassword.hidden = !(accountStatus.signedIn && !contact.isAgent && contact.userId === me?.userId);
  contactDetailDialog.showModal();
}

// Opening details reads the model list, which runs the CLI once; if another contact is opened while reading, the old result is discarded.
let contactModelLoad = 0;
let contactModelSaved = "";

async function loadContactModels(contact: UserRef): Promise<void> {
  const load = ++contactModelLoad;
  contactAgentModelField.hidden = true;
  contactDetailModel.replaceChildren();
  contactModelSaved = "";
  contactDetailModel.title = "";
  // Agents on other computers: can only be configured once that side has reported model status; borrowed ones and those on old clients don't have it
  if (!contact.isAgent || !contact.kind || (contact.remote && !contact.remote.model)) return;
  const option = (value: string, label: string, title?: string): HTMLOptionElement => {
    const item = document.createElement("option");
    item.value = value;
    item.textContent = label;
    if (title) item.title = title;
    return item;
  };
  contactAgentModelField.hidden = false;
  contactDetailModel.disabled = true;
  contactDetailModel.append(option("", t("app.profile.modelLoading")));
  contactDetailModelHint.textContent = "";
  let catalog: AgentModelCatalog;
  try {
    catalog = await bridge.agentModelCatalog(contact.userId);
  } catch (error) {
    catalog = { supported: true, models: [], selected: contact.modelConfig?.model, error: describeError(error) };
  }
  if (load !== contactModelLoad) return;
  if (!catalog.supported) {
    contactAgentModelField.hidden = true;
    return;
  }
  const native = catalog.nativeModel
    ? catalog.models.find((model) => model.id === catalog.nativeModel || model.label === catalog.nativeModel)?.label ?? catalog.nativeModel
    : "";
  const options = [option("", native
    ? t("app.profile.modelDefaultCurrent", { model: native })
    : t("app.profile.modelDefault"))];
  for (const model of catalog.models) options.push(option(model.id, model.label, model.description));
  const selected = catalog.selected ?? "";
  if (selected && !catalog.models.some((model) => model.id === selected)) {
    options.push(option(selected, catalog.selectedLabel ?? t("app.profile.modelMissing", { model: selected })));
  }
  contactDetailModel.replaceChildren(...options);
  contactDetailModel.value = selected;
  contactModelSaved = selected;
  // When the list can't be read the model can't be changed, but the current selection is still shown
  contactDetailModel.disabled = !catalog.models.length || !!catalog.readOnly;
  contactDetailModel.title = catalog.readOnly ? t("app.agent.computerOffline") : "";
  contactDetailModelHint.textContent = catalog.error ? t("app.profile.modelFailed", { reason: catalog.error }) : "";
}

/** Change the account password. The old password is verified by the backend; the UI only does local checks like "the two new passwords match" */
async function submitPasswordChange(): Promise<void> {
  const current = passwordCurrent.value;
  const next = passwordNew.value;
  if (!current || !next) {
    passwordError.textContent = t("app.password.allRequired");
    return;
  }
  if (next !== passwordConfirm.value) {
    passwordError.textContent = t("app.password.mismatch");
    return;
  }
  if (next === current) {
    passwordError.textContent = t("app.password.same");
    return;
  }
  passwordError.textContent = "";
  passwordSubmit.disabled = true;
  passwordSubmit.textContent = t("app.common.saving");
  try {
    await bridge.changeAccountPassword?.(current, next);
    passwordDialog.close();
    setStatus(t("app.password.changed"));
  } catch (error) {
    passwordError.textContent = describeError(error);
  } finally {
    passwordSubmit.disabled = false;
    passwordSubmit.textContent = t("app.common.save");
  }
}

async function saveContactDetail(): Promise<void> {
  const contact = detailContact;
  if (!contact || (contact.isAgent && contact.owner && contact.owner !== me?.userId)) return;
  const editingMe = contact.userId === me?.userId;
  contactDetailSave.disabled = true;
  contactDetailSave.textContent = t("app.common.saving");
  contactDetailError.textContent = "";
  try {
    if (contact.isAgent && !contactAgentModelField.hidden && !contactDetailModel.disabled
        && contactDetailModel.value !== contactModelSaved) {
      await bridge.setAgentModel(contact.userId, contactDetailModel.value || null);
    }
    const patch = {
      // Unchanged English default names (e.g. Cody) in the English UI are saved back as the Chinese default names, so switching back to the Chinese UI won't turn them English
      displayName: contact.isAgent ? storedAgentName(contact.kind, contactDetailName.value) : contactDetailName.value,
      avatarUrl: pendingContactAvatar ?? "",
      phone: contact.isAgent ? undefined : contactDetailPhone.value,
      email: contact.isAgent ? undefined : contactDetailEmail.value
    };
    // When signed in, this edits the account's own profile; only when not signed in does it edit the standalone profile; the two never overwrite each other
    const saveToAccount = editingMe && accountStatus.signedIn && localMe !== null;
    const updated = saveToAccount
      ? identityFrom(localMe as UserRef, await bridge.updateAccountProfile(patch))
      : await bridge.updateContact(contact.userId, patch);
    if (editingMe && !saveToAccount) localMe = updated;
    users.set(updated.userId, withLocalizedName(updated));
    detailContact = withLocalizedName(updated);
    if (editingMe) {
      ++identityGeneration;
      me = updated;
      renderCurrentUserIdentity();
      renderMessages();
    }
    renderConversationList();
    renderHeader();
    contactDetailDialog.close();
    setStatus(editingMe ? t("app.profile.meSaved") : t("app.profile.contactSaved"));
  } catch (error) {
    contactDetailError.textContent = describeError(error);
  } finally {
    contactDetailSave.disabled = false;
    contactDetailSave.textContent = t("app.common.save");
  }
}

function renderContactAvatar(
  container: HTMLElement,
  contact: UserRef,
  override?: string
): void {
  container.replaceChildren();
  container.title = contact.displayName;
  container.classList.toggle("agent-avatar-white", contact.isAgent);
  const customAvatar = override !== undefined ? override : contact.avatarUrl;
  const defaultAvatar = contact.isAgent && contact.kind
    ? AGENT_CONTACT_ICONS[contact.kind]
    : mode === "local" && contact.userId === me?.userId
      ? "./assets/ading.png"
      : undefined;
  const source = customAvatar || defaultAvatar;
  if (source) {
    const icon = document.createElement("img");
    icon.src = source;
    icon.alt = "";
    container.append(icon);
    return;
  }
  container.textContent = contact.displayName.slice(0, 1).toUpperCase();
}

function openAvatarPreview(source: string): void {
  avatarPreviewImage.src = source;
  avatarPreviewDialog.showModal();
}

/** The title bar, main navigation and own messages always use the same real-person profile. */
function renderCurrentUserIdentity(): void {
  if (!me) return;
  renderContactAvatar(currentUserRailAvatar, me);
  currentUserRailAvatar.title = me.displayName;
}

function appendReadonlyProfileItem(label: string, value?: string): void {
  const item = document.createElement("div");
  const key = document.createElement("span");
  const text = document.createElement("strong");
  item.className = "readonly-profile-item";
  key.textContent = label;
  text.textContent = value?.trim() || "—";
  item.append(key, text);
  readonlyProfileGrid.append(item);
}

function openReadOnlyProfile(contact: UserRef): void {
  readonlyProfileGrid.replaceChildren();
  renderContactAvatar(readonlyProfileAvatar, contact);
  readonlyProfileName.textContent = contact.displayName;
  readonlyProfileSubtitle.textContent = contact.isAgent
    ? contact.kind ? AGENT_REAL_NAMES[contact.kind] : "Agent"
    : t("app.profile.human");
  appendReadonlyProfileItem(t("app.profile.username"), contact.username);
  if (contact.isAgent) {
    appendReadonlyProfileItem(t("app.profile.status"), agentSignal(contact).text);
    appendReadonlyProfileItem(
      t("app.profile.agentKind"),
      contact.kind ? AGENT_REAL_NAMES[contact.kind] : undefined
    );
    appendReadonlyProfileItem(t("app.profile.agentVersion"), contact.version);
  } else {
    appendReadonlyProfileItem(t("app.profile.phone"), contact.phone);
    appendReadonlyProfileItem(t("app.profile.email"), contact.email);
  }
  readonlyProfileDialog.showModal();
}

// ---------------------------------------------------------------------------
// Help and support
// ---------------------------------------------------------------------------

type SupportTab = "report" | "developer" | "tip";
let supportScreenshot: SupportImagePayload | undefined;
let supportUserImages: SupportImagePayload[] = [];

function localSecondValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

function setSupportFeedback(
  element: HTMLElement,
  text: string,
  error = false
): void {
  element.textContent = text;
  element.classList.toggle("error", error);
}

/** Issue reports and contact-the-developer both have two forms: filling in, and the result page after submitting. */
function showSupportReportDone(done: boolean): void {
  supportReportDone.hidden = !done;
  supportReportPanel.hidden = done;
}

function showSupportDeveloperDone(done: boolean): void {
  supportDeveloperDone.hidden = !done;
  supportDeveloperPanel.hidden = done;
}

function switchSupportTab(tab: SupportTab): void {
  for (const button of supportTabs) {
    button.classList.toggle("active", button.dataset.supportTab === tab);
  }
  // Switching to another tab and back should give a clean form, not the last result page.
  if (tab !== "report") supportReportDone.hidden = true;
  if (tab !== "developer") supportDeveloperDone.hidden = true;
  supportReportPanel.hidden = tab !== "report" || !supportReportDone.hidden;
  supportDeveloperPanel.hidden = tab !== "developer" || !supportDeveloperDone.hidden;
  supportTipPanel.hidden = tab !== "tip";
}

function renderSupportScreenshot(): void {
  supportCapturePreview.replaceChildren();
  if (!supportScreenshot) {
    supportCapturePreview.textContent = t("app.support.captureFailed");
    supportCaptureStatus.textContent = t("app.support.captureFailedHint");
    return;
  }
  const image = document.createElement("img");
  image.src = supportScreenshot.dataUrl;
  image.alt = t("app.support.captureAlt");
  supportCapturePreview.append(image);
  supportCaptureStatus.textContent = t("app.support.captureReady");
}

function renderSupportAttachments(): void {
  supportAttachments.replaceChildren();
  supportUserImages.forEach((attachment, index) => {
    const item = document.createElement("div");
    item.className = "support-attachment";
    item.title = attachment.name;
    const image = document.createElement("img");
    image.src = attachment.dataUrl;
    image.alt = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = t("app.support.removeImage");
    remove.setAttribute("aria-label", t("app.support.removeNamed", { name: attachment.name }));
    remove.innerHTML = iconSvg("close");
    remove.addEventListener("click", () => {
      supportUserImages.splice(index, 1);
      renderSupportAttachments();
    });
    item.append(image, remove);
    supportAttachments.append(item);
  });
  supportAddImage.disabled = supportUserImages.length >= 5;
}

let supportDeveloperFiles: DeveloperContactAttachment[] = [];

function renderSupportDeveloperFiles(): void {
  supportDeveloperAttachments.replaceChildren();
  supportDeveloperFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "support-file";
    const name = document.createElement("span");
    name.textContent = file.name;
    name.title = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = t("app.support.removeNamed", { name: file.name });
    remove.setAttribute("aria-label", t("app.support.removeNamed", { name: file.name }));
    remove.innerHTML = iconSvg("close");
    remove.addEventListener("click", () => {
      supportDeveloperFiles.splice(index, 1);
      renderSupportDeveloperFiles();
    });
    item.append(name, remove);
    supportDeveloperAttachments.append(item);
  });
  supportDeveloperAddFile.disabled = supportDeveloperFiles.length >= 5;
}

function fileAsContactAttachment(file: File): Promise<DeveloperContactAttachment> {
  return new Promise((resolve, reject) => {
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error(t("app.support.imageTooLarge", { name: file.name })));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error(t("app.support.imageReadFailed", { name: file.name })));
        return;
      }
      // readAsDataURL's result is data:<type>;base64,<content>; an empty file has no content part
      const comma = reader.result.indexOf(",");
      resolve({ name: file.name, mimeType: file.type, base64: reader.result.slice(comma + 1) });
    });
    reader.addEventListener("error", () => reject(new Error(t("app.support.imageReadFailed", { name: file.name }))));
    reader.readAsDataURL(file);
  });
}

function fileAsSupportImage(file: File): Promise<SupportImagePayload> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      reject(new Error(t("app.support.imageUnsupported", { name: file.name })));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error(t("app.support.imageTooLarge", { name: file.name })));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error(t("app.support.imageReadFailed", { name: file.name })));
        return;
      }
      resolve({ name: file.name, mimeType: file.type, dataUrl: reader.result });
    });
    reader.addEventListener("error", () => reject(new Error(t("app.support.imageReadFailed", { name: file.name }))));
    reader.readAsDataURL(file);
  });
}

async function openSupport(): Promise<void> {
  supportEntry.disabled = true;
  setSupportFeedback(supportReportFeedback, "");
  showSupportReportDone(false);
  showSupportDeveloperDone(false);
  switchSupportTab("report");
  supportCapturePreview.textContent = t("app.support.capturing");
  supportCaptureStatus.textContent = t("app.support.preparing");
  supportReportOccurredAt.value = localSecondValue();
  try {
    // Must capture before the dialog appears, otherwise the screenshot only shows the "Report an issue" window.
    supportScreenshot = (await bridge.captureSupportScreenshot()) ?? undefined;
  } catch {
    supportScreenshot = undefined;
  } finally {
    renderSupportScreenshot();
    supportEntry.disabled = false;
    supportDialog.showModal();
  }
}

async function submitSupportReport(): Promise<void> {
  supportSubmitReport.disabled = true;
  setSupportFeedback(supportReportFeedback, t("app.support.savingReport"));
  try {
    const result = await bridge.submitSupportReport({
      occurredAt: new Date(supportReportOccurredAt.value).toISOString(),
      description: supportReportDescription.value,
      screenshot: supportScreenshot,
      images: supportUserImages
    });
    supportReportDescription.value = "";
    supportUserImages = [];
    renderSupportAttachments();
    setSupportFeedback(supportReportFeedback, "");
    // Switch to the result page after submitting: showing an identical empty form again makes it impossible to tell whether it worked.
    supportDoneDetail.textContent =
      result.status === "uploaded"
        ? t("app.support.reportUploaded")
        : result.backgroundUpload
          ? t("app.support.reportBackground")
          : t("app.support.reportQueued");
    supportDoneId.textContent = t("app.support.reportId", { id: result.reportId });
    showSupportReportDone(true);
  } catch (error) {
    setSupportFeedback(supportReportFeedback, describeError(error), true);
  } finally {
    supportSubmitReport.disabled = false;
  }
}

async function contactDeveloper(): Promise<void> {
  supportEmailDeveloper.disabled = true;
  setSupportFeedback(supportDeveloperFeedback, t("app.support.saving"));
  try {
    const result = await bridge.contactDeveloper({
      subject: supportDeveloperSubject.value,
      content: supportDeveloperContent.value,
      replyTo: supportDeveloperReplyTo.value,
      attachments: supportDeveloperFiles
    });
    const replied = supportDeveloperReplyTo.value.trim();
    supportDeveloperSubject.value = "";
    supportDeveloperContent.value = "";
    supportDeveloperReplyTo.value = "";
    supportDeveloperFiles = [];
    renderSupportDeveloperFiles();
    setSupportFeedback(supportDeveloperFeedback, "");
    // Same as issue reports: switch to the result page after sending, don't show another empty form.
    supportDeveloperDoneDetail.textContent = result.backgroundUpload
      ? replied
        ? t("app.support.devBackgroundReply", { reply: replied })
        : t("app.support.devBackgroundNoReply")
      : t("app.support.devQueued");
    supportDeveloperDoneId.textContent = t("app.support.contactId", { id: result.contactId });
    showSupportDeveloperDone(true);
  } catch (error) {
    setSupportFeedback(supportDeveloperFeedback, describeError(error), true);
  } finally {
    supportEmailDeveloper.disabled = false;
  }
}

// Keep the first click's target: opening the focused chat can clear its unread
// count before the second click arrives.
const contactUnreadClickTargets = new Map<string, string | undefined>();

function newestUnreadDirectConversationFor(userId: string): Conversation | undefined {
  return directConversationsFor(userId)
    .filter(conversation => conversation.status === "ACTIVE" && conversation.conversationId !== selectedId && unreadCount(conversation) > 0)
    .sort((left, right) =>
      Date.parse(right.lastMessage?.createdAt ?? right.updatedAt) - Date.parse(left.lastMessage?.createdAt ?? left.updatedAt)
      || left.conversationId.localeCompare(right.conversationId))[0];
}

function contactButton(contact: UserRef): HTMLElement {
  const row = document.createElement("div");
  const button = document.createElement("button");
  const remove = document.createElement("button");
  const avatar = document.createElement("span");
  const summary = document.createElement("span");
  const name = document.createElement("span");

  row.className = "contact-list-item";
  row.dataset.memberKind = contact.isAgent ? "agent" : "human";
  row.dataset.userId = contact.userId;
  row.dataset.ownAgent = String(contact.isAgent && (!contact.owner || contact.owner === me?.userId));
  button.type = "button";
  button.className = "contact-button person";
  button.setAttribute("aria-label", t("app.contact.chatWith", { name: contact.displayName }));
  // Screen readers need the aria-label above, but mouse hover needn't pop another bubble:
  // the contact row itself shows the name, so the tooltip adds no new information. Agents in online mode are the exception:
  // hovering shows their computer -- when each of two computers has a "小c", the names can't tell them apart
  button.dataset.tooltip = agentComputerLabel(contact);
  if (selectedContactId === contact.userId) button.classList.add("active");
  if (agentBusyAnywhere(contact.userId)) button.classList.add("busy");

  avatar.className = "avatar";
  if (contact.avatarUrl || (contact.isAgent && contact.kind)) {
    avatar.classList.add("agent-avatar");
  }
  renderContactAvatar(avatar, contact);
  name.className = "contact-name";
  name.textContent = contact.displayName;
  summary.className = "contact-summary";
  summary.append(name);
  if (contact.isAgent) {
    const status = agentStatusOf(contact);
    const offline = !!contact.remote && !contact.remote.online;
    const described = agentSignal(contact);
    const state = document.createElement("span");
    const stateLamp = document.createElement("span");
    state.className = `agent-signal contact-list-signal ${described.tone}`.trim();
    // A red light only means unavailable and shows no specific reason: that string of paths, versions and English raw text
    // is long and useless in the contact list; the text beside the light already explains the situation.
    state.dataset.tooltip = "";
    stateLamp.className = `agent-lamp ${described.lamp}`;
    state.append(
      stateLamp,
      document.createTextNode(status && !offline ? activeAgentStatusText(status) : described.text)
    );
    if (agentBusyAnywhere(contact.userId)) state.append(thinkingIndicator(contact.displayName));
    summary.append(state);
  }
  button.append(avatar, summary);
  // Unread: sum of all their active direct chats (excluding the one being viewed); badge uses the same style as the task list
  const unread = directConversationsFor(contact.userId)
    .filter((conversation) => conversation.status === "ACTIVE" && conversation.conversationId !== selectedId)
    .reduce((sum, conversation) => sum + unreadCount(conversation), 0);
  if (unread > 0) {
    const badge = document.createElement("span");
    badge.className = "unread";
    badge.textContent = unread > 99 ? "99+" : String(unread);
    button.append(badge);
  }
  avatar.title = t("app.contact.viewDetail");
  button.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.closest(".avatar")) {
      // A reused row must open the latest profile, including fields not shown in the row.
      const current = users.get(contact.userId) ?? contact;
      // A friend's profile is their own; it can only be viewed here, not edited
      if (!current.isAgent && current.userId !== me?.userId) openReadOnlyProfile(current);
      else openContactDetail(current);
      return;
    }
    if (event.detail > 1) return;
    contactUnreadClickTargets.clear();
    contactUnreadClickTargets.set(contact.userId, newestUnreadDirectConversationFor(contact.userId)?.conversationId);
    void openContact(users.get(contact.userId) ?? contact);
  });
  button.addEventListener("dblclick", (event) => {
    if ((event.target as Element).closest(".avatar")) return;
    const targetId = contactUnreadClickTargets.get(contact.userId);
    contactUnreadClickTargets.clear();
    const target = targetId ? conversationById(targetId) : newestUnreadDirectConversationFor(contact.userId);
    if (!target || target.status !== "ACTIVE" || target.type !== "DIRECT"
      || !target.members.some(member => member.userId === contact.userId)) return;
    selectedContactId = contact.userId;
    rememberFocus(target);
    void selectConversation(target.conversationId);
  });

  remove.type = "button";
  remove.className = "contact-item-delete";
  const person = !contact.isAgent;
  remove.title = t(person ? "app.friends.deleteNamed" : "app.contact.deleteNamed", { name: contact.displayName });
  remove.setAttribute("aria-label", remove.title);
  remove.innerHTML = iconSvg("delete");
  remove.addEventListener("click", () => {
    openDeleteConfirmation(
      t(person ? "app.friends.deleteTitle" : "app.contact.deleteTitle"),
      t(person ? "app.friends.deleteCopy" : "app.contact.deleteCopy", { name: contact.displayName }),
      async () => {
        await bridge.deleteContact(contact.userId);
        contactIds.delete(contact.userId);
        if (selectedContactId === contact.userId) selectedContactId = null;
        if (draftContactId === contact.userId) draftContactId = null;
        // The Agent page row is the status of this type of agent on this machine; deleting a contact on another computer doesn't affect it
        if (contact.kind && !contact.remote) {
          const status = agentCatalog.find((candidate) => candidate.kind === contact.kind);
          if (status) status.added = false;
        }
        await refreshConversations();
        renderAgents();
        setStatus(t("app.contact.deleted"));
      }
    );
  });
  if (contact.isAgent) {
    const share = document.createElement("button"); share.type = "button"; share.className = "contact-item-share";
    share.innerHTML = iconSvg("share");
    const owned = !contact.owner || contact.owner === me?.userId;
    const allowed = accountStatus.signedIn && owned;
    share.setAttribute("aria-disabled",String(!allowed));
    share.dataset.tooltip = t(!accountStatus.signedIn ? "app.share.signIn" : !owned ? "app.share.ownerOnly" : "app.share.action");
    share.setAttribute("aria-label",share.dataset.tooltip);
    share.addEventListener("click",() => { if (allowed) openAgentSharing(users.get(contact.userId) ?? contact); });
    row.append(button, share, remove);
  } else row.append(button, remove);
  return row;
}

let sharingDialog: HTMLDialogElement | undefined;
function openAgentSharing(agent: UserRef): void {
  sharingDialog?.remove();
  const dialog=document.createElement("dialog"); dialog.className="contact-detail-dialog agent-share-dialog";
  sharingDialog=dialog;
  const card=document.createElement("form"); card.className="contact-detail-card";
  const heading=document.createElement("h2"); heading.textContent=t("app.share.title",{name:agent.displayName});
  const close=document.createElement("button"); close.type="button"; close.className="contact-detail-close"; close.innerHTML=iconSvg("close");
  close.dataset.tooltip=t("html.common.close"); close.setAttribute("aria-label",close.dataset.tooltip); close.onclick=()=>dialog.close();
  const list=document.createElement("div"); list.className="agent-share-list";
  const people=[...users.values()].filter(user=>!user.isAgent && user.friend===true && user.userId!==me?.userId);
  const boxes=new Map<string,HTMLInputElement>();
  for (const person of people) {
    const label=document.createElement("label"); label.className="agent-share-person";
    const checkbox=document.createElement("input"); checkbox.type="checkbox"; checkbox.checked=agent.sharedWith?.includes(person.userId)??false;
    checkbox.setAttribute("aria-label",person.displayName); boxes.set(person.userId,checkbox);
    const avatar=document.createElement("span"); avatar.className="avatar"; renderContactAvatar(avatar,person);
    const name=document.createElement("span"); name.textContent=person.displayName;
    label.append(checkbox,avatar,name); list.append(label);
  }
  if(!people.length){const empty=document.createElement("p");empty.textContent=t("app.share.noFriends");list.append(empty);}
  const error=document.createElement("p");error.className="contact-detail-error";error.setAttribute("role","status");
  const actions=document.createElement("div");actions.className="contact-detail-actions";
  const save=document.createElement("button");save.type="submit";save.className="primary";save.textContent=t("app.common.save");save.disabled=!people.length;
  actions.append(save);card.append(heading,close,list,error,actions);dialog.append(card);document.body.append(dialog);
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});
  card.addEventListener("submit",event=>{
    event.preventDefault();
    const changes=[...boxes].filter(([id,box])=>box.checked!==(agent.sharedWith?.includes(id)??false));
    if(!changes.length){dialog.close();return;}
    if(changes.some(([,box])=>box.checked) && !window.confirm(t("app.share.warning")))return;
    save.disabled=true;
    void (async()=>{
      for(const [id,box] of changes)await bridge.shareAgent(agent.userId,id,box.checked);
      await refreshConversations();dialog.close();
    })().catch(cause=>{error.textContent=describeError(cause);save.disabled=false;});
  });
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Add friends (online edition only)
//
// Agents don't interconnect by default: this only finds and adds real people. Chatting between friends is a task with only real people,
// reusing the task list, unread counts and message UI; agents never appear in friends' tasks.
// ---------------------------------------------------------------------------

let friendRequests: FriendPerson[] = [];
/** Results of the latest search; redrawn with the new relationship after requesting or accepting */
let friendSearchHits: FriendPerson[] | null = null;
let friendActionPending = false;

async function refreshFriendRequests(): Promise<void> {
  friendRequests = accountStatus.signedIn ? await bridge.listFriendRequests().catch(() => friendRequests) : [];
  const incoming=friendRequests.filter(request=>request.relation==="INCOMING").length;
  const contactsTab=el<HTMLButtonElement>("#tab-contacts");
  contactsTab.querySelector(".friend-request-dot")?.remove();
  if(incoming){const dot=document.createElement("span");dot.className="friend-request-dot";dot.setAttribute("aria-label",t("app.friends.pendingCount",{count:incoming}));contactsTab.append(dot);}
  renderNavigationUnread();
  if (activeTab === "contacts") renderConversationList();
  if (friendDialog.open) renderFriendDialog();
}

function addFriendButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-add-button";
  button.innerHTML = iconSvg("personAdd");
  button.setAttribute("aria-label", t("app.friends.add"));
  const allowed = accountStatus.signedIn && accountStatus.canAddFriend === true;
  button.setAttribute("aria-disabled", String(!allowed));
  button.dataset.tooltip = allowed ? t("app.friends.add")
    : t(accountStatus.signedIn && accountStatus.canAddFriend === false
      ? "app.friends.regionUnavailable" : "app.friends.regionPending");
  button.addEventListener("click", () => openFriendDialog());
  return button;
}

function friendRequestsRow(count: number): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "friend-requests-row";
  const text = document.createElement("span");
  text.textContent = t("app.friends.newRequests");
  const badge = document.createElement("span");
  badge.className = "friend-badge";
  badge.textContent = String(count);
  row.innerHTML = iconSvg("personAdd");
  row.append(text, badge);
  // When available, don't repeat the inline text; when disabled, the tooltip gives the region reason.
  const allowed = accountStatus.signedIn && accountStatus.canAddFriend === true;
  row.setAttribute("aria-disabled", String(!allowed));
  row.dataset.tooltip = allowed ? "" : t(accountStatus.signedIn && accountStatus.canAddFriend === false
    ? "app.friends.regionUnavailable" : "app.friends.regionPending");
  row.addEventListener("click", () => openFriendDialog());
  return row;
}

function openFriendDialog(): void {
  if (!accountStatus.signedIn || accountStatus.canAddFriend !== true) return;
  friendSearchInput.value = "";
  friendSearchHits = null;
  friendError.textContent = "";
  renderFriendDialog();
  friendDialog.showModal();
  friendSearchInput.focus();
  void refreshFriendRequests();
}

function renderFriendDialog(): void {
  friendSearchSubmit.disabled = friendActionPending;
  friendSearchResults.replaceChildren();
  if (friendSearchHits) {
    if (!friendSearchHits.length) {
      const empty = document.createElement("div");
      empty.className = "friend-empty";
      empty.textContent = t("app.friends.notFound");
      friendSearchResults.append(empty);
    }
    for (const person of friendSearchHits) friendSearchResults.append(friendRow(person));
  }
  // "Friend requests" only holds ones others sent me; ones I sent that the other side hasn't accepted get their own section, so they can be withdrawn later.
  // If the search results already have this person (the row has "Pending" and withdraw/accept buttons), don't list them again below, so the same person doesn't appear twice
  const inSearch = new Set((friendSearchHits ?? []).map(person => person.userId));
  const incomingAll = friendRequests.filter(request => request.relation === "INCOMING");
  const incoming = incomingAll.filter(request => !inSearch.has(request.userId));
  const outgoing = friendRequests.filter(request => request.relation === "OUTGOING" && !inSearch.has(request.userId));
  friendRequestList.replaceChildren();
  if (!incomingAll.length) {
    const empty = document.createElement("div");
    empty.className = "friend-empty";
    empty.textContent = t("app.friends.noRequests");
    friendRequestList.append(empty);
  }
  for (const person of incoming) friendRequestList.append(friendRow(person));
  friendOutgoingList.replaceChildren(...outgoing.map(friendRow));
  friendOutgoingTitle.hidden = !outgoing.length;
}

function friendRow(person: FriendPerson): HTMLElement {
  const row = document.createElement("div");
  row.className = "friend-row";
  row.dataset.userId = person.userId;
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  renderContactAvatar(avatar, { userId: person.userId, displayName: person.displayName, avatarUrl: person.avatarUrl, isAgent: false });
  const text = document.createElement("span");
  text.className = "friend-row-text";
  const name = document.createElement("span");
  name.className = "friend-row-name";
  name.textContent = person.displayName;
  const sub = document.createElement("span");
  sub.className = "friend-row-sub";
  sub.textContent = person.username;
  text.append(name, sub);
  row.append(avatar, text);
  const actions = document.createElement("span");
  actions.className = "friend-row-actions";
  const state = (label: string) => {
    const span = document.createElement("span");
    span.className = "friend-row-state";
    span.textContent = label;
    row.append(span);
  };
  if (person.relation === "FRIEND") {
    state(t("app.friends.alreadyFriends"));
  } else if (person.relation === "NONE") {
    actions.append(friendActionButton("personAdd", t("app.friends.sendRequest"), () => bridge.requestFriend(person.userId)
      .then((relation) => { setStatus(t(relation === "FRIEND" ? "app.friends.nowFriends" : "app.friends.requestSent", { name: person.displayName })); return relation; })));
  } else if (person.relation === "OUTGOING") {
    state(t("app.friends.waiting"));
    actions.append(friendActionButton("close", t("app.friends.withdraw"), () => bridge.dismissFriendRequest(person.userId)
      .then(() => { setStatus(t("app.friends.withdrawn")); return "NONE" as const; })));
  } else {
    actions.append(
      friendActionButton("check", t("app.friends.accept"), () => bridge.acceptFriend(person.userId)
        .then(() => { setStatus(t("app.friends.nowFriends", { name: person.displayName })); return "FRIEND" as const; })),
      friendActionButton("close", t("app.friends.reject"), () => bridge.dismissFriendRequest(person.userId)
        .then(() => { setStatus(t("app.friends.rejected")); return "NONE" as const; }))
    );
  }
  row.append(actions);
  return row;

  function friendActionButton(icon: "personAdd" | "check" | "close", title: string, act: () => Promise<FriendPerson["relation"]>): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `member-icon-button ${icon === "close" ? "remove" : "add"}`;
    button.innerHTML = iconSvg(icon);
    button.setAttribute("aria-label", title);
    button.dataset.tooltip = title;
    button.disabled = friendActionPending;
    button.addEventListener("click", () => void runFriendAction(person.userId, act));
    return button;
  }
}

async function runFriendAction(userId: string, act: () => Promise<FriendPerson["relation"]>): Promise<void> {
  if (friendActionPending) return;
  friendActionPending = true;
  friendError.textContent = "";
  renderFriendDialog();
  try {
    const relation = await act();
    if (friendSearchHits) friendSearchHits = friendSearchHits.map(hit => hit.userId === userId ? { ...hit, relation } : hit);
    await refreshConversations();
  } catch (error) {
    friendError.textContent = describeError(error);
  } finally {
    friendActionPending = false;
    await refreshFriendRequests();
    renderFriendDialog();
  }
}

async function searchFriends(): Promise<void> {
  const query = friendSearchInput.value.trim();
  if (!query || friendActionPending) return;
  friendActionPending = true;
  friendError.textContent = "";
  renderFriendDialog();
  try {
    friendSearchHits = await bridge.searchPeople(query);
  } catch (error) {
    friendSearchHits = null;
    friendError.textContent = describeError(error);
  } finally {
    friendActionPending = false;
    renderFriendDialog();
  }
}

friendSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void searchFriends();
});
friendClose.addEventListener("click", () => friendDialog.close());

/** Workspace management stays available without interrupting task recency order. */
function workspaceRow(
  label: string,
  trailing: string,
  trailingClass: "ws-path" | "ws-count",
  removable?: Workspace
): HTMLElement {
  const heading = document.createElement("div");
  const row = document.createElement("div");
  heading.className = "ws-list-heading";
  row.className = "ws-row";

  const text = document.createElement("span");
  text.textContent = label;

  const tail = document.createElement("span");
  tail.className = trailingClass;
  tail.textContent = trailing;
  if (trailingClass === "ws-path") tail.title = trailing;

  row.append(text, tail);
  heading.append(row);

  if (removable?.kind === "folder") {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "workspace-item-delete";
    remove.title = t("app.workspace.deleteNamed", { name: removable.name });
    remove.setAttribute("aria-label", t("app.workspace.deleteNamed", { name: removable.name }));
    remove.innerHTML = iconSvg("delete");
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      openDeleteConfirmation(
        t("app.workspace.deleteTitle"),
        t("app.workspace.deleteCopy", { name: removable.name, path: removable.path ?? t("app.workspace.folderFallback") }),
        async () => {
          await bridge.deleteWorkspace(removable.workspaceId);
          workspaces = await bridge.listWorkspaces();
          await refreshConversations();
          if (activeTab === "knowledge") renderScopeList();
          setStatus(t("app.workspace.deleted"));
        }
      );
    });
    heading.append(remove);
  }
  return heading;
}

const contactSearchInput = document.createElement("input");
contactSearchInput.id = "contact-search";
contactSearchInput.className = "contact-search";
contactSearchInput.type = "search";
contactSearchInput.placeholder = t("app.contacts.search");
contactSearchInput.setAttribute("aria-label", t("app.contacts.search"));
const contactSearchResults = document.createElement("div");
contactSearchResults.className = "sidebar-scroll";
/** The task page's scroll area. The title row stays outside and doesn't scroll */
const conversationScroll = document.createElement("div");
conversationScroll.className = "sidebar-scroll";
const listPageError = (error: unknown) => setStatus(describeError(error), "error");
const contactPages = new InfiniteList(100, async ids => {
  const page = await bridge.listPage("contacts", ids);
  indexUsers(page);
  return page.map(item => item.userId);
}, renderConversationList, listPageError);
const conversationPages = new InfiniteList(100, async ids => (await bridge.listPage("conversations", ids)).map(item => item.conversationId), renderConversationList, listPageError);
const switcherPages = new InfiniteList(10, async ids => (await bridge.listPage("switcher", ids)).map(item => item.conversationId), renderConversationSwitcherMenu, listPageError);
contactSearchResults.addEventListener("scroll", () => contactPages.nearEnd(contactSearchResults));
conversationScroll.addEventListener("scroll", () => conversationPages.nearEnd(conversationScroll));
contactSearchInput.addEventListener("input", () => renderConversationList());

/** Conversations have one global recency order; contact search keeps its DOM/focus across updates. */
let permanentOnly = localStorage.getItem("ading.permanentOnly") === "true";
let sharedOnly = localStorage.getItem("ading.sharedOnly") === "true";
/** A followed unread stays visible until leaving it, without changing the saved category filters. */
let temporaryUnreadConversationId: string | undefined;
function matchesConversationFilters(conversation: Conversation): boolean {
  return (!permanentOnly && !sharedOnly)
    || (sharedOnly && isSharedConversation(conversation))
    || (permanentOnly && !isSharedConversation(conversation) && !!conversation.permanent);
}
function categoryFilter(kind: "permanent" | "shared", toggle: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = `${kind}-only`;
  button.className = `conversation-filter ${kind}`;
  button.innerHTML = iconSvg(kind);
  button.setAttribute("aria-label", t(`app.conversation.${kind}Filter`));
  button.dataset.tooltip = t(`app.conversation.${kind}Filter`);
  button.addEventListener("click", toggle);
  return button;
}
const permanentFilter = categoryFilter("permanent", () => {
  temporaryUnreadConversationId = undefined;
  permanentOnly = !permanentOnly;
  localStorage.setItem("ading.permanentOnly", String(permanentOnly));
  renderConversationList();
});
const sharedFilter = categoryFilter("shared", () => {
  temporaryUnreadConversationId = undefined;
  sharedOnly = !sharedOnly;
  localStorage.setItem("ading.sharedOnly", String(sharedOnly));
  renderConversationList();
});
const conversationFilters = document.createElement("div");
conversationFilters.className = "conversation-filters";
const groupPermanent = el<HTMLInputElement>("#group-permanent");
const settingsPermanent = el<HTMLInputElement>("#settings-permanent");
let draftPermanent = false;

/** Navigation uses all unread conversations, regardless of the current contact or list filter. */
function unreadConversations(): Conversation[] {
  return recentConversations(conversations.filter(conversation => conversation.status === "ACTIVE" && unreadCount(conversation) > 0));
}

function unreadContactId(conversation: Conversation): string | undefined {
  if (conversation.type !== "DIRECT") return undefined;
  return conversation.members.find(member => member.userId !== me?.userId && contactIds.has(member.userId))?.userId;
}

function renderNavigationUnread(): void {
  const unread = unreadConversations();
  const contactsHaveUnread = unread.some(conversation => unreadContactId(conversation));
  const incomingRequests = friendRequests.some(request => request.relation === "INCOMING");
  for (const [button, show] of [[tabConversations, unread.length > 0], [tabContacts, contactsHaveUnread && !incomingRequests]] as const) {
    button.querySelector(".navigation-unread-dot")?.remove();
    if (show) {
      const dot = unreadDot();
      dot.classList.add("navigation-unread-dot");
      button.append(dot);
    }
  }
}

function renderConversationList(): void {
  permanentFilter.setAttribute("aria-pressed", String(permanentOnly));
  sharedFilter.setAttribute("aria-pressed", String(sharedOnly));
  renderNavigationUnread();
  const contacts = [...users.values()]
    .filter((user) => contactIds.has(user.userId) && user.userId !== me?.userId)
    .sort(compareContacts);
  if (activeTab === "contacts") {
    newGroupButton.hidden = true;
    // Adding friends is online-only: the standalone edition has no account, so there's no one else to add
    const label = sidebarLabel(t("app.contacts.label"), contacts.length, accountStatus.signedIn ? addFriendButton() : undefined);
    if (contactSearchInput.parentElement !== conversationList) {
      conversationList.replaceChildren(label, contactSearchInput, contactSearchResults);
    } else {
      conversationList.firstElementChild?.replaceWith(label);
    }
    const previousRows = new Map(Array.from(contactSearchResults.querySelectorAll<HTMLElement>(".contact-list-item"))
      .map(row => [row.dataset.userId, row]));
    const nextRows: HTMLElement[] = [];
    const incoming = friendRequests.filter(request => request.relation === "INCOMING");
    if (accountStatus.signedIn && incoming.length) nextRows.push(friendRequestsRow(incoming.length));
    const matching = contacts.filter(contact => matchesContact(contact, contactSearchInput.value));
    const visible = contactPages.visible([...matching].sort(compareMembers).map(contact => contact.userId));
    if (matching.length) {
      for (const isAgent of [true, false]) {
        const group = matching.filter(contact => contact.isAgent === isAgent && visible.has(contact.userId));
        if (!group.length) continue;
        if (nextRows.length) nextRows.push(memberGroupDivider());
        for (const contact of group) {
          const next = contactButton(contact);
          const previous = previousRows.get(contact.userId);
          // Selection/read receipts must not replace the click target between
          // native click and dblclick. Rebuild if contact details really change.
          const signature = (row: HTMLElement): string => {
            const copy = row.cloneNode(true) as HTMLElement;
            copy.querySelector(".contact-button")?.classList.remove("active");
            copy.querySelector(".unread")?.remove();
            return copy.outerHTML;
          };
          if (previous && signature(previous) === signature(next)) {
            const button = previous.querySelector<HTMLElement>(".contact-button")!;
            button.className = next.querySelector<HTMLElement>(".contact-button")!.className;
            const badge = next.querySelector(".unread");
            const oldBadge = previous.querySelector(".unread");
            if (badge && oldBadge) oldBadge.textContent = badge.textContent;
            else if (badge) button.append(badge);
            else oldBadge?.remove();
            nextRows.push(previous);
          } else nextRows.push(next);
        }
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "contact-empty compact";
      empty.textContent = contacts.length ? t("app.contacts.noMatch") : t("app.contacts.empty");
      nextRows.push(empty);
    }
    for (const [index, row] of nextRows.entries()) {
      const current = contactSearchResults.children[index];
      if (current !== row) contactSearchResults.insertBefore(row, current ?? null);
    }
    while (contactSearchResults.children.length > nextRows.length) contactSearchResults.lastElementChild?.remove();
    return;
  }

  newGroupButton.hidden = false;
  // A task needs at least one Agent to do it: when there are none, the new-task entry is greyed out
  const canStartConversation = contacts.some((contact) => contact.isAgent || contact.friend === true);
  setConversationStartAvailable(newGroupButton, canStartConversation, t("app.conversation.newConversation"));
  // The title row (with the new button) stays fixed at the top; only the task entries below scroll
  const heading=sidebarLabel(t("app.conversations.label"), undefined, newGroupButton);
  conversationFilters.replaceChildren(permanentFilter, sharedFilter);
  heading.insertBefore(conversationFilters,newGroupButton);
  const scrollTop = conversationScroll.scrollTop;
  conversationList.replaceChildren(heading, conversationScroll);
  conversationScroll.replaceChildren();
  const matching = recentConversations(conversations.filter(item => matchesConversationFilters(item) || item.conversationId === temporaryUnreadConversationId));
  const visible = conversationPages.visible(matching.map(item => item.conversationId));
  for (const conversation of matching) if (visible.has(conversation.conversationId)) conversationScroll.append(conversationButton(conversation));
  conversationScroll.scrollTop = scrollTop;
}

const NO_AGENT_TIP = t("app.conversation.needAgentTip");

/** Entry for starting a task: greyed out with the reason in the tooltip when unavailable. Uses aria-disabled, because native disabled gets no hover and the tooltip wouldn't appear */
function setConversationStartAvailable(button: HTMLButtonElement, available: boolean, label: string): void {
  if (available) {
    button.removeAttribute("aria-disabled");
    if (button.dataset.tooltip === NO_AGENT_TIP) delete button.dataset.tooltip;
    button.setAttribute("aria-label", label);
  } else {
    button.setAttribute("aria-disabled", "true");
    button.dataset.tooltip = NO_AGENT_TIP;
    button.setAttribute("aria-label", t("app.conversation.disabledLabel", { label, reason: NO_AGENT_TIP }));
  }
}

/** Keep only the last two directory segments; paths that long nobody reads to the end */
function shortPath(full: string): string {
  const parts = full.split("/").filter(Boolean);
  if (parts.length <= 2) return full;
  return `…/${parts.slice(-2).join("/")}`;
}

// ---------------------------------------------------------------------------
// Rendering: messages
// ---------------------------------------------------------------------------

/** Kept in sync with the main process's cleanAgentOutput; historical messages are cleaned at display time without changing files. */
function cleanAgentOutputForDisplay(value: string): string {
  let cleaned = value.replace(/\r\n?/g, "\n").trim();
  cleaned = cleaned
    .replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think\s*>/gi, "")
    .trim();
  const closings = [...cleaned.matchAll(/<\/think\s*>/gi)];
  const lastClosing = closings[closings.length - 1];
  if (lastClosing?.index !== undefined) {
    const tail = cleaned
      .slice(lastClosing.index + lastClosing[0].length)
      .trim();
    cleaned = tail || cleaned.slice(0, lastClosing.index).trim();
  }
  cleaned = cleaned
    .replace(/<think(?:\s[^>]*)?>[\s\S]*$/gi, "")
    .replace(/<\/?think(?:\s[^>]*)?>/gi, "")
    .trim();
  const lines = cleaned.split("\n");
  while (
    lines.length > 0 &&
    /^\s*\\?<\/?(?:parameter|invoke|function|tool_call|tool_use)(?:\s[^>]*)?>\s*$/i.test(
      lines[lines.length - 1] ?? ""
    )
  ) {
    lines.pop();
  }
  cleaned = lines.join("\n").trim();
  if (/^skip[.!]?$/i.test(cleaned)) return "SKIP";
  return cleaned.replace(/\n+\s*skip\s*$/i, "").trim();
}

function displayedMessageContent(message: Message): string {
  const sender = users.get(message.senderId);
  return sender?.isAgent
    ? cleanAgentOutputForDisplay(agentChatContent(message))
    : message.content;
}

function safeExternalUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function messageAnchor(label: string, target: string): HTMLAnchorElement | null {
  const local = target && !target.startsWith("//") && !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.includes("\0") ? target : null;
  const conversationId = selectedId;
  const url = safeExternalUrl(target);
  if (!local && !url) return null;
  const anchor = document.createElement("a");
  anchor.href = url || "#";
  anchor.textContent = label;
  anchor.rel = "noreferrer noopener";
  anchor.addEventListener("click", event => {
    event.preventDefault();
    const context = currentComposerKey();
    void (local ? bridge.revealArtifact(local, conversationId ?? undefined) : bridge.openExternal(url!)).catch((error: unknown) => {
      setStatus(t("app.link.openFailed", { error: describeError(error) }), "error", false, context);
    });
  });
  return anchor;
}

function appendLinkedText(container: HTMLElement, text: string): void {
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>`，。！？；、]+/gi)) {
    const index = match.index!;
    let target = match[0].replace(/[.,!?;:]+$/, "");
    while (/[)\]}]$/.test(target)) {
      const close = target.at(-1)!;
      const open = close === ")" ? "(" : close === "]" ? "[" : "{";
      if (target.split(close).length <= target.split(open).length) break;
      target = target.slice(0, -1);
    }
    container.append(document.createTextNode(text.slice(cursor, index)));
    container.append(messageAnchor(target, target) ?? document.createTextNode(target));
    cursor = index + target.length;
  }
  container.append(document.createTextNode(text.slice(cursor)));
}

interface MaskedMath {text:string;append:(container:HTMLElement,text:string,plain:(container:HTMLElement,text:string)=>void)=>void;}
declare global { interface Window {adingMath?:{mask:(content:string)=>MaskedMath};} }
let activeMath:MaskedMath|undefined;
function appendMessageText(container:HTMLElement,text:string):void {
  if(activeMath)activeMath.append(container,text,appendLinkedText);else appendLinkedText(container,text);
}

function appendInlineMarkdown(container: HTMLElement, text: string): void {
  // CommonMark angle destinations allow spaces and parentheses in local file paths.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\((?:<[^>\n]+>|[^\s)]+)\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) appendMessageText(container, text.slice(cursor, index));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      container.append(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      appendMessageText(strong, token.slice(2, -2));
      container.append(strong);
    } else if (token.startsWith("~~")) {
      const strike = document.createElement("s");
      appendMessageText(strike, token.slice(2, -2));
      container.append(strike);
    } else {
      const link = token.match(/^\[([^\]]+)\]\((?:<([^>]+)>|([^)]*))\)$/);
      const anchor = link ? messageAnchor(link[1], link[2] ?? link[3]) : null;
      container.append(anchor ?? document.createTextNode(token));
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) appendMessageText(container, text.slice(cursor));
}

function appendLinkPreviews(bubble: HTMLElement): void {
  const urls = new Set(Array.from(bubble.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .map(anchor => safeExternalUrl(anchor.href)).filter((url): url is string => !!url));
  for (const url of urls) {
    const card = messageAnchor("", url)!;
    card.className = "link-preview";
    const title = document.createElement("strong");
    title.textContent = new URL(url).hostname;
    const description = document.createElement("span");
    description.className = "link-preview-description";
    description.hidden = true;
    const site = document.createElement("span");
    site.className = "link-preview-site";
    site.textContent = url;
    const header = document.createElement("span");
    header.className = "link-preview-header";
    const thumbnail = document.createElement("img");
    thumbnail.className = "link-preview-image";
    thumbnail.alt = "";
    thumbnail.hidden = true;
    thumbnail.addEventListener("error", () => { thumbnail.hidden = true; });
    header.append(title, thumbnail);
    card.append(header, description, site);
    bubble.append(card);
    void bridge.linkPreview?.(url).then(preview => {
      if (!preview) return;
      // Cached rows of other conversations keep the preview; only the visible pane needs its scroll kept.
      const restoreScroll = card.isConnected ? messageScroll.beforeRender(selectedId ? `${selectedId}:${messageFilter}` : null) : undefined;
      title.textContent = preview.title;
      description.textContent = preview.description;
      description.hidden = !preview.description;
      site.textContent = new URL(url).hostname;
      if (preview.image && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(preview.image)) {
        thumbnail.src = preview.image;
        thumbnail.hidden = false;
      }
      restoreScroll?.();
    }).catch(() => { /* Keep the working link when metadata is unavailable. */ });
  }
}

function markdownBlockStart(line: string): boolean {
  return /^(?:```|#{1,4}\s+|\s*[-+*]\s+|\s*\d+[.)]\s+|\s*>\s?)/.test(line);
}

function renderMarkdown(container:HTMLElement,markdown:string):void {
  const previous=activeMath;activeMath=window.adingMath?.mask(markdown);
  try {renderMarkdownBody(container,activeMath?.text??markdown);}finally {activeMath=previous;}
}

function renderMarkdownBody(container: HTMLElement, markdown: string): void {
  container.classList.add("markdown");
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```\s*([\w-]+)?\s*$/);
    if (fence) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.language = fence[1];
      code.textContent = codeLines.join("\n");
      pre.append(code);
      container.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const title = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(title, heading[2]);
      container.append(title);
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    if (unordered) {
      const list = document.createElement("ul");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-+*]\s+(.+)$/);
        if (!item) break;
        const listItem = document.createElement("li");
        appendInlineMarkdown(listItem, item[1]);
        list.append(listItem);
        index += 1;
      }
      container.append(list);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const list = document.createElement("ol");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        const listItem = document.createElement("li");
        appendInlineMarkdown(listItem, item[1]);
        list.append(listItem);
        index += 1;
      }
      container.append(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      appendInlineMarkdown(quote, quoteLines.join("\n"));
      container.append(quote);
      continue;
    }

    const paragraph = document.createElement("p");
    let firstLine = true;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !markdownBlockStart(lines[index])
    ) {
      if (!firstLine) paragraph.append(document.createElement("br"));
      appendInlineMarkdown(paragraph, lines[index]);
      firstLine = false;
      index += 1;
    }
    container.append(paragraph);
  }
}

function messageActionButton(className: string, icon: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `message-action ${className}`;
  button.innerHTML = iconSvg(icon);
  button.dataset.tooltip = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

async function copyMessageText(button: HTMLButtonElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    setStatus(t("app.message.copyFailed", { error: describeError(error) }), "error", false, selectedId ? chatKey(selectedId) : currentComposerKey());
    return;
  }
  button.innerHTML = iconSvg("check");
  button.classList.add("copied");
  button.dataset.tooltip = t("app.message.copied");
  setTimeout(() => {
    button.innerHTML = iconSvg("copy");
    button.classList.remove("copied");
    button.dataset.tooltip = t("app.message.copy");
  }, 1500);
}

function messageElement(message: Message, conversation: Conversation, thinking = false): HTMLElement {
  const mine = message.senderId === me?.userId;
  const sender = users.get(message.senderId);
  const article = document.createElement("article");
  article.className = `message ${mine ? "user" : "agent"}`;
  article.dataset.scrollKey = message.messageId;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (!sender?.isAgent && message.type === "USER") {
    const math=window.adingMath?.mask(message.content);
    if(math)math.append(bubble,math.text,appendLinkedText);else appendLinkedText(bubble, message.content);
    bubble.style.whiteSpace = "pre-wrap";
  } else renderMarkdown(bubble, displayedMessageContent(message));
  appendLinkPreviews(bubble);
  if (message.mentions?.length) highlightMentions(bubble, [
    ...message.mentions.map(id => ({ label: id === me?.userId ? me.displayName : users.get(id)?.displayName ?? "", mine: id === me?.userId })).filter(item => item.label),
    ...ALL_PEOPLE_LABELS.map(label => ({ label, mine: !!me && message.mentions.includes(me.userId) }))
  ]);
  if (message.quote) bubble.prepend(messageQuoteElement(message.quote, message.replyTo));
  // Only images or files sent: don't leave an empty bubble
  bubble.hidden = !message.content.trim() && Boolean(message.attachments?.length) && !message.quote;

  const time = document.createElement("time");
  time.className = "time";
  time.textContent = formatTime(message.createdAt);
  if (message.status === "SENDING" || message.status === "FAILED") {
    article.classList.add(message.status === "FAILED" ? "failed" : "pending");
    const delivery = document.createElement("span");
    delivery.className = `message-delivery ${message.status === "FAILED" ? "failed" : "pending"}`;
    delivery.textContent = t(message.status === "FAILED" ? "app.message.deliveryFailed" : "app.message.pendingSync");
    time.append(" · ", delivery);
  }

  // Modeled on DingTalk: avatars on both sides of messages, aligned with the bubble top; in group chats the name goes above the bubble, direct chats have only two people so no name
  const row = document.createElement("div");
  row.className = "message-row";
  const body = document.createElement("div");
  body.className = "message-body";
  if (!mine && sender && conversation.type === "GROUP") {
    const name = document.createElement("button");
    name.type = "button";
    name.className = "message-sender";
    name.textContent = sender.displayName;
    name.dataset.tooltip = t(conversation.members.some(member => member.userId === sender.userId) ? "app.message.mentionSender" : "app.message.viewProfile", { name: sender.displayName });
    // The name is for @-mentioning, the avatar for viewing the profile; when @ isn't possible (left the group, composer unavailable) the profile is still offered
    name.addEventListener("click", () => { const latest = users.get(sender.userId) ?? sender; if (!mentionInComposer(latest)) openReadOnlyProfile(latest); });
    if (thinking) {
      const line = document.createElement("div");
      line.className = "message-sender-line";
      line.append(name, thinkingIndicator(sender.displayName));
      body.append(line);
    } else {
      body.append(name);
    }
  }
  const attachments = message.attachments?.length ? attachmentsElement(message.conversationId, message.attachments) : null;
  const actions: HTMLButtonElement[] = [];
  if (!mine && message.type === "USER" && !message.internal && !message.failed && message.status === "SENT") {
    actions.push(messageActionButton("message-reply", "reply", t("app.message.reply"), () => startReply(message)));
  }
  const copyText = displayedMessageContent(message);
  if (copyText.trim()) {
    const copy = messageActionButton("message-copy", "copy", t("app.message.copy"), () => void copyMessageText(copy, copyText));
    actions.push(copy);
  }
  if (actions.length) {
    // Hover actions sit beside the message, level with its bottom; message content (bubble and attachments) is wrapped separately, the time stays below
    const line = document.createElement("div");
    line.className = "message-line";
    const content = document.createElement("div");
    content.className = "message-content";
    content.append(bubble);
    if (attachments) content.append(attachments);
    const group = document.createElement("div");
    group.className = "message-actions";
    group.append(...actions);
    if (mine) line.append(group, content);
    else line.append(content, group);
    body.append(line, time);
  } else {
    body.append(bubble);
    if (attachments) body.append(attachments);
    body.append(time);
  }

  const person = mine ? me : sender;
  if (person) {
    const avatar = document.createElement(mine ? "span" : "button");
    avatar.className = "message-avatar";
    if (avatar instanceof HTMLButtonElement) {
      avatar.type = "button";
      avatar.setAttribute("aria-label", t("app.message.viewProfile", { name: person.displayName }));
      // Rows are reused across renders, so look the profile up when clicked.
      avatar.addEventListener("click", () => openReadOnlyProfile(users.get(person.userId) ?? person));
    } else {
      avatar.title = person.displayName;
    }
    renderContactAvatar(avatar, person);
    if (mine) row.append(body, avatar);
    else row.append(avatar, body);
  } else {
    row.append(body);
  }
  article.append(row);
  return article;
}

// ---------------------------------------------------------------------------
// Attachments: images shown directly, videos playable, other files show name and size; clicking opens them with the system default app
// ---------------------------------------------------------------------------

/**
 * Address of images and videos. The main process reads the file in the attachments directory by this address;
 * in the online edition, if this machine doesn't have it yet (sent from a phone), it downloads first. Attachments not yet sent have no task, so "_" is written.
 */
function attachmentUrl(conversationId: string | null, attachment: Attachment): string {
  const parts = [conversationId || "_", attachment.attachmentId, attachment.name].map(encodeURIComponent);
  return `ading-attachment://file/${parts.join("/")}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Last-message preview in the task list: when only attachments were sent, show text like [Image] */
function attachmentSummary(message: Message): string {
  const first = message.attachments?.[0];
  if (!first) return "";
  if (first.kind === "image") return t("app.attachment.image");
  if (first.kind === "video") return t("app.attachment.video");
  return t("app.attachment.file", { name: first.name });
}

function openAttachment(conversationId: string | null, attachment: Attachment): void {
  const context = conversationId ? chatKey(conversationId) : currentComposerKey();
  if (attachment.kind === "image") {
    previewedAttachment = { conversationId, attachment };
    attachmentImageName.textContent = attachment.name;
    attachmentImagePreview.alt = attachment.name;
    attachmentImageError.hidden = true;
    attachmentImageError.textContent = t("html.attachment.imageLoadFailed");
    resetAttachmentImageZoom();
    attachmentImagePreview.src = attachmentUrl(conversationId, attachment);
    attachmentImageDialog.showModal();
    return;
  }
  bridge.openAttachment(conversationId, attachment).catch((error: unknown) => {
    setStatus(t("app.attachment.openFailed", { error: describeError(error) }), "error", false, context);
  });
}
el<HTMLButtonElement>("#attachment-image-close").addEventListener("click", () => attachmentImageDialog.close());

/** Image viewer zoom: 1 is the fit-to-window size when first opened; after zooming in, scroll within the image frame. */
const ATTACHMENT_IMAGE_ZOOM_STEP = 1.25;
const ATTACHMENT_IMAGE_ZOOM_MIN = 0.25;
const ATTACHMENT_IMAGE_ZOOM_MAX = 8;
let attachmentImageZoom = 1;
function syncAttachmentImageZoomButtons(): void {
  attachmentImageZoomOut.disabled = attachmentImageZoom <= ATTACHMENT_IMAGE_ZOOM_MIN;
  attachmentImageZoomIn.disabled = attachmentImageZoom >= ATTACHMENT_IMAGE_ZOOM_MAX;
}
function resetAttachmentImageZoom(): void {
  attachmentImageZoom = 1;
  for (const property of ["width", "max-width", "max-height"]) attachmentImagePreview.style.removeProperty(property);
  for (const property of ["min-width", "min-height"]) attachmentImageViewport.style.removeProperty(property);
  syncAttachmentImageZoomButtons();
}
function zoomAttachmentImage(factor: number): void {
  const { naturalWidth, naturalHeight } = attachmentImagePreview;
  if (!naturalWidth || !naturalHeight) return;
  const zoom = Math.min(ATTACHMENT_IMAGE_ZOOM_MAX, Math.max(ATTACHMENT_IMAGE_ZOOM_MIN, attachmentImageZoom * factor));
  // The image frame only grows, never shrinks: when zooming out the dialog doesn't shrink with it, so the buttons don't slip out from under the mouse.
  const frame = attachmentImageViewport.getBoundingClientRect();
  attachmentImageViewport.style.minWidth = `${frame.width}px`;
  attachmentImageViewport.style.minHeight = `${frame.height}px`;
  const fit = Math.min(1, (window.innerWidth - 72) / naturalWidth, (window.innerHeight - 120) / naturalHeight);
  attachmentImageZoom = zoom;
  attachmentImagePreview.style.maxWidth = "none";
  attachmentImagePreview.style.maxHeight = "none";
  attachmentImagePreview.style.width = `${naturalWidth * fit * zoom}px`;
  syncAttachmentImageZoomButtons();
}
attachmentImageZoomIn.addEventListener("click", () => zoomAttachmentImage(ATTACHMENT_IMAGE_ZOOM_STEP));
attachmentImageZoomOut.addEventListener("click", () => zoomAttachmentImage(1 / ATTACHMENT_IMAGE_ZOOM_STEP));
closeOnBackdropClick(attachmentImageDialog);
attachmentImageSave.addEventListener("click", async () => {
  const selected = previewedAttachment;
  if (!selected || attachmentImageSave.disabled) return;
  attachmentImageSave.disabled = true;
  try {
    await bridge.saveAttachment(selected.conversationId, selected.attachment);
  } catch (error) {
    if (previewedAttachment === selected) {
      attachmentImageError.textContent = t("app.attachment.downloadFailed", { error: describeError(error) });
      attachmentImageError.hidden = false;
    }
  } finally {
    attachmentImageSave.disabled = false;
  }
});
attachmentImagePreview.addEventListener("error", () => { attachmentImageError.hidden = false; });
attachmentImagePreview.addEventListener("load", () => { attachmentImageError.hidden = true; });

function attachmentsElement(conversationId: string, attachments: Attachment[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "message-attachments";
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "attachment-image";
      button.setAttribute("aria-label", t("app.attachment.open", { name: attachment.name }));
      button.dataset.tooltip = "";
      const image = document.createElement("img");
      image.src = attachmentUrl(conversationId, attachment);
      image.alt = attachment.name;
      image.loading = "lazy";
      button.append(image);
      button.addEventListener("click", () => openAttachment(conversationId, attachment));
      box.append(button);
    } else if (attachment.kind === "video") {
      const video = document.createElement("video");
      video.className = "attachment-video";
      video.src = attachmentUrl(conversationId, attachment);
      video.controls = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", attachment.name);
      box.append(video);
    } else {
      box.append(attachmentFileChip(attachment, () => openAttachment(conversationId, attachment)));
    }
  }
  return box;
}

function attachmentFileChip(attachment: Attachment, onOpen: () => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "attachment-file";
  button.setAttribute("aria-label", t("app.attachment.open", { name: attachment.name }));
  // The name is already written on the button; no extra tooltip
  button.dataset.tooltip = "";
  button.innerHTML = iconSvg("file");
  const name = document.createElement("span");
  name.className = "attachment-file-name";
  name.textContent = attachment.name;
  const size = document.createElement("small");
  size.textContent = formatBytes(attachment.size);
  button.append(name, size);
  button.addEventListener("click", onOpen);
  return button;
}

/** Above the composer: attachments not yet sent, removable one by one */
function renderComposerAttachments(): void {
  composerAttachments.replaceChildren();
  composerAttachments.hidden = pendingAttachments.length === 0;
  for (const attachment of pendingAttachments) {
    const item = document.createElement("div");
    item.className = "composer-attachment";
    if (attachment.kind === "image") {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "composer-attachment-image";
      const image = document.createElement("img");
      image.src = attachmentUrl(null, attachment);
      image.alt = attachment.name;
      open.append(image);
      open.addEventListener("click", () => openAttachment(null, attachment));
      item.append(open);
    } else {
      item.append(attachmentFileChip(attachment, () => openAttachment(null, attachment)));
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-attachment-remove";
    remove.setAttribute("aria-label", t("app.attachment.remove", { name: attachment.name }));
    remove.dataset.tooltip = t("app.attachment.remove", { name: attachment.name }).slice(0, 24);
    remove.innerHTML = iconSvg("close");
    remove.addEventListener("click", () => {
      pendingAttachments = pendingAttachments.filter((item) => item.attachmentId !== attachment.attachmentId);
      renderComposerAttachments();
      syncComposer();
    });
    item.append(remove);
    composerAttachments.append(item);
  }
}

function addPendingAttachments(result: AttachmentImport, key = currentComposerKey()): void {
  if (key !== currentComposerKey()) {
    const draft = composerDrafts.get(key) ?? { text: "", attachments: [], revision: 0 };
    const room = MAX_PENDING_ATTACHMENTS - draft.attachments.length;
    composerDrafts.set(key, { ...draft, attachments: [...draft.attachments, ...result.attachments.slice(0, Math.max(0, room))], revision: draft.revision + 1 });
    const problems = result.rejected.map(item => item.name ? t("app.attachment.rejected", item) : item.reason);
    if (result.attachments.length > room) problems.push(t("app.attachment.tooMany"));
    if (problems.length) setStatus(problems.join(t("app.common.clauseSeparator")), "error", true, key);
    return;
  }
  const room = MAX_PENDING_ATTACHMENTS - pendingAttachments.length;
  pendingAttachments = [...pendingAttachments, ...result.attachments.slice(0, Math.max(0, room))];
  const problems = result.rejected.map((item) => item.name ? t("app.attachment.rejected", item) : item.reason);
  if (result.attachments.length > room) problems.push(t("app.attachment.tooMany"));
  if (problems.length) setStatus(problems.join(t("app.common.clauseSeparator")), "error", true);
  renderComposerAttachments();
  syncComposer();
}

function attachmentCallbacks() {
  const key = currentComposerKey(), generation = dataGeneration;
  return {
    accept: (result: AttachmentImport) => { if (dataGeneration === generation) addPendingAttachments(result, key); },
    reject: (error: unknown) => { if (dataGeneration === generation) setStatus(t("app.attachment.failed", { error: describeError(error) }), "error", true, key); }
  };
}

function messageMatchesFilter(message: Message): boolean {
  if (isOperationalMessage(message)) return false;
  const content = displayedMessageContent(message);
  if ((!content && !message.attachments?.length) || (conversationById(message.conversationId)?.type !== "DIRECT" && users.get(message.senderId)?.isAgent && content === "SKIP")) return false;
  if (messageFilter === "all") return true;
  const sender = users.get(message.senderId);
  if (!sender) return false;
  return messageFilter === "agents" ? sender.isAgent : !sender.isAgent;
}

function renderMessageFilters(): void {
  const hasConversation = Boolean(selectedId);
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  const leaderMember = conversation?.members.find(
    (member) => member.role === "LEADER" && users.get(member.userId)?.isAgent
  );
  const leaderBusy = Boolean(
    leaderMember && conversation && runtimeState.isBusy(conversation.conversationId, leaderMember.userId)
  );
  const lastMessage = conversation
    ? messagesByConversation.get(conversation.conversationId)?.at(-1)
    : undefined;
  const lastIsReport = Boolean(lastMessage?.report);
  const remote = mode === "remote";
  messageFilters.hidden = !hasConversation;
  filterHumansButton.hidden = !remote;
  filterAgentsButton.hidden = !remote;
  filterHumansButton.classList.toggle("active", messageFilter === "humans");
  filterAgentsButton.classList.toggle("active", messageFilter === "agents");
  toggleProcessButton.classList.toggle("active", processPanelOpen);
  toggleProcessButton.setAttribute("aria-pressed", String(processPanelOpen));
  reportConversationButton.disabled = Boolean(
    !conversation ||
    conversation.type !== "GROUP" ||
    conversation.status !== "ACTIVE" ||
    !leaderMember ||
    leaderMember.paused ||
    lastIsReport || Boolean(selectedId && reportingConversations.has(selectedId))
  );
  reportConversationButton.dataset.tooltip = selectedId && reportingConversations.has(selectedId)
    ? t("app.report.running")
    : conversation?.type === "DIRECT"
    ? t("app.report.direct")
    : !leaderMember
    ? t("app.report.noLeader")
    : conversation?.status !== "ACTIVE"
      ? t("app.report.ended")
      : leaderMember.paused
        ? t("app.report.leaderPaused")
        : lastIsReport
          ? t("app.report.alreadyLatest")
        : leaderBusy
          ? t("app.report.parallel")
          : t("app.report.action");
  reportConversationButton.setAttribute("aria-label", reportConversationButton.dataset.tooltip);
  filterHumansButton.setAttribute(
    "aria-pressed",
    String(messageFilter === "humans")
  );
  filterAgentsButton.setAttribute(
    "aria-pressed",
    String(messageFilter === "agents")
  );
}

type ProcessRunState = "running" | "queued" | "stopped" | "done" | "failed";
interface ProcessRun {
  id: string;
  agentUserId: string;
  createdAt: string;
  state: ProcessRunState;
  headline: string;
  events: ProcessEvent[];
}

function processTimeline(events: ProcessEvent[]): HTMLElement {
  const timeline = document.createElement("div");
  timeline.className = "process-timeline";
  for (const event of events) {
    const row = document.createElement("div");
    const time = document.createElement("time");
    const text = document.createElement("span");
    row.className = "process-timeline-row";
    time.textContent = formatTime(event.createdAt);
    text.textContent = event.text;
    row.append(time, text);
    timeline.append(row);
  }
  return timeline;
}

function processLaneSummary(run:ProcessRun):HTMLElement|undefined {
  const lanes=new Map<string,string>();
  for(const text of [...run.events.map(event=>event.text),run.headline]){
    const match=text.match(/^(?:并行工作|Parallel work)\s+([^：:]+)[：:]\s*(.+)$/s);
    if(match)lanes.set(match[1].trim(),match[2].trim());
  }
  if(lanes.size<2)return;
  const summary=document.createElement("div");
  summary.className="process-lane-summary";
  for(const [id,status] of lanes){
    const item=document.createElement("div"),label=document.createElement("strong"),detail=document.createElement("span");
    label.textContent=id;detail.textContent=status;item.append(label,detail);summary.append(item);
  }
  return summary;
}

const processDetailsOpen = new Map<string, boolean>();
const processScroll = new ScrollPosition(processFeed, () => !processPanel.hidden && processFeed.clientHeight > 0);

function processRunElement(run: ProcessRun): HTMLElement {
  const article = document.createElement("article");
  const head = document.createElement("div");
  const current = document.createElement("div");
  const state = document.createElement("span");
  const sender = users.get(run.agentUserId);
  article.className = `process-run ${run.state}`;
  article.dataset.scrollKey = run.id;
  head.className = "process-run-head";
  current.className = "process-run-current";
  current.textContent = run.headline;
  state.className = `process-run-state ${run.state}`;
  state.textContent = run.state === "running"
    ? t("app.process.running")
    : run.state === "queued" ? t("app.process.queued") : run.state === "stopped" ? t("app.process.stopped") : run.state === "failed" ? t("app.process.failed") : t("app.process.done");

  if (sender && sender.userId !== me?.userId) {
    const person = document.createElement("button");
    const avatar = document.createElement("span");
    const name = document.createElement("span");
    person.type = "button";
    person.className = "process-run-person";
    avatar.className = "process-entry-avatar";
    renderContactAvatar(avatar, sender);
    name.textContent = sender.displayName;
    person.append(avatar, name);
    person.addEventListener("click", () => openReadOnlyProfile(sender));
    head.append(person);
  } else {
    const label = document.createElement("span");
    label.textContent = sender?.displayName ?? t("app.process.system");
    head.append(label);
  }
  head.append(state);
  article.append(head, current);
  const lanes=processLaneSummary(run);
  if(lanes)article.append(lanes);

  const hidden = run.events.slice(0, -3);
  const visible = run.events.slice(-3);
  if (hidden.length) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.className = "process-details";
    details.dataset.runId = run.id;
    details.open = processDetailsOpen.get(run.id) ?? false;
    details.addEventListener("toggle", () => { if (details.isConnected) processDetailsOpen.set(run.id,details.open); });
    summary.textContent = t("app.process.moreLogs", { count: hidden.length });
    details.append(summary, processTimeline(hidden));
    article.append(details);
  }
  if (visible.length) article.append(processTimeline(visible));
  return article;
}

function renderProcessPanel(): void {
  for (const details of processFeed.querySelectorAll<HTMLDetailsElement>("details[data-run-id]")) processDetailsOpen.set(details.dataset.runId!,details.open);
  const restoreScroll=processScroll.beforeRender(selectedId ? `${selectedId}:${processAgentFilterId ?? "all"}` : null);
  processFeed.replaceChildren();
  processPanel.hidden = !selectedId || !processPanelOpen;
  // A closed panel is rebuilt when it opens; building it hidden on every message render is wasted work.
  if (!selectedId || !processPanelOpen) return;

  const conversation = conversationById(selectedId);
  if (!conversation) return;
  renderProcessAgentFilters(conversation);
  const agentFilterId = processAgentFilterId;
  processPanelTitle.textContent = processAgentFilterId
    ? t("app.process.titleFor", { name: userName(processAgentFilterId) })
    : t("app.process.title");

  const runs: ProcessRun[] = [];
  for (const message of messagesByConversation.get(selectedId) ?? []) {
    if (isTeamRelayMessage(message)) continue;
    const events = (message.steps ?? []).map((step) => ({
        agentUserId: message.senderId,
        text: step,
        createdAt: message.createdAt
      }));
    if (events.length || isOperationalMessage(message)) {
      runs.push({
        id: `${selectedId}:message:${message.messageId}`,
        agentUserId: message.senderId,
        createdAt: message.createdAt,
        state: message.failed ? "failed" : "done",
        headline: isOperationalMessage(message)
          ? message.content
          : t("app.process.done"),
        events
      });
    }
  }
  const liveEntries=liveProcessByConversation.get(selectedId)??[];
  const liveStates=liveProcessStateByConversation.get(selectedId)??new Map();
  const liveAgentIds=new Set([...liveEntries.map(entry=>entry.agentUserId),...liveStates.keys(),...busyAgentsIn(selectedId).map(agent=>agent.userId)]);
  for (const agentUserId of liveAgentIds) {
    const live = liveEntries.filter(entry => entry.agentUserId === agentUserId);
    const latest = live[live.length - 1];
    const running=runtimeState.isBusy(selectedId,agentUserId);
    runs.push({
      id: `${selectedId}:live:${agentUserId}`,
      agentUserId,
      createdAt: latest?.createdAt ?? new Date().toISOString(),
      state: running ? "running" : liveStates.get(agentUserId)?.state ?? "stopped",
      headline: latest?.text ?? (running ? t("app.process.starting") : t("app.process.halted")),
      events: live.slice(0, -1)
    });
  }

  for (const entry of queuedAgents.filter(entry => entry.conversationId === selectedId && queueEntryText(entry))) {
    runs.push({id: `${selectedId}:queue:${entry.agentUserId}`,agentUserId: entry.agentUserId, createdAt: new Date().toISOString(), state: entry.messageState === "processing" ? "running" : "queued", headline: queueEntryText(entry), events: []});
  }

  const filteredRuns = agentFilterId
    ? runs.filter((run) => run.agentUserId === agentFilterId)
    : runs;
  for (const run of filteredRuns) processFeed.append(processRunElement(run));

  if (!filteredRuns.length) {
    const empty = document.createElement("div");
    empty.className = "process-empty";
    empty.textContent = processAgentFilterId
      ? t("app.process.emptyMember")
      : t("app.process.empty");
    processFeed.append(empty);
  }
  restoreScroll();
}

// Parallel workers can report dozens of progress events in one second. Rebuilding
// the complete process feed for every event makes the renderer contend with the
// workers exactly when the machine is busiest, so merge feed-only updates into a
// short UI batch while keeping messages and state changes immediate.
let processPanelRenderTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleProcessPanelRender(): void {
  if (!processPanelOpen || processPanelRenderTimer) return;
  processPanelRenderTimer = setTimeout(() => {
    processPanelRenderTimer = undefined;
    renderProcessPanel();
  }, 80);
}

function renderProcessAgentFilters(conversation: Conversation): void {
  processAgentFilters.replaceChildren();
  const agents = agentMembers(conversation);
  const show = agents.length > 0;
  processAgentFilters.hidden = !show;
  if (!show) return;

  if (
    processAgentFilterId &&
    !agents.some((agent) => agent.userId === processAgentFilterId)
  ) {
    processAgentFilterId = null;
  }

  const all = document.createElement("button");
  all.type = "button";
  all.className = "process-agent-filter";
  all.classList.toggle("active", processAgentFilterId === null);
  all.textContent = t("app.process.filterAll");
  all.setAttribute("aria-pressed", String(processAgentFilterId === null));
  all.addEventListener("click", () => {
    processAgentFilterId = null;
    renderProcessPanel();
  });
  processAgentFilters.append(all);

  for (const agent of agents) {
    const button = document.createElement("button");
    const avatar = document.createElement("span");
    const active = processAgentFilterId === agent.userId;
    button.type = "button";
    button.className = "process-agent-filter";
    button.classList.toggle("active", active);
    button.setAttribute("aria-label", t("app.process.filterOnly", { name: agent.displayName }));
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(active));
    avatar.className = "process-filter-avatar";
    renderContactAvatar(avatar, agent);
    button.append(avatar, document.createTextNode(agent.displayName));
    button.addEventListener("click", () => {
      processAgentFilterId = agent.userId;
      renderProcessPanel();
    });
    processAgentFilters.append(button);
  }
}

const messageScroll = new ScrollPosition(messagesPane);
const messageSizeObserver = new ResizeObserver(() => renderLatestJump());

function renderLatestJump(): void {
  latestJumpButton.hidden = !selectedId || messagesPane.clientHeight <= 0
    || messagesPane.scrollHeight - messagesPane.clientHeight - messagesPane.scrollTop <= 8;
}

latestJumpButton.addEventListener("click", () => {
  messagesPane.scrollTop = messagesPane.scrollHeight;
  renderLatestJump();
});

/** Everything messageElement reads besides the click-time state; same key means the existing element is still correct. */
const messageJson = new WeakMap<Message, string>();
type MessageRenderKey = { body: string; context: string };
function messageRenderKey(message: Message, conversation: Conversation, thinking: boolean): MessageRenderKey {
  const person = (id: string) => { const user = id === me?.userId ? me : users.get(id); return user ? [user.displayName, user.avatarUrl, user.isAgent, user.kind] : null; };
  // Serializing long agent replies and their steps on every render is costly; message objects are replaced on change,
  // except delivery status and server time corrections, which are mutated in place and so stay outside the cached part.
  let body = messageJson.get(message);
  if (body === undefined) { body = JSON.stringify(message); messageJson.set(message, body); }
  return { body, context: JSON.stringify([
    message.status, message.createdAt, currentLanguage(), mode, me?.userId, person(message.senderId), me && person(me.userId),
    message.mentions?.map(id => users.get(id)?.displayName), message.quote ? userName(message.quote.senderId) : null,
    conversation.type, conversation.members.some(member => member.userId === message.senderId), thinking, formatTime(message.createdAt)
  ]) };
}

/** The highlight must survive list re-renders while older pages keep arriving. */
let flashedMessage: { id: string; until: number } | undefined;
/** Rendered rows per conversation, so re-renders keep loaded images, link previews and button state. */
const renderedMessages = new Map<string, Map<string, { key: MessageRenderKey; element: HTMLElement }>>();
const RENDERED_CONVERSATION_LIMIT = 8;

function renderMessages(): void {
  const restoreScroll = messageScroll.beforeRender(selectedId ? `${selectedId}:${messageFilter}` : null);
  messageSizeObserver.disconnect();
  messageSizeObserver.observe(messagesPane);
  latestJumpButton.hidden = true;
  renderMessageFilters();
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  if (!selectedId || !conversation) {
    messagesPane.replaceChildren();
    renderProcessPanel();
    return;
  }

  const visible = (messagesByConversation.get(selectedId) ?? []).filter(messageMatchesFilter);
  // Agent running in a group chat: Ikkyu attaches next to the name on its latest message, not on every historical message
  const thinkingOn = new Set<string>();
  if (conversation.type === "GROUP") {
    const seen = new Set<string>();
    for (let i = visible.length - 1; i >= 0; i--) {
      const senderId = visible[i].senderId;
      if (seen.has(senderId)) continue;
      seen.add(senderId);
      if (users.get(senderId)?.isAgent && runtimeState.isBusy(conversation.conversationId, senderId)) {
        thinkingOn.add(visible[i].messageId);
      }
    }
  }
  const cache = renderedMessages.get(selectedId);
  const next = new Map<string, { key: MessageRenderKey; element: HTMLElement }>();
  const now = Date.now();
  let cursor = messagesPane.firstChild;
  for (const message of visible) {
    const thinking = thinkingOn.has(message.messageId);
    const key = messageRenderKey(message, conversation, thinking);
    const cached = cache?.get(message.messageId);
    const element = cached && cached.key.body === key.body && cached.key.context === key.context ? cached.element : messageElement(message, conversation, thinking);
    element.classList.toggle("mention-target", flashedMessage?.id === message.messageId && flashedMessage.until > now);
    next.set(message.messageId, { key, element });
    // Only touch the DOM where rows were added, changed or reordered.
    if (element === cursor) cursor = cursor.nextSibling;
    else messagesPane.insertBefore(element, cursor);
  }
  while (cursor) { const following = cursor.nextSibling; cursor.remove(); cursor = following; }
  renderedMessages.delete(selectedId);
  renderedMessages.set(selectedId, next);
  while (renderedMessages.size > RENDERED_CONVERSATION_LIMIT) renderedMessages.delete(renderedMessages.keys().next().value!);
  renderProcessPanel();
  restoreScroll();
  renderMentionJump();
  renderLatestJump();
  // Images and math can change message heights after the initial render.
  for (const child of messagesPane.children) messageSizeObserver.observe(child);
  // Internal messages / filters can leave a page too short to scroll.
  if (messagesPane.clientHeight > 0 && messagesPane.scrollHeight <= messagesPane.clientHeight) {
    queueMicrotask(() => void loadOlderMessages(true));
  }
}

/** @-mentions read when opening the conversation: once marked read they can't be found, so record them for the floating button; drop them once clicked or scrolled to */
const mentionJumps = new Map<string, number>();
function mentionTarget(): HTMLElement | null {
  const seq = selectedId ? mentionJumps.get(selectedId) : undefined;
  const message = seq ? messagesByConversation.get(selectedId!)?.find(item => item.seq === seq) : undefined;
  return message ? messagesPane.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(message.messageId)}"]`) : null;
}
function flashMessage(target: HTMLElement): void {
  target.classList.remove("mention-target");
  void target.offsetWidth;
  target.classList.add("mention-target");
  if (target.dataset.scrollKey) flashedMessage = { id: target.dataset.scrollKey, until: Date.now() + 1600 };
}
function flashMentionTarget(target: HTMLElement): void {
  flashMessage(target);
  if (selectedId) mentionJumps.delete(selectedId);
  mentionJumpButton.hidden = true;
}
function renderMentionJump(): void {
  const target = mentionTarget();
  if (!target) {
    const seq = selectedId ? mentionJumps.get(selectedId) : undefined;
    mentionJumpButton.hidden = !(selectedId && seq && messageHistory.hasOlder(selectedId)
      && seq < (messagesByConversation.get(selectedId)?.[0]?.seq ?? 0));
    return;
  }
  const box = target.getBoundingClientRect(), pane = messagesPane.getBoundingClientRect();
  if (box.bottom > pane.top && box.top < pane.bottom) flashMentionTarget(target);
  else mentionJumpButton.hidden = false;
}
mentionJumpButton.addEventListener("click", async () => {
  const seq = selectedId ? mentionJumps.get(selectedId) : undefined;
  const target = seq ? await revealHistoryMessage(message => message.seq === seq) : null;
  if (target === undefined) return;
  if (!target) { mentionJumpButton.hidden = true; return; }
  target.scrollIntoView({ block: "center" });
  flashMentionTarget(target);
});
messagesPane.addEventListener("scroll", () => {
  renderLatestJump();
  if (!mentionJumpButton.hidden) renderMentionJump();
  if (messagesPane.scrollTop <= 120) void loadOlderMessages();
}, { passive: true });
// At the very top a failed request can be retried without moving away first.
messagesPane.addEventListener("wheel", event => {
  if (event.deltaY < 0 && messagesPane.scrollTop <= 120) void loadOlderMessages();
}, { passive: true });

function refreshPendingBubbles(): void {
  scheduleProcessPanelRender();
}

// ---------------------------------------------------------------------------
// Conversation header and composer
// ---------------------------------------------------------------------------

function renderConversationHeaderAvatar(contact?: UserRef, fallback = "A"): void {
  conversationAvatar.className = "conversation-avatar";
  conversationAvatar.replaceChildren();
  if (contact) {
    if (contact.avatarUrl || (contact.isAgent && contact.kind)) {
      conversationAvatar.classList.add("image-avatar");
    }
    renderContactAvatar(conversationAvatar, contact);
    return;
  }
  conversationAvatar.textContent = fallback.slice(0, 1).toUpperCase();
}

function renderAllMembersAvatar(conversation: Conversation): void {
  renderMemberCollage(
    conversation.members.map((member) => member.userId)
  );
}

function renderMemberCollage(memberIds: string[]): void {
  conversationAvatar.className = "conversation-avatar member-collage";
  conversationAvatar.replaceChildren();
  const members = memberIds
    .map((userId) => users.get(userId))
    .filter(
      (member): member is UserRef =>
        Boolean(member && member.userId !== me?.userId)
    )
    .slice(0, 4);
  conversationAvatar.classList.add(`members-${Math.max(1, members.length)}`);
  if (!members.length) {
    conversationAvatar.textContent = t("app.conversation.groupAvatar");
    return;
  }
  for (const member of members) {
    const cell = document.createElement("span");
    cell.className = "member-collage-cell";
    renderContactAvatar(cell, member);
    conversationAvatar.append(cell);
  }
}

function conversationSwitchCandidates(): Conversation[] {
  if (conversationSwitcherContactContextId) {
    return conversationsForContact(conversationSwitcherContactContextId);
  }
  if (activeTab === "contacts") {
    const contactId = draftContactId ?? selectedContactId;
    return contactId ? conversationsForContact(contactId) : [];
  }

  const current = selectedId ? conversationById(selectedId) : undefined;
  if (!current) {
    // A contact draft has no selected conversation yet, but still has its history.
    if (draftContactId) return conversationsForContact(draftContactId);
    if (!draftMemberIds?.length) return [];
    return draftMemberIds.length === 1
      ? directConversationsFor(draftMemberIds[0])
      : conversationsWithMemberIds(draftMemberIds);
  }
  if (current.type === "GROUP") return conversationsWithSameMembers(current);
  const contact = focusedContactForConversation(current);
  return contact ? conversationsForContact(contact.userId) : [current];
}

/** Conversations switchable from the all-members perspective: group chats whose members (excluding self) are exactly the same */
function conversationsWithSameMembers(conversation: Conversation): Conversation[] {
  return conversationsWithMemberIds(conversation.members.map(member => member.userId));
}

/** Drafts and existing group chats both look up past conversations by the same member set. */
function conversationsWithMemberIds(memberIds: string[]): Conversation[] {
  const key = (ids: string[]) => ids.filter(id => id !== me?.userId).sort().join(",");
  const target = key(memberIds);
  return conversations
    .filter(item => item.type === "GROUP" && key(item.members.map(member => member.userId)) === target)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function focusedContactForConversation(conversation: Conversation): UserRef | undefined {
  if (selectedContactId) {
    const isMember = conversation.members.some(
      (member) => member.userId === selectedContactId
    );
    const selected = users.get(selectedContactId);
    if (isMember && selected && selected.userId !== me?.userId) return selected;
  }
  return counterpart(conversation) ?? conversation.members
    .map((member) => users.get(member.userId))
    .find((member): member is UserRef => Boolean(member && member.userId !== me?.userId));
}

function unreadDot(): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "conversation-unread-dot";
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", t("app.conversation.unread"));
  return dot;
}

function renderConversationSwitcherUnread(): void {
  const hasUnread = !conversationSwitcherButton.disabled && conversationSwitchCandidates()
    .some(conversation => conversation.conversationId !== selectedId && unreadCount(conversation) > 0);
  conversationSwitcherButton.querySelector(".conversation-unread-dot")?.remove();
  if (hasUnread) conversationSwitcherButton.append(unreadDot());
  if (!conversationSwitcherMenu.hidden) renderConversationSwitcherMenu();
}

/** Who the conversations in the switcher list are with: "New conversation" opens another direct chat with this person */
function conversationSwitcherContact(): UserRef | undefined {
  if (conversationSwitcherContactContextId) return users.get(conversationSwitcherContactContextId);
  if (activeTab === "contacts" || !selectedId) {
    const contactId = draftContactId ?? selectedContactId;
    return contactId ? users.get(contactId) : undefined;
  }
  const current = conversationById(selectedId);
  return current ? focusedContactForConversation(current) : undefined;
}

function renderConversationSwitcherMenu(): void {
  // The first item is always "New conversation" and doesn't scroll; the scrollable conversation list is below it
  const scrollTop = conversationSwitcherMenu.querySelector(".conversation-switcher-scroll")?.scrollTop ?? 0;
  const scroll = document.createElement("div");
  scroll.className = "conversation-switcher-scroll";
  scroll.addEventListener("scroll", () => switcherPages.nearEnd(scroll));
  const contact = conversationSwitcherContact();
  const current = selectedId ? conversationById(selectedId) : undefined;
  const create = document.createElement("button");
  create.type = "button";
  create.className = "conversation-switcher-item conversation-switcher-new";
  const createLabel = document.createElement("span");
  createLabel.textContent = t("app.conversation.newConversation");
  create.innerHTML = iconSvg("add");
  create.append(createLabel);
  // Already in a new conversation with no messages sent, creating another is pointless: this item is the current item
  const alreadyNew = !selectedId && Boolean(draftContactId || draftMemberIds?.length);
  if (alreadyNew) create.classList.add("active");
  // All-members perspective (group chat, not focused on one person): new means opening another conversation with the current members
  const groupView = !conversationSwitcherContactContextId && activeTab !== "contacts" && current?.type === "GROUP";
  create.disabled = !alreadyNew && !groupView && !contact;
  // Disabled items must also explain why: the hover tooltip and screen reader both give "why it can't be clicked"
  if (create.disabled) {
    create.setAttribute("aria-disabled", "true");
    create.dataset.tooltip = t("app.conversation.newUnavailable");
    create.setAttribute("aria-label", t("app.conversation.disabledLabel", { label: t("app.conversation.newConversation"), reason: t("app.conversation.newUnavailable") }));
  }
  create.addEventListener("click", () => {
    conversationSwitcherMenu.hidden = true;
    if (alreadyNew) return;
    if (groupView && current) beginGroupConversationWithSameMembers(current);
    // The one opened becomes the focus, and clicking the contact goes into it by default; to go back to the previous one, switch back here and the focus follows.
    else if (contact) beginContactConversation(contact, current?.workspaceId ?? draftWorkspaceId);
  });
  conversationSwitcherMenu.replaceChildren(create, scroll);
  const related = conversationSwitchCandidates();
  const visible = switcherPages.visible(related.map(item => item.conversationId));
  for (const conversation of related.filter(item => visible.has(item.conversationId))) {
    const item = document.createElement("button");
    const title = document.createElement("span");
    const meta = document.createElement("small");
    item.type = "button";
    item.className = "conversation-switcher-item";
    item.dataset.conversationId = conversation.conversationId;
    if (conversation.conversationId === selectedId) item.classList.add("active");
    title.textContent = conversationName(conversation);
    const memberText = conversation.type === "GROUP"
      ? t("app.conversation.memberCount", { count: conversation.members.length })
      : counterpart(conversation)?.displayName;
    meta.textContent = conversation.status === "ACTIVE"
      ? memberText || t("app.conversation.inProgress")
      : t("app.conversation.completed");
    const activity = document.createElement("span");
    activity.className = "conversation-switcher-activity";
    item.append(activity, title, meta);
    if (conversation.conversationId !== selectedId && unreadCount(conversation) > 0) item.append(unreadDot());
    if (conversation.conversationId === selectedId) {
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = "✓";
      item.append(check);
    }
    item.addEventListener("click", () => {
      conversationSwitcherMenu.hidden = true;
      rememberFocus(conversation);
      void selectConversation(conversation.conversationId, true);
    });
    scroll.append(item);
  }
  scroll.scrollTop = scrollTop;
  syncSwitcherThinking();

  if (!related.length) {
    const empty = document.createElement("div");
    empty.className = "contact-empty compact";
    empty.textContent = t("app.conversation.noConversations");
    scroll.append(empty);
  }
}

function renderHeader(): void {
  conversationHeader.classList.remove("conversation-running", "conversation-idle");
  conversationIdentity.querySelector(".ikkyu-thinking")?.remove();
  renderConversationAgentMenu(selectedId ? conversationById(selectedId) : undefined);
  conversationIdentity.hidden = false;
  conversationMeta.textContent = "";
  conversationNameCenter.textContent = "";
  conversationNameCenter.hidden = true;
  settingsButton.hidden = true;
  settingsButton.disabled = true;

  if (!selectedId) {
    conversationHeader.classList.add("conversation-idle");
    const contact = draftContactId ? users.get(draftContactId) : undefined;
    if (contact) {
      conversationTitle.textContent = contact.displayName;
      conversationNameCenter.textContent = t("app.conversation.draftName");
      conversationNameCenter.hidden = false;
      renderConversationHeaderAvatar(contact);
      const history = conversationsForContact(contact.userId);
      conversationSwitcherButton.hidden = history.length === 0;
      conversationSwitcherButton.disabled = history.length === 0;
      conversationSwitcherButton.dataset.tooltip = t("app.conversation.switch");
      conversationSwitcherButton.setAttribute("aria-label", t("app.conversation.switch"));
    } else if (draftMemberIds?.length) {
      // When only one Agent is selected this is a direct chat, and the header shows who the other party is;
      // "All members" is wording only for group chats; it doesn't fit with one person.
      const only = draftMemberIds.length === 1 ? users.get(draftMemberIds[0]) : undefined;
      conversationTitle.textContent = only?.displayName ?? t("app.header.allMembers");
      conversationNameCenter.textContent = t("app.conversation.draftName");
      conversationNameCenter.hidden = false;
      if (only) renderConversationHeaderAvatar(only);
      else renderMemberCollage(draftMemberIds);
      const history = conversationSwitchCandidates();
      conversationSwitcherButton.hidden = history.length === 0;
      conversationSwitcherButton.disabled = history.length === 0;
      conversationSwitcherButton.dataset.tooltip = t("app.conversation.switch");
      conversationSwitcherButton.setAttribute("aria-label", t("app.conversation.switch"));
    } else {
      conversationTitle.textContent = t("app.header.pickPrompt");
      renderConversationHeaderAvatar();
      conversationSwitcherButton.hidden = true;
      conversationSwitcherButton.disabled = true;
    }
    renderAddMemberButton();
    renderConversationSwitcherUnread();
    return;
  }
  const conversation = conversationById(selectedId);
  if (!conversation) return;
  conversationHeader.classList.add(
    hasRunningAgent(conversation.conversationId) ? "conversation-running" : "conversation-idle"
  );
  renderConversationAgentMenu(conversation);

  const name = conversationName(conversation);
  const contact = activeTab === "contacts" ? focusedContactForConversation(conversation) : undefined;
  conversationNameCenter.textContent = name;
  conversationNameCenter.hidden = false;
  if (conversation.type === "DIRECT") {
    const other = counterpart(conversation);
    renderConversationHeaderAvatar(other, name);
    conversationTitle.textContent = other?.displayName ?? t("app.header.contactFallback");
  } else {
    renderAllMembersAvatar(conversation);
    conversationTitle.textContent = t("app.header.allMembers");
  }
  syncHeaderThinking();

  const candidates = conversationSwitchCandidates();
  conversationSwitcherButton.hidden = candidates.length === 0;
  conversationSwitcherButton.disabled = candidates.length === 0;
  // The current task name is already in the title bar; stuffing it into the bubble would only blow it up --
  // task names are often an entire path, and the bubble's 300px max width can't fit it.
  const switchTip = t("app.conversation.switch");
  conversationSwitcherButton.dataset.tooltip = switchTip;
  conversationSwitcherButton.setAttribute("aria-label", switchTip);

  renderAddMemberButton();
  renderConversationSwitcherUnread();
}

function renderAddMemberButton(): void {
  const current = selectedId ? conversationById(selectedId) : undefined;
  const available = (!current || isConversationMember(current)) && addMemberTargetIds() !== null;
  conversationAddMemberButton.hidden = !available;
  if (!available) conversationAddMemberMenu.hidden = true;
  else if (!conversationAddMemberMenu.hidden) renderAddMemberMenu();
}

function autoGrowInput(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function syncComposer(): void {
  syncComposerContext();
  renderComposerReply();
  // Same for direct and group chats: show the notice as long as one AI is running or still has queued work; details are in the "Feed"; hide it when all have stopped.
  const working = selectedId !== null && (hasRunningAgent(selectedId) || queuedAgents.some(entry => entry.conversationId === selectedId));
  const queueStatus = el<HTMLDivElement>("#conversation-queue-status");
  queueStatus.hidden = !working;
  queueStatus.textContent = working ? t("app.queue.working") : "";
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  // When using an Agent shared by someone else, its owner can also see this conversation
  const memberIds = conversation?.members.map(member => member.userId) ?? draftMemberIds ?? (draftContactId ? [draftContactId] : []);
  const shareOwners = [...new Set(memberIds.map(id => users.get(id)?.isAgent ? users.get(id)?.owner : undefined)
    .filter((owner): owner is string => !!owner && owner !== me?.userId && !memberIds.includes(owner)))];
  const shareNotice = el<HTMLDivElement>("#conversation-share-notice");
  shareNotice.hidden = !shareOwners.length;
  shareNotice.textContent = shareOwners.length ? t("app.share.ownerCanSee", { owners: shareOwners.map(id => users.get(id)?.displayName ?? id).join("、") }) : "";
  const exFriend = conversation ? formerFriendIn(conversation) : undefined;
  // Sharing a direct chat forbids sending messages; the Agent's owner can still pause or resume their own Agent.
  const readOnly = !!conversation && !isConversationMember(conversation);
  const ownerViewing = readOnly && conversation.members.some(member => {
    const user = users.get(member.userId);
    return user?.isAgent && user.owner === me?.userId;
  });
  // The shared Agent I'm using was paused by its owner: no more messages can be sent, and only the owner can resume
  const pausedAgent = conversation?.members.map(member => member.ownerPaused ? users.get(member.userId) : undefined)
    .find(agent => !!agent && agent.owner !== me?.userId);
  const pausedText = pausedAgent ? t("app.share.ownerPaused", { owner: users.get(pausedAgent.owner ?? "")?.displayName ?? pausedAgent.owner ?? "", agent: pausedAgent.displayName }) : "";
  if (pausedText) { shareNotice.hidden = false; shareNotice.textContent = pausedText; }
  const canSend = !exFriend && !readOnly && !pausedAgent && (selectedId !== null || draftContactId !== null || Boolean(draftMemberIds?.length));
  input.disabled = !canSend;
  input.placeholder = exFriend
    ? t("app.friends.noLongerFriends", { name: exFriend.displayName })
    : pausedText ? pausedText
    : ownerViewing
    ? t("app.share.ownerReadOnly", { name: users.get(conversation.owner)?.displayName ?? conversation.owner })
    : readOnly ? t("app.share.notMember")
    : draftContactId
    ? t("app.composer.placeholderContact", { name: users.get(draftContactId)?.displayName ?? t("app.header.contactFallback") })
    : draftMemberIds?.length ? t("app.composer.placeholderDraft") : t("app.composer.placeholder");
  // After pausing, once all Agents have stopped, this button becomes "Resume"; while an Agent is running it's still Pause
  const resumable = Boolean(conversation && isResumable(conversation.conversationId));
  stopButton.hidden = !(canSend || ownerViewing);
  stopButton.disabled = !conversation
    || (!ownerViewing && !resumable && !hasRunningAgent(conversation.conversationId))
    || conversationControlPending.has(conversation.conversationId);
  stopButton.title = t(resumable ? "app.composer.resume" : "app.composer.stop");
  stopButton.setAttribute("aria-label", stopButton.title);
  const stopIcon = el<SVGElement>("#composer-stop-icon");
  const icon = resumable ? "play" : "pause";
  if (stopIcon.dataset.icon !== icon) {
    stopIcon.dataset.icon = icon;
    mountIcons(stopButton);
  }
  sendButton.hidden = false;
  sendButton.disabled = !canSend || (input.value.trim().length === 0 && pendingAttachments.length === 0);
  attachButton.disabled = !canSend || pendingAttachments.length >= MAX_PENDING_ATTACHMENTS;
}

/** Direct chat with a deleted friend: returns the other party. The history stays, but no more messages can be sent */
function formerFriendIn(conversation: Conversation): UserRef | undefined {
  if (conversation.type !== "DIRECT") return undefined;
  const other = conversation.members.find(member => member.userId !== me?.userId);
  const user = other ? users.get(other.userId) : undefined;
  return user && !user.isAgent && user.friend === false ? user : undefined;
}

const mentionMenu = document.createElement("div");
mentionMenu.className = "mention-menu";
mentionMenu.setAttribute("role", "listbox");
mentionMenu.setAttribute("aria-label", t("app.mention.choose"));
mentionMenu.hidden = true;
composer.prepend(mentionMenu);
let mentionIndex = 0;
function mentionLabel(user: UserRef, candidates: UserRef[]): string {
  const duplicates = candidates.filter(candidate => candidate.displayName === user.displayName);
  if (duplicates.length < 2) return user.displayName;
  const computer = user.remote?.computerName ?? agentComputerOf(user)?.name;
  const base = computer ? `${user.displayName} (${computer})` : user.displayName;
  const sameComputer = duplicates.filter(candidate => (candidate.remote?.computerName ?? agentComputerOf(candidate)?.name) === computer);
  return sameComputer.length > 1 ? `${base} #${sameComputer.findIndex(candidate => candidate.userId === user.userId) + 1}` : base;
}
function mentionCandidates(): UserRef[] {
  const ids = selectedId ? conversationById(selectedId)?.members.map(member => member.userId) ?? [] : draftMemberIds ?? (draftContactId ? [draftContactId] : []);
  return ids.filter(id => id !== me?.userId).map(id => users.get(id)).filter((user): user is UserRef => !!user);
}
function mentionOptions(): MentionOption[] {
  const candidates = mentionCandidates();
  const options = candidates.map(user => ({ label: mentionLabel(user, candidates), userId: user.userId }));
  // A direct chat has only one person, so "all real people" doesn't apply
  return candidates.length > 1 && candidates.some(user => !user.isAgent)
    ? [{ label: t("app.mentions.allPeople"), userId: ALL_PEOPLE_MENTION }, ...options]
    : options;
}
function mentionQuery(): RegExpMatchArray | null {
  // An @ followed immediately by whitespace isn't mentioning anyone; spaces inside names are unaffected (@Home 小c)
  return input.value.slice(0, input.selectionStart).match(/@(?!\s)([^@\n]*)$/);
}
/** A direct chat has only one counterpart, so @ needs no picking. Drafts have no conversation type yet, so count by member count */
function mentionMenuAvailable(): boolean {
  const conversation = selectedId ? conversationById(selectedId) : undefined;
  return conversation ? conversation.type !== "DIRECT" : mentionCandidates().length > 1;
}
function renderMentions(): void {
  const query = mentionQuery();
  mentionMenu.replaceChildren();
  if (!query || input.disabled || !mentionMenuAvailable()) { mentionMenu.hidden = true; return; }
  const candidates = mentionOptions().filter(option => option.label.toLocaleLowerCase().includes(query[1].toLocaleLowerCase()));
  mentionIndex = Math.min(mentionIndex, Math.max(0, candidates.length - 1));
  candidates.forEach((option, index) => {
    const button = document.createElement("button"); button.type = "button";
    button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(index === mentionIndex));
    button.textContent = option.label;
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => {
      const current = mentionQuery(); if (!current) return;
      insertMention(option, input.selectionStart - current[1].length - 1, input.selectionStart);
    });
    mentionMenu.append(button);
  });
  mentionMenu.hidden = !candidates.length;
}
/** Replace [start, end) with @name and bind the userId. The name includes the computer name, to distinguish same-named members */
function insertMention(option: MentionOption, start: number, end: number): void {
  const key = currentComposerKey();
  pickedMentions.set(key, new Map(pickedMentions.get(key)).set(option.label, option.userId));
  input.setRangeText(`@${option.label} `, start, end, "end");
  mentionMenu.hidden = true; input.focus(); autoGrowInput(); syncComposer();
}
/** @-mention this person at the cursor; returns false if the composer is unavailable or they're no longer in the conversation */
function mentionInComposer(user: UserRef): boolean {
  const option = input.disabled ? undefined : mentionOptions().find(item => item.userId === user.userId);
  if (!option) return false;
  insertMention(option, input.selectionStart, input.selectionEnd);
  return true;
}
/** Quote at the top of a bubble: click to jump back to the original message */
function messageQuoteElement(quote: MessageQuote, replyTo?: string): HTMLElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "message-quote";
  const name = document.createElement("strong");
  name.textContent = userName(quote.senderId);
  const text = document.createElement("span");
  text.textContent = quote.text;
  element.append(name, text);
  element.addEventListener("click", async () => {
    const target = replyTo ? await revealHistoryMessage(message => message.messageId === replyTo) : null;
    if (target === undefined) return;
    if (!target) { setStatus(t("app.message.quoteMissing"), "info", true); return; }
    target.scrollIntoView({ block: "center" });
    flashMessage(target);
  });
  return element;
}
function renderComposerReply(): void {
  const reply = replyTargets.get(currentComposerKey());
  composerReply.hidden = !reply;
  composerReply.replaceChildren();
  if (!reply) return;
  const name = document.createElement("strong");
  name.textContent = userName(reply.quote.senderId);
  const text = document.createElement("span");
  text.textContent = reply.quote.text;
  const close = document.createElement("button");
  close.type = "button";
  close.innerHTML = iconSvg("close");
  close.dataset.tooltip = t("app.message.replyCancel");
  close.setAttribute("aria-label", t("app.message.replyCancel"));
  close.addEventListener("click", () => { cancelReply(); input.focus(); });
  composerReply.append(name, text, close);
}
function cancelReply(): void {
  const key = currentComposerKey();
  const reply = replyTargets.get(key);
  if (!reply) return;
  replyTargets.delete(key);
  const auto = reply.mentionLabel ? `@${reply.mentionLabel} ` : "";
  if (auto && input.value.startsWith(auto)) {
    input.value = input.value.slice(auto.length);
    input.dispatchEvent(new Event("input"));
  }
  renderComposerReply();
}
/** Reply to a message: show the quote above the composer; in group chats auto-@ its sender at the start, without repeating if already mentioned */
function startReply(message: Message): void {
  if (input.disabled) return;
  cancelReply();
  const option = mentionMenuAvailable() ? mentionOptions().find(item => item.userId === message.senderId) : undefined;
  const mentionLabel = option && !input.value.includes(`@${option.label}`) ? option.label : undefined;
  if (option && mentionLabel) insertMention(option, 0, 0);
  const preview = (displayedMessageContent(message) || attachmentSummary(message)).replace(/\s+/g, " ").trim().slice(0, 200);
  replyTargets.set(currentComposerKey(), { messageId: message.messageId, quote: { senderId: message.senderId, text: preview }, ...(mentionLabel ? { mentionLabel } : {}) });
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  autoGrowInput();
  syncComposer();
}
input.addEventListener("click", renderMentions);
input.addEventListener("blur", () => { mentionMenu.hidden = true; });

/** Only picks from the menu count as @: the userId is bound at pick time, and manually typed text isn't parsed. Once deleted from the body it no longer counts */
function parseMentions(content: string, conversation: Conversation, picked: ReadonlyMap<string, string>): string[] {
  const options = [...picked].filter(([, userId]) => userId === ALL_PEOPLE_MENTION || conversation.members.some(member => member.userId === userId && userId !== me?.userId));
  const people = conversation.members.map(member => member.userId).filter(id => id !== me?.userId && users.get(id) && !users.get(id)?.isAgent);
  return [...new Set(resolveMentions(content, options.map(([label, userId]) => ({ label, userId }))).flatMap(id => id === ALL_PEOPLE_MENTION ? people : [id]))];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function indexUsers(list: UserRef[]): void {
  for (const user of list) {
    // "Me" is set only by sign-in state switches and saving personal details; don't let the standalone profile from the list overwrite it
    if (me && user.userId === me.userId) continue;
    users.set(user.userId, withLocalizedName(user));
  }
}

function replaceContacts(list: UserRef[]): void {
  contactIds.clear();
  for (const contact of list) {
    users.set(contact.userId, withLocalizedName(contact));
    // Real people who were unfriended or only seen in groups are only used for display names, not counted as contacts
    if (contact.friend !== false) contactIds.add(contact.userId);
  }
}

async function loadMessages(conversationId: string): Promise<void> {
  await messageHistory.load(conversationId);
}

const olderMessageLoads = new Set<string>();
/** Quote / unread navigation may refer to a message outside the initial page. */
async function revealHistoryMessage(matches: (message: Message) => boolean): Promise<HTMLElement | null | undefined> {
  const id = selectedId, generation = dataGeneration;
  if (!id) return null;
  try {
    let message = messagesByConversation.get(id)?.find(matches);
    while (!message && messageHistory.hasOlder(id)) {
      if (!await messageHistory.loadOlder(id)) break;
      if (selectedId !== id || generation !== dataGeneration) return undefined;
      message = messagesByConversation.get(id)?.find(matches);
    }
    if (selectedId !== id || generation !== dataGeneration) return undefined;
    renderMessages();
    return message ? messagesPane.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(message.messageId)}"]`) : null;
  } catch (error) {
    if (selectedId === id && generation === dataGeneration) {
      setStatus(t("app.messages.loadFailed", { error: describeError(error) }), "error", false, chatKey(id));
    }
    return undefined;
  }
}

/** Automatic fills follow every render; after a failure they wait, while scrolling still retries at once. */
const olderLoadFailedAt = new Map<string, number>();
const AUTO_OLDER_RETRY_MS = 5000;
async function loadOlderMessages(automatic = false): Promise<void> {
  const id = selectedId, generation = dataGeneration;
  if (!id || messagesPane.clientHeight <= 0 || !messageHistory.hasOlder(id) || olderMessageLoads.has(id)) return;
  if (automatic && Date.now() - (olderLoadFailedAt.get(id) ?? 0) < AUTO_OLDER_RETRY_MS) return;
  olderMessageLoads.add(id);
  try {
    const loaded = await messageHistory.loadOlder(id);
    olderLoadFailedAt.delete(id);
    if (loaded && generation === dataGeneration && selectedId === id) renderMessages();
  } catch (error) {
    olderLoadFailedAt.set(id, Date.now());
    if (generation === dataGeneration && selectedId === id) {
      setStatus(t("app.messages.loadFailed", { error: describeError(error) }), "error", false, chatKey(id));
    }
  } finally {
    olderMessageLoads.delete(id);
  }
}

let appWindowActive=false;
let windowActiveRevision=0;
let bootReady=false;
let pendingNotificationConversationId:string|undefined;
function visibleConversation():Conversation|undefined {
  if(!appWindowActive||!selectedId||draftContactId||draftMemberIds?.length||!['contacts','conversations'].includes(activeTab))return;
  return conversationById(selectedId);
}
function markVisibleConversationRead():void {
  const conversation=visibleConversation();
  if(!conversation||unreadCount(conversation)===0)return;
  const mentionSeq=unreadMentionSeq(conversation);
  if(mentionSeq&&!mentionJumps.has(conversation.conversationId)){mentionJumps.set(conversation.conversationId,mentionSeq);renderMentionJump();}
  const seq=conversation.lastSeq;
  void bridge.markRead(conversation.conversationId,seq).then(accepted=>{
    if(accepted===false)return;
    const mine=conversation.members.find(member=>member.userId===me?.userId);
    if(mine){mine.lastReadSeq=Math.max(mine.lastReadSeq??0,seq);if((mine.firstUnreadMentionSeq??0)<=seq)delete mine.firstUnreadMentionSeq;}
    renderConversationList();renderConversationSwitcherUnread();
  }).catch(()=>undefined);
}
async function refreshVisibleConversation():Promise<void> {
  const conversation=visibleConversation();if(!conversation)return;
  try {
    await loadMessages(conversation.conversationId);
    if(visibleConversation()?.conversationId!==conversation.conversationId)return;
    renderMessages();markVisibleConversationRead();
  }catch{/* Keep unread when the conversation couldn't be loaded. */}
}
async function openNotificationConversation():Promise<void> {
  const id=pendingNotificationConversationId;if(!bootReady||!id)return;
  pendingNotificationConversationId=undefined;
  if(!conversationById(id))await refreshConversations();
  if(!conversationById(id))return;
  switchTab('conversations');await selectConversation(id);
}
bridge.onWindowActive?.(active=>{
  windowActiveRevision++;appWindowActive=active;
  if(active&&bootReady)void refreshVisibleConversation();
});
bridge.onOpenFriendRequests?.(()=>{openChatTab("contacts");void refreshFriendRequests().then(()=>openFriendDialog());});
bridge.onOpenConversation?.(id=>{
  pendingNotificationConversationId=id;void openNotificationConversation();
});

async function selectConversation(
  conversationId: string,
  preserveSwitcherContext = false
): Promise<void> {
  const generation = dataGeneration;
  if (temporaryUnreadConversationId !== conversationId) temporaryUnreadConversationId = undefined;
  if (!preserveSwitcherContext) conversationSwitcherContactContextId = null;
  selectedId = conversationId;
  conversationAgentMenuOpen = false;
  processAgentFilterId = null;
  draftContactId = null;
  draftMemberIds = null;
  draftPermanent = false;
  draftAutoTitle = false;
  draftWorkspaceId = undefined;
  draftReturnConversationId = null;
  const selected = conversationById(conversationId);
  const contact = selected ? counterpart(selected) : undefined;
  if (contact) selectedContactId = contact.userId;
  conversationSwitcherMenu.hidden = true;
  renderConversationList();
  renderHeader();
  syncComposer();
  // Show cached rows right away instead of leaving the previous conversation on screen while the page loads.
  renderMessages();
  let loaded=true;
  try {
    await loadMessages(conversationId);
  } catch (error) {
    loaded=false;
    if (generation !== dataGeneration) return;
    setStatus(t("app.messages.loadFailed", { error: describeError(error) }), "error", false, chatKey(conversationId));
  }
  if (generation !== dataGeneration || selectedId !== conversationId) return;
  renderMessages();

  if(loaded)markVisibleConversationRead();
  input.focus();
}

let conversationRefreshGeneration = 0;
async function refreshConversations(): Promise<void> {
  const generation = ++conversationRefreshGeneration;
  const [nextConversations, contacts, stopped] = await Promise.all([
    bridge.listConversations(),
    bridge.listContacts(),
    bridge.listStoppedConversations()
  ]);
  if (generation !== conversationRefreshGeneration) return;
  conversations = recentConversations(nextConversations);
  stoppedConversations = new Set(stopped);
  replaceContacts(contacts);
  if (contactDetailDialog.open && detailContact?.isAgent) {
    detailContact = users.get(detailContact.userId) ?? detailContact;
    renderContactAgentStatus(detailContact, agentStatusOf(detailContact));
  }
  const selectionRemoved=!!selectedId && !conversations.some(conversation=>conversation.conversationId===selectedId);
  if (selectionRemoved) { selectedId=null; temporaryUnreadConversationId=undefined; }
  if (activeTab==="conversations" || (activeTab==="agents" && tabBeforeAgents==="conversations")) ensureDefaultConversationDraft();
  if (selectionRemoved) renderMessages();
  renderConversationList();
  renderHeader();
  renderMessageFilters();
  syncComposer();
  if (settingsDialog.open && editingConversationId) {
    const editing = conversationById(editingConversationId);
    if (editing) renderMemberEditor(editing);
  }
}


// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

function workspacesWithInboxFirst(): Workspace[] {
  return [...workspaces].sort(
    (left, right) => Number(right.kind === "inbox") - Number(left.kind === "inbox")
  );
}

function openConversationSettings(conversationId = selectedId): void {
  if (!conversationId) return;
  const conversation = conversationById(conversationId);
  if (!conversation || !isConversationMember(conversation)) return;

  editingConversationId = conversation.conversationId;

  const isGroup = conversation.type === "GROUP";
  addingConversationMembers = false;
  settingsMemberSearch.value = "";
  settingsDialog.classList.toggle("direct-settings", !isGroup);
  groupFields.hidden = false;
  conversationMemberSettings.hidden = !isGroup;
  workspaceInput.value = conversation.workspacePath ?? "";
  settingsPermanent.checked = !!conversation.permanent;

  // "Move this conversation into a workspace". Starting casually and later finding it belongs to some project
  // is a very common path -- what changes is only which layer of shared knowledge it can see from now on; history is untouched.
  settingsWorkspace.replaceChildren();
  for (const workspace of workspacesWithInboxFirst()) {
    const option = document.createElement("option");
    option.value = workspace.workspaceId;
    option.textContent =
      workspace.kind === "folder"
        ? `${workspace.name}　${shortPath(workspace.path ?? "")}`
        : t("app.workspace.none");
    settingsWorkspace.append(option);
  }
  settingsWorkspace.value = conversation.workspaceId;
  updateSettingsWorkspaceHint();

  settingsTitle.textContent = t("app.settings.title");
  conversationSettingsError.textContent = "";
  groupNameInput.value = conversation.name ?? "";
  conversationGoalInput.value = conversation.charter?.goal ?? "";
  conversationInstructions.value = conversation.charter?.instructions ?? "";
  if (isGroup) {
    renderMemberEditor(conversation);
  }
  settingsDialog.showModal();
}

function memberGroupDivider(): HTMLElement {
  const heading = document.createElement("div");
  heading.className = "human-group-divider";
  heading.setAttribute("role", "separator");
  return heading;
}

function agentReadinessLight(agent: UserRef): HTMLElement {
  const available = agentAvailable(agent);
  const light = document.createElement("span");
  light.className = `conversation-agent-readiness ${available ? "ready" : "unavailable"}`;
  light.setAttribute("role", "img");
  light.setAttribute("aria-label", available ? t("app.readiness.available") : t("app.readiness.unavailable"));
  light.title = available ? t("app.readiness.available") : t("app.readiness.unavailable");
  return light;
}

function renderMemberEditor(conversation: Conversation): void {
  const scrollTop = memberEditor.scrollTop;
  memberEditor.replaceChildren();
  // The member list doesn't show yourself: you're always in the task, so listing yourself carries no information
  const listedMembers = conversation.members.filter(member => member.userId !== me?.userId);
  settingsMembersTitle.textContent = addingConversationMembers ? t("app.members.addTitle") : t("app.members.countTitle", { count: listedMembers.length });
  settingsMemberSearch.placeholder = addingConversationMembers ? t("app.contacts.search") : t("app.members.search");
  settingsMemberSearch.setAttribute("aria-label", settingsMemberSearch.placeholder);
  settingsAddMembers.title = addingConversationMembers ? t("app.members.backToList") : t("app.members.addTitle");
  settingsAddMembers.setAttribute("aria-label", settingsAddMembers.title);
  settingsAddMembers.innerHTML = iconSvg(addingConversationMembers ? "back" : "add");
  settingsAddMembers.disabled = memberMutationPending;
  const candidates = addingConversationMembers
    ? [...users.values()].filter(user => contactIds.has(user.userId) && !conversation.members.some(member => member.userId === user.userId) && canJoinTogether(conversation.members.map(member => member.userId), user, false)).sort(compareContacts)
    : listedMembers.map(member => users.get(member.userId) ?? {userId:member.userId,displayName:userName(member.userId),isAgent:false} as UserRef);
  const matching = candidates.filter(user => matchesContact(user, settingsMemberSearch.value)).sort(compareMembers);
  let previousKind: boolean | undefined;
  for (const user of matching) {
    if (previousKind !== user.isAgent) {
      if (previousKind !== undefined) memberEditor.append(memberGroupDivider());
      previousKind = user.isAgent;
    }
    const member = conversation.members.find(item => item.userId === user.userId);
    const row = document.createElement("div");
    row.className = "member-row";
    row.dataset.userId = user.userId;
    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    renderContactAvatar(avatar, user);
    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = user.displayName;
    name.title = user.displayName;
    // In online mode, hovering an agent shows its computer, to tell same-named agents apart
    const computerLabel = agentComputerLabel(user);
    if (computerLabel) name.dataset.tooltip = computerLabel;
    const readiness = user.isAgent ? agentReadinessLight(user) : document.createElement("span");
    const leaderSlot = document.createElement("span");
    leaderSlot.className = "member-leader-slot";
    if (user.isAgent && member) {
      const leader = memberActionButton("leader", member.role === "LEADER" ? t("app.leader.current") : t("app.leader.set"));
      leader.setAttribute("aria-pressed", String(member.role === "LEADER"));
      leader.disabled = memberMutationPending;
      leader.addEventListener("click", () => {
        if (member.role !== "LEADER") void changeConversationMember(conversation.conversationId, () => bridge.setMemberRole(conversation.conversationId, user.userId, "LEADER"), t("app.leader.became", { name: user.displayName }));
      });
      leaderSlot.append(leader);
    }
    const action = memberActionButton(addingConversationMembers ? "add" : "remove", addingConversationMembers ? t("app.members.addNamed", { name: user.displayName }) : user.userId === conversation.owner ? t("app.members.ownerFixed") : t("app.members.removeNamed", { name: user.displayName }));
    action.disabled = memberMutationPending || (!addingConversationMembers && (user.userId === conversation.owner || conversation.members.some(member => users.get(member.userId)?.isAgent && users.get(member.userId)?.owner === user.userId)));
    action.addEventListener("click", () => {
      if (addingConversationMembers) void changeConversationMember(conversation.conversationId, () => bridge.addMember(conversation.conversationId, user.userId, "ENGINEER"), t("app.members.added", { name: user.displayName }));
      else void changeConversationMember(conversation.conversationId, () => bridge.removeMember(conversation.conversationId, user.userId), t("app.members.removed", { name: user.displayName }));
    });
    row.append(avatar, name, readiness, leaderSlot, action);
    memberEditor.append(row);
  }
  if (!memberEditor.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "contact-empty compact";
    empty.textContent = addingConversationMembers && !settingsMemberSearch.value ? t("app.members.noneToAdd") : t("app.members.noMatch");
    memberEditor.append(empty);
  }
  memberEditor.scrollTop = scrollTop;
}


function memberActionButton(action: "add" | "remove" | "leader", title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `member-icon-button ${action}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = iconSvg(action);
  return button;
}

async function changeConversationMember(conversationId: string, change: () => Promise<Conversation>, success: string): Promise<void> {
  if (memberMutationPending) return;
  memberMutationPending = true;
  conversationSettingsError.textContent = "";
  const conversation = conversationById(conversationId);
  if (conversation) renderMemberEditor(conversation);
  if (!conversationAddMemberMenu.hidden) renderAddMemberMenu();
  try {
    await change();
    await refreshConversations();
    setStatus(success, "info", false, chatKey(conversationId));
  } catch (error) {
    setStatus(describeError(error), "error", false, chatKey(conversationId));
    conversationSettingsError.textContent = describeError(error);
  } finally {
    memberMutationPending = false;
    const fresh = conversationById(conversationId);
    if (fresh && editingConversationId === conversationId && settingsDialog.open) renderMemberEditor(fresh);
    if (!conversationAddMemberMenu.hidden) renderAddMemberMenu();
  }
}

settingsAddMembers.addEventListener("click", () => {
  addingConversationMembers = !addingConversationMembers;
  settingsMemberSearch.value = "";
  const conversation = editingConversationId ? conversationById(editingConversationId) : undefined;
  if (conversation) renderMemberEditor(conversation);
  settingsMemberSearch.focus();
});
settingsMemberSearch.addEventListener("input", () => {
  memberEditor.scrollTop = 0;
  const conversation = editingConversationId ? conversationById(editingConversationId) : undefined;
  if (conversation) renderMemberEditor(conversation);
});

function updateSettingsWorkspaceHint(): void {
  const workspace = workspaceById(settingsWorkspace.value);
  settingsWorkspaceHint.textContent =
    workspace?.kind === "folder"
      ? t("app.settings.workspaceHintFolder")
      : t("app.settings.workspaceHintNone");
}

settingsWorkspace.addEventListener("change", updateSettingsWorkspaceHint);

async function saveSettings(): Promise<void> {
  if (!editingConversationId) return;
  const conversation = conversationById(editingConversationId);
  if (!conversation) return;

  settingsSave.disabled = true;
  settingsSave.textContent = t("app.common.saving");
  try {
    const name = groupNameInput.value.trim();
    if (!name) throw new Error(t("app.settings.needName"));
    const goal = conversationGoalInput.value.trim();
    const charter = {
      ...conversation.charter,
      instructions: conversationInstructions.value.trim(),
      goal
    };
    await bridge.updateConversation(conversation.conversationId, {
      name,
      workspaceId: settingsWorkspace.value,
      workspacePath: workspaceInput.value,
      permanent: settingsPermanent.checked,
      charter
    });
    await refreshConversations();
    renderHeader();
    settingsDialog.close();
    editingConversationId = null;
    setStatus(t("app.settings.saved"), "info", false, chatKey(conversation.conversationId));
  } catch (error) {
    setStatus(describeError(error), "error", false, chatKey(conversation.conversationId));
    conversationSettingsError.textContent = describeError(error);
  } finally {
    settingsSave.disabled = false;
    settingsSave.textContent = t("app.common.save");
  }
}

// ---------------------------------------------------------------------------
// Create group
// ---------------------------------------------------------------------------

function fuzzyContactMatch(value: string, query: string): boolean {
  const haystack = value.toLocaleLowerCase().replace(/\s+/g, "");
  const needle = query.toLocaleLowerCase().replace(/\s+/g, "");
  if (!needle || haystack.includes(needle)) return true;
  let cursor = 0;
  for (const character of haystack) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

function filterGroupMembers(): void {
  const query = groupMemberSearch.value.trim();
  let visible = 0;
  for (const label of groupMemberList.querySelectorAll<HTMLElement>(".member-pick")) {
    const matches = fuzzyContactMatch(label.dataset.searchText ?? "", query);
    label.hidden = !matches;
    if (matches) visible += 1;
  }
  const empty = groupMemberList.querySelector<HTMLElement>(".member-search-empty");
  if (empty) empty.hidden = visible > 0;
}

/**
 * Every real person must own or be permitted to use all Agents in the conversation.
 */
function joiningMembers(memberIds: string[], candidate: UserRef, includeSelf: boolean): UserRef[] {
  return [...new Set([...(includeSelf ? [me?.userId ?? ""] : []), ...memberIds, candidate.userId])]
    .map(id => id === candidate.userId ? candidate : users.get(id)).filter((user): user is UserRef => Boolean(user));
}

function withAgentOwners(memberIds: string[]): string[] {
  return [...new Set([...memberIds, ...memberIds.flatMap(id => {
    const agent = users.get(id);
    return agent?.isAgent && agent.owner && agent.owner !== me?.userId ? [agent.owner] : [];
  })])];
}

function canJoinTogether(memberIds: string[], candidate: UserRef, includeSelf = true): boolean {
  const members = joiningMembers(withAgentOwners([...memberIds, candidate.userId]), candidate, includeSelf);
  return members.filter(user => user.isAgent).every(agent => members.filter(user => !user.isAgent)
    .every(human => human.userId === (agent.owner ?? me?.userId) || agent.sharedWith?.includes(human.userId)));

}

/** Reason for greying out: say whose authorization is missing and who should share. When the gap isn't in this Agent itself, no specific person can be named */
function joinBlockedReason(memberIds: string[], candidate: UserRef, includeSelf = true): string {
  if (!candidate.isAgent) return t("app.friends.personBlocked");
  const owner = candidate.owner ?? me?.userId;
  const missing = joiningMembers(memberIds, candidate, includeSelf)
    .filter(user => !user.isAgent && user.userId !== owner && !candidate.sharedWith?.includes(user.userId));
  const ownerName = owner === me?.userId ? "" : users.get(owner ?? "")?.displayName;
  if (!missing.length || (owner !== me?.userId && !ownerName)) return t("app.friends.agentBlocked");
  const names = missing.map(user => user.userId === me?.userId ? t("app.friends.you") : user.displayName);
  const people = names.length > 3
    ? t("app.friends.peopleMore", { first: names[0], second: names[1], count: names.length - 2 })
    : new Intl.ListFormat(intlLocale()).format(names);
  return ownerName
    ? t("app.friends.askOwnerToShare", { owner: ownerName, agent: candidate.displayName, people })
    : t("app.friends.shareOwnAgent", { agent: candidate.displayName, people });
}

function refreshGroupSelection(): void {
  const boxes = [...groupMemberList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const selectedIds = boxes.filter(box => box.checked).map(box => box.value);
  const requiredOwners = new Set(selectedIds.flatMap(id => {
    const agent = users.get(id);
    return agent?.isAgent && agent.owner && agent.owner !== me?.userId ? [agent.owner] : [];
  }));
  for (const box of boxes) if (requiredOwners.has(box.value)) box.checked = true;
  const chosen = boxes.filter(box => box.checked).map(box => box.value);
  // Members without authorization for all Agents can't join the conversation.
  for (const box of boxes) {
    const user = users.get(box.value);
    const blocked = !box.checked && !!user && !canJoinTogether(chosen, user);
    box.disabled = blocked || requiredOwners.has(box.value);
    const row = box.closest<HTMLElement>(".member-pick");
    row?.classList.toggle("blocked", blocked);
    if (row) {
      if (blocked && user) {
        row.dataset.tooltip = joinBlockedReason(chosen, user);
        row.setAttribute("aria-disabled", "true");
      } else {
        delete row.dataset.tooltip;
        row.removeAttribute("aria-disabled");
      }
    }
  }
  const selected = boxes.filter(box => box.checked);
  if (!selected.some(box => box.value === groupLeaderId)) groupLeaderId = selected.find(box => users.get(box.value)?.isAgent)?.value;
  const selectable = boxes.filter(box => !box.disabled);
  groupSelectAll.checked = selectable.length > 0 && selected.length === selectable.length;
  groupSelectAll.indeterminate = selected.length > 0 && selected.length < selectable.length;
  for (const row of groupMemberList.querySelectorAll<HTMLElement>(".member-pick")) {
    const crown = row.querySelector<HTMLButtonElement>(".conversation-agent-leader");
    if (!crown) continue;
    const active = row.dataset.userId === groupLeaderId;
    crown.classList.toggle("active", active);
    crown.setAttribute("aria-pressed", String(active));
    crown.dataset.tooltip = active ? t("app.leader.current") : t("app.leader.set");
  }
}
groupSelectAll.addEventListener("change", () => {
  const boxes = [...groupMemberList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  // Select members meeting the shared authorization condition in display order.
  const chosen: string[] = [];
  for (const box of boxes) {
    const user = users.get(box.value);
    box.checked = groupSelectAll.checked && !!user && canJoinTogether(chosen, user);
    if (box.checked) chosen.push(box.value);
  }
  refreshGroupSelection();
});

function openGroupDialog(): void {
  groupPermanent.checked = false;
  groupLeaderId = undefined;
  groupSelectAll.checked = false;
  groupSelectAll.indeterminate = false;
  groupMemberSearch.value = "";
  // Agents first; humans aren't marked with a type. Checks are unaffected by detection refreshes.
  groupMemberList.replaceChildren();
  const pickable = [...users.values()].filter(
    (user) => contactIds.has(user.userId) && user.userId !== me?.userId
  );
  pickable.sort(compareMembers);
  for (const user of pickable) {
    const label = document.createElement("div");
    label.className = "member-pick";
    label.dataset.userId = user.userId;
    label.dataset.searchText = [
      user.displayName,
      user.username,
      user.kind,
      user.kind ? AGENT_REAL_NAMES[user.kind] : undefined
    ].filter(Boolean).join(" ");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = user.userId;
    const text = document.createElement("span");
    text.textContent = user.displayName;
    // In online mode, hovering an agent shows its computer, to tell same-named agents apart
    const computerLabel = agentComputerLabel(user);
    if (computerLabel) text.dataset.tooltip = computerLabel;
    const readiness = user.isAgent ? agentReadinessLight(user) : document.createElement("span");
    box.setAttribute("aria-label", t("app.group.selectNamed", { name: user.displayName }));
    const choice = document.createElement("label");
    choice.className = "member-pick-choice";
    choice.append(box, text);
    label.append(choice, readiness);
    box.addEventListener("change", refreshGroupSelection);
    if (user.isAgent) {
      const crown = document.createElement("button");
      crown.type = "button";
      crown.className = "conversation-agent-leader";
      crown.innerHTML = iconSvg("leader");
      crown.setAttribute("aria-label", t("app.group.makeLeaderNamed", { name: user.displayName }));
      crown.dataset.tooltip = t("app.leader.set");
      crown.addEventListener("click", () => { box.checked = true; groupLeaderId = user.userId; refreshGroupSelection(); });
      label.append(crown);
    }
    groupMemberList.append(label);
  }
  if (!groupMemberList.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "member-search-empty";
    empty.textContent = t("app.group.noCandidates");
    groupMemberList.append(empty);
  } else {
    const empty = document.createElement("div");
    empty.className = "member-search-empty";
    empty.textContent = t("app.contacts.noMatch");
    empty.hidden = true;
    groupMemberList.append(empty);
  }
  refreshGroupSelection();
  groupDialog.showModal();
}

/**
 * The dialog only picks people: after confirming it enters a draft, persisted only when the first message is sent.
 * That way no empty task is created, and there's no need to think up a task name first.
 */
function createGroup(): void {
  const memberIds = Array.from(
    groupMemberList.querySelectorAll<HTMLInputElement>("input:checked")
  ).map((box) => box.value);
  if (memberIds.length === 0) {
    setStatus(t("app.group.needMember"), "error");
    return;
  }
  groupDialog.close();
  beginConversationDraft(withAgentOwners(memberIds), groupLeaderId);
  draftPermanent = groupPermanent.checked;
}

// ---------------------------------------------------------------------------
// Knowledge page: skill library, facts, proposals awaiting decision
//
// Why this page exists: skill proposals, the shared skill library and every memory layer used to live only in the main process;
// agents were already reviewing each other and writing to the shared library, yet people couldn't see a single entry --
// "people have veto power" doesn't hold for things they can't see.
// ---------------------------------------------------------------------------

type ScopeSelection =
  | { kind: "pending" }
  | { kind: "user" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "global" };

type AppTab = "contacts" | "conversations" | "knowledge" | "agents";

let activeTab: AppTab = "conversations";
let agentCatalog: AgentStatus[] = [];
let stableReadyAgentCount = Math.max(
  0,
  Number.parseInt(localStorage.getItem("ading.ready-agent-count") ?? "0", 10) || 0
);
/** The ones currently being checked, used to turn the button into "Checking…" */
const verifying = new Set<AgentKind>();
/** Count of full detection rounds in progress (at startup, manual refresh); together with per-agent verifying it decides whether the refresh button spins */
let agentCheckRuns = 0;
/** Agents being installed or signed in, and the specific action being done right now. */
const lifecycleBusy = new Map<AgentKind, "install" | "login">();
/** Keep each installation's latest progress across panel close/reopen. */
const agentInstallProgress = new Map<AgentKind, string>();
/** Keep only the code required for device authorization, never CLI logs. */
const agentLoginCodes = new Map<AgentKind, string>();
/** The vendor sign-in page found in login output; only official hosts are kept. */
const agentLoginLinks = new Map<AgentKind, string>();
/**
 * Official sign-in hosts (and their subdomains) per Agent. Login output is
 * untrusted text, so any other link stays hidden instead of becoming clickable.
 */
const AGENT_LOGIN_HOSTS: Partial<Record<AgentKind, readonly string[]>> = {
  kiro: ["awsapps.com", "kiro.dev"],
  copilot: ["github.com"],
  codex: ["auth.openai.com"],
  "claude-code": ["claude.ai", "claude.com", "anthropic.com"],
  qoder: ["qoder.com"],
  "qoder-cn": ["qoder.cn"]
};

function agentLoginLink(kind: AgentKind, text: string): string | undefined {
  const hosts = AGENT_LOGIN_HOSTS[kind] ?? [];
  for (const raw of text.match(/https:\/\/[^\s"'<>\x00-\x1f\x7f]+/g) ?? []) {
    try {
      const url = new URL(raw.replace(/[).,;:!?]+$/, ""));
      if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
          hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return url.href;
    } catch { /* Not a usable link. */ }
  }
  return undefined;
}

function forgetAgentLogin(kind: AgentKind): void {
  agentLoginCodes.delete(kind);
  agentLoginLinks.delete(kind);
}
const agentDownloads = new Map<AgentKind, AgentDownloadProgress>();
/** Startup detection runs only one round; during runtime the next round is triggered only by the user clicking refresh. */
let startupAgentCheck: Promise<void> | null = null;
let activeScope: ScopeSelection = { kind: "pending" };
let pendingProposals: SkillProposal[] = [];

function scopeKeyOf(scope: ScopeSelection): string {
  return scope.kind === "workspace" ? `workspace:${scope.workspaceId}` : scope.kind;
}

function switchTab(tab: AppTab): void {
  if (tab !== "conversations") temporaryUnreadConversationId = undefined;
  if (
    activeTab !== "agents" &&
    tab !== "agents" &&
    tab !== activeTab &&
    (draftContactId || draftMemberIds?.length)
  ) {
    selectedId =
      draftReturnConversationId ??
      conversations.find((conversation) => conversation.status === "ACTIVE")?.conversationId ??
      null;
    draftContactId = null;
    draftMemberIds = null;
    draftPermanent = false;
    draftWorkspaceId = undefined;
    draftReturnConversationId = null;
  }
  activeTab = tab;
  processAgentFilterId = null;
  applyChatSidebarLayout();
  const baseTab = tab === "agents" ? tabBeforeAgents : tab;
  if (baseTab === "conversations") ensureDefaultConversationDraft();
  tabContacts.classList.toggle("active", baseTab === "contacts");
  tabConversations.classList.toggle("active", baseTab === "conversations");
  tabKnowledge.classList.toggle("active", baseTab === "knowledge");
  agentsEntry.classList.toggle("active", tab === "agents");
  const showChat = baseTab === "contacts" || baseTab === "conversations";
  chatSidebar.hidden = !showChat;
  chatPane.hidden = !showChat;
  newGroupButton.hidden = baseTab !== "conversations";
  knowledgeSidebar.hidden = baseTab !== "knowledge";
  knowledgePane.hidden = baseTab !== "knowledge";
  agentPane.hidden = tab !== "agents";
  if (baseTab === "contacts" && selectedId) {
    const selected = conversationById(selectedId);
    const contact = selected ? counterpart(selected) : undefined;
    if (contact) selectedContactId = contact.userId;
  }
  conversationSwitcherMenu.hidden = true;
  if (showChat) {
    renderConversationList();
    renderHeader();
    renderMessages();
    syncComposer();
    if(bootReady)void refreshVisibleConversation();
  }
  if (baseTab === "knowledge") void refreshKnowledge();
  if (tab === "agents") {
    void (startupAgentCheck ?? refreshAgents());
  }
}

/** The count awaiting decision hangs on the rail -- people know something is waiting for them without entering this page */
async function refreshPendingBadge(): Promise<void> {
  try {
    pendingProposals = await bridge.listProposals(["needs_human"]);
  } catch {
    pendingProposals = [];
  }
  knowledgeBadge.hidden = pendingProposals.length === 0;
  knowledgeBadge.textContent =
    pendingProposals.length > 99 ? "99+" : String(pendingProposals.length);
}

async function refreshKnowledge(): Promise<void> {
  if(knowledgeSyncFailures.length)setKnowledgeStatus(knowledgeSyncDetails(knowledgeSyncFailures),"error");
  await refreshPendingBadge();
  renderScopeList();
  await renderKnowledgeBody();
}

function scopeRow(
  label: string,
  meta: string,
  scope: ScopeSelection,
  dot = false
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "contact-button";
  if (scopeKeyOf(scope) === scopeKeyOf(activeScope)) button.classList.add("active");

  const summary = document.createElement("span");
  const nameEl = document.createElement("span");
  const metaEl = document.createElement("span");
  nameEl.className = "contact-name";
  nameEl.textContent = label;
  metaEl.className = "contact-meta";
  metaEl.textContent = meta;
  summary.className = "contact-summary";
  summary.append(nameEl, metaEl);
  button.append(summary);

  if (dot) {
    const badge = document.createElement("span");
    badge.className = "unread";
    badge.textContent = String(pendingProposals.length);
    button.append(badge);
  }

  button.addEventListener("click", () => {
    activeScope = scope;
    renderScopeList();
    void renderKnowledgeBody();
  });
  return button;
}

function renderScopeList(): void {
  scopeList.replaceChildren();

  scopeList.append(
    scopeRow(
      t("app.knowledge.pending"),
      pendingProposals.length === 0
        ? t("app.knowledge.pendingNone")
        : pendingProposals.length === 1
          ? t("app.knowledge.pendingOne")
          : t("app.knowledge.pendingMany", { count: pendingProposals.length }),
      { kind: "pending" },
      pendingProposals.length > 0
    )
  );

  const personal = document.createElement("div");
  personal.className = "k-section-title";
  personal.style.padding = "12px 11px 2px";
  personal.textContent = t("app.knowledge.personal");
  scopeList.append(personal);
  scopeList.append(
    scopeRow(t("app.knowledge.aboutMe"), t("app.knowledge.aboutMeHint"), { kind: "user" })
  );

  const folders = workspaces.filter((w) => w.kind === "folder");
  if (folders.length) {
    const title = document.createElement("div");
    title.className = "k-section-title";
    title.style.padding = "12px 11px 2px";
    title.textContent = t("app.knowledge.workspaces");
    scopeList.append(title);
    for (const workspace of folders) {
      scopeList.append(
        scopeRow(workspace.name, shortPath(workspace.path ?? ""), {
          kind: "workspace",
          workspaceId: workspace.workspaceId
        })
      );
    }
  }

  const globalTitle = document.createElement("div");
  globalTitle.className = "k-section-title";
  globalTitle.style.padding = "12px 11px 2px";
  globalTitle.textContent = t("app.knowledge.global");
  scopeList.append(globalTitle);
  scopeList.append(
    scopeRow(t("app.knowledge.globalSkills"), t("app.knowledge.globalSkillsHint"), { kind: "global" })
  );
}

function card(className = ""): HTMLElement {
  const box = document.createElement("div");
  box.className = `k-card ${className}`.trim();
  return box;
}

function emptyNote(text: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "k-empty";
  box.textContent = text;
  return box;
}

/** A proposal awaiting decision: given together with the reviewers' original words at the time, otherwise people can't judge */
function proposalCard(proposal: SkillProposal): HTMLElement {
  const box = card("pending");

  const head = document.createElement("div");
  head.className = "k-head";
  const left = document.createElement("div");
  const name = document.createElement("div");
  name.className = "k-name";
  name.textContent = proposal.name;
  const when = document.createElement("div");
  when.className = "k-when";
  const from = conversationById(proposal.conversationId);
  when.textContent =
    t("app.proposal.meta", { description: proposal.description, name: userName(proposal.proposerUserId) }) +
    (from ? t("app.proposal.from", { conversation: conversationName(from) }) : "");
  left.append(name, when);
  const pill = document.createElement("span");
  pill.className = "k-pill wait";
  pill.textContent = proposal.kind === "update" ? t("app.proposal.pendingUpdate") : t("app.knowledge.pending");
  head.append(left, pill);

  const body = document.createElement("div");
  body.className = "k-body";
  body.textContent = proposal.content;

  box.append(head, body);

  if (proposal.reviews.length || proposal.blockedReason) {
    const reviews = document.createElement("div");
    reviews.className = "k-reviews";
    const title = document.createElement("h4");
    title.textContent = t("app.proposal.reviews");
    reviews.append(title);

    if (proposal.blockedReason && !proposal.reviews.length) {
      const note = document.createElement("div");
      note.className = "k-quote";
      note.textContent = proposal.blockedReason;
      reviews.append(note);
    }

    for (const review of proposal.reviews) {
      const quote = document.createElement("div");
      quote.className = review.verdict === "pass" ? "k-quote pass" : "k-quote";
      const who = document.createElement("b");
      who.textContent = t("app.proposal.reviewLine", {
        name: userName(review.reviewerUserId),
        verdict: review.verdict === "pass"
          ? t("app.proposal.pass")
          : review.verdict === "blocked"
            ? t("app.proposal.blocked")
            : t("app.proposal.unreadable")
      });
      quote.append(who, document.createElement("br"));
      quote.append(
        document.createTextNode(
          review.problems.length ? review.problems.join("\n") : review.raw
        )
      );
      if (review.suggestion) {
        quote.append(
          document.createElement("br"),
          document.createTextNode(t("app.proposal.suggestion", { text: review.suggestion }))
        );
      }
      reviews.append(quote);
    }
    box.append(reviews);
  }

  const actions = document.createElement("div");
  actions.className = "k-actions";

  const accept = document.createElement("button");
  accept.className = "primary";
  accept.textContent = t("app.proposal.accept");
  accept.addEventListener("click", () => void resolve(proposal, true));

  const reject = document.createElement("button");
  reject.className = "danger";
  reject.textContent = t("app.proposal.reject");
  reject.addEventListener("click", () => void resolve(proposal, false));

  actions.append(accept, reject);

  if (from) {
    const goto = document.createElement("button");
    goto.textContent = t("app.proposal.gotoChat");
    goto.addEventListener("click", () => {
      switchTab("conversations");
      void selectConversation(proposal.conversationId);
    });
    actions.append(goto);
  }

  box.append(actions);
  return box;
}

function knowledgePrompt(title:string,value="",multiline=true):Promise<string|null> {
  return new Promise(resolve=>{
    const dialog=document.createElement("dialog");dialog.className="contact-detail-dialog knowledge-editor-dialog";
    const card=document.createElement("form");card.className="contact-detail-card";card.method="dialog";
    const heading=document.createElement("h2");heading.textContent=title;
    const field=document.createElement("textarea");field.id="knowledge-editor-text";field.value=value;field.rows=multiline?10:2;field.setAttribute("aria-label",title);
    const actions=document.createElement("div");actions.className="contact-detail-actions";
    const cancel=document.createElement("button");cancel.type="button";cancel.textContent=t("html.common.cancel");
    const save=document.createElement("button");save.type="submit";save.textContent=t("html.common.save");save.className="primary";
    const finish=(result:string|null)=>{dialog.close();dialog.remove();resolve(result);};
    cancel.addEventListener("click",()=>finish(null));card.addEventListener("submit",event=>{event.preventDefault();finish(field.value);});
    dialog.addEventListener("cancel",event=>{event.preventDefault();finish(null);});
    dialog.addEventListener("click",event=>{if(event.target===dialog)finish(null);});
    actions.append(cancel,save);card.append(heading,field,actions);dialog.append(card);document.body.append(dialog);dialog.showModal();field.focus();
  });
}
function setKnowledgeStatus(text:string,tone:"info"|"error"="info"):void {
  knowledgeSyncNotice.hidden=!text;
  knowledgeSyncText.textContent=text;
  knowledgeSyncText.scrollTop=0;
  knowledgeSyncNotice.classList.toggle("error",tone==="error");
}

function skillCard(skill: Skill): HTMLElement {
  const box = card();
  const head = document.createElement("div");
  head.className = "k-head";
  const left = document.createElement("div");
  const name = document.createElement("div");
  name.className = "k-name";
  name.textContent = skill.name;
  const when = document.createElement("div");
  when.className = "k-when";
  when.textContent =
    t("app.skill.meta", { description: skill.description, count: skill.useCount }) +
    (skill.authorKind === "human" ? t("app.skill.humanOnly") : t("app.skill.autoUpdate"));
  left.append(name, when);
  const pill = document.createElement("span");
  pill.className = skill.authorKind === "human" ? "k-pill human" : "k-pill auto";
  pill.textContent = skill.authorKind === "human" ? t("app.skill.mine") : t("app.skill.auto");
  head.append(left, pill);

  const body = document.createElement("div");
  body.className = "k-body";
  body.textContent = skill.content;

  const actions = document.createElement("div");
  actions.className = "k-actions";
  const edit=document.createElement("button");edit.textContent=t("app.knowledge.edit");
  edit.addEventListener("click",async()=>{
    const name=await knowledgePrompt(t("app.knowledge.skillName"),skill.name,false);if(!name?.trim())return;
    const description=await knowledgePrompt(t("app.knowledge.skillDescription"),skill.description,false);if(description===null)return;
    const content=await knowledgePrompt(t("app.knowledge.skillContent"),skill.content);if(!content?.trim())return;
    void bridge.updateSkill(skill.skillId,{name:name.trim(),description:description.trim(),content:content.trim()}).then(()=>renderKnowledgeBody()).catch(error=>setKnowledgeStatus(describeError(error),"error"));
  });
  actions.append(edit);
  for(const sourceKind of ["zip","directory"] as const) {
    const replace=document.createElement("button");replace.textContent=t(sourceKind==="zip" ? "app.knowledge.replaceZip" : "app.knowledge.replaceDirectory");
    replace.addEventListener("click",()=>{void bridge.importSkill({scope:skill.scope,ownerId:skill.ownerId,sourceKind,skillId:skill.skillId}).then(()=>renderKnowledgeBody()).catch(error=>setKnowledgeStatus(describeError(error),"error"));});
    actions.append(replace);
  }
  const remove = document.createElement("button");
  remove.className = "danger";
  remove.textContent = t("app.common.delete");
  remove.addEventListener("click", () => {
    void bridge
      .deleteSkill(skill.skillId)
      .then(() => renderKnowledgeBody())
      .catch((error: unknown) => setKnowledgeStatus(describeError(error), "error"));
  });
  actions.append(remove);

  box.append(head, body, actions);
  return box;
}

function memoryCard(entry: MemoryEntry): HTMLElement {
  const box = card();
  const head = document.createElement("div");
  head.className = "k-head";
  const left = document.createElement("div");
  const body = document.createElement("div");
  body.className = "k-body";
  body.style.marginTop = "0";
  body.textContent = entry.content;
  const when = document.createElement("div");
  when.className = "k-when";
  when.textContent =
    entry.authorKind === "human"
      ? t("app.memory.mine", { time: formatTime(entry.createdAt) })
      : t("app.memory.byAgent", { name: userName(entry.authorUserId ?? ""), time: formatTime(entry.createdAt) });
  left.append(body, when);
  head.append(left);

  const actions = document.createElement("div");
  actions.className = "k-actions";
  const edit=document.createElement("button");edit.textContent=t("app.knowledge.edit");
  edit.addEventListener("click",async()=>{
    const content=await knowledgePrompt(entry.scope==="user" ? t("app.knowledge.promptUser") : t("app.knowledge.promptWorkspace"),entry.content);
    if(!content?.trim())return;
    void bridge.updateMemory(entry.memoryId,{content:content.trim()}).then(()=>renderKnowledgeBody()).catch(error=>setKnowledgeStatus(describeError(error),"error"));
  });
  actions.append(edit);
  const remove = document.createElement("button");
  remove.className = "danger";
  remove.textContent = t("app.memory.remove");
  remove.addEventListener("click", () => {
    void bridge
      .deleteMemory(entry.memoryId)
      .then(() => renderKnowledgeBody())
      .catch((error: unknown) => setKnowledgeStatus(describeError(error), "error"));
  });
  actions.append(remove);

  box.append(head, actions);
  return box;
}

async function resolve(proposal: SkillProposal, accept: boolean): Promise<void> {
  try {
    await bridge.resolveProposal(proposal.proposalId, accept);
    setKnowledgeStatus(accept ? t("app.proposal.accepted", { name: proposal.name }) : t("app.proposal.rejected"));
    await refreshKnowledge();
  } catch (error) {
    setKnowledgeStatus(describeError(error), "error");
  }
}

async function renderKnowledgeBody(): Promise<void> {
  knowledgeBody.replaceChildren();
  knowledgeAdd.hidden = true;
  const skillScope=activeScope.kind==="global"||activeScope.kind==="workspace";
  knowledgeCreateSkill.hidden=!skillScope;
  knowledgeImportZip.hidden=!skillScope;
  knowledgeImportDirectory.hidden=!skillScope;

  if (activeScope.kind === "pending") {
    knowledgeTitle.textContent = t("app.knowledge.pending");
    knowledgeMeta.textContent =
      t("app.knowledge.pendingMeta");
    if (!pendingProposals.length) {
      knowledgeBody.append(
        emptyNote(t("app.knowledge.pendingEmpty"))
      );
      return;
    }
    for (const proposal of pendingProposals) {
      knowledgeBody.append(proposalCard(proposal));
    }
    return;
  }

  if (activeScope.kind === "user") {
    knowledgeTitle.textContent = t("app.knowledge.aboutMe");
    knowledgeMeta.textContent =
      t("app.knowledge.aboutMeMeta");
    knowledgeAdd.hidden = false;
    const entries = me ? await bridge.listMemories("user", me.userId, 200) : [];
    if (!entries.length) {
      knowledgeBody.append(
        emptyNote(t("app.knowledge.aboutMeEmpty"))
      );
      return;
    }
    for (const entry of entries) knowledgeBody.append(memoryCard(entry));
    return;
  }

  if (activeScope.kind === "global") {
    knowledgeTitle.textContent = t("app.knowledge.globalSkills");
    knowledgeMeta.textContent =
      t("app.knowledge.globalMeta");
    const skills = await bridge.listSkills([{ scope: "global" }]);
    if (!skills.length) {
      knowledgeBody.append(emptyNote(t("app.knowledge.globalEmpty")));
      return;
    }
    for (const skill of skills) knowledgeBody.append(skillCard(skill));
    return;
  }

  const workspace = workspaceById(activeScope.workspaceId);
  knowledgeTitle.textContent = workspace?.name ?? t("app.knowledge.workspaceFallback");
  knowledgeMeta.textContent = workspace?.path ?? "";
  knowledgeAdd.hidden = false;

  const skills = await bridge.listSkills([
    { scope: "workspace", ownerId: activeScope.workspaceId }
  ]);
  const facts = await bridge.listMemories(
    "workspace",
    activeScope.workspaceId,
    200
  );

  if (!skills.length && !facts.length) {
    knowledgeBody.append(
      emptyNote(t("app.knowledge.workspaceEmpty"))
    );
    return;
  }

  if (skills.length) {
    const title = document.createElement("div");
    title.className = "k-section-title";
    title.textContent = t("app.knowledge.skillsTitle", { count: skills.length });
    knowledgeBody.append(title);
    for (const skill of skills) knowledgeBody.append(skillCard(skill));
  }
  if (facts.length) {
    const title = document.createElement("div");
    title.className = "k-section-title";
    title.textContent = t("app.knowledge.factsTitle", { count: facts.length });
    knowledgeBody.append(title);
    for (const entry of facts) knowledgeBody.append(memoryCard(entry));
  }
}

// ---------------------------------------------------------------------------
// Agent onboarding page
//
// The skeleton is "which vendors we support", unrelated to what's installed locally -- installation only decides the light's color.
// The old design was "search what's installed locally"; when the search came up empty, people had no idea what to do.
// ---------------------------------------------------------------------------

const AGENT_TINT: Record<AgentKind, string> = {
  codex: "#202b3d",
  "claude-code": "#d97757",
  qoder: "#6b5bd2",
  "qoder-cn": "#111827",
  "qwen-code": "#615ced",
  kiro: "#9046ff", copilot: "#24292f", antigravity: "#4285f4"
};

function agentInitials(label: string): string {
  const compact = label.replace(/[^A-Za-z]/g, "");
  return (compact.slice(0, 2) || label.slice(0, 1)).toUpperCase();
}

/**
 * An agent's current state.
 *
 * Local ones take the local detection result by type. Those on other computers use the state published by that computer and synced over,
 * fitted into the same structure, so the downstream lights and text all follow the same local rules -- cross-computer only adds a sync layer; the judgement is unchanged.
 * It can no longer be taken by type alone: the local codex being ready doesn't mean the codex on another computer is ready.
 */
function agentStatusOf(agent: UserRef): AgentStatus | undefined {
  const local = agent.kind ? agentCatalog.find((candidate) => candidate.kind === agent.kind) : undefined;
  if (!agent.remote) return local;
  if (!local) return undefined;
  return {
    ...local,
    installed: true,
    readiness: agent.remote.readiness,
    // The following are all local detection details and don't belong to that computer
    version: agent.version,
    executablePath: undefined,
    detail: undefined,
    recovery: undefined,
    setupNotice: undefined,
    cliMissing: undefined,
    userId: agent.userId,
    added: agent.enabled !== false
  };
}

/** Green light: same rule as local. Ones on other computers also need that computer to be online */
function agentAvailable(agent: UserRef): boolean {
  if (agent.remote && !agent.remote.online) return false;
  return agentStatusOf(agent)?.readiness === "ready";
}

/** The light and the word beside it. When another computer is offline, its agents all get a red light, handled the same as local red-light agents */
function agentSignal(agent: UserRef): { text: string; tone: string; lamp: string } {
  if (agent.remote && !agent.remote.online) return { text: t("app.agent.computerOffline"), tone: "bad", lamp: "r" };
  const status = agentStatusOf(agent);
  return status ? signalOf(status) : { text: t("app.agent.checking"), tone: "", lamp: "o" };
}

/**
 * An agent just added as a contact has the same name as an existing contact (usually the same type on another computer): ask whether to rename.
 * Whether to rename is up to the person; without renaming they can still be told apart by the hover computer. Ask only once at the moment of "adding", without repeated nagging.
 * Only ask in online mode: the standalone edition has no other computers, so keep the original behavior.
 */
function offerRenameIfDuplicate(kind: AgentKind): void {
  const added = [...users.values()].find((user) => user.isAgent && !user.remote && user.kind === kind && contactIds.has(user.userId));
  if (!added) return;
  const name = added.displayName.trim();
  const twin = [...users.values()].find((user) =>
    user.isAgent && user.userId !== added.userId && contactIds.has(user.userId) && user.displayName.trim() === name);
  const computer = twin && agentComputerLabel(twin);
  if (!twin || !computer) return;
  duplicateNameTarget = added;
  duplicateNameCopy.textContent = t("app.agent.duplicateCopy", { name, computer });
  duplicateNameDialog.showModal();
}

/** The word beside the light. It states the status only, no explanation -- the explanation goes in title and appears only on hover */
function signalOf(status: AgentStatus): { text: string; tone: string; lamp: string } {
  if(status.recovery&&status.readiness!=='ready')return {text:status.recovery.statusText,tone:'bad',lamp:'r'};
  switch (status.readiness) {
    case "ready":
      return { text: "", tone: "good", lamp: "g" };
    case "missing":
      return {
        text: status.setupNotice ? t("app.agent.notConnected") : status.cliMissing ? t("app.agent.cliMissing") : t("app.agent.notInstalled"),
        tone: "bad",
        lamp: "r"
      };
    case "unauthorized":
      return { text: t("app.agent.signedOut"), tone: "bad", lamp: "r" };
    case "exhausted":
      return { text: t("app.agent.exhausted"), tone: "bad", lamp: "r" };
    case "error":
      if (/\b403\b|forbidden|not\s+authorized\s+to\s+use|(?:access|permission|policy)\s+denied|insufficient[_\s-]+scopes?/i.test(status.detail ?? "")) {
        return { text: t("app.agent.accessRestricted"), tone: "bad", lamp: "r" };
      }
      if (/404|network|ECONN|ENOTFOUND|timeout|overloaded|服务/i.test(status.detail ?? "")) {
        return { text: t("app.agent.serviceError"), tone: "bad", lamp: "r" };
      }
      return { text: t("app.agent.stateError"), tone: "bad", lamp: "r" };
    default:
      // CLI found but no verdict yet: refreshing the directory immediately checks it individually, so truthfully say "Checking" here
      return { text: t("app.agent.checking"), tone: "", lamp: "o" };
  }
}

/** Transient checking/installing/signing-in states take precedence over the last persisted detection result. */
function activeAgentStatusText(status: AgentStatus): string {
  if (verifying.has(status.kind)) return t("app.agent.checking");
  if (lifecycleBusy.has(status.kind)) {
    return lifecycleBusy.get(status.kind) === "install" ? t("app.agent.installing") : t("app.agent.signingIn");
  }
  return signalOf(status).text;
}

function appendAgentFailureDetail(parent: HTMLElement, status: AgentStatus): void {
  if (verifying.has(status.kind) || lifecycleBusy.has(status.kind)
    || !["error", "exhausted", "unauthorized"].includes(status.readiness) || !status.detail?.trim()) return;
  const detail = document.createElement("span");
  detail.className = "agent-failure-detail";
  detail.textContent = status.detail;
  parent.append(detail);
}

/**
 * Diagnostic evidence takes no layout space; it hangs on title.
 * One row per agent is a hard constraint, but a red light without a reason says nothing -- the compromise is making it visible on hover.
 */
function agentTooltip(status: AgentStatus): string {
  return [
    status.setupNotice?.message,
    status.cliMissing && !status.installed
      ? t("app.agent.cliMissingTip", { label: status.label })
      : undefined,
    status.executablePath,
    status.version,
    status.detail
  ]
    .filter((item): item is string => Boolean(item))
    .filter((item, index, all) => all.indexOf(item) === index)
    .join("\n");
}


function setAgentButtonIcon(
  button: HTMLButtonElement,
  label: string,
  icon: IconName
): void {
  button.classList.add("icon-only");
  button.dataset.tooltip = label;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = iconSvg(icon);
}

/** The single most important action for this row right now. Returns null when no action is needed */
function agentAction(status: AgentStatus): HTMLButtonElement | null {
  const make = (
    label: string,
    icon: IconName,
    onClick: () => void,
    tone: "pri" | "gh" = "pri"
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-btn ${tone}`;
    setAgentButtonIcon(button, label, icon);
    button.disabled = lifecycleBusy.has(status.kind) || verifying.has(status.kind);
    button.addEventListener("click", onClick);
    return button;
  };

  if(lifecycleBusy.get(status.kind)==='login'){
    const cancel=make(t("app.agent.cancelLogin"),'close',()=>{
      cancel.disabled=true;
      void bridge.cancelAgentLifecycle(status.kind,'login').catch(error=>setAgentStatus(describeError(error),'error'));
    },'gh');
    cancel.disabled=false;
    return cancel;
  }

  if (status.setupNotice) {
    const button = make(
      status.setupNotice.actionLabel,
      /^(打开|open)/i.test(status.setupNotice.actionLabel) ? "open" : "connect",
      () => {
      button.disabled = true;
      void bridge
        .enableAgentSetup(status.kind)
        .then((result) => {
          setAgentStatus(result.message, result.ok ? "info" : "error");
          return refreshAgents();
        })
        .catch((error: unknown) => setAgentStatus(describeError(error), "error"))
        .finally(() => {
          button.disabled = false;
        });
      }
    );
    return button;
  }

  // Installation progress belongs to its Agent row, including concurrent downloads.
  if (!status.installed) {
    return make(status.cliMissing ? t("app.agent.installCli") : t("app.agent.install"), "install", () => {
      lifecycleBusy.set(status.kind, "install");
      agentInstallProgress.set(status.kind, t("app.agent.preparingInstall"));
      renderAgents();
      void bridge
        .installAgent(status.kind, true)
        .then(async (result) => {
          // End "Installing" first, so refreshAgents goes on to check this vendor (busy ones are skipped)
          lifecycleBusy.delete(status.kind);
          agentInstallProgress.delete(status.kind);
          agentDownloads.delete(status.kind);
          if (!result.ok) {
            setAgentStatus(result.message, "error");
            await refreshAgents();
            return;
          }
          await refreshAgents();
          const checked = agentCatalog.find((candidate) => candidate.kind === status.kind);
          const ready = checked?.readiness === "ready";
          setAgentStatus(
            ready ? t("app.agent.connected", { label: status.label })
              : checked?.detail
                ? t("app.agent.cliInstalledStateDetail", { label: status.label, state: checked ? signalOf(checked).text : t("app.agent.checkIncomplete"), detail: checked.detail })
                : t("app.agent.cliInstalledState", { label: status.label, state: checked ? signalOf(checked).text : t("app.agent.checkIncomplete") }),
            ready ? "info" : "error"
          );
        })
        .catch((error: unknown) => setAgentStatus(describeError(error), "error"))
        .finally(() => {
          lifecycleBusy.delete(status.kind);
          agentInstallProgress.delete(status.kind);
          agentDownloads.delete(status.kind);
          renderAgents();
        });
    });
  }
  if (status.readiness === "unauthorized" || status.recovery?.action === "login") {
    return make(status.recovery?.label ?? t("app.agent.login"), "login", () => {
      lifecycleBusy.set(status.kind, "login");
      forgetAgentLogin(status.kind);
      renderAgents();
      void bridge
        .loginAgent(status.kind, true)
        .then(async (result) => {
          const ready=result.verification?.readiness==='ready';
          forgetAgentLogin(status.kind);
          setAgentStatus(
            result.ok ? ready ? t("app.agent.connected", { label: status.label }) :
              t("app.agent.loginDone", { detail: result.verification?.detail ?? t("app.agent.loginVerifyFailed") }) : result.message,
            // Interactive-only sign-in (Antigravity, Qwen) returns guidance, not a failure.
            ready || result.awaitingUserAction || result.unsupported ? "info" : "error"
          );
          await refreshAgents();
        })
        .catch((error: unknown) => {
          const text = describeError(error);
          setAgentStatus(text, "error");
        })
        .finally(() => {
          lifecycleBusy.delete(status.kind);
          forgetAgentLogin(status.kind);
          renderAgents();
        });
    });
  }
  return null;
}

const agentDataDialog = el<HTMLDialogElement>("#agent-data-dialog");
const agentDataAgree = el<HTMLButtonElement>("#agent-data-agree");
const agentDataCancel = el<HTMLButtonElement>("#agent-data-cancel");
const agentDataError = el<HTMLElement>("#agent-data-error");
let agentDataAccepted = false;
let agentDataConsentKey: string | null = null;

function agentDataStorageKey(): string {
  const scope = accountStatus.signedIn ? `account:${accountStatus.user.userId}` : "local";
  return `ading.agent-message-sharing-consent:${scope}`;
}

function showAgentDataDetails(status?: AgentStatus): Promise<boolean> {
  if (agentDataDialog.open) return Promise.resolve(false);
  const consentKey = status ? agentDataStorageKey() : null;
  if (consentKey) {
    try {
      if (localStorage.getItem(consentKey) === "agreed") return Promise.resolve(true);
    } catch {
      // When the authorization record can't be read, explicit consent is still required.
    }
  }
  agentDataConsentKey = consentKey;
  el<HTMLElement>("#agent-data-dialog-title").textContent = t("html.agent.dataTitle");
  agentDataAgree.hidden = !status;
  agentDataAgree.disabled = false;
  agentDataCancel.textContent = status ? t("html.agent.dataDecline") : t("html.common.close");
  agentDataError.hidden = true;
  agentDataAccepted = false;
  const result = new Promise<boolean>(resolve => {
    agentDataDialog.addEventListener("close", () => resolve(!!status && agentDataAccepted), { once: true });
  });
  agentDataDialog.showModal();
  agentDataCancel.focus();
  return result;
}

el<HTMLButtonElement>("#agent-data-details").addEventListener("click", () => void showAgentDataDetails());
el<HTMLButtonElement>("#agent-data-close").addEventListener("click", () => agentDataDialog.close());
agentDataCancel.addEventListener("click", () => agentDataDialog.close());
agentDataDialog.addEventListener("cancel", () => { agentDataAccepted = false; });
agentDataAgree.addEventListener("click", () => {
  if (!agentDataConsentKey) return;
  try {
    localStorage.setItem(agentDataConsentKey, "agreed");
  } catch (error) {
    agentDataError.textContent = describeError(error);
    agentDataError.hidden = false;
    return;
  }
  agentDataAccepted = true;
  agentDataAgree.disabled = true;
  agentDataDialog.close("agree");
});
el<HTMLButtonElement>("#agent-data-privacy").addEventListener("click", () => {
  void bridge.openExternal(`https://www.coffeestudy.com.cn/ading/privacy.html#${currentLanguage() === "en" ? "en" : "zh"}`)
    .catch((error: unknown) => { agentDataError.textContent = describeError(error); agentDataError.hidden = false; });
});

/** Add/remove contacts. Removing only takes it off contacts; its conversations and records are untouched */
function agentContactButton(status: AgentStatus): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";

  if (status.added) {
    button.className = "agent-btn gh danger";
    setAgentButtonIcon(button, t("app.agent.removeContact"), "remove");
    button.addEventListener("click", () => {
      button.disabled = true;
      void bridge
        .setAgentAdded(status.kind, false)
        .then((list) => {
          agentCatalog = localizedCatalog(list);
          renderAgents();
          return refreshConversations().then(() => {
            setAgentStatus(t("app.agent.removedContact", { label: status.label }));
          });
        })
        .catch((error: unknown) => {
          setAgentStatus(describeError(error), "error");
          button.disabled = false;
        });
    });
    return button;
  }

  button.className = status.readiness === "ready" ? "agent-btn pri" : "agent-btn gh";
  setAgentButtonIcon(button, t("app.agent.addContact"), "add");
  button.disabled = !status.installed;
  button.addEventListener("click", async () => {
    button.disabled = true;
    if (!await showAgentDataDetails(status)) {
      button.disabled = !status.installed;
      return;
    }
    void bridge
      .setAgentAdded(status.kind, true)
      .then((list) => {
        agentCatalog = localizedCatalog(list);
        renderAgents();
        return refreshConversations().then(() => {
          setAgentStatus(t("app.agent.addedContact", { label: status.label }));
          offerRenameIfDuplicate(status.kind);
        });
      })
      .catch((error: unknown) => {
        setAgentStatus(describeError(error), "error");
        button.disabled = false;
      });
  });
  return button;
}

function agentRow(status: AgentStatus): HTMLElement {
  const row = document.createElement("div");
  row.className = "agent-row";
  row.dataset.agentKind = status.kind;
  const installing = lifecycleBusy.get(status.kind) === "install";
  const loggingIn = lifecycleBusy.get(status.kind) === "login";
  if (status.readiness === "ready" && !loggingIn) forgetAgentLogin(status.kind);
  if (status.readiness === "ready") row.classList.add("ready");
  if (verifying.has(status.kind) || lifecycleBusy.has(status.kind)) {
    row.classList.add("busy");
  }
  const avatar = document.createElement("button");
  avatar.type = "button";
  avatar.className = "agent-ava";
  avatar.classList.add("image-avatar");
  const contact = [...users.values()].find(
    (candidate) => candidate.isAgent && !candidate.remote && candidate.kind === status.kind
  );
  const avatarSource = contact?.avatarUrl || AGENT_CONTACT_ICONS[status.kind];
  const image = document.createElement("img");
  image.src = avatarSource;
  // The name is written right of the icon; alt would be popped as bubble text by the tooltip layer, purely redundant
  image.alt = "";
  avatar.setAttribute("aria-label", t("app.agent.viewAvatar"));
  avatar.setAttribute("aria-label", t("app.agent.viewAvatarNamed", { name: status.displayName ?? status.label }));
  avatar.addEventListener("click", () => openAvatarPreview(avatarSource));
  avatar.append(image);

  const identity = document.createElement("span");
  identity.className = "agent-id";
  const nameLine = document.createElement("span");
  nameLine.className = "agent-name-line";
  const alias = document.createElement("span");
  alias.className = "agent-alias";
  // Nicknames only exist after being added as a contact; ones not added use the product name as a placeholder
  alias.textContent = status.displayName ?? status.label;

  const signal = document.createElement("span");
  const described = installing || loggingIn ? { tone: "installing", lamp: "o" } : signalOf(status);
  signal.className = `agent-signal ${described.tone}`.trim();
  const lamp = document.createElement("span");
  lamp.className = `agent-lamp ${described.lamp}`;
  signal.append(
    lamp,
    document.createTextNode(activeAgentStatusText(status))
  );
  nameLine.append(alias, signal);

  const username = document.createElement("span");
  username.className = "agent-user";
  username.textContent = status.kind;
  const meta = document.createElement("span");
  meta.className = "agent-meta";
  const login = document.createElement("span");
  login.className = "agent-login";
  const loginCode = document.createElement("span");
  loginCode.className = "agent-login-code";
  const loginLink = document.createElement("button");
  loginLink.type = "button";
  loginLink.className = "agent-login-link";
  loginLink.textContent = t("app.agent.openLoginPage");
  // The button text doesn't include the domain, so the tooltip must show which site will open before clicking
  loginLink.setAttribute("data-tooltip-always", "");
  loginLink.addEventListener("click", () => {
    const url = agentLoginLinks.get(status.kind);
    if (url) void bridge.openExternal(url).catch((error: unknown) => setAgentStatus(describeError(error), "error"));
  });
  login.append(loginCode, loginLink);
  meta.append(username, login);
  identity.append(nameLine, meta);
  appendAgentFailureDetail(identity, status);

  const right = document.createElement("span");
  right.className = "agent-right";

  const action = agentAction(status);
  if (action) right.append(action);
  right.append(agentContactButton(status));

  const progress = document.createElement("div");
  progress.className = "agent-install-progress";
  progress.hidden = !installing;
  const caption = document.createElement("span");
  caption.className = "agent-download-caption";
  caption.setAttribute("role", "status");
  const meter = document.createElement("progress");
  meter.className = "agent-download-meter";
  meter.max = 1;
  meter.setAttribute("aria-label", t("app.agent.downloadProgress"));
  progress.append(caption, meter);
  row.classList.toggle("has-install-progress", installing);
  row.append(avatar, identity, right, progress);
  updateInstallProgress(row, status);
  updateAgentLogin(row, status.kind);
  return row;
}

function updateAgentLogin(row: HTMLElement, kind: AgentKind): void {
  const code = agentLoginCodes.get(kind);
  const link = agentLoginLinks.get(kind);
  const codeElement = row.querySelector<HTMLElement>(".agent-login-code");
  const linkElement = row.querySelector<HTMLElement>(".agent-login-link");
  if (codeElement) {
    codeElement.textContent = code ? t("app.agent.deviceCode", { code }) : "";
    codeElement.hidden = !code;
  }
  if (linkElement) {
    linkElement.hidden = !link;
    // Show only the host: the full URL can carry one-time challenges.
    linkElement.dataset.tooltip = link ? t("app.agent.openLoginPageAt", { host: new URL(link).host }) : "";
  }
}

function updateInstallProgress(row: HTMLElement, status: AgentStatus): void {
  const caption = row.querySelector<HTMLElement>(".agent-download-caption");
  const meter = row.querySelector<HTMLProgressElement>(".agent-download-meter");
  if (!caption || !meter) return;
  const download = agentDownloads.get(status.kind);
  const received = download?.receivedBytes;
  const total = download?.totalBytes;
  const known = total !== undefined && Number.isFinite(total) && total > 0 && received !== undefined && total >= received;
  caption.textContent = received !== undefined && Number.isFinite(received) && received >= 0
    ? known ? t("app.agent.downloadingTotal", { received: (received / 1048576).toFixed(1), total: (total / 1048576).toFixed(1) })
      : t("app.agent.downloading", { received: (received / 1048576).toFixed(1) })
    : installProgressText(status);
  if (known) meter.value = Math.min(1, Math.max(0, received / total));
  else meter.removeAttribute("value");
  meter.setAttribute("aria-valuetext", caption.textContent);
}

function installProgressText(status: AgentStatus): string {
  const text = agentInstallProgress.get(status.kind) ?? "";
  for (const name of [status.label, status.kind]) {
    for (const separator of ["：", ":"]) {
      const prefix = `${name}${separator}`;
      if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
    }
  }
  return text;
}

function renderAgents(): void {
  renderAgentRecheck();
  agentRows.replaceChildren();
  for (const status of agentCatalog) agentRows.append(agentRow(status));

  const ready = agentCatalog.filter((status) => status.readiness === "ready").length;
  const stillChecking = agentCatalog.some(
    (status) => status.installed && !status.checkedAt
  );
  if (ready > 0 || !stillChecking) {
    stableReadyAgentCount = ready;
    localStorage.setItem("ading.ready-agent-count", String(ready));
  }
  agentsBadge.hidden = stableReadyAgentCount === 0;
  agentsBadge.textContent = String(stableReadyAgentCount);
  agentsBadge.setAttribute("aria-label", t("app.agent.readyCount", { count: stableReadyAgentCount }));

  if (contactDetailDialog.open && detailContact?.isAgent) {
    detailContact = users.get(detailContact.userId) ?? detailContact;
    renderContactAgentStatus(detailContact, agentStatusOf(detailContact));
  }
  if (selectedId || draftContactId || draftMemberIds?.length) renderHeader();
  if (activeTab === "contacts") renderConversationList();
  if (groupDialog.open) {
    for (const row of groupMemberList.querySelectorAll<HTMLElement>(".member-pick")) {
      const user = users.get(row.dataset.userId ?? "");
      if (user?.isAgent) row.querySelector(".conversation-agent-readiness")?.replaceWith(agentReadinessLight(user));
    }
  }
  if (settingsDialog.open && editingConversationId) {
    const editing = conversationById(editingConversationId);
    if (editing) renderMemberEditor(editing);
  }
}

/**
 * Refresh the directory.
 *
 * It's split in two because speeds differ by two orders of magnitude: installed-or-not is pure filesystem (milliseconds), connectivity checks actually start processes (seconds per vendor).
 * So draw the directory first, then check as needed: on force (user clicks "Recheck") run a full round; otherwise only individually check
 * the vendors with "CLI found but no detection verdict yet" -- e.g. a CLI just installed, a desktop App just connected,
 * or ones installed outside ADing. Never leave a "pending check" state that nobody checks.
 * At startup refreshAgentsAtStartup defers detection uniformly and passes verifyUnchecked=false.
 */
async function refreshAgents(force = false, verifyUnchecked = true): Promise<void> {
  try {
    agentCatalog = localizedCatalog(await bridge.agentCatalog(force));
    renderAgents();
  } catch (error) {
    setAgentStatus(describeError(error), "error");
    return;
  }

  if (force) {
    await verifyCatalogAgents();
    return;
  }
  if (!verifyUnchecked) return;
  const unchecked = agentCatalog.filter(
    (status) => status.installed && (status.readiness === "found" || status.readiness === "unknown")
  );
  await Promise.allSettled(unchecked.map((status) => verifyOne(status.kind)));
}

async function verifyCatalogAgents(): Promise<void> {
  const pending = agentCatalog.filter((status) => status.installed);
  await Promise.allSettled(pending.map((status) => verifyOne(status.kind)));
}

async function refreshAgentsAtStartup(): Promise<void> {
  await trackAgentCheck(async () => {
    await refreshAgents(false, false);
    // Let Electron finish its first layout/paint before starting the independent
    // low-priority probes. They remain parallel, so total time follows the slowest.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await verifyCatalogAgents();
  });
}

async function trackAgentCheck(run: () => Promise<void>): Promise<void> {
  agentCheckRuns++;
  renderAgentRecheck();
  try {
    await run();
  } finally {
    agentCheckRuns--;
    renderAgentRecheck();
  }
}

/** Spin and stay unclickable while still checking, to avoid launching duplicate checks */
function renderAgentRecheck(): void {
  const busy = agentCheckRuns > 0 || verifying.size > 0;
  agentRecheck.disabled = busy;
  agentRecheck.classList.toggle("spinning", busy);
  const tip = busy ? t("app.agent.checking") : t("app.agent.recheck");
  agentRecheck.dataset.tooltip = tip;
  agentRecheck.setAttribute("aria-label", tip);
}

/** The slow part: actually send one minimal call; vendors don't block each other, each lights up as it's ready. */
async function verifyOne(kind: AgentKind): Promise<void> {
  if (verifying.has(kind)||lifecycleBusy.has(kind)) return;
  verifying.add(kind);
  renderAgents();
  try {
    const refreshed = await bridge.verifyAgent(kind);
    const updated = refreshed.find((status) => status.kind === kind);
    // When returning concurrently, merge only this vendor's own result, so an earlier directory snapshot doesn't overwrite another vendor's new result.
    if (updated) {
      agentCatalog = agentCatalog.map((status) =>
        status.kind === kind ? localizedCatalog([updated])[0] : status
      );
    }
  } catch (error) {
    setAgentStatus(describeError(error), "error");
  } finally {
    verifying.delete(kind);
    renderAgents();
  }
}

agentRecheck.addEventListener("click", () => {
  if (agentCheckRuns > 0 || verifying.size > 0) return;
  void trackAgentCheck(() => refreshAgents(true));
});

/**
 * The top-right entry. It's not in the rail, so after opening it no slot on the rail is lit --
 * therefore this page carries its own close button to return to the page before it.
 */
let tabBeforeAgents: "contacts" | "conversations" | "knowledge" = "conversations";

function openAgents(): void {
  if (activeTab === "agents") return;
  tabBeforeAgents = activeTab;
  switchTab("agents");
}

function closeAgents(): void {
  if (activeTab !== "agents") return;
  switchTab(tabBeforeAgents);
}

agentsEntry.addEventListener("click", () => activeTab === "agents" ? closeAgents() : openAgents());
agentClose.addEventListener("click", closeAgents);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || activeTab !== "agents") return;
  // The dialog consumes Esc itself; don't steal it
  if (document.querySelector("dialog[open]")) return;
  closeAgents();
});

function openChatTab(tab: "contacts" | "conversations", followUnread = false): void {
  const unread = unreadConversations();
  const target = tab === "contacts" ? unread.find(conversation => unreadContactId(conversation)) : unread[0];
  if (tab === "conversations") {
    temporaryUnreadConversationId = followUnread && target && !matchesConversationFilters(target)
      ? target.conversationId : undefined;
  }
  if (target && tab === "contacts") contactSearchInput.value = "";
  chatSidebarCollapsed = false;
  localStorage.setItem(sidebarCollapsedStorageKey, "false");
  switchTab(tab);
  const scrollToTarget = async (): Promise<void> => {
    if (!target) return;
    const contactId = unreadContactId(target);
    await (tab === "contacts" ? contactPages.reveal(contactId ?? "") : conversationPages.reveal(target.conversationId));
    if (activeTab !== tab) return;
    const row = tab === "contacts"
      ? [...contactSearchResults.querySelectorAll<HTMLElement>(".contact-list-item")].find(row => row.dataset.userId === contactId)
      : [...conversationScroll.querySelectorAll<HTMLElement>(".conversation-list-item")].find(row => row.dataset.conversationId === target.conversationId);
    row?.scrollIntoView({ block: "nearest" });
  };
  if (followUnread && target) void selectConversation(target.conversationId).then(scrollToTarget);
  else void scrollToTarget();
}

for (const [button, tab] of [[tabContacts, "contacts"], [tabConversations, "conversations"]] as const) {
  button.addEventListener("click", event => openChatTab(tab,
    event.target instanceof Element && !!event.target.closest(".navigation-unread-dot")));
  // Double-clicking anywhere on the tab follows unread like its dot, including conversations hidden by a filter.
  button.addEventListener("dblclick", () => { if (button.querySelector(".navigation-unread-dot")) openChatTab(tab, true); });
  button.addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && button.querySelector(".navigation-unread-dot")) {
      event.preventDefault();
      openChatTab(tab, true);
    }
  });
}
tabKnowledge.addEventListener("click", () => switchTab("knowledge"));

sidebarToggle.addEventListener("click", () => {
  chatSidebarCollapsed = !chatSidebarCollapsed;
  localStorage.setItem(
    sidebarCollapsedStorageKey,
    String(chatSidebarCollapsed)
  );
  applyChatSidebarLayout();
});

sidebarResizer.addEventListener("pointerdown", (event) => {
  if (chatSidebarCollapsed) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = chatSidebarWidth;
  sidebarResizer.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-sidebar");

  const move = (moveEvent: PointerEvent): void => {
    chatSidebarWidth = boundedSidebarWidth(
      startWidth + moveEvent.clientX - startX
    );
    applyChatSidebarLayout();
  };
  const end = (): void => {
    document.body.classList.remove("resizing-sidebar");
    sidebarResizer.removeEventListener("pointermove", move);
    sidebarResizer.removeEventListener("pointerup", end);
    sidebarResizer.removeEventListener("pointercancel", end);
    saveChatSidebarWidth();
  };
  sidebarResizer.addEventListener("pointermove", move);
  sidebarResizer.addEventListener("pointerup", end);
  sidebarResizer.addEventListener("pointercancel", end);
});

sidebarResizer.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const step = event.shiftKey ? 40 : 10;
  chatSidebarWidth = boundedSidebarWidth(
    chatSidebarWidth + (event.key === "ArrowRight" ? step : -step)
  );
  applyChatSidebarLayout();
  saveChatSidebarWidth();
});

window.addEventListener("resize", applyChatSidebarLayout);

knowledgeAdd.addEventListener("click", async () => {
  const text = await knowledgePrompt(
    activeScope.kind === "user"
      ? t("app.knowledge.promptUser")
      : t("app.knowledge.promptWorkspace")
  );
  if (!text?.trim() || !me) return;
  const target =
    activeScope.kind === "user"
      ? { scope: "user" as MemoryScope, ownerId: me.userId }
      : activeScope.kind === "workspace"
        ? { scope: "workspace" as MemoryScope, ownerId: activeScope.workspaceId }
        : null;
  if (!target) return;
  void bridge
    .appendMemory({ ...target, content: text.trim() })
    .then(() => renderKnowledgeBody())
    .catch((error: unknown) => setKnowledgeStatus(describeError(error), "error"));
});
function activeSkillScope():{scope:Scope;ownerId?:string}|null {
  return activeScope.kind==="global" ? {scope:"global"} : activeScope.kind==="workspace" ? {scope:"workspace",ownerId:activeScope.workspaceId} : null;
}
knowledgeCreateSkill.addEventListener("click",async()=>{
  const scope=activeSkillScope();if(!scope)return;
  const name=await knowledgePrompt(t("app.knowledge.skillName"),"",false);if(!name?.trim())return;
  const description=await knowledgePrompt(t("app.knowledge.skillDescription"),"",false);if(description===null)return;
  const content=await knowledgePrompt(t("app.knowledge.skillContent"));if(!content?.trim())return;
  void bridge.createSkill({...scope,name:name.trim(),description:description.trim(),content:content.trim()}).then(()=>{setKnowledgeStatus(t("app.knowledge.saved"));return renderKnowledgeBody();}).catch(error=>setKnowledgeStatus(describeError(error),"error"));
});
for(const [button,sourceKind] of [[knowledgeImportZip,"zip"],[knowledgeImportDirectory,"directory"]] as const)button.addEventListener("click",()=>{
  const scope=activeSkillScope();if(!scope)return;
  void bridge.importSkill({...scope,sourceKind}).then(skill=>{if(skill)setKnowledgeStatus(t("app.knowledge.saved"));return renderKnowledgeBody();}).catch(error=>setKnowledgeStatus(describeError(error),"error"));
});
knowledgeSyncClose.addEventListener("click",()=>{
  setKnowledgeStatus("");
  knowledgeRetrySync.focus();
});
knowledgeRetrySync.addEventListener("click",()=>{
  knowledgeRetrySync.disabled=true;
  void bridge.retryKnowledgeSync().then(result=>{
    applyKnowledgeSyncState({failures:result.failures??[]});
    // A failed retry always answers, even when the failure list is the one already shown.
    setKnowledgeStatus(result.synced ? t("app.knowledge.synced") : result.failures?.length ? knowledgeSyncDetails(result.failures) : t("app.knowledge.syncPending"),result.failures?.length ? "error" : "info");
  }).catch(error=>setKnowledgeStatus(t("app.knowledge.retryFailed",{error:describeError(error)}),"error"))
    .finally(()=>{knowledgeRetrySync.disabled=false;});
});

// Notice when syncing central-library knowledge to an Agent's native directory fails: failure doesn't block execution, but people should know which Agent is missing which kind of knowledge.
let knowledgeSyncFailures:KnowledgeSyncFailure[]=[];
let knowledgeSyncSignature="[]";
let knowledgeSyncNoticeShown:{key:string;text:string}|null=null;
function knowledgeSyncAgents(agents:AgentKind[]):string {return agents.map(kind=>AGENT_REAL_NAMES[kind]??kind).join(t("app.common.listSeparator"));}
function knowledgeSyncCategory(category:KnowledgeSyncFailure["category"]):string {return t(`app.knowledge.syncCategory.${category}`);}
const isCloudSyncFailure=(failure:KnowledgeSyncFailure):boolean=>failure.category==="cloud";
function knowledgeSyncSummary(failures:KnowledgeSyncFailure[]):string {
  const groups=new Map<string,{agents:AgentKind[];category:KnowledgeSyncFailure["category"]}>();
  for(const failure of failures)for(const kind of failure.agents) {
    const group=groups.get(failure.category)??{agents:[],category:failure.category};
    if(!group.agents.includes(kind))group.agents.push(kind);groups.set(failure.category,group);
  }
  return [...groups.values()].map(group=>t("app.knowledge.syncSummaryItem",{agents:knowledgeSyncAgents(group.agents),category:knowledgeSyncCategory(group.category)})).join(t("app.common.clauseSeparator"));
}
function knowledgePermissionHelp(failure:KnowledgeSyncFailure):string {
  const permission=failure.permission;if(!permission)return "";
  if(failure.sync)return t(failure.sync.stage==="verification" ? "app.knowledge.syncVerifyDenied" : "app.knowledge.syncCopyDenied",{path:permission.path});
  const reason=t(permission.directoryWritable===true ? "app.knowledge.permissionWritable" : "app.knowledge.permissionDenied");
  const advice=t(permission.platform==="darwin" ? "app.knowledge.permissionMac" : "app.knowledge.permissionOther");
  return t("app.knowledge.permissionLine",{agents:knowledgeSyncAgents(failure.agents),directory:permission.directory,code:permission.code,reason,advice});
}
function knowledgeSyncDetails(failures:KnowledgeSyncFailure[]):string {
  const agentFailures=failures.filter(failure=>!isCloudSyncFailure(failure)),parts:string[]=[];
  if(agentFailures.length)parts.push(t("app.knowledge.syncFailed",{details:agentFailures.map(failure=>t("app.knowledge.syncFailureLine",{agents:knowledgeSyncAgents(failure.agents),category:knowledgeSyncCategory(failure.category),detail:[failure.detail,knowledgePermissionHelp(failure)].filter(Boolean).join("\n")})).join("\n")}));
  for(const failure of failures.filter(isCloudSyncFailure))parts.push(t("app.knowledge.cloudSyncFailed",{detail:failure.detail}));
  return parts.join("\n");
}
function knowledgeSyncNoticeText(failures:KnowledgeSyncFailure[]):string {
  const parts:string[]=[];
  const ordinary=failures.filter(failure=>!isCloudSyncFailure(failure)&&!failure.permission&&!failure.sync);
  if(ordinary.length)parts.push(t("app.knowledge.syncFailedNotice",{summary:knowledgeSyncSummary(ordinary)}));
  for(const failure of failures.filter(failure=>failure.sync))parts.push(t("app.knowledge.syncFinalFailure",{agents:knowledgeSyncAgents(failure.agents),code:failure.sync!.code,detail:knowledgePermissionHelp(failure)||failure.detail}));
  const permissionLines=[...new Set(failures.filter(failure=>!failure.sync).map(knowledgePermissionHelp).filter(Boolean))];
  if(permissionLines.length)parts.push(t("app.knowledge.permissionNotice",{details:permissionLines.join("\n")}));
  if(failures.some(isCloudSyncFailure))parts.push(t("app.knowledge.cloudSyncFailedNotice"));
  return parts.join(" ");
}
function applyKnowledgeSyncState(state:KnowledgeSyncState|undefined):void {
  const failures=Array.isArray(state?.failures) ? state.failures : [];
  const pending=Array.isArray(state?.pending) ? state.pending : [];
  const signature=JSON.stringify({failures,pending});
  if(signature===knowledgeSyncSignature)return;
  knowledgeSyncSignature=signature;knowledgeSyncFailures=failures;
  const shown=knowledgeSyncNoticeShown;
  if(shown&&chatNotices.get(shown.key)?.text===shown.text)setStatus("","info",false,shown.key);
  knowledgeSyncNoticeShown=null;
  // Waiting, background re-sync and automatic correction run silently; only final failures alert the user.
  // After recovery only dismiss the sync-failure notice; keep other knowledge notices (e.g. central save failures)
  if(!failures.length){if(shown||!knowledgeSyncNotice.hidden&&[t("app.knowledge.syncFailed",{details:""}),t("app.knowledge.cloudSyncFailed",{detail:""})].some(prefix=>knowledgeSyncText.textContent?.startsWith(prefix)))setKnowledgeStatus("");return;}
  // The Knowledge page isn't in the navigation now, so also tell the user in the current conversation's notice bar; the same failure is shown only once and doesn't keep popping after being closed.
  const text=knowledgeSyncNoticeText(failures),key=currentComposerKey();
  setStatus(text,"error",false,key);knowledgeSyncNoticeShown={key,text};
  setKnowledgeStatus(knowledgeSyncDetails(failures),"error");
}
bridge.onKnowledgeSyncState?.(applyKnowledgeSyncState);
// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

newGroupButton.addEventListener("click", () => {
  if (newGroupButton.getAttribute("aria-disabled") !== "true") openGroupDialog();
});
settingsButton.addEventListener("click", () => openConversationSettings());
currentUserRailAvatar.addEventListener("click", () => {
  if (me) openContactDetail(me);
});
supportEntry.addEventListener("click", () => void openSupport());
supportClose.addEventListener("click", () => supportDialog.close());
closeOnBackdropClick(supportDialog);
for (const button of supportTabs) {
  button.addEventListener("click", () => {
    const tab = button.dataset.supportTab as SupportTab | undefined;
    if (tab) switchSupportTab(tab);
  });
}
supportDeveloperAddFile.addEventListener("click", () => supportDeveloperFileInput.click());
supportDeveloperFileInput.addEventListener("change", async () => {
  const files = Array.from(supportDeveloperFileInput.files ?? []);
  supportDeveloperFileInput.value = "";
  if (files.length + supportDeveloperFiles.length > 5) {
    setSupportFeedback(supportDeveloperFeedback, t("app.support.maxAttachments"), true);
    return;
  }
  try {
    supportDeveloperFiles.push(...(await Promise.all(files.map(fileAsContactAttachment))));
    renderSupportDeveloperFiles();
    setSupportFeedback(supportDeveloperFeedback, "");
  } catch (error) {
    setSupportFeedback(supportDeveloperFeedback, describeError(error), true);
  }
});
supportAddImage.addEventListener("click", () => supportImageInput.click());
supportImageInput.addEventListener("change", async () => {
  const files = Array.from(supportImageInput.files ?? []);
  supportImageInput.value = "";
  if (files.length + supportUserImages.length > 5) {
    setSupportFeedback(supportReportFeedback, t("app.support.maxImages"), true);
    return;
  }
  try {
    const added = await Promise.all(files.map(fileAsSupportImage));
    supportUserImages.push(...added);
    renderSupportAttachments();
    setSupportFeedback(supportReportFeedback, "");
  } catch (error) {
    setSupportFeedback(supportReportFeedback, describeError(error), true);
  }
});
supportSubmitReport.addEventListener("click", () => void submitSupportReport());
supportReportAgain.addEventListener("click", () => {
  showSupportReportDone(false);
  supportReportOccurredAt.value = localSecondValue();
  supportReportDescription.focus();
});
supportDoneClose.addEventListener("click", () => supportDialog.close());
supportDeveloperAgain.addEventListener("click", () => {
  showSupportDeveloperDone(false);
  supportDeveloperSubject.focus();
});
supportDeveloperDoneClose.addEventListener("click", () => supportDialog.close());
supportEmailDeveloper.addEventListener("click", () => void contactDeveloper());

// Once content starts being edited, the error left from the last submission is void:
// with enough characters already entered, a lingering "Please use at least 5 characters" below would only make people think it didn't take effect.
function clearFeedbackOnInput(feedback: HTMLElement, ...fields: HTMLElement[]): void {
  for (const field of fields) {
    field.addEventListener("input", () => {
      if (feedback.classList.contains("error")) setSupportFeedback(feedback, "");
    });
  }
}
clearFeedbackOnInput(supportReportFeedback, supportReportDescription, supportReportOccurredAt);
clearFeedbackOnInput(
  supportDeveloperFeedback,
  supportDeveloperSubject,
  supportDeveloperContent,
  supportDeveloperReplyTo
);
contactDetailClose.addEventListener("click", () => contactDetailDialog.close());
contactDetailRefreshStatus.addEventListener("click", () => {
  const contact = detailContact;
  if (!contact?.isAgent || contactDetailRefreshStatus.disabled) return;
  void (async () => {
    contactDetailRefreshStatus.disabled = true;
    contactDetailRefreshStatus.textContent = t("app.agent.refreshingStatus");
    contactDetailError.textContent = "";
    try {
      const result = await bridge.refreshAgentStatus(contact.userId);
      if (result.catalog) {
        const updated = result.catalog.find(status => status.kind === contact.kind);
        if (updated) agentCatalog = agentCatalog.map(status =>
          status.kind === contact.kind ? localizedCatalog([updated])[0] : status);
        renderAgents();
      }
      if (result.requested) setStatus(t("app.agent.refreshRequested"));
    } catch (error) {
      contactDetailError.textContent = describeError(error);
    } finally {
      contactDetailRefreshStatus.disabled = false;
      contactDetailRefreshStatus.textContent = t("html.profile.refreshStatus");
    }
  })();
});
contactChangePassword.addEventListener("click", () => {
  passwordCurrent.value = "";
  passwordNew.value = "";
  passwordConfirm.value = "";
  passwordError.textContent = "";
  passwordDialog.showModal();
  passwordCurrent.focus();
});
passwordClose.addEventListener("click", () => passwordDialog.close());
passwordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPasswordChange();
});
closeOnBackdropClick(contactDetailDialog);
readonlyProfileClose.addEventListener("click", () => readonlyProfileDialog.close());
closeOnBackdropClick(readonlyProfileDialog);
closeOnBackdropClick(friendDialog);
contactDetailAvatar.addEventListener("click", () => {
  const image = contactDetailAvatar.querySelector<HTMLImageElement>("img");
  if (!image?.src) return;
  openAvatarPreview(image.src);
});
contactAvatarChange.addEventListener("click", () => contactAvatarInput.click());
avatarPreviewClose.addEventListener("click", () => avatarPreviewDialog.close());
closeOnBackdropClick(avatarPreviewDialog);
deleteConfirmClose.addEventListener("click", closeDeleteConfirmation);
closeOnBackdropClick(deleteConfirmDialog, closeDeleteConfirmation);
deleteConfirmAction.addEventListener("click", () => {
  const action = pendingDeleteAction;
  const context = pendingDeleteContext;
  const generation = dataGeneration;
  if (!action) return;
  deleteConfirmAction.disabled = true;
  deleteConfirmAction.textContent = t("app.common.deleting");
  void action()
    .then(closeDeleteConfirmation)
    .catch((error: unknown) => { if (generation === dataGeneration) setStatus(t("app.common.deleteFailed", { error: describeError(error) }), "error", false, context); })
    .finally(() => {
      deleteConfirmAction.disabled = false;
      deleteConfirmAction.textContent = t("app.common.delete");
    });
});
contactAvatarInput.addEventListener("change", () => {
  const contact = detailContact;
  const file = contactAvatarInput.files?.[0];
  if (!contact || !file) return;
  contactDetailError.textContent = "";
  if (file.size > 1_000_000) {
    contactDetailError.textContent = t("app.avatar.tooLarge");
    contactAvatarInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    if (typeof reader.result !== "string") return;
    pendingContactAvatar = reader.result;
    renderContactAvatar(contactDetailAvatar, contact, pendingContactAvatar);
  });
  reader.addEventListener("error", () => {
    contactDetailError.textContent = t("app.avatar.readFailed");
  });
  reader.readAsDataURL(file);
});
contactDetailForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveContactDetail();
});

settingsClose.addEventListener("click", () => {
  editingConversationId = null;
  settingsDialog.close();
});
settingsSave.addEventListener("click", () => void saveSettings());

groupMemberSearch.addEventListener("input", filterGroupMembers);
groupClose.addEventListener("click", () => groupDialog.close());
groupConfirm.addEventListener("click", () => createGroup());

function isSharedConversation(conversation: Conversation): boolean {
  return !!conversation.shared || (!isConversationMember(conversation) && conversation.members.some(member => {
    const agent = users.get(member.userId);
    return agent?.isAgent && agent.owner === me?.userId;
  }));
}

function isConversationMember(conversation: Conversation): boolean {
  return conversation.members.some(member => member.userId === me?.userId);
}

function isResumable(conversationId: string): boolean {
  if (hasRunningAgent(conversationId)) return false;
  const conversation = conversationById(conversationId);
  // The owner's pause is stored in the cloud, so it can still be resumed after a restart
  if (conversation && !isConversationMember(conversation) && conversation.members.some(member => member.ownerPaused)) return true;
  return stoppedConversations.has(conversationId);
}

stopButton.addEventListener("click", () => {
  if (!selectedId || stopButton.disabled) return;
  const conversationId = selectedId;
  const conversation = conversationById(conversationId);
  if (!conversation || (!isConversationMember(conversation) && !isSharedConversation(conversation))) return;
  if (isResumable(conversationId)) {
    conversationControlPending.add(conversationId);
    stopButton.disabled = true;
    setStatus(t("app.conversation.resuming"), "info", false, chatKey(conversationId));
    void bridge.resumeConversation(conversationId)
      .then(async () => {
        await refreshConversations();
        syncConversationActivity();
        syncComposer();
        setStatus(t("app.conversation.resumed"), "info", false, chatKey(conversationId));
      })
      .catch((error: unknown) => setStatus(describeError(error), "error", false, chatKey(conversationId)))
      .finally(() => {
        conversationControlPending.delete(conversationId);
        syncComposer();
      });
    return;
  }
  if (!hasRunningAgent(conversationId) && !isSharedConversation(conversation)) return;
  conversationControlPending.add(conversationId);
  stopButton.disabled = true;
  setStatus(t("app.conversation.pausing"), "info", false, chatKey(conversationId));
  void bridge.stopConversation(conversationId)
    .then(async () => {
      await refreshConversations();
      syncConversationActivity();
      syncComposer();
      setStatus(t("app.conversation.pauseRequested"), "info", false, chatKey(conversationId));
    })
    .catch((error: unknown) => setStatus(describeError(error), "error", false, chatKey(conversationId)))
    .finally(() => {
      conversationControlPending.delete(conversationId);
      syncComposer();
    });
});

sendModeButton.addEventListener("click", (event) => {
  event.stopPropagation();
  sendModeMenu.hidden = !sendModeMenu.hidden;
});
filterHumansButton.addEventListener("click", () => {
  messageFilter = messageFilter === "humans" ? "all" : "humans";
  renderMessages();
});
filterAgentsButton.addEventListener("click", () => {
  messageFilter = messageFilter === "agents" ? "all" : "agents";
  renderMessages();
});
toggleProcessButton.addEventListener("click", () => {
  processPanelOpen = !processPanelOpen;
  renderMessages();
});
conversationAgentMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (conversationAgentMenuButton.disabled) return;
  conversationSwitcherMenu.hidden = true;
  conversationAddMemberMenu.hidden = true;
  conversationAgentMenuOpen = !conversationAgentMenuOpen;
  renderConversationAgentMenu(selectedId ? conversationById(selectedId) : undefined);
});
conversationAgentMenu.addEventListener("click", (event) => event.stopPropagation());
reportConversationButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!selectedId || reportConversationButton.disabled || reportConfirmDialog.open) return;
  reportConfirmationConversationId = selectedId;
  reportConfirmDialog.showModal();
});
function closeReportConfirmation(): void {
  reportConfirmDialog.close();
  reportConfirmationConversationId = null;
}
el<HTMLButtonElement>("#report-confirm-cancel").addEventListener("click", closeReportConfirmation);
el<HTMLButtonElement>("#report-confirm-close").addEventListener("click", closeReportConfirmation);
reportConfirmDialog.addEventListener("cancel", () => { reportConfirmationConversationId = null; });
closeOnBackdropClick(reportConfirmDialog, closeReportConfirmation);
reportConfirmAction.addEventListener("click", () => {
  const conversationId = reportConfirmationConversationId;
  closeReportConfirmation();
  if (!conversationId || selectedId !== conversationId || reportingConversations.has(conversationId)) return;
  // Task state can change while the confirmation is open.
  renderMessageFilters();
  if (reportConversationButton.disabled) return;
  reportingConversations.add(conversationId);
  renderMessageFilters();
  setStatus(t("app.report.inProgress"), "info", false, chatKey(conversationId));
  void bridge
    .reportConversation(conversationId)
    .then(() => setStatus(t("app.report.done"), "info", false, chatKey(conversationId)))
    .catch((error: unknown) => setStatus(describeError(error), "error", false, chatKey(conversationId)))
    .finally(() => { reportingConversations.delete(conversationId); renderMessageFilters(); });
});
processPanelClose.addEventListener("click", () => {
  processPanelOpen = false;
  renderMessages();
});
// When filtering Agents the panel redraws synchronously and old buttons detach from the DOM; stop internal clicks from continuing to
// bubble, so document doesn't misjudge this click as "clicked outside the feed".
processPanel.addEventListener("click", (event) => event.stopPropagation());
sendModeMenu.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", (event) => {
  sendModeMenu.hidden = true;
  conversationSwitcherMenu.hidden = true;
  conversationAddMemberMenu.hidden = true;
  if (conversationAgentMenuOpen) {
    conversationAgentMenuOpen = false;
    conversationAgentMenu.hidden = true;
  }
  const target = event.target;
  if (
    processPanelOpen &&
    target instanceof Node &&
    !processPanel.contains(target) &&
    !toggleProcessButton.contains(target)
  ) {
    processPanelOpen = false;
    renderMessageFilters();
    renderProcessPanel();
  }
});

conversationSwitcherButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (conversationSwitcherButton.disabled) return;
  conversationAgentMenuOpen = false;
  conversationAgentMenu.hidden = true;
  conversationAddMemberMenu.hidden = true;
  const current = selectedId ? conversationById(selectedId) : undefined;
  if (current?.type === "DIRECT") {
    conversationSwitcherContactContextId = counterpart(current)?.userId ?? null;
  } else if (
    conversationSwitcherContactContextId &&
    !current?.members.some(
      (member) => member.userId === conversationSwitcherContactContextId
    )
  ) {
    conversationSwitcherContactContextId = null;
  }
  renderConversationSwitcherMenu();
  conversationSwitcherMenu.hidden = !conversationSwitcherMenu.hidden;
});
conversationSwitcherMenu.addEventListener("click", (event) => event.stopPropagation());
conversationAddMemberButton.addEventListener("click", (event) => {
  event.stopPropagation();
  conversationSwitcherMenu.hidden = true;
  conversationAgentMenuOpen = false;
  conversationAgentMenu.hidden = true;
  if (!conversationAddMemberMenu.hidden) {
    conversationAddMemberMenu.hidden = true;
    return;
  }
  conversationAddMemberSearch.value = "";
  addMemberPinnedIds = new Set(addMemberTargetIds() ?? []);
  addMemberVisibleCount = ADD_MEMBER_PAGE_SIZE;
  conversationAddMemberList.scrollTop = 0;
  renderAddMemberMenu();
  conversationAddMemberMenu.hidden = false;
  conversationAddMemberSearch.focus();
});
conversationAddMemberMenu.addEventListener("click", (event) => event.stopPropagation());
conversationAddMemberSearch.addEventListener("input", () => {
  addMemberVisibleCount = ADD_MEMBER_PAGE_SIZE;
  conversationAddMemberList.scrollTop = 0;
  renderAddMemberMenu();
});
conversationAddMemberList.addEventListener("scroll", () => {
  if (addMemberVisibleCount >= addMemberMatchCount) return;
  const list = conversationAddMemberList;
  if (list.scrollTop + list.clientHeight < list.scrollHeight - 120) return;
  addMemberVisibleCount += ADD_MEMBER_PAGE_SIZE;
  renderAddMemberMenu();
});

function renderSendMode(): void {
  for (const option of sendModeOptions) {
    const active = option.dataset.sendMode === sendMode;
    option.classList.toggle("active", active);
    option.setAttribute("aria-pressed", String(active));
  }
  sendModeButton.title =
    sendMode === "enter" ? t("app.sendMode.enter") : t("app.sendMode.commandEnter");
}

for (const option of sendModeOptions) {
  option.addEventListener("click", () => {
    sendMode = option.dataset.sendMode === "enter" ? "enter" : "command-enter";
    localStorage.setItem(sendModeStorageKey, sendMode);
    renderSendMode();
    sendModeMenu.hidden = true;
    input.focus();
  });
}

function conversationTitleFromFirstMessage(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 22 ? `${compact.slice(0, 22)}…` : compact;
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const content = input.value;
  const attachments = [...pendingAttachments];
  const originKey = currentComposerKey();
  const generation = dataGeneration;
  const targetId = selectedId;
  const targetContactId = draftContactId;
  const targetMembers = draftMemberIds ? [...draftMemberIds] : null;
  const targetWorkspaceId = draftWorkspaceId;
  const targetLeaderId = draftLeaderId;
  const targetAutoTitle = draftAutoTitle;
  const targetPermanent = draftPermanent;
  const picked = new Map(pickedMentions.get(originKey));
  const targetMentions = parseMentions(content, { members: mentionCandidates().map(user => ({userId:user.userId})) } as Conversation, picked);
  if (!content.trim() && !attachments.length) return;
  pickedMentions.delete(originKey);
  const reply = replyTargets.get(originKey);
  replyTargets.delete(originKey);
  // When only attachments are sent, use the attachment names as the task name and goal
  const topic = content.trim() || attachments.map((item) => item.name).join("、");
  const withAttachments = attachments.length ? { initialAttachments: attachments } : {};

  input.value = "";
  pendingAttachments = [];
  renderComposerAttachments();
  autoGrowInput();
  syncComposer();

  const submittedRevision = saveComposerDraft().revision;
  if (!failedDrafts.get(originKey)?.length) chatNotices.delete(originKey);
  renderChatNotice();
  void (async () => {
    let conversation = targetId ? conversationById(targetId) : undefined;
    let createdFromDraft = false;
    if (!conversation && targetContactId) {
      const contact = users.get(targetContactId);
      if (!contact) throw new Error(t("app.composer.contactMissing"));
      const created = await bridge.createConversation({
        initialMessage: content,
        initialMentions: targetMentions,
        permanent: targetPermanent,
        ...withAttachments,
        name: conversationTitleFromFirstMessage(topic),
        memberIds: [contact.userId],
        workspaceId: targetWorkspaceId,
        // Chatting with friends isn't a task handed to an agent, so there's no goal to speak of
        ...(contact.isAgent ? { charter: { goal: topic } } : {})
      });
      if (dataGeneration !== generation) return;
      await refreshConversations();
      if (dataGeneration !== generation) return;
      if (currentComposerKey() === originKey) {
        const draft = composerDrafts.get(originKey);
        if (draft) composerDrafts.set(chatKey(created.conversationId), draft);
        await selectConversation(created.conversationId, false);
      }
      conversation = conversationById(created.conversationId) ?? created;
      // The direct chat just opened is this person's focus: next time clicking the contact goes into it by default
      rememberFocus(conversation);
      createdFromDraft = true;
    }
    if (!conversation && targetMembers?.length) {
      const created = await bridge.createConversation({
        initialMessage: content,
        initialMentions: targetMentions,
        permanent: targetPermanent,
        ...withAttachments,
        // While waiting for the semantic name, show "New task" instead of borrowing the truncated first message --
        // messages often start with an entire path; truncated, it's ugly and doesn't say what the task is.
        name: targetAutoTitle ? AUTO_TITLE_PLACEHOLDER : conversationTitleFromFirstMessage(topic),
        autoTitle: targetAutoTitle,
        memberIds: targetMembers,
        leaderId: targetLeaderId,
        workspaceId: targetWorkspaceId,
        ...(targetMembers.some(id => users.get(id)?.isAgent) ? { charter: { goal: topic } } : {})
      });
      if (dataGeneration !== generation) return;
      await refreshConversations();
      if (dataGeneration !== generation) return;
      if (currentComposerKey() === originKey) {
        const draft = composerDrafts.get(originKey);
        if (draft) composerDrafts.set(chatKey(created.conversationId), draft);
        await selectConversation(created.conversationId, false);
      }
      conversation = conversationById(created.conversationId) ?? created;
      // A new task with only one Agent selected is also a direct chat and likewise takes over the focus
      rememberFocus(conversation);
      createdFromDraft = true;
    }
    if (!conversation) throw new Error(t("app.composer.pickFirst"));
    if (!createdFromDraft) {
      await bridge.sendMessage({
        conversationId: conversation.conversationId,
        clientMessageId: newClientMessageId(),
        content,
        mentions: parseMentions(content, conversation, picked),
        ...(reply ? { replyTo: reply.messageId, quote: reply.quote } : {}),
        ...(attachments.length ? { attachments } : {})
      });
    }
  })()
    .catch((error: unknown) => {
      if (dataGeneration !== generation) return;
      if (composerContext === originKey) saveComposerDraft();
      const draft = composerDrafts.get(originKey);
      const failed = { text: content, attachments, mentions: picked, revision: submittedRevision, ...(reply ? { reply } : {}) };
      if (draft?.revision === submittedRevision && !draft.text && !draft.attachments.length) {
        composerDrafts.set(originKey, failed);
        if (currentComposerKey() === originKey) {
          input.value = content;
          if (picked.size) pickedMentions.set(originKey, new Map(picked));
          if (reply) replyTargets.set(originKey, reply);
          pendingAttachments = [...attachments];
          renderComposerAttachments();
          autoGrowInput();
        }
      } else {
        const saved = failedDrafts.get(originKey) ?? [];
        saved.push(failed);
        failedDrafts.set(originKey, saved);
      }
      setStatus(t("app.composer.sendFailed", { error: describeError(error) }), "error", false, originKey);
      syncComposer();
    });
});

attachButton.addEventListener("click", () => {
  const callbacks = attachmentCallbacks();
  bridge.pickAttachments().then(callbacks.accept, callbacks.reject);
});

// Drag files into the composer
composer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files") || input.disabled) return;
  event.preventDefault();
  composer.classList.add("drop-target");
});
composer.addEventListener("dragleave", () => composer.classList.remove("drop-target"));
composer.addEventListener("drop", (event) => {
  composer.classList.remove("drop-target");
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length || input.disabled) return;
  event.preventDefault();
  const paths = files.map((file) => bridge.pathForFile(file)).filter(Boolean);
  const callbacks = attachmentCallbacks();
  bridge.importAttachmentPaths(paths).then(callbacks.accept, callbacks.reject);
});

// Paste screenshots: the clipboard holds image content with no original file
input.addEventListener("paste", (event) => {
  const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  const callbacks = attachmentCallbacks();
  event.preventDefault();
  void (async () => {
    const attachments: Attachment[] = [];
    for (const image of images) {
      const extension = image.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const name = image.name && image.name !== "image.png" ? image.name : `${t("app.attachment.image").replace(/[[\]]/g, "")}-${Date.now()}.${extension}`;
      attachments.push(await bridge.importAttachmentData(name, image.type, new Uint8Array(await image.arrayBuffer())));
    }
    callbacks.accept({ attachments, rejected: [] });
  })().catch(callbacks.reject);
});

input.addEventListener("input", () => {
  const picks = pickedMentions.get(currentComposerKey());
  for (const label of picks?.keys() ?? []) if (!input.value.includes(`@${label}`)) picks?.delete(label);
  mentionIndex = 0; renderMentions();
  autoGrowInput();
  syncComposer();
});

input.addEventListener("keydown", (event) => {
  if (!mentionMenu.hidden && !event.isComposing) {
    const options = [...mentionMenu.querySelectorAll<HTMLButtonElement>("button")];
    if (event.key === "Escape") { mentionMenu.hidden = true; event.preventDefault(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      mentionIndex = (mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      renderMentions(); event.preventDefault(); return;
    }
    if (event.key === "Enter" || event.key === "Tab") { options[mentionIndex]?.click(); event.preventDefault(); return; }
  }
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  const shouldSend = sendMode === "enter" ? !event.shiftKey : event.metaKey;
  if (shouldSend) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

bridge.onStoreEvent((event) => {
  if (event.type === "message-times") {
    const times = new Map(event.times.map((time) => [time.messageId, time.createdAt]));
    for (const message of messagesByConversation.get(event.conversationId) ?? []) {
      const createdAt = times.get(message.messageId);
      if (createdAt) message.createdAt = createdAt;
    }
    const lastMessage = conversationById(event.conversationId)?.lastMessage;
    if (lastMessage && times.has(lastMessage.messageId)) lastMessage.createdAt = times.get(lastMessage.messageId)!;
    if (event.conversationId === selectedId) renderMessages();
    renderConversationList();
    return;
  }
  if (event.type === "message-delivery") {
    const message = messagesByConversation.get(event.conversationId)?.find((item) => item.messageId === event.messageId);
    if (message) message.status = event.status;
    if (event.conversationId === selectedId) renderMessages();
    return;
  }
  if (event.type === "message") {
    ++conversationRefreshGeneration;
    const list = messagesByConversation.get(event.conversationId);
    if (list) messageHistory.merge(event.conversationId, [event.message]);
    // Once the same execution steps are durably attached to the final message,
    // discard only that Agent's transient copy to avoid duplicate process runs.
    if(event.message.steps?.length){
      const retained=(liveProcessByConversation.get(event.conversationId)??[]).filter(entry=>entry.agentUserId!==event.message.senderId);
      if(retained.length)liveProcessByConversation.set(event.conversationId,retained);else liveProcessByConversation.delete(event.conversationId);
      const states=liveProcessStateByConversation.get(event.conversationId);
      states?.delete(event.message.senderId);
      if(states&&!states.size)liveProcessStateByConversation.delete(event.conversationId);
    }
    const conversation = conversationById(event.conversationId);
    if (conversation) {
      conversation.lastSeq = Math.max(conversation.lastSeq, event.message.seq);
      conversation.updatedAt = event.message.createdAt;
      if (!isOperationalMessage(event.message) && (!conversation.lastMessage || event.message.seq > conversation.lastMessage.seq)) conversation.lastMessage = event.message;
      if (event.conversationId === selectedId) {
        markVisibleConversationRead();
        // Operational failures belong to the information stream, but must not
        // disappear behind a closed panel when a provider/session dies.
        if(event.message.failed)processPanelOpen=true;
      }
    }
    if (event.conversationId === selectedId) {
      renderMessages();
      renderMessageFilters();
      if(processPanelOpen)renderProcessPanel();
    }
    renderConversationList();
    renderConversationSwitcherUnread();
    return;
  }
  if (
    event.type === "skills" ||
    event.type === "proposals" ||
    event.type === "memories"
  ) {
    // The badge must always be accurate -- people need to know something is waiting even when not on the Knowledge page
    void refreshPendingBadge().then(() => {
      if (activeTab === "knowledge") {
        renderScopeList();
        void renderKnowledgeBody();
      }
    });
    return;
  }
  if (event.type === "workspaces") {
    void bridge
      .listWorkspaces()
      .then((list) => {
        workspaces = list;
        renderConversationList();
        if (activeTab === "knowledge") renderScopeList();
      })
      .catch(() => undefined);
    return;
  }
  if (event.type === "agents") {
    void refreshAgents();
    return;
  }
  if (event.type === "friends") {
    void refreshFriendRequests();
    return;
  }
  if (event.type === "contacts") {
    // When agents from other computers sync in, this machine's computer must already be registered, so fetch it once along the way
    void refreshLocalComputer().then(() => refreshConversations());
    return;
  }
  if (event.type === "conversation") {
    void refreshConversations();
  }
});

bridge.onAgentLifecycleProgress((payload) => {
  if (payload.action === "install") {
    if (lifecycleBusy.get(payload.kind) !== "install") return;
    agentInstallProgress.set(payload.kind, payload.text);
    const status = agentCatalog.find(item => item.kind === payload.kind);
    if (payload.download) agentDownloads.set(payload.kind, payload.download);
    else agentDownloads.delete(payload.kind);
    const row = agentRows.querySelector<HTMLElement>(`[data-agent-kind="${payload.kind}"]`);
    if (status && row) updateInstallProgress(row, status);
    return;
  }
  if (payload.action === "login") {
    if (lifecycleBusy.get(payload.kind) !== "login") return;
    // A code can share a line with a long authorization URL. Keep the short
    // code and an official sign-in link (shown as a button, never as raw text);
    // URL challenges and terminal chatter never enter the panel.
    const link = agentLoginLink(payload.kind, payload.text);
    if (link) agentLoginLinks.set(payload.kind, link);
    const text = payload.text.replace(/https?:\/\/\S+/g, "").trim();
    const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
    if (code && (/code|码/i.test(text) || text === code)) agentLoginCodes.set(payload.kind, code);
    const row = agentRows.querySelector<HTMLElement>(`[data-agent-kind="${payload.kind}"]`);
    if (row) updateAgentLogin(row, payload.kind);
    return;
  }
  if (activeTab !== "agents") return;
  setAgentStatus(payload.text, "info", false);
});

bridge.onAgentProgress((payload) => {
  if (!runtimeState.accept(runtimeState.key(payload.conversationId, payload.agentUserId), payload.revision)) return;
  const wasBusy = runtimeState.isBusy(payload.conversationId, payload.agentUserId);
  // An accepted, current progress event is itself evidence of ongoing activity.
  busyAgents.set(runtimeState.key(payload.conversationId, payload.agentUserId), payload.conversationId);
  progressText.set(runtimeState.key(payload.conversationId, payload.agentUserId), payload.text);
  const states=liveProcessStateByConversation.get(payload.conversationId)??new Map();
  const previous=states.get(payload.agentUserId);
  let entries = liveProcessByConversation.get(payload.conversationId) ?? [];
  if(previous?.state==="stopped")entries=entries.filter(entry=>entry.agentUserId!==payload.agentUserId);
  states.set(payload.agentUserId,{state:"running",startedAt:previous?.state==="running"?previous.startedAt:new Date().toISOString()});
  liveProcessStateByConversation.set(payload.conversationId,states);
  const last = entries[entries.length - 1];
  if (!last || last.agentUserId !== payload.agentUserId || last.text !== payload.text) {
    entries.push({
      agentUserId: payload.agentUserId,
      text: payload.text,
      createdAt: new Date().toISOString()
    });
    if (entries.length > 300) entries.splice(0, entries.length - 300);
    liveProcessByConversation.set(payload.conversationId, entries);
  }
  if (payload.conversationId === selectedId) {
    if (!wasBusy) {
      renderMessages();
      renderConversationAgentMenu(conversationById(payload.conversationId));
    } else refreshPendingBubbles();
  }
  syncConversationActivity();
  syncComposer();
});

bridge.onAgentQueue?.((payload) => {
  if (payload.revision <= queueRevision) return;
  queueRevision = payload.revision;
  queuedAgents = payload.queued;
  syncComposer();
  scheduleProcessPanelRender();
});

bridge.onAgentBusy((payload) => {
  if (!runtimeState.accept(runtimeState.key(payload.conversationId, payload.agentUserId), payload.revision)) return;
  const states=liveProcessStateByConversation.get(payload.conversationId)??new Map();
  if (payload.busy) {
    const previous=states.get(payload.agentUserId);
    if(previous?.state==="stopped")liveProcessByConversation.set(payload.conversationId,(liveProcessByConversation.get(payload.conversationId)??[]).filter(entry=>entry.agentUserId!==payload.agentUserId));
    states.set(payload.agentUserId,{state:"running",startedAt:previous?.state==="running"?previous.startedAt:new Date().toISOString()});
    busyAgents.set(runtimeState.key(payload.conversationId, payload.agentUserId), payload.conversationId);
  } else {
    busyAgents.delete(runtimeState.key(payload.conversationId, payload.agentUserId));
    progressText.delete(runtimeState.key(payload.conversationId, payload.agentUserId));
    if(states.has(payload.agentUserId)||(liveProcessByConversation.get(payload.conversationId)??[]).some(entry=>entry.agentUserId===payload.agentUserId)){
      const previous=states.get(payload.agentUserId);
      states.set(payload.agentUserId,{state:"stopped",startedAt:previous?.startedAt??new Date().toISOString()});
    }
  }
  if(states.size)liveProcessStateByConversation.set(payload.conversationId,states);
  if (payload.conversationId === selectedId) {
    renderMessages();
    renderConversationAgentMenu(conversationById(payload.conversationId));
  }
  syncConversationActivity();
  syncComposer();
});

// ---------------------------------------------------------------------------
// Settings (opened by clicking the title bar icon and name): language, about.
// Updates no longer pop a bottom notice: when there's a new version the top right permanently shows "Update", with details in "Settings -> About".
// ---------------------------------------------------------------------------
const appSettingsEntry = el<HTMLButtonElement>("#app-settings-entry");
const appSettingsDialog = el<HTMLDialogElement>("#app-settings-dialog");
const appSettingsClose = el<HTMLButtonElement>("#app-settings-close");
const settingsTabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
const settingsPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-panel]"));
const languageInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="app-language"]'));
const aboutVersion = el<HTMLElement>("#settings-about-version");
const updateStatusText = el<HTMLElement>("#settings-update-status");
const checkUpdateButton = el<HTMLButtonElement>("#settings-check-update");
const installUpdateButton = el<HTMLButtonElement>("#settings-install-update");
const updateEntry = el<HTMLButtonElement>("#update-entry");

/** UI language: once chosen, save and reload the whole page; next time settings opens it still stays on the "Language" page */
const REOPEN_SETTINGS_KEY = "ading.reopen-settings";
function renderLanguage(): void {
  const language = currentLanguage();
  for (const input of languageInputs) input.checked = input.value === language;
}
for (const input of languageInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    const next: Language = input.value === "en" ? "en" : "zh-CN";
    if (next === currentLanguage()) return;
    try {
      sessionStorage.setItem(REOPEN_SETTINGS_KEY, "language");
    } catch {
      // It just doesn't auto-open settings after reloading
    }
    void switchLanguage(next, (language) => bridge.setLanguage?.(language));
  });
}

function showSettingsTab(name: string): void {
  for (const tab of settingsTabs) tab.classList.toggle("active", tab.dataset.settingsTab === name);
  for (const panel of settingsPanels) panel.hidden = panel.dataset.settingsPanel !== name;
  if (name === "permissions") {
    void bridge.getPermissionMode().then(mode=>{permissionMode=mode;renderPermissionMode();}).catch(error=>setStatus(describeError(error),"error"));
    void bridge.getKeepAwake().then(enabled=>{keepAwakeInput.checked=enabled;}).catch(error=>setStatus(describeError(error),"error"));
    void renderPermissionChecks();
  }
}

// ---------------------------------------------------------------------------
// Settings -> Permissions -> System authorization
//
// When another computer remotely has an Agent on this computer do work, nobody is in front of this computer, nobody clicks the system authorization dialog, and the task gets stuck.
// So check and authorize here while someone is present. Only check, don't pop dialogs; only when the user clicks the button does the system prompt pop or System Settings open.
// ADing doesn't manage permissions for the system: there's no toggle; authorization itself always happens in the system prompt and System Settings.
// ---------------------------------------------------------------------------
const settingsPermissionList = el<HTMLElement>("#settings-permission-list");
const settingsPermissionsRecheck = el<HTMLButtonElement>("#settings-permissions-recheck");
type PermissionState = "granted" | "missing" | "notDetermined" | "denied" | "unknown";
let permissionCheckRun = 0;

function permissionNote(text: string, error = false): HTMLElement {
  const note = document.createElement("li");
  note.className = `settings-permission-note${error ? " error" : ""}`;
  note.textContent = text;
  return note;
}

async function renderPermissionChecks(): Promise<void> {
  const run = ++permissionCheckRun;
  if (!settingsPermissionList.childElementCount) settingsPermissionList.replaceChildren(permissionNote(t("app.permission.checking")));
  let result: Awaited<ReturnType<typeof bridge.checkPermissions>>;
  try {
    result = await bridge.checkPermissions();
  } catch (error) {
    if (run === permissionCheckRun) settingsPermissionList.replaceChildren(permissionNote(t("app.permission.checkFailed", { error: describeError(error) }), true));
    return;
  }
  if (run !== permissionCheckRun) return;
  const rows: Array<{ item: string; name: string; purpose: string; state: PermissionState }> = [
    { item: "accessibility", name: t("app.permission.accessibility"), purpose: t("app.permission.accessibilityPurpose"), state: result.accessibility ? "granted" : "missing" },
    // The screen recording prompt only pops once: if requested but not authorized, it wasn't allowed then, and the system won't ask again
    { item: "screenRecording", name: t("app.permission.screenRecording"), purpose: t("app.permission.screenRecordingPurpose"), state: result.screenRecording ? "granted" : result.screenRecordingRequested ? "denied" : "missing" },
    ...result.automation.map((target) => ({
      item: target.bundleId,
      name: t("app.permission.automation", { name: target.name }),
      purpose: t(target.bundleId === "com.apple.finder" ? "app.permission.finderPurpose" : "app.permission.systemEventsPurpose"),
      state: (target.status === "granted" || target.status === "denied" || target.status === "notDetermined" ? target.status : "unknown") as PermissionState
    }))
  ];
  settingsPermissionList.replaceChildren(...rows.map((row) => {
    const item = document.createElement("li");
    item.className = "settings-permission-item";
    const lamp = document.createElement("span");
    lamp.className = `agent-lamp ${row.state === "granted" ? "g" : row.state === "unknown" ? "o" : "r"}`;
    lamp.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "settings-permission-text";
    const name = document.createElement("span");
    name.className = "settings-permission-name";
    name.textContent = row.name;
    const purpose = document.createElement("span");
    purpose.className = "settings-permission-purpose";
    purpose.textContent = row.purpose;
    text.append(name, purpose);
    const state = document.createElement("span");
    state.className = `settings-permission-state${row.state === "granted" || row.state === "unknown" ? "" : " bad"}`;
    state.textContent = t(`app.permission.${row.state}`);
    item.append(lamp, text, state);
    // Not asked yet: pop the system prompt now; previously denied: the system won't ask again, so only System Settings works;
    // already authorized ones can also go to System Settings, to turn it off there
    const action = row.state === "missing" ? "app.permission.grant"
      : row.state === "notDetermined" ? "app.permission.grantNow"
        : row.state === "denied" || row.state === "granted" ? "app.permission.openSettings" : undefined;
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "support-secondary";
      button.textContent = t(action);
      button.addEventListener("click", () => {
        button.disabled = true;
        void (row.state === "granted" ? bridge.openPermissionSettings(row.item) : bridge.grantPermission(row.item))
          .catch((error: unknown) => settingsPermissionList.append(permissionNote(describeError(error), true)))
          .finally(() => void renderPermissionChecks());
      });
      item.append(button);
    }
    return item;
  }));
}

settingsPermissionsRecheck.addEventListener("click", () => void renderPermissionChecks());
// After turning on authorization in System Settings and switching back to ADing, automatically recheck without a manual click
window.addEventListener("focus", () => {
  const panel = document.querySelector<HTMLElement>("[data-settings-panel='permissions']");
  if (panel && !panel.hidden && appSettingsDialog.open) void renderPermissionChecks();
});

// When an Agent first fails due to missing "Accessibility" or "Screen Recording" permission, the main process has already shown the system authorization prompt;
// here explain why it's needed and where to allow it.
bridge.onComputerPermissionMissing?.(({ kind }) => {
  const name = kind === "screenRecording" ? t("app.permission.screenRecording") : t("app.permission.accessibility");
  setAgentStatus(t("app.permission.computerMissing", { name }), "error", false);
});
for (const tab of settingsTabs) {
  tab.addEventListener("click", () => showSettingsTab(tab.dataset.settingsTab ?? "permissions"));
}

function openAppSettings(tab = "permissions"): void {
  renderLanguage();
  showSettingsTab(tab);
  void bridge.appInfo()
    .then((info) => { aboutVersion.textContent = t("app.about.version", { version: info.version }); })
    .catch(() => { aboutVersion.textContent = ""; });
  if (!appSettingsDialog.open) appSettingsDialog.showModal();
}
appSettingsEntry.addEventListener("click", () => openAppSettings());
try {
  const reopen = sessionStorage.getItem(REOPEN_SETTINGS_KEY);
  if (reopen) {
    sessionStorage.removeItem(REOPEN_SETTINGS_KEY);
    openAppSettings(reopen);
  }
} catch {
  // If it can't be read, don't auto-open
}
appSettingsClose.addEventListener("click", () => appSettingsDialog.close());
closeOnBackdropClick(appSettingsDialog);

let updateState: AppUpdateState = { phase: "idle" };
/** The user actively clicked check in "About": this result must be reported (automatic checks don't mention "Up to date") */
let updateCheckRequested = false;

function describeUpdateState(state: AppUpdateState): { text: string; error?: boolean } {
  switch (state.phase) {
    case "checking":
      return { text: t("app.update.checking") };
    case "downloading": {
      const received = (state.receivedBytes / 1048576).toFixed(0);
      return {
        text: state.totalBytes
          ? t("app.update.downloadingTotal", { version: state.update.version, received, total: (state.totalBytes / 1048576).toFixed(0) })
          : t("app.update.downloading", { version: state.update.version, received })
      };
    }
    case "ready": {
      const name = t(state.update.gray ? "app.update.nameGray" : "app.update.name", { version: state.update.version });
      if (state.install === "preparing") return { text: t("app.update.verifying", { name }) };
      if (state.install === "restart") return { text: t("app.update.readyRestart", { name }) };
      return { text: state.installNote ? t("app.update.readyManualNote", { name, note: state.installNote }) : t("app.update.readyManual", { name }) };
    }
    case "up-to-date":
      return { text: updateCheckRequested ? t("app.update.upToDate") : "" };
    case "error":
      return updateCheckRequested ? { text: state.message, error: true } : { text: "" };
    default:
      // In dev runs (pnpm start) or with ADING_UPDATE_DISABLED set, update checks aren't enabled
      return { text: updateCheckRequested ? t("app.update.disabled") : "" };
  }
}

const updateReadyDialog = el<HTMLDialogElement>("#update-ready-dialog");
const updateReadyCopy = el<HTMLParagraphElement>("#update-ready-copy");
const updateReadyAction = el<HTMLButtonElement>("#update-ready-action");
/** Each version pops proactively only once; after "Later", the top-right entry and auto-install on quit take over */
let promptedUpdateVersion: string | undefined;
/** Automatic check failures announce the same reason only once, not every 6 hours */
let lastAnnouncedUpdateError: string | undefined;

/**
 * The dialog's text and buttons are determined entirely by the current state, and are redrawn whenever the state changes.
 *
 * Previously it was written only once on first pop; afterwards, when the verification result changed from "Open installer" to "Restart to update", it didn't change,
 * and the user clicked on an already stale message. Verification takes several seconds, and this window is passed through on every upgrade.
 */
function renderUpdateReadyPrompt(state: Extract<AppUpdateState, { phase: "ready" }>): void {
  const restart = state.install === "restart";
  updateReadyCopy.textContent = restart
    ? t(state.update.gray ? "app.update.promptRestartGray" : "app.update.promptRestart", { version: state.update.version })
    : state.installNote
      ? t("app.update.promptManualNote", { version: state.update.version, note: state.installNote })
      : t("app.update.promptManual", { version: state.update.version });
  updateReadyAction.textContent = restart ? t("app.update.restart") : t("app.update.openPackage");
}

/**
 * Previously, after the automatic check downloaded a new version, only a small button was put in the top right, which users never noticed,
 * and it was quietly installed on restart; automatic check failures weren't shown at all. Now a dialog asks once when ready, and failures show the reason at the bottom.
 */
function announceUpdate(state: AppUpdateState): void {
  // For forced upgrades the window blocking the whole UI handles it, so "New version ready" isn't popped separately
  if (state.required) return;
  // Don't pop the dialog while the installer is being verified: whether to say "Restart to update" or "Open installer" isn't decided yet
  if (state.phase === "ready" && state.install !== "preparing") {
    const firstPrompt = promptedUpdateVersion !== state.update.version;
    promptedUpdateVersion = state.update.version;
    renderUpdateReadyPrompt(state);
    if (firstPrompt && !updateReadyDialog.open) updateReadyDialog.showModal();
  }
  if (state.phase === "error" && !updateCheckRequested && state.message !== lastAnnouncedUpdateError) {
    lastAnnouncedUpdateError = state.message;
    // The app-wide bottom notice, visible whichever page is current. Background automatic checks aren't user-initiated,
    // so a plain notice is enough on failure, not an error red box; strip the trailing period from the reason so it doesn't double up with the template's period
    const reason = (state.message ?? "").replace(/[。.．!！\s]+$/u, "");
    setAgentStatus(t("app.update.autoFailed", { message: reason }), "info");
  }
  if (state.phase !== "error") lastAnnouncedUpdateError = undefined;
}

updateReadyAction.addEventListener("click", () => {
  updateReadyDialog.close();
  void runUpdate();
});
el<HTMLButtonElement>("#update-ready-later").addEventListener("click", () => updateReadyDialog.close());
el<HTMLButtonElement>("#update-ready-close").addEventListener("click", () => updateReadyDialog.close());

const updateRequiredDialog = el<HTMLDialogElement>("#update-required-dialog");
const updateRequiredCopy = el<HTMLParagraphElement>("#update-required-copy");
const updateRequiredStatus = el<HTMLParagraphElement>("#update-required-status");
const updateRequiredAction = el<HTMLButtonElement>("#update-required-action");
// The forced-upgrade window can't be closed: Esc does nothing, and clicking the backdrop doesn't close it
updateRequiredDialog.addEventListener("cancel", (event) => event.preventDefault());

/**
 * Forced upgrade: below the required version, the whole UI is blocked, leaving only the update path.
 * Shows progress while the new version isn't downloaded yet; retry is available when the server can't be reached.
 */
function renderUpdateRequired(state: AppUpdateState): void {
  if (!state.required) {
    if (updateRequiredDialog.open) updateRequiredDialog.close();
    return;
  }
  const ready = state.phase === "ready" && state.install !== "preparing";
  const busy = state.phase === "checking" || state.phase === "downloading" || (state.phase === "ready" && state.install === "preparing");
  updateRequiredCopy.textContent = t("app.update.requiredCopy", { version: state.required });
  updateRequiredStatus.textContent = state.phase === "error"
    ? t("app.update.requiredOffline")
    : ready || state.phase === "downloading" ? describeUpdateState(state).text : t("app.update.requiredWaiting");
  updateRequiredAction.disabled = busy;
  updateRequiredAction.textContent = ready
    ? t(state.install === "restart" ? "app.update.restart" : "app.update.openPackage")
    : t("app.update.retry");
  if (updateReadyDialog.open) updateReadyDialog.close();
  if (!updateRequiredDialog.open) updateRequiredDialog.showModal();
}

updateRequiredAction.addEventListener("click", () => {
  if (updateState.phase === "ready" && updateState.install !== "preparing") {
    void runUpdate();
    return;
  }
  renderUpdateState({ ...updateState, phase: "checking" });
  void bridge.checkForUpdates()
    .then(renderUpdateState)
    .catch((error: unknown) => renderUpdateState({ required: updateState.required, phase: "error", message: describeError(error), checkedAt: new Date().toISOString() }));
});

function renderUpdateState(state: AppUpdateState): void {
  updateState = state;
  announceUpdate(state);
  renderUpdateRequired(state);
  const status = describeUpdateState(state);
  updateStatusText.textContent = status.text;
  updateStatusText.classList.toggle("error", Boolean(status.error));
  const busy = state.phase === "checking" || state.phase === "downloading";
  checkUpdateButton.disabled = busy;
  checkUpdateButton.textContent = state.phase === "checking" ? t("app.update.checkingShort") : t("app.update.check");
  const ready = state.phase === "ready" && state.install !== "preparing";
  installUpdateButton.hidden = !ready;
  // Once a new version is detected (downloading or ready), permanently show it in the top right
  updateEntry.hidden = state.phase !== "ready" && state.phase !== "downloading";
  updateEntry.setAttribute("aria-label", state.phase === "ready" || state.phase === "downloading"
    ? t("app.update.entryTo", { version: state.update.version })
    : t("app.update.entry"));
}

async function runUpdate(): Promise<void> {
  const state = updateState;
  if (state.phase !== "ready" || state.install === "preparing") {
    openAppSettings("about");
    return;
  }
  try {
    if (state.install === "restart") {
      await bridge.installUpdate();
    } else {
      await bridge.openUpdatePackage();
    }
  } catch (error) {
    updateStatusText.textContent = describeError(error);
    updateStatusText.classList.add("error");
    openAppSettings("about");
  }
}

checkUpdateButton.addEventListener("click", () => {
  updateCheckRequested = true;
  renderUpdateState({ phase: "checking" });
  void bridge.checkForUpdates()
    .then(renderUpdateState)
    .catch((error: unknown) => renderUpdateState({ phase: "error", message: describeError(error), checkedAt: new Date().toISOString() }))
    // This manual check's result is already shown in the panel; later automatic checks notify by the automatic rules (failures show the reason at the bottom)
    .finally(() => { updateCheckRequested = false; });
});
installUpdateButton.addEventListener("click", () => void runUpdate());
updateEntry.addEventListener("click", () => void runUpdate());

bridge.onUpdateState(renderUpdateState);
void bridge.updateState().then(renderUpdateState).catch(() => undefined);

bridge.onSupportUploadResult((payload) => {
  const developer = payload.target === "developer";
  const target = developer ? supportDeveloperFeedback : supportReportFeedback;
  if (payload.ok) {
    setSupportFeedback(target, developer ? t("app.support.sentDeveloper") : t("app.support.reported"), false);
    return;
  }
  // Permanent failures will keep failing, so the user can no longer be told "will retry automatically".
  setSupportFeedback(
    target,
    payload.permanent
      ? t(developer ? "app.support.sendFailedPermanent" : "app.support.reportFailedPermanent", { error: payload.error ?? t("app.support.serverRejected") })
      : developer
        ? t("app.support.sendRetry")
        : t("app.support.reportRetry"),
    true
  );
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

type AccountDialogMode = "login" | "register";
let accountDialogMode: AccountDialogMode = "login";

/** Shows "Sign in" when not signed in (registration is switched to from the sign-in dialog), "Sign out" when signed in. */
function renderAccount(status: AccountStatus): void {
  accountStatus = status;
  window.dispatchEvent(new Event("ading-account-changed"));
  accountLoginButton.hidden = status.signedIn;
  accountLogoutButton.hidden = !status.signedIn;
  if (friendDialog.open && (!status.signedIn || status.canAddFriend !== true)) friendDialog.close();
  void applyIdentity();
  void refreshLocalComputer();
  void refreshFriendRequests();
}

/** The "me" in the UI after sign-in: keep the local identity ID (tasks, messages and memories are all linked by it), with the profile swapped for the account's */
function identityFrom(local: UserRef, profile: AccountProfileView): UserRef {
  return {
    ...local,
    username: profile.username,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    phone: profile.phone,
    email: profile.email
  };
}

/** Decide which own profile to show in the UI based on current sign-in state. After signing out, restore the standalone edition's original one */
async function applyIdentity(): Promise<void> {
  if (!localMe) return;
  const generation = ++identityGeneration;
  let next = localMe;
  if (accountStatus.signedIn) {
    try {
      const profile = await bridge.accountProfile();
      if (profile) next = identityFrom(localMe, profile);
    } catch {
      // If the account profile can't be read, show the standalone profile first, without affecting use
    }
  }
  if (generation !== identityGeneration) return;
  me = next;
  users.set(next.userId, withLocalizedName(next));
  renderCurrentUserIdentity();
  renderMessages();
  renderConversationList();
  renderHeader();
}

function setAccountMode(next: AccountDialogMode): void {
  accountDialogMode = next;
  const registering = next === "register";
  accountTitle.textContent = registering ? t("app.account.registerTitle") : t("app.account.loginTitle");
  accountSubmit.textContent = registering ? t("app.account.register") : t("app.account.login");
  accountConfirmField.hidden = !registering;
  accountPassword.autocomplete = registering ? "new-password" : "current-password";
  accountSwitchHint.textContent = registering ? t("app.account.haveAccount") : t("app.account.noAccount");
  accountSwitch.textContent = registering ? t("app.account.login") : t("app.account.register");
  accountConfirm.value = "";
  setSupportFeedback(accountFeedback, "");
  // Signing in switches the data session and running agents are stopped immediately; registration doesn't switch, so no prompt
  const running = registering ? 0 : runningAgentCount();
  accountAgentsNotice.hidden = running === 0;
  accountAgentsNotice.textContent = running
    ? t("app.account.loginStopsAgents", { count: running })
    : "";
}

/** Number of running agents: the same agent running in several tasks at once counts as one */
function runningAgentCount(): number {
  const agents = new Set<string>();
  for (const key of busyAgents.keys()) {
    const [, agentUserId] = JSON.parse(key) as [string, string];
    agents.add(agentUserId);
  }
  return agents.size;
}

function openAccountDialog(next: AccountDialogMode): void {
  accountUsername.value = "";
  accountPassword.value = "";
  accountSubmit.disabled = false;
  setAccountMode(next);
  accountDialog.showModal();
  accountUsername.focus();
}

async function submitAccount(): Promise<void> {
  const registering = accountDialogMode === "register";
  if (registering && accountPassword.value !== accountConfirm.value) {
    setSupportFeedback(accountFeedback, t("app.account.passwordMismatch"), true);
    accountConfirm.focus();
    return;
  }
  accountSubmit.disabled = true;
  setSupportFeedback(accountFeedback, registering ? t("app.account.registering") : t("app.account.loggingIn"));
  try {
    const result = registering
      ? await bridge.accountRegister(accountUsername.value, accountPassword.value)
      : await bridge.accountLogin(accountUsername.value, accountPassword.value);
    if (!result.ok) {
      setSupportFeedback(accountFeedback, result.message, true);
      return;
    }
    if (registering) {
      // Registration only creates the account without auto sign-in: go back to the sign-in screen, keep the username, and let the user sign in once with the new password
      const username = accountUsername.value;
      setAccountMode("login");
      accountUsername.value = username;
      accountPassword.value = "";
      setSupportFeedback(accountFeedback, t("app.account.registered"));
      accountPassword.focus();
      return;
    }
    renderAccount(result.status);
    accountDialog.close();
  } catch (error) {
    setSupportFeedback(accountFeedback, describeError(error), true);
  } finally {
    accountSubmit.disabled = false;
  }
}

accountLoginButton.addEventListener("click", () => openAccountDialog("login"));
accountSwitch.addEventListener("click", () =>
  setAccountMode(accountDialogMode === "login" ? "register" : "login")
);
accountClose.addEventListener("click", () => accountDialog.close());
// Clear the password when the dialog closes, so it doesn't linger in the DOM
accountDialog.addEventListener("close", () => {
  accountPassword.value = "";
  accountConfirm.value = "";
});
accountForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAccount();
});
accountLogoutButton.addEventListener("click", async () => {
  const running = runningAgentCount();
  let pending = 0;
  try {
    pending = await bridge.syncPending();
  } catch {
    pending = 0;
  }
  logoutConfirmCopy.textContent =
    t("app.account.logoutConfirm") +
    (pending
      ? t("app.account.logoutPending", { count: pending })
      : "") +
    (running ? t("app.account.logoutStopsAgents", { count: running }) : "");
  logoutConfirmDialog.showModal();
});
logoutConfirmClose.addEventListener("click", () => logoutConfirmDialog.close());
duplicateNameClose.addEventListener("click", () => duplicateNameDialog.close());
duplicateNameKeep.addEventListener("click", () => duplicateNameDialog.close());
duplicateNameRename.addEventListener("click", () => {
  duplicateNameDialog.close();
  const target = duplicateNameTarget && users.get(duplicateNameTarget.userId);
  if (!target) return;
  // Open its detail page directly with the cursor on the name; save after editing -- this uses the existing rename flow instead of a separate one
  openContactDetail(target);
  contactDetailName.focus();
  contactDetailName.select();
});
duplicateNameDialog.addEventListener("close", () => { duplicateNameTarget = null; });
logoutConfirmAction.addEventListener("click", async () => {
  logoutConfirmAction.disabled = true;
  try {
    renderAccount(await bridge.accountLogout());
    logoutConfirmDialog.close();
  } catch (error) {
    setStatus(t("app.account.logoutFailed", { error: describeError(error) }), "error");
  } finally {
    logoutConfirmAction.disabled = false;
  }
});

/** Waiting overlay while switching data sessions. After a full page reload it keeps showing via sessionStorage until the new data is fetched */
const DATA_SWITCH_FLAG = "ading:data-switching";

function showDataSwitch(target: "local" | "account"): void {
  dataSwitchText.textContent = target === "account" ? t("app.account.switchingOnline") : t("app.account.switchingLocal");
  dataSwitchOverlay.hidden = false;
}

bridge.onDataSwitching(({ target }) => {
  dataGeneration++;
  messageHistory.clear();
  renderedMessages.clear();
  temporaryUnreadConversationId = undefined;
  composerDrafts.clear();
  chatNotices.clear();
  failedDrafts.clear();
  input.value = "";
  pendingAttachments = [];
  composerContext = "";
  renderChatNotice();
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
  try {
    sessionStorage.setItem(DATA_SWITCH_FLAG, target);
  } catch {
    // If it can't be stored, show the overlay only on this page
  }
  showDataSwitch(target);
});
// The data layer is already switched: reload the whole UI, clear all old state and refetch (window and app process untouched)
bridge.onDataSwitched(() => location.reload());
bridge.onAccountChanged(renderAccount);

// Update region permissions promptly after switching networks; separate from local-data startup, so network failure doesn't sign out.
async function refreshAccountRegion(): Promise<void> {
  if (!accountStatus.signedIn) return;
  const current = accountStatus;
  const status = await bridge.accountStatus().catch(() => null);
  if (accountStatus !== current) return;
  if (status && JSON.stringify(status) !== JSON.stringify(accountStatus)) renderAccount(status);
}
window.addEventListener("focus", () => void refreshAccountRegion());
window.setInterval(() => void refreshAccountRegion(), 60_000);

async function boot(): Promise<void> {
  let switching: string | null = null;
  try {
    switching = sessionStorage.getItem(DATA_SWITCH_FLAG);
  } catch {
    switching = null;
  }
  if (switching === "local" || switching === "account") showDataSwitch(switching);
  const overlays = new OverlayController();
  overlays.dialogs();
  overlays.panel(processPanel, toggleProcessButton);
  overlays.panel(conversationAgentMenu, conversationAgentMenuButton);
  overlays.panel(conversationSwitcherMenu, conversationSwitcherButton);
  overlays.panel(conversationAddMemberMenu, conversationAddMemberButton);
  overlays.panel(sendModeMenu, sendModeButton);
  overlays.panel(agentPane, agentsEntry);
  applyChatSidebarLayout();
  renderSendMode();
  autoGrowInput();
  // Sign-in state is fetched separately, not tied to the local-data bootstrap: if it can't be fetched, show as signed out
  void bridge.accountStatus().then(renderAccount, () => renderAccount({ signedIn: false }));
  try {
    const activeRevision=windowActiveRevision;
    const payload = await bridge.bootstrap();
    if(activeRevision===windowActiveRevision)appWindowActive=payload.windowActive??true;
    permissionMode=payload.permissionMode ?? "unattended";
    renderPermissionMode();
    runtimeState.restore(payload.runtime);
    if (payload.runtime && payload.runtime.revision > queueRevision) {
      queuedAgents = payload.runtime.queued ?? []; queueRevision = payload.runtime.revision;
    }
    mode = payload.mode;
    localMe = payload.me;
    me = payload.me;
    users.set(payload.me.userId, payload.me);
    renderCurrentUserIdentity();
    replaceContacts(payload.contacts);
    workspaces = payload.workspaces;
    conversations = recentConversations(payload.conversations);
    ensureDefaultConversationDraft();
    renderConversationList();
    renderHeader();
    syncComposer();
    // Sign-in state may be ready before local data, so do the profile switch once more here
    void applyIdentity();
    if (conversations.length) {
      await selectConversation(conversations[0].conversationId, false);
    } else input.focus();
    // Startup sync may happen before the window is ready, so fetch the current failure list once more
    void bridge.knowledgeSyncState?.().then(applyKnowledgeSyncState,()=>undefined);
    // Show the window and cache first, then run one low-priority parallel check.
    startupAgentCheck = refreshAgentsAtStartup().finally(() => {
      startupAgentCheck = null;
      // Only after Agent discovery and checks finish does device telemetry include available Agents
      void bridge.telemetryReady?.().catch(() => undefined);
    });
    // On first use, with no digital employees yet, take people to "Explore Silicon Beings"; this is a required step of first use.
    // Only auto-pop this once: afterwards keep the normal chat page whether or not there are Agent contacts; checks update silently in the background.
    if (!payload.contacts.some((contact) => contact.isAgent) && !agentsIntroShown()) {
      openAgents();
      rememberAgentsIntroShown();
    }
  } catch (error) {
    setStatus(t("app.startup.failed", { error: describeError(error) }), "error");
  }
  dataSwitchOverlay.hidden = true;
  try {
    sessionStorage.removeItem(DATA_SWITCH_FLAG);
  } catch {
    // Ignore
  }
  await refreshPendingBadge();
  bootReady=true;
  installOnboarding(() => accountStatus);
  await openNotificationConversation();
}

const AGENTS_INTRO_KEY = "ading.agents-intro-shown";

/** Whether "Explore Silicon Beings" has already auto-popped. If it can't be stored (private mode etc.), treat it as popped, preferring not to disturb */
function agentsIntroShown(): boolean {
  try {
    return localStorage.getItem(AGENTS_INTRO_KEY) === "true";
  } catch {
    return true;
  }
}

function rememberAgentsIntroShown(): void {
  try {
    localStorage.setItem(AGENTS_INTRO_KEY, "true");
  } catch {
    // Ignore
  }
}

void boot();
