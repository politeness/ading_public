import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId } from "./ids";

/**
 * Local data written before "task" was renamed to "conversation" (task → conversation) is migrated in place at startup, before any data is read.
 *
 * When the data directory still has the old tasks.json:
 *   - field names in ADing's own data files (see dataFiles; user content like attachments is never touched) are renamed by the same rules as the code (taskId → conversationId, etc.)
 *   - scope / type values that are exactly "task" become "conversation" (scope of memories and proposals); message bodies are untouched
 *   - the default name of unnamed conversations "新任务" becomes "新会话"
 *   - finally tasks.json → conversations.json
 * Two steps always run, with or without tasks.json (on machines where the old migration already ran, or a cloud snapshot wrote conversations.json first, these two would be missed):
 *   - online-mode pending sync queue: old op.kind (task / task-delete) renamed, otherwise replay won't recognize them
 *   - memories/task-*.jsonl → memories/conversation-*.jsonl
 * Every step is idempotent and every file is written atomically: if interrupted, the next startup continues, and repeated runs give the same result.
 */
export async function migrateLegacyTaskNaming(rootDir: string): Promise<boolean> {
  const legacy = path.join(rootDir, "tasks.json");
  const current = path.join(rootDir, "conversations.json");
  const hasLegacy = await exists(legacy);
  let changed = false;

  if (hasLegacy) {
    for (const file of await dataFiles(rootDir)) changed = (await rewriteFile(file)) || changed;
  }
  // The queue is small, so go through it on every startup; if already renamed the content is unchanged and nothing is written
  changed = (await rewriteFile(path.join(rootDir, "sync-queue.json"))) || changed;
  changed = (await renameMemories(path.join(rootDir, "memories"))) || changed;

  if (hasLegacy) {
    // Both exist, meaning an earlier version wrote a full cloud snapshot before migrating: the snapshot wins; rename the old file and keep it for reference, never delete user data
    await rename(legacy, (await exists(current)) ? `${legacy}.legacy` : current);
    changed = true;
  }
  return changed;
}

/** Rewrite a JSON / JSONL file line by line; return false if the file doesn't exist or needs no changes */
async function rewriteFile(file: string): Promise<boolean> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  const queue = isQueueFile(file);
  const next = file.endsWith(".jsonl")
    ? text.split("\n").map((line) => (line.trim() ? rewriteJson(line, queue) : line)).join("\n")
    : rewriteJson(text, queue);
  if (next === text) return false;
  await writeAtomic(file, next);
  return true;
}

/**
 * Rename old memory files. When a file with the new name already exists (memories of the same conversation written before and after the rename),
 * lines from the old file missing in the new one are merged in front in original order, then the old file is deleted; rerunning after a partial merge won't duplicate.
 */
async function renameMemories(dir: string): Promise<boolean> {
  let changed = false;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith("task-") || !name.endsWith(".jsonl")) continue;
    const source = path.join(dir, name);
    const target = path.join(dir, `conversation-${name.slice(5)}`);
    await rewriteFile(source);
    if (!(await exists(target))) {
      await rename(source, target);
    } else {
      const existing = await readFile(target, "utf8");
      const known = new Set(existing.split("\n").filter((line) => line.trim()));
      const missing = (await readFile(source, "utf8")).split("\n").filter((line) => line.trim() && !known.has(line));
      if (missing.length) await writeAtomic(target, missing.map((line) => `${line}\n`).join("") + existing);
      await unlink(source);
    }
    changed = true;
  }
  return changed;
}

function rewriteJson(text: string, queue: boolean): string {
  try {
    let value = rewriteValue(JSON.parse(text), undefined);
    if (queue) value = Array.isArray(value) ? value.map(rewriteQueueEntry) : rewriteQueueEntry(value);
    const next = JSON.stringify(value, null, text.includes("\n  ") ? 2 : undefined);
    // Keep the original trailing newline, otherwise every run counts as "changed"
    return text.endsWith("\n") && !next.endsWith("\n") ? `${next}\n` : next;
  } catch {
    return text;
  }
}

function rewriteValue(value: unknown, key: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) out[renameKey(name)] = rewriteValue(item, name);
    return out;
  }
  if (value === "task" && (key === "scope" || key === "type")) return "conversation";
  if (value === "新任务" && key === "name") return "新会话";
  return value;
}

/** Old operation names in the sync queue (and rejected log). kind has other meanings elsewhere (attachments, workspaces), so only change it in queue entries */
const LEGACY_OP_KINDS: Record<string, string> = { task: "conversation", "task-delete": "conversation-delete" };

function rewriteQueueEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const { key, op } = entry as { key?: unknown; op?: { kind?: unknown } };
  const kind = op && typeof op.kind === "string" ? LEGACY_OP_KINDS[op.kind] : undefined;
  if (!kind) return entry;
  // Conversation change dedupe keys are still task:<id>, same as the old queue, no change needed; delete keys are now conversation-delete:<id>
  const nextKey = typeof key === "string" ? key.replace(/^task-delete:/, "conversation-delete:") : key;
  return { ...entry, key: nextKey, op: { ...op, kind } };
}

function isQueueFile(file: string): boolean {
  const name = path.basename(file);
  return name === "sync-queue.json" || name === "sync-rejected.jsonl";
}

/** Same as the rename rules in code: only change the word "task" in names; leave "subtask" names like childTaskLimit alone */
function renameKey(name: string): string {
  if (name === "childTaskLimit" || !/task/i.test(name)) return name;
  return name
    .replace(/Tasks(?=[A-Z0-9_]|$)/g, "Conversations")
    .replace(/Task(?=[A-Z0-9_]|$)/g, "Conversation")
    .replace(/^tasks(?=[A-Z0-9_]|$)/, "conversations")
    .replace(/^task(?=[A-Z0-9_]|$)/, "conversation");
}

/** Files LocalStore / CloudStore write themselves at the data directory root */
const ROOT_FILES = [
  "tasks.json",
  "conversations.json",
  "profile.json",
  "agents.json",
  "workspaces.json",
  "people.json",
  "agent-sessions.json",
  "skill-proposals.json",
  "sync-queue.json",
  "sync-rejected.jsonl",
  "sync-state.json",
  "cloud-cursors.json"
];

/**
 * Data files to migrate: only those ADing writes itself (known files at the root, JSONL under messages/ and memories/, the skill index).
 * Never recurse the whole directory — attachments/ holds raw user uploads; rewriting would alter fields, reformat, and lose precision on big numbers.
 */
async function dataFiles(rootDir: string): Promise<string[]> {
  const files = ROOT_FILES.map((name) => path.join(rootDir, name));
  files.push(path.join(rootDir, "skills", "index.json"));
  for (const dir of ["messages", "memories"]) {
    for (const name of await readdir(path.join(rootDir, dir)).catch(() => [] as string[])) {
      if (name.endsWith(".jsonl")) files.push(path.join(rootDir, dir, name));
    }
  }
  return files;
}

/** Write a temp file then rename: if killed mid-write, the original still has the complete old content and the next startup retries */
async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${newId("message")}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}
