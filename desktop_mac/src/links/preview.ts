import { execFile } from "node:child_process";
import { computerHelperPath } from "../agents/computer-tools";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export interface LinkPreview { title: string; description: string; siteName: string; image?: string }

/** Only globally routed addresses. Pin the checked result to the socket to prevent DNS rebinding. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Global unicast only, excluding transition/documentation ranges that may embed local IPv4.
  const value = address.toLowerCase();
  const [first, second] = value.split(":").map(part => parseInt(part || "0", 16));
  return isIP(value) === 6 && /^[23]/.test(value) &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    first !== 0x2002 && first !== 0x3fff;
}

function text(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, key: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    if (!key.startsWith("#")) return named[key.toLowerCase()] ?? entity;
    const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }).replace(/\s+/g, " ").trim();
}

export function parseLinkPreview(html: string, hostname: string): LinkPreview | null {
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4]);
    }
    const key = attrs.get("property") ?? attrs.get("name");
    if (key && attrs.has("content")) meta.set(key.toLowerCase(), attrs.get("content")!);
  }
  const title = text(meta.get("og:title") ?? meta.get("twitter:title") ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 240);
  const description = text(meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description") ?? "").slice(0, 500);
  if (!title && !description) return null;
  return { title: title || hostname, description, siteName: text(meta.get("og:site_name") ?? hostname).slice(0, 120) };
}

export function publicPreviewHostname(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
    !isIP(host.replace(/^\[|\]$/g, "")) && host.includes(".") &&
    !/(?:^|\.)(?:localhost|local|lan|home|internal|intranet|corp|test|invalid)\.?$/.test(host);
}

async function systemPreview(url: URL): Promise<LinkPreview | null> {
  if (process.platform !== "darwin" || !publicPreviewHostname(url)) return null;
  return new Promise(resolve => {
    execFile(computerHelperPath(), ["link-preview", JSON.stringify({ url: url.toString() })], { timeout: 8500, maxBuffer: 192 * 1024 }, (_error, stdout) => {
      try {
        const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        const image = typeof result.image === "string" && result.image.length <= 132 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(result.image) ? result.image : undefined;
        resolve(result.ok && typeof result.title === "string" ? { title: result.title.slice(0, 240), description: "", siteName: String(result.siteName ?? url.hostname).slice(0, 120), ...(image ? { image } : {}) } : null);
      } catch { resolve(null); }
    });
  });
}

class ProxyDNS extends Error {}
class UnsafeDestination extends Error {}

async function fetchHtml(url: URL, signal: AbortSignal, redirects = 0, permitted = { native: false }): Promise<{ html: string; hostname: string }> {
  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
    (url.port && url.port !== "80" && url.port !== "443") || redirects > 4) throw new UnsafeDestination("Unsupported preview URL");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (/(?:^|\.)(?:localhost|local|lan|home|internal|intranet|corp|test|invalid)\.?$/i.test(hostname)) throw new UnsafeDestination("Local preview hostname");
  permitted.native = false;
  const addresses = await lookup(hostname, { all: true });
  // A transparent proxy can return benchmark-range synthetic IPs for public names.
  // Only the OS metadata provider may use that mapping; never dial those IPs directly.
  if (redirects === 0 && publicPreviewHostname(url) && addresses.length && addresses.every(item => /^198\.(?:18|19)\./.test(item.address))) { permitted.native = true; throw new ProxyDNS(); }
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new UnsafeDestination("Non-public preview destination");
  permitted.native = true;
  signal.throwIfAborted();
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).get(url, {
      signal, agent: false,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: Function) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any,
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "identity", "User-Agent": "ADing-LinkPreview/1.0" }
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.destroy();
        try { resolve(fetchHtml(new URL(response.headers.location, url), signal, redirects + 1, permitted)); } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200 || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers["content-type"] ?? "")) {
        response.destroy(); reject(Error("Preview unavailable")); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      const finish = () => {
        const charset = response.headers["content-type"]?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? "utf-8";
        try { resolve({ html: new TextDecoder(charset).decode(Buffer.concat(chunks)), hostname: url.hostname }); }
        catch { resolve({ html: Buffer.concat(chunks).toString("utf8"), hostname: url.hostname }); }
      };
      response.on("data", (chunk: Buffer) => {
        const remaining = 512 * 1024 - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
        // Metadata is in the head; do not download a multi-megabyte article body.
        if (size >= 512 * 1024 || /<\/head\s*>/i.test(Buffer.concat(chunks).toString("utf8"))) {
          finish(); response.destroy();
        }
      });
      response.on("end", finish);
      response.on("error", reject);
    });
    req.on("error", reject);
  });
}

export class LinkPreviews {
  private cache = new Map<string, { expires: number; value: Promise<LinkPreview | null> }>();
  private active = 0;
  async get(raw: string): Promise<LinkPreview | null> {
    if (typeof raw !== "string" || raw.length > 4096) return null;
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    url.hash = "";
    const key = url.toString();
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (this.active >= 4) return null;
    this.active++;
    const signal = AbortSignal.timeout(6000);
    const value = (async () => {
      try {
        let parsed: LinkPreview | null = null;
        const permitted = { native: false };
        try {
          const fetched = await Promise.race([
            fetchHtml(url, signal, 0, permitted),
            new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
          ]);
          parsed = parseLinkPreview(fetched.html, fetched.hostname);
        } catch (error) {
          if (error instanceof UnsafeDestination) return null;
        }
        // Like iOS, system metadata can provide site branding even for a login-only page.
        const native = permitted.native ? await systemPreview(url) : null;
        if (!native) return parsed;
        return { ...native, description: parsed?.description ?? "" };
      } finally { this.active--; }
    })();
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: Date.now() + 10 * 60_000, value });
    return value;
  }
}
