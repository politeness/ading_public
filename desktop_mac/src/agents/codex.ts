import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { access, constants, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import {ExecutionAgent} from "./execution-agent";
import {readCodexConfiguration,readCodexModels,readCodexNativeConfiguration,codexServiceTier} from "./codex-config";
import { removeManagedBlock, writeManagedBlock } from "../skills/block";
import { removeSkillDirs, writeSkillDirs } from "../skills/skill-dir";
import { log, safeArgs } from "../orchestration/diagnostics";
import { skillRootMayExist } from "./cli-agent";
import { ProcessRunner } from "./process-runner";
import { runCodexWithApprovals } from "./codex-app-server";
import { prepareCodexSessionHome, codexSessionConfigArgs, nativeCodexHome } from "./codex-session-home";
import { isolatedHome } from "./isolated-home";
import { AGENT_PROBE_TIMEOUT_MS, cliListsFlag, handshakeArgs, handshakeCommand, handshakeHelp, withHandshakeDirectory, type OneShotAsk } from "./handshake";
import type { SkillTarget } from "../skills/target";
import type { AgentAdapter, AgentRuntimeConfig, SteerInput, SteerResult, TurnInput, VerifyResult } from "./types";
import {recordTokenUsage} from "./token-usage";
import { p } from "../prompt-language";
import { agentLocalUuid } from "../account/machine";
import { desktopAppPaths } from "./desktop-apps";

const execFileAsync = promisify(execFile);

const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CodexAdapter extends ExecutionAgent implements AgentAdapter {
  protected readNativeConfiguration(agent:DiscoveredAgent,workspacePath:string) {
    return readCodexConfiguration(agent,workspacePath);
  }
  readonly kind: AgentKind = "codex";
  readonly cumulativeTokenUsage = true;
  readonly label = "Codex";
  readonly installHint = "npm i -g @openai/codex";
  readonly loginHint = "codex login";
  readonly logoutHint = "codex logout";
  readonly docsUrl = "https://developers.openai.com/codex/cli";

  private readonly runner = new ProcessRunner();
  private readonly activeSteers=new Map<string,(input:SteerInput)=>Promise<SteerResult>>();

  listModels(agent: DiscoveredAgent): Promise<AgentModelOption[]> {
    return withHandshakeDirectory(this.kind, cwd => readCodexModels(agent, cwd));
  }

  async discover(): Promise<DiscoveredAgent[]> {
    const executablePath = await this.findExecutable();
    if (!executablePath) return [];

    let version = p("未知版本", "unknown version");
    try {
      const result = await execFileAsync(executablePath, ["--version"], {
        timeout: 3000
      });
      version = result.stdout.trim() || version;
    } catch {
      // Finding the executable is enough; an unreadable version doesn't block adding the contact
    }

    return [
      {
        // Identity is determined only by "computer UUID + type", not install path or computer name —
        // otherwise a codex upgrade that changes the path would orphan the contact and break all history
        localUuid: await agentLocalUuid("codex"),
        kind: "codex",
        name: "Codex",
        version,
        executablePath,
        nodeName: os.hostname()
      }
    ];
  }

  isBusy(localUuid: string): boolean {
    return this.runner.isBusy(localUuid);
  }

  busyIds(): string[] {
    return this.runner.busyIds();
  }

  waitForExit(timeoutMs: number): Promise<string[]> {
    return this.runner.waitForExit(timeoutMs);
  }

  cancel(localUuid: string): boolean {
    return this.runner.cancel(localUuid);
  }

  steer(localUuid:string,input:SteerInput):Promise<SteerResult>{
    return this.activeSteers.get(localUuid)?.(input)??Promise.resolve({status:"not-ready"});
  }

  protected async executeTurn(agent:DiscoveredAgent,input:TurnInput):Promise<AgentTurnOutcome> {
    const sessions = await prepareCodexSessionHome(input.threadId);
    let memoryHome: Awaited<ReturnType<typeof isolatedHome>> | undefined;
    try {
      if (input.isolateMemory) {
        memoryHome = await isolatedHome("codex", sessions.path,
          name => name === "AGENTS.md" || name === "AGENTS.override.md" || name.startsWith("memories"),
          ["auth.json"], input.workspacePath);
      }
      const home = memoryHome?.path ?? sessions.path;
      return await this.runCodex(agent, input, { ...sessions.env, CODEX_HOME: home, ADING_CODEX_SESSION_HOME: home });
    } finally {
      await memoryHome?.settle().catch(error => log("isolated-home-settle-failed", {kind:"codex", error:String(error)}));
      await sessions.settle().catch(error => log("codex-session-home-settle-failed", {error:String(error)}));
    }
  }

  private async runCodex(agent:DiscoveredAgent,input:TurnInput,env:NodeJS.ProcessEnv):Promise<AgentTurnOutcome> {
    const steps: string[] = [];
    let pendingNarration = "";
    const record = (text: string): void => {
      if (steps[steps.length - 1] !== text) steps.push(text);
      input.onProgress(text);
    };

    const emptyMetrics: TurnMetrics = { iterations: 0, sideEffects: false };
    if (input.threadId && !THREAD_ID_PATTERN.test(input.threadId)) {
      return {
        ok: false,
        error: p("Codex 会话 ID 无效", "Invalid Codex session ID"),
        steps,
        cancelled: false,
        metrics: emptyMetrics
      };
    }
    if (this.runner.isBusy(agent.localUuid)) {
      return {
        ok: false,
        error: p("该 Agent 还有任务在执行", "This Agent still has a task running"),
        steps,
        cancelled: false,
        metrics: emptyMetrics
      };
    }

    if (input.steerable || input.onPermission || input.onKnowledgeTool) {
      return runCodexWithApprovals(this.runner,agent,input,handler=>{
        this.activeSteers.set(agent.localUuid,handler);
        return ()=>{if(this.activeSteers.get(agent.localUuid)===handler)this.activeSteers.delete(agent.localUuid);};
      },env);
    }

    const sandboxOptions = input.fullAccess
      ? ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"]
      : [
          "-c",
          'sandbox_mode="read-only"',
          "-c",
          'approval_policy="never"',
          "--skip-git-repo-check"
        ];

    sandboxOptions.push(...codexSessionConfigArgs(env));

    if (input.communicationOnly) {
      sandboxOptions.push(...["shell_tool", "shell_snapshot", "apps", "plugins", "hooks", "image_generation", "view_image", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser", "sleep_tool", "skill_mcp_dependency_install", "skill_search", "multi_agent", "multi_agent_v2", "goals", "tool_suggest", "code_mode_host"].flatMap(name=>["-c",`features.${name}=false`]),"-c",'web_search="disabled"',"-c","mcp_servers={}");
    }

    if (input.isolateMemory) sandboxOptions.push("-c", "features.memories=false", "-c", "memories.generate_memories=false", "-c", "memories.use_memories=false");
    // Codex reports enabled under-development features as an `error` item on every start.
    sandboxOptions.push("-c", "suppress_unstable_features_warning=true");
    if(input.runtimeConfig?.model)sandboxOptions.push("--model",input.runtimeConfig.model);
    if(input.runtimeConfig?.reasoningEffort)sandboxOptions.push("-c",`model_reasoning_effort=${JSON.stringify(input.runtimeConfig.reasoningEffort)}`);
    const tier=codexServiceTier(input.runtimeConfig);
    if(tier)sandboxOptions.push("-c",`service_tier=${JSON.stringify(tier)}`);

    const ephemeral = !!input.noSessionPersistence && !input.threadId && await cliListsFlag(agent, "--ephemeral");
    if (input.noSessionPersistence && !ephemeral) await log("no-session-persistence-unsupported", { kind: "codex", version: agent.version, flag: "--ephemeral" });
    const args = input.threadId
      ? ["exec", "resume", "--json", ...sandboxOptions, input.threadId, input.prompt]
      : [
          "exec",
          "--json",
          ...(ephemeral ? ["--ephemeral"] : []),
          ...sandboxOptions,
          "--color",
          "never",
          "-C",
          input.workspacePath,
          input.prompt
        ];

    const metrics: TurnMetrics = { iterations: 0, sideEffects: false };
    record(p("正在启动任务", "Starting the task"));
    await log("cli-exec", {
      kind: "codex",
      bin: agent.executablePath,
      args: safeArgs(args.map((arg, index) => index === args.length - 1 ? `<prompt ${input.prompt.length} chars>` : arg)),
      cwd: input.workspacePath
    });
    const run = await this.runner.run(agent.localUuid, {
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      executablePath: agent.executablePath,
      args,
      cwd: input.workspacePath,
      env,
      label: "Codex",
      retainLine: retainCodexLine,
      onLine: (line) => {
        try {
          const event = JSON.parse(line);
          if (event.item && ["item.started", "item.completed"].includes(event.type)) {
            if (event.item.type === "agent_message" && event.type === "item.completed") {
              if (pendingNarration) record(p(`进展：${pendingNarration}`, `Progress: ${pendingNarration}`));
              pendingNarration = event.item.text ?? "";
            } else if (event.item.type !== "agent_message") {
              if (pendingNarration) { record(p(`进展：${pendingNarration}`, `Progress: ${pendingNarration}`)); pendingNarration = ""; }
              if(event.item.type==="error")void log("codex-item-error",{message:String(event.item.message ?? "").slice(0,500)});
              input.onAudit?.({id:event.item.id,kind:event.item.type ?? "unknown",phase:event.type,failed:event.item.status==="failed"});
            }
          }
        } catch { /* not an event line */ }
        countMetrics(line, metrics);
        const description = describeEvent(line);
        if (description) record(description);
      }
    });
    const parsed = this.parseOutput(run.stdout, input.threadId);

    if (run.cancelled) {
      return {
        ok: false,
        threadId: parsed.threadId,
        error: p("任务已停止", "The task was stopped"),
        steps,
        cancelled: true,
        metrics
      };
    }
    if (run.failure || parsed.error) {
      await log("cli-failed", {
        kind: "codex",
        failure: run.failure.slice(0, 500),
        reported: parsed.error?.slice(0, 500),
        stderr: run.stderr.slice(-800),
        stdoutBytes: Buffer.byteLength(run.stdout)
      });
      return {
        ok: false,
        threadId: parsed.threadId,
        error: p(`Codex 回复失败：${parsed.error || run.failure}`, `Codex reply failed: ${parsed.error || run.failure}`),
        partialMessage: parsed.message,
        steps,
        cancelled: false,
        metrics
      };
    }
    if (!parsed.completed || !parsed.threadId || !parsed.message) {
      return {
        ok: false,
        threadId: parsed.threadId,
        error: p("Codex 返回的数据不完整，请重试", "Codex returned incomplete data; please try again"),
        partialMessage: parsed.message,
        steps,
        cancelled: false,
        metrics
      };
    }

    return {
      ok: true,
      threadId: parsed.threadId,
      message: parsed.message,
      steps,
      metrics
    };
  }

  /**
   * Ask once, get one answer, leave no trace. Same path as the connectivity check: codex exec with --ephemeral,
   * so the session isn't saved and won't appear in the Codex app's own history.
   */
  async askOnce(agent: DiscoveredAgent, prompt: string): Promise<VerifyResult> {
    return this.oneShot(agent, { prompt });
  }

  /** Authentication handshake only; the normal task execution profile stays unchanged. */
  async verify(agent: DiscoveredAgent): Promise<VerifyResult> {
    return this.oneShot(agent);
  }

  private async oneShot(agent: DiscoveredAgent, ask?: OneShotAsk): Promise<VerifyResult> {
    return withHandshakeDirectory(this.kind, async cwd => {
      const help = await handshakeHelp(agent.executablePath, this.kind, cwd);
      const args = ask ? handshakeArgs(this.kind, cwd, help, ask) : handshakeArgs(this.kind, cwd, help);
      const config = await readCodexNativeConfiguration(agent, cwd);
      // Empty TOML tables merge with config.toml, so disable named servers explicitly.
      // Only names enter arguments; provider headers/credentials remain in native config.
      const disabledServers = Object.keys(config.mcp_servers ?? {}).map(name =>
        `${JSON.stringify(name)}={enabled=false}`).join(",");
      args.splice(1, 0, "-c", `mcp_servers={${disabledServers}}`);
      const sessions = await prepareCodexSessionHome();
      args.splice(1, 0, ...codexSessionConfigArgs(sessions.env));
      try {
        const run = await this.runner.run(`${agent.localUuid}::verify`, {
          ...handshakeCommand(agent.executablePath, args),
          cwd,
          env: sessions.env,
          label: "Codex",
          backgroundPriority: true,
          timeoutMs: ask ? 60_000 : AGENT_PROBE_TIMEOUT_MS,
          onLine: () => undefined
        });
        const parsed = this.parseOutput(run.stdout);
        if (parsed.message && !run.failure) {
          // The 200-character cap is for the connectivity check display; a question asked through askOnce needs the full answer.
          return { ok: true, text: ask ? parsed.message : parsed.message.slice(0, 200) };
        }
        return {
          ok: false,
          text: parsed.error || run.failure || run.stderr || p("没有拿到回复", "No reply was received")
        };
      } finally { await sessions.settle(); }
    });
  }

  // -------------------------------------------------------------------------
  // Skill sync
  // -------------------------------------------------------------------------

  /**
   * codex reads "one whole rules document" rather than a multi-file skill library, so the target is a managed block in AGENTS.md.
   *
   * global goes to ~/.codex/AGENTS.md — note this affects the user's direct use of codex outside ADing,
   * so this scope must be explicitly enabled by the user, stated clearly in humanNote.
   * If ~/.codex isn't detected, return null; never create the directory from scratch.
   */
  async resolveSkillTarget(scope: Scope, workspacePath: string): Promise<SkillTarget | null> {
    const home = nativeCodexHome();
    const base = scope === "workspace" ? workspacePath : home;
    if (!(await skillRootMayExist(base))) return null;
    const dirPath = scope === "workspace" ? path.join(base, ".codex", "skills") : path.join(base, "skills");
    return { agentKind: "codex", scope, style: "skill-dir", dirPath,
      compatibilityFilePath: path.join(base, "AGENTS.md"),
      humanNote: p(`同步完整技能包到 ${dirPath}`, `Syncs complete skill packages to ${dirPath}`) };
  }

  async syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]> {
    if (target.style === "managed-block" && target.filePath) {
      await writeManagedBlock(target.filePath, skills, { ownerFingerprint: target.ownerFingerprint }); return [target.filePath];
    }
    if (!target.dirPath) return [];
    return writeSkillDirs(target.dirPath, skills, { ownerFingerprint: target.ownerFingerprint });
  }

  async unsyncSkills(target: SkillTarget): Promise<string[]> {
    const cleared = target.dirPath ? await removeSkillDirs(target.dirPath, { ownerFingerprint: target.ownerFingerprint }) : [];
    const file = target.compatibilityFilePath ?? target.filePath;
    if (file && await removeManagedBlock(file, { ownerFingerprint: target.ownerFingerprint })) cleared.push(file);
    return cleared;
  }

  // -------------------------------------------------------------------------

  private candidatePaths(): string[] {
    const fromPath = (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "codex"));

    return [
      // Since ChatGPT 0.158 the bundled codex moved to Resources/codex-cli/bin/ (the entry is a forwarding script); the old location remains for older versions
      ...desktopAppPaths("codex").flatMap(app => [
        path.join(app, "Contents/Resources/codex-cli/bin/codex"),
        path.join(app, "Contents/Resources/codex")
      ]),
      path.join(os.homedir(), ".local/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      ...fromPath
    ];
  }

  private async findExecutable(): Promise<string | null> {
    const checked = new Set<string>();
    for (const candidate of this.candidatePaths()) {
      try {
        await access(candidate, constants.X_OK);
        const resolved = await realpath(candidate);
        if (checked.has(resolved)) continue;
        checked.add(resolved);
        return resolved;
      } catch {
        // Try the next common install location
      }
    }
    return null;
  }

  /** Parse only, don't judge completeness — on failure the threadId obtained so far must still be returned */
  private parseOutput(
    output: string,
    previousThreadId?: string
  ): { threadId?: string; message?: string; error?: string; completed: boolean } {
    let threadId = previousThreadId;
    let message = "";
    let error: string | undefined;
    let completed = false;

    for (const line of output.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string };
          error?: string | { message?: string };
          message?: string;
        };
        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        }
        if (event.type === "turn.completed") { completed = true; error = undefined; }
        if (event.type === "turn.failed") completed = false;
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          event.item.text
        ) {
          // The CLI's last segment is the final deliverable; earlier agent_message items are progress.
          message = event.item.text;
        }
        if (event.type === "turn.failed" || event.type === "error") {
          error =
            (typeof event.error === "string" ? event.error : event.error?.message) ??
            event.message ??
            p("执行失败", "Execution failed");
        }
      } catch {
        // codex mixes in non-JSON logs; accept only valid JSONL events
      }
    }

    return { threadId, message: message || undefined, error, completed };
  }
}

/** Translates codex JSONL events into human-readable text */
function describeEvent(line: string): string | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      item?: { type?: string; command?: string; name?: string; tool?: string };
    };
    if (event.type === "thread.started") return p("已连接到 Codex", "Connected to Codex");
    if (event.type === "turn.started") return p("正在理解任务", "Understanding the task");
    if (event.type === "turn.completed") return p("正在整理结果", "Organizing the results");
    if (event.type === "turn.failed" || event.type === "error") {
      return p("执行过程中遇到问题", "Ran into a problem during execution");
    }
    if (event.type !== "item.started" || !event.item?.type) return null;

    const itemType = event.item.type;
    if (itemType === "command_execution") {
      const command = event.item.command?.replace(/\s+/g, " ").slice(0, 70);
      return command ? p(`正在执行命令：${command}`, `Running command: ${command}`) : p("正在执行命令", "Running a command");
    }
    if (itemType === "file_change") return p("正在处理文件", "Working on files");
    if (itemType === "mcp_tool_call") {
      const toolName = event.item.name ?? event.item.tool;
      return toolName ? p(`正在使用工具：${toolName}`, `Using tool: ${toolName}`) : p("正在使用工具", "Using a tool");
    }
    if (itemType === "web_search") return p("正在搜索资料", "Searching for information");
    if (itemType === "plan") return p("正在规划任务", "Planning the task");
    if (itemType === "reasoning") return p("正在分析", "Analyzing");
    if (itemType.includes("computer")) return p("正在操作电脑", "Operating the computer");
    return p("正在执行任务", "Working on the task");
  } catch {
    return null;
  }
}

/** Measures this turn's size and side effects, to judge whether it's worth turning into a skill */
function countMetrics(line: string, metrics: TurnMetrics): void {
  if (!line.trim().startsWith("{")) return;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      item?: { type?: string };
      usage?: Record<string,unknown>;
    };
    if(event.type==="turn.completed"&&event.usage)recordTokenUsage(metrics,event.usage);
    if (event.type === "item.completed") metrics.iterations += 1;
    const itemType = event.item?.type;
    if (itemType === "command_execution" || itemType === "file_change") {
      metrics.sideEffects = true;
    }
  } catch {
    // Ignore non-JSON lines
  }
}

/** Keep the answer and session; don't accumulate large fields like command output or images. */
export function retainCodexLine(line: string): string | undefined {
  try {
    const e = JSON.parse(line);
    if (e.type === "thread.started") return JSON.stringify({type:e.type,thread_id:e.thread_id});
    if (e.type === "turn.completed") return JSON.stringify({type:e.type});
    if (e.type === "item.completed" && e.item?.type === "agent_message") return JSON.stringify({type:e.type,item:{type:e.item.type,text:e.item.text}});
    if (["turn.failed","error"].includes(e.type)) return JSON.stringify({type:e.type,error:e.error,message:e.message});
  } catch { /* ignore non-event lines */ }
  return undefined;
}
