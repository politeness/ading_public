import path from "node:path";

/**
 * Translates "which workspace this conversation belongs to" into the two things the orchestrator actually needs:
 * which directory the agent works in, and whether it can see the workspace layer's shared knowledge.
 *
 * Extracted separately because the rules for these two easily scatter: one place checks kind, another checks whether path exists,
 * yet another checks whether quick conversations should inject facts — change one and miss another. Centralizing here also makes it testable.
 */
export interface WorkspaceResolution {
  /** The agent's cwd for this turn */
  workspacePath: string;
  /**
   * Whether this conversation can read and write workspace-level skills and facts.
   *
   * "Quick" is false — the conversations under it are entirely unrelated,
   * and injecting A's facts into B is "different tasks bleeding into each other", just via another path.
   */
  sharesKnowledge: boolean;
  /** When sharesKnowledge is true, skills and facts hang under this id */
  knowledgeOwnerId?: string;
}

/**
 * @param scratchRoot Root of temporary directories for quick conversations. Each conversation has its own slot under it,
 *   not a shared directory — two unrelated things sharing a working directory would overwrite each other's files.
 */
export function resolveWorkspace(
  conversation: Pick<Conversation, "conversationId" | "workspacePath">,
  workspace: Workspace | null,
  scratchRoot: string
): WorkspaceResolution {
  if (workspace && workspace.kind === "folder" && workspace.path) {
    return {
      // workspacePath on the conversation is an override: set only when a conversation should run in a subdirectory
      workspacePath: conversation.workspacePath ?? workspace.path,
      sharesKnowledge: true,
      knowledgeOwnerId: workspace.workspaceId
    };
  }
  return {
    workspacePath:
      conversation.workspacePath ??
      path.join(scratchRoot, conversation.conversationId),
    sharesKnowledge: false
  };
}

/** Memory scopes injected into the prompt. Order is the injection order: person → project → this conversation */
export function memoryScopesFor(
  resolution: WorkspaceResolution,
  userId: string,
  conversationId: string
): Array<{ scope: MemoryScope; ownerId: string; label: string }> {
  const scopes: Array<{ scope: MemoryScope; ownerId: string; label: string }> = [
    { scope: "user", ownerId: userId, label: "user" }
  ];
  if (resolution.sharesKnowledge && resolution.knowledgeOwnerId) {
    scopes.push({
      scope: "workspace",
      ownerId: resolution.knowledgeOwnerId,
      label: "workspace"
    });
  }
  scopes.push({
    scope: "conversation",
    ownerId: conversationId,
    label: "conversation"
  });
  return scopes;
}

/** File links use the same working directory as the Agent, never the app cwd. */
export function resolveArtifactPath(target: string, resolution?: WorkspaceResolution): string | null {
  if (!target || target.includes("\0") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (path.isAbsolute(target)) return target;
  return resolution ? path.resolve(resolution.workspacePath, target) : null;
}
