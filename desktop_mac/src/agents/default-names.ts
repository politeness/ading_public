/**
 * Default names used when newly discovered Agents are registered as contacts. Names the user changed in ADing are unaffected:
 * used only on first registration, then the user's setting applies. Both offline and online registration take names from here for consistency.
 */
export const DEFAULT_AGENT_NAMES: Record<AgentKind, string> = {
  codex: "小c",
  "claude-code": "小cc",
  qoder: "小q",
  "qoder-cn": "小q-cn",
  "qwen-code": "小qw",
  kiro: "小k",
  copilot: "小cp",
  antigravity: "小a"
};

export function defaultAgentName(kind: AgentKind, fallback: string): string {
  return DEFAULT_AGENT_NAMES[kind] ?? fallback;
}

/**
 * Replaced old default names. Agents still using an old default name (not changed by the user) get the new default on registration; changed ones are left alone.
 * Only Chinese default names are stored (English names are substituted only in the UI), so only Chinese names are recognized here.
 */
const LEGACY_AGENT_NAMES: Partial<Record<AgentKind, readonly string[]>> = {
  "qwen-code": ["小千"],
  copilot: ["小航"],
  antigravity: ["小引"]
};

/** Returns the new default name when the name exactly equals an old default of this type, otherwise empty */
export function migratedAgentName(kind: AgentKind | undefined, name: string): string | undefined {
  return kind && LEGACY_AGENT_NAMES[kind]?.includes(name) ? DEFAULT_AGENT_NAMES[kind] : undefined;
}
