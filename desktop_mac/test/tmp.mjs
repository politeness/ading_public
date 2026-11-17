/**
 * Temp directories for tests: created directories are registered and all deleted on process exit.
 *
 * Tests use `mkdtemp` heavily, but only a few files clean up afterwards; one full test run would leave
 * hundreds of `ading-*` in the system temp directory (the 2026-09-22 cleanup removed 1153 at once, 96 MB; 4762 were seen once).
 * Rather than writing try/finally in every file -- and the hard path to clean is exactly the failed-assertion / early-return one --
 * let creation keep the books itself: usage is identical to the same-named `node:fs` functions, plus automatic cleanup.
 *
 * Deletion runs in the `exit` event and must be synchronous, hence `rmSync`. Failing to delete (a child process still holds it,
 * or the test already deleted it) is fine; this is best-effort only, and a cleanup failure must never fail a test.
 */
import { mkdtemp as createAsync } from "node:fs/promises";
import { mkdtempSync as createSync, rmSync } from "node:fs";

const created = new Set();
let registered = false;

function remember(directory) {
  created.add(directory);
  if (!registered) {
    registered = true;
    process.on("exit", () => {
      for (const target of created) {
        try {
          rmSync(target, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          // cleanup failure does not affect the test result
        }
      }
    });
  }
  return directory;
}

export async function mkdtemp(prefix) {
  return remember(await createAsync(prefix));
}

export function mkdtempSync(prefix) {
  return remember(createSync(prefix));
}
