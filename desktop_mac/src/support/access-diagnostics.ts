import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeCodexHome } from "../agents/codex-session-home";

/**
 * On-the-spot record when a vendor CLI is denied (EPERM / EACCES) reading/writing its own config directory.
 *
 * On 2026-09-17 and 09-28, Qoder CLI on the same computer twice reported "can't read saved login state (EPERM)";
 * it can't be reproduced locally, and ADing's detection sandbox doesn't govern ~/.qoder. The root cause can only be found on the affected computer,
 * so at the moment of failure record everything visible: directory permissions, ACLs, file flags, extended attributes,
 * relevant lines from the vendor CLI's own logs, installed system extensions (security software), and blocking records in the system log.
 * All read-only, run only on errors.
 */

export const ACCESS_DENIED = /\bE(PERM|ACCES)\b|operation not permitted|permission denied/i;

type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const run: Run = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      const text = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
      resolve(error && !text ? `failed: ${error.message}` : text);
    });
  });

function configDirectory(kind: AgentKind, home: string): string {
  switch (kind) {
    case "qoder": return process.env.QODER_CONFIG_DIR || path.join(home, ".qoder");
    case "qoder-cn": return process.env.QODERCN_CONFIG_DIR || path.join(home, ".qoder-cn");
    case "kiro": return path.join(home, ".kiro");
    case "copilot": return process.env.COPILOT_HOME || path.join(home, ".copilot");
    case "antigravity": return path.join(home, ".gemini", "antigravity-cli");
    case "qwen-code": return process.env.QWEN_HOME || path.join(home, ".qwen");
    case "codex": return nativeCodexHome(home);
    default: return path.join(home, ".claude");
  }
}

const tail = (text: string, lines: number, chars = 4000) => text.split("\n").slice(-lines).join("\n").slice(-chars);

async function vendorLogLines(directory: string): Promise<string | undefined> {
  for (const file of [path.join(directory, "logs", "latest", "qodercli.log"), path.join(directory, "logs", "latest", "qoderclicn.log")]) {
    try {
      const text = await readFile(file, "utf8");
      const relevant = text.split("\n").filter((line) => /auth-storage|EPERM|EACCES|credential/i.test(line));
      return tail(relevant.join("\n"), 20);
    } catch {
      // This vendor has no such log file, try the next
    }
  }
  return undefined;
}

export async function collectAccessDiagnostics(kind: AgentKind, execute: Run = run, home = os.homedir()): Promise<Record<string, unknown>> {
  const directory = configDirectory(kind, home);
  const [listing, auth, identity, extensions, denials, vendorLog] = await Promise.all([
    execute("/bin/ls", ["-laeO@", directory], 5000),
    execute("/bin/ls", ["-laeO@", path.join(directory, ".auth")], 5000),
    execute("/usr/bin/id", [], 5000),
    execute("/usr/bin/systemextensionsctl", ["list"], 10_000),
    execute("/usr/bin/log", ["show", "--last", "3m", "--style", "compact", "--predicate",
      `eventMessage CONTAINS "${path.basename(directory)}" AND (eventMessage CONTAINS[c] "deny" OR eventMessage CONTAINS "EPERM" OR eventMessage CONTAINS[c] "not permitted")`], 20_000),
    vendorLogLines(directory)
  ]);
  return {
    kind,
    directory,
    listing: tail(listing, 40),
    auth: tail(auth, 20),
    identity,
    extensions: tail(extensions, 30),
    denials: tail(denials, 30),
    ...(vendorLog ? { vendorLog } : {})
  };
}
