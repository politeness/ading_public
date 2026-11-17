import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads the untracked .env at the repo root (format in .env.example).
 * Real server addresses live only there; existing environment variables take precedence, and a missing file yields an empty result.
 */
export function localEnv(env = process.env) {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
  const values = {};
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return values; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const key of Object.keys(values)) if (env[key]?.trim()) values[key] = env[key].trim();
  return values;
}

/** A value that must be set in the environment or .env; if missing, abort and say where to set it. */
export function requiredLocal(name, env = process.env) {
  const value = env[name]?.trim() || localEnv(env)[name];
  if (!value) throw new Error(`Missing ${name}: pass it as an environment variable or add it to the untracked .env at the repo root (see .env.example)`);
  return value;
}

/** Anonymous download URL prefix of the OSS bucket holding installers; the bucket name stays out of the repo. */
export function ossDownloadBase(env = process.env) {
  return `https://${requiredLocal("ADING_OSS_BUCKET", env)}.oss-cn-shanghai.aliyuncs.com`;
}

/** Backend for the development build: ADING_DEV_API_BASE_URL from the environment or .env; falls back to the built-in localhost. */
export function devApiBaseUrl(env = process.env) {
  return env.ADING_DEV_API_BASE_URL?.trim() || localEnv(env).ADING_DEV_API_BASE_URL || "";
}
