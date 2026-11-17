import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { compareVersions, isValidVersion } from "../dist/update/version.js";
import { AppUpdater, parseCheckResponse } from "../dist/update/updater.js";

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; }
  catch (error) { failed += 1; console.error(`FAIL: ${label} -> ${error?.stack ?? error}`); }
}

const MACHINE = "c".repeat(64);
const payload = Buffer.from("fake dmg bytes ".repeat(1000));
const sha = createHash("sha256").update(payload).digest("hex");
const update = (over = {}) => ({
  version: "0.5.0",
  url: "https://example.com/releases/0.5.0/ADing-0.5.0-arm64.dmg",
  sizeBytes: payload.length,
  sha256: sha,
  signed: false,
  mandatory: false,
  fullPackageRequired: false,
  gray: true,
  ...over
});
const available = (over) => ({ ok: true, data: { available: true, update: update(over) } });

function fakeDownload(body = payload, counter = { n: 0 }) {
  return async () => {
    counter.n += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === "content-length" ? String(body.length) : null) },
      body: (async function* () {
        for (let i = 0; i < body.length; i += 4096) yield body.subarray(i, i + 4096);
      })()
    };
  };
}

async function makeUpdater(request, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ading-update-"));
  const states = [];
  const logs = [];
  const updater = new AppUpdater({
    channel: "release",
    arch: "arm64",
    currentVersion: "0.4.0",
    directory,
    machineId: async () => MACHINE,
    request,
    download: fakeDownload(),
    onState: (s) => states.push(s),
    log: (event, data) => logs.push({ event, data }),
    ...extra
  });
  return { updater, directory, states, logs };
}

await check("version comparison: dev builds sort by build date and time, below the release with the same number", () => {
  assert.ok(compareVersions("0.4.0-2026.9.9-235959-dev", "0.4.0-2026.9.16-000000-dev") < 0);
  assert.ok(compareVersions("0.4.0-2026.10.1-000000-dev", "0.4.0-2026.9.30-235959-dev") > 0);
  // Same day, same three-part version: HHMMSS decides which is newer, so OTA tests don't need a version bump
  assert.ok(compareVersions("0.4.0-2026.9.16-093005-dev", "0.4.0-2026.9.16-093006-dev") < 0);
  assert.ok(compareVersions("0.4.0-2026.9.16-095959-dev", "0.4.0-2026.9.16-100000-dev") < 0);
  assert.ok(compareVersions("0.4.0-2026.9.16-230000-dev", "0.4.0-2026.9.16-091500-dev") > 0);
  assert.equal(compareVersions("0.4.0-2026.9.16-093005-dev", "0.4.0-2026.9.16-093005-dev"), 0);
  assert.ok(isValidVersion("0.4.0-2026.9.16-000000-dev"));
  assert.ok(compareVersions("0.4.0-2026.9.16-235959-dev", "0.4.0") < 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("0.4.0", "0.4.0+build.1"), 0);
  assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha") < 0);
  assert.ok(!isValidVersion("0.4.0-2026.09.16-093005-dev"));
});

await check("check request includes channel, architecture, current version, and computer identifier", async () => {
  let seen;
  const { updater, logs } = await makeUpdater(async (body) => { seen = body; return { ok: true, data: { available: false } }; });
  const state = await updater.check();
  assert.deepEqual(seen, { platform: "mac", channel: "release", arch: "arm64", currentVersion: "0.4.0", machineId: MACHINE });
  assert.equal(state.phase, "up-to-date");
  assert.equal(logs.find((l) => l.event === "update-check").data.machineId, MACHINE);
});

await check("with a gray version available, download, verify, and become ready", async () => {
  const { updater, directory, states } = await makeUpdater(async () => available());
  const state = await updater.check();
  assert.equal(state.phase, "ready");
  assert.equal(state.update.gray, true);
  assert.equal(path.dirname(state.file), path.join(directory, "0.5.0"));
  assert.deepEqual(await readFile(state.file), payload);
  assert.ok(states.some((s) => s.phase === "downloading"));
  assert.deepEqual(await readdir(path.join(directory, "0.5.0")), ["ADing-0.5.0-arm64.dmg"]);
});

await check("on checksum mismatch, delete and report an error without becoming ready", async () => {
  const { updater, directory } = await makeUpdater(async () => available({ sha256: "d".repeat(64) }));
  const state = await updater.check();
  assert.equal(state.phase, "error");
  assert.match(state.message, /校验和不一致/);
  assert.deepEqual(await readdir(path.join(directory, "0.5.0")), []);
});

await check("no re-download when already downloaded and checksum matches", async () => {
  const counter = { n: 0 };
  const { updater } = await makeUpdater(async () => available(), { download: fakeDownload(payload, counter) });
  await updater.check();
  await updater.check();
  assert.equal(counter.n, 1);
});

await check("only one check at a time", async () => {
  let calls = 0;
  const { updater } = await makeUpdater(async () => { calls += 1; return { ok: true, data: { available: false } }; });
  await Promise.all([updater.check(), updater.check(), updater.check()]);
  assert.equal(calls, 1);
});

await check("keep the ready version on network failure", async () => {
  let fail = false;
  const { updater } = await makeUpdater(async () => (fail ? { ok: false, message: "offline" } : available()));
  await updater.check();
  fail = true;
  assert.equal((await updater.check()).phase, "ready");
});

await check("clear the downloaded package when the gray release is withdrawn", async () => {
  let revoked = false;
  const { updater, directory } = await makeUpdater(async () => (revoked ? { ok: true, data: { available: false } } : available()));
  await updater.check();
  revoked = true;
  assert.equal((await updater.check()).phase, "up-to-date");
  assert.deepEqual(await readdir(directory), []);
});

await check("keep only the new version directory when switching to another version", async () => {
  let version = "0.5.0";
  const { updater, directory } = await makeUpdater(async () => available({
    version, url: `https://example.com/ADing-${version}.dmg`
  }));
  await updater.check();
  version = "0.6.0";
  const state = await updater.check();
  assert.equal(state.update.version, "0.6.0");
  assert.deepEqual(await readdir(directory), ["0.6.0"]);
});

await check("server response is validated field by field", () => {
  const response = (over) => ({ available: true, update: update(over) });
  assert.equal(parseCheckResponse({ available: false }, "0.4.0"), null);
  // Never "upgrade" to a lower or equal version
  assert.equal(parseCheckResponse(response({ version: "0.4.0" }), "0.4.0"), null);
  assert.equal(parseCheckResponse(response({ version: "0.3.9" }), "0.4.0"), null);
  assert.throws(() => parseCheckResponse(response({ url: "http://example.com/a.dmg" }), "0.4.0"), /https/);
  assert.throws(() => parseCheckResponse(response({ sha256: "xyz" }), "0.4.0"), /校验和/);
  assert.throws(() => parseCheckResponse(response({ version: "latest" }), "0.4.0"), /版本号/);
  assert.throws(() => parseCheckResponse("oops", "0.4.0"), /格式/);
  assert.equal(parseCheckResponse(response({ sha256: sha.toUpperCase() }), "0.4.0").sha256, sha);
});

await check("path traversal in file names is sanitized", async () => {
  const { updater, directory } = await makeUpdater(async () => available({
    url: "https://example.com/x/..%2F..%2Fevil.dmg"
  }));
  const state = await updater.check();
  assert.equal(state.phase, "ready");
  assert.equal(path.dirname(state.file), path.join(directory, "0.5.0"));
});

await check("check proceeds as usual without a computer identifier", async () => {
  let seen;
  const { updater } = await makeUpdater(
    async (body) => { seen = body; return { ok: true, data: { available: false } }; },
    { machineId: async () => { throw new Error("no ioreg"); } }
  );
  await updater.check();
  assert.equal("machineId" in seen, false);
});

console.log(`app-update: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
