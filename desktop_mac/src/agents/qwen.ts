import os from "node:os";
import path from "node:path";
import { StreamJsonAgent, skillRootMayExist } from "./cli-agent";
import { qwenHome, qwenNativeConfiguration, qwenModelOptions, qwenContextWindow } from "./qwen-config";
import { handshakePrompt, type OneShotAsk } from "./handshake";
import { writeSkillDirs, removeSkillDirs } from "../skills/skill-dir";
import type { SkillTarget } from "../skills/target";
import type { AgentRuntimeConfig, TurnInput } from "./types";
import { p } from "../prompt-language";
import { isolatedHome } from "./isolated-home";

const READ_TOOLS = ["read_file", "list_directory", "glob", "grep_search"];
// Qwen plan mode permits plan-file writes and some shell commands. Explicitly
// remove those and other non-read tools for ADing's stricter read-only turns.
const NON_READ_TOOLS = ["exec", "edit", "write_file", "run_shell_command", "monitor", "notebook_edit",
  "autofix_pr", "todo_write", "save_memory", "manage_memory", "search_memory", "agent", "skill", "exit_plan_mode", "enter_plan_mode",
  "web_fetch", "web_search", "image_gen", "lsp", "ask_user_question", "cron_create", "cron_list", "cron_delete",
  "loop_wakeup", "create_sub_session", "list_agents", "task_stop", "task_create", "task_update", "task_list",
  "team_create", "team_delete", "team_plan_approval", "request_shutdown", "send_message", "structured_output",
  "tool_call", "tool_search", "read_mcp_resource", "advisor", "enter_worktree", "exit_worktree", "workflow",
  "artifact", "record_artifact", "record_source", "report_findings", "get_goal", "update_goal", "propose_goal",
  "display_image", "zoom_image", "omni_*"];

export function qwenProbeArgs(ask: OneShotAsk = { prompt: handshakePrompt() }): string[] {
  return ["--safe-mode", "--chat-recording=false", "--approval-mode", "plan", "--max-tool-calls", "0",
    "--exclude-tools", [...NON_READ_TOOLS, ...READ_TOOLS].join(","), "--output-format", "stream-json", "-p", ask.prompt,
    ...(ask.systemPrompt ? ["--system-prompt", ask.systemPrompt] : [])];
}

export class QwenCodeAdapter extends StreamJsonAgent {
  readonly kind: AgentKind = "qwen-code";
  protected readonly binary = "qwen";
  readonly label = "Qwen Code";
  readonly installHint = "npm install -g @qwen-code/qwen-code";
  get loginHint(): string { return p("运行 qwen，然后使用 /auth 配置模型服务", "Run qwen, then use /auth to configure a model provider"); }
  readonly logoutHint = undefined;
  readonly docsUrl = "https://qwenlm.github.io/qwen-code-docs/en/users/overview/";
  protected readonly noPersistenceFlag = "--chat-recording";

  protected extraCandidates(): string[] {
    return this.desktopAppPaths().map(app => path.join(app, "Contents/Resources/runtime/qwen-code/bin/qwen"));
  }
  protected readNativeConfiguration(_agent: DiscoveredAgent, workspace: string) { return qwenNativeConfiguration(workspace); }
  protected readContextWindow(_agent:DiscoveredAgent,input:TurnInput) { return qwenContextWindow(input.workspacePath,input.runtimeConfig?.model); }
  listModels(): Promise<AgentModelOption[]> { return qwenModelOptions(os.homedir()); }
  // buildArgs below chooses the approval mode itself (plan/default/yolo).
  protected permissionArgs(): string[] { return []; }
  protected usesStreamingInput(): boolean { return true; }
  protected streamPermissionOptions(input: TurnInput) {
    const effort = input.runtimeConfig?.reasoningEffort;
    return { initialize: { hooks: null, ...(effort && effort !== "none" ? { effort } : {}) }, readableTools: READ_TOOLS };
  }

  private readonly settleHomes = new WeakMap<TurnInput, () => Promise<void>>();
  /** QWEN.md and the rules directory have no switch outside --bare, which also drops tools. What this turn remembers stays with this workspace. */
  protected async turnEnvironment(input: TurnInput): Promise<NodeJS.ProcessEnv | undefined> {
    if (!input.isolateMemory) return undefined;
    const home = await isolatedHome(this.kind, qwenHome(), name => ["QWEN.md", "AGENTS.md", "memories", "rules"].includes(name), ["oauth_creds.json"], input.workspacePath);
    this.settleHomes.set(input, home.settle);
    return { ...process.env, QWEN_HOME: home.path, QWEN_CODE_MEMORY_BASE_DIR: path.join(input.workspacePath, ".qwen", "ading-memory") };
  }

  protected async executeTurn(agent: DiscoveredAgent, input: TurnInput): Promise<AgentTurnOutcome> {
    try {
      // The SDK initialize request accepts effort tiers but cannot disable
      // thinking. Never report an ADing "none" override as applied when the
      // native configuration would still enable reasoning.
      const native = await qwenNativeConfiguration(input.workspacePath);
      if (input.runtimeConfig?.reasoningEffort === "none" && native?.reasoningEffort !== "none") {
        throw new Error(p("请先在 Qwen Code 原生配置中关闭推理；当前 SDK 无法应用 none 覆盖值", "Disable reasoning in Qwen Code's native settings first; the current SDK cannot apply a none override"));
      }
      // Repeating the native model with --model makes Qwen ignore model.baseUrl,
      // which disambiguates providers sharing the same model ID. Let Qwen use
      // its own selection when it already matches the effective snapshot.
      const invocation = input.runtimeConfig?.model && input.runtimeConfig.model === native?.model
        ? { ...input, runtimeConfig: { ...input.runtimeConfig, model: undefined } } : input;
      try { return await super.executeTurn(agent, invocation); }
      finally { await this.settleHomes.get(invocation)?.().catch(() => undefined); this.settleHomes.delete(invocation); }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error),
        threadId: input.threadId, steps: [], cancelled: !!input.signal?.aborted,
        metrics: { iterations: 0, sideEffects: false } };
    }
  }

  buildArgs(input: TurnInput, mcpConfig?: string): string[] {
    if (input.runtimeConfig?.fastMode === true || input.runtimeConfig?.serviceTier) {
      throw new Error(p("Qwen Code 没有对应的 Fast 服务参数，请清除该覆盖配置", "Qwen Code has no equivalent Fast service option; clear that override"));
    }
    const restricted = input.discussionOnly || !input.fullAccess;
    let mcp: string | undefined;
    if (mcpConfig) {
      const servers = JSON.parse(mcpConfig).mcpServers;
      mcp = JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([name, raw]) => {
        const { url, type, alwaysLoad, ...server } = raw as Record<string, unknown>;
        return [name, { ...server, httpUrl: url, alwaysLoadTools: alwaysLoad === true }];
      })) });
    }
    return ["--input-format", "stream-json", "--output-format", "stream-json", "--channel=SDK",
      ...(!input.noSessionPersistence ? ["--chat-recording=true"] : input.noPersistFlagMissing ? [] : ["--chat-recording=false"]),
      "--approval-mode", restricted ? "plan" : input.permissionMode === "unattended" ? "yolo" : "default",
      ...(restricted ? ["--safe-mode", "--exclude-tools", [...NON_READ_TOOLS, ...(input.discussionOnly ? READ_TOOLS : [])].join(",")] : []),
      ...(mcp ? ["--mcp-config", mcp] : []),
      ...(input.runtimeConfig?.model ? ["--model", input.runtimeConfig.model] : []),
      ...(input.threadId ? ["--resume", input.threadId] : [])];
  }

  protected async verificationArgs(agent: DiscoveredAgent, cwd: string, help: string, app?: AgentRuntimeConfig, ask?: OneShotAsk): Promise<string[]> {
    for (const flag of ["--safe-mode", "--chat-recording", "--max-tool-calls", "--exclude-tools"]) {
      if (!help.includes(flag)) throw new Error(p(`请更新 Qwen Code：当前版本缺少 ${flag}`, `Update Qwen Code: the current version lacks ${flag}`));
    }
    const config = await this.initializeConfiguration(agent, cwd, app);
    if (config.notice) throw new Error(config.notice);
    const native = await qwenNativeConfiguration(cwd);
    return [...qwenProbeArgs(ask), ...(config.model && config.model !== native?.model ? ["--model", config.model] : [])];
  }

  async resolveSkillTarget(scope: Scope, workspacePath: string): Promise<SkillTarget | null> {
    const base = scope === "workspace" ? workspacePath : qwenHome();
    if (!(await skillRootMayExist(base))) return null;
    const dirPath = scope === "workspace" ? path.join(base, ".qwen", "skills") : path.join(base, "skills");
    return { agentKind: this.kind, scope, style: "skill-dir", dirPath,
      humanNote: p(`同步完整技能包到 ${dirPath}`, `Syncs complete skill packages to ${dirPath}`) };
  }
  async syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]> {
    return target.dirPath ? writeSkillDirs(target.dirPath, skills, { ownerFingerprint: target.ownerFingerprint }) : [];
  }
  async unsyncSkills(target: SkillTarget): Promise<string[]> {
    return target.dirPath ? removeSkillDirs(target.dirPath, { ownerFingerprint: target.ownerFingerprint }) : [];
  }
}
