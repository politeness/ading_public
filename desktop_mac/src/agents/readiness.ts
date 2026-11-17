/**
 * Translates the result of one minimal call into "what color the light should be".
 *
 * It is extracted on its own because it is all string matching, and string matching is the easiest place to make assumptions:
 * every CLI words "not logged in" differently, so only pattern matching works,
 * which makes it all the more important to pin it down with tests instead of each adapter doing its own thing.
 */

/** Every vendor words "not logged in" differently; list every variant we can cover */
const AUTH_PATTERNS = [
  /unauthor/i,
  /not\s+(logged|signed)\s*in/i,
  /please\s+(log|sign)\s*in/i,
  /\blogin\s+required/i,
  /authenticat/i,
  /no auth type is selected|please configure an auth type/i,
  /\b401\b/,
  /\b403\b/,
  /api[\s_-]?key/i,
  /credential/i,
  /session\s+expired/i,
  /token.*(expired|invalid|missing)/i,
  /未登录/,
  /登录已过期/,
  /请先登录/
];

/** These mean "works, but not this time" and must not be judged as not logged in - getting it wrong sends people to log in for nothing */
const NOT_AUTH_PATTERNS = [
  // Copilot also reports "403 unauthorized" when login succeeded but the feature isn't enabled; only match its specific wording, a bare 403 still counts as not logged in
  /not\s+authorized\s+to\s+use\b/i,
  /\binsufficient[_\s-]+scopes?\b/i,
  // No permission on a local file (the path may contain credentials); not an account problem
  /\bE(?:ACCES|PERM)\b/,
  /rate.?limit/i,
  /quota/i,
  /credit\s+balance/i,
  /overloaded/i,
  /timeout/i,
  /ECONN/i,
  /ENOTFOUND/i,
  /network/i
];

/** Explicitly says the account balance or session/period quota is used up; temporary rate limiting doesn't count. */
const EXHAUSTED_PATTERNS = [
  /(?:hit|reached)\s+your\s+(?:session|weekly|monthly|\d+[ -]hour)\s+limit\b/i,
  /credit\s+(usage\s+)?limit/i,
  /credit\s+balance/i,
  /quota\s+(exhausted|limit|reached)/i,
  /usage\s+limit/i,
  /upgrade\s+your\s+(subscription|plan)/i,
  /额度(?:已)?(不足|耗尽|用完)/,
  /配额(?:已)?(不足|耗尽|用完)/,
  /(?:没有|无)(?:可用)?额度/
];

export function looksExhausted(text: string): boolean {
  return EXHAUSTED_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksUnauthorized(text: string): boolean {
  if (!text) return false;
  if (NOT_AUTH_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return AUTH_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Check result -> light color.
 *
 * @param installed whether this machine has the executable
 * @param outcome   result of the minimal call; pass undefined if it wasn't run
 */
export function classifyReadiness(
  installed: boolean,
  outcome?: { ok: boolean; text: string; signedOut?: boolean }
): { readiness: AgentReadiness; detail?: string } {
  if (!installed) return { readiness: "missing" };
  if (!outcome) return { readiness: "found" };
  if (outcome.ok) return { readiness: "ready" };

  const text = outcome.text.trim();
  // The adapter has already explicitly determined "not logged in"; no longer rely on (possibly Chinese) text matching.
  if (outcome.signedOut) return { readiness: "unauthorized", detail: firstLine(text) };
  // Quota messages occasionally include 401 too; check quota first to avoid wrongly telling the user to log in again.
  if (looksExhausted(text)) {
    return { readiness: "exhausted", detail: firstLine(text) };
  }
  if (looksUnauthorized(text)) {
    return { readiness: "unauthorized", detail: firstLine(text) };
  }
  return { readiness: "error", detail: firstLine(text) };
}

/** Only Agents that are discovered, checked and not currently being re-checked can take part in tasks. */
export function canAgentParticipate(
  readiness: AgentReadiness | undefined,
  options: { discovered: boolean; verifying: boolean }
): boolean {
  return options.discovered && !options.verifying && readiness === "ready";
}

/** On errors a CLI often dumps dozens of stack lines; the page only has room for one */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return (line ?? text).slice(0, 200);
}
