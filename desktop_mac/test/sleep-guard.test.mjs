import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "./tmp.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SleepGuard } from "../dist/platform/sleep-guard.js";
import { readPreferences, writePreference } from "../dist/platform/preferences.js";
import { loadMainLanguage, setMainLanguage } from "../dist/i18n.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// Block idle sleep while any Agent is running, release immediately when idle; busy/idle is recomputed from the snapshot each time so a release is never missed
let busy = false, keepAwake = true, nextId = 1;
const active = new Set(), events = [];
const guard = new SleepGuard({
  busy: () => { if (busy === "throw") throw new Error("switching"); return busy; },
  keepAwake: () => keepAwake,
  blocker: { start: () => { const id = nextId++; active.add(id); return id; }, stop: (id) => active.delete(id) },
  onSleep: () => events.push("sleep"),
  onWake: () => events.push("wake"),
  log: () => undefined,
  intervalMs: 20
});
try {
  guard.refresh();
  assert.equal(active.size, 0, "idle does not block sleep");
  busy = true;
  guard.schedule(); guard.schedule(); guard.schedule();
  await tick();
  assert.equal(active.size, 1, "running blocks idle sleep; multiple events open only one blocker");
  guard.refresh();
  assert.equal(active.size, 1, "repeated recompute does not open extra blockers");
  busy = false;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(active.size, 0, "fallback recompute still releases when a busy/idle event is missed");

  busy = true; guard.refresh();
  keepAwake = false; guard.refresh();
  assert.equal(active.size, 0, "released immediately when the setting is turned off");
  keepAwake = true; guard.refresh();
  assert.equal(active.size, 1);
  busy = "throw"; guard.refresh();
  assert.equal(active.size, 0, "treated as idle when no snapshot is available");

  // Between suspend and resume counts as asleep (DarkWake does not emit resume)
  busy = true; guard.refresh();
  guard.suspend(); guard.suspend();
  assert.equal(guard.sleeping, true);
  assert.deepEqual(events, ["sleep"], "repeated suspend goes offline only once");
  assert.equal(active.size, 0, "no blocker held while asleep");
  guard.refresh();
  assert.equal(active.size, 0, "does not re-block sleep while asleep (DarkWake)");
  guard.resume("resume"); guard.resume("unlock-screen");
  assert.equal(guard.sleeping, false);
  assert.deepEqual(events, ["sleep", "wake"], "reconnects only once on wake");
  assert.equal(active.size, 1, "re-blocks after wake if still running");
} finally {
  guard.dispose();
}
assert.equal(active.size, 0, "released on exit");

// Preferences are saved per item: switching language does not clobber "keep awake", and vice versa
const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "ading-prefs-"));
try {
  const file = path.join(dir, "preferences.json");
  writeFileSync(file, JSON.stringify({ language: "en" }));
  writePreference(file, "keepAwake", false);
  assert.deepEqual(readPreferences(file), { language: "en", keepAwake: false });
  loadMainLanguage(file);
  setMainLanguage("zh-CN");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { language: "zh-CN", keepAwake: false });
  assert.deepEqual(readPreferences(path.join(dir, "missing.json")), {});
  setMainLanguage("zh-CN");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("sleep-guard: keep-awake blocker, suspend/DarkWake/resume and preferences passed");
