import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Post-update health record, used for rollback.
 *
 * Rule (docs/ota-design.md section 4): if a new version installed via OTA is gone within
 * 60 seconds on two consecutive launches (crashed or force-quit), prompt to roll back to the previous version on the next launch.
 * A normal quit also counts as healthy, so "open, glance, close" isn't mistaken for a crash.
 */

export const HEALTHY_AFTER_MS = 60_000;

interface Launch {
  at: string;
  healthy: boolean;
}

export interface HealthFile {
  /** The version installed via OTA, and the version before it */
  installed?: { version: string; sha256: string; previous: string; at: string };
  version?: string;
  launches: Launch[];
  /** Versions that were rolled back (version@sha256); skipped when checking for updates so they aren't installed again */
  rejected: string[];
}

export class UpdateHealth {
  private data: HealthFile = { launches: [], rejected: [] };
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "health.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<HealthFile>;
      this.data = {
        ...(parsed.installed ? { installed: parsed.installed } : {}),
        ...(parsed.version ? { version: parsed.version } : {}),
        launches: Array.isArray(parsed.launches) ? parsed.launches.slice(-10) : [],
        rejected: Array.isArray(parsed.rejected) ? parsed.rejected.slice(-20) : []
      };
    } catch {
      this.data = { launches: [], rejected: [] };
    }
  }

  /**
   * Record a launch and return whether a rollback prompt is due before this launch.
   * Only this OTA-installed version's own record counts; the count restarts when the version changes.
   */
  async recordLaunch(
    version: string,
    now = new Date()
  ): Promise<{ offerRollback: boolean; previous?: string; rejectKey?: string }> {
    if (this.data.version !== version) {
      this.data.version = version;
      this.data.launches = [];
    }
    const recent = this.data.launches.slice(-2);
    const crashedTwice = recent.length === 2 && recent.every((launch) => !launch.healthy);
    const installed = this.data.installed?.version === version ? this.data.installed : undefined;
    this.data.launches.push({ at: now.toISOString(), healthy: false });
    await this.save();
    return installed && crashedTwice
      ? { offerRollback: true, previous: installed.previous, rejectKey: releaseKey(installed) }
      : { offerRollback: false };
  }

  async markHealthy(): Promise<void> {
    const last = this.data.launches.at(-1);
    if (!last || last.healthy) return;
    last.healthy = true;
    await this.save();
  }

  /** Whether the current version has run healthily once (ran a full 60 seconds or quit normally) */
  hasHealthyLaunch(): boolean {
    return this.data.launches.some((launch) => launch.healthy);
  }

  async markInstalled(
    update: { version: string; sha256: string },
    previous: string,
    now = new Date()
  ): Promise<void> {
    this.data.installed = { version: update.version, sha256: update.sha256, previous, at: now.toISOString() };
    await this.save();
  }

  /** After rollback: this version is no longer downloaded automatically; counts are reset so the older version doesn't inherit the newer version's crash record */
  async reject(key: string): Promise<void> {
    if (!this.data.rejected.includes(key)) this.data.rejected.push(key);
    this.data.launches = [];
    this.data.version = undefined;
    this.data.installed = undefined;
    await this.save();
  }

  isRejected(key: string): boolean {
    return this.data.rejected.includes(key);
  }

  snapshot(): HealthFile {
    return JSON.parse(JSON.stringify(this.data)) as HealthFile;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(temp, this.file);
  }
}

export const releaseKey = (update: { version: string; sha256: string }) => `${update.version}@${update.sha256}`;
