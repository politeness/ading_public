import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { misplacedDirectoryNames, recoverMisplacedLogs } from "../dist/support/log-recovery.js";

let passed = 0;
const check = (name, ok) => { assert.ok(ok, name); passed += 1; };

const names = misplacedDirectoryNames("阿钉");
check("First-level mojibake matches the real directory name", Buffer.from(names[0], "utf8").toString("hex") === "c3a9c298c2bfc3a9c292c289");
check("Each OTA adds one more mojibake level", names.length === 3 && names[1] !== names[0]);
// After the app name became ASCII, converting it yields itself: no mojibake directory should be derived at all.
// Otherwise the derived "mojibake directory" is the app's own directory, and every launch would rename the last-run.log being written.
check("ASCII app name derives no mojibake directory", misplacedDirectoryNames("ADing").length === 0);
check("ASCII app name does not count itself", !misplacedDirectoryNames("ADing").includes("ADing"));

const support = await mkdtemp(path.join(os.tmpdir(), "ading-log-recovery-"));
const std = path.join(support, "阿钉", "logs");
await mkdir(std, { recursive: true });
await writeFile(path.join(std, "last-run.log"), "standard\n");
for (const [index, name] of names.slice(0, 2).entries()) {
  await mkdir(path.join(support, name, "logs"), { recursive: true });
  await writeFile(path.join(support, name, "logs", "last-run.log"), `misplaced-${index}\n`);
}
// If a mojibake directory contains other things, ADing did not write it by mistake, so it must not be deleted
await writeFile(path.join(support, names[1], "keep-me.txt"), "not ours");
await mkdir(path.join(support, "别的应用", "logs"), { recursive: true });
await writeFile(path.join(support, "别的应用", "logs", "last-run.log"), "other app\n");

const moved = await recoverMisplacedLogs({ appSupportDirectory: support, appName: "阿钉", logDirectory: std, now: new Date("2026-09-18T14:00:00Z") });
check("Logs from both mojibake levels are recovered", moved.length === 2);
const files = (await readdir(std)).sort();
check("Recovered logs go into the standard directory and are renamed", files.filter((f) => f.startsWith("last-run-recovered-")).length === 2 && files.includes("last-run.log"));
const contents = await Promise.all(files.map((f) => readFile(path.join(std, f), "utf8")));
check("Log content is kept as-is", contents.includes("misplaced-0\n") && contents.includes("misplaced-1\n") && contents.includes("standard\n"));
const left = await readdir(support);
check("Mojibake directories left empty are deleted", !left.includes(names[0]));
check("Mojibake directories with other files are kept", left.includes(names[1]));
check("Other apps' directories are untouched", left.includes("别的应用"));
check("Does nothing when there is no mojibake directory", (await recoverMisplacedLogs({ appSupportDirectory: support, appName: "阿钉", logDirectory: std })).length === 0);

console.log(`log-recovery: ${passed} passed, 0 failed`);
