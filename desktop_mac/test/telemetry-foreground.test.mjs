import assert from "node:assert/strict";
import { ForegroundTelemetry, localHour, TELEMETRY_ROUTE } from "../dist/support/telemetry.js";

let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`); passed += 1; };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

check("does not use the old background reporting endpoint", TELEMETRY_ROUTE === "/api/v1/telemetry/foreground", TELEMETRY_ROUTE);
check("local hour is zero-padded", localHour(new Date(2026, 9, 5, 8, 30)) === "2026-10-05T08", localHour(new Date(2026, 9, 5, 8, 30)));
check("crossing the hour counts as two buckets", localHour(new Date(2026, 9, 5, 8, 59)) !== localHour(new Date(2026, 9, 5, 9, 0)));

// Both the clock and foreground state are injected
let clock = new Date(2026, 9, 30, 9, 0);
let foreground = false;
let outcome = { ok: true };
let gate;
const calls = [];
const telemetry = new ForegroundTelemetry({
  foreground: () => foreground,
  send: async (reason) => { calls.push(reason); if (gate) await gate; if (outcome === "throw") throw new Error("boom"); return outcome; },
  now: () => clock,
  intervalMs: 10
});
try {
  // Do not report before Agent detection finishes: otherwise the available Agents list is empty
  foreground = true;
  telemetry.check("focus");
  await wait(5);
  check("no report when the window comes to front before detection finishes", calls.length === 0, calls);

  // App started in the background (window not opened): no report even after detection -- this was the source of "counted as daily active without opening the UI"
  foreground = false;
  telemetry.markReady();
  telemetry.check("interval");
  await wait(5);
  check("no report when the window is not in front", calls.length === 0 && telemetry.reportedHour === undefined, calls);

  // Crossing midnight or waking no longer triggers a report: left open in the background overnight, periodic checks send nothing
  clock = new Date(2026, 9, 31, 7, 15);
  telemetry.start();
  await wait(40);
  check("no report when open in the background across days", calls.length === 0, calls);

  foreground = true;
  telemetry.check("focus");
  await wait(5);
  check("reports once when the window comes to front", calls.length === 1 && calls[0] === "focus", calls);
  check("records this hour on success", telemetry.reportedHour === "2026-10-31T07", telemetry.reportedHour);
  telemetry.check("focus"); telemetry.check("focus");
  await wait(40);
  check("no more reports within the same hour from refocusing or periodic checks", calls.length === 1, calls);

  // Kept in front: the periodic check reports again after crossing the hour
  clock = new Date(2026, 9, 31, 8, 1);
  await wait(40);
  check("reports once more after crossing the hour while in front", calls.length === 2 && calls[1] === "interval", calls);
  telemetry.dispose();

  // On failure the hour is not recorded, so it can retry next time
  clock = new Date(2026, 9, 31, 9, 0);
  outcome = { ok: false, message: "unreachable" };
  telemetry.check("focus");
  await wait(5);
  check("failure does not update the last reported hour", calls.length === 3 && telemetry.reportedHour === "2026-10-31T08", telemetry.reportedHour);
  outcome = "throw";
  telemetry.check("focus");
  await wait(5);
  check("report exception is neither recorded nor rethrown", calls.length === 4 && telemetry.reportedHour === "2026-10-31T08", telemetry.reportedHour);
  outcome = { ok: true };
  telemetry.check("focus");
  await wait(5);
  check("retries successfully on next focus after failure", calls.length === 5 && telemetry.reportedHour === "2026-10-31T09", telemetry.reportedHour);

  // In-flight dedup: refocusing before the previous report returns sends only one
  clock = new Date(2026, 9, 31, 10, 0);
  gate = wait(20);
  telemetry.check("focus"); telemetry.check("focus");
  await wait(40);
  check("no duplicate while in flight", calls.length === 6, calls);
} finally {
  telemetry.dispose();
}

console.log(`telemetry-foreground: ${passed} passed, 0 failed`);
