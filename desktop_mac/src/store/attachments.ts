import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { newId } from "./ids";
import { removeTree } from "../platform/remove-tree";

/**
 * Where message attachments live on this computer: `<dataDir>/attachments/<attachmentId>/<fileName>`.
 *
 * In standalone mode attachments exist only here; in online mode this is a cache — attachments you send go here first then upload to OSS,
 * attachments from other devices are downloaded here the first time they're used (viewing, handing to an agent).
 * One directory per attachment, named by ID, with the original file name kept: the path given to an agent shows what the file is.
 */

/** Same as the backend: 200 MB per attachment, at most 9 per message */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const MAX_ATTACHMENTS = 9;

const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm", avi: "video/x-msvideo", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", xml: "application/xml", zip: "application/zip", gz: "application/gzip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  key: "application/vnd.apple.keynote", pages: "application/vnd.apple.pages", numbers: "application/vnd.apple.numbers"
};

export function mimeFromName(name: string): string {
  const extension = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

/** Convert between cloud form (IMAGE/VIDEO/FILE) and local form */
export function kindFromCloud(kind: string | undefined, mimeType: string): AttachmentKind {
  const lower = (kind ?? "").toLowerCase();
  return lower === "image" || lower === "video" || lower === "file" ? lower : attachmentKind(mimeType);
}

/** Strip only path separators and control characters from file names; keep CJK and spaces: agents need to recognize which file it is */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:]/g, "_").trim().slice(0, 200);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

export function isAttachmentId(id: string): boolean {
  return ATTACHMENT_ID.test(id);
}

/** Validate whether a set of attachments can be sent with one message; return a normalized copy */
export function normalizeAttachments(list: Attachment[] | undefined): Attachment[] | undefined {
  if (!list?.length) return undefined;
  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const item of list) {
    if (!isAttachmentId(item.attachmentId)) throw new Error(`invalid attachment id: ${item.attachmentId}`);
    if (seen.has(item.attachmentId)) continue;
    seen.add(item.attachmentId);
    if (item.size > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
    const mimeType = item.mimeType || mimeFromName(item.name);
    out.push({
      attachmentId: item.attachmentId,
      name: safeFileName(item.name),
      mimeType,
      size: Math.max(0, Math.floor(item.size)),
      kind: item.kind ?? attachmentKind(mimeType)
    });
  }
  if (out.length > MAX_ATTACHMENTS) throw new Error("ATTACHMENT_TOO_MANY");
  return out;
}

export class AttachmentVault {
  /** Download only once when an attachment is viewed and handed to an agent at the same time */
  private readonly downloads = new Map<string, Promise<string>>();

  constructor(private readonly root: string) {}

  dir(): string {
    return path.join(this.root, "attachments");
  }

  pathFor(attachment: Pick<Attachment, "attachmentId" | "name">): string {
    if (!isAttachmentId(attachment.attachmentId)) throw new Error(`invalid attachment id: ${attachment.attachmentId}`);
    return path.join(this.dir(), attachment.attachmentId, safeFileName(attachment.name));
  }

  async has(attachment: Pick<Attachment, "attachmentId" | "name">): Promise<boolean> {
    try {
      return (await stat(this.pathFor(attachment))).isFile();
    } catch {
      return false;
    }
  }

  /** Copy files the user picked in (don't move the originals). Reject outright if over the limit, no copy */
  async importFile(source: string, name = path.basename(source)): Promise<Attachment> {
    const info = await stat(source);
    if (!info.isFile()) throw new Error("ATTACHMENT_NOT_FILE");
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
    const attachment = this.describe(name, info.size);
    const target = this.pathFor(attachment);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    return attachment;
  }

  /** Content with no original file, like pasted screenshots */
  async importData(name: string, mimeType: string, bytes: Uint8Array): Promise<Attachment> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
    const attachment = this.describe(name, bytes.byteLength, mimeType);
    const target = this.pathFor(attachment);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return attachment;
  }

  /**
   * If not present locally, use fetchUrl to get a download URL and download it. Write a temp file then rename:
   * a download interrupted halfway won't leave a broken file that looks complete.
   */
  async ensure(attachment: Pick<Attachment, "attachmentId" | "name">, fetchUrl?: () => Promise<string>): Promise<string> {
    const target = this.pathFor(attachment);
    if (await this.has(attachment)) return target;
    if (!fetchUrl) throw new Error("ATTACHMENT_MISSING");
    const running = this.downloads.get(attachment.attachmentId);
    if (running) return running;
    const download = (async () => {
      await mkdir(path.dirname(target), { recursive: true });
      const partial = `${target}.part`;
      try {
        await downloadToFile(await fetchUrl(), partial);
        await rename(partial, target);
        return target;
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
    })();
    this.downloads.set(attachment.attachmentId, download);
    try {
      return await download;
    } finally {
      this.downloads.delete(attachment.attachmentId);
    }
  }

  /** Delete attachments along with the task; skip ones not present locally (not yet downloaded in online mode) */
  async remove(attachmentIds: string[]): Promise<void> {
    for (const id of new Set(attachmentIds)) {
      if (isAttachmentId(id)) await removeTree(path.join(this.dir(), id));
    }
  }

  private describe(name: string, size: number, mimeType?: string): Attachment {
    const mime = mimeType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType) ? mimeType.toLowerCase() : mimeFromName(name);
    return { attachmentId: newId("attachment"), name: safeFileName(name), mimeType: mime, size, kind: attachmentKind(mime) };
  }
}

type Requester = typeof https.request;

function requester(url: URL): Requester {
  return (url.protocol === "http:" ? http.request : https.request) as Requester;
}

/** Direct upload to OSS via signed URL: streaming, so even a 200 MB video isn't read fully into memory */
export async function uploadFile(url: string, file: string, contentType: string): Promise<void> {
  const target = new URL(url);
  const size = (await stat(file)).size;
  await new Promise<void>((resolve, reject) => {
    const request = requester(target)(target, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(size) },
      timeout: 120_000
    }, (response) => {
      response.resume();
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`upload failed: HTTP ${status}`));
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("upload timed out")));
    request.on("error", reject);
    createReadStream(file).on("error", reject).pipe(request);
  });
}

export async function downloadToFile(url: string, file: string, redirects = 3): Promise<void> {
  const target = new URL(url);
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = requester(target)(target, { method: "GET", timeout: 120_000 }, resolve);
    request.on("timeout", () => request.destroy(new Error("download timed out")));
    request.on("error", reject);
    request.end();
  });
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
    response.resume();
    return downloadToFile(new URL(response.headers.location, target).toString(), file, redirects - 1);
  }
  if (status < 200 || status >= 300) {
    response.resume();
    throw new Error(`download failed: HTTP ${status}`);
  }
  await pipeline(response, createWriteStream(file));
}
