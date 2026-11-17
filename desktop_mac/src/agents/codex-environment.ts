/**
 * Session-level variables the Codex desktop host injects into child processes.
 *
 * If ADing itself happens to be launched by a Codex/ChatGPT dev task, it inherits these too. Passing them on
 * to "Cody" would make the new Codex CLI think it still belongs to the outer session and take the wrong backend
 * route. Variables that are real user config, like CODEX_HOME, must be kept, so only explicit host state is removed here.
 */
export const CODEX_HOST_CONTEXT_ENV_KEYS = [
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_CI",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_MCP_NODE_PATH",
  "CODEX_PERMISSION_PROFILE",
  "CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE",
  "CODEX_SESSION_ID",
  "CODEX_SHELL",
  "CODEX_THREAD_ID"
] as const;

export function codexChildEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of CODEX_HOST_CONTEXT_ENV_KEYS) delete environment[key];
  return environment;
}
