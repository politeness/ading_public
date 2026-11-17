/**
 * Device telemetry: reported while the window is in the foreground, at most once per hour. Nothing is reported when running in the background or with no window open; ops console DAU is computed from this.
 *
 * The backend inserts on first device_uuid (computer identifier) and updates afterwards; user_id comes from the request token, never self-reported by the client.
 * Standalone mode (not signed in) also reports; phone and email come from the profile, omitted if empty. City is inferred by the backend from the IP.
 */
import { describeError } from "../orchestration/diagnostics";

/** The old background /telemetry/startup report is no longer accepted; the two kinds of reports must not be mixed into one metric */
export const TELEMETRY_ROUTE = "/api/v1/telemetry/foreground";

export interface TelemetryBody {
  deviceUuid: string;
  deviceType: string;
  phone?: string;
  email?: string;
  /** Agent types detected as available */
  agents: string[];
  appVersion?: string;
  osVersion?: string;
}

export function buildTelemetryBody(input: {
  fingerprint: string;
  platform: NodeJS.Platform;
  phone?: string;
  email?: string;
  readyAgents: string[];
  appVersion?: string;
  osVersion?: string;
}): TelemetryBody {
  const text = (value?: string) => (value && value.trim() ? value.trim() : undefined);
  return {
    deviceUuid: input.fingerprint,
    deviceType: input.platform === "darwin" ? "mac" : input.platform === "win32" ? "windows" : input.platform,
    ...(text(input.phone) ? { phone: text(input.phone) } : {}),
    ...(text(input.email) ? { email: text(input.email) } : {}),
    agents: [...new Set(input.readyAgents)].sort(),
    ...(text(input.appVersion) ? { appVersion: text(input.appVersion) } : {}),
    ...(text(input.osVersion) ? { osVersion: text(input.osVersion) } : {})
  };
}

/** Logs don't record phone or email contents, only whether they're present */
export function describeTelemetry(body: TelemetryBody): Record<string, unknown> {
  return { deviceUuid: body.deviceUuid, deviceType: body.deviceType, phone: !!body.phone, email: !!body.email, agents: body.agents };
}

export type TelemetryResult = { ok: true } | { ok: false; message: string };

/** Anonymous report when not signed in */
export async function postTelemetryAnonymously(baseUrl: string, body: TelemetryBody, timeoutMs = 10_000): Promise<TelemetryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${TELEMETRY_ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => undefined) as { code?: unknown; message?: unknown } | undefined;
    if (payload?.code === "OK") return { ok: true };
    return { ok: false, message: typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Local hour, like 2026-10-30T14. Compares local time only, unaffected by timezone offset */
export function localHour(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}`;
}

export interface ForegroundTelemetryOptions {
  /** Whether the window is currently in the foreground and in use */
  foreground(): boolean;
  /** Send one report. reason goes only into logs: ready, focus, interval */
  send(reason: string): Promise<TelemetryResult>;
  /** Check interval while staying in the foreground, default 5 minutes */
  intervalMs?: number;
  /** Injected clock, for tests */
  now?: () => Date;
}

/**
 * Foreground reporting: report once when the window comes to the foreground, and once more each hour while it stays there.
 *
 * The check is "current hour != hour of last successful report", not a timer firing on the hour —
 * timers don't run while macOS sleeps; with an idempotent comparison, returning to the foreground or the next check catches up.
 * On failure the hour isn't recorded, so the next check retries.
 */
export class ForegroundTelemetry {
  private lastHour: string | undefined;
  private ready = false;
  private running: Promise<TelemetryResult> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: ForegroundTelemetryOptions) {}

  /** Local hour of the last successful report; undefined if never succeeded */
  get reportedHour(): string | undefined {
    return this.lastHour;
  }

  /** Start reporting only after startup Agent detection finishes, otherwise the first report has no available Agents */
  markReady(): void {
    this.ready = true;
    this.check("ready");
  }

  /** Both foreground events and periodic checks go through here: skip if not in the foreground or already reported this hour */
  check(reason: string): void {
    if (!this.ready || !this.options.foreground() || localHour(this.current()) === this.lastHour) return;
    void this.report(reason);
  }

  /** Actually send once; only one in flight at a time */
  private report(reason: string): Promise<TelemetryResult> {
    this.running ??= (async (): Promise<TelemetryResult> => {
      const hour = localHour(this.current());
      try {
        const result = await this.options.send(reason);
        if (result.ok) this.lastHour = hour;
        return result;
      } catch (error) {
        return { ok: false, message: describeError(error) };
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check("interval"), this.options.intervalMs ?? 300_000);
    this.timer.unref?.();
  }

  dispose(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private current(): Date {
    return this.options.now?.() ?? new Date();
  }
}
