/**
 * Version numbers and release channels. The authoritative rules are in the repo root README "Version numbers and release channels"; this is their only implementation.
 *
 * All components (desktop, backend) share one version scheme a.b.c:
 *   - a major: significant changes, important new features;
 *   - b minor: small features, small requests, small changes;
 *   - c routine updates: mainly debugging, patches, hot fixes, and other tiny changes.
 *
 * Three channels, three version string forms:
 *   - release  `0.4.0`                        connects to the ECS production backend
 *   - pre      `0.4.0-2026.9.17-143005-pre`   connects to the ECS pre-release backend (for gray validation)
 *   - develop  `0.4.0-2026.9.17-143005-dev`   connects to the NAS development backend
 *
 * All of these are valid semver with the right semantics: pre and dev builds are both **prereleases** of their release version,
 * `0.4.0-…-dev < 0.4.0` and `0.4.0-…-pre < 0.4.0`. There are no upgrades across channels, so it doesn't matter whether dev or pre sorts higher.
 * Month and day in the date **must not be zero-padded** (semver numeric identifiers forbid leading zeros; `09` makes the whole string invalid);
 * hours/minutes/seconds **must be zero-padded to 6 digits**: joined with the suffix they form one alphanumeric segment, which allows leading zeros,
 * and comparison (update/version.ts and conductor's SemVer.java) compares the day first, then the time as text,
 * so a fixed width guarantees text order equals time order. Within a channel this orders builds without touching the three-part version.
 *
 * The channel is an **independent, explicit property**, not parsed from the version string. The version string is for humans;
 * the channel decides which server to connect to — letting a display field carry configuration means a single typo in the version
 * connects to the wrong environment, often discovered only by users.
 */

export type ReleaseChannel = "develop" | "pre" | "release";

const CHANNELS: readonly ReleaseChannel[] = ["develop", "pre", "release"];

function asChannel(value: string | undefined): ReleaseChannel | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  return CHANNELS.find(channel => channel === normalized);
}

/** Marker at the end of pre and dev version strings; release has none */
export const CHANNEL_SUFFIX: Record<Exclude<ReleaseChannel, "release">, string> = {
  develop: "dev",
  pre: "pre"
};

export interface ReleaseManifest {
  version: string;
  adingChannel?: string;
  adingBuildTime?: string;
}

type Env = Record<string, string | undefined>;

/** Unrecognized channel names are treated as develop: better to fail to reach the dev machine than let a misspelled name point a build at production */
export function resolveChannel(
  manifest: ReleaseManifest,
  env: Env = process.env
): ReleaseChannel {
  return asChannel(env.ADING_CHANNEL) ?? asChannel(manifest.adingChannel) ?? "develop";
}

/**
 * Strip the build time and channel marker to get back the three-part release version.
 * In packaged apps version is already the full string; without this, building it again would stack suffixes.
 */
export function baseVersionOf(version: string): string {
  const match = /^(\d+\.\d+\.\d+)/.exec(version.trim());
  return match ? match[1] : version.trim();
}

/** Build time looks like 2026.9.12-093005 (local time): month and day not zero-padded, hh/mm/ss zero-padded to 6 digits. */
export function formatBuildTime(at: Date = new Date()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}.${at.getMonth() + 1}.${at.getDate()}`
    + `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

const BUILD_TIME = /^\d{4}\.[1-9]\d?\.[1-9]\d?-([01]\d|2[0-3])[0-5]\d[0-5]\d$/;

/** Build time fixed at packaging; if missing or malformed (e.g. dev run), use now */
export function buildTimeOf(manifest: ReleaseManifest, now: Date = new Date()): string {
  const declared = (manifest.adingBuildTime ?? "").trim();
  return BUILD_TIME.test(declared) ? declared : formatBuildTime(now);
}

/** Dev 0.1.0-2026.9.12-093005-dev, pre 0.1.0-2026.9.12-093005-pre, release is just 0.1.0. */
export function formatVersion(
  baseVersion: string,
  buildTime: string,
  channel: ReleaseChannel
): string {
  const base = baseVersionOf(baseVersion);
  return channel === "release" ? base : `${base}-${buildTime}-${CHANNEL_SUFFIX[channel]}`;
}

export function describeRelease(
  manifest: ReleaseManifest,
  env: Env = process.env,
  now: Date = new Date()
): {
  channel: ReleaseChannel;
  buildTime: string;
  baseVersion: string;
  displayVersion: string;
} {
  const channel = resolveChannel(manifest, env);
  const buildTime = buildTimeOf(manifest, now);
  const baseVersion = baseVersionOf(manifest.version);
  return {
    channel,
    buildTime,
    baseVersion,
    displayVersion: formatVersion(baseVersion, buildTime, channel)
  };
}
