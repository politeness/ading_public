/**
 * Backend addresses for "support". Standalone mode (not signed in) also uses these APIs,
 * so they don't depend on sign-in state, only on the addresses resolved here.
 *
 * Priority: per-address environment variable > ADING_API_BASE_URL > built-in default.
 * Packaged apps can't see the dev machine's environment variables; the built-in default is what actually makes the uploader run:
 * previously only environment variables were read, so the uploader was always off in release builds and reports stayed local.
 */

/**
 * Dev builds connect locally by default, pre builds to the pre-release service, release builds to production.
 * Which one is decided by the release channel, not guessed from the version string.
 *
 * The dev server address actually used by dev builds isn't in the repo: launch and packaging scripts read it from the local .env
 * (ADING_DEV_API_BASE_URL, see .env.example at the repo root) and apply it via ADING_API_BASE_URL.
 */
export const API_BASE_URL: Record<ReleaseChannel, string> = {
  develop: "http://localhost:8080",
  // Release must use HTTPS: reports upload screenshots and logs, over the public internet.
  // Use a domain rather than an IP, so switching servers doesn't require a new release (IPs can't get certificates either)
  // The pre-release service is mounted under the /pre/ prefix of the production domain, reusing the same certificate
  pre: "https://www.coffeestudy.com.cn/pre",
  release: "https://www.coffeestudy.com.cn"
};

import type { ReleaseChannel } from "../shared/release";

export interface SupportEndpoints {
  report?: string;
  contact?: string;
  config?: string;
}

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

function baseUrl(env: Env, channel: ReleaseChannel): string {
  const configured = clean(env.ADING_API_BASE_URL) || API_BASE_URL[channel];
  return configured.replace(/\/+$/, "");
}

/** Backend root address. Account sign-in and "support" share this resolution rule instead of writing it twice. */
export function apiBaseUrl(channel: ReleaseChannel, env: Env = process.env): string {
  return baseUrl(env, channel);
}

/** Legacy config compatibility: if only .../reports is given, derive the other addresses in the same group. */
function siblingOf(reportUrl: string, name: string): string | undefined {
  return /\/reports\/?$/.test(reportUrl)
    ? reportUrl.replace(/\/reports\/?$/, `/${name}`)
    : undefined;
}

export function resolveSupportEndpoints(
  channel: ReleaseChannel,
  env: Env = process.env
): SupportEndpoints {
  if (clean(env.ADING_SUPPORT_DISABLED) === "1") return {};
  const base = baseUrl(env, channel);
  const report = clean(env.ADING_SUPPORT_REPORT_URL) || `${base}/api/v1/support/reports`;
  const contact =
    clean(env.ADING_SUPPORT_CONTACT_URL)
    || siblingOf(report, "contacts")
    || `${base}/api/v1/support/contacts`;
  const config =
    clean(env.ADING_SUPPORT_CONFIG_URL)
    || siblingOf(report, "config")
    || `${base}/api/v1/support/config`;
  return { report, contact, config };
}
