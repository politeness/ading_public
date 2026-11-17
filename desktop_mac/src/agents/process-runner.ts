import { spawn, type ChildProcess } from "node:child_process";
import { p } from "../prompt-language";

/**
 * Runs a CLI agent child process.
 *
 * The agents (codex / claude-code / qoder / qoder-cn) differ only in command-line arguments and output format;
 * the process layer is identical: feed lines to a parser, kill when idle too long, kill when output is too large,
 * SIGTERM then SIGKILL on cancel, and hand over whatever was received no matter how it ends.
 *
 * Before extraction this lived in codex.ts, and a second adapter would have meant copying it —
 * and every copy of "timeout and cancel" code forks, with fixes made on one side and forgotten on the other.
 */

/** No output for longer than this is considered stuck */
export const INACTIVITY_TIMEOUT_MS = 10 * 60_000;
/** Kill when stdout exceeds this, so a runaway run can't exhaust memory */
export const MAX_STDOUT_BYTES = 20 * 1024 * 1024;

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Non-empty means this turn failed; the content is the human-readable reason */
  failure: string;
  cancelled: boolean;
}

export interface RunOptions {
  /** A parent can be quiet while its supervised children are still working. */
  hasPendingWork?: ()=>boolean;
  /** Overrides INACTIVITY_TIMEOUT_MS. Exists so the watchdog is testable. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  executablePath: string;
  args: string[];
  cwd: string;
  /** Inherits ADing's environment when omitted; specific adapters can isolate host-specific variables here. */
  env?: NodeJS.ProcessEnv;
  /** Human-readable name, used in timeout and exit code error messages */
  label: string;
  /** Readiness probes may run in parallel after launch without competing with the UI. */
  backgroundPriority?: boolean;
  /**
   * Hard limit for the whole turn. Without it only the idle timeout is the fallback —
   * which is 10 minutes, too long for a connectivity check: a person on the page can't wait that long.
   */
  timeoutMs?: number;
  /** Called once per complete stdout line. Parsing, progress and counting hook in here */
  onLine: (line: string) => void;
  /** Bidirectional control protocol; writes only to its own child process, never other CLIs. */
  onStart?: (channel: ProcessChannel) => void;
  /** Streaming protocols keep only events needed for final parsing; images and tool results aren't accumulated in memory. */
  retainLine?: (line: string) => string | undefined;
  /** Sign-in links, install progress etc. often go to stderr; pass them through line by line when needed. */
  onStderrLine?: (line: string) => void;
}

export interface ProcessChannel {
  /** Returns false only when the owned process can no longer accept input. */
  write(value: unknown): boolean;
  end(): void;
  waitingForApproval(waiting: boolean): void;
}

/**
 * Registry enforcing "one turn at a time per agent" on a machine.
 * Each adapter holds one instance — different agents don't affect each other and can run in parallel.
 */
export class ProcessRunner {
  private readonly running = new Map<string, ChildProcess>();
  private readonly cancelled = new Set<string>();

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
    }
  }

  isBusy(localUuid: string): boolean {
    return this.running.has(localUuid);
  }

  busyIds(): string[] {
    return [...this.running.keys()];
  }

  /**
   * Waits until all child processes have actually exited, returning those still lingering at the deadline.
   *
   * Entries in running are deleted in the child's close event, so it being empty means
   * the process group has been reaped by the kernel — more reliable than blindly waiting a fixed time: returns at once if processes exit quickly,
   * and won't close the app before slow ones have fully exited.
   */
  async waitForExit(timeoutMs: number, pollMs = 50): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return [...this.running.keys()];
  }

  cancel(localUuid: string): boolean {
    const child = this.running.get(localUuid);
    if (!child) return false;
    this.cancelled.add(localUuid);
    this.signal(child, "SIGTERM");
    // Give it 3 seconds to exit gracefully, then SIGKILL
    setTimeout(() => {
      this.signal(child, "SIGKILL");
    }, 3000);
    return true;
  }

  run(localUuid: string, options: RunOptions): Promise<RunResult> {
    if (options.signal?.aborted) {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: null, signal: null, failure: p("任务已停止", "The task was stopped"), cancelled: true });
    }
    if (this.running.has(localUuid)) {
      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        failure: p(`${options.label} 已经在进行中`, `${options.label} is already in progress`),
        cancelled: false
      });
    }
    return new Promise((resolve) => {
      const lowerPriority = options.backgroundPriority && process.platform !== "win32";
      const child = spawn(lowerPriority ? "/usr/bin/nice" : options.executablePath, lowerPriority
        ? ["-n", "10", options.executablePath, ...options.args]
        : options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: [options.onStart ? "pipe" : "ignore", "pipe", "pipe"]
      });
      this.running.set(localUuid, child);
      const abort = (): void => { this.cancel(localUuid); };
      options.signal?.addEventListener("abort", abort, { once: true });

      let stdout = "";
      let stderr = "";
      let buffer = "";
      let stderrBuffer = "";
      let failure = "";
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let settled = false;
      let waitingForApproval = false;
      let idleTimer: NodeJS.Timeout;
      let hardTimer: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const terminate = (): void => {
        this.signal(child, "SIGTERM");
        clearTimeout(forceKillTimer);
        forceKillTimer = setTimeout(() => {
          this.signal(child, "SIGKILL");
        }, 3000);
      };

      const idleAfter = options.idleTimeoutMs ?? INACTIVITY_TIMEOUT_MS;
      // Waiting on an approval or on supervised children is not inactivity, but it
      // must not disarm the watchdog either: nothing calls touch() again when that
      // wait ends without output, so skipping the timer here left a stalled child
      // running forever. Re-check on the same interval instead.
      const check = (): void => {
        if (settled) return;
        if (waitingForApproval || options.hasPendingWork?.()) {
          idleTimer = setTimeout(check, idleAfter);
          return;
        }
        failure = p(`${options.label} 长时间没有任何进度`, `${options.label} made no progress for a long time`);
        terminate();
      };
      const touch = (): void => {
        clearTimeout(idleTimer);
        if (settled) return;
        idleTimer = setTimeout(check, idleAfter);
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        // Keep the forced cancel even if the parent exits first, to clean up leftover descendants in the group.
        this.running.delete(localUuid);
        const wasCancelled = this.cancelled.delete(localUuid);
        resolve({
          stdout,
          stderr,
          exitCode,
          signal: exitSignal,
          failure,
          cancelled: wasCancelled
        });
      };

      touch();
      if (options.timeoutMs !== undefined) {
        hardTimer = setTimeout(() => {
          failure = p(`${options.label} 超过 ${Math.max(1, Math.round(options.timeoutMs! / 1000))} 秒还没结束`, `${options.label} timed out after ${Math.max(1, Math.round(options.timeoutMs! / 1000))} seconds without finishing`);
          terminate();
        }, options.timeoutMs);
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        touch();
        if (!options.retainLine) stdout += chunk;
        buffer += chunk;
        const lines = buffer.split("\n");
        // The last piece may be a partial line; keep it to join with the next chunk
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          options.onLine(line);
          const retained = options.retainLine?.(line);
          if (retained) stdout += retained + "\n";
        }
        if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES || Buffer.byteLength(buffer) > 64 * 1024 * 1024) {
          failure = p(`${options.label} 回复数据过大`, `${options.label}'s reply data is too large`);
          terminate();
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        touch();
        if (stderr.length < 1024 * 1024) stderr += chunk;
        if (options.onStderrLine) {
          stderrBuffer += chunk;
          const lines = stderrBuffer.split("\n");
          stderrBuffer = lines.pop() ?? "";
          for (const line of lines) options.onStderrLine(line);
        }
      });
      child.on("error", (error) => {
        failure = failure || error.message;
        finish();
      });
      child.stdin?.on("error", (error) => {
        if (!settled && !child.stdin?.writableEnded && !this.cancelled.has(localUuid)) {
          failure = p(`控制通道中断：${error.message}`, `Control channel interrupted: ${error.message}`);
          terminate();
        }
      });
      options.onStart?.({
        write: value => {
          if (settled || child.stdin?.destroyed || child.stdin?.writableEnded) return false;
          child.stdin?.write(JSON.stringify(value) + "\n");
          return true;
        },
        end: () => { if (!child.stdin?.destroyed) child.stdin?.end(); },
        waitingForApproval: waiting => { waitingForApproval = waiting; touch(); }
      });
      child.on("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        // Feed the final partial line too, or the last event (often the result itself) would be lost
        if (buffer.trim()) {
          options.onLine(buffer);
          const retained = options.retainLine?.(buffer);
          if (retained) stdout += retained + "\n";
        }
        if (stderrBuffer.trim()) options.onStderrLine?.(stderrBuffer);
        if (!failure && code !== 0 && !this.cancelled.has(localUuid)) {
          failure = stderr.trim() || p(`${options.label} 进程退出，状态码：${code}`, `${options.label} process exited with code ${code}`);
        }
        finish();
      });
    });
  }
}
