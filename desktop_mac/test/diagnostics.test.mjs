import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "./tmp.mjs";
import {
  readFile,
  readdir,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";

const dir = await mkdtemp(path.join(os.tmpdir(), "ading-diagnostics-"));
const logPath = path.join(dir, "last-run.log");
process.env.ADING_LOG = logPath;

const {
  LOG_FILE_BYTES,
  LOG_RETENTION_BYTES,
  LOG_RETENTION_MS,
  log,
  shouldStartNewLog,
  startLog,
  supportLogArchive,
  supportLogSnapshots,
  SUPPORT_LOG_WINDOW_MS,
  linesSince,
} = await import("../dist/orchestration/diagnostics.js");

let passed = 0;
function check(name, actual) {
  assert.ok(actual, name);
  passed += 1;
}

check("Single log file is capped at 1 MB", LOG_FILE_BYTES === 1024 * 1024);
check("Total log size is capped at 10 MB", LOG_RETENTION_BYTES === 10 * 1024 * 1024);
check("Logs are kept for at most 24 hours", LOG_RETENTION_MS === 24 * 60 * 60 * 1000);
check("Exactly 1 MB after writing does not rotate the file", !shouldStartNewLog(LOG_FILE_BYTES - 10, 10));
check("Rotates when the next entry would exceed 1 MB", shouldStartNewLog(LOG_FILE_BYTES - 10, 11));

await startLog({ run: 1 });
await log("first-message", { value: "保留我" });
await startLog({ run: 2 });
let active = await readFile(logPath, "utf8");
check("Restart does not clear a log that is not full", active.includes("first-message"));
check("Restart appends a new start event", active.includes('"run":2'));

await writeFile(logPath, Buffer.alloc(LOG_FILE_BYTES));
await startLog({ run: 3 });
active = await readFile(logPath, "utf8");
let files = await readdir(dir);
check("Creates a new file once the current file reaches 1 MB", files.some((name) => /^last-run-.*\.log$/.test(name)));
check("New file contains the new cycle's logs", active.includes('"run":3'));

await log("too-large", { value: "x".repeat(LOG_FILE_BYTES + 1) });
active = await readFile(logPath, "utf8");
check("Oversized single entry is safely abbreviated", active.includes("oversized-log-entry"));
check("Log file never exceeds 1 MB", (await stat(logPath)).size <= LOG_FILE_BYTES);

const snapshots = await supportLogSnapshots();
check("Issue report takes only the two most recent logs", snapshots.length === 2);
check("Issue report includes the current log first", snapshots[0].name === "last-run.log");
check("Reports complete log files within 1 MB", snapshots.every((item) => Buffer.byteLength(item.content) <= LOG_FILE_BYTES));

// Besides taking tail text, issue reports also pack the full logs into an archive uploaded to OSS separately.
const archive = await supportLogArchive();
check("Log archive can be collected", Boolean(archive));
check("Archive is tar.gz", archive.name.endsWith(".tar.gz"));
check("Archive covers more than one log file", archive.fileCount >= 2);
check("Compression actually reduces size", archive.packedBytes < archive.rawBytes);
check("Archive is decodable base64", Buffer.from(archive.base64, "base64").length === archive.packedBytes);
{
  const { execFileSync } = await import("node:child_process");
  const packedPath = path.join(dir, "collected.tar.gz");
  await writeFile(packedPath, Buffer.from(archive.base64, "base64"));
  const listed = execFileSync("/usr/bin/tar", ["-tzf", packedPath]).toString();
  check("Collected archive contains the current log", listed.includes("last-run.log"));
}

const expiredName = "last-run-2000-01-01T00-00-00-000Z-9999.log";
const expiredPath = path.join(dir, expiredName);
await writeFile(expiredPath, "expired", "utf8");
const expiredAt = new Date(Date.now() - LOG_RETENTION_MS - 1_000);
await utimes(expiredPath, expiredAt, expiredAt);
await log("cleanup-expired");
files = await readdir(dir);
check("Logs older than 24 hours are evicted", !files.includes(expiredName));

for (let index = 0; index < 11; index += 1) {
  const extraPath = path.join(dir, `last-run-extra-${String(index).padStart(2, "0")}.log`);
  await writeFile(extraPath, "", "utf8");
  await truncate(extraPath, LOG_FILE_BYTES);
  const modifiedAt = new Date(Date.now() - (11 - index) * 1_000);
  await utimes(extraPath, modifiedAt, modifiedAt);
}
await log("cleanup-total-size");
const retained = (await readdir(dir)).filter((name) => name.endsWith(".log"));
const total = (await Promise.all(retained.map((name) => stat(path.join(dir, name)))))
  .reduce((sum, item) => sum + item.size, 0);
check("Oldest files are evicted when total logs reach 10 MB", total < LOG_RETENTION_BYTES);

// Issue reports carry only the last two days: cut by per-line timestamps; recording and retention rules are unchanged.
check("Report window is 48 hours", SUPPORT_LOG_WINDOW_MS === 48 * 60 * 60 * 1000);
{
  const now = Date.now();
  const line = (ms, event) => JSON.stringify({ at: new Date(now - ms).toISOString(), event });
  const mixed = [line(3 * 86400_000, "three-days-ago"), "续行跟随前一条", line(3600_000, "an-hour-ago"), "续行跟随新的一条"].join("\n");
  const kept = linesSince(mixed, now - SUPPORT_LOG_WINDOW_MS);
  check("Removes lines older than 48 hours", !kept.includes("three-days-ago") && !kept.includes("续行跟随前一条"));
  check("Keeps lines within 48 hours and their continuation lines", kept.includes("an-hour-ago") && kept.includes("续行跟随新的一条"));

  const windowDir = await mkdtemp(path.join(os.tmpdir(), "ading-diagnostics-window-"));
  process.env.ADING_LOG = path.join(windowDir, "last-run.log");
  await startLog({ run: "window" });
  const current = path.join(windowDir, "last-run.log");
  await writeFile(current, [line(3 * 86400_000, "old-in-current-file"), line(60_000, "recent-in-current-file"), ""].join("\n"), "utf8");
  const oldFile = path.join(windowDir, "last-run-2000-01-01T00-00-00-000Z-0001.log");
  await writeFile(oldFile, line(3 * 86400_000, "whole-old-file") + "\n", "utf8");
  const oldAt = new Date(now - 3 * 86400_000);
  await utimes(oldFile, oldAt, oldAt);

  const recentSnapshots = await supportLogSnapshots();
  const snapshotText = recentSnapshots.map((item) => item.content).join("\n");
  check("Report text contains only the last two days", snapshotText.includes("recent-in-current-file") && !snapshotText.includes("old-in-current-file"));
  check("Whole old files older than the window are not uploaded", recentSnapshots.every((item) => !item.name.includes("2000-01-01")));

  const windowArchive = await supportLogArchive();
  const { execFileSync } = await import("node:child_process");
  const packed = path.join(windowDir, "collected.tar.gz");
  await writeFile(packed, Buffer.from(windowArchive.base64, "base64"));
  const unpacked = execFileSync("/usr/bin/tar", ["-xzOf", packed]).toString();
  check("Archive contains only the last two days", unpacked.includes("recent-in-current-file") && !unpacked.includes("old-in-current-file") && !unpacked.includes("whole-old-file"));
}

// A write failure must no longer permanently disable logging for the whole process: after recovery, add a note and keep writing.
{
  const { rm } = await import("node:fs/promises");
  const brokenDir = await mkdtemp(path.join(os.tmpdir(), "ading-diagnostics-broken-"));
  process.env.ADING_LOG = path.join(brokenDir, "logs", "last-run.log");
  await startLog({ run: "broken" });
  await rm(path.join(brokenDir, "logs"), { recursive: true, force: true });
  await log("lost-while-dir-missing");
  await log("after-recovery");
  const recovered = await readFile(path.join(brokenDir, "logs", "last-run.log"), "utf8");
  check("Logging is not permanently disabled after a write failure", recovered.includes("after-recovery"));
  check("Recovery records the dropped count and reason", /"event":"log-write-recovered","droppedEntries":1,"lastError":".+"/.test(recovered));
}

console.log(`diagnostics: ${passed} passed, 0 failed`);
