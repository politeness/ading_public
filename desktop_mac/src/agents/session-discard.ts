import path from "node:path";
import { lstat, rm } from "node:fs/promises";
import { removeTree } from "../platform/remove-tree";

/** A provider session ID is one path segment and can't be read as a CLI option. */
export function isOwnSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/**
 * Remove one stored record of a session this turn created. A name that leaves `root`, a symlink
 * or an entry of the other type is left alone; so the worst case is a record that stays.
 * Returns whether something was removed.
 */
export async function removeOwnSessionEntry(root: string, name: string, type: "file" | "directory"): Promise<boolean> {
  if (!isOwnSessionId(name)) return false;
  const target = path.join(root, name);
  const stats = await lstat(target).catch(() => undefined);
  if (!stats || (type === "file" ? !stats.isFile() : !stats.isDirectory())) return false;
  if (type === "file") await rm(target, { force: true });
  else await removeTree(target);
  return true;
}
