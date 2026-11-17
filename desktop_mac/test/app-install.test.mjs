import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { cp, mkdir, readFile, readdir, symlink, writeFile, access } from "node:fs/promises";
import {
  appBundleOf, BUNDLE_ID, installBlocker, launchInstaller, parseSignature, relaunchEnvironment, removeTree, stageUpdate
} from "../dist/update/installer.js";
import { UpdateHealth, releaseKey, HEALTHY_AFTER_MS } from "../dist/update/health.js";

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; }
  catch (error) { failed += 1; console.error(`FAIL: ${label} -> ${error?.stack ?? error}`); }
}
const exists = (p) => access(p).then(() => true, () => false);
const tmp = (name) => mkdtemp(path.join(os.tmpdir(), `ading-${name}-`));

async function fakeApp(dir, version, marker) {
  const bundle = path.join(dir, "阿钉.app");
  await mkdir(path.join(bundle, "Contents", "Resources", "app"), { recursive: true });
  await writeFile(path.join(bundle, "Contents", "Resources", "app", "package.json"), JSON.stringify({ version }));
  await writeFile(path.join(bundle, "marker.txt"), marker);
  return bundle;
}

/** Simulate hdiutil / ditto / codesign / xattr */
function fakeRun({ dmgContent, signatures, calls = [], verifyFails = false }) {
  return async (file, args) => {
    calls.push([path.basename(file), ...args]);
    const tool = path.basename(file);
    if (tool === "hdiutil" && args[0] === "attach") {
      const mountPoint = args[args.indexOf("-mountpoint") + 1];
      await cp(dmgContent, mountPoint, { recursive: true, verbatimSymlinks: true });
      return { stdout: "", stderr: "" };
    }
    if (tool === "hdiutil") return { stdout: "", stderr: "" };
    if (tool === "ditto") {
      await cp(args[0], args[1], { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (tool === "codesign" && args[0] === "--verify") {
      if (verifyFails) throw new Error("invalid signature");
      return { stdout: "", stderr: "" };
    }
    if (tool === "codesign") {
      const target = args.at(-1);
      const sig = target.includes("staging") ? signatures.next : signatures.current;
      return { stdout: "", stderr: `Executable=x\nIdentifier=${sig.identifier}\nTeamIdentifier=${sig.team}\n` };
    }
    return { stdout: "", stderr: "" };
  };
}

async function dmgFixture(version, { extraApp = false } = {}) {
  const root = await tmp("dmg");
  await fakeApp(root, version, "new");
  await symlink("/Applications", path.join(root, "Applications"));
  if (extraApp) await fakeApp(path.join(root, "extra"), version, "x").then((p) => cp(p, path.join(root, "另一个.app"), { recursive: true }));
  return root;
}

async function stageFixture(opts = {}) {
  const home = await tmp("stage");
  const current = await fakeApp(path.join(home, "Applications"), "0.4.0", "old");
  const dmgContent = await dmgFixture(opts.dmgVersion ?? "0.5.0", opts);
  const calls = [];
  const run = fakeRun({
    dmgContent,
    calls,
    verifyFails: opts.verifyFails,
    signatures: {
      current: { identifier: BUNDLE_ID, team: opts.currentTeam ?? "not set" },
      next: { identifier: opts.nextId ?? BUNDLE_ID, team: opts.nextTeam ?? "not set" }
    }
  });
  const workDir = path.join(home, "updates", "staging");
  const promise = stageUpdate({ dmg: "/x.dmg", version: "0.5.0", workDir, currentBundle: current, run });
  return { promise, workDir, calls, current };
}

await check("find the .app from the executable path", () => {
  assert.equal(appBundleOf("/Applications/阿钉.app/Contents/MacOS/阿钉"), "/Applications/阿钉.app");
  assert.equal(appBundleOf("/usr/local/bin/electron"), undefined);
});

await check("cases where automatic replacement isn't possible", async () => {
  assert.match(await installBlocker(undefined), /开发模式/);
  assert.match(await installBlocker("/private/var/folders/x/AppTranslocation/y/阿钉.app"), /隔离/);
  assert.match(await installBlocker("/Volumes/阿钉/阿钉.app"), /安装盘/);
  assert.match(await installBlocker("/nonexistent/阿钉.app"), /权限/);
  const dir = await tmp("writable");
  assert.equal(await installBlocker(await fakeApp(dir, "0.4.0", "x")), undefined);
});

await check("removing a tree that someone else is touching doesn't give up after one try", async () => {
  // This is how the 0.5.0 OTA on 2026-09-22 failed: updates/staging was operated on at once by two paths that didn't wait for each other
  // (one deleting the old version, one making room for the new version); fs.rm defaults to maxRetries=0, so the final rmdir hit
  // ENOTEMPTY and gave up, leaving half a tree, and every later update check reported the same error. removeTree retries.
  const root = await tmp("remove-tree");
  const resources = path.join(root, "staging", "app", "阿钉.app", "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  for (let i = 0; i < 40; i += 1) {
    await mkdir(path.join(resources, `d${i}`), { recursive: true });
    for (let j = 0; j < 10; j += 1) await writeFile(path.join(resources, `d${i}`, `f${j}`), "x".repeat(1024));
  }
  // Someone keeps writing into it during deletion, simulating a concurrent ditto / another preparation
  let writing = true;
  const writer = (async () => {
    while (writing) await writeFile(path.join(resources, "default_app.asar"), "x".repeat(4096)).catch(() => undefined);
  })();
  const failure = await removeTree(path.join(root, "staging")).then(() => undefined, (error) => error);
  writing = false;
  await writer;
  assert.equal(failure, undefined, `removeTree should not fail: ${failure?.code ?? failure}`);
});

await check("each version has its own staging; preparing a new version doesn't touch the old one's", async () => {
  // The old implementation shared updates/staging across all versions, so the old one had to be deleted before installing a new one — exactly the premise that created the concurrency.
  const home = await tmp("staging-per-version");
  const current = await fakeApp(path.join(home, "Applications"), "0.4.0", "old");
  const previous = path.join(home, "updates", "staging", "0.4.9");
  await mkdir(previous, { recursive: true });
  await writeFile(path.join(previous, "留下的.txt"), "上一次预备留下的");
  const dmgContent = await dmgFixture("0.5.0");
  const run = fakeRun({
    dmgContent,
    signatures: { current: { identifier: BUNDLE_ID, team: "not set" }, next: { identifier: BUNDLE_ID, team: "not set" } }
  });
  const workDir = path.join(home, "updates", "staging", "0.5.0");
  const staged = await stageUpdate({ dmg: "/x.dmg", version: "0.5.0", workDir, currentBundle: current, run });
  assert.ok(staged.startsWith(workDir), "new version is prepared in its own directory");
  assert.equal(await exists(path.join(previous, "留下的.txt")), true, "must not touch another version's staging");
});

await check("parse codesign output", () => {
  assert.deepEqual(parseSignature("Identifier=com.a\nTeamIdentifier=ABCDE12345\n"), { identifier: "com.a", teamId: "ABCDE12345" });
  assert.deepEqual(parseSignature("Identifier=com.a\nTeamIdentifier=not set\n"), { identifier: "com.a" });
});

await check("preparation succeeds: copy out the new bundle, unmount the installer disk, remove the quarantine attribute", async () => {
  const { promise, calls } = await stageFixture();
  const staged = await promise;
  assert.equal(path.basename(staged), "阿钉.app");
  assert.equal(await readFile(path.join(staged, "marker.txt"), "utf8"), "new");
  assert.ok(calls.some((c) => c[0] === "hdiutil" && c[1] === "detach"));
  assert.ok(calls.some((c) => c[0] === "xattr"));
});

for (const [label, opts, pattern] of [
  ["version mismatch", { dmgVersion: "0.6.0" }, /不是预期的 0\.5\.0/],
  ["signature verification fails", { verifyFails: true }, /invalid signature/],
  ["not an ADing bundle", { nextId: "com.evil.app" }, /不是阿钉/],
  ["Team ID must match for properly signed apps", { currentTeam: "AAAAAAAAAA", nextTeam: "BBBBBBBBBB" }, /签名团队/],
  ["a properly signed app rejects an unsigned new bundle", { currentTeam: "AAAAAAAAAA" }, /签名团队/],
  ["multiple .app bundles on the installer disk", { extraApp: true }, /恰好有一个/]
]) {
  await check(`preparation fails: ${label}, leaving nothing half-done`, async () => {
    const { promise, workDir, calls } = await stageFixture(opts);
    await assert.rejects(promise, pattern);
    assert.equal(await exists(workDir), false);
    if (!opts.extraApp) assert.ok(calls.some((c) => c[0] === "hdiutil" && c[1] === "detach"));
  });
}

await check("a properly signed bundle with the same Team ID can be installed", async () => {
  const { promise } = await stageFixture({ currentTeam: "AAAAAAAAAA", nextTeam: "AAAAAAAAAA" });
  await promise;
});

async function installFixture() {
  const home = await tmp("install");
  const target = await fakeApp(path.join(home, "Applications"), "0.4.0", "old");
  const staged = await fakeApp(path.join(home, "updates", "staging", "app"), "0.5.0", "new");
  const backup = path.join(home, "updates", "rollback", "阿钉.app");
  const opened = path.join(home, "opened.txt");
  const openCmd = path.join(home, "fake-open.sh");
  await writeFile(openCmd, `#!/bin/bash\necho "$1" >> "${opened}"\n`);
  execFileSync("chmod", ["+x", openCmd]);
  return { home, target, staged, backup, opened, openCmd };
}

let launchedEnv;
function runScript(f, { pid, staged = f.staged, relaunch = true }) {
  return new Promise((resolve) => {
    const spawnProcess = (cmd, args, options) => {
      launchedEnv = options.env;
      const child = spawn(cmd, args, { ...options, detached: false, env: { ...options.env, ADING_OPEN_CMD: f.openCmd } });
      child.on("exit", (code) => resolve(code));
      // launchInstaller calls unref; the test needs to wait for it to finish, so don't let it detach from the event loop
      return { unref() {} };
    };
    void launchInstaller({
      directory: path.join(f.home, "updates"), pid, current: f.target, target: f.target, staged, backup: f.backup, relaunch, spawnProcess
    });
  });
}

await check("swap script: after the process exits, swap in the new bundle, keep the old one for rollback, relaunch", async () => {
  const f = await installFixture();
  const sleeper = spawn("sleep", ["0.5"]);
  const started = Date.now();
  const code = await runScript(f, { pid: sleeper.pid });
  assert.equal(code, 0);
  assert.ok(Date.now() - started >= 400, "should wait for the process to exit");
  assert.equal(await readFile(path.join(f.target, "marker.txt"), "utf8"), "new");
  assert.equal(await readFile(path.join(f.backup, "marker.txt"), "utf8"), "old");
  assert.equal(await exists(f.staged), false);
  assert.equal((await readFile(f.opened, "utf8")).trim(), f.target);
  assert.match(await readFile(path.join(f.home, "updates", "install.log"), "utf8"), /Replaced: /);
});

await check("relaunch doesn't pass ADing's own environment variables down (open garbles Chinese paths)", async () => {
  const env = relaunchEnvironment({
    HOME: "/Users/x", USER: "x", PATH: "/Users/x/Library/Application Support/阿钉/runtime/abc/bin:/usr/bin",
    ADING_LOG: "/Users/x/Library/Application Support/阿钉/logs/last-run.log", ADING_CHANNEL: "pre",
    ELECTRON_RUN_AS_NODE: "1", __CF_USER_TEXT_ENCODING: "0x1F5:0x19:0x34"
  });
  assert.equal(env.ADING_LOG, undefined);
  assert.equal(env.ADING_CHANNEL, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(env.HOME, "/Users/x");
  assert.equal(env.__CF_USER_TEXT_ENCODING, "0x1F5:0x19:0x34");
  const f = await installFixture();
  process.env.ADING_LOG = "/Users/x/Library/Application Support/阿钉/logs/last-run.log";
  try {
    await runScript(f, { pid: spawn("true").pid });
  } finally {
    delete process.env.ADING_LOG;
  }
  assert.equal(launchedEnv.ADING_LOG, undefined, "the swap script itself also starts with a clean environment");
});

await check("swap script: only swaps when not relaunching", async () => {
  const f = await installFixture();
  const sleeper = spawn("true");
  await new Promise((r) => sleeper.on("exit", r));
  assert.equal(await runScript(f, { pid: sleeper.pid, relaunch: false }), 0);
  assert.equal(await exists(f.opened), false);
  assert.equal(await readFile(path.join(f.target, "marker.txt"), "utf8"), "new");
});

await check("swap script: if the new bundle is missing, leave the old version alone and relaunch it", async () => {
  const f = await installFixture();
  assert.equal(await runScript(f, { pid: 999999, staged: path.join(f.home, "missing.app") }), 1);
  assert.equal(await readFile(path.join(f.target, "marker.txt"), "utf8"), "old");
  assert.equal((await readFile(f.opened, "utf8")).trim(), f.target);
});

await check("swap script: rollback swaps the old bundle in rollback back in (the two trade places)", async () => {
  const f = await installFixture();
  assert.equal(await runScript(f, { pid: 999999 }), 0);
  assert.equal(await runScript(f, { pid: 999999, staged: f.backup }), 0);
  assert.equal(await readFile(path.join(f.target, "marker.txt"), "utf8"), "old");
  assert.equal(await readFile(path.join(f.backup, "marker.txt"), "utf8"), "new");
  assert.deepEqual(await readdir(path.dirname(f.backup)), ["阿钉.app"]);
});

await check("health record: prompt rollback only when the OTA-installed version exits quickly twice in a row", async () => {
  const dir = await tmp("health");
  const update = { version: "0.5.0", sha256: "e".repeat(64) };
  let health = new UpdateHealth(dir);
  await health.load();
  await health.recordLaunch("0.4.0");
  await health.markHealthy();
  await health.markInstalled(update, "0.4.0");

  // Neither the first nor the second launch lasted long enough to be healthy
  for (let i = 0; i < 2; i++) {
    health = new UpdateHealth(dir);
    await health.load();
    assert.equal((await health.recordLaunch("0.5.0")).offerRollback, false);
  }
  health = new UpdateHealth(dir);
  await health.load();
  const third = await health.recordLaunch("0.5.0");
  assert.deepEqual(third, { offerRollback: true, previous: "0.4.0", rejectKey: releaseKey(update) });

  await health.reject(third.rejectKey);
  health = new UpdateHealth(dir);
  await health.load();
  assert.equal(health.isRejected(releaseKey(update)), true);
  assert.equal((await health.recordLaunch("0.4.0")).offerRollback, false);
  assert.equal(HEALTHY_AFTER_MS, 60_000);
});

await check("health record: no prompt if one launch in between was normal; no prompt for versions not installed via OTA", async () => {
  const dir = await tmp("health2");
  const health = new UpdateHealth(dir);
  await health.load();
  await health.markInstalled({ version: "0.5.0", sha256: "f".repeat(64) }, "0.4.0");
  await health.recordLaunch("0.5.0");
  await health.markHealthy();
  await health.recordLaunch("0.5.0");
  assert.equal((await health.recordLaunch("0.5.0")).offerRollback, false);

  const other = new UpdateHealth(await tmp("health3"));
  await other.load();
  await other.recordLaunch("0.6.0");
  await other.recordLaunch("0.6.0");
  assert.equal((await other.recordLaunch("0.6.0")).offerRollback, false);
});

await check("start over when the health file is corrupted", async () => {
  const dir = await tmp("health4");
  await writeFile(path.join(dir, "health.json"), "{broken");
  const health = new UpdateHealth(dir);
  await health.load();
  assert.equal((await health.recordLaunch("0.5.0")).offerRollback, false);
});

console.log(`app-install: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
