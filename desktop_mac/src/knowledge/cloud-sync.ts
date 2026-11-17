import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Store } from "../store/store";
import type { CloudApi } from "../store/cloud";
import { packageManifest, type PackageFile } from "./bundle-files";

/**
 * Cloud sync for the user's skills and memories. On OSS, skill/<userId>/<skillId>/ is the actual skill package directory,
 * and memory/<userId>/<memoryId>.json holds one object per entry.
 *
 * The comparison is three-way: local state, OSS state (etag) and the state after the last sync (baseline). Whichever side changed relative to the baseline is synced to the other;
 * if both changed, the newer by updatedAt wins, and the losing copy is kept locally in knowledge-cloud-conflicts/ rather than discarded.
 * Deletions write a tombstone instead of leaving nothing, otherwise other computers can't tell "deleted" from "not uploaded yet".
 * Pulled content goes through Store into the central library and emits change events, then KnowledgeService syncs it to each Agent; native directories aren't touched here.
 *
 * OSS uploads one file at a time, so skill package integrity relies on .ading-meta.json: it records the name, scope and each file's checksum, and is written last on upload.
 * Other computers only check whether it changed; after downloading they verify each checksum and, on mismatch, keep the local copy and pull again next round, so a half-uploaded version is never used.
 *
 * Multiple computers of the same user are queued by the backend: the whole sync round (read cloud, merge, upload) holds a lock; if it can't be acquired, try again a bit later.
 * On a crash or network loss the lock expires automatically; after expiry the backend rejects the former holder's writes, so that round stops and queues up again.
 */

export const KNOWLEDGE_PULL_INTERVAL_MS = 60 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 3000;
const URL_BATCH = 100;
const TRANSFER_CONCURRENCY = 8;
const TRANSFER_TIMEOUT_MS = 120_000;
const SCHEMA = 1;
const LOCK_LOST_CODE = "KNOW_004";
/** Renew several times within the validity period, so one or two network drops don't lose the lock */
const LOCK_RENEW_PER_TTL = 3;
const LOCK_RETRY_JITTER_MS = 5000;
const LOCK_LOST_RETRY_MS = 30_000;
export const META_FILE = ".ading-meta.json";

type Kind = "skill" | "memory";
const KINDS: Kind[] = ["skill", "memory"];

interface CloudDoc {
  schema: number;
  id: string;
  updatedAt: string;
  deleted?: boolean;
  skill?: Omit<Skill, "content" | "source" | "useCount" | "updatedAt">;
  files?: SkillPackageSource["files"];
  memory?: MemoryEntry;
}
interface LocalItem { hash: string; updatedAt: string; doc: CloudDoc; files?: PackageFile[]; directory?: string; scope?: string }
interface BaseItem { hash: string; etag: string }
type SyncState = Record<Kind, Record<string, BaseItem>>;

interface SignedUrls { uploads: Record<string, { url: string; contentType: string }>; downloads: Record<string, string>; deletes: Record<string, string> }

export interface KnowledgeTransport {
  upload(url: string, body: Uint8Array, contentType: string): Promise<string>;
  download(url: string): Promise<Buffer>;
  remove(url: string): Promise<void>;
}

export const fetchTransport: KnowledgeTransport = {
  async upload(url, body, contentType) {
    const response = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: body as unknown as BodyInit, signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`upload failed: HTTP ${response.status}`);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("upload failed: no ETag");
    return etag;
  },
  async download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
  async remove(url) {
    const response = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
    if (!response.ok && response.status !== 404) throw new Error(`delete failed: HTTP ${response.status}`);
  }
};

export interface KnowledgeCloudOptions {
  store: Pick<Store, "knowledgeRoot" | "exportKnowledge" | "applyCloudSkill" | "applyCloudMemory" | "deleteSkill" | "deleteMemory">;
  api: CloudApi;
  transport?: KnowledgeTransport;
  log: (event: string, data?: Record<string, unknown>) => unknown;
  /** Report at the end of each round: undefined means success; network loss and not logged in aren't reported, the next round retries automatically */
  onStatus?: (failure: string | undefined) => unknown;
  /** This round wrote cloud content locally: time to sync to each Agent. Called once per round, not per write */
  onPulled?: () => unknown;
  now?: () => string;
}

export class KnowledgeCloudSync {
  private running: Promise<void> | undefined;
  private rerun = false;
  private stopped = false;
  private pushTimer: NodeJS.Timeout | undefined;
  private pullTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private lock: { token: string; lost: boolean } | undefined;
  /** Cloud content is being written. Change events Store emits meanwhile are self-caused and needn't trigger another sync */
  private merging = false;
  private get transport(): KnowledgeTransport { return this.options.transport ?? fetchTransport; }
  private pulledThisRound = false;

  constructor(private readonly options: KnowledgeCloudOptions) {}

  /** Reconcile once when the data session opens, then check the cloud every hour */
  start(): void {
    void this.sync();
    this.pullTimer = setInterval(() => void this.sync(), KNOWLEDGE_PULL_INTERVAL_MS);
    this.pullTimer.unref?.();
  }

  /** Local knowledge changed: wait a few seconds before uploading so consecutive changes run only one round */
  schedule(): void {
    if (this.stopped || this.merging) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.sync(), PUSH_DEBOUNCE_MS);
    this.pushTimer.unref?.();
  }

  get applyingCloudChanges(): boolean { return this.merging; }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.pushTimer);
    clearInterval(this.pullTimer);
    clearTimeout(this.retryTimer);
    await this.running;
  }

  /** Only one round at a time; if changes arrive while running, run another round. Failures are only logged and retried on the next trigger or an hour later */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.rerun = true; return this.running; }
    this.running = (async () => {
      do {
        this.rerun = false;
        try { if (await this.syncOnce()) await this.options.onStatus?.(undefined); }
        catch (error) {
          await this.options.log("knowledge-cloud-sync-failed", { error: String(error) });
          if (isLockLost(error)) this.retryLater(LOCK_LOST_RETRY_MS);
          else if (!isOffline(error)) await this.options.onStatus?.(failureDetail(error));
        }
      } while (this.rerun && !this.stopped);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  private retryLater(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    // Add a bit of randomness so several computers don't collide at the same moment
    this.retryTimer = setTimeout(() => void this.sync(), delayMs + Math.random() * LOCK_RETRY_JITTER_MS);
    this.retryTimer.unref?.();
  }

  /** Acquire the lock, run a round while holding it, release it. If another computer is syncing, queue up; neither failure nor success, returns false */
  private async syncOnce(): Promise<boolean> {
    const granted = await this.call("POST", "/api/v1/knowledge/lock") as { granted: boolean; token?: string; ttlSeconds: number; retryAfterSeconds: number };
    if (!granted.granted || !granted.token) {
      await this.options.log("knowledge-cloud-lock-busy", { retryAfterSeconds: granted.retryAfterSeconds });
      this.retryLater(granted.retryAfterSeconds * 1000);
      return false;
    }
    const lock = this.lock = { token: granted.token, lost: false };
    const heartbeat = setInterval(() => void this.renewLock(lock), granted.ttlSeconds * 1000 / LOCK_RENEW_PER_TTL);
    heartbeat.unref?.();
    try { await this.syncLocked(); return true; }
    finally {
      clearInterval(heartbeat);
      this.lock = undefined;
      // Failing to release the lock is fine; it expires automatically
      await this.options.api("POST", "/api/v1/knowledge/lock/release", { token: lock.token }).catch(() => undefined);
    }
  }

  /** A network drop during renewal doesn't lose the lock: once the network is back it can still be used before expiry; after expiry the backend rejects writes */
  private async renewLock(lock: { token: string; lost: boolean }): Promise<void> {
    try {
      const result = await this.options.api("POST", "/api/v1/knowledge/lock/renew", { token: lock.token });
      if (result.ok && !(result.data as { held: boolean }).held) lock.lost = true;
    } catch { /* retry on the next heartbeat */ }
  }

  private ensureLock(): void {
    if (this.lock?.lost) throw new KnowledgeLockLost("knowledge sync lock lost");
  }

  private async syncLocked(): Promise<void> {
    const root = await this.options.store.knowledgeRoot();
    const state = await readState(root);
    const errors: unknown[] = [];
    this.pulledThisRound = false;
    for (const kind of KINDS) {
      try { await this.syncKind(kind, state, root, errors); }
      finally { await writeState(root, state); }
    }
    if (this.pulledThisRound) await this.options.onPulled?.();
    if (errors.length) throw new AggregateError(errors, errors.slice(0, 3).map(failureText).join("; "));
  }

  private async syncKind(kind: Kind, state: SyncState, root: string, errors: unknown[]): Promise<void> {
    const base = state[kind];
    const { heads, objects } = await this.listRemote(kind);
    const local = await this.localItems(kind);
    const pulls: string[] = [];
    // Not pulled this round: the cloud may be newer than local, so don't push over it without comparing; leave it for the next round
    const unmerged = new Set<string>();
    for (const id of new Set([...Object.keys(local), ...Object.keys(heads), ...Object.keys(base)])) {
      const etag = heads[id], known = base[id];
      if (etag === known?.etag) continue;
      if (etag) pulls.push(id);
      // The object is gone from OSS (baseline still present): re-upload it as new if it exists locally, otherwise forget it
      else delete base[id];
    }

    for (const batch of chunks(pulls, URL_BATCH)) {
      const urls = await this.urls(kind, { downloads: batch.map(id => headName(kind, id)) });
      const docs = await mapLimit(batch, async id => {
        try { return { id, doc: parseDoc(await this.transport.download(urls.downloads[headName(kind, id)]!), id, kind) }; }
        catch (error) { errors.push(error); unmerged.add(id); return undefined; }
      });
      for (const pulled of docs) {
        if (!pulled) continue;
        this.merging = true;
        try { await this.merge(kind, pulled.id, pulled.doc, heads[pulled.id]!, base, local, root); }
        catch (error) { errors.push(error); unmerged.add(pulled.id); }
        finally { this.merging = false; }
      }
    }

    // Merging may delete a local entry or write a new one; pushing must be based on the post-merge state
    const after = await this.localItems(kind);
    const pushes: Array<{ id: string; item?: LocalItem }> = [];
    for (const id of new Set([...Object.keys(after), ...Object.keys(base)])) {
      if (!unmerged.has(id) && (after[id]?.hash ?? "") !== (base[id]?.hash ?? "")) pushes.push({ id, item: after[id] });
    }
    if (kind === "memory") {
      for (const batch of chunks(pushes, URL_BATCH)) {
        this.ensureLock();
        const urls = await this.urls(kind, { uploads: batch.map(({ id }) => headName(kind, id)) });
        await mapLimit(batch, async ({ id, item }) => {
          try {
            const upload = urls.uploads[headName(kind, id)]!;
            base[id] = { hash: item?.hash ?? "", etag: normalizeEtag(await this.transport.upload(upload.url, encodeDoc(item?.doc ?? this.tombstone(id)), upload.contentType)) };
          } catch (error) { errors.push(error); }
        });
      }
    } else {
      for (const { id, item } of pushes) {
        this.ensureLock();
        try { await this.pushSkill(id, item, objects[id] ?? {}, base, errors); }
        catch (error) { errors.push(error); }
      }
    }
    if (pulls.length || pushes.length) await this.options.log("knowledge-cloud-synced", { kind, pulled: pulls.length, pushed: pushes.length });
  }

  /** Upload files first, then write .ading-meta.json, then delete old files: if any step breaks, other computers still see the complete old version or can detect it by checksum */
  private async pushSkill(id: string, item: LocalItem | undefined, remote: Record<string, string>, base: Record<string, BaseItem>, errors: unknown[]): Promise<void> {
    const files = item?.files ?? [];
    // The ETag of a plain OSS upload is the content MD5; files whose content hasn't changed needn't be re-uploaded
    const changed = files.filter(file => remote[file.path] !== createHash("md5").update(file.bytes).digest("hex").toUpperCase());
    for (const batch of chunks(changed, URL_BATCH)) {
      const urls = await this.urls("skill", { uploads: batch.map(file => `${id}/${file.path}`) });
      await mapLimit(batch, async file => {
        const upload = urls.uploads[`${id}/${file.path}`]!;
        await this.transport.upload(upload.url, file.bytes, upload.contentType);
      });
    }
    const head = headName("skill", id);
    const { uploads } = await this.urls("skill", { uploads: [head] });
    const etag = await this.transport.upload(uploads[head]!.url, encodeDoc(item?.doc ?? this.tombstone(id)), uploads[head]!.contentType);
    base[id] = { hash: item?.hash ?? "", etag: normalizeEtag(etag) };

    const keep = new Set(files.map(file => file.path));
    const stale = Object.keys(remote).filter(file => file !== META_FILE && !keep.has(file));
    // An old file that wasn't deleted doesn't affect use (the new version's manifest doesn't list it); just record it rather than failing this round and re-uploading
    for (const batch of chunks(stale, URL_BATCH)) {
      try {
        const urls = await this.urls("skill", { deletes: batch.map(file => `${id}/${file}`) });
        await mapLimit(batch, file => this.transport.remove(urls.deletes[`${id}/${file}`]!));
      } catch (error) { errors.push(error); }
    }
  }

  private tombstone(id: string): CloudDoc {
    return { schema: SCHEMA, id, updatedAt: this.options.now?.() ?? new Date().toISOString(), deleted: true };
  }

  private async merge(kind: Kind, id: string, doc: CloudDoc, etag: string, base: Record<string, BaseItem>, local: Record<string, LocalItem>, root: string): Promise<void> {
    const remoteHash = doc.deleted ? "" : hashDoc(doc);
    const mine = local[id], mineHash = mine?.hash ?? "", knownHash = base[id]?.hash ?? "";
    const done = () => { base[id] = { hash: remoteHash, etag }; };
    if (remoteHash === mineHash) return done();
    if (mineHash !== knownHash && mine && !newer(doc.updatedAt, id, mine.updatedAt, id)) {
      // Both sides changed and local is newer: the baseline records the other side's content, and the later push stage overwrites it with the local copy
      if (!doc.deleted) await this.archiveRemote(root, kind, id, doc);
      return done();
    }
    if (doc.deleted) {
      if (mine && mineHash !== knownHash) await archive(root, kind, id, mine.doc, mine.files);
      if (mine) this.pulledThisRound = true;
      if (kind === "skill") await this.options.store.deleteSkill(id);
      else await this.options.store.deleteMemory(id);
      delete local[id];
      return done();
    }
    if (kind === "memory") {
      if (mine && mineHash !== knownHash) await archive(root, kind, id, mine.doc);
      this.pulledThisRound = true;
      await this.options.store.applyCloudMemory(doc.memory!);
      local[id] = memoryItem(doc);
      return done();
    }
    // Two computers each imported a skill with the same name: different IDs but the same native directory name, so only one can stay. Keep the newer; the older gets a tombstone
    const rival = Object.entries(local).find(([otherId, item]) => otherId !== id && item.scope === scopeOf(doc) && item.directory === directoryOf(doc));
    if (rival && !newer(doc.updatedAt, id, rival[1].updatedAt, rival[0])) {
      await this.archiveRemote(root, kind, id, doc);
      return done();
    }
    // Download and verify the files first; on failure nothing local has changed, try again next round
    const files = await this.downloadFiles(id, doc);
    if (mine && mineHash !== knownHash) await archive(root, kind, id, mine.doc, mine.files);
    this.pulledThisRound = true;
    if (rival) {
      await archive(root, kind, rival[0], rival[1].doc, rival[1].files);
      await this.options.store.deleteSkill(rival[0]);
      delete local[rival[0]];
    }
    await this.options.store.applyCloudSkill(toSkill(doc), files);
    local[id] = skillItem(doc, files);
    done();
  }

  private async downloadFiles(id: string, doc: CloudDoc): Promise<PackageFile[]> {
    const out: PackageFile[] = [];
    for (const batch of chunks(doc.files!, URL_BATCH)) {
      const urls = await this.urls("skill", { downloads: batch.map(file => `${id}/${file.path}`) });
      out.push(...await mapLimit(batch, async file => {
        const bytes = await this.transport.download(urls.downloads[`${id}/${file.path}`]!);
        if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`knowledge file does not match its manifest: skill/${id}/${file.path}`);
        return { path: file.path, mode: file.mode, bytes };
      }));
    }
    return out;
  }

  /** Keep a copy of the losing cloud version too. If it can't be downloaded, keep only the manifest; this must not block uploading the newer local copy */
  private async archiveRemote(root: string, kind: Kind, id: string, doc: CloudDoc): Promise<void> {
    let files: PackageFile[] | undefined;
    if (kind === "skill") {
      try { files = await this.downloadFiles(id, doc); }
      catch (error) { await this.options.log("knowledge-cloud-archive-incomplete", { id, error: String(error) }); }
    }
    await archive(root, kind, id, doc, files);
  }

  /** heads are each entry's version marker (a skill's .ading-meta.json, or the memory file itself); objects are all files currently in the skill directory */
  private async listRemote(kind: Kind): Promise<{ heads: Record<string, string>; objects: Record<string, Record<string, string>> }> {
    const list = await this.call("GET", `/api/v1/knowledge/${kind}/objects`) as Array<{ name: string; etag: string }>;
    const heads: Record<string, string> = {}, objects: Record<string, Record<string, string>> = {};
    for (const item of list) {
      const etag = normalizeEtag(item.etag);
      if (kind === "memory") { heads[item.name.replace(/\.json$/, "")] = etag; continue; }
      const slash = item.name.indexOf("/"), id = item.name.slice(0, slash), file = item.name.slice(slash + 1);
      (objects[id] ??= {})[file] = etag;
      if (file === META_FILE) heads[id] = etag;
    }
    return { heads, objects };
  }

  private async urls(kind: Kind, body: { uploads?: string[]; downloads?: string[]; deletes?: string[] }): Promise<SignedUrls> {
    return await this.call("POST", `/api/v1/knowledge/${kind}/urls`, { ...body, lockToken: this.lock?.token }) as SignedUrls;
  }

  private async call(method: "GET" | "POST", route: string, body?: object): Promise<unknown> {
    const result = await this.options.api(method, route, body);
    if (!result.ok) {
      if (result.code === LOCK_LOST_CODE) throw new KnowledgeLockLost(result.message);
      const message = `${route}: ${result.kind} ${result.status} ${result.code ?? ""} ${result.message}`;
      throw result.kind === "network" || result.kind === "signed-out" ? new KnowledgeCloudOffline(message) : new Error(message);
    }
    return result.data;
  }

  private async localItems(kind: Kind): Promise<Record<string, LocalItem>> {
    const { skills, memories } = await this.options.store.exportKnowledge();
    if (kind === "memory") return Object.fromEntries(memories.map(entry => [entry.memoryId, memoryItem(memoryDoc(entry))]));
    return Object.fromEntries(skills.map(({ skill, files }) => [skill.skillId, skillItem(skillDoc(skill, files), files)]));
  }
}

class KnowledgeCloudOffline extends Error {}
class KnowledgeLockLost extends Error {}

/** This round was interrupted by a lost lock: don't bother anyone, queue up again. Other errors in the same round will reappear next round */
function isLockLost(error: unknown): boolean {
  return error instanceof AggregateError ? error.errors.some(isLockLost) : error instanceof KnowledgeLockLost;
}

/** Network loss, timeouts and not being logged in are normal and recover automatically once online, so don't bother anyone. Report if other errors are mixed into a round */
function isOffline(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.every(isOffline);
  return error instanceof KnowledgeCloudOffline || error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);
const FAILURE_DETAIL_LIMIT = 300;
function failureDetail(error: unknown): string {
  const text = failureText(error).replace(/\s+/g, " ").trim();
  return text.length > FAILURE_DETAIL_LIMIT ? `${text.slice(0, FAILURE_DETAIL_LIMIT - 1)}…` : text;
}

function skillDoc(skill: Skill, files: PackageFile[]): CloudDoc {
  const { content: _content, source: _source, useCount: _useCount, updatedAt, ...meta } = skill;
  return { schema: SCHEMA, id: skill.skillId, updatedAt, skill: meta, files: packageManifest(files) };
}
function memoryDoc(entry: MemoryEntry): CloudDoc {
  return { schema: SCHEMA, id: entry.memoryId, updatedAt: entry.updatedAt ?? entry.createdAt, memory: entry };
}
function skillItem(doc: CloudDoc, files: PackageFile[]): LocalItem {
  return { hash: hashDoc(doc), updatedAt: doc.updatedAt, doc, files, directory: directoryOf(doc), scope: scopeOf(doc) };
}
function memoryItem(doc: CloudDoc): LocalItem {
  return { hash: hashDoc(doc), updatedAt: doc.updatedAt, doc };
}
const directoryOf = (doc: CloudDoc) => (doc.skill?.directoryName ?? "").toLowerCase();
const scopeOf = (doc: CloudDoc) => JSON.stringify([doc.skill?.scope, doc.skill?.ownerId ?? null]);
function toSkill(doc: CloudDoc): Skill {
  return { ...doc.skill!, content: "", useCount: 0, updatedAt: doc.updatedAt } as Skill;
}
const encodeDoc = (doc: CloudDoc) => Buffer.from(JSON.stringify(doc, null, 2));
const headName = (kind: Kind, id: string) => kind === "skill" ? `${id}/${META_FILE}` : `${id}.json`;

/** Content fingerprint: fixed field order, excludes updatedAt, so identical content on both sides isn't a conflict; local stats (useCount) and local paths are excluded */
function hashDoc(doc: CloudDoc): string {
  const payload = doc.memory
    ? [doc.memory.memoryId, doc.memory.scope, doc.memory.ownerId, doc.memory.content, doc.memory.authorKind, doc.memory.authorUserId ?? null, doc.memory.sourceMessageId ?? null, doc.memory.pinned, doc.memory.createdAt]
    : [doc.skill!.skillId, doc.skill!.name, doc.skill!.description, doc.skill!.scope, doc.skill!.ownerId ?? null, doc.skill!.directoryName ?? null, doc.skill!.enabled, doc.skill!.authorKind, doc.skill!.authorUserId ?? null, doc.skill!.targets ?? null, doc.skill!.createdAt, doc.files!.map(file => [file.path, file.size, file.sha256, file.mode ?? null])];
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Whether a is newer than b. On equal times compare IDs, so both computers reach the same conclusion */
function newer(aTime: string, aId: string, bTime: string, bId: string): boolean {
  const a = Date.parse(aTime) || 0, b = Date.parse(bTime) || 0;
  return a === b ? aId >= bId : a > b;
}

function parseDoc(raw: Buffer, id: string, kind: Kind): CloudDoc {
  const doc = JSON.parse(raw.toString("utf8")) as CloudDoc;
  if (doc?.schema !== SCHEMA || doc.id !== id || typeof doc.updatedAt !== "string") throw new Error(`invalid knowledge object: ${kind}/${id}`);
  if (doc.deleted) return doc;
  const valid = kind === "skill"
    ? doc.skill?.skillId === id && Array.isArray(doc.files) && doc.files.every(file => typeof file?.path === "string" && typeof file.sha256 === "string" && typeof file.size === "number")
    : doc.memory?.memoryId === id && typeof doc.memory.content === "string";
  if (!valid) throw new Error(`invalid knowledge object: ${kind}/${id}`);
  return doc;
}

const normalizeEtag = (etag: string) => etag.replace(/"/g, "").toUpperCase();

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

async function mapLimit<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(TRANSFER_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index]!); }
  }));
  return results;
}

const stateFile = (root: string) => path.join(root, "knowledge-cloud-state.json");

async function readState(root: string): Promise<SyncState> {
  try {
    const state = JSON.parse(await readFile(stateFile(root), "utf8")) as Partial<SyncState>;
    return { skill: state.skill ?? {}, memory: state.memory ?? {} };
  } catch (error) {
    // Treat a corrupt baseline as missing: that only costs one extra comparison and never treats local content as deleted
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { skill: {}, memory: {} };
  }
}

async function writeState(root: string, state: SyncState): Promise<void> {
  const file = stateFile(root), candidate = `${file}.candidate`;
  try { await writeFile(candidate, JSON.stringify(state), { mode: 0o600 }); await rename(candidate, file); }
  finally { await rm(candidate, { force: true }); }
}

async function archive(root: string, kind: Kind, id: string, doc: CloudDoc, files?: PackageFile[]): Promise<void> {
  const directory = path.join(root, "knowledge-cloud-conflicts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${kind}-${id}-${Date.now()}.json`), JSON.stringify({ ...doc, contents: files?.map(file => ({ path: file.path, data: Buffer.from(file.bytes).toString("base64") })) }), { mode: 0o600 });
}
