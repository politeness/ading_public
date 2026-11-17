import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";

// Run protocol and dispatch logic with a fake native tool; the real tool gets a separate smoke call
const dir = await mkdtemp(path.join(os.tmpdir(), "ading-computer-test-"));
const fake = path.join(dir, "fake-computer");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
await writeFile(fake, `#!/bin/sh
case "$1" in
  apps) echo '{"ok":true,"apps":[{"pid":42,"name":"测试应用"}]}' ;;
  screenshot) out=$(printf '%s' "$2" | sed -E 's/.*"out":"([^"]+)".*/\\1/'); printf '%s' '${png}' | base64 -D > "$out"; echo "{\\"ok\\":true,\\"path\\":\\"$out\\",\\"width\\":1,\\"height\\":1}" ;;
  press) echo '{"ok":false,"error":"阿钉还没有「辅助功能」权限：请在 系统设置 → 隐私与安全性 → 辅助功能 里打开阿钉","permission":"accessibility"}'; exit 1 ;;
  *) echo '{"ok":true}' ;;
esac
`);
await chmod(fake, 0o755);
process.env.ADING_COMPUTER_HELPER = fake;

const tools = await import("../dist/agents/computer-tools.js");
const { adingMcpNeeded, startParallelMcp } = await import("../dist/agents/parallel-mcp.js");
const { parallelTool } = await import("../dist/agents/parallel-work.js");
let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`); passed += 1; };

// Which turns get computer-use tools
check("Provided in fully authorized execution turns", tools.computerToolsEnabled({ fullAccess: true }, "darwin"));
check("Not provided for read-only review", !tools.computerToolsEnabled({ fullAccess: false }, "darwin"));
check("Not provided for discussion", !tools.computerToolsEnabled({ fullAccess: true, discussionOnly: true }, "darwin"));
check("Not provided for communication-only turns", !tools.computerToolsEnabled({ fullAccess: true, communicationOnly: true }, "darwin"));
check("Not provided on non-macOS", !tools.computerToolsEnabled({ fullAccess: true }, "linux"));

// Prompt: attach the user-approved original text only when tools are provided
const guided = tools.withComputerGuidance({ prompt: "做事", fullAccess: true });
check("Execution turns attach the usage guidance", guided.prompt === `做事\n\n${tools.computerToolGuidance()}`);
check("Guidance is the user-approved original text", tools.computerToolGuidance().startsWith("操作其他应用的界面时，优先使用阿钉提供的 computer_* 工具") && tools.computerToolGuidance().includes("并在回复里说明原因"));
check("Discussion turns do not attach guidance", tools.withComputerGuidance({ prompt: "讨论", fullAccess: true, discussionOnly: true }).prompt === "讨论");

// MCP: execution turns with only computer use and no parallel dispatch also start the ADing tool server
check("MCP is needed even with only computer use", adingMcpNeeded({ fullAccess: true }));
check("Discussion turns do not need MCP", !adingMcpNeeded({ fullAccess: true, discussionOnly: true }));
const missing = [];
tools.onComputerPermissionMissing((kind) => missing.push(kind));
const bridge = await startParallelMcp({ fullAccess: true });
const config = JSON.parse(bridge.config).mcpServers.ading;
const call = async (method, params = {}) => (await fetch(config.url, {
  method: "POST", headers: { ...config.headers, "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
})).json();
try {
  const names = (await call("tools/list")).result.tools.map((tool) => tool.name);
  check("Lists all computer-use tools", tools.computerTools().every((tool) => names.includes(tool.name)), names);
  check("ading_parallel not listed without dispatch", !names.includes("ading_parallel"), names);
  const apps = (await call("tools/call", { name: "computer_apps", arguments: {} })).result;
  check("Call returns the tool result", !apps.isError && JSON.parse(apps.content[0].text).apps[0].name === "测试应用", apps);
  const shot = (await call("tools/call", { name: "computer_screenshot", arguments: { pid: 42 } })).result;
  check("Screenshot returned as an image", shot.content.some((item) => item.type === "image" && item.mimeType === "image/png" && item.data === png), shot);
  check("Screenshot temp file path is not leaked", !shot.content[0].text.includes("ading-computer-"), shot.content[0].text);
  const denied = (await call("tools/call", { name: "computer_press", arguments: { pid: 42, id: "0" } })).result;
  check("Returns an error when permission is missing", denied.isError === true);
  check("Notifies the UI when permission is missing", missing.includes("accessibility"), missing);
} finally {
  bridge.close();
}
const discussion = await startParallelMcp({ fullAccess: true, discussionOnly: true, onParallelWork: async () => ({}) });
try {
  const c = JSON.parse(discussion.config).mcpServers.ading;
  const listed = await (await fetch(c.url, { method: "POST", headers: { ...c.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
  check("Discussion turns only have the dispatch tool", listed.result.tools.map((tool) => tool.name).join() === "ading_parallel", listed.result.tools.map((tool) => tool.name));
} finally {
  discussion.close();
}

// Codex: dynamic tool definitions and image return format
check("Codex dynamic tool definitions are complete", tools.computerDynamicTools().length === tools.computerTools().length);
// The Codex server requires dynamic tools in one request to share a format: computer_* missing type/deferLoading would
// mix with ading_parallel into two formats and the whole turn is rejected (dynamic tools must use either canonical or legacy format consistently).
check("Codex dynamic tools share the same format as ading_parallel",
  tools.computerDynamicTools().every(tool => tool.type === parallelTool.type && typeof tool.deferLoading === typeof parallelTool.deferLoading));
const codex = tools.toCodexContent({ isError: false, content: [{ type: "text", text: "{}" }, { type: "image", data: png, mimeType: "image/png" }] });
check("Codex images use a data URL", codex[1].type === "inputImage" && codex[1].imageUrl === `data:image/png;base64,${png}`);

// Real native tool smoke test: runs and returns JSON
delete process.env.ADING_COMPUTER_HELPER;
const real = tools.computerHelperPath();
const permissions = JSON.parse(execFileSync(real, ["permissions"], { encoding: "utf8" }));
check("Native tool runs and returns permission status", permissions.ok === true && typeof permissions.accessibility === "boolean", permissions);
const unknown = (() => { try { execFileSync(real, ["nope"], { encoding: "utf8" }); return null; } catch (error) { return JSON.parse(error.stdout); } })();
check("Unknown command reports an explicit error", unknown?.ok === false && unknown.error.includes("未知命令"), unknown);
const unknownEn = (() => { try { execFileSync(real, ["nope"], { encoding: "utf8", env: { ...process.env, ADING_LANGUAGE: "en" } }); return null; } catch (error) { return JSON.parse(error.stdout); } })();
check("Native tool returns English under the English UI", unknownEn?.error === "Unknown command: nope", unknownEn);

// English UI: guidance and tool descriptions for the Agent are in English
const i18n = await import("../dist/i18n.js");
i18n.setMainLanguage("en");
check("Usage guidance is English under the English UI", tools.computerToolGuidance().startsWith("When operating other apps' interfaces, prefer the computer_* tools"));
check("Tool descriptions are English under the English UI", tools.computerTools().every((tool) => !/[\u4e00-\u9fff]/.test(JSON.stringify(tool))));
i18n.setMainLanguage("zh");

console.log(`computer-tools: ${passed} passed, 0 failed`);
