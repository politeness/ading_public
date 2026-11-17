import { NativeCliAgent, assertNoFast } from "./native-cli";
import type { TurnInput, VerifyResult } from "./types";
import { randomUUID } from "node:crypto";
import { ProcessRunner, type ProcessChannel, type RunOptions, type RunResult } from "./process-runner";
import { adingMcpNeeded, startParallelMcp } from "./parallel-mcp";
import { handshakeCommand, withHandshakeDirectory } from "./handshake";
import { setTokenUsage } from "./token-usage";
import { stdioMcpServer } from "./native-tool-bridge";
import { p } from "../prompt-language";
import { redactDiagnosticText } from "./lifecycle-diagnostics";
import { isOwnSessionId } from "./session-discard";
import { log } from "../orchestration/diagnostics";

export interface AcpLaunch { args: string[]; env?: NodeJS.ProcessEnv; close?: () => Promise<void>; }

/** session/cancel lets the agent settle and persist its session; the runner
 * kills it only after this grace, still within the quit wait. */
const ACP_CANCEL_GRACE_MS = 2000;
const ACP_AUTH_TIMEOUT_MS = 60_000;

function configOption(state: any, category: string) {
  return Array.isArray(state?.configOptions) ? state.configOptions.find((option: any) =>
    option?.type === "select" && (option.category === category ||
      (!option.category && option.id === (category === "model" ? "model" : "effortLevel")))) : undefined;
}

function observedConfiguration(state: any) {
  const model = configOption(state, "model")?.currentValue ?? state?.models?.currentModelId;
  const reasoningEffort = configOption(state, "thought_level")?.currentValue;
  return { ...(typeof model === "string" && model ? { model } : {}),
    ...(typeof reasoningEffort === "string" && reasoningEffort ? { reasoningEffort } : {}) };
}

/** ACP v1 NDJSON transport. The provider still owns tools and sessions; ADing
 * owns permission decisions, cancellation and the shared execution pipeline. */
/** ACP advertises models as a configOption, or in the older optional `models` metadata. */
export function acpModels(state: any): AgentModelOption[] {
  const option = (Array.isArray(state?.configOptions) ? state.configOptions : []).find((item: any) => item?.category === "model");
  if (option) return (Array.isArray(option.options) ? option.options : [])
    .flatMap((item: any) => Array.isArray(item?.options) ? item.options : [item])
    .filter((item: any) => typeof item?.value === "string" && item.value)
    .map((item: any) => ({ id: item.value, label: item.name || item.value, description: item.description || undefined }));
  return (Array.isArray(state?.models?.availableModels) ? state.models.availableModels : [])
    .filter((item: any) => typeof item?.modelId === "string" && item.modelId)
    .map((item: any) => ({ id: item.modelId, label: item.name || item.modelId, description: item.description || undefined }));
}

export abstract class AcpAgent extends NativeCliAgent {
  private readonly cancellers = new Map<string, () => void>();
  protected readonly objectParallelSchema: boolean = false;
  protected abstract prepareAcp(input: TurnInput): Promise<AcpLaunch>;
  cancel(localUuid: string): boolean {
    const cancel = this.cancellers.get(localUuid);
    if (!cancel) return super.cancel(localUuid);
    cancel();
    return true;
  }
  /** Login check without a model request: an ACP agent rejects session/new
   * until it is signed in, so no prompt is sent and no request quota is spent.
   * The caller's runner owns the process, so it is cancellable and reaped on quit. */
  async probeAuth(agent: DiscoveredAgent, run: (options: RunOptions) => Promise<RunResult>): Promise<VerifyResult> {
    return this.probeSession(agent, run);
  }
  /** session/new advertises the models; no prompt is sent, so no request quota is spent. */
  async listModels(agent: DiscoveredAgent): Promise<AgentModelOption[]> {
    let models: AgentModelOption[] = [];
    const runner = new ProcessRunner();
    const result = await this.probeSession(agent, options => runner.run(`models:${randomUUID()}`, options), state => { models = acpModels(state); });
    if (!result.ok) throw new Error(result.text);
    return models;
  }
  private async probeSession(agent: DiscoveredAgent, run: (options: RunOptions) => Promise<RunResult>, onSession?: (state: any) => void): Promise<VerifyResult> {
    return withHandshakeDirectory(this.kind, async workspacePath => {
      const launch = await this.prepareAcp({ workspacePath, prompt: "", discussionOnly: true, fullAccess: false, onProgress: () => undefined });
      let channel: ProcessChannel | undefined, nextId = 0, result: VerifyResult | undefined;
      const pending = new Map<number, (event: any) => void>();
      const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, event => event.error ? reject(new Error(redactDiagnosticText(event.error.message || "ACP error"))) : resolve(event.result));
        if (!channel?.write({ jsonrpc: "2.0", id, method, params })) { pending.delete(id); reject(new Error(p("ACP 输入连接已关闭", "ACP input closed"))); }
      });
      try {
        const probe = await run({
          ...handshakeCommand(agent.executablePath, launch.args), env: launch.env, cwd: workspacePath,
          label: this.label, timeoutMs: ACP_AUTH_TIMEOUT_MS, retainLine: () => undefined,
          onStart: started => {
            channel = started;
            void (async () => {
              const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "ading", version: "1.0.0" } });
              if (init.protocolVersion !== 1) throw new Error(p("不支持该 ACP 协议版本", "Unsupported ACP protocol version"));
              const state = await request("session/new", { cwd: workspacePath, mcpServers: [] });
              onSession?.(state);
              result = { ok: true, text: p("已登录", "Signed in") };
            })().catch(cause => { result = { ok: false, text: cause instanceof Error ? cause.message : String(cause) }; })
              .finally(() => channel?.end());
          },
          onLine: line => {
            let event: any;
            try { event = JSON.parse(line); } catch { return; }
            if (!event || typeof event !== "object" || event.id === undefined) return;
            if (event.method) channel?.write({ jsonrpc: "2.0", id: event.id, error: { code: -32601, message: "Client capability not supported" } });
            else { const waiting = pending.get(event.id); pending.delete(event.id); waiting?.(event); }
          }
        });
        return result && !probe.cancelled ? result : { ok: false,
          text: probe.failure || p("ACP 在登录检测完成前断开", "ACP disconnected before the login check finished") };
      } finally {
        await launch.close?.();
      }
    });
  }
  /** ACP has no way to open a session without storing it. Providers that document where a
   * session lives remove it here; returns how many stored entries were removed. */
  protected async discardSession(_agent: DiscoveredAgent, _sessionId: string, _input: TurnInput): Promise<number> { return 0; }
  /** Runs after the process exited, so nothing rewrites the record. A resumed session is
   * the caller's, not this turn's, and is never removed. A failed removal never fails the turn. */
  private async discardOwnSession(agent: DiscoveredAgent, sessionId: string | undefined, input: TurnInput): Promise<void> {
    if (!input.noSessionPersistence || input.threadId || !sessionId) return;
    try {
      if (!isOwnSessionId(sessionId)) throw new Error("unexpected session id format");
      await log("session-discarded", { kind: this.kind, sessionId, removed: await this.discardSession(agent, sessionId, input) });
    } catch (cause) {
      await log("session-discard-failed", { kind: this.kind, sessionId, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  protected async configureSession(request: (method: string, params: any) => Promise<any>, sessionId: string, state: any, input: TurnInput): Promise<void> {
    // ACP configOptions can replace the older model metadata. Re-read after
    // each change: selecting a model may change its available effort levels.
    for (const [category, wanted] of [["model", input.runtimeConfig?.model],
      ["thought_level", input.runtimeConfig?.reasoningEffort]] as const) {
      const option = configOption(state, category);
      if (!wanted || !option || option.currentValue === wanted) continue;
      const values = Array.isArray(option.options) ? option.options.flatMap((item: any) =>
        Array.isArray(item?.options) ? item.options : [item]) : [];
      if (!values.some((item: any) => item?.value === wanted)) {
        throw new Error(p(`CLI 未提供所选配置：${wanted}`, `The CLI did not offer the selected configuration: ${wanted}`));
      }
      const updated = await request("session/set_config_option", { sessionId, configId: option.id, value: wanted });
      if (configOption(updated, category)?.currentValue !== wanted) {
        throw new Error(p(`CLI 未确认所选配置：${wanted}`, `The CLI did not confirm the selected configuration: ${wanted}`));
      }
      state.configOptions = updated.configOptions;
    }
    // A later selection may reset an earlier one; never silently run with a
    // different advertised configuration after applying all requested values.
    for (const [category, wanted] of [["model", input.runtimeConfig?.model],
      ["thought_level", input.runtimeConfig?.reasoningEffort]] as const) {
      const option = configOption(state, category);
      if (wanted && option && option.currentValue !== wanted) {
        throw new Error(p(`CLI 未保留所选配置：${wanted}`, `The CLI did not retain the selected configuration: ${wanted}`));
      }
    }
    // Optional model metadata is not required by ACP. Launch flags still pin
    // the model when a server omits it; do not claim an observed model then.
    const model = input.runtimeConfig?.model;
    if (model && !configOption(state, "model") && state.models && state.models.currentModelId !== model) {
      if (!state.models?.availableModels?.some((item: any) => item.modelId === model)) {
        throw new Error(p(`CLI 未提供所选模型：${model}`, `The CLI did not offer the selected model: ${model}`));
      }
      await request("session/set_model", { sessionId, modelId: model });
      state.models.currentModelId = model;
    }
  }
  protected async executeTurn(agent: DiscoveredAgent, input: TurnInput): Promise<AgentTurnOutcome> {
    const metrics: TurnMetrics = { iterations: 0, sideEffects: false };
    const steps: string[] = [];
    let threadId = input.threadId, message = "", error: string | undefined, complete = false, prompting = false;
    let launch: AcpLaunch | undefined, bridge: Awaited<ReturnType<typeof startParallelMcp>> | undefined;
    let stdio: Awaited<ReturnType<typeof stdioMcpServer>> | undefined;
    let channel: ProcessChannel | undefined, nextId = 0;
    const pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void }>();
    const scope = new AbortController(), kill = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, scope.signal]) : scope.signal;
    let cancelRequested = false, grace: NodeJS.Timeout | undefined;
    // ACP cancellation is session/cancel: pending permission requests answer
    // cancelled, the agent ends the turn itself, and the runner kills only after
    // the grace period or when no session is prompting yet.
    const cancel = () => {
      if (cancelRequested) return;
      cancelRequested = true; scope.abort();
      if (prompting && threadId && channel?.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: threadId } })) {
        grace = setTimeout(() => kill.abort(), ACP_CANCEL_GRACE_MS);
      } else kill.abort();
    };
    const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { method, resolve, reject });
      if (!channel?.write({ jsonrpc: "2.0", id, method, params })) { pending.delete(id); reject(new Error(p("ACP 输入连接已关闭", "ACP input closed"))); }
    });
    const report = (text: string) => { if (steps.at(-1) !== text) steps.push(text); input.onProgress(text); };
    const replyPermission = async (event: any) => {
      const params = event.params ?? {}, call = params.toolCall ?? {};
      let allowed = false;
      // No cross-session permission response can approve the owning session.
      if (params.sessionId === threadId && prompting && !signal.aborted && !input.discussionOnly) {
        if (!input.fullAccess) allowed = ["read", "search"].includes(call.kind);
        else if (input.permissionMode === "unattended") allowed = true;
        else if (input.onPermission) {
          channel?.waitingForApproval(true);
          try { allowed = await input.onPermission({ requestId: String(call.toolCallId ?? event.id),
            toolName: call.kind || "ACP tool", input: call.rawInput ?? {},
            workspacePath: input.workspacePath, signal }); } catch { allowed = false; }
          finally { channel?.waitingForApproval(false); }
        }
      }
      if (signal.aborted) allowed = false;
      // "cancelled" means the turn was cancelled. Approval never falls back to
      // allow_always, which would persist a grant in the vendor's settings.
      if (signal.aborted) { channel?.write({ jsonrpc: "2.0", id: event.id, result: { outcome: { outcome: "cancelled" } } }); return; }
      const options = Array.isArray(params.options) ? params.options : [];
      const option = (allowed ? ["allow_once"] : ["reject_once", "reject_always"])
        .map(kind => options.find((item: any) => item?.kind === kind)).find(Boolean);
      channel?.write(option ? { jsonrpc: "2.0", id: event.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } }
        : { jsonrpc: "2.0", id: event.id, error: { code: -32602, message: allowed
          ? "Permission approved, but no allow_once option was offered" : "Permission denied, but no reject option was offered" } });
    };
    const seen = new Set<string>();
    const update = (params: any) => {
      // Loading replays previous messages. Child sessions never own this turn.
      if (!params || !prompting || params.sessionId !== threadId) return;
      const value = params.update ?? {};
      if (value._meta?.kiro?.replay) return;
      if (value.sessionUpdate === "agent_message_chunk" && value.content?.type === "text") message += value.content.text ?? "";
      if (["tool_call", "tool_call_update"].includes(value.sessionUpdate)) {
        const id = String(value.toolCallId ?? "");
        if (id && !seen.has(id)) {
          seen.add(id); metrics.iterations++;
          metrics.sideEffects ||= !["read", "search", "think"].includes(value.kind);
          report(value.title || p("正在调用工具", "Running a tool"));
        }
        input.onAudit?.({ id, kind: value.kind || "tool", phase: value.status || "in_progress", failed: value.status === "failed" });
      }
      if (value.sessionUpdate === "usage_update") setTokenUsage(metrics, value);
      const configuration = value.sessionUpdate === "config_option_update" ? observedConfiguration(value) :
        value.sessionUpdate === "current_model_update" ? observedConfiguration({ models: value }) : {};
      if (Object.keys(configuration).length) input.onRuntimeConfig?.({ ...configuration, observed: true });
    };
    try {
      assertNoFast(input.runtimeConfig);
      if (this.runner.isBusy(agent.localUuid)) throw new Error(p("该 Agent 还有任务在执行", "This Agent still has a task running"));
      this.cancellers.set(agent.localUuid, cancel);
      if (input.signal?.aborted) cancel(); else input.signal?.addEventListener("abort", cancel, { once: true });
      launch = await this.prepareAcp(input);
      if (adingMcpNeeded(input)) bridge = await startParallelMcp(input, {objectSchema: this.objectParallelSchema});
      let servers: any[] = bridge ? Object.entries(JSON.parse(bridge.config).mcpServers).map(([name, raw]) => {
        const server = raw as any;
        return { name, type: "http", url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) };
      }) : [];
      const command = this.isProbe(input) ? handshakeCommand(agent.executablePath, launch.args) : { executablePath: agent.executablePath, args: launch.args };
      const run = await this.runner.run(agent.localUuid, {
        ...command, env: launch.env, cwd: input.workspacePath, label: this.label, signal: kill.signal,
        timeoutMs: input.timeoutMs, hasPendingWork: input.hasPendingWork, retainLine: () => undefined,
        onStart: started => {
          channel = started;
          void (async () => {
            const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "ading", version: "1.0.0" } });
            if (init.protocolVersion !== 1) throw new Error(p("不支持该 ACP 协议版本", "Unsupported ACP protocol version"));
            if (bridge && !init.agentCapabilities?.mcpCapabilities?.http) { stdio = await stdioMcpServer(bridge.config); servers = [stdio.server]; }
            if (threadId && !init.agentCapabilities?.loadSession) throw new Error(p("该 CLI 不支持恢复会话", "This CLI cannot resume sessions"));
            const state = await request(threadId ? "session/load" : "session/new", {
              cwd: input.workspacePath, mcpServers: servers, ...(threadId ? { sessionId: threadId } : {})
            });
            threadId ??= state.sessionId;
            if (!threadId) throw new Error(p("ACP 没有返回会话编号", "ACP returned no sessionId"));
            await this.configureSession(request, threadId, state, input);
            const actual = observedConfiguration(state);
            if (Object.keys(actual).length) input.onRuntimeConfig?.({ ...actual, observed: true });
            prompting = true;
            const result = await request("session/prompt", { sessionId: threadId, prompt: [{ type: "text", text: input.prompt }] });
            complete = result.stopReason === "end_turn";
            if (!complete) error = p(`Agent 停止：${result.stopReason}`, `Agent stopped: ${result.stopReason}`);
          })().catch(cause => { error = cause instanceof Error ? cause.message : String(cause); })
            .finally(() => { prompting = false; channel?.end(); });
        },
        onLine: line => {
          let event: any;
          try { event = JSON.parse(line); } catch { return; }
          if (!event || typeof event !== "object") return;
          if (event.method === "session/update") update(event.params);
          else if (event.method === "session/request_permission" && event.id !== undefined) void replyPermission(event);
          else if (event.method && event.id !== undefined) channel?.write({ jsonrpc: "2.0", id: event.id, error: { code: -32601, message: "Client capability not supported" } });
          else if (event.id !== undefined) {
            const waiting = pending.get(event.id); pending.delete(event.id);
            if (event.error) {
              const summary = event.error.message || "ACP error";
              const detail = event.error.data === undefined ? "" : redactDiagnosticText(
                typeof event.error.data === "string" ? event.error.data : JSON.stringify(event.error.data)).slice(0, 2000);
              const context = /internal error/i.test(summary) ? ` (${waiting?.method ?? "ACP"})` : "";
              waiting?.reject(new Error(redactDiagnosticText(summary) + context + (detail ? `: ${detail}` : "")));
            }
            else waiting?.resolve(event.result);
          }
        }
      });
      if (error && /internal error/i.test(error) && run.stderr.trim()) {
        error += `: ${redactDiagnosticText(run.stderr.trim()).slice(-2000)}`;
      }
      error ||= run.failure || (!complete ? p("ACP 在回复完成前断开", "ACP disconnected before completing the reply") : undefined);
      if (complete && !error && !run.cancelled && !cancelRequested && threadId) return { ok: true, threadId, message, steps, metrics };
      return { ok: false, threadId, partialMessage: message, error: error || p("没有拿到完整回复", "No complete reply was received"),
        cancelled: run.cancelled || cancelRequested, steps, metrics };
    } catch (cause) {
      return { ok: false, threadId, partialMessage: message, error: cause instanceof Error ? cause.message : String(cause), cancelled: cancelRequested || !!input.signal?.aborted, steps, metrics };
    } finally {
      // A late grace timer must not kill the next turn of the same Agent.
      clearTimeout(grace); input.signal?.removeEventListener("abort", cancel);
      if (this.cancellers.get(agent.localUuid) === cancel) this.cancellers.delete(agent.localUuid);
      scope.abort();
      for (const waiting of pending.values()) waiting.reject(new Error(p("ACP 连接已关闭", "ACP connection closed")));
      pending.clear(); bridge?.close(); await stdio?.close(); await launch?.close?.();
      await this.discardOwnSession(agent, threadId, input);
    }
  }
}
