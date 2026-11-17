import { mkdir, readdir, readFile, rename, writeFile, lstat, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { p } from "../prompt-language";
import { readPackageDirectory, fingerprintPackageFiles, writePackageCandidate, replaceDirectory, type PackageFile } from "../knowledge/bundle-files";
import path from "node:path";
import { removeTree } from "../platform/remove-tree";

/**
 * "One directory per skill" target, for agents like Claude Code that already have a skill mechanism.
 *
 * Why not insert a managed block like codex: Claude Code loads skills on demand by description;
 * putting them in CLAUDE.md turns them into always-on rules that take context every turn — defeating its built-in mechanism.
 * The user asked to "sync into its own skills", so we have to use its own shape.
 *
 * Safety boundary: only touch directories meeting both conditions — name starts with ading- and contains the MARKER file.
 * Both are required. A skill directory the user wrote will never be deleted by us,
 * even if they happen to name it ading-xxx.
 *
 * When a same-named directory is in the way (an old version the user created by hand, a copy synced by another account, a link), the central library is authoritative:
 * move the original directory whole into the sibling BACKUP_DIR, then write the central version. This is a normal takeover, not reported to the user as an error;
 * the original content stays untouched in the backup and can be moved back when needed.
 */
const PREFIX = "ading-";
const MARKER = ".ading-managed";
/** Sits next to the skills root, not inside it, so no Agent loads a backed-up copy as a skill. */
export const BACKUP_DIR = ".ading-skill-backup";

/** Move whatever occupies a skill directory aside, keeping it intact. Same filesystem, so this is a rename. */
async function backupPath(root: string, dirName: string): Promise<string> {
  const base = path.join(path.dirname(root), BACKUP_DIR);
  await mkdir(base, { recursive: true });
  return path.join(base, `${dirName}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
}

async function checkRoot(root: string): Promise<void> {
  for(const full of [path.dirname(root),root]) {
    try { if((await lstat(full)).isSymbolicLink()) throw Object.assign(new Error(p(`技能目标目录不允许符号链接：${full}`, `Skill target directories must not be symbolic links: ${full}`)),{code:"ADING_SKILL_TARGET_SYMLINK",path:full}); } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  }
}

/**
 * Directory name: a readable part + a skillId tail.
 *
 * The tail can't be dropped: Chinese characters in skill names are stripped, so "MQ 幂等" and "MQ 重试" both become mq,
 * and two skills would fight over one directory — the later write overwrites the earlier, and cleanup keeps only one.
 * The name is just for humans; uniqueness comes from skillId.
 */
export function skillSlug(skill: Pick<Skill, "skillId" | "name">): string {
  const ascii = skill.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const tail = skill.skillId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6);
  return PREFIX + (ascii ? `${ascii}-${tail}` : tail);
}

/** SKILL.md body. The frontmatter name / description is what Claude Code uses to decide when to load it */
export function renderSkillFile(skill: Skill): string {
  const escape = (value: string): string => value.replace(/\r?\n/g, " ").trim();
  return [
    "---",
    `name: ${escape(skill.name)}`,
    `description: ${escape(skill.description || skill.name)}`,
    "---",
    "",
    "<!-- 由 ADing 公共技能库同步，请勿手改；要改请到 ADing 里改 -->",
    "",
    skill.content.trim(),
    ""
  ].join("\n");
}

/** Atomic write: write a temp file then rename, so a crash never leaves half a file */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.ading.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

async function managedDirs(root: string, ownerFingerprint?: string): Promise<string[]> {
  await checkRoot(root);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const marker=path.join(root,entry.name,MARKER);
      if(!(await lstat(marker)).isFile() || (await lstat(marker)).isSymbolicLink()) continue;
      const value=await readFile(marker,"utf8");
      if(ownerFingerprint) {
        try { if(JSON.parse(value).ownerFingerprint!==ownerFingerprint) continue; } catch { continue; }
      }
      if (!entry.name.startsWith(PREFIX)) {
        const parsed=JSON.parse(value); if(parsed.version!==2 || typeof parsed.skillId!=="string") continue;
      }
      found.push(entry.name);
    } catch {
      // No marker file — we didn't create it, never touch it
    }
  }
  return found;
}

/**
 * Whether an unmanaged same-named directory differs from the central content; if identical the caller adopts it directly.
 * Unreadable (e.g. contains symlinks) also counts as different; the caller moves it to backup before writing.
 */
async function differsFrom(dir: string, files: PackageFile[]): Promise<boolean> {
  try { return fingerprintPackageFiles((await readPackageDirectory(dir)).filter(file=>file.path!==MARKER))!==fingerprintPackageFiles(files); }
  catch { return true; }
}

/**
 * Sync the shared library into skill directories, and reclaim ones we created that no longer exist.
 *
 * The reclaim step is required: after a skill is deleted in ADing,
 * it would otherwise stay active in ~/.claude/skills and people would think it was fully removed.
 */
export async function writeSkillDirs(
  root: string,
  skills: Skill[],
  options: { ownerFingerprint?: string } = {}
): Promise<string[]> {
  const enabled = skills.filter((skill) => skill.enabled);
  const written: string[] = [];
  const keep = new Set<string>();
  const failures: unknown[] = [];
  const libraries=new Set(skills.filter(skill=>skill.source).map(skill=>path.dirname(path.dirname(skill.source!.directory))));
  const ownerFingerprint=options.ownerFingerprint ?? (libraries.size===1 ? createHash("sha256").update(path.resolve([...libraries][0])).digest("hex") : undefined);
  await checkRoot(root);
  await mkdir(root,{recursive:true});

  // One skill failing to write must not affect other skills in the same directory, nor skip the reclaim afterwards.
  for (const skill of enabled) {
    try {
      const dirName = skill.directoryName ?? skillSlug(skill);
      if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(dirName) || dirName==="." || dirName==="..") throw new Error(p("技能目标目录名无效", "The skill target directory name is invalid"));
      if(keep.has(dirName.toLowerCase())) throw new Error(p("同步目标包含同名技能目录", "The sync target contains duplicate skill directory names"));
      keep.add(dirName.toLowerCase());
      const dir = path.join(root, dirName);
      let files: PackageFile[];
      if(skill.source) {
        files=await readPackageDirectory(skill.source.directory);
        if(fingerprintPackageFiles(files)!==skill.source.fingerprint) throw new Error(p("中央技能源已变化，请重新读取后同步", "The central skill source changed; reload it before syncing"));
      } else files=[{path:"SKILL.md",bytes:Buffer.from(renderSkillFile(skill)),mode:0o644}];
      let existed = false, displace = false;
      try {
        const st=await lstat(dir);
        existed=true;
        if(st.isSymbolicLink() || !st.isDirectory()) displace=true;
        else {
          let owner: string | undefined, existingLibrary: string | undefined;
          try {
            const marker=path.join(dir,MARKER); const ms=await lstat(marker);
            if(ms.isFile() && !ms.isSymbolicLink()) { const raw=await readFile(marker,"utf8"); try { const value=JSON.parse(raw);owner=value.skillId;existingLibrary=value.ownerFingerprint; } catch { if(dirName.startsWith(PREFIX)) owner=raw.trim(); } }
          } catch {}
          // Not this skill's managed copy: identical content is adopted below, anything else is backed up and replaced.
          if(owner!==skill.skillId || existingLibrary && ownerFingerprint && existingLibrary!==ownerFingerprint) displace=!!owner || await differsFrom(dir,files);
        }
      } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
      if(existed && !displace) {
        try {
          const replica=(await readPackageDirectory(dir)).filter(file=>file.path!==MARKER);
          if(fingerprintPackageFiles(replica)===fingerprintPackageFiles(files)) { await writeAtomic(path.join(dir,MARKER),JSON.stringify({version:2,skillId:skill.skillId,fingerprint:fingerprintPackageFiles(files),ownerFingerprint})); written.push(path.join(dir,"SKILL.md")); continue; }
        } catch { /* A damaged managed copy is replaced from the validated central source. */ }
      }
      const candidate=path.join(root,`.ading-candidate-${randomUUID()}`);
      await writePackageCandidate(candidate,files);
      try {
        await writeAtomic(path.join(candidate,MARKER),JSON.stringify({version:2,skillId:skill.skillId,fingerprint:fingerprintPackageFiles(files),ownerFingerprint}));
        if(displace) {
          // The complete candidate exists before the old entry moves; if the swap fails the old entry goes back.
          const backup=await backupPath(root,dirName);
          await rename(dir,backup);
          try { await rename(candidate,dir); }
          catch(error) { await rename(backup,dir).catch(()=>undefined); throw error; }
        } else await replaceDirectory(candidate,dir);
      } finally { await rm(candidate,{recursive:true,force:true}); }
      written.push(path.join(dir, "SKILL.md"));
    } catch(error) { failures.push(error); }
  }

  for (const dirName of await managedDirs(root,ownerFingerprint)) {
    if (keep.has(dirName.toLowerCase())) continue;
    await removeTree(path.join(root, dirName));
  }
  if(failures.length) throw new AggregateError(failures,failures.map(error=>String(error)).join("; "));
  return written;
}

/** Withdraw: delete all skill directories we created, leave the user's own untouched */
export async function removeSkillDirs(root: string,options: {ownerFingerprint?:string} = {}): Promise<string[]> {
  const removed: string[] = [];
  for (const dirName of await managedDirs(root,options.ownerFingerprint)) {
    await removeTree(path.join(root, dirName));
    removed.push(path.join(root, dirName));
  }
  return removed;
}
