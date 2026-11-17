import os from "node:os";
import path from "node:path";
import { removeTree } from "../platform/remove-tree";
import { makeScratchDirectory } from "./scratch";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { p } from "../prompt-language";

/** Maximum wait for one Explore Silicon Folks connection probe. */
export const AGENT_PROBE_TIMEOUT_MS = 4 * 60_000;

const exec = promisify(execFile);
export function handshakePrompt(): string {
  return p("这是连接检测。只回复 OK，不要读取文件、调用工具、启动应用或执行其他操作。", "This is a connection check. Reply only OK; don't read files, call tools, launch apps or do anything else.");
}

/** Deny protected personal locations before macOS TCC can prompt for them.
 * This applies only to health checks, not to user-requested Agent tasks. */
export function handshakeCommand(executablePath: string, args: string[], platform = process.platform, home = os.homedir()): { executablePath: string; args: string[] } {
  if (platform !== "darwin") return { executablePath, args };
  const canonicalHome = realpathSync(home);
  const protectedPaths = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music",
    "Library/Containers", "Library/Group Containers", "Library/Mail", "Library/Messages", "Library/Safari"];
  const rules = protectedPaths.map(relative => `(subpath ${JSON.stringify(path.join(canonicalHome, relative))})`).join(" ");
  const profile = `(version 1)(allow default)(deny file-read* file-write* ${rules})(deny appleevent-send)`;
  return { executablePath: "/usr/bin/sandbox-exec", args: ["-p", profile, executablePath, ...args] };
}

/** Only the probe uses this directory; never change the user's HOME or saved configuration. */
export async function withHandshakeDirectory<T>(kind: AgentKind, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await makeScratchDirectory("handshake", kind);
  try { return await run(directory); }
  finally { await removeTree(directory); }
}

export async function handshakeHelp(executable: string, kind: AgentKind, cwd: string, helpArgs = kind === "codex" ? ["exec", "--help"] : ["--help"]): Promise<string> {
  const command = handshakeCommand(executable, helpArgs);
  const { stdout } = await exec(command.executablePath, command.args, { cwd, timeout: 5000, maxBuffer: 256 * 1024 });
  return stdout;
}

const helpTexts = new Map<string, string>();

/** Users run any CLI version, and an unknown flag aborts the whole turn: pass optional flags only when --help lists them.
 * Help is cached per build. An unreadable help counts as not listed and is read again next time. */
export async function cliListsFlag(agent: DiscoveredAgent, flag: string, helpArgs?: string[]): Promise<boolean> {
  const key = JSON.stringify([agent.executablePath, agent.version, helpArgs]);
  let help = helpTexts.get(key);
  if (help === undefined) {
    try { help = await withHandshakeDirectory(agent.kind, cwd => handshakeHelp(agent.executablePath, agent.kind, cwd, helpArgs)); }
    catch { return false; }
    helpTexts.set(key, help);
  }
  return help.includes(flag);
}

/**
 * The question for a one-off call. Defaults to the connectivity check; "ask once, leave no trace" calls like task naming
 * pass their own content and share the same no-persistence flags, so each vendor needn't reimplement them.
 */
export interface OneShotAsk {
  prompt: string;
  /** The three non-codex vendors accept a separate system instruction; codex exec has no such entry, so it's merged into the prompt */
  systemPrompt?: string;
}

/** Unsupported safe flags must not silently fall back to a full Agent session. */
export function handshakeArgs(kind: AgentKind, cwd: string, help: string, ask: OneShotAsk = { prompt: handshakePrompt(), systemPrompt: "You are a connection health check. Reply only OK. Do not use tools." }): string[] {
  const required = kind === "codex"
    ? ["--ephemeral"]
    : ["--tools", "--strict-mcp-config", "--setting-sources", "--no-session-persistence"];
  for (const flag of required) {
    if (!help.includes(flag)) throw new Error(p(`当前 CLI 不支持轻量检测（缺少 ${flag}），请更新 CLI`, `The current CLI doesn't support the lightweight check (missing ${flag}); please update the CLI`));
  }
  if (kind === "codex") {
    // Preserve provider/auth routing from the user's config. The caller disables
    // each configured MCP server (an empty table would merge, not replace it).
    return ["exec", "--json", "--ephemeral", "--skip-git-repo-check",
      "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"',
      ...["shell_tool", "shell_snapshot", "apps", "plugins", "hooks", "memories", "skill_mcp_dependency_install",
        "image_generation", "view_image", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
        "in_app_browser", "sleep_tool", "skill_search", "multi_agent", "multi_agent_v2", "goals", "tool_suggest", "code_mode_host"
      ].flatMap(name => ["-c", `features.${name}=false`]),
      "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"', "-c", "notify=[]",
      "--color", "never", "-C", cwd, ask.prompt];
  }
  const claude = kind === "claude-code";
  const settings = claude ? { disableAllHooks: true } : {
    disableAllHooks: true, enabledPlugins: {}, ide: { enabled: false },
    agentsMdExcludes: ["**/*"], experimental: { enableAgents: false },
    privacy: { usageStatisticsEnabled: false }
  };
  return ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "", "--settings", JSON.stringify(settings), "--no-session-persistence",
    ...(claude ? ["--no-chrome", "--disable-slash-commands", ...(help.includes("--safe-mode") ? ["--safe-mode"] : [])] : ["--cwd", cwd]),
    "--permission-mode", claude ? "dontAsk" : "dont_ask",
    ...(ask.systemPrompt ? ["--system-prompt", ask.systemPrompt] : []),
    "-p", ask.prompt, "--output-format", "stream-json", ...(claude ? ["--verbose"] : [])];
}
