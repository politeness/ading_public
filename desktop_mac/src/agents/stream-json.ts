import {recordTokenUsage,setTokenUsage,recordProviderCredits,recordContextUsage} from "./token-usage";
import { p } from "../prompt-language";

/**
 * Parsing of Claude Code / Qoder stream-json output.
 *
 * The two share nearly the same command-line flags and event shapes (Qoder was modeled on Claude Code's interface),
 * so they share this one. It is a bit more lenient than the docs: both spellings of field names are accepted,
 * and if there is no result event it falls back to the assistant text -
 * when the parser doesn't match the version it should degrade, not show the user "returned data is incomplete".
 *
 * Event shapes (one JSON per line):
 *   {"type":"system","subtype":"init","session_id":"…"}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"},
 *                                             {"type":"tool_use","name":"Bash","input":{…}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result",…}]}}
 *   {"type":"result","subtype":"success","result":"final reply","session_id":"…"}
 */

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: { command?: string; file_path?: string; path?: string; pattern?: string };
}

interface StreamEvent {
  parent_tool_use_id?: string | null;
  type?: string;
  subtype?: string;
  session_id?: string;
  sessionId?: string;
  result?: string;
  is_error?: boolean;
  error?: string | { message?: string };
  errors?: string[];
  message?: { content?: ContentBlock[] | string; usage?: Record<string,unknown> };
  usage?: Record<string,unknown>;
  /** Per-model totals for the whole run, subagents included; usage covers only the top-level session. */
  modelUsage?: Record<string,Record<string,unknown>>;
}

export interface StreamParseResult {
  threadId?: string;
  message?: string;
  /** Error reported by the CLI itself (result event with is_error true). More specific than the process exit code */
  error?: string;
}

/** Images returned by tools may be several MB each; parsing the final answer doesn't need this binary content. */
export function retainStreamLine(line: string): string | undefined {
  const event = parseLine(line);
  if (!event) return undefined;
  if (event.parent_tool_use_id) return undefined;
  const session_id = event.session_id ?? event.sessionId;
  if (event.type === "result") return JSON.stringify(event);
  if (event.type === "assistant") return JSON.stringify({ type: event.type, session_id,
    message: { content: blocksOf(event).filter(block => block.type === "text").map(block => ({ type: "text", text: block.text })) } });
  if (session_id) return JSON.stringify({ type: "system", session_id });
  return undefined;
}

/**
 * Models occasionally leak the internal thinking protocol into the final text, especially Qoder CN.
 * A lone </think> means only the closing tag went into result; in that case the body is what follows the closing tag.
 */
export function cleanAgentOutput(value: string): string {
  let cleaned = value.replace(/\r\n?/g, "\n").trim();
  cleaned = cleaned
    .replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think\s*>/gi, "")
    .trim();

  const closings = [...cleaned.matchAll(/<\/think\s*>/gi)];
  const lastClosing = closings[closings.length - 1];
  if (lastClosing?.index !== undefined) {
    const tail = cleaned
      .slice(lastClosing.index + lastClosing[0].length)
      .trim();
    cleaned = tail || cleaned.slice(0, lastClosing.index).trim();
  }

  cleaned = cleaned
    .replace(/<think(?:\s[^>]*)?>[\s\S]*$/gi, "")
    .replace(/<\/?think(?:\s[^>]*)?>/gi, "")
    .trim();

  // Qoder CN occasionally appends closing tags of the internal tool protocol to the end of the final body.
  // Only remove protocol tags that sit on their own lines consecutively at the end, to avoid damaging XML examples in the body.
  const lines = cleaned.split("\n");
  while (
    lines.length > 0 &&
    /^\s*\\?<\/?(?:parameter|invoke|function|tool_call|tool_use)(?:\s[^>]*)?>\s*$/i.test(
      lines[lines.length - 1] ?? ""
    )
  ) {
    lines.pop();
  }
  cleaned = lines.join("\n").trim();

  if (/^skip[.!]?$/i.test(cleaned)) return "SKIP";
  return cleaned.replace(/\n+\s*skip\s*$/i, "").trim();
}

function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    // The CLI mixes in non-JSON log output; only accept valid lines
    return null;
  }
}

function blocksOf(event: StreamEvent): ContentBlock[] {
  const content = event.message?.content;
  if (Array.isArray(content)) return content;
  // Some versions put plain text directly on content
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/** Only parses, doesn't judge completeness - even on failure it must hand back the session id already obtained */
export function parseStreamJson(
  output: string,
  previousThreadId?: string,
  preserveReplyText = false
): StreamParseResult {
  let threadId = previousThreadId;
  // A steer that lands after the final answer makes the CLI run a follow-up turn
  // in the same process, so one run can carry several results: the answer to the
  // original request, then the answer to the steer. Both belong to the reply.
  const finals: string[] = [];
  let error: string | undefined;
  const assistantText: string[] = [];
  const replyText: string[] = [];

  for (const line of output.split("\n")) {
    const event = parseLine(line);
    if (!event) continue;
    if (event.parent_tool_use_id) continue;

    const id = event.session_id ?? event.sessionId;
    if (id) threadId = id;

    if (event.type === "assistant") {
      for (const block of blocksOf(event)) {
        if (block.type === "text" && block.text?.trim()) {
          assistantText.push(block.text.trim());
          replyText.push(block.text.trim());
        }
      }
      continue;
    }

    if (event.type === "result") {
      if (event.is_error) {
        error =
          (typeof event.error === "string" ? event.error : event.error?.message) ||
          event.errors?.find((item) => item.trim()) ||
          event.result ||
          p("执行失败", "Execution failed");
        continue;
      }
      if (typeof event.result === "string" && event.result.trim()) {
        finals.push(event.result.trim());
        replyText.push(event.result.trim());
      }
    }
  }

  // The result event is the authoritative answer; without it, fall back to the last assistant text.
  // Not all assistant text concatenated - the middle parts are process narration, not the reply for the group.
  // Some CLIs echo a failed API request as assistant text before the error
  // result. It is not partial work: publishing it leaks recoverable errors and
  // makes the shared context budget refuse a safe retry. Keep real prior text.
  const diagnostic = error ? cleanAgentOutput(error) : undefined;
  const replies = diagnostic ? assistantText.filter(text => cleanAgentOutput(text) !== diagnostic) : assistantText;
  // A direct reply can answer one request before tools and another afterwards.
  // The result only repeats the final segment; it must not erase the earlier answer.
  // Coordination callers retain their final-only control protocol.
  const complete = diagnostic ? replyText.filter(text => cleanAgentOutput(text) !== diagnostic) : replyText;
  const message = preserveReplyText ? joinTurnResults(complete) : finals.length ? joinTurnResults(finals) :
    replies.length ? cleanAgentOutput(replies[replies.length - 1]) : undefined;
  return { threadId, message: message || undefined, error };
}

/** Results of consecutive turns in one run, in order. A follow-up that restates
 * the previous answer replaces it; a SKIP turn only counts if every turn skipped. */
function joinTurnResults(finals: string[]): string {
  const parts: string[] = [];
  for (const cleaned of finals.map(cleanAgentOutput).filter(Boolean)) {
    const combined = parts.join("\n\n");
    const last = parts[parts.length - 1];
    if (combined && cleaned.startsWith(combined)) parts.splice(0, parts.length, cleaned);
    else if (last !== undefined && cleaned.startsWith(last)) parts[parts.length - 1] = cleaned;
    else parts.push(cleaned);
  }
  const spoken = parts.filter(part => part !== "SKIP");
  return spoken.length ? spoken.join("\n\n") : parts[0] ?? "";
}

/** Turns one event line into plain language for live progress like "Running command: ..." */
export function describeStreamEvent(line: string): string | null {
  const event = parseLine(line);
  if (!event) return null;

  if (event.type === "system") {
    return event.subtype === "init" ? p("已连接", "Connected") : null;
  }
  if (event.type === "result") {
    return event.is_error ? p("执行过程中遇到问题", "Ran into a problem during execution") : p("正在整理结果", "Organizing the results");
  }
  if (event.type !== "assistant") return null;

  const blocks = blocksOf(event);
  const tool = blocks.find((block) => block.type === "tool_use");
  if (tool) return describeTool(tool);
  return blocks.some((block) => block.type === "text") ? p("正在分析", "Analyzing") : null;
}

function describeTool(block: ContentBlock): string {
  const name = block.name ?? "";
  const command = block.input?.command?.replace(/\s+/g, " ").slice(0, 70);
  if (command) return p(`正在执行命令：${command}`, `Running command: ${command}`);

  const file = block.input?.file_path ?? block.input?.path;
  if (file) {
    const short = file.split("/").slice(-2).join("/");
    return isWriteTool(name) ? p(`正在修改文件：${short}`, `Modifying file: ${short}`) : p(`正在查看文件：${short}`, `Viewing file: ${short}`);
  }
  if (block.input?.pattern) return p("正在搜索代码", "Searching the code");
  if (/websearch|web_search/i.test(name)) return p("正在搜索资料", "Searching for information");
  if (/todo|plan/i.test(name)) return p("正在规划任务", "Planning the task");
  if (/task|agent/i.test(name)) return p("正在派生子任务", "Spawning sub-tasks");
  return name ? p(`正在使用工具：${name}`, `Using tool: ${name}`) : p("正在执行任务", "Working on the task");
}

/**
 * Decides whether a tool counts as having "touched the outside world".
 *
 * Uses pattern matching rather than an allowlist: Claude Code and Qoder tool names differ,
 * and both keep adding new tools. Better to misjudge a read-only tool as having side effects -
 * that only makes the threshold a little easier to reach, far cheaper than a miss that leaves lessons that should be captured uncaptured.
 */
function isWriteTool(name: string): boolean {
  return /bash|shell|exec|command|write|edit|create|apply|patch|delete|move/i.test(
    name
  );
}

/** Tallies this turn's size, side effects and the token usage reported by the vendor. */
/** The result event's usage is the top-level session only; work done by
 * subagents shows up solely in modelUsage. Sum that when present so delegated
 * work is not silently left out of the turn's cost. */
function runUsage(event: StreamEvent): Record<string,unknown>|undefined {
  const models = event.modelUsage && typeof event.modelUsage === "object" ? Object.values(event.modelUsage) : [];
  if (!models.length) return event.usage;
  const sum = (key: string) => models.reduce((total, model) => total + (typeof model?.[key] === "number" ? model[key] as number : 0), 0);
  return {
    input_tokens: sum("inputTokens"),
    output_tokens: sum("outputTokens"),
    cache_read_input_tokens: sum("cacheReadInputTokens"),
    cache_creation_input_tokens: sum("cacheCreationInputTokens")
  };
}

export function countStreamMetrics(line: string, metrics: TurnMetrics): void {
  const event = parseLine(line);
  if (!event) return;
  if(event.type==="result"&&(event.usage||event.modelUsage)){
    // modelUsage is the running total of the provider session, so a later result (after a steer) replaces the earlier one.
    if(event.modelUsage)setTokenUsage(metrics,runUsage(event),true);
    else recordTokenUsage(metrics,runUsage(event),true);
    if(event.usage)recordContextUsage(metrics,event.usage);
    return;
  }
  if (event.type !== "assistant") return;
  // Credit-billed providers report their cost per model call and leave the token
  // counts at zero, so the result event alone carries no usage for them.
  const usage=event.message?.usage;
  if(usage){recordProviderCredits(metrics,usage);recordContextUsage(metrics,usage);}
  // One assistant message = one model round, the same order of magnitude as codex's item.completed
  metrics.iterations += 1;
  for (const block of blocksOf(event)) {
    if (block.type === "tool_use" && isWriteTool(block.name ?? "")) {
      metrics.sideEffects = true;
    }
  }
}
