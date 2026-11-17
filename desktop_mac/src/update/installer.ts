import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tm } from "../i18n";
import { removeTree } from "../platform/remove-tree";

/**
 * OTA install: swap the new .app from the downloaded, verified DMG into the location of the running .app.
 *
 * Why not Squirrel.Mac (electron autoUpdater): it requires both the old and new bundles to have Developer ID signatures
 * with the same Team ID; the current bundle is ad-hoc signed, so Squirrel refuses to install. We do the swap ourselves:
 *   1. Prepare (app still running): mount DMG → copy the .app to staging → unmount →
 *      verify bundle identifier, version, and signature integrity; if the current bundle has a Team ID, the new one must have the same Team ID.
 *   2. Swap (after the app quits): a small standalone script waits for the ADing process to actually exit,
 *      moves the old bundle to rollback/ (only one copy kept, for rollback), then moves the new bundle in; on failure it puts the old bundle back.
 * This flow still works once we have a certificate; signature checks become stricter automatically.
 */

export type RunCommand = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export const defaultRun: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export const BUNDLE_ID = "com.politeness.ading";

export { removeTree };

/** The old version kept in the rollback directory (its name may differ from the current one: a renamed old version is called 阿钉.app) */
export async function rollbackBundle(directory: string): Promise<string | undefined> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const name = names.find((entry) => entry.endsWith(".app"));
  return name ? path.join(directory, name) : undefined;
}

/** Find the enclosing .app from the main process executable path */
export function appBundleOf(execPath: string): string | undefined {
  const marker = ".app/Contents/MacOS/";
  const index = execPath.lastIndexOf(marker);
  return index < 0 ? undefined : execPath.slice(0, index + ".app".length);
}

/** Reason automatic replacement isn't possible; undefined means it is possible */
export async function installBlocker(bundle: string | undefined): Promise<string | undefined> {
  if (!bundle) return tm("svc.update.devMode");
  if (bundle.includes("/AppTranslocation/")) {
    return tm("svc.update.translocated");
  }
  if (bundle.startsWith("/Volumes/")) return tm("svc.update.fromVolume");
  try {
    await access(path.dirname(bundle), constants.W_OK);
    await access(bundle, constants.W_OK);
  } catch {
    return tm("svc.update.noPermission", { bundle });
  }
  return undefined;
}

interface Signature {
  identifier?: string;
  teamId?: string;
}

/** codesign -dv writes its info to stderr */
export function parseSignature(output: string): Signature {
  const identifier = /^Identifier=(.+)$/m.exec(output)?.[1]?.trim();
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  return {
    ...(identifier ? { identifier } : {}),
    ...(team && team !== "not set" ? { teamId: team } : {})
  };
}

async function readSignature(run: RunCommand, bundle: string): Promise<Signature> {
  const { stdout, stderr } = await run("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
  return parseSignature(`${stdout}\n${stderr}`);
}

export interface StageOptions {
  dmg: string;
  version: string;
  /** Staging directory dedicated to this version (updates/staging.noindex/<version>). One per version; they don't overwrite each other */
  workDir: string;
  /** The running .app, used to verify the signing identity */
  currentBundle: string;
  run?: RunCommand;
}

/** Prepare the new version and return the .app path in staging. Throws if any check fails, leaving nothing half-done */
export async function stageUpdate(options: StageOptions): Promise<string> {
  const run = options.run ?? defaultRun;
  await removeTree(options.workDir);
  const mountPoint = path.join(options.workDir, "mnt");
  const stagedDir = path.join(options.workDir, "app");
  await mkdir(mountPoint, { recursive: true });
  await mkdir(stagedDir, { recursive: true });

  try {
    const staged = await copyOutOfDmg(run, options, mountPoint, stagedDir);
    const manifest = JSON.parse(
      await readFile(path.join(staged, "Contents", "Resources", "app", "package.json"), "utf8")
    ) as { version?: unknown };
    if (manifest.version !== options.version) {
      throw new Error(tm("svc.update.versionMismatch", { actual: String(manifest.version), expected: options.version }));
    }
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
    const [current, next] = await Promise.all([
      readSignature(run, options.currentBundle),
      readSignature(run, staged)
    ]);
    if (next.identifier !== BUNDLE_ID) {
      throw new Error(tm("svc.update.wrongIdentifier", { identifier: next.identifier ?? tm("svc.update.unknown") }));
    }
    // When the current bundle is properly signed, the new one must come from the same developer certificate — the same security baseline Squirrel enforces
    if (current.teamId && next.teamId !== current.teamId) {
      throw new Error(tm("svc.update.teamMismatch", { next: next.teamId ?? tm("svc.update.unsigned"), current: String(current.teamId) }));
    }
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged]).catch(() => undefined);
    return staged;
  } catch (error) {
    // If unmount fails, mnt is still the read-only installer disk; failing to delete it is fine — don't let a cleanup error mask the real cause
    await removeTree(options.workDir).catch(() => undefined);
    throw error;
  }
}

async function copyOutOfDmg(
  run: RunCommand,
  options: StageOptions,
  mountPoint: string,
  stagedDir: string
): Promise<string> {
  await run("/usr/bin/hdiutil", [
    "attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mountPoint, options.dmg
  ]);
  try {
    const apps: string[] = [];
    for (const name of await readdir(mountPoint)) {
      if (!name.endsWith(".app")) continue;
      // In the DMG, the item pointing to "Applications" is a symlink; the real bundle is a directory
      if ((await lstat(path.join(mountPoint, name))).isDirectory()) apps.push(name);
    }
    if (apps.length !== 1) throw new Error(tm("svc.update.appCount", { count: apps.length }));
    // Use the app's own name from the installer: when the app was renamed (阿钉.app → ADing.app), the new name is what gets installed
    const staged = path.join(stagedDir, apps[0]);
    // ditto preserves the extended attributes and symlinks the signature needs
    await run("/usr/bin/ditto", [path.join(mountPoint, apps[0]), staged]);
    return staged;
  } finally {
    await run("/usr/bin/hdiutil", ["detach", mountPoint, "-force"]).catch(() => undefined);
  }
}

/**
 * Swap script. Arguments: PID CURRENT TARGET STAGED BACKUP RELAUNCH LOG
 * A standalone process that acts only after ADing exits; it doesn't depend on Node and uses only built-in system commands.
 *
 * CURRENT is the running bundle and TARGET is the installed location. They are usually the same; when the app is renamed
 * (阿钉.app → ADing.app), TARGET uses the new name and the old bundle is still moved to BACKUP for rollback.
 * An empty STAGED means rename only, no version change: the 0.7.0 installer put the new version back under the old name, and the new version fixes it on quit.
 */
export const INSTALL_SCRIPT = `#!/bin/bash
set -u
PID="$1"; CURRENT="$2"; TARGET="$3"; STAGED="$4"; BACKUP="$5"; RELAUNCH="$6"; LOG="$7"
OPEN_CMD="\${ADING_OPEN_CMD:-/usr/bin/open}"
exec >>"$LOG" 2>&1
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
relaunch() { if [ "$RELAUNCH" = "1" ]; then "$OPEN_CMD" "$1" || say "Relaunch failed"; fi; }

say "Waiting for ADing to exit pid=$PID"
for _ in $(seq 1 1200); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$PID" 2>/dev/null; then say "ADing did not exit within 120 seconds; abandoning this update"; exit 1; fi

if [ -z "$STAGED" ]; then
  if [ -e "$TARGET" ]; then say "Rename target already exists; leaving as is: $TARGET"; relaunch "$CURRENT"; exit 1; fi
  if ! mv "$CURRENT" "$TARGET"; then say "Rename failed: $CURRENT"; relaunch "$CURRENT"; exit 1; fi
  say "Renamed: $CURRENT -> $TARGET"
  relaunch "$TARGET"
  exit 0
fi
if [ ! -d "$STAGED" ]; then say "Staged bundle not found: $STAGED"; relaunch "$CURRENT"; exit 1; fi

mkdir -p "$(dirname "$BACKUP")"
rm -rf "$BACKUP.swap"
if ! mv "$CURRENT" "$BACKUP.swap"; then say "Could not move the current version: $CURRENT"; relaunch "$CURRENT"; exit 1; fi
# For a rename install, if an old app with the new name is left at that location, replace it too
if [ "$TARGET" != "$CURRENT" ] && [ -e "$TARGET" ]; then rm -rf "$TARGET"; fi
if ! mv "$STAGED" "$TARGET"; then
  say "Failed to move in the new bundle; restoring the original version"
  mv "$BACKUP.swap" "$CURRENT" || say "Restore failed! The original version is at $BACKUP.swap"
  relaunch "$CURRENT"
  exit 1
fi
rm -rf "$(dirname "$BACKUP")"/*.app
mv "$BACKUP.swap" "$BACKUP" || say "Failed to keep the rollback copy (this update is not affected)"
say "Replaced: $TARGET"
relaunch "$TARGET"
exit 0
`;

/**
 * Environment variables for the swap script and the ADing it relaunches: keep only the basic variables present when opened from Finder.
 *
 * Why not inherit directly: `/usr/bin/open` passes the caller's environment variables to the newly launched app,
 * and any Chinese in them gets garbled (UTF-8 bytes re-encoded as if they were Latin-1). An inherited
 * ADING_LOG points to "…/Application Support/阿钉/logs"; once garbled, logs are written to a different directory,
 * and the next OTA garbles it another layer. On 2026-09-18 this split one computer's daytime logs and the logs collected for issue reports into two places.
 * The node shim directory ADing adds to PATH also contains Chinese and must not be passed down either.
 */
export function relaunchEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  // For tests: replaces the "relaunch" command; absent in normal runs
  if (source.ADING_OPEN_CMD) env.ADING_OPEN_CMD = source.ADING_OPEN_CMD;
  return env;
}

export interface LaunchOptions {
  /** The updates/ root directory, where the script and log live */
  directory: string;
  pid: number;
  /** The running .app */
  current: string;
  /** The installed location; same directory as current, named after the new bundle */
  target: string;
  /** The new bundle to install; empty means just rename current to target */
  staged: string;
  backup: string;
  relaunch: boolean;
  spawnProcess?: typeof spawn;
}

/** Start the swap script and return immediately. The caller then quits the app */
export async function launchInstaller(options: LaunchOptions): Promise<void> {
  await mkdir(options.directory, { recursive: true });
  const script = path.join(options.directory, "install.sh");
  await writeFile(script, INSTALL_SCRIPT, "utf8");
  await chmod(script, 0o755);
  const child = (options.spawnProcess ?? spawn)("/bin/bash", [
    script,
    String(options.pid),
    options.current,
    options.target,
    options.staged,
    options.backup,
    options.relaunch ? "1" : "0",
    path.join(options.directory, "install.log")
  ], { detached: true, stdio: "ignore", env: relaunchEnvironment() });
  child.unref();
}
