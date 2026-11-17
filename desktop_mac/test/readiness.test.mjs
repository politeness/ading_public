// Status light colors. This is all string matching, where assumptions are easy to make:
// misjudging "quota exhausted" as "signed out" sends people off to do something useless
import path from "node:path";
const { canAgentParticipate, classifyReadiness, looksExhausted, looksUnauthorized } = await import(
  path.resolve("dist/agents/readiness.js")
);

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++; else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

// ---- not installed / installed but untested / tested OK ----
check("not installed is missing", classifyReadiness(false).readiness === "missing");
check("not installed has no detail", classifyReadiness(false).detail === undefined);
check("installed but untested is found", classifyReadiness(true).readiness === "found");
check("ignores text when adapter explicitly reports signed out", classifyReadiness(true, { ok: false, text: "any text", signedOut: true }).readiness === "unauthorized");
check("passing run is ready", classifyReadiness(true, { ok: true, text: "OK" }).readiness === "ready");

// ---- only ready Agents can join chats ----
check("participates when ready and discovered",
  canAgentParticipate("ready", { discovered: true, verifying: false }) === true);
for (const readiness of [undefined, "missing", "found", "unauthorized", "exhausted", "error"]) {
  check(`ignored when ${readiness ?? "unchecked"}`,
    canAgentParticipate(readiness, { discovered: true, verifying: false }) === false);
}
check("ignored while rechecking even if the old cache is ready",
  canAgentParticipate("ready", { discovered: true, verifying: true }) === false);
check("ignored when executable not found even if the old cache is ready",
  canAgentParticipate("ready", { discovered: false, verifying: false }) === false);

// ---- various ways of saying "signed out" ----
for (const text of [
  "Error: 401 unauthorized",
  "You are not logged in. Run `codex login`.",
  "Please sign in to continue",
  "authentication failed",
  "Invalid API key provided",
  "credentials not found",
  "session expired",
  "token expired",
  "请先登录后再使用",
  "未登录"
]) {
  check(`recognizes signed out: ${text.slice(0, 28)}`,
    classifyReadiness(true, { ok: false, text }).readiness === "unauthorized", text);
}

// ---- these are not signed out; misjudging them sends people to sign in for nothing ----
for (const text of [
  "rate limit exceeded, try again later",
  "Error: connect ECONNREFUSED 127.0.0.1:443",
  "getaddrinfo ENOTFOUND api.example.com",
  "network unreachable",
  "server overloaded",
  "request timeout"
]) {
  check(`not misjudged as signed out: ${text.slice(0, 28)}`,
    classifyReadiness(true, { ok: false, text }).readiness === "error", text);
}

// ---- feature/policy denials after a successful sign-in are kept separate from real auth expiry ----
for (const text of [
  '403 "unauthorized: not authorized to use this Copilot feature\\n"',
  'unauthorized: not authorized to use this Copilot feature',
  '403 unauthorized: insufficient_scope'
]) {
  const result = classifyReadiness(true, { ok: false, text });
  check(`feature restriction does not prompt re-login: ${text}`, result.readiness === 'error', result);
  check('feature denial keeps the original reason', result.detail === text, result);
  check('lifecycle check does not treat feature denial as signed out either', !looksUnauthorized(text));
}

// ---- 403 from other Agents still prompts re-login (e.g. org token revoked) ----
for (const text of [
  '403 Forbidden',
  '403',
  'Error: 403 {"type":"error","error":{"type":"permission_error"}}',
  '403 unauthorized: access denied',
  'Authentication failed: access denied'
]) {
  check(`403/auth denial is still judged signed out: ${text}`,
    classifyReadiness(true, { ok: false, text }).readiness === 'unauthorized', text);
  check(`lifecycle check also judges signed out: ${text}`, looksUnauthorized(text));
}

// ---- insufficient local file permissions are not a sign-in problem ----
for (const text of [
  'permission denied',
  "EACCES: permission denied, open '/Users/me/.codex/credentials.json'",
  "EPERM: operation not permitted, open '/Users/me/.claude/.credentials.json'"
]) {
  check(`local permission error not misjudged as signed out: ${text.slice(0, 28)}`,
    classifyReadiness(true, { ok: false, text }).readiness === 'error', text);
}
check('403 with explicitly expired credentials still prompts re-login',
  classifyReadiness(true, { ok: false, text: '403: token expired; please sign in' }).readiness === 'unauthorized');

// ---- a separate state when balance or monthly quota is truly exhausted ----
for (const text of [
  "You've reached your credit usage limit. Please upgrade your subscription.",
  "Your credit balance is too low",
  "quota exhausted for this month",
  "You've hit your 5-hour limit · resets 2:50am (Asia/Singapore)",
  "You've hit your session limit · resets 2:50am (Asia/Singapore)",
  "本月额度已耗尽",
  "You've hit your session limit · resets 3:10am (Asia/Singapore)",
  "You’ve reached your weekly limit · resets Sep 10"
]) {
  check(`recognizes quota exhausted: ${text.slice(0, 28)}`,
    classifyReadiness(true, { ok: false, text }).readiness === "exhausted", text);
}

// When a quota error mentions 401, "quota" wins -- signing in will not fix a quota
check("quota + 401 is judged exhausted",
  classifyReadiness(true, { ok: false, text: "401: credit balance too low" }).readiness === "exhausted");

const sessionLimit = "You've hit your session limit · resets 3:10am (Asia/Singapore)";
check("session quota exhausted keeps the reset time", classifyReadiness(true, {ok:false,text:sessionLimit}).detail === sessionLimit);
check("concurrent session limit is not usage exhaustion", !looksExhausted("maximum concurrent session limit exceeded"));

// ---- detail keeps only one line ----
const long = classifyReadiness(true, {
  ok: false,
  text: "  \n\nError: something broke\n    at foo (bar.js:1:1)\n    at baz"
});
check("detail takes the first non-empty line", long.detail === "Error: something broke", long.detail);
check("detail has a length limit",
  (classifyReadiness(true, { ok: false, text: "x".repeat(500) }).detail ?? "").length <= 200);

// ---- edge cases ----
check("empty text is not signed out", looksUnauthorized("") === false);
check("ordinary rate limit is not quota exhaustion", looksExhausted("rate limit exceeded") === false);
check("ordinary failure is not signed out", looksUnauthorized("command not found") === false);
check("failure without text is still error",
  classifyReadiness(true, { ok: false, text: "" }).readiness === "error");

console.log(`readiness: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
