import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, cp, link, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log } from "../orchestration/diagnostics";
import { codexChildEnvironment } from "./codex-environment";

let sessionRoot: string | undefined;

/** The host supplies its channel-specific data directory. */
export function configureCodexSessionRoot(root: string): void { sessionRoot = root; }

/** The user's own Codex home, even when ADing runs inside an ADing Codex turn. */
export function nativeCodexHome(home = os.homedir()): string {
  return path.resolve(codexChildEnvironment().CODEX_HOME?.trim() || path.join(home, ".codex"));
}

// Only reusable configuration and knowledge cross the boundary. In particular,
// never link session indexes, databases, rollouts, queues, locks or shell state.
const sharedEntries = new Set([
  "auth.json", ".credentials.json", "config.toml", "AGENTS.md", "AGENTS.override.md",
  "skills", "rules", "agents", "plugins", "hooks.json", "memories", "memories_v2"
]);
const shared = (name: string) => sharedEntries.has(name) || name.endsWith(".config.toml");
// Codex creates these on its own. Linking them up front, even before the native
// side has them, keeps its writes from forking off into the private home.
const sharedDirectories = ["skills", "rules", "agents", "plugins", "memories", "memories_v2"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = async (file: string) => {
  try { return createHash("sha256").update(await readFile(file)).digest("hex"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

/** Look up only the requested rollout by filename; never read unrelated chats. */
async function findRollout(root: string, threadId: string): Promise<string | undefined> {
  const walk = async (directory: string, depth: number): Promise<string | undefined> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) return path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) {
        const found = await walk(path.join(directory, entry.name), depth + 1);
        if (found) return found;
      }
    }
  };
  return walk(root, 0);
}

async function importRollout(source: string, target: string, threadId?: string): Promise<void> {
  if (!threadId || !uuid.test(threadId)) return;
  for (const name of ["sessions", "archived_sessions"]) {
    if (await findRollout(path.join(target, name), threadId)) return;
  }
  for (const name of ["sessions", "archived_sessions"]) {
    const sourceRoot = path.join(source, name);
    const file = await findRollout(sourceRoot, threadId);
    if (!file) continue;
    const destination = path.join(target, "sessions", path.relative(sourceRoot, file));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const candidate = `${destination}.${randomUUID()}.tmp`;
    try {
      await copyFile(file, candidate, constants.COPYFILE_EXCL);
      // Atomic publish without overwriting a rollout another lane has resumed.
      await link(candidate, destination).catch(error => { if (error.code !== "EEXIST") throw error; });
    } finally { await rm(candidate, { force: true }); }
    return;
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Replace whatever is at destination with a link, without a moment where it is absent. */
async function replaceWithLink(target: string, destination: string): Promise<void> {
  const candidate = `${destination}.ading-${randomUUID()}.link`;
  await symlink(target, candidate);
  try { await rename(candidate, destination); }
  finally { await rm(candidate, { force: true }); }
}

/**
 * A plain auth.json left in the private home means an older Codex replaced the
 * link and ADing stopped before settling. The native file wins unless the
 * private copy was written after the native one last changed: then it is the
 * refresh that never got copied back, and the native token may already be
 * rotated out server-side. A missing native file means logout and also wins.
 */
async function reconcileCredential(local: string, original: string): Promise<void> {
  const entry = await lstat(local).catch(() => undefined);
  if (!entry?.isFile()) return;
  const native = await stat(original).catch(error => { if (missing(error)) return undefined; throw error; });
  const newer = !!native && entry.mtimeMs > native.mtimeMs;
  if (newer) {
    const candidate = `${original}.ading-${randomUUID()}.tmp`;
    try { await copyFile(local, candidate); await rename(candidate, original); }
    finally { await rm(candidate, { force: true }); }
  }
  log("codex-session-home-stale-credential", { kept: newer ? "private" : "native" });
  await replaceWithLink(original, local);
}

/** Move one entry without overwriting anything already in place. */
async function moveIfAbsent(from: string, to: string): Promise<boolean> {
  if (await lstat(to).catch(() => undefined)) return false;
  try { await rename(from, to); }
  catch (error) {
    if (missing(error)) return true;
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
  return true;
}

/**
 * Link a shared directory to the native one. A real private directory (Codex
 * created it before ADing linked it) is merged into the native side first:
 * entries the native side lacks move over, native entries are never replaced,
 * and conflicting private leftovers are set aside rather than deleted.
 */
async function linkSharedDirectory(home: string, source: string, name: string): Promise<void> {
  const target = path.join(source, name), destination = path.join(home, name);
  const entry = await lstat(destination).catch(() => undefined);
  if (entry?.isSymbolicLink()) return;
  if (entry && !entry.isDirectory()) return;
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Never create the native Codex home itself from scratch.
    if (code === "ENOENT") return;
    if (code !== "EEXIST") throw error;
  }
  if (!(await stat(target)).isDirectory()) return;
  if (entry) {
    const conflicts: string[] = [];
    for (const child of await readdir(destination)) {
      if (!(await moveIfAbsent(path.join(destination, child), path.join(target, child)))) conflicts.push(child);
    }
    if (conflicts.length) {
      const aside = path.join(home, ".ading-diverged", `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`);
      await mkdir(path.dirname(aside), { recursive: true, mode: 0o700 });
      await rename(destination, aside);
      log("codex-session-home-diverged", { name, conflicts: conflicts.length, aside });
    } else await rm(destination, { recursive: true, force: true });
  }
  await symlink(target, destination).catch(error => { if (error.code !== "EEXIST") throw error; });
}

// Parallel lanes share one private home; its links are set up one at a time.
const queues = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/** Persistent private state, with the original login and configuration reused. */
export async function prepareCodexSessionHome(threadId?: string): Promise<{
  path: string; env: NodeJS.ProcessEnv; settle: () => Promise<void>;
}> {
  const source = nativeCodexHome();
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const home = path.join(sessionRoot ?? `${source}-ading`, key);
  const local = path.join(home, "auth.json"), original = path.join(source, "auth.json");
  const authBefore = await exclusive(home, async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    // Create these before the memory-isolation view, so it links persistent state
    // even on the very first turn instead of putting rollouts in a temp directory.
    for (const name of ["sessions", "archived_sessions"]) await mkdir(path.join(home, name), { recursive: true, mode: 0o700 });
    await reconcileCredential(local, original);
    for (const name of sharedDirectories) await linkSharedDirectory(home, source, name);
    const names = new Set((await readdir(source).catch(error => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    })).filter(shared));
    names.add("auth.json"); // A later native login immediately becomes available.
    for (const name of names) {
      const target = path.join(source, name), destination = path.join(home, name);
      if (await readlink(destination).catch(() => undefined) === target) continue;
      await symlink(target, destination).catch(error => { if (error.code !== "EEXIST") throw error; });
    }
    return digest(original);
  });
  await importRollout(source, home, threadId);
  const nativeEnv = codexChildEnvironment();
  const env = { ...nativeEnv, CODEX_HOME: home, CODEX_SQLITE_HOME: home,
    ADING_CODEX_SESSION_HOME: home, ADING_CODEX_NATIVE_HOME: source, ADING_CODEX_NATIVE_SQLITE_HOME: nativeEnv.CODEX_SQLITE_HOME ?? "" };
  return { path: home, env, settle: () => exclusive(home, async () => {
    // Current Codex follows credential links when refreshing tokens. Older
    // versions may replace the link: preserve that refresh unless native login
    // changed in the meantime (including logout), then restore the link.
    if (!(await lstat(local).catch(() => undefined))?.isFile()) return;
    if (await digest(original) === authBefore) {
      const candidate = `${original}.ading-${randomUUID()}.tmp`;
      try { await copyFile(local, candidate); await rename(candidate, original); }
      finally { await rm(candidate, { force: true }); }
    }
    await replaceWithLink(original, local);
  }) };
}

/** An explicit native sqlite_home must not put private threads in the app DB. */
export function codexSessionConfigArgs(env: NodeJS.ProcessEnv): string[] {
  return env.CODEX_SQLITE_HOME ? ["-c", `sqlite_home=${JSON.stringify(env.CODEX_SQLITE_HOME)}`] : [];
}
