import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Asking the CLI for its model list starts a process and is slow. The list isn't re-fetched within a day; a CLI upgrade may add models, so a version change also triggers a re-fetch */
export const AGENT_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry { fetchedAt: number; version?: string; models: AgentModelOption[] }

export class AgentModelCache {
  private loaded: Promise<Record<string, CacheEntry>> | undefined;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private entries(): Promise<Record<string, CacheEntry>> {
    return this.loaded ??= readFile(this.file, "utf8").then(raw => JSON.parse(raw) as Record<string, CacheEntry>).catch(() => ({}));
  }

  async get(userId: string, version: string | undefined): Promise<AgentModelOption[] | undefined> {
    const entry = (await this.entries())[userId];
    if (!entry || entry.version !== version) return undefined;
    const age = this.now() - entry.fetchedAt;
    return age >= 0 && age < AGENT_MODEL_CACHE_TTL_MS ? entry.models : undefined;
  }

  /** Model display name. Display-only, still used after the list expires */
  async label(userId: string, modelId: string): Promise<string | undefined> {
    return (await this.entries())[userId]?.models.find(model => model.id === modelId || model.label === modelId)?.label;
  }

  /** A failed file write only affects the next launch; the in-memory copy still works, so it doesn't block model selection */
  async set(userId: string, version: string | undefined, models: AgentModelOption[]): Promise<void> {
    const entries = await this.entries();
    entries[userId] = { fetchedAt: this.now(), version, models };
    const candidate = `${this.file}.${randomUUID()}.candidate`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(candidate, JSON.stringify(entries));
      await rename(candidate, this.file);
    } catch { /* see above */ }
    finally { await rm(candidate, { force: true }).catch(() => undefined); }
  }
}
