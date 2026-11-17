/**
 * Where an agent's skills land under a given scope.
 *
 * Must be **detected** by each adapter, never hard-coded —
 * return null when the config directory doesn't exist and skip normally; never create a config directory out of thin air.
 * Real errors like permissions propagate up and must not be confused with "not installed yet".
 */
export interface SkillTarget {
  agentKind: AgentKind;
  scope: Scope;
  /** managed-block: write into a managed block of a Markdown file (like codex's AGENTS.md) */
  style: "managed-block" | "skill-dir";
  /** Absolute path of the target file for managed-block */
  filePath?: string;
  /** Absolute path of the target directory for skill-dir (like Claude Code's skills/) */
  dirPath?: string;
  /** Compatibility rule index in addition to the complete native skill package. */
  compatibilityFilePath?: string;
  /** Explicit handover of an independently verified, byte-identical existing package. */
  ownerFingerprint?: string;
  /** One sentence for the user explaining where it writes and what it affects */
  humanNote: string;
}
