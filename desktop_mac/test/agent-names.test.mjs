import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DEFAULT_AGENT_NAMES } = require("../dist/agents/default-names.js");
const { AGENT_DEFAULT_NAMES, localizedAgentName, storedAgentName } = await import("../dist/ui/agent-names.js");

let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`); passed += 1; };

for (const [kind, zh] of Object.entries(DEFAULT_AGENT_NAMES)) {
  check(`${kind} Chinese default name matches between UI and main process`, AGENT_DEFAULT_NAMES[kind]?.zh === zh, { kind, zh, ui: AGENT_DEFAULT_NAMES[kind] });
  check(`${kind} English name contains no Chinese`, !/[一-鿿]/.test(AGENT_DEFAULT_NAMES[kind].en), AGENT_DEFAULT_NAMES[kind].en);
}
check("both lists cover the same Agents", Object.keys(AGENT_DEFAULT_NAMES).sort().join() === Object.keys(DEFAULT_AGENT_NAMES).sort().join());
check("English UI: 小c shows as Cody", localizedAgentName("codex", "小c", "en") === "Cody");
check("English UI: 小q-cn shows as Quincy", localizedAgentName("qoder-cn", "小q-cn", "en") === "Quincy");
check("Chinese UI doesn't change it", localizedAgentName("codex", "小c", "zh-CN") === "小c");
check("renamed names don't change", localizedAgentName("codex", "我的助手", "en") === "我的助手");
check("another vendor's default name isn't mixed in", localizedAgentName("qoder", "小c", "en") === "小c");
check("English default name is stored back as Chinese on save", storedAgentName("claude-code", "Cleo") === "小cc");
check("renamed names are stored as-is on save", storedAgentName("claude-code", "Cleo 2") === "Cleo 2");

console.log(`agent-names: ${passed} passed, 0 failed`);
