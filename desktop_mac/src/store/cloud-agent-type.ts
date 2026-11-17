/**
 * How local agent types are written in the cloud.
 *
 * Registering local agents needs "local → cloud"; syncing agents on other computers needs "cloud → local".
 * Both directions share this one table, so we don't keep two copies and forget one side when adding a new agent.
 */
export const CLOUD_AGENT_TYPE: Record<AgentKind, string> = {
  codex: "CODEX",
  "claude-code": "CLAUDE_CODE",
  qoder: "QODER",
  "qoder-cn": "QODER_CN",
  "qwen-code": "QWEN_CODE",
  kiro: "KIRO", copilot: "COPILOT", antigravity: "ANTIGRAVITY"
};

/** Map a cloud type back to the local one; unrecognized returns empty and the caller skips it */
export function agentKindFromCloud(type: string | undefined): AgentKind | undefined {
  const match = (Object.entries(CLOUD_AGENT_TYPE) as [AgentKind, string][]).find(([, cloud]) => cloud === type);
  return match?.[0];
}
