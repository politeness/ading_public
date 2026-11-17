import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createLogArchive, archiveFileName } from "../dist/support/log-archive.js";

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${label} -> ${error?.message ?? error}`);
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "ading-log-archive-"));
const entries = [
  { name: "last-run.log", content: Buffer.from('{"event":"one"}\n{"event":"two"}\n', "utf8") },
  { name: "last-run-2026-09-12T01-37-47-318Z-0001.log", content: Buffer.from('{"event":"old"}\n', "utf8") }
];

// The real acceptance criterion is whether macOS's built-in tar can extract it:
// a wrong tar header checksum shows up at this step.
await check("System tar can extract it and both logs are in the archive", async () => {
  const archivePath = path.join(root, "logs.tar.gz");
  await writeFile(archivePath, await createLogArchive(entries));
  execFileSync("/usr/bin/tar", ["-xzf", archivePath, "-C", root]);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".log")).sort(), [
    "last-run-2026-09-12T01-37-47-318Z-0001.log",
    "last-run.log"
  ]);
});

await check("Extracted content matches the original byte for byte", async () => {
  for (const entry of entries) {
    assert.equal(await readFile(path.join(root, entry.name), "utf8"), entry.content.toString());
  }
});

// Logs are highly repetitive JSON lines, so compression must really work, otherwise packing is pointless.
await check("Compression ratio at least 10x", async () => {
  const line = '{"at":"2026-09-12T03:20:50.714Z","event":"verify","kind":"claude-code"}\n';
  const repetitive = Buffer.from(line.repeat(2000), "utf8");
  const packed = await createLogArchive([{ name: "big.log", content: repetitive }]);
  assert.ok(packed.length * 10 < repetitive.length,
    `packed ${packed.length}, raw ${repetitive.length}`);
});

await check("Empty logs also produce a valid archive", async () => {
  const empty = path.join(root, "empty.tar.gz");
  await writeFile(empty, await createLogArchive([{ name: "empty.log", content: Buffer.alloc(0) }]));
  execFileSync("/usr/bin/tar", ["-tzf", empty]);
});

await check("File name has a timestamp and is tar.gz", async () => {
  assert.match(
    archiveFileName(new Date("2026-09-12T03:34:00.000Z")),
    /^阿钉日志-2026-09-12T03-34-00-000Z\.tar\.gz$/
  );
});

console.log(`log-archive: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
