import type { InstallProgress } from "./download-progress";
import { installNativeCli } from "./native-install";
import { KiroAdapter, CopilotAdapter } from "./acp-providers";
import { AntigravityAdapter } from "./antigravity";
import { ProcessRunner, type RunOptions, type RunResult } from "./process-runner";
import { log } from "../orchestration/diagnostics";
import { deniedPaths, lifecycleDoneDetail, lifecycleStartDetail, probeDeniedPath } from "./lifecycle-diagnostics";
import { access, lstat, readdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { codexChildEnvironment } from "./codex-environment";
import { tm } from "../i18n";
import { p } from "../prompt-language";
import { qwenProbeArgs } from "./qwen";
import { parseStreamJson } from "./stream-json";
import { looksUnauthorized } from "./readiness";
import { handshakeCommand, withHandshakeDirectory } from "./handshake";

interface LifecycleSpec {
  packageName: string;
  nativeInstall?: "kiro" | "antigravity";
  interactiveLoginMessage?: () => string;
  statusArgs: string[];
  loginArgs: string[];
  interactiveLoginOnly?: boolean;
  logoutArgs?: string[];
}

const INSTALL_BIN_NAMES: Record<AgentKind, string[]> = {
  codex: ["codex"],
  "claude-code": ["claude"],
  qoder: ["qodercli"],
  "qoder-cn": ["qodercn", "qoderclicn"],
  "qwen-code": ["qwen"],
  kiro: ["kiro-cli"], copilot: ["copilot"], antigravity: ["agy"]
};

/**
 * Only vendor-supported public commands; never read credential files or guess sign-in state.
 * Installation prefers the official CLI, using npm or verified native release packages; never curl | shell.
 */
export const AGENT_LIFECYCLE_SPECS: Record<AgentKind, LifecycleSpec> = {
  kiro: { packageName: "Kiro", nativeInstall: "kiro", statusArgs: ["whoami"], loginArgs: ["login", "--use-device-flow"], logoutArgs: ["logout"] },
  copilot: { packageName: "@github/copilot", statusArgs: [], loginArgs: ["login", "--device-code"] },
  antigravity: { packageName: "Antigravity", nativeInstall: "antigravity", statusArgs: [], loginArgs: [], interactiveLoginOnly: true,
    interactiveLoginMessage: () => p("请在终端运行 agy 完成登录，再回到阿钉点击检测。", "Run agy in Terminal to sign in, then return to ADing and click Check.") },
  codex: {
    packageName: "@openai/codex",
    statusArgs: ["login", "status"],
    loginArgs: ["login", "--device-auth"],
    logoutArgs: ["logout"]
  },
  "claude-code": {
    packageName: "@anthropic-ai/claude-code",
    statusArgs: ["auth", "status"],
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"]
  },
  qoder: {
    packageName: "@qoder-ai/qodercli",
    statusArgs: ["status", "-o", "json"],
    loginArgs: ["login"]
    // Qoder 1.1.41 only has interactive /logout, with no safely callable logout subcommand.
  },
  "qoder-cn": {
    packageName: "@qodercn-ai/qoderclicn",
    statusArgs: ["status", "-o", "json"],
    loginArgs: ["login"]
  },
  "qwen-code": {
    packageName: "@qwen-code/qwen-code",
    statusArgs: [], // Uses the restricted, localized probe below; no auth status command exists.
    loginArgs: [],
    interactiveLoginOnly: true
  }
};

function firstUsefulLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? tm("svc.agent.noOutput")
  ).slice(0, 500);
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Vendor status command output → ADing's unified sign-in state. */
export function parseAgentAuthStatus(
  kind: AgentKind,
  stdout: string,
  stderr = ""
): AgentAuthStatus {
  const combined = `${stdout}\n${stderr}`.trim();
  if (kind === "qwen-code") {
    const parsed = parseStreamJson(stdout);
    if (!stderr && parsed.message && !parsed.error) return { kind, state: "signed-in", detail: tm("svc.agent.signedIn", { name: "Qwen Code" }) };
    const detail = parsed.error || stderr || combined;
    return { kind, state: looksUnauthorized(detail) ? "signed-out" : "unknown", detail: firstUsefulLine(detail) };
  }
  if (kind === "claude-code") {
    const parsed = jsonObject(combined);
    if (typeof parsed?.loggedIn === "boolean") {
      return {
        kind,
        state: parsed.loggedIn ? "signed-in" : "signed-out",
        detail: parsed.loggedIn ? tm("svc.agent.signedIn", { name: "Claude Code" }) : tm("svc.agent.signedOut", { name: "Claude Code" })
      };
    }
  }
  if (kind === "qoder" || kind === "qoder-cn") {
    const parsed = jsonObject(combined);
    if (typeof parsed?.logged_in === "boolean") {
      return {
        kind,
        state: parsed.logged_in ? "signed-in" : "signed-out",
        detail: parsed.logged_in
          ? tm("svc.agent.signedIn", { name: kind === "qoder-cn" ? "Qoder CN" : "Qoder" })
          : tm("svc.agent.signedOut", { name: kind === "qoder-cn" ? "Qoder CN" : "Qoder" })
      };
    }
  }

  const normalized = combined.toLowerCase();
  if (/not\s+logged\s+in|not\s+signed\s+in|未登录|logged\s+out/.test(normalized)) {
    return {
      kind,
      state: "signed-out",
      detail: kind === "codex" ? tm("svc.agent.signedOut", { name: "Codex" }) : firstUsefulLine(combined)
    };
  }
  if (/logged\s+in|signed\s+in|已登录/.test(normalized)) {
    const evidence = combined
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /logged\s+in|signed\s+in|已登录/i.test(line));
    return { kind, state: "signed-in", detail: (evidence || firstUsefulLine(combined)).slice(0, 500) };
  }
  return { kind, state: "unknown", detail: firstUsefulLine(combined) };
}

function resultText(run: RunResult): string {
  return (run.stdout.trim() || run.stderr.trim() || run.failure || tm("svc.agent.noOutput")).slice(
    0,
    2000
  );
}

/**
 * Agent install and account lifecycle. There's no UI yet, but the testable capabilities are fully encapsulated first.
 * Every action that changes machine state requires the caller to pass confirmed=true explicitly.
 */
export class AgentLifecycleService {
  private readonly runner = new ProcessRunner();
  /** Copilot only lends its ACP launch flags; the probe runs in this.runner. */
  private readonly copilot = new CopilotAdapter();
  /** Antigravity has no status command. One owned instance keeps its probe
   * deduplicated, cancellable and included in the quit wait. */
  private readonly antigravity = new AntigravityAdapter();

  /**
   * All lifecycle operations run through here; start, end and "permission denied" context are written to last-run.log.
   * Previously failure reasons only appeared in the UI and couldn't be traced from user reports.
   */
  private async runLogged(kind: AgentKind, action: string, localUuid: string, options: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    await log("agent-lifecycle-start", await lifecycleStartDetail({
      kind, action, executablePath: options.executablePath, args: options.args, cwd: options.cwd, env: options.env
    }).catch(error => ({ kind, action, detailError: String(error) })));
    const run = await this.runner.run(localUuid, options);
    await log("agent-lifecycle-done", lifecycleDoneDetail(kind, action, run, startedAt));
    for (const denied of deniedPaths(`${run.failure ?? ""}\n${run.stdout}\n${run.stderr}`).slice(0, 3)) {
      await log("agent-lifecycle-denied-path", { kind, action, ...(await probeDeniedPath(denied)) });
    }
    return run;
  }

  constructor(
    private readonly npmExecutable?: string,
    private readonly installPrefix = path.join(homedir(), ".local")
  ) {}

  private progress(onProgress: (text: string) => void): (line: string) => void {
    return (line) => {
      const text = line.trim();
      if (text) onProgress(text.slice(0, 500));
    };
  }

  /** When the GUI launches from Finder PATH is very short, so `npm` can't be assumed to be found. */
  private async resolveNpmExecutable(): Promise<string | null> {
    if (this.npmExecutable) return this.npmExecutable;
    const pathCandidates = (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "npm"));
    const candidates = [
      ...pathCandidates,
      "/opt/homebrew/bin/npm",
      "/usr/local/bin/npm",
      path.join(homedir(), ".local", "bin", "npm")
    ];
    const nvmRoot = path.join(homedir(), ".nvm", "versions", "node");
    try {
      const versions = await readdir(nvmRoot);
      versions.sort().reverse();
      candidates.push(...versions.map((version) => path.join(nvmRoot, version, "bin", "npm")));
    } catch {
      // Not having nvm installed is normal.
    }
    for (const candidate of [...new Set(candidates)]) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking at the next candidate.
      }
    }
    return null;
  }

  /**
   * npm reports EEXIST on a dangling symlink with the same name and can't fix it itself.
   * Only remove symlinks whose target no longer exists and whose name truly belongs to the current Agent; never overwrite regular files.
   */
  private async removeBrokenInstallShims(
    kind: AgentKind,
    onProgress: (text: string) => void
  ): Promise<void> {
    for (const name of INSTALL_BIN_NAMES[kind]) {
      const candidate = path.join(this.installPrefix, "bin", name);
      try {
        const info = await lstat(candidate);
        if (!info.isSymbolicLink()) continue;
        try {
          await access(candidate, constants.X_OK);
        } catch {
          await unlink(candidate);
          onProgress(tm("svc.agent.removedBrokenShim", { name }));
        }
      } catch {
        // Missing or unreadable is left to npm, which returns a clear error.
      }
    }
  }

  async authStatus(agent: DiscoveredAgent): Promise<AgentAuthStatus> {
    const spec = AGENT_LIFECYCLE_SPECS[agent.kind];
    if (agent.kind === "kiro") {
      const run = await this.runLogged(agent.kind, "status", `lifecycle:${agent.kind}:status`, {
        executablePath: agent.executablePath, args: ["whoami", "--format", "json"], cwd: process.cwd(),
        label: agent.name, timeoutMs: 15_000, onLine: () => undefined
      });
      const detail = resultText(run);
      return { kind: agent.kind, state: !run.failure && !run.cancelled && run.exitCode === 0 && !!run.stdout.trim()
        ? "signed-in" : looksUnauthorized(detail) ? "signed-out" : "unknown", detail };
    }
    if (agent.kind === "copilot") {
      const result = await this.copilot.probeAuth(agent, options => this.runLogged(agent.kind, "status", `lifecycle:${agent.kind}:status`, options));
      return { kind: agent.kind, state: result.ok ? "signed-in" : looksUnauthorized(result.text) ? "signed-out" : "unknown", detail: result.text };
    }
    if (agent.kind === "antigravity") {
      const startedAt = Date.now();
      await log("agent-lifecycle-start", { kind: agent.kind, action: "status", transport: "native-adapter" });
      const result = await this.antigravity.verify(agent);
      await log("agent-lifecycle-done", { kind: agent.kind, action: "status", ok: result.ok, durationMs: Date.now() - startedAt });
      return { kind: agent.kind, state: result.ok ? "signed-in" : result.signedOut || looksUnauthorized(result.text) ? "signed-out" : "unknown", detail: result.text };
    }
    if (agent.kind === "qwen-code") return withHandshakeDirectory(agent.kind, async cwd => {
      const run = await this.runLogged(agent.kind, "status", `lifecycle:${agent.kind}:status`, {
        ...handshakeCommand(agent.executablePath, qwenProbeArgs()), cwd, label: agent.name,
        timeoutMs: 60_000, onLine: () => undefined
      });
      return parseAgentAuthStatus(agent.kind, run.stdout, run.failure || "");
    });
    const run = await this.runLogged(agent.kind, "status", `lifecycle:${agent.kind}:status`, {
      executablePath: agent.executablePath,
      args: spec.statusArgs,
      cwd: process.cwd(),
      env: agent.kind === "codex" ? codexChildEnvironment() : undefined,
      label: p(`${agent.name} 登录检测`, `${agent.name} login check`),
      timeoutMs: 15_000,
      onLine: () => undefined
    });
    return parseAgentAuthStatus(agent.kind, run.stdout, run.stderr || run.failure);
  }

  async install(
    kind: AgentKind,
    confirmed: boolean,
    onProgress: InstallProgress = () => undefined
  ): Promise<AgentLifecycleResult> {
    if (!confirmed) {
      return {
        kind,
        action: "install",
        ok: false,
        requiresUserAction: true,
        message: tm("svc.agent.installNeedsConfirm")
      };
    }
    const spec = AGENT_LIFECYCLE_SPECS[kind];
    if (spec.nativeInstall) {
      try {
        const message = await installNativeCli(spec.nativeInstall, this.installPrefix, (executablePath, args, timeoutMs) =>
          this.runLogged(kind, "install", `lifecycle:${kind}:install`, { executablePath, args, cwd: homedir(), label: spec.packageName,
            timeoutMs: timeoutMs ?? 10 * 60_000, idleTimeoutMs: timeoutMs,
            onLine: () => {} }), onProgress);
        return { kind, action: "install", ok: true, requiresUserAction: false, message };
      } catch (error) { return { kind, action: "install", ok: false, requiresUserAction: false, message: error instanceof Error ? error.message : String(error) }; }
    }
    const npmExecutable = await this.resolveNpmExecutable();
    if (!npmExecutable) {
      return {
        kind,
        action: "install",
        ok: false,
        requiresUserAction: true,
        message: tm("svc.agent.npmMissing")
      };
    }
    onProgress(tm("svc.agent.installing", { name: spec.packageName }));
    await this.removeBrokenInstallShims(kind, onProgress);
    // A desktop app may only find its own bundled npm. Global installs must still go to the user directory,
    // never modify the host app bundle, and never require sudo.
    const userPrefix = this.installPrefix;
    const run = await this.runLogged(kind, "install", `lifecycle:${kind}:install`, {
      executablePath: npmExecutable,
      args: ["install", "-g", "--prefix", userPrefix, spec.packageName],
      cwd: process.cwd(),
      label: p(`${kind} 安装`, `${kind} installation`),
      timeoutMs: 10 * 60_000,
      // npm has no aggregate byte total; keep its logs out of the progress UI.
      onLine: () => {},
      onStderrLine: () => {}
    });
    return {
      kind,
      action: "install",
      ok: !run.failure && !run.cancelled && run.exitCode === 0,
      requiresUserAction: false,
      message: run.failure || resultText(run)
    };
  }

  async login(
    agent: DiscoveredAgent,
    confirmed: boolean,
    onProgress: (text: string) => void = () => undefined
  ): Promise<AgentLifecycleResult> {
    if (!confirmed) {
      return {
        kind: agent.kind,
        action: "login",
        ok: false,
        requiresUserAction: true,
        message: tm("svc.agent.loginNeedsConfirm")
      };
    }
    const spec = AGENT_LIFECYCLE_SPECS[agent.kind];
    if (spec.interactiveLoginOnly) return {
      kind: agent.kind, action: "login", ok: false, requiresUserAction: true, unsupported: true,
      message: spec.interactiveLoginMessage?.() ?? p("请在终端运行 qwen，使用 /auth 配置模型服务；完成后回到阿钉点击检测。Qwen Code 当前版本不支持独立的登录命令。",
        "Run qwen in Terminal and use /auth to configure a model provider, then return to ADing and click Check. This Qwen Code version has no standalone login command.")
    };
    onProgress(tm("svc.agent.loginStarting", { name: agent.name }));
    const report = this.progress(onProgress);
    const run = await this.runLogged(agent.kind, "login", `lifecycle:${agent.kind}:login`, {
      executablePath: agent.executablePath,
      args: spec.loginArgs,
      cwd: process.cwd(),
      env: agent.kind === "codex" ? codexChildEnvironment() : undefined,
      label: p(`${agent.name} 登录`, `${agent.name} login`),
      timeoutMs: 10 * 60_000,
      onLine: report,
      onStderrLine: report
    });
    // Failed/cancelled authorization must not probe an old account. Copilot has
    // no status command; its successful login is followed by main's model check.
    const completed = !run.failure && !run.cancelled && run.exitCode === 0;
    const auth: AgentAuthStatus = !completed
      ? { kind: agent.kind, state: "unknown", detail: resultText(run) }
      : agent.kind === "copilot"
        ? { kind: agent.kind, state: "signed-in", detail: resultText(run) }
        : await this.authStatus(agent);
    return {
      kind: agent.kind,
      action: "login",
      ok: !run.failure && !run.cancelled && auth.state === "signed-in",
      requiresUserAction: !!run.failure || run.cancelled || auth.state !== "signed-in",
      message: run.failure || resultText(run),
      auth
    };
  }

  async logout(
    agent: DiscoveredAgent,
    confirmed: boolean,
    onProgress: (text: string) => void = () => undefined
  ): Promise<AgentLifecycleResult> {
    const spec = AGENT_LIFECYCLE_SPECS[agent.kind];
    if (!spec.logoutArgs) {
      return {
        kind: agent.kind,
        action: "logout",
        ok: false,
        requiresUserAction: true,
        unsupported: true,
        message: tm("svc.agent.logoutTerminalOnly", { name: agent.name })
      };
    }
    if (!confirmed) {
      return {
        kind: agent.kind,
        action: "logout",
        ok: false,
        requiresUserAction: true,
        message: tm("svc.agent.logoutNeedsConfirm")
      };
    }
    onProgress(tm("svc.agent.loggingOut", { name: agent.name }));
    const report = this.progress(onProgress);
    const run = await this.runLogged(agent.kind, "logout", `lifecycle:${agent.kind}:logout`, {
      executablePath: agent.executablePath,
      args: spec.logoutArgs,
      cwd: process.cwd(),
      env: agent.kind === "codex" ? codexChildEnvironment() : undefined,
      label: p(`${agent.name} 退出登录`, `${agent.name} logout`),
      timeoutMs: 30_000,
      onLine: report,
      onStderrLine: report
    });
    const auth = await this.authStatus(agent);
    return {
      kind: agent.kind,
      action: "logout",
      ok: auth.state === "signed-out",
      requiresUserAction: false,
      message: run.failure || resultText(run),
      auth
    };
  }

  cancel(kind: AgentKind, action: AgentLifecycleAction): boolean {
    return this.runner.cancel(`lifecycle:${kind}:${action}`);
  }

  cancelAll(): void {
    for(const id of this.runner.busyIds())this.runner.cancel(id);
    for(const id of this.antigravity.busyIds())this.antigravity.cancel(id);
  }

  async waitForExit(timeoutMs: number): Promise<string[]> {
    return (await Promise.all([this.runner.waitForExit(timeoutMs), this.antigravity.waitForExit(timeoutMs)])).flat();
  }
}
