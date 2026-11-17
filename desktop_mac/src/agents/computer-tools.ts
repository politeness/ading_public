import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { TurnInput } from "./types";
import { isEnglish, p } from "../prompt-language";

/**
 * Background computer-use tools ADing provides to all Agents.
 *
 * Why: command-line Agents like Qoder and Claude Code can't operate UIs in the background on their own; they can only use
 * AppleScript activate and System Events keystrokes — the target app gets brought to the front and the keyboard and mouse are taken over,
 * so the user can't use the computer while ADing runs tasks. These tools are executed by ADing's bundled native program ading-computer,
 * and reading UIs, pressing buttons, choosing menus, entering text and capturing windows never bring apps to the front.
 *
 * Definitions and execution are implemented once here: Claude Code / Qoder call them via ADing's MCP server,
 * and Codex via app-server dynamicTools; both share them.
 */

export interface ComputerToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}
export interface ComputerToolResult { content: ComputerToolContent[]; isError: boolean }

interface ComputerToolDefinition {
  name: string;
  command: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Descriptions follow the current UI language and are generated on each access */
export function computerTools(): ComputerToolDefinition[] {
  const pid = { type: "integer", description: p("目标应用的 pid（用 computer_apps 或 computer_launch 取得）", "pid of the target app (get it with computer_apps or computer_launch)") };
  const id = { type: "string", description: p("界面元素编号（来自 computer_ui_tree 的 id）", "UI element id (the id from computer_ui_tree)") };
  return [
    {
      name: "computer_apps", command: "apps",
      description: p("列出正在运行的应用（名称、pid、bundleId、是否在前台）。后台电脑操作的起点。", "List running apps (name, pid, bundleId, whether frontmost). The starting point for background computer operation."),
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "computer_launch", command: "launch",
      description: p("在后台启动应用（不切到前台）；已在运行则直接返回 pid。", "Launch an app in the background (without bringing it to the front); if it's already running, return its pid directly."),
      inputSchema: { type: "object", properties: { bundleId: { type: "string", description: p("例如 com.apple.TextEdit", "e.g. com.apple.TextEdit") } }, required: ["bundleId"], additionalProperties: false }
    },
    {
      name: "computer_windows", command: "windows",
      description: p("列出应用的窗口（windowId、标题、位置、是否可见）。", "List an app's windows (windowId, title, position, whether visible)."),
      inputSchema: { type: "object", properties: { pid }, required: ["pid"], additionalProperties: false }
    },
    {
      name: "computer_screenshot", command: "screenshot",
      description: p("截取应用窗口的图片，窗口在后台或被遮挡也能截，不切前台。", "Capture an image of an app window; works even when the window is in the background or covered, without bringing it to the front."),
      inputSchema: {
        type: "object",
        properties: { pid, windowId: { type: "integer" }, windowTitle: { type: "string", description: p("按标题包含的文字选窗口", "Pick the window whose title contains this text") } },
        required: ["pid"], additionalProperties: false
      }
    },
    {
      name: "computer_ui_tree", command: "tree",
      description: p("读取应用的界面结构（按钮、输入框、文字、菜单等，带元素编号、可执行动作和位置）。内容多时用 id 只读某个子树，或用 query 按文字过滤。", "Read an app's UI structure (buttons, input fields, text, menus, etc., with element ids, available actions and positions). When there's a lot of content, use id to read only one subtree, or query to filter by text."),
      inputSchema: {
        type: "object",
        properties: { pid, id: { type: "string", description: p("只读取这个元素下面的子树", "Only read the subtree under this element") }, query: { type: "string", description: p("只返回标题、说明、内容里包含这段文字的元素", "Only return elements whose title, description or content contains this text") }, depth: { type: "integer" }, max: { type: "integer" } },
        required: ["pid"], additionalProperties: false
      }
    },
    {
      name: "computer_read", command: "read",
      description: p("读取一个元素的完整内容（输入框、文本区的全部文字、选中的文字等）。", "Read an element's full content (all the text in an input field or text area, the selected text, etc.)."),
      inputSchema: { type: "object", properties: { pid, id }, required: ["pid", "id"], additionalProperties: false }
    },
    {
      name: "computer_press", command: "press",
      description: p("按下按钮、勾选框、列表项等（AXPress），不切前台。", "Press a button, checkbox, list item, etc. (AXPress), without bringing the app to the front."),
      inputSchema: { type: "object", properties: { pid, id }, required: ["pid", "id"], additionalProperties: false }
    },
    {
      name: "computer_action", command: "action",
      description: p("对元素执行 computer_ui_tree 里列出的其他动作，例如 AXIncrement、AXDecrement、AXConfirm、AXCancel、AXRaise。", "Perform another action listed in computer_ui_tree on an element, e.g. AXIncrement, AXDecrement, AXConfirm, AXCancel, AXRaise."),
      inputSchema: { type: "object", properties: { pid, id, action: { type: "string" } }, required: ["pid", "id", "action"], additionalProperties: false }
    },
    {
      name: "computer_set_value", command: "set_value",
      description: p("把输入框或文本区的内容整体替换成 value。", "Replace the entire content of an input field or text area with value."),
      inputSchema: { type: "object", properties: { pid, id, value: { type: "string" } }, required: ["pid", "id", "value"], additionalProperties: false }
    },
    {
      name: "computer_insert_text", command: "insert_text",
      description: p("在输入框或文本区的光标处插入文字（替换当前选中的文字）。", "Insert text at the cursor in an input field or text area (replacing the current selection)."),
      inputSchema: { type: "object", properties: { pid, id, text: { type: "string" } }, required: ["pid", "id", "text"], additionalProperties: false }
    },
    {
      name: "computer_menu", command: "menu",
      description: p("按下应用菜单栏里的菜单项，例如 [\"文件\",\"导出为 PDF…\"]，不切前台。", "Press a menu item in the app's menu bar, e.g. [\"File\",\"Export as PDF…\"], without bringing the app to the front."),
      inputSchema: { type: "object", properties: { pid, path: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["pid", "path"], additionalProperties: false }
    }
  ];
}

/** Original text approved by the user on 2026-09-19; get the user's consent before changing it */
export function computerToolGuidance(): string {
  return p("操作其他应用的界面时，优先使用阿钉提供的 computer_* 工具：它们在后台读取界面、截图、按按钮和填写内容，不会把应用切到前台，用户可以同时正常使用电脑。只有这些工具确实做不到时，才使用会切到前台或占用键盘鼠标的方式（例如 osascript 的 activate、System Events 模拟按键），并在回复里说明原因。", "When operating other apps' interfaces, prefer the computer_* tools provided by ADing: they read the interface, take screenshots, press buttons and fill in content in the background without bringing the app to the front, so the user can keep using the computer normally. Only when these tools really can't do it, use methods that bring apps to the front or take over the keyboard and mouse (such as osascript's activate or System Events keystrokes), and explain why in your reply.");
}

/**
 * When this turn has computer-use tools attached, usage instructions are appended to the end of the prompt.
 * The instructions are added by ADing itself, so in split delivery they go with the app half, not the conversation.
 */
export function withComputerGuidance<T extends Pick<TurnInput, "prompt" | "split" | "fullAccess" | "discussionOnly" | "communicationOnly" | "noComputerTools">>(input: T): T {
  if (!computerToolsEnabled(input)) return input;
  const guidance = computerToolGuidance();
  return {
    ...input,
    prompt: `${input.prompt}\n\n${guidance}`,
    ...(input.split ? { split: { ...input.split, app: `${input.split.app}\n\n${guidance}` } } : {})
  };
}

const BY_NAME = new Map(computerTools().map((tool) => [tool.name, tool]));

export function isComputerTool(name: string): boolean {
  return BY_NAME.has(name);
}

/**
 * Offered only in execution turns that change things: discussion, communication-only and read-only check turns can't press buttons or change content.
 * Only macOS has this capability.
 */
export function computerToolsEnabled(input: Pick<TurnInput, "fullAccess" | "discussionOnly" | "communicationOnly" | "noComputerTools">, platform = process.platform): boolean {
  return platform === "darwin" && !!input.fullAccess && !input.discussionOnly && !input.communicationOnly && !input.noComputerTools;
}

/** Packaged builds use ADing.app/Contents/Resources/bin/; dev runs use the compiled copy under dist-native/. */
export function computerHelperPath(): string {
  const override = process.env.ADING_COMPUTER_HELPER;
  if (override) return override;
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? path.join(resources, "bin", "ading-computer") : "";
  if (packaged && existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "..", "dist-native", "ading-computer");
}

function runHelper(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    execFile(computerHelperPath(), [command, JSON.stringify(args)], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, signal, env: { ...process.env, ADING_LANGUAGE: isEnglish() ? "en" : "zh" } }, (error, stdout) => {
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        resolve({ ok: false, error: error ? p(`电脑操作工具运行失败：${error.message}`, `Computer operation tool failed to run: ${error.message}`) : p("电脑操作工具没有返回结果", "Computer operation tool returned no result") });
      }
    });
  });
}

export async function runComputerTool(name: string, rawArgs: unknown, signal?: AbortSignal): Promise<ComputerToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return { content: [{ type: "text", text: p(`未知工具：${name}`, `Unknown tool: ${name}`) }], isError: true };
  const args = rawArgs && typeof rawArgs === "object" ? { ...(rawArgs as Record<string, unknown>) } : {};
  let shot: string | undefined;
  if (tool.command === "screenshot") {
    shot = path.join(os.tmpdir(), `ading-computer-${randomBytes(6).toString("hex")}.png`);
    args.out = shot;
  }
  const started = Date.now();
  try {
    const result = await runHelper(tool.command, args, signal);
    if (result.ok !== true) {
      const message = String(result.error ?? "");
      // The screenshot out is a temp file name with no diagnostic value; log the other arguments as-is
      const { out: _out, ...logged } = args;
      toolLogger?.("computer-tool-failed", {
        tool: name, command: tool.command, args: logged, durationMs: Date.now() - started,
        error: message, ...(result.permission ? { permission: result.permission } : {})
      });
      if (result.permission === "accessibility" || result.permission === "screenRecording") permissionListener?.(result.permission, message);
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
    }
    if (shot) {
      const data = (await readFile(shot)).toString("base64");
      const { path: _path, ...meta } = result;
      return { content: [{ type: "text", text: JSON.stringify(meta) }, { type: "image", data, mimeType: "image/png" }], isError: false };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
  } finally {
    if (shot) await rm(shot, { force: true }).catch(() => undefined);
  }
}

export type ComputerPermissionKind = "accessibility" | "screenRecording";
/** Triggers the system permission prompt (shown only on the first request; afterwards it must be enabled manually in System Settings) */
export async function requestComputerPermission(kind: ComputerPermissionKind): Promise<void> {
  await runHelper("request", { kind });
}

/** Status of the Automation permission (whether ADing can control a given app) */
export type AutomationStatus = "granted" | "denied" | "notDetermined" | "notRunning" | "unknown";

/** Apps Agents most often control via AppleScript: System Events for keystrokes and UI scripting, Finder for files */
export const AUTOMATION_TARGETS = [
  { bundleId: "com.apple.systemevents", name: "System Events" },
  { bundleId: "com.apple.finder", name: "Finder" }
] as const;

function automationStatusOf(value: unknown): AutomationStatus {
  return value === "granted" || value === "denied" || value === "notDetermined" || value === "notRunning" ? value : "unknown";
}

/**
 * Used by "System permissions" in Settings → Permissions: checks which permissions ADing already has on this computer. **Check only, never show any prompt**.
 * When another computer assigns work remotely, nobody is at this one to click a permission prompt and the task stalls, so check and grant while someone is present.
 */
export async function checkComputerPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean; automation: Record<string, AutomationStatus> }> {
  const [basic, automation] = await Promise.all([
    runHelper("permissions", {}),
    runHelper("automation", { bundleIds: AUTOMATION_TARGETS.map((target) => target.bundleId) })
  ]);
  const raw = (automation.automation ?? {}) as Record<string, unknown>;
  return {
    accessibility: basic.accessibility === true,
    screenRecording: basic.screenRecording === true,
    automation: Object.fromEntries(AUTOMATION_TARGETS.map((target) => [target.bundleId, automationStatusOf(raw[target.bundleId])]))
  };
}

/** Shows the system "ADing wants to control xxx" prompt and returns after the user responds. Called only when the user clicks "Grant now" */
export async function requestAutomation(bundleId: string): Promise<AutomationStatus> {
  const result = await runHelper("request-automation", { bundleId });
  return automationStatusOf(((result.automation ?? {}) as Record<string, unknown>)[bundleId]);
}

/** Notifies the UI when an Agent's tool call fails for lack of permission, so the user knows to grant it instead of the task silently failing */
let permissionListener: ((kind: ComputerPermissionKind, message: string) => void) | undefined;
export function onComputerPermissionMissing(listener: (kind: ComputerPermissionKind, message: string) => void): void {
  permissionListener = listener;
}

/**
 * Call log for computer-use tools.
 *
 * Why: in a 2026-09-20 report computer_screenshot failed, but the log had only one
 * `tool-event ... phase:"started"` entry and not a word of the failure text, leaving only guesses about permissions or something else.
 * Arguments, results and raw failure text of key calls must be readable from reported logs.
 */
let toolLogger: ((event: string, data: Record<string, unknown>) => void) | undefined;
export function onComputerToolLog(logger: (event: string, data: Record<string, unknown>) => void): void {
  toolLogger = logger;
}

/**
 * dynamicTools definitions for Codex app-server.
 *
 * Must carry type/deferLoading like parallelTool: the Codex server requires dynamic tools in one request
 * to use one format; without these two fields they'd mix two formats with ading_parallel and the whole turn would be rejected
 * (Invalid request: dynamic tools must use either canonical or legacy format consistently).
 */
export function computerDynamicTools(): Array<{ type: "function"; name: string; deferLoading: boolean; description: string; inputSchema: Record<string, unknown> }> {
  return computerTools().map(({ name, description, inputSchema }) =>
    ({ type: "function" as const, name, deferLoading: false, description, inputSchema }));
}

/** Converts to the Codex dynamic tool result format: images as data URLs */
export function toCodexContent(result: ComputerToolResult): Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }> {
  return result.content.map((item) => item.type === "image"
    ? { type: "inputImage" as const, imageUrl: `data:${item.mimeType};base64,${item.data}` }
    : { type: "inputText" as const, text: item.text ?? "" });
}
