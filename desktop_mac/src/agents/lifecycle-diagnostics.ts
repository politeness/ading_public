import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants, lstat, open, realpath } from "node:fs/promises";
import type { RunResult } from "./process-runner";

const exec = promisify(execFile);
const TAIL_CHARS = 1500;

/**
 * Diagnostics for lifecycle operations such as install, sign-in and sign-in checks.
 *
 * Why: when these operations fail, the reason only appears in the UI, so reported logs contain nothing.
 * On 2026-09-17 Qoder sign-in failed with EPERM while the same command worked in Terminal; only on-site logs could tell
 * "all of ADing can't read this file" from "only child processes started by ADing can't read it".
 */

const SENSITIVE_KEYS = /^(e-?mail|user_?name|login|avatar_?url|phone|(access|refresh|id|api|session|auth)?_?token|api_?key|secret|password|cookie)$/i;

/**
 * Logs are uploaded to OSS with issue reports, so personal info and credentials are redacted before writing:
 * - URL query parameters often carry one-time auth data (challenge, nonce, machine ID); keep only the address itself;
 * - vendor status commands output email, username and avatar URL (e.g. `qodercli status -o json`); keep only field names;
 * - email addresses appearing elsewhere.
 * State needed for diagnosis, such as signed-in status and version, is kept as-is.
 */
export function redactDiagnosticText(text: string): string {
  return text
    .replace(/("([A-Za-z_-]+)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (whole, prefix: string, key: string) =>
      SENSITIVE_KEYS.test(key) ? `${prefix}"<已隐去>"` : whole)
    .replace(/(https?:\/\/[^\s?#'"]+)[?#][^\s'"]*/g, "$1?<已隐去>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<邮箱已隐去>");
}

export function outputTail(text: string, limit = TAIL_CHARS): string {
  const trimmed = redactDiagnosticText(text.trim());
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/** Extracts the denied file path from a Node-style error, e.g. `EPERM: operation not permitted, open '/x/y'`. */
export function deniedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(EPERM|EACCES)\b[^'"\n]*?\b(?:open|scandir|mkdir|lstat|stat|access|rename|unlink|link)\s+['"]([^'"\n]+)['"]/g)) {
    found.add(match[2]);
  }
  return [...found];
}

/** Finds the node the child process will actually use via PATH; `#!/usr/bin/env node` CLIs all run with it. */
async function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* next directory */ }
  }
  return undefined;
}

/** When the executable is a script, record its interpreter line so dispatch scripts and node scripts are obvious at a glance. */
async function interpreterLine(executablePath: string): Promise<string | undefined> {
  try {
    const handle = await open(executablePath, "r");
    try {
      const buffer = Buffer.alloc(128);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString("utf8");
      return head.startsWith("#!") ? head.split("\n")[0] : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function lifecycleStartDetail(options: {
  kind: AgentKind;
  action: string;
  executablePath: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> {
  let resolvedExecutable: string | undefined;
  try { resolvedExecutable = await realpath(options.executablePath); } catch { /* if missing, the run result will say so */ }
  return {
    kind: options.kind,
    action: options.action,
    executable: options.executablePath,
    ...(resolvedExecutable && resolvedExecutable !== options.executablePath ? { resolvedExecutable } : {}),
    interpreter: await interpreterLine(resolvedExecutable ?? options.executablePath),
    args: options.args.map(redactDiagnosticText),
    cwd: options.cwd,
    node: await resolveOnPath("node", options.env),
    customEnv: options.env !== undefined
  };
}

/**
 * When a child process reports "permission denied", ADing's main process probes the same file itself: only checks whether it opens, without reading content.
 * Main process can't open it either → the whole app is blocked; main process can open it → only child processes are blocked.
 */
export async function probeDeniedPath(filePath: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { path: filePath };
  try {
    const info = await lstat(filePath);
    result.mode = (info.mode & 0o7777).toString(8);
    result.uid = info.uid;
    result.gid = info.gid;
    result.processUid = process.getuid?.();
  } catch (error) {
    result.lstatError = (error as NodeJS.ErrnoException).code ?? String(error);
  }
  try {
    const handle = await open(filePath, "r");
    await handle.close();
    result.appCanOpen = true;
  } catch (error) {
    result.appCanOpen = false;
    result.appOpenError = (error as NodeJS.ErrnoException).code ?? String(error);
  }
  try {
    await access(path.dirname(filePath), constants.R_OK | constants.X_OK);
    result.parentAccess = "ok";
  } catch (error) {
    result.parentAccess = (error as NodeJS.ErrnoException).code ?? String(error);
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await exec("/usr/bin/xattr", [filePath], { timeout: 3000 });
      result.xattrs = stdout.split("\n").map(line => line.trim()).filter(Boolean);
    } catch (error) {
      result.xattrError = (error as Error).message.slice(0, 200);
    }
    try {
      const { stdout } = await exec("/bin/ls", ["-lO", filePath], { timeout: 3000 });
      result.fileFlags = stdout.trim().split(/\s+/)[4];
    } catch { /* ignore */ }
  }
  return result;
}

export function lifecycleDoneDetail(kind: AgentKind, action: string, run: RunResult, startedAt: number): Record<string, unknown> {
  return {
    kind,
    action,
    ok: !run.failure && !run.cancelled && run.exitCode === 0,
    exitCode: run.exitCode,
    signal: run.signal ?? undefined,
    cancelled: run.cancelled,
    durationMs: Date.now() - startedAt,
    failure: run.failure ? outputTail(run.failure, 500) : undefined,
    stdoutTail: outputTail(run.stdout),
    stderrTail: outputTail(run.stderr)
  };
}
