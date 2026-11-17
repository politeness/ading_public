/**
 * All recursive directory deletion in the main process goes through here.
 *
 * fs in the Electron main process treats .asar files as directories: when recursive deletion reaches an .asar (e.g. inside some .app's
 * Contents/Resources/default_app.asar), it waits forever, with the Promise neither resolving nor rejecting.
 * On 2026-09-29 a 0.7.0 upgrade got stuck exactly here — after preparation failed it had to delete the staging directory, which neither deleted nor errored;
 * the UI kept showing "Verifying installer", and only Contents/Resources/default_app.asar remained in the staging directory.
 * Besides update staging, .asar files can also appear in Agent temp directories, skill directories, and attachments (e.g. an Agent packaged an Electron app),
 * so all recursive deletion uses original-fs to bypass asar handling.
 * Unit tests run in plain Node without original-fs, so they use plain fs (which has no asar handling there).
 */
const nativeFs: typeof import("node:fs") = (() => {
  try {
    return require("original-fs") as typeof import("node:fs");
  } catch {
    return require("node:fs") as typeof import("node:fs");
  }
})();

/**
 * Deletes a directory tree.
 *
 * `fs.rm` defaults to `maxRetries: 0`: if anyone writes into it between its three steps "list directory → delete entries → delete directory",
 * the last step reports ENOTEMPTY and gives up. The 0.5.0 OTA on 2026-09-22
 * failed exactly this way — two pieces of code deleted the same staging at once, each deleting entries the other had listed,
 * and every update check afterwards got stuck on half a tree. Concurrency has been eliminated at the callers (see the staging serial queue in main.ts);
 * the retry here is a second safeguard: Spotlight, Time Machine, and antivirus scanning the tree cause the same jitter.
 */
export function removeTree(target: string): Promise<void> {
  return nativeFs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
