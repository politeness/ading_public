import { mkdtempSync } from "./tmp.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const m = await import(path.resolve("dist/skills/block.js"));

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

const skills = [
  { skillId: "k_1", name: "提交规范", description: "写 commit 时", content: "用祈使句，首行 50 字以内。", enabled: true, scope: "workspace", authorKind: "agent", useCount: 0, createdAt: "", updatedAt: "" },
  { skillId: "k_2", name: "禁用项", description: "永远不要", content: "不要 force push 到 main。", enabled: false, scope: "workspace", authorKind: "human", useCount: 0, createdAt: "", updatedAt: "" }
];

const block = m.renderManagedBlock(skills);
check("renders only enabled ones", block.includes("提交规范") && !block.includes("force push"));
check("has begin/end markers", block.includes("ADING:BEGIN") && block.includes("ADING:END"));

const userContent = "# 我自己的规则\n\n- 用 pnpm\n- 测试要过\n";
const once = m.applyManagedBlock(userContent, block);
check("keeps user content", once.includes("我自己的规则") && once.includes("用 pnpm"));
check("block inserted", m.hasManagedBlock(once));

// Idempotent: writing again must not produce two blocks
const twice = m.applyManagedBlock(once, block);
check("idempotent, only one block", (twice.match(/ADING:BEGIN/g) || []).length === 1);

// When content changes, the block is replaced, not appended
const block2 = m.renderManagedBlock([{ ...skills[0], name: "新规范", content: "改过了" }]);
const replaced = m.applyManagedBlock(twice, block2);
check("replaced, not appended", (replaced.match(/ADING:BEGIN/g) || []).length === 1 && replaced.includes("新规范") && !replaced.includes("提交规范"));
check("user content still present after replace", replaced.includes("用 pnpm"));

// Removal
const stripped = m.stripManagedBlock(replaced);
check("no block after removal", !m.hasManagedBlock(stripped));
check("user content intact after removal", stripped.includes("我自己的规则") && stripped.includes("用 pnpm") && stripped.includes("测试要过"));
check("no leftovers after removal", !stripped.includes("新规范") && !stripped.includes("ADing"));

// Empty file
const fresh = m.applyManagedBlock("", block);
check("can write to an empty file", m.hasManagedBlock(fresh));

// Disk round trip
const dir = mkdtempSync(path.join(tmpdir(), "ading-"));
const file = path.join(dir, "AGENTS.md");
writeFileSync(file, userContent, "utf8");
await m.writeManagedBlock(file, skills);
const onDisk = readFileSync(file, "utf8");
check("on-disk write keeps user content", onDisk.includes("用 pnpm") && onDisk.includes("提交规范"));
await m.writeManagedBlock(file, skills);
check("repeated disk writes still have only one block", (readFileSync(file,"utf8").match(/ADING:BEGIN/g) || []).length === 1);
const removed = await m.removeManagedBlock(file);
check("removal returns true", removed === true);
check("file is clean after removal", !readFileSync(file, "utf8").includes("ADING:BEGIN"));
check("removing from a file without a block returns false", (await m.removeManagedBlock(file)) === false);

console.log(`\nManaged block tests: passed ${pass}, failed ${fail}`);
process.exit(fail ? 1 : 0);
