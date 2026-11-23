import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { removeTree } from "../platform/remove-tree";
import { compareVersions, isValidVersion } from "./version";
import { cloudErrorText, tm } from "../i18n";
import { describeError } from "../orchestration/diagnostics";

/**
 * Client-side update check (gray release by account / computer; the decision is made on the server).
 *
 * This version only goes as far as: check → download → verify sha256 → tell the UI "ready".
 * Installation is still done by the user opening the installer; Squirrel auto-replacement needs a signing certificate, see docs/ota-design.md.
 *
 * Failures never bother the user: an unreachable server isn't the user's problem, so just log it and retry next time.
 */

export const UPDATE_CHECK_ROUTE = "/api/v1/app/updates/check";

/** Wait a while after launch before checking, to avoid the agent detection peak */
export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Size limit for the installer, so a server-side data error can't fill up the disk */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

export type UpdateInfo = AppUpdateInfo;

/** Same structure as the AppUpdateState used by the UI in shared/domain.d.ts */
export type UpdateState = AppUpdateState;

export interface UpdateCheckBody {
  /** Always mac for the desktop app; ios for the mobile app */
  platform: "mac";
  channel: string;
  arch: string;
  currentVersion: string;
  machineId?: string;
}

/** detail goes to the log only: the full reason including the cause chain; message is what the UI shows */
export type CheckResult = { ok: true; data: unknown } | { ok: false; message: string; detail?: string };

export interface DownloadResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}

export interface AppUpdaterOptions {
  channel: string;
  arch: string;
  currentVersion: string;
  /** Download directory, usually userData/updates */
  directory: string;
  /** This computer's identifier (same value as terminals.fingerprint); undefined when it can't be read */
  machineId: () => Promise<string | undefined>;
  /** Call the check API. Sends the token when logged in (refreshing it automatically); anonymous when logged out */
  request: (body: UpdateCheckBody) => Promise<CheckResult>;
  download?: (url: string, signal: AbortSignal) => Promise<DownloadResponse>;
  /** Rolled-back versions are no longer downloaded automatically */
  isRejected?: (update: UpdateInfo) => boolean;
  onState?: (state: UpdateState) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
  now?: () => Date;
}

export class AppUpdater {
  private current: UpdateState = { phase: "idle" };
  private inFlight?: Promise<UpdateState>;
  private timer?: NodeJS.Timeout;
  private abort?: AbortController;

  constructor(private readonly options: AppUpdaterOptions) {}

  state(): UpdateState {
    return this.current;
  }

  /** Delayed first check, then periodic checks. Repeated calls don't stack timers */
  start(firstDelayMs = FIRST_CHECK_DELAY_MS, intervalMs = CHECK_INTERVAL_MS): void {
    this.stop();
    const tick = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.check().finally(() => tick(intervalMs));
      }, delay);
      this.timer.unref?.();
    };
    tick(firstDelayMs);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
  }

  /** Runs only one at a time; an already downloaded version isn't downloaded again */
  check(): Promise<UpdateState> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<UpdateState> {
    const previous = this.current;
    if (previous.phase !== "ready") this.set({ phase: "checking" });
    const machineId = await this.options.machineId().catch(() => undefined);
    const body: UpdateCheckBody = {
      platform: "mac",
      channel: this.options.channel,
      arch: this.options.arch,
      currentVersion: this.options.currentVersion,
      ...(machineId ? { machineId } : {})
    };
    // Log the machineId: when adding a standalone install to the gray list, it can be taken from the logs attached to issue reports
    this.log("update-check", { ...body });

    const result: CheckResult = await this.options.request(body).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
      detail: describeError(error)
    }));
    if (!result.ok) return this.fail(previous, tm("svc.update.checkFailed", { message: result.message }), result.detail);

    let update: UpdateInfo | null;
    try {
      update = parseCheckResponse(result.data, this.options.currentVersion);
    } catch (error) {
      return this.fail(previous, error instanceof Error ? error.message : String(error));
    }
    if (update && this.options.isRejected?.(update)) {
      this.log("update-skipped-rejected", { version: update.version });
      update = null;
    }
    if (!update) {
      // When a gray release is withdrawn or a version is pulled, an already downloaded package must not be kept around for installation
      await this.removeOtherVersions("");
      this.log("update-none", {});
      return this.set({ phase: "up-to-date", checkedAt: this.stamp() });
    }
    // After the list changes, a higher version may disappear or be replaced by another: trust only the one the server returns this time
    if (previous.phase === "ready" && previous.update.version === update.version
        && previous.update.sha256 === update.sha256) {
      return this.set({ ...previous, update, checkedAt: this.stamp() });
    }
    this.log("update-available", {
      version: update.version, gray: update.gray, signed: update.signed, mandatory: update.mandatory,
      requiredVersion: update.requiredVersion
    });
    try {
      const file = await this.fetchPackage(update);
      this.log("update-ready", { version: update.version, file });
      return this.set({ phase: "ready", update, file, checkedAt: this.stamp() });
    } catch (error) {
      return this.fail(previous, tm("svc.update.downloadFailed", { message: error instanceof Error ? error.message : String(error) }), describeError(error));
    }
  }

  private async fetchPackage(update: UpdateInfo): Promise<string> {
    const dir = path.join(this.options.directory, safeSegment(update.version));
    const file = path.join(dir, packageFileName(update));
    await this.removeOtherVersions(path.basename(dir));
    await mkdir(dir, { recursive: true });

    if (await fileExists(file)) {
      if ((await sha256File(file)) === update.sha256) return file;
      await rm(file, { force: true });
    }

    const download = this.options.download ?? defaultDownload;
    const partial = `${file}.part`;
    this.abort = new AbortController();
    const response = await download(update.url, this.abort.signal);
    if (!response.ok || !response.body) throw new Error(tm("svc.update.serverStatus", { status: response.status }));
    const declared = Number(response.headers.get("content-length") ?? "");
    const total = Number.isFinite(declared) && declared > 0 ? declared : update.sizeBytes;
    if (total && total > MAX_DOWNLOAD_BYTES) throw new Error(tm("svc.update.sizeAbnormal"));

    const hash = createHash("sha256");
    const handle = await open(partial, "w");
    let received = 0;
    let lastReport = 0;
    try {
      this.set({ phase: "downloading", update, receivedBytes: 0, totalBytes: total });
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) throw new Error(tm("svc.update.sizeAbnormal"));
        hash.update(chunk);
        await handle.write(chunk);
        // Report progress at most once per 1 MB so the UI isn't flooded
        if (received - lastReport >= 1024 * 1024) {
          lastReport = received;
          this.set({ phase: "downloading", update, receivedBytes: received, totalBytes: total });
        }
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(partial, { force: true });
      throw error;
    }
    await handle.close();

    // This step can't be skipped: the checksum is the only way to confirm "what we downloaded is exactly what we published"
    const actual = hash.digest("hex");
    if (actual !== update.sha256) {
      await rm(partial, { force: true });
      throw new Error(tm("svc.update.checksumMismatch", { expected: update.sha256.slice(0, 12), actual: actual.slice(0, 12) }));
    }
    await rename(partial, file);
    return file;
  }

  /** Keep only the current version under updates/, so gray and rolled-back versions don't pile up */
  private async removeOtherVersions(keep: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.options.directory);
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((name) => name !== keep)
      .map((name) => removeTree(path.join(this.options.directory, name))));
  }

  /** When a check fails, an already downloaded version stays valid; one network glitch must not lose the "ready" state */
  private fail(previous: UpdateState, message: string, detail?: string): UpdateState {
    this.log("update-check-failed", detail && detail !== message ? { message, detail } : { message });
    if (previous.phase === "ready") return this.set(previous);
    return this.set({ phase: "error", message, checkedAt: this.stamp() });
  }

  private set(state: UpdateState): UpdateState {
    this.current = state;
    this.options.onState?.(state);
    return state;
  }

  private stamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private log(event: string, data: Record<string, unknown>): void {
    try {
      this.options.log?.(event, data);
    } catch {
      // Logging failures don't affect the update
    }
  }
}

/** Server responses aren't trusted: validate each field and don't download if any is wrong */
export function parseCheckResponse(data: unknown, currentVersion: string): UpdateInfo | null {
  if (!data || typeof data !== "object") throw new Error(tm("svc.update.badResponse"));
  const payload = data as { available?: unknown; update?: unknown };
  if (payload.available !== true) return null;
  const u = payload.update as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") throw new Error(tm("svc.update.badResponse"));

  const version = typeof u.version === "string" ? u.version.trim() : "";
  if (!isValidVersion(version)) throw new Error(tm("svc.update.badVersion"));
  // The server already compared versions; check again here: never "upgrade" to a lower or equal version
  if (!isValidVersion(currentVersion) || compareVersions(version, currentVersion) <= 0) return null;

  const url = typeof u.url === "string" ? u.url : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(tm("svc.update.badUrl"));
  }
  if (parsed.protocol !== "https:") throw new Error(tm("svc.update.httpsRequired"));

  const sha256 = typeof u.sha256 === "string" ? u.sha256.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(tm("svc.update.badChecksum"));

  const sizeBytes = typeof u.sizeBytes === "number" && u.sizeBytes > 0 ? u.sizeBytes : undefined;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  return {
    version,
    url: parsed.toString(),
    sha256,
    signed: u.signed === true,
    mandatory: u.mandatory === true,
    ...(u.mandatory === true && typeof u.requiredVersion === "string" && isValidVersion(u.requiredVersion.trim())
      ? { requiredVersion: u.requiredVersion.trim() } : {}),
    fullPackageRequired: u.fullPackageRequired === true,
    gray: u.gray === true,
    ...(sizeBytes ? { sizeBytes } : {}),
    ...(text(u.teamId) ? { teamId: text(u.teamId) } : {}),
    ...(text(u.notes) ? { notes: text(u.notes) } : {}),
    ...(text(u.releasedAt) ? { releasedAt: text(u.releasedAt) } : {})
  };
}

/** When logged out, call the API directly; when logged in, AccountSession.api handles sending and refreshing the token */
export async function postAnonymous(
  baseUrl: string,
  body: UpdateCheckBody,
  timeoutMs = 10_000
): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${UPDATE_CHECK_ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => undefined) as
      { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (payload?.code === "OK") return { ok: true, data: payload.data };
    // The server message is English only; show the UI-language text for known codes
    const message = cloudErrorText(payload?.code) ?? (typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`);
    return { ok: false, message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), detail: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultDownload(url: string, signal: AbortSignal): Promise<DownloadResponse> {
  const response = await fetch(url, { signal });
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: response.body as unknown as AsyncIterable<Uint8Array> | null
  };
}

function packageFileName(update: UpdateInfo): string {
  const raw = path.posix.basename(new URL(update.url).pathname);
  let fromUrl = raw;
  try {
    fromUrl = decodeURIComponent(raw);
  } catch {
    // If the encoding is invalid, use it as-is; it gets sanitized below anyway
  }
  const name = safeSegment(fromUrl);
  return name && name !== "." && name !== ".." ? name : `ADing-${safeSegment(update.version)}.dmg`;
}

function safeSegment(text: string): string {
  return text.replace(/[^0-9A-Za-z._+-]/g, "_");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
