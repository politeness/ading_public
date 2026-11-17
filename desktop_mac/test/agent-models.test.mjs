import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { parseQoderModels } from "../dist/agents/qoder.js";
import { acpModels } from "../dist/agents/acp-agent.js";
import { modelSelection, resolveRuntimeConfig } from "../dist/agents/runtime-config.js";
import { LocalStore } from "../dist/store/local.js";
import { parseAgyModels, AntigravityAdapter } from "../dist/agents/antigravity.js";
import { parseKiroModels, KiroAdapter, CopilotAdapter } from "../dist/agents/acp-providers.js";
import { qwenModelOptions } from "../dist/agents/qwen-config.js";
import { QwenCodeAdapter } from "../dist/agents/qwen.js";
import { mkdir, writeFile, rm } from "node:fs/promises";

// Qoder --list-models: the header isn't a model; custom models are selected by ID, names are only for display
assert.deepEqual(parseQoderModels("MODEL\nAuto\nQwen3.8-Max\nQwen-3.8-Max (4d4401e0-3110)\n\n"), [
  { id: "Auto", label: "Auto" },
  { id: "Qwen3.8-Max", label: "Qwen3.8-Max" },
  { id: "4d4401e0-3110", label: "Qwen-3.8-Max" }
]);

// ACP: configOptions first, with group support; otherwise read the old models metadata
assert.deepEqual(acpModels({ configOptions: [
  { category: "thought_level", options: [{ value: "high", name: "High" }] },
  { category: "model", options: [{ value: "a", name: "A" }, { group: "g", options: [{ value: "b", description: "B 说明" }] }] }
] }), [{ id: "a", label: "A", description: undefined }, { id: "b", label: "b", description: "B 说明" }]);
assert.deepEqual(acpModels({ models: { availableModels: [{ modelId: "m", name: "M" }] } }),
  [{ id: "m", label: "M", description: undefined }]);
assert.deepEqual(acpModels({}), []);

// Inherited effort and Fast are overridden only when the vendor explicitly doesn't support them
const option = { id: "m", label: "M", efforts: ["low", "medium"], defaultEffort: "medium", supportsFast: false };
assert.deepEqual(modelSelection(option, { reasoningEffort: "xhigh", fastMode: true }),
  { model: "m", source: "ADing", reasoningEffort: "medium", fastMode: false });
assert.deepEqual(modelSelection(option, { reasoningEffort: "low", fastMode: false }), { model: "m", source: "ADing" });
assert.deepEqual(modelSelection({ id: "m", label: "M" }, { reasoningEffort: "xhigh", fastMode: true }), { model: "m", source: "ADing" });

// The model chosen in ADing takes priority over the original app; other fields keep following the original app
const resolved = await resolveRuntimeConfig({ app: { model: "picked", source: "ADing" },
  native: async () => ({ model: "native", reasoningEffort: "high" }) });
assert.equal(resolved.model, "picked");
assert.equal(resolved.reasoningEffort, "high");
assert.equal((await resolveRuntimeConfig({ app: {}, native: async () => ({ model: "native" }) })).model, "native");

// The choice is persisted; rediscovering the Agent must not wipe it; clearing reverts to following
const root = await mkdtemp(path.join(os.tmpdir(), "ading-agent-models-"));
const discovered = { localUuid: "local-1", kind: "codex", executablePath: "/bin/true", version: "1", label: "Codex" };
const store = new LocalStore(root);
await store.init();
const [agent] = await store.syncDiscoveredAgents([discovered]);
await store.updateAgent(agent.userId, { modelConfig: { model: "picked", source: "ADing" } });
await store.syncDiscoveredAgents([{ ...discovered, runtimeDefaults: { model: "native" } }]);
const reopened = new LocalStore(root);
await reopened.init();
assert.equal((await reopened.getUser(agent.userId)).modelConfig.model, "picked");
await reopened.updateAgent(agent.userId, { modelConfig: {} });
assert.equal((await reopened.getUser(agent.userId)).modelConfig, undefined);

// Antigravity: sample output of agy models from the official docs
assert.deepEqual(parseAgyModels("gemini-4-argon-high       Gemini 4 Argon (High)\ngemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\n\nWarning: something\nbare-model\n"), [
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "bare-model", label: "bare-model" }
]);

// Kiro: the docs don't give the JSON structure, so accept both arrays and objects
assert.deepEqual(parseKiroModels(JSON.stringify({ models: [{ model_name: "Auto", model_id: "auto", description: "说明" }, { modelId: "x" }, {}] })), [
  { id: "auto", label: "Auto", description: "说明" }, { id: "x", label: "x", description: undefined }
]);
assert.deepEqual(parseKiroModels(JSON.stringify(["a"])), [{ id: "a", label: "a", description: undefined }]);
assert.throws(() => parseKiroModels("not json"));

// Qwen: list only models for the current auth method; project config replaces the user config wholesale; image- and audio-only models aren't listed
const qwenRoot = await mkdtemp(path.join(os.tmpdir(), "ading-qwen-models-"));
const previous = { QWEN_HOME: process.env.QWEN_HOME, SYSTEM: process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH, DEFAULTS: process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH, TRUST: process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH };
process.env.QWEN_HOME = path.join(qwenRoot, "home");
process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH = path.join(qwenRoot, "system.json");
process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH = path.join(qwenRoot, "defaults.json");
process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH = path.join(qwenRoot, "trust.json");
const workspace = path.join(qwenRoot, "project");
await mkdir(process.env.QWEN_HOME, { recursive: true });
await mkdir(path.join(workspace, ".qwen"), { recursive: true });
const userSettings = { security: { auth: { selectedType: "openai" } }, modelProviders: {
  openai: [{ id: "m1", name: "Model 1", description: "说明", capabilities: { reasoning: { efforts: ["low", "high"], defaultEffort: "low" } } },
    { id: "m1", name: "duplicate" }, { id: "m2" }, { id: "image", imageOnly: true }, { id: "voice", realtimeOnly: true }, { name: "no id" }],
  anthropic: [{ id: "other" }] } };
await writeFile(path.join(process.env.QWEN_HOME, "settings.json"), JSON.stringify(userSettings));
assert.deepEqual(await qwenModelOptions(workspace), [
  { id: "m1", label: "Model 1", description: "说明", efforts: ["low", "high"], defaultEffort: "low" },
  { id: "m2", label: "m2", description: undefined }
]);
await writeFile(path.join(process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH), JSON.stringify({ [workspace]: "TRUST_FOLDER" }));
await writeFile(path.join(workspace, ".qwen/settings.json"), JSON.stringify({ modelProviders: { openai: [{ id: "project-only" }] } }));
assert.deepEqual((await qwenModelOptions(workspace)).map(item => item.id), ["project-only"]);
await rm(path.join(workspace, ".qwen/settings.json"));
await writeFile(path.join(process.env.QWEN_HOME, "settings.json"), JSON.stringify({ ...userSettings, security: { auth: { selectedType: "qwen-oauth" } } }));
assert.deepEqual(await qwenModelOptions(workspace), [], "qwen-oauth has no readable catalog, so the entry is hidden");
for (const [key, value] of [["QWEN_HOME", previous.QWEN_HOME], ["QWEN_CODE_SYSTEM_SETTINGS_PATH", previous.SYSTEM], ["QWEN_CODE_SYSTEM_DEFAULTS_PATH", previous.DEFAULTS], ["QWEN_CODE_TRUSTED_FOLDERS_PATH", previous.TRUST]]) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

// All four are integrated; actually run the fake CLI to confirm the command line and parsing fit together
assert.equal(typeof new QwenCodeAdapter().listModels, "function");
assert.equal(typeof new CopilotAdapter().listModels, "function");
const fake = path.join(qwenRoot, "fake-cli.cjs");
await writeFile(fake, `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "models") { console.log("gemini-3.1-pro-high   Gemini 3.1 Pro (High)"); process.exit(0); }
if (args === "chat --list-models --format json") { console.log(process.env.FAKE_KIRO_BAD ? "oops" : JSON.stringify({ models: [{ model_id: "auto", model_name: "Auto" }] })); process.exit(0); }
process.exit(3);
`, { mode: 0o755 });
const fakeAgent = (kind) => ({ kind, localUuid: "fake-" + kind, executablePath: fake, version: "1", label: kind });
assert.deepEqual(await new AntigravityAdapter().listModels(fakeAgent("antigravity")), [{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }]);
assert.deepEqual(await new KiroAdapter().listModels(fakeAgent("kiro")), [{ id: "auto", label: "Auto", description: undefined }]);

// The model list is cached for a day: re-queried only when expired or the CLI version changes; survives restart; read/write failures don't block
{
  const { AgentModelCache, AGENT_MODEL_CACHE_TTL_MS } = await import("../dist/agents/model-cache.js");
  const { mkdtemp: makeTemp, rm: removeDir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await makeTemp(join(tmpdir(), "ading-model-cache-"));
  try {
    let clock = 1000;
    const file = join(dir, "nested", "cache.json"), models = [{ id: "a", label: "A" }];
    const cache = new AgentModelCache(file, () => clock);
    assert.equal(await cache.get("u1", "1.0"), undefined);
    await cache.set("u1", "1.0", models);
    assert.deepEqual(await cache.get("u1", "1.0"), models);
    assert.equal(await cache.get("u2", "1.0"), undefined, "each Agent has its own list");
    assert.equal(await cache.get("u1", "1.1"), undefined, "a new CLI version asks again");
    const restarted = new AgentModelCache(file, () => clock);
    assert.deepEqual(await restarted.get("u1", "1.0"), models, "survives a restart");
    clock += AGENT_MODEL_CACHE_TTL_MS - 1;
    assert.deepEqual(await restarted.get("u1", "1.0"), models, "still fresh within a day");
    clock += 1;
    assert.equal(await restarted.get("u1", "1.0"), undefined, "expires after a day");
    clock = 0;
    assert.equal(await cache.get("u1", "1.0"), undefined, "a clock moved backwards does not keep it forever");
    const broken = new AgentModelCache(join(dir, "nested"), () => clock);
    assert.equal(await broken.get("u1", "1.0"), undefined, "an unreadable file means no cache");
    await broken.set("u1", "1.0", models);
    assert.deepEqual(await broken.get("u1", "1.0"), models, "a failed write still works in memory");
  } finally { await removeDir(dir, { recursive: true, force: true }); }
}

console.log("agent-models: 21 passed, 0 failed");
