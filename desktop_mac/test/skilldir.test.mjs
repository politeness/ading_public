// Writing and reclaiming skill directories. Most important: never delete the user's own skill directories
import { mkdtempSync } from "./tmp.mjs";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const m = await import(path.resolve("dist/skills/skill-dir.js"));

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++; else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

const skill = (id, name, extra = {}) => ({
  skillId: id, name, description: `什么时候用 ${name}`, content: `${name} 的正文。`,
  enabled: true, scope: "workspace", authorKind: "agent", useCount: 0,
  createdAt: "", updatedAt: "", ...extra
});

const root = mkdtempSync(path.join(tmpdir(), "ading-skills-"));

// The user's own skill directory must never be touched
mkdirSync(path.join(root, "my-own-skill"), { recursive: true });
writeFileSync(path.join(root, "my-own-skill", "SKILL.md"), "我自己写的", "utf8");
// Name happens to start with ading- but has no marker file -- must not be touched either
mkdirSync(path.join(root, "ading-lookalike"), { recursive: true });
writeFileSync(path.join(root, "ading-lookalike", "SKILL.md"), "看着像但不是", "utf8");

const written = await m.writeSkillDirs(root, [
  skill("k_1", "MQ 幂等"),
  skill("k_2", "Commit style"),
  skill("k_3", "禁用项", { enabled: false })
]);

check("only writes enabled ones", written.length === 2, written);
const dirOf = (id, name) => "ading-" + (name ? name + "-" : "") + id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-6);
const commit = dirOf("k_2", "commit-style");
const mq = dirOf("k_1", "mq");
check("English name used as directory name", existsSync(path.join(root, commit, "SKILL.md")), commit);
check("only the leading part remains after stripping Chinese", existsSync(path.join(root, mq, "SKILL.md")), written);

// Different skills with the same name must not share one directory
const clash = await m.writeSkillDirs(root, [skill("k_1", "MQ 幂等"), skill("k_2", "MQ 重试")]);
check("colliding names still get separate directories", new Set(clash).size === 2, clash);
await m.removeSkillDirs(root);
await m.writeSkillDirs(root, [skill("k_1", "MQ 幂等"), skill("k_2", "Commit style"), skill("k_3", "禁用项", { enabled: false })]);

const body = readFileSync(path.join(root, commit, "SKILL.md"), "utf8");
check("has frontmatter name", body.includes("name: Commit style"));
check("has frontmatter description", body.includes("description: 什么时候用 Commit style"));
check("has body", body.includes("Commit style 的正文。"));
check("marker file written", existsSync(path.join(root, commit, ".ading-managed")));

// ---- reclaim: deleting one in ADing must remove it from disk too ----
await m.writeSkillDirs(root, [skill("k_2", "Commit style")]);
check("keeps the remaining ones", existsSync(path.join(root, commit, "SKILL.md")));
check("reclaims deleted ones", !existsSync(path.join(root, mq)));

check("does not touch the user's own directory", existsSync(path.join(root, "my-own-skill", "SKILL.md")));
check("does not touch unmarked directories with the same prefix", existsSync(path.join(root, "ading-lookalike", "SKILL.md")));

// ---- withdraw ----
const removed = await m.removeSkillDirs(root);
check("withdraw deletes only our own", removed.length === 1, removed);
check("ours are gone after withdraw", !existsSync(path.join(root, commit)));
check("user's remain after withdraw", existsSync(path.join(root, "my-own-skill", "SKILL.md")));
check("lookalike directory remains after withdraw", existsSync(path.join(root, "ading-lookalike", "SKILL.md")));

// ---- no crash when the directory does not exist ----
check("withdrawing from a missing directory returns empty", (await m.removeSkillDirs(path.join(root, "nope"))).length === 0);

// ---- a multi-line description must not break the frontmatter ----
const multi = m.renderSkillFile(skill("k_9", "多行", { description: "第一行\n第二行" }));
check("description collapsed to one line", multi.split("\n")[2] === "description: 第一行 第二行", multi.split("\n")[2]);

// ---- manually placed directory with the same name: adopt if content matches, otherwise report only this one ----
const named = (id, directoryName) => skill(id, directoryName, { directoryName });
const handRoot = mkdtempSync(path.join(tmpdir(), "ading-skills-hand-"));
const handDir = (name) => path.join(handRoot, name);
mkdirSync(handDir("ading-same"), { recursive: true });
writeFileSync(path.join(handDir("ading-same"), "SKILL.md"), m.renderSkillFile(named("k_same", "ading-same")), "utf8");
mkdirSync(path.join(handDir("ading-extra"), "agents"), { recursive: true });
writeFileSync(path.join(handDir("ading-extra"), "SKILL.md"), m.renderSkillFile(named("k_extra", "ading-extra")), "utf8");
writeFileSync(path.join(handDir("ading-extra"), "agents", "openai.yaml"), "interface: {}\n", "utf8");
mkdirSync(handDir("ading-edited"), { recursive: true });
writeFileSync(path.join(handDir("ading-edited"), "SKILL.md"), "用户改过", "utf8");
await m.writeSkillDirs(handRoot, [named("k_stale", "ading-stale")]);
check("stale managed directory ready", existsSync(path.join(handDir("ading-stale"), ".ading-managed")));

// Same name but different content: move as-is to a sibling backup directory, write the central version, no error
const handSkills = [named("k_edited", "ading-edited"), named("k_extra", "ading-extra"), named("k_same", "ading-same"), named("k_after", "ading-after")];
let handError;
try { await m.writeSkillDirs(handRoot, handSkills); } catch (error) { handError = error; }
check("same-name conflict does not error", handError === undefined, handError?.message);
const backupRoot = path.join(path.dirname(handRoot), m.BACKUP_DIR);
const backups = existsSync(backupRoot) ? readdirSync(backupRoot).filter((name) => name.startsWith("ading-edited-") || name.startsWith("ading-extra-")) : [];
const backupOf = (name) => path.join(backupRoot, backups.find((item) => item.startsWith(`${name}-`)) ?? "missing");
check("original directory moved intact to backup", backups.length === 2 && readFileSync(path.join(backupOf("ading-edited"), "SKILL.md"), "utf8") === "用户改过" && existsSync(path.join(backupOf("ading-extra"), "agents", "openai.yaml")), backups);
check("backup is not inside the skills directory", !readdirSync(handRoot).some((name) => name.includes("backup")));
check("directory with matching content is adopted", JSON.parse(readFileSync(path.join(handDir("ading-same"), ".ading-managed"), "utf8")).skillId === "k_same");
check("later skills are written as usual", existsSync(path.join(handDir("ading-after"), "SKILL.md")));
check("sync does not affect reclaim", !existsSync(handDir("ading-stale")));
check("directory with different content replaced by the central version", JSON.parse(readFileSync(path.join(handDir("ading-edited"), ".ading-managed"), "utf8")).skillId === "k_edited" && readFileSync(path.join(handDir("ading-edited"), "SKILL.md"), "utf8") !== "用户改过");
check("extra files do not leak into the central version", !existsSync(path.join(handDir("ading-extra"), "agents", "openai.yaml")) && existsSync(path.join(handDir("ading-extra"), ".ading-managed")));
for (const name of backups) rmSync(path.join(backupRoot, name), { recursive: true, force: true });

// Once adopted it is managed: re-syncing does not error, and central changes are followed
await m.writeSkillDirs(handRoot, [named("k_same", "ading-same")]);
await m.writeSkillDirs(handRoot, [{ ...named("k_same", "ading-same"), content: "中央新正文" }]);
check("follows central updates after adoption", readFileSync(path.join(handDir("ading-same"), "SKILL.md"), "utf8").includes("中央新正文"));

// Same-name directory synced from another account: the current account's central library wins, original moved to backup
const foreignRoot = mkdtempSync(path.join(tmpdir(), "ading-skills-foreign-"));
await m.writeSkillDirs(foreignRoot, [named("k_a", "ading-shared")], { ownerFingerprint: "library-a" });
let foreign;
try { await m.writeSkillDirs(foreignRoot, [named("k_b", "ading-shared")], { ownerFingerprint: "library-b" }); } catch (error) { foreign = error; }
const foreignBackups = readdirSync(path.join(path.dirname(foreignRoot), m.BACKUP_DIR)).filter((name) => name.startsWith("ading-shared-"));
check("other account's directory kept in backup", foreign === undefined && JSON.parse(readFileSync(path.join(foreignRoot, "ading-shared", ".ading-managed"), "utf8")).skillId === "k_b" && foreignBackups.length >= 1);
for (const name of foreignBackups) rmSync(path.join(path.dirname(foreignRoot), m.BACKUP_DIR, name), { recursive: true, force: true });

// Link placeholder: move only the link itself, leave the link target untouched
const linkRoot = mkdtempSync(path.join(tmpdir(), "ading-skills-link-"));
const linkTarget = mkdtempSync(path.join(tmpdir(), "ading-skills-link-target-"));
writeFileSync(path.join(linkTarget, "SKILL.md"), "外部内容", "utf8");
symlinkSync(linkTarget, path.join(linkRoot, "ading-linked"));
await m.writeSkillDirs(linkRoot, [named("k_link", "ading-linked")]);
check("link replaced by a managed directory and target untouched", !lstatSync(path.join(linkRoot, "ading-linked")).isSymbolicLink() && readFileSync(path.join(linkTarget, "SKILL.md"), "utf8") === "外部内容");
for (const name of readdirSync(path.join(path.dirname(linkRoot), m.BACKUP_DIR)).filter((item) => item.startsWith("ading-linked-"))) rmSync(path.join(path.dirname(linkRoot), m.BACKUP_DIR, name), { recursive: true, force: true });
rmSync(linkRoot, { recursive: true, force: true }); rmSync(linkTarget, { recursive: true, force: true });

try { rmdirSync(path.join(tmpdir(), m.BACKUP_DIR)); } catch {}
console.log(`skill-dir: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
