import path from "node:path";
import { archiveFileName, createLogArchive } from "../support/log-archive";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

/**
 * Runtime log.
 *
 * The reason it exists is concrete: the app only runs on macOS, and I can't reach macOS.
 * Without this log, every problem would need someone watching the screen and relaying what they saw to me —
 * which outsources debugging to someone who shouldn't be doing it.
 *
 * With it, a person only needs to run `pnpm start` once, and then I read the logs and keep investigating myself.
 *
 * It's written under the repo's .ading/ rather than the app data directory because it travels with the code,
 * anyone can open it directly, and it's easy to share with others.
 *
 * Four constraints:
 *   1. Never throw. Failing to write a log is minor; it must not crash the app in turn.
 *   2. Switch to a new file before a single file reaches 1 MB; no log file exceeds 1 MB.
 *   3. Keep only the last 24 hours with a total under 10 MB; evict the oldest files when over the limit.
 *   4. Issue reports upload only the last 48 hours of logs (see SUPPORT_LOG_WINDOW_MS); recording and retention rules are unaffected.
 */
export const LOG_FILE_BYTES = 1 * 1024 * 1024;
export const LOG_RETENTION_BYTES = 10 * 1024 * 1024;
export const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const SUPPORT_LOG_COUNT = 2;
/**
 * Issue reports carry only the last two days of logs. Trimmed by each line's time, not by file:
 * the current file isn't rotated until it reaches 1 MB, so it often holds several days of records.
 */
export const SUPPORT_LOG_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Maximum raw log size packed into the archive; the retention policy itself keeps the total under 10 MB */
export const SUPPORT_ARCHIVE_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/** Compressed size limit. Logs are JSON lines and compress very well, so this is normally far from reached */
export const SUPPORT_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;

let filePath: string | null = null;
let written = 0;
let disabled = false;
/** Number of entries dropped after write failures and the last reason; when writes recover, add a log-write-recovered entry instead of silently disabling logging */
let droppedEntries = 0;
let lastWriteError: string | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let archiveSequence = 0;

function resolvePath(): string {
  const cwd = process.cwd();
  const explicit = process.env.ADING_LOG;
  if (explicit) return explicit;
  // Alongside the task sheet: pnpm start runs inside desktop_mac, so the parent is exactly the repo root
  return path.join(cwd, "..", ".ading", "last-run.log");
}

function archivePath(logPath: string, at: number): string {
  const timestamp = new Date(at).toISOString().replace(/[:.]/g, "-");
  const extension = path.extname(logPath);
  const stem = extension ? logPath.slice(0, -extension.length) : logPath;
  archiveSequence += 1;
  return `${stem}-${timestamp}-${String(archiveSequence).padStart(4, "0")}${extension}`;
}

export function shouldStartNewLog(currentBytes: number, nextBytes: number): boolean {
  return currentBytes > 0 && currentBytes + nextBytes > LOG_FILE_BYTES;
}

interface LogFileInfo {
  path: string;
  size: number;
  modifiedAt: number;
  active: boolean;
}

async function listLogFiles(logPath: string): Promise<LogFileInfo[]> {
  const directory = path.dirname(logPath);
  const extension = path.extname(logPath);
  const base = path.basename(logPath);
  const stem = extension ? base.slice(0, -extension.length) : base;
  const names = (await readdir(directory)).filter((name) =>
    name === base || (name.startsWith(`${stem}-`) && name.endsWith(extension))
  );
  return Promise.all(names.map(async (name) => {
    const candidatePath = path.join(directory, name);
    const info = await stat(candidatePath);
    return {
      path: candidatePath,
      size: info.size,
      modifiedAt: info.mtimeMs,
      active: name === base
    };
  }));
}

async function cleanupOldLogs(now = Date.now()): Promise<void> {
  if (!filePath) return;
  let files = await listLogFiles(filePath);
  files.sort((left, right) => left.modifiedAt - right.modifiedAt);

  for (const item of files.filter(
    (candidate) => !candidate.active && now - candidate.modifiedAt >= LOG_RETENTION_MS
  )) {
    try {
      await unlink(item.path);
      files = files.filter((candidate) => candidate.path !== item.path);
    } catch {
      // Failing to delete a single old file doesn't affect continuing to write the current log.
    }
  }

  let total = files.reduce((sum, item) => sum + item.size, 0);
  for (const item of files) {
    if (total < LOG_RETENTION_BYTES) break;
    if (item.active) continue;
    try {
      await unlink(item.path);
      total -= item.size;
    } catch {
      // Try again on the next log write.
    }
  }
}

async function rotateLog(now = Date.now()): Promise<void> {
  if (!filePath) return;
  try {
    const current = await stat(filePath);
    if (current.size > 0) await rename(filePath, archivePath(filePath, now));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(filePath, "", "utf8");
  written = 0;
}

export async function startLog(header: Record<string, unknown>): Promise<void> {
  try {
    await writeQueue;
    filePath = resolvePath();
    disabled = false;
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      const current = await stat(filePath);
      written = current.size;
      if (written >= LOG_FILE_BYTES) await rotateLog();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rotateLog();
    }
    await cleanupOldLogs();
    await log("start", header);
  } catch (error) {
    // Don't disable logging on init failure: start records the reason, and if writes fail log() counts dropped entries and keeps retrying.
    if (!filePath) return;
    await log("start", { ...header, logInitError: error instanceof Error ? error.message.slice(0, 300) : String(error) });
  }
}

/** One JSON object per line. Fields vary by event; split by event when reading */
export async function log(
  event: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  if (disabled || !filePath) return;
  writeQueue = writeQueue.then(async () => {
    if (disabled || !filePath) return;
    try {
      let line =
        JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n";
      let bytes = Buffer.byteLength(line);
      if (bytes > LOG_FILE_BYTES) {
        line = JSON.stringify({
          at: new Date().toISOString(),
          event: "oversized-log-entry",
          originalEvent: event,
          originalBytes: bytes
        }) + "\n";
        bytes = Buffer.byteLength(line);
      }
      if (droppedEntries > 0) {
        // The directory may have been deleted or not created yet: recreate it first, then note how many were lost in between
        await mkdir(path.dirname(filePath), { recursive: true });
        const notice = JSON.stringify({
          at: new Date().toISOString(), event: "log-write-recovered",
          droppedEntries, lastError: lastWriteError
        }) + "\n";
        await appendFile(filePath, notice, "utf8");
        written += Buffer.byteLength(notice);
        droppedEntries = 0;
        lastWriteError = undefined;
      }
      if (shouldStartNewLog(written, bytes)) await rotateLog();
      await appendFile(filePath, line, "utf8");
      written += bytes;
      await cleanupOldLogs().catch(() => undefined);
    } catch (error) {
      // This used to permanently disable logging for the whole process, writing nothing afterwards and leaving no trace.
      // Now it only records how many were lost and why, and retries on the next log entry.
      droppedEntries += 1;
      lastWriteError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    }
  });
  await writeQueue;
}

/**
 * Keeps only lines timed after cutoff. Each line is one JSON object, with time taken from `at`;
 * lines without a time (half-written lines, placeholders for oversized entries) follow the previous line's fate, and those at the start of the file are kept by default.
 */
export function linesSince(content: string, cutoff: number): string {
  let keep = true;
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    const at = /^\{"at":"([^"]+)"/.exec(line)?.[1];
    const time = at ? Date.parse(at) : NaN;
    if (!Number.isNaN(time)) keep = time >= cutoff;
    if (keep) kept.push(line);
  }
  return kept.join("\n");
}

async function readLogTail(logPath: string): Promise<{ name: string; content: string }> {
  const handle = await open(logPath, "r");
  try {
    const info = await handle.stat();
    const bytes = Math.min(info.size, LOG_FILE_BYTES);
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, info.size - bytes);
    let content = buffer.toString("utf8");
    if (info.size > bytes) {
      const firstNewline = content.indexOf("\n");
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    }
    return { name: path.basename(logPath), content };
  } finally {
    await handle.close();
  }
}

/** The two most recent logs for issue reports. If reading one file fails, still try to return the other. */
export async function supportLogSnapshots(): Promise<
  Array<{ name: string; content: string }>
> {
  if (!filePath || disabled) return [];
  try {
    await writeQueue;
    const dated = await listLogFiles(filePath);
    dated.sort((left, right) =>
      right.modifiedAt - left.modifiedAt || Number(right.active) - Number(left.active)
    );
    const cutoff = Date.now() - SUPPORT_LOG_WINDOW_MS;
    const recent = dated.filter((item) => item.modifiedAt >= cutoff);
    const snapshots = await Promise.allSettled(
      recent.slice(0, SUPPORT_LOG_COUNT).map(async (item) => {
        const tail = await readLogTail(item.path);
        return { ...tail, content: linesSince(tail.content, cutoff) };
      })
    );
    return snapshots.flatMap((snapshot) =>
      snapshot.status === "fulfilled" && snapshot.value.content.trim() ? [snapshot.value] : []
    );
  } catch {
    return [];
  }
}

/**
 * Collects all currently retained logs and packs them into a tar.gz.
 *
 * Difference from supportLogSnapshots: that one takes only the tails of the last two files as plain text in JSON,
 * convenient to read directly in email; this one takes complete files, compressed and uploaded separately to OSS, for real investigation.
 * Both are kept — skim in email, download the archive to dig in.
 *
 * Like the log itself, this never throws: if collection fails, skip it; it must not crash the reporting flow.
 */
export async function supportLogArchive(): Promise<
  { name: string; base64: string; fileCount: number; rawBytes: number; packedBytes: number }
  | undefined
> {
  if (!filePath || disabled) return undefined;
  try {
    await writeQueue;
    const dated = await listLogFiles(filePath);
    // Newest first: when the limit is hit, rather drop the oldest
    dated.sort((left, right) =>
      right.modifiedAt - left.modifiedAt || Number(right.active) - Number(left.active)
    );

    // Files last modified before the window are entirely old records; the rest are trimmed by line to the last 48 hours.
    const cutoff = Date.now() - SUPPORT_LOG_WINDOW_MS;
    const entries: Array<{ name: string; content: Buffer; modifiedAt: number }> = [];
    let rawBytes = 0;
    for (const item of dated.filter((candidate) => candidate.modifiedAt >= cutoff)) {
      const content = Buffer.from(linesSince(await readFile(item.path, "utf8"), cutoff), "utf8");
      if (content.length === 0 || !content.toString("utf8").trim()) continue;
      if (rawBytes + content.length > SUPPORT_ARCHIVE_MAX_SOURCE_BYTES) continue;
      entries.push({ name: path.basename(item.path), content, modifiedAt: item.modifiedAt });
      rawBytes += content.length;
    }
    if (entries.length === 0) return undefined;

    let packed = await createLogArchive(entries);
    while (packed.length > SUPPORT_ARCHIVE_MAX_BYTES && entries.length > 1) {
      entries.pop();
      packed = await createLogArchive(entries);
    }
    if (packed.length > SUPPORT_ARCHIVE_MAX_BYTES) return undefined;

    return {
      name: archiveFileName(),
      base64: packed.toString("base64"),
      fileCount: entries.length,
      rawBytes: entries.reduce((sum, entry) => sum + entry.content.length, 0),
      packedBytes: packed.length
    };
  } catch {
    return undefined;
  }
}

/** Error objects can't be JSON.stringify'd directly; they become {} */
/**
 * Describes it together with the cause chain. When Node's fetch fails it only reports "fetch failed",
 * the real reason (EHOSTUNREACH, ECONNREFUSED, certificate errors...) is in cause; without it we can only guess.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    const withCode = typeof code === "string" && !current.message.includes(code) ? ` (${code})` : "";
    parts.push(`${current.name}: ${current.message}${withCode}`);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

/** Don't keep prompt bodies in logs: they may contain sensitive project content and aren't needed for investigation */
export function safeArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    out.push(args[i]);
    if (args[i] === "-p" || args[i] === "--prompt") {
      out.push(`<prompt ${args[i + 1]?.length ?? 0} chars>`);
      i += 1;
    }
  }
  return out;
}
