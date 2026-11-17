/**
 * Uploads desktop release artifacts to OSS: releases go to ota/desktop_mac/releases/<version>/,
 * pre-releases go to ota/desktop_mac/prereleases/<version>/. Dev builds are not uploaded.
 *
 * No ali-oss SDK: a release only needs to PUT a few objects, and OSS V1 signing takes a few dozen hand-written lines;
 * not worth pulling a whole dependency tree into a release script.
 *
 * Credentials are read from environment variables, named the same as in the ECS deployment directory's env:
 *   OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
 * The bucket name comes from ADING_OSS_BUCKET (environment variable or the untracked .env at the repo root). The endpoint defaults to public
 * (overridable via ADING_OSS_UPLOAD_ENDPOINT) — releases are done locally, and this machine is not in the Alibaba Cloud VPC,
 * so the internal endpoint doesn't resolve. The backend's ADING_OSS_ENDPOINT is deliberately not reused, so the ECS
 * internal address isn't carried over.
 *
 * Release artifacts are immutable by default: the cask and landing page list their sha256, so silently replacing content would make users'
 * verification fail. So an existing object with identical content is skipped, and different content is an error. Only when the user explicitly decides
 * to republish the same version is --overwrite added, and the hashes in the cask and landing page must be updated as well.
 *
 * See "OSS layout" in docs/ota-design.md for the bucket layout. ota/ holds installers, by client desktop_mac|mobile_ios,
 * then by releases|prereleases/<version>. This script only writes these two directories under ota/desktop_mac/.
 * Pre-release packages are for gray testing (downloaded anonymously by clients), kept separate from releases and never referenced by Homebrew or the landing page.
 *
 * Usage: node scripts/upload-oss.mjs [--overwrite] <version> <file>...
 */
import { readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { request } from "node:https";
import path from "node:path";
import { requiredLocal } from "./local-env.mjs";

const CONTENT_TYPES = {
  ".dmg": "application/x-apple-diskimage",
  ".sha256": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

/** Root directory of desktop installers on OSS */
export const DESKTOP_OTA_ROOT = "ota/desktop_mac";

/** The version decides the directory: three-part release versions go to releases/, pre-releases (…-pre) to prereleases/; dev builds are not uploaded and are rejected like any other format */
export function releasePrefix(version) {
  if (/^\d+\.\d+\.\d+$/.test(version)) return `${DESKTOP_OTA_ROOT}/releases`;
  if (/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+-pre$/.test(version)) return `${DESKTOP_OTA_ROOT}/prereleases`;
  if (/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+-dev$/.test(version)) throw new Error(`Dev builds are not uploaded to OSS: ${version}`);
  throw new Error(`Version is neither a release nor a pre-release: ${version}`);
}

/** Reads OSS config; returns null if credentials are missing */
export function ossConfig(env = process.env) {
  const accessKeyId = env.OSS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = env.OSS_ACCESS_KEY_SECRET?.trim();
  if (!accessKeyId || !accessKeySecret) return null;
  const endpoint = env.ADING_OSS_UPLOAD_ENDPOINT?.trim() || "oss-cn-shanghai.aliyuncs.com";
  return {
    accessKeyId,
    accessKeySecret,
    bucket: requiredLocal("ADING_OSS_BUCKET", env),
    host: endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  };
}

/**
 * Large PUTs don't use fetch: fetch waits at most 5 minutes for the server response, so a 140 MB DMG on a slow network gets cut off before finishing
 * (two consecutive UND_ERR_HEADERS_TIMEOUT on an outside network during the 0.8.1 release). https.request has no timeout by default and waits as long as it takes.
 */
function putObject(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "PUT", headers: { ...headers, "content-length": body.length } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const objectUrl = (config, key) =>
  `https://${config.bucket}.${config.host}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** OSS V1 signature: HMAC-SHA1(VERB \n MD5 \n TYPE \n DATE \n x-oss-headers resource) */
export function signHeaders(config, method, key, headers, date = new Date().toUTCString()) {
  const ossHeaders = Object.keys(headers)
    .filter(name => name.startsWith("x-oss-"))
    .sort()
    .map(name => `${name}:${headers[name]}\n`)
    .join("");
  const stringToSign = [
    method,
    headers["content-md5"] ?? "",
    headers["content-type"] ?? "",
    date,
    `${ossHeaders}/${config.bucket}/${key}`
  ].join("\n");
  const signature = createHmac("sha1", config.accessKeySecret).update(stringToSign).digest("base64");
  return { ...headers, date, authorization: `OSS ${config.accessKeyId}:${signature}` };
}

/**
 * Uploads one file; returns "uploaded", "overwritten" or "unchanged".
 * overwrite is only enabled when the user explicitly decides to republish the same version: earlier downloaders hold a file with the old hash.
 */
export async function uploadFile(config, key, file, { overwrite = false } = {}) {
  const body = await readFile(file);
  const md5 = createHash("md5").update(body);
  const md5Hex = md5.copy().digest("hex");
  const url = objectUrl(config, key);

  // For simple uploads the ETag is the content MD5; use it to tell whether the same file was already uploaded
  const head = await fetch(url, { method: "HEAD", headers: signHeaders(config, "HEAD", key, {}) });
  let existed = false;
  if (head.ok) {
    const etag = head.headers.get("etag")?.replace(/"/g, "").toLowerCase();
    if (etag === md5Hex) return "unchanged";
    if (!overwrite) {
      throw new Error(`${key} already exists on OSS with different content (ETag ${etag}, local MD5 ${md5Hex}). Release artifacts are not overwritten by default; add --overwrite when you are sure you want to republish the same version.`);
    }
    existed = true;
  } else if (head.status !== 404) {
    throw new Error(`Failed to check ${key}: HTTP ${head.status}`);
  }

  const headers = {
    "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    // With Content-MD5, OSS verifies the received content and rejects corrupted uploads
    "content-md5": md5.digest("base64")
  };
  const put = await putObject(url, signHeaders(config, "PUT", key, headers), body);
  if (put.status < 200 || put.status >= 300) throw new Error(`Failed to upload ${key}: HTTP ${put.status}\n${put.text}`);

  // Users download anonymously; if anonymous access fails, it's as good as unpublished
  const anonymous = await fetch(url, { method: "HEAD" });
  if (!anonymous.ok) throw new Error(`${key} was uploaded, but anonymous access returned HTTP ${anonymous.status}; users can't download it`);
  return existed ? "overwritten" : "uploaded";
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const overwrite = args.includes("--overwrite");
  const [version, ...files] = args.filter(arg => arg !== "--overwrite");
  if (!version || files.length === 0) {
    throw new Error("Usage: node scripts/upload-oss.mjs [--overwrite] <version> <file>...");
  }
  const prefix = releasePrefix(version);

  const config = ossConfig();
  if (!config) throw new Error("Missing OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET environment variables");

  for (const file of files) {
    const key = `${prefix}/${version}/${path.basename(file)}`;
    const result = await uploadFile(config, key, file, { overwrite });
    console.log(`OSS_${result.toUpperCase()}=${objectUrl(config, key)}`);
  }
}
