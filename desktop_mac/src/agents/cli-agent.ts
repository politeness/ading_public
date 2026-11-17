import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { access, constants, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { log, safeArgs } from "../orchestration/diagnostics";
import { StreamPermissions } from "./stream-permissions";
import { ProcessRunner } from "./process-runner";
import { ToolLoopGuard } from "./tool-loop-guard";
import { AGENT_PROBE_TIMEOUT_MS, cliListsFlag, handshakeArgs, handshakeCommand, handshakeHelp, withHandshakeDirectory, type OneShotAsk } from "./handshake";
import {
  countStreamMetrics,
  describeStreamEvent,
  parseStreamJson,
  retainStreamLine
} from "./stream-json";
import {ExecutionAgent} from "./execution-agent";
import {adingMcpNeeded,startParallelMcp} from "./parallel-mcp";
import {computerToolsEnabled} from "./computer-tools";
import type { SkillTarget } from "../skills/target";
import type { AgentAdapter, AgentRuntimeConfig, SteerInput, SteerResult, TurnInput, VerifyResult } from "./types";
import { p } from "../prompt-language";
import { agentLocalUuid } from "../account/machine";
import { desktopAppPaths } from "./desktop-apps";

const execFileAsync = promisify(execFile);

/** The first line of an execFile error is just "Command failed: …"; the real cause is in stderr or the timeout flag */
function probeReason(error: unknown, message: string): string {
  const detail = error as { killed?: boolean; signal?: string; code?: unknown; stderr?: unknown };
  if (detail.killed || detail.signal === "SIGTERM") return p("--version 超过 5 秒没有返回", "--version timed out after 5 seconds");
  if (typeof detail.stderr === "string" && detail.stderr.trim()) return firstLine(detail.stderr);
  if (detail.code === "EACCES") return p("没有执行权限", "No execute permission");
  return firstLine(message);
}

/** Errors often carry the whole stderr; for humans, show only the first line, kept short */
function firstLine(message: string): string {
  const line = message.split("\n").map((item) => item.trim()).find(Boolean) ?? p("未知错误", "Unknown error");
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * Shared base for CLI agents that use stream-json.
 *
 * Claude Code and Qoder have largely the same command line: -p for non-interactive,
 * --output-format stream-json, --resume to continue a session, --permission-mode for permissions.
 * Small differences need extension points, e.g. Claude supports --verbose but Qoder 1.1.41 doesn't.
 */
export abstract class StreamJsonAgent extends ExecutionAgent implements AgentAdapter {
  abstract readonly kind: AgentKind;
  /** Executable name, also the name to look for in PATH */
  protected abstract readonly binary: string;
  /** Human-readable name, used in error messages and on the Agent page */
  abstract readonly label: string;
  abstract readonly installHint: string;
  abstract readonly loginHint: string;
  abstract readonly logoutHint?: string;
  abstract readonly docsUrl: string;

  protected readonly runner = new ProcessRunner();
  /** Advertise the lenient ading_parallel schema; see lenientParallelInputSchema. */
  protected readonly lenientParallelSchema: boolean = false;
  private readonly activeSteers=new Map<string,(input:SteerInput)=>Promise<SteerResult>>();

  /**
   * Other executable names for the same vendor's CLI. E.g. the npm Qoder installs as qodercli,
   * while the desktop app's launcher shim is called qoder — both names must be searched in standard directories and PATH.
   */
  protected readonly binaryAliases: string[] = [];
  /** This vendor's flag for disabling session history; passed only if listed in --help */
  protected readonly noPersistenceFlag: string = "--no-session-persistence";
  /** Reason from the latest discover for "file exists but won't run"; cleared when a usable CLI is found */
  private discoveryFailure: string | undefined;

  lastDiscoveryFailure(): string | undefined {
    return this.discoveryFailure;
  }

  /** Common install locations besides PATH */
  protected extraCandidates(): string[] {
    return [];
  }

  /** Install locations of the vendor desktop app. The app and the CLI are separate components; having the app doesn't mean it's callable */
  protected desktopAppPaths(): string[] {
    return desktopAppPaths(this.kind);
  }

  /**
   * Two cases where users think it's "already installed": the desktop app is installed, or the app's launcher shim exists but won't run.
   * Then say "CLI not installed" and offer an install-CLI button, rather than a vague "not installed".
   */
  async vendorAppInstalled(): Promise<boolean> {
    if (this.discoveryFailure) return true;
    for (const appPath of this.desktopAppPaths()) {
      try {
        await access(appPath);
        return true;
      } catch {
        // Not at this location; check the next one.
      }
    }
    return false;
  }

  /** Permission arguments for this turn. fullAccess is decided by the caller from the permission level; the adapter doesn't judge */
  protected abstract permissionArgs(fullAccess: boolean): string[];

  /** What this vendor needs beyond the shared arguments (e.g. Qoder needs an explicit --cwd) */
  protected extraArgs(_input: TurnInput): string[] {
    return [];
  }

  /** Process environment for this turn. Vendors provide memory isolation here; undefined keeps ADing's own environment */
  protected turnEnvironment(_input: TurnInput): NodeJS.ProcessEnv | undefined | Promise<NodeJS.ProcessEnv | undefined> {
    return undefined;
  }

  /** Claude's stream-json requires verbose; not every compatible CLI supports this flag. */
  protected streamDetailArgs(): string[] {
    return ["--verbose"];
  }

  /** Extra flags only valid with streaming input, e.g. echoing folded steers. */
  protected streamingInputArgs(): string[] {
    return [];
  }

  abstract resolveSkillTarget(
    scope: Scope,
    workspacePath: string
  ): Promise<SkillTarget | null>;
  abstract syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]>;
  abstract unsyncSkills(target: SkillTarget): Promise<string[]>;

  async discover(): Promise<DiscoveredAgent[]> {
    // A desktop app may install a launcher shim first; when the shim exists but the CLI isn't installed, --version fails.
    // Don't stop at the first shim; keep trying PATH and other standard install locations.
    let failure: string | undefined;
    for (const candidate of this.candidatePaths()) {
      let present = false;
      try {
        await access(candidate, constants.X_OK);
        present = true;
        const executablePath = await realpath(candidate);
        const result = await execFileAsync(executablePath, ["--version"], {
          timeout: 5000
        });
        const version = result.stdout.trim().split("\n")[0] || p("未知版本", "unknown version");
        this.discoveryFailure = undefined;
        return [
          {
            // Identity is determined only by "computer UUID + type", not install path or computer name —
            // otherwise an upgrade that changes the path would orphan the contact and break all history
            localUuid: await agentLocalUuid(this.kind),
            kind: this.kind,
            name: this.label,
            version,
            executablePath,
            nodeName: os.hostname()
          }
        ];
      } catch (error) {
        if (present) {
          const message = error instanceof Error ? error.message : String(error);
          await log("agent-discovery-probe-failed", {
            kind: this.kind,
            candidate,
            error: message.slice(0, 800)
          });
          // Keep only the first: usually the very file the user thinks is "already installed"
          failure ??= p(`${candidate} 无法运行：${probeReason(error, message)}`, `${candidate} can't run: ${probeReason(error, message)}`);
        }
        // Invalid launcher shim or non-executable candidate; keep looking.
      }
    }
    this.discoveryFailure = failure;
    return [];
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
    if(!adingMcpNeeded(input))return this.executeStream(agent,input);
    const bridge=await startParallelMcp(input,{lenientSchema:this.lenientParallelSchema});
    try {return await this.executeStream(agent,input,bridge.config);}
    finally {bridge.close();}
  }

  private async checkNoPersistenceFlag(agent:DiscoveredAgent,input:TurnInput):Promise<TurnInput> {
    if(!input.noSessionPersistence||await cliListsFlag(agent,this.noPersistenceFlag))return input;
    await log("no-session-persistence-unsupported",{kind:this.kind,version:agent.version,flag:this.noPersistenceFlag});
    return {...input,noPersistFlagMissing:true};
  }

  private async executeStream(
    agent: DiscoveredAgent,
    input: TurnInput,
    mcpConfig?:string
  ): Promise<AgentTurnOutcome> {
    const startedAt=Date.now();
    let firstEventMs:number|undefined;
    let firstToolMs:number|undefined;
    let model:string|undefined;
    let runtimeError:string|undefined;
    const toolCounts:Record<string,number>={};
    const steps: string[] = [];
    const metrics: TurnMetrics = { iterations: 0, sideEffects: false };
    const loopGuard=new ToolLoopGuard();
    const record = (text: string): void => {
      // Don't record the same progress line repeatedly, or steps fill up with "Analyzing"
      if (steps[steps.length - 1] !== text) steps.push(text);
      input.onProgress(text);
    };

    if (this.runner.isBusy(agent.localUuid)) {
      return {
        ok: false,
        error: p("该 Agent 还有任务在执行", "This Agent still has a task running"),
        steps,
        cancelled: false,
        metrics
      };
    }

    const args = this.buildArgs(await this.checkNoPersistenceFlag(agent,input),mcpConfig);
    const permissions = this.usesStreamingInput(input) ? new StreamPermissions(input, () => this.runner.cancel(agent.localUuid), this.streamPermissionOptions(input)) : undefined;
    const steer=permissions ? async(update:SteerInput):Promise<SteerResult>=>permissions.steer(update.content,update.clientMessageId)?{status:"accepted"}:{status:"not-ready"} : undefined;
    if(steer)this.activeSteers.set(agent.localUuid,steer);

    record(p("正在启动", "Starting"));
    // Wrong arguments are among the hardest problems to spot from symptoms, so log the actual command line
    await log("cli-exec", {
      kind: this.kind,
      bin: agent.executablePath,
      args: safeArgs(args.map((arg,index)=>args[index-1]==="--mcp-config" ? "<runtime MCP config>" : arg)),
      cwd: input.workspacePath,
      isolateMemory: !!input.isolateMemory
    });
    const run = await this.runner.run(agent.localUuid, {
      env: await this.turnEnvironment(input),
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      hasPendingWork:input.hasPendingWork,
      onStart: permissions ? channel => permissions.start(channel) : undefined,
      executablePath: agent.executablePath,
      args,
      cwd: input.workspacePath,
      label: this.label,
      retainLine: retainStreamLine,
      onLine: (line) => {
        try {
          const event = JSON.parse(line);
          firstEventMs ??= Date.now()-startedAt;
          if(event.type==="system" && event.subtype==="init")void log("provider-runtime",{
            kind:this.kind,sessionId:event.session_id,model:event.model,
            tools:event.tools,mcpServers:Array.isArray(event.mcp_servers) ? event.mcp_servers.map((server:any)=>({name:server.name,status:server.status})) : undefined,
            parallelTools:!!input.onParallelWork,computerTools:computerToolsEnabled(input),startupMs:firstEventMs
          });
          if (!event.parent_tool_use_id) model=event.model ?? event.message?.model ?? model;
          // What the CLI actually ran. Worth showing and storing, but it is not a
          // user choice, so it is marked observed and never replayed as an argument.
          if(!event.parent_tool_use_id && typeof (event.model ?? event.message?.model)==="string")input.onRuntimeConfig?.({
            ...input.runtimeConfig,model:event.model ?? event.message.model,observed:true,
            source:input.runtimeConfig?.source ?? p(`${this.label} 实际使用的模型`, `the model ${this.label} actually uses`)
          });
          // ADing's MCP server may expose only computer-use tools; require the dispatch tool to be connected only when this turn dispatches parallel work.
          if(event.type==="system" && event.subtype==="init" && mcpConfig && input.onParallelWork && !event.tools?.includes("mcp__ading__ading_parallel")) {
            runtimeError=p(`${this.label} 并行工具未连接，本轮已停止；请检查运行日志中的 MCP 连接状态后重试。`, `${this.label}'s parallel tools aren't connected, so this turn was stopped; check the MCP connection status in the run log and try again.`);
            this.runner.cancel(agent.localUuid);
          }
          permissions?.line(event);
          for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
            if(block.type==="tool_use") {
              firstToolMs ??= Date.now()-startedAt;toolCounts[block.name ?? "tool"]=(toolCounts[block.name ?? "tool"]??0)+1;
              const loopNotice=loopGuard.observe(block.name ?? "tool",block.input);
              if(loopNotice&&permissions?.steer(loopNotice))record(p("检测到重复工具循环，已在当前会话内调整方向", "Detected a repeated tool loop; adjusted direction within the current session"));
            }
            if (block.type === "tool_use") input.onAudit?.({id:block.id,kind:block.name ?? "tool",phase:"started"});
            if (block.type === "tool_result") input.onAudit?.({id:block.tool_use_id,kind:"tool",phase:"completed",failed:!!block.is_error});
          }
        } catch { /* not an event line */ }
        countStreamMetrics(line, metrics);
        const description = describeStreamEvent(line);
        if (description) record(description);
      }
    });

    if(steer&&this.activeSteers.get(agent.localUuid)===steer)this.activeSteers.delete(agent.localUuid);

    permissions?.close();
    await log("provider-timing",{kind:this.kind,model,elapsedMs:Date.now()-startedAt,firstEventMs,firstToolMs,toolCounts,cancelled:run.cancelled});
    const parsed = parseStreamJson(run.stdout, input.threadId);
    if(runtimeError)return {ok:false,threadId:parsed.threadId,error:runtimeError,steps,cancelled:false,metrics};
    if (permissions?.error) return {ok:false,threadId:parsed.threadId,error:permissions.error,steps,cancelled:false,metrics};
    // Keep the model's own report: it says what was delivered despite the block,
    // and dropping it leaves the user a failure with no account of the work done.
    if (permissions?.denied && !run.cancelled) return {ok:false,threadId:parsed.threadId,error:p("工具操作未获授权，当前分工受阻。请 Leader 调整方案；用户拒绝的操作不得原样重试。", "A tool operation wasn't authorized, so the current assignment is blocked. The Leader should adjust the plan; operations the user denied must not be retried as-is."),partialMessage:parsed.message,steps,cancelled:false,metrics};
    if (run.failure || parsed.error) {
      // Raw stderr is the most useful; don't drop it
      await log("cli-failed", {
        kind: this.kind,
        failure: run.failure?.slice(0, 500),
        reported: parsed.error?.slice(0, 500),
        stderr: run.stderr.slice(-800),
        stdoutBytes: Buffer.byteLength(run.stdout)
      });
    }

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
    // Discussion turns have no tools or side effects. Qoder sometimes emits the complete assistant text
    // but never sends the result/exit event; discarding the whole 90 seconds of output in that case
    // would only make the whole team repeat the discussion. Keep the same native session and treat the last visible body text
    // as a degraded success. Execution turns must never do this, since side effects may be unfinished without a completion event.
    const failure = parsed.error || run.failure;
    const timedOut = !!run.failure && /超过\s*\d+\s*秒|timed?\s*out|timeout/i.test(run.failure);
    if (failure && input.communicationOnly && timedOut && parsed.threadId && parsed.message?.trim()) {
      await log("communication-timeout-salvaged", {
        kind: this.kind,
        sessionId: parsed.threadId,
        messageChars: parsed.message.length
      });
      return {
        ok: true,
        threadId: parsed.threadId,
        message: parsed.message,
        steps,
        metrics
      };
    }
    if (failure) {
      return {
        ok: false,
        threadId: parsed.threadId,
        error: p(`${this.label} 回复失败：${failure}`, `${this.label} reply failed: ${failure}`),
        partialMessage: parsed.message,
        steps,
        cancelled: false,
        metrics
      };
    }
    if (!parsed.threadId || !parsed.message) {
      return {
        ok: false,
        threadId: parsed.threadId,
        error: p(`${this.label} 返回的数据不完整，请重试`, `${this.label} returned incomplete data; please try again`),
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
      metrics,
      ...(permissions?.steersSeen.length ? {steersSeen: [...permissions.steersSeen]} : {})
    };
  }

  /**
   * Builds this turn's command line.
   *
   * Extracted so it can be tested — errors like a wrong permission level or a missing --resume on continuation
   * take a full real run to notice, but a single assertion here pins them down.
   */
  protected streamPermissionOptions(_input: TurnInput): import("./stream-permissions").StreamPermissionOptions { return {}; }

  protected usesStreamingInput(input: TurnInput): boolean {
    // Unattended work needs the control channel too: vendor safety checks that
    // insist on approval (e.g. an rm whose glob cannot be resolved) otherwise
    // hard-block even in bypass mode, and the turn is reported as denied.
    const unattendedWork=input.fullAccess&&input.permissionMode==="unattended"&&!input.discussionOnly;
    return !!input.steerable || unattendedWork || (!!input.onPermission && !input.discussionOnly);
  }

  buildArgs(input: TurnInput,mcpConfig?:string): string[] {
    const interactive = this.usesStreamingInput(input);
    const unattended=input.fullAccess&&input.permissionMode==="unattended";
    return [
      interactive ? "--print" : "-p",
      // The approval tool stays attached when unattended: bypass mode still lets
      // ordinary tools run without asking, and the few checks that must ask now
      // reach ADing, which approves them under the unattended policy.
      ...(interactive ? ["--input-format", "stream-json", "--permission-prompt-tool", "stdio", ...this.streamingInputArgs()] : [input.prompt]),
      "--output-format",
      "stream-json",
      ...this.streamDetailArgs(),
      ...(interactive&&!unattended ? ["--permission-mode", this.kind === "claude-code" ? "manual" : "default"] : this.permissionArgs(input.fullAccess)),
      ...(input.discussionOnly ? ["--tools", "", "--strict-mcp-config", ...(!mcpConfig ? ["--mcp-config", '{"mcpServers":{}}'] : [])] : !input.fullAccess ? ["--tools", "Read,Glob,Grep", "--strict-mcp-config", ...(!mcpConfig ? ["--mcp-config", '{"mcpServers":{}}'] : [])] : []),
      ...(mcpConfig ? ["--mcp-config",mcpConfig] : []),
      ...this.extraArgs(input),
      ...(input.noSessionPersistence&&!input.noPersistFlagMissing ? ["--no-session-persistence"] : []),
      ...(input.threadId ? ["--resume", input.threadId] : [])
    ];
  }

  protected async verificationArgs(_agent: DiscoveredAgent, cwd: string, help: string, _app?: AgentRuntimeConfig, ask?: OneShotAsk): Promise<string[]> {
    return ask ? handshakeArgs(this.kind, cwd, help, ask) : handshakeArgs(this.kind, cwd, help);
  }

  /**
   * Ask once, get one answer, leave no trace. It uses the same path as the connectivity check, just with a different question,
   * so likewise no tools, no extensions, no saved session — the user won't see it in the vendor's own app.
   */
  async askOnce(agent: DiscoveredAgent, prompt: string): Promise<VerifyResult> {
    return this.oneShot(agent, undefined, { prompt });
  }

  /** Restricted handshake: no task instructions, tools, extensions or persisted session. */
  async verify(agent: DiscoveredAgent, app?: AgentRuntimeConfig): Promise<VerifyResult> {
    return this.oneShot(agent, app);
  }

  private async oneShot(agent: DiscoveredAgent, app?: AgentRuntimeConfig, ask?: OneShotAsk): Promise<VerifyResult> {
    return withHandshakeDirectory(this.kind, async cwd => {
      const args = await this.verificationArgs(agent, cwd, await handshakeHelp(agent.executablePath, this.kind, cwd), app, ask);
      const run = await this.runner.run(`${agent.localUuid}::verify`, {
        ...handshakeCommand(agent.executablePath, args),
        cwd,
        label: this.label,
        backgroundPriority: true,
        timeoutMs: ask ? 60_000 : AGENT_PROBE_TIMEOUT_MS,
        onLine: () => undefined
      });
      const parsed = parseStreamJson(run.stdout);
      if (parsed.message && !parsed.error && !run.failure) {
        return { ok: true, text: parsed.message.slice(0, 200) };
      }
      return {
        ok: false,
        text: parsed.error || run.failure || run.stderr || p("没有拿到回复", "No reply was received")
      };
    });
  }

  protected candidatePaths(): string[] {
    const names = [this.binary, ...this.binaryAliases];
    const directories = [
      path.join(os.homedir(), ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
    ];
    return [
      ...new Set([
        ...this.extraCandidates(),
        ...directories.flatMap((directory) =>
          names.map((name) => path.join(directory, name))
        )
      ])
    ];
  }

}

/** Missing configuration is normal. Defer access denials to the real copy so its complete target can be delegated. */
export async function skillRootMayExist(dir: string): Promise<boolean> {
  try { return (await stat(dir)).isDirectory(); }
  catch(error) {
    const code=(error as NodeJS.ErrnoException).code;
    if(code==="ENOENT")return false;
    if(code==="EACCES"||code==="EPERM")return true;
    throw error;
  }
}
