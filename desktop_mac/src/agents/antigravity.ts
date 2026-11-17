import os from "node:os";
import path from "node:path";
import { NativeCliAgent, assertNoFast } from "./native-cli";
import { readJsoncSettings } from "../platform/jsonc-settings";
import type { TurnInput } from "./types";
import { adingMcpNeeded, startParallelMcp } from "./parallel-mcp";
import { startNativeToolBridge } from "./native-tool-bridge";
import { handshakeCommand, withHandshakeDirectory } from "./handshake";
import { setTokenUsage } from "./token-usage";
import { p } from "../prompt-language";
import { log } from "../orchestration/diagnostics";

/** `agy models` prints one `slug  display name` per line; --model takes the slug. Effort is part of the slug. */
export function parseAgyModels(stdout: string): AgentModelOption[] {
  return stdout.split("\n").flatMap(line => {
    const match = /^([a-z0-9][a-z0-9._:/-]*)(?:\s{2,}(\S.*))?$/.exec(line.trim());
    return match ? [{ id: match[1], label: match[2]?.trim() || match[1] }] : [];
  });
}

export class AntigravityAdapter extends NativeCliAgent {
  constructor(private readonly home = os.homedir()) { super(); }
  readonly kind: AgentKind = "antigravity";
  protected readonly binary = "agy";
  readonly label = "Antigravity";
  readonly installHint = "https://antigravity.google/download";
  get loginHint(): string { return p("运行 agy 完成首次登录", "Run agy to complete initial sign-in"); }
  readonly logoutHint = undefined;
  readonly docsUrl = "https://antigravity.google/docs/cli/headless";
  protected skillDirectories(workspace: string) { return { user: path.join(this.home, ".gemini/antigravity-cli/skills"), workspace: path.join(workspace, ".agents/skills") }; }
  protected async readNativeConfiguration() {
    const file = path.join(this.home, ".gemini/antigravity-cli/settings.json");
    const config = await readJsoncSettings(file);
    // Public settings schema stores /model's selected label in `model`.
    // /effort selects a saved model variant; --effort overrides only this invocation.
    if (config.model !== undefined && typeof config.model !== "string") throw new Error(p("Antigravity 模型配置格式无效", "Invalid Antigravity model setting"));
    return config.model ? { model: config.model, source: file } : undefined;
  }
  listModels(agent: DiscoveredAgent): Promise<AgentModelOption[]> {
    return withHandshakeDirectory(this.kind, async cwd => {
      const listed = await this.runner.run(`${agent.localUuid}::models`, { ...handshakeCommand(agent.executablePath, ["models"]), cwd,
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, label: this.label, backgroundPriority: true, timeoutMs: 20_000, onLine: () => undefined });
      if (listed.failure) throw new Error(listed.failure);
      return parseAgyModels(listed.stdout);
    });
  }
  buildArgs(input: TurnInput): string[] {
    assertNoFast(input.runtimeConfig);
    return ["--input-format", "stream-json", "--output-format", "stream-json",
      ...(input.discussionOnly ? ["--disable-slash-commands"] : []),
      ...(!input.fullAccess || input.discussionOnly ? ["--mode", "plan"] : []),
      ...(input.runtimeConfig?.model ? ["--model", input.runtimeConfig.model] : []),
      ...(input.runtimeConfig?.reasoningEffort ? ["--effort", input.runtimeConfig.reasoningEffort] : []),
      ...(input.threadId ? ["--conversation", input.threadId] : [])];
  }
  protected async executeTurn(agent: DiscoveredAgent, input: TurnInput): Promise<AgentTurnOutcome> {
    let mcp: Awaited<ReturnType<typeof startParallelMcp>> | undefined;
    let tools: Awaited<ReturnType<typeof startNativeToolBridge>> | undefined;
    let threadId = input.threadId, message = "", error: string | undefined, complete = false;
    let initialized = false, providerCancelled = false;
    const steps: string[] = [], metrics: TurnMetrics = { iterations: 0, sideEffects: false };
    const seen = new Set<number>();
    // No documented flag or non-interactive removal, and only unofficial sources describe the
    // on-disk layout: the conversation stays in agy's history instead of guessing at its files.
    if (input.noSessionPersistence) await log("no-session-persistence-unavailable", { kind: this.kind, version: agent.version });
    try {
      const args = this.buildArgs(input);
      if (adingMcpNeeded(input)) mcp = await startParallelMcp(input);
      tools = await startNativeToolBridge(input, mcp?.config);
      const command = this.isProbe(input) ? handshakeCommand(agent.executablePath, args) : { executablePath: agent.executablePath, args };
      const run = await this.runner.run(agent.localUuid, { ...command, cwd: input.workspacePath,
        env: { ...tools.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, label: this.label, signal: input.signal,
        timeoutMs: input.timeoutMs, hasPendingWork: () => !!tools?.isWaiting() || !!input.hasPendingWork?.(), retainLine: () => undefined,
        onStart: channel => {
          channel.write({ event: "user", message: { content: input.prompt } });
          // One turn per owned process: EOF drains it without queueing a second prompt.
          channel.end();
        },
        onLine: line => {
          let event: any;
          try { event = JSON.parse(line); } catch { return; }
          if (!event || typeof event !== "object") return;
          if (event.event === "init" && typeof event.conversation_id === "string" && event.conversation_id) {
            threadId ??= event.conversation_id;
            initialized ||= event.conversation_id === threadId;
          }
          const step = event.step_update;
          if (step && threadId && step.conversation_id === threadId) {
            if (step.step_type === "agent_response" && typeof step.text_delta === "string") message += step.text_delta;
            if (step.step_type === "tool") {
              const id = step.step_index;
              if (!seen.has(id)) {
                seen.add(id); metrics.iterations++; metrics.sideEffects = true;
                const text = step.tool_name || step.tool_info?.name || step.title || p("正在调用工具", "Running a tool");
                steps.push(text); input.onProgress(text);
              }
              input.onAudit?.({ id: String(id), kind: step.tool_name || step.tool_info?.name || "tool", phase: step.state || "ACTIVE", failed: !!(step.tool_info?.error || step.error) });
            }
          }
          const value = event.result;
          // Startup failures have no init event or conversation ID, including on resume.
          // Never adopt a foreign result as this process's parent conversation.
          const startupError = !initialized && value?.conversation_id === "" && value?.status === "ERROR";
          if (event.event === "result" && value && ((threadId && value.conversation_id === threadId) || startupError)) {
            complete = value.status === "SUCCESS";
            providerCancelled = value.status === "CANCELED" || value.status === "INTERRUPTED";
            if (typeof value.response === "string" && value.response) message = value.response;
            error = typeof value.error === "string" ? value.error : undefined;
            setTokenUsage(metrics, { ...value.usage, cachedInputTokens: value.usage?.cache_read_tokens, reasoningOutputTokens: value.usage?.thinking_tokens });
          }
        }
      });
      if (!complete && /authentication required/i.test(run.stderr)) {
        this.markSignedOut(input);
        // Both texts keep a readiness auth marker (未登录 / authenticat) for callers that only see the text.
        error = p("Antigravity 未登录：请运行 agy 完成登录", "Antigravity authentication required: run agy to sign in");
      }
      error ||= run.failure || (!complete ? p("Antigravity 未返回完整结果", "Antigravity did not return a complete result") : undefined);
      if (complete && !error && !run.cancelled && threadId) return { ok: true, threadId, message, steps, metrics };
      return { ok: false, threadId, partialMessage: message, error: error || p("没有拿到完整回复", "No complete reply was received"),
        cancelled: run.cancelled || providerCancelled, steps, metrics };
    } catch (cause) {
      return { ok: false, threadId, partialMessage: message, error: cause instanceof Error ? cause.message : String(cause), cancelled: !!input.signal?.aborted, steps, metrics };
    } finally { mcp?.close(); await tools?.close(); }
  }
}
