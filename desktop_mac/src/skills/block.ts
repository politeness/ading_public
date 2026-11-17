import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { p } from "../prompt-language";

/**
 * Managed block.
 *
 * When ADing writes into an agent's rules file it only touches content between these two markers;
 * everything outside the block is left alone — the user's handwritten rules must not be wiped.
 * This is the old trick shell rc and hosts files use: reliable and reversible.
 */
export const BLOCK_BEGIN =
  "<!-- ADING:BEGIN 由 ADing 公共技能库同步，请勿手改；要改请到 ADing 里改 -->";
export const BLOCK_END = "<!-- ADING:END -->";

/**
 * Create a new regex every time.
 *
 * Don't share one instance with the g flag: `.test()` advances its lastIndex,
 * so the next call starts matching mid-string and returns false, turning a "replace" into an "append",
 * and the file accumulates two managed blocks. Unit tests caught this one.
 */
function blockPattern(): RegExp {
  return new RegExp(
    `\\n?${escapeRegExp(BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}\\n?`,
    "g"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render a set of skills as one Markdown section. Agents with "one big rules file" like codex use this shape */
export function renderManagedBlock(skills: Skill[]): string {
  const enabled = skills.filter((skill) => skill.enabled);
  const body = enabled.length
    ? enabled
        .map((skill) => {
          const head = `### ${skill.name}`;
          const desc = skill.description ? `_${skill.description}_` : "";
          const content = skill.source
            ? p(`完整技能包入口：${path.join(skill.source.directory, "SKILL.md")}\n技能标识：${skill.skillId}`, `Complete skill package entry: ${path.join(skill.source.directory, "SKILL.md")}\nSkill ID: ${skill.skillId}`)
            : skill.content.trim();
          return [head, desc, "", content]
            .filter((line) => line !== "")
            .join("\n");
        })
        .join("\n\n")
    : p("（暂无）", "(none yet)");

  return [
    BLOCK_BEGIN,
    "",
    p("## ADing 团队技能", "## ADing team skills"),
    "",
    p("以下内容由 ADing 从公共技能库同步而来，多个 Agent 共用。", "The following is synced by ADing from the shared skill library and is shared by multiple Agents."),
    "",
    body,
    "",
    BLOCK_END
  ].join("\n");
}

/** Insert the block into existing content: replace an old block in place, otherwise append to the end */
export function applyManagedBlock(existing: string, block: string): string {
  if (hasManagedBlock(existing)) {
    return existing.replace(blockPattern(), `\n${block}\n`);
  }
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

/** Withdraw: remove the whole managed block, keep content outside it as is */
export function stripManagedBlock(existing: string): string {
  return existing.replace(blockPattern(), "\n").replace(/\n{3,}/g, "\n\n");
}

export function hasManagedBlock(existing: string): boolean {
  return blockPattern().test(existing);
}

/** Atomic write: write a temp file then rename, so a crash never leaves half a file */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.ading.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

export async function writeManagedBlock(
  filePath: string,
  skills: Skill[],
  options: {ownerFingerprint?:string} = {}
): Promise<void> {
  const existing = await readFile(filePath, "utf8").catch(() => "");
  const block=renderManagedBlock(skills);
  const owned=options.ownerFingerprint ? block.replace(BLOCK_BEGIN,`${BLOCK_BEGIN}\n<!-- ADING:OWNER ${options.ownerFingerprint} -->`) : block;
  await writeAtomic(filePath, applyManagedBlock(existing, owned));
}

export async function removeManagedBlock(filePath: string,options:{ownerFingerprint?:string} = {}): Promise<boolean> {
  const existing = await readFile(filePath, "utf8").catch(() => null);
  if (existing === null || !hasManagedBlock(existing)) return false;
  if(options.ownerFingerprint && !existing.includes(`<!-- ADING:OWNER ${options.ownerFingerprint} -->`)) return false;
  await writeAtomic(filePath, stripManagedBlock(existing));
  return true;
}
