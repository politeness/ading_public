import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A working directory under the system temp directory, whose name says who created it and why.
 *
 * If it were just `ading-work-`, a pile of leftovers in the temp directory couldn't be traced back to the task or lane that left them,
 * nor could we tell whether to delete them. With task and work identifiers in the name, they match the tasks in the logs at a glance when troubleshooting.
 *
 * The identifiers come from internal values like task IDs and Agent IDs, but are still treated as paths: only digits, letters, dots, underscores and hyphens are kept,
 * everything else becomes an underscore, at most 24 characters per segment. macOS path separators and colons are both replaced,
 * and the whole name never grows past the file name length limit.
 */
export function scratchName(purpose: string, ...marks: string[]): string {
  // Strip leading and trailing dots: a segment of just ".." can't cause path traversal (it is part of a file name, with no slash),
  // but it looks like a parent directory when troubleshooting; no need to leave that ambiguity
  const clean = (value: string) =>
    value.replace(/[^0-9A-Za-z._-]/g, "_").replace(/^\.+|\.+$/g, "").slice(0, 24);
  return [`ading-${purpose}`, ...marks.map(clean).filter(Boolean), ""].join("-");
}

/** Creates a labeled temp directory. The returned path ends with the random suffix added by mkdtemp */
export function makeScratchDirectory(purpose: string, ...marks: string[]): Promise<string> {
  return mkdtemp(path.join(tmpdir(), scratchName(purpose, ...marks)));
}
