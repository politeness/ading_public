import path from "node:path";
import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";

/**
 * Recover logs written to the wrong place.
 *
 * When old-version OTA reopened ADing, `/usr/bin/open` passed the previous process's ADING_LOG along,
 * garbling the Chinese (UTF-8 bytes re-encoded as Latin-1), so logs were written to
 * `Application Support/<garbled 阿钉>/logs/`; each OTA added another layer of garbling.
 * These logs aren't in the standard directory, so issue reports don't pick them up. Current versions no longer write there;
 * this moves the misplaced ones back into the standard log directory (renamed last-run-recovered-…, retention rules apply as usual),
 * then deletes garbled directories left empty. Only directory names derived by this rule are recognized; nothing else is touched.
 */
export function misplacedDirectoryNames(appName: string, depth = 3): string[] {
  const names: string[] = [];
  let current = appName;
  for (let level = 0; level < depth; level += 1) {
    const next = Buffer.from(current, "utf8").toString("latin1");
    // A pure-ASCII name converts to itself. Without stopping here, the derived "garbled directory" would be the app's own directory,
    // and every startup would rename the currently written last-run.log as a misplaced log.
    if (next === current) break;
    current = next;
    names.push(current);
  }
  return names;
}

export async function recoverMisplacedLogs(options: {
  appSupportDirectory: string;
  appName: string;
  logDirectory: string;
  now?: Date;
}): Promise<Array<{ from: string; to: string }>> {
  const moved: Array<{ from: string; to: string }> = [];
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  let sequence = 0;
  for (const name of misplacedDirectoryNames(options.appName)) {
    const root = path.join(options.appSupportDirectory, name);
    const logs = path.join(root, "logs");
    let files: string[];
    try {
      if (!(await stat(root)).isDirectory()) continue;
      files = (await readdir(logs)).filter((file) => file.endsWith(".log"));
    } catch {
      continue;
    }
    await mkdir(options.logDirectory, { recursive: true });
    for (const file of files) {
      sequence += 1;
      const target = path.join(options.logDirectory, `last-run-recovered-${stamp}-${String(sequence).padStart(4, "0")}.log`);
      await rename(path.join(logs, file), target);
      moved.push({ from: path.join(logs, file), to: target });
    }
    // Only delete empty directories: if anything else is inside, we didn't misplace it, so leave it as is
    await rmdir(logs).catch(() => undefined);
    if ((await readdir(root).catch(() => ["?"])).length === 0) await rmdir(root).catch(() => undefined);
  }
  return moved;
}
