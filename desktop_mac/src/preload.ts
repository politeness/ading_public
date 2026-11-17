import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * The only channel between the renderer and the main process.
 * This file must be self-contained: preload under sandbox can't require local modules.
 */
contextBridge.exposeInMainWorld("ading", {
  listPage: (kind: string, ids: string[]) => ipcRenderer.invoke("lists:page", kind, ids),
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  onWindowActive:(callback:(active:boolean)=>void)=>{ipcRenderer.on("app:window-active",(_e,active)=>callback(active));},
  onOpenFriendRequests:(callback:()=>void)=>{ipcRenderer.on("app:open-friend-requests",()=>callback());},
  onOpenConversation:(callback:(conversationId:string)=>void)=>{ipcRenderer.on("app:open-conversation",(_e,id)=>callback(id));},
  getPermissionMode: () => ipcRenderer.invoke("permissions:get-mode"),
  setPermissionMode: (mode:string) => ipcRenderer.invoke("permissions:set-mode",mode),
  getKeepAwake: () => ipcRenderer.invoke("power:get-keep-awake"),
  setKeepAwake: (enabled: boolean) => ipcRenderer.invoke("power:set-keep-awake", enabled),
  revealArtifact: (target: string, conversationId?: string) => ipcRenderer.invoke("app:reveal-artifact", target, conversationId),
  linkPreview: (url: string) => ipcRenderer.invoke("app:link-preview", url),
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),

  onboardingProgress: (completedSteps?: number) => ipcRenderer.invoke("account:onboarding", completedSteps),
  accountStatus: () => ipcRenderer.invoke("account:status"),
  accountComputer: () => ipcRenderer.invoke("account:computer"),
  checkPermissions: () => ipcRenderer.invoke("permissions:check"),
  grantPermission: (item: string) => ipcRenderer.invoke("permissions:grant", item),
  openPermissionSettings: (item: string) => ipcRenderer.invoke("permissions:open-settings", item),
  accountLogin: (username: string, password: string) =>
    ipcRenderer.invoke("account:login", username, password),
  accountRegister: (username: string, password: string) =>
    ipcRenderer.invoke("account:register", username, password),
  accountLogout: () => ipcRenderer.invoke("account:logout"),
  syncPending: () => ipcRenderer.invoke("sync:pending"),
  accountProfile: () => ipcRenderer.invoke("account:profile"),
  updateAccountProfile: (patch: unknown) => ipcRenderer.invoke("account:update-profile", patch),
  changeAccountPassword: (current: string, next: string) =>
    ipcRenderer.invoke("account:change-password", current, next),
  onAccountChanged: (callback: (status: unknown) => void) => {
    ipcRenderer.on("account:changed", (_e, status) => callback(status));
  },
  onDataSwitching: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("data:switching", (_e, payload) => callback(payload));
  },
  onDataSwitched: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("data:switched", (_e, payload) => callback(payload));
  },

  captureSupportScreenshot: () =>
    ipcRenderer.invoke("support:capture-screenshot"),
  submitSupportReport: (input: unknown) =>
    ipcRenderer.invoke("support:submit-report", input),
  contactDeveloper: (input: unknown) =>
    ipcRenderer.invoke("support:contact-developer", input),

  appInfo: () => ipcRenderer.invoke("app:info"),
  setLanguage: (language: string) => ipcRenderer.invoke("app:set-language", language),
  telemetryReady: () => ipcRenderer.invoke("telemetry:ready"),
  updateState: () => ipcRenderer.invoke("updates:state"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  openUpdatePackage: () => ipcRenderer.invoke("updates:open-package"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: (callback: (state: unknown) => void) => {
    ipcRenderer.on("update:state", (_e, state) => callback(state));
  },
  onComputerPermissionMissing: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("computer:permission-missing", (_e, payload) => callback(payload));
  },

  enableAgentSetup: (kind: string) =>
    ipcRenderer.invoke("agents:enable-setup", kind),

  agentCatalog: (refresh = false) => ipcRenderer.invoke("agents:catalog", refresh),
  verifyAgent: (kind: string) => ipcRenderer.invoke("agents:verify", kind),
  refreshAgentStatus: (userId: string) => ipcRenderer.invoke("agents:refresh-one", userId),
  agentAuthStatus: (kind: string) =>
    ipcRenderer.invoke("agents:auth-status", kind),
  installAgent: (kind: string, confirmed: boolean) =>
    ipcRenderer.invoke("agents:install", kind, confirmed),
  loginAgent: (kind: string, confirmed: boolean) =>
    ipcRenderer.invoke("agents:login", kind, confirmed),
  cancelAgentLifecycle: (kind: string, action: string) =>
    ipcRenderer.invoke("agents:cancel-lifecycle", kind, action),
  setAgentAdded: (kind: string, added: boolean) =>
    ipcRenderer.invoke("agents:set-added", kind, added),
  agentModelCatalog: (userId: string) => ipcRenderer.invoke("agents:model-catalog", userId),
  setAgentModel: (userId: string, modelId: string | null) => ipcRenderer.invoke("agents:set-model", userId, modelId),
  updateAgent: (userId: string, patch: unknown) =>
    ipcRenderer.invoke("agents:update", userId, patch),
  updateContact: (userId: string, patch: unknown) =>
    ipcRenderer.invoke("contacts:update", userId, patch),
  listContacts: () => ipcRenderer.invoke("contacts:list"),
  deleteContact: (userId: string) => ipcRenderer.invoke("contacts:delete", userId),
  shareAgent: (agentId: string, recipientId: string, shared: boolean) => ipcRenderer.invoke("friends:share-agent", agentId, recipientId, shared),
  listFriendRequests: () => ipcRenderer.invoke("friends:requests"),
  searchPeople: (query: string) => ipcRenderer.invoke("friends:search", query),
  requestFriend: (userId: string) => ipcRenderer.invoke("friends:request", userId),
  acceptFriend: (userId: string) => ipcRenderer.invoke("friends:accept", userId),
  dismissFriendRequest: (userId: string) => ipcRenderer.invoke("friends:dismiss", userId),
  cancelAgent: (agentUserId: string) =>
    ipcRenderer.invoke("agents:cancel", agentUserId),

  listWorkspaces: () => ipcRenderer.invoke("workspaces:list"),
  createWorkspace: (input: unknown) =>
    ipcRenderer.invoke("workspaces:create", input),
  updateWorkspace: (workspaceId: string, patch: unknown) =>
    ipcRenderer.invoke("workspaces:update", workspaceId, patch),
  deleteWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke("workspaces:delete", workspaceId),
  pickWorkspace: () => ipcRenderer.invoke("workspaces:pick"),

  listConversations: () => ipcRenderer.invoke("conversations:list"),
  getConversation: (id: string) => ipcRenderer.invoke("conversations:get", id),
  createConversation: (input: unknown) =>
    ipcRenderer.invoke("conversations:create", input),
  addMember: (id: string, userId: string, role: string) =>
    ipcRenderer.invoke("conversations:add-member", id, userId, role),
  setMemberRole: (id: string, userId: string, role: string) =>
    ipcRenderer.invoke("conversations:set-role", id, userId, role),
  reportConversation: (id: string) => ipcRenderer.invoke("conversations:report", id),
  removeMember: (id: string, userId: string) =>
    ipcRenderer.invoke("conversations:remove-member", id, userId),
  updateConversation: (id: string, patch: unknown) =>
    ipcRenderer.invoke("conversations:update", id, patch),
  deleteConversation: (id: string) => ipcRenderer.invoke("conversations:delete", id),
  stopConversation: (id: string) => ipcRenderer.invoke("conversations:stop", id),
  listStoppedConversations: () => ipcRenderer.invoke("conversations:stopped"),
  resumeConversation: (id: string) => ipcRenderer.invoke("conversations:resume", id),
  archiveConversation: (id: string, keep: unknown) =>
    ipcRenderer.invoke("conversations:archive", id, keep),

  listMessages: (conversationId: string, options?: unknown) =>
    ipcRenderer.invoke("messages:list", conversationId, options),
  sendMessage: (input: unknown) => ipcRenderer.invoke("messages:send", input),
  markRead: (conversationId: string, seq: number) =>
    ipcRenderer.invoke("messages:mark-read", conversationId, seq),

  pickAttachments: () => ipcRenderer.invoke("attachments:pick"),
  importAttachmentPaths: (paths: string[]) =>
    ipcRenderer.invoke("attachments:import-paths", paths),
  importAttachmentData: (name: string, mimeType: string, bytes: Uint8Array) =>
    ipcRenderer.invoke("attachments:import-data", name, mimeType, bytes),
  openAttachment: (conversationId: string | null, attachment: unknown) =>
    ipcRenderer.invoke("attachments:open", conversationId, attachment),
  saveAttachment: (conversationId: string | null, attachment: unknown) =>
    ipcRenderer.invoke("attachments:save", conversationId, attachment),
  // Files dragged in have no path in the renderer (sandbox), so convert them in preload
  pathForFile: (file: File) => webUtils.getPathForFile(file),

  listSkills: (refs?: unknown) => ipcRenderer.invoke("skills:list", refs),
  importSkill: (input:unknown)=>ipcRenderer.invoke("skills:import",input),
  retryKnowledgeSync:()=>ipcRenderer.invoke("skills:retry-sync"),
  knowledgeSyncState:()=>ipcRenderer.invoke("skills:sync-state"),
  createSkill: (input: unknown) => ipcRenderer.invoke("skills:create", input),
  updateSkill: (skillId: string, patch: unknown) =>
    ipcRenderer.invoke("skills:update", skillId, patch),
  deleteSkill: (skillId: string) => ipcRenderer.invoke("skills:delete", skillId),
  listProposals: (states?: unknown) =>
    ipcRenderer.invoke("skills:list-proposals", states),
  resolveProposal: (proposalId: string, accept: boolean) =>
    ipcRenderer.invoke("skills:resolve-proposal", proposalId, accept),
  syncSkills: (conversationId: string, alsoWriteUserLevel?: boolean) =>
    ipcRenderer.invoke("skills:sync", conversationId, alsoWriteUserLevel),
  unsyncSkills: (conversationId: string) =>
    ipcRenderer.invoke("skills:unsync", conversationId),

  listMemories: (scope: string, ownerId: string, limit?: number) =>
    ipcRenderer.invoke("memories:list", scope, ownerId, limit),
  appendMemory: (input: unknown) => ipcRenderer.invoke("memories:append", input),
  updateMemory: (memoryId: string, patch: unknown) =>
    ipcRenderer.invoke("memories:update", memoryId, patch),
  deleteMemory: (memoryId: string) =>
    ipcRenderer.invoke("memories:delete", memoryId),

  onStoreEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.on("store:event", (_e, payload) => callback(payload));
  },
  onKnowledgeSyncState:(callback:(payload:unknown)=>void)=>{
    ipcRenderer.on("knowledge:sync-state",(_event,payload)=>callback(payload));
  },
  onAgentProgress: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("agent:progress", (_e, payload) => callback(payload));
  },
  onAgentQueue: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("agent:queue", (_e, payload) => callback(payload));
  },
  onAgentBusy: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("agent:busy", (_e, payload) => callback(payload));
  },
  onAgentLifecycleProgress: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("agent:lifecycle-progress", (_e, payload) => callback(payload));
  },
  onSupportUploadResult: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("support:upload-result", (_e, payload) => callback(payload));
  }
});
