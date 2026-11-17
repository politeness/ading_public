import { mkdtemp } from "./tmp.mjs";
import os from "node:os";
import path from "node:path";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { AgentLifecycleService, AGENT_LIFECYCLE_SPECS, parseAgentAuthStatus } from "../dist/agents/lifecycle.js";
import { deniedPaths, redactDiagnosticText, probeDeniedPath } from "../dist/agents/lifecycle-diagnostics.js";

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

check("Codex signed-in status", parseAgentAuthStatus("codex", "Logged in using ChatGPT").state === "signed-in");
check("Codex sign-in detail ignores leading warnings", parseAgentAuthStatus("codex", "WARNING: path unavailable\nLogged in using ChatGPT").detail === "Logged in using ChatGPT");
check("Codex signed-out status", parseAgentAuthStatus("codex", "Not logged in").state === "signed-out");
check("Claude JSON signed-in status", parseAgentAuthStatus("claude-code", '{"loggedIn":true}').state === "signed-in");
check("Claude JSON signed-out status", parseAgentAuthStatus("claude-code", '{"loggedIn":false}').state === "signed-out");
check("Qoder JSON signed-in status", parseAgentAuthStatus("qoder", '{"logged_in":true}').state === "signed-in");
check("Qoder JSON signed-out status", parseAgentAuthStatus("qoder", '{"logged_in":false}').state === "signed-out");
check("Qoder CN JSON signed-in status", parseAgentAuthStatus("qoder-cn", '{"logged_in":true}').state === "signed-in");
check("Qoder CN JSON signed-out status", parseAgentAuthStatus("qoder-cn", '{"logged_in":false}').state === "signed-out");
check("Unknown output is not guessed", parseAgentAuthStatus("codex", "service unavailable").state === "unknown");

check("Lifecycle diagnostics extract the denied path", JSON.stringify(deniedPaths("Login failed: EPERM: operation not permitted, open '/Users/x/.qoder/.auth/machine_id'")) === JSON.stringify(["/Users/x/.qoder/.auth/machine_id"]));
check("Lifecycle diagnostics do not treat ordinary errors as permission issues", deniedPaths("Not logged in · Please run /login").length === 0);
check("Lifecycle diagnostics redact personal info in status output", (() => {
  const out = redactDiagnosticText('{"logged_in": true, "email": "a.b@example.com", "username": "someone", "avatar_url": "https://x/y.png?sig=1", "version": "1.1.55"}');
  return out.includes('"logged_in": true') && out.includes('"version": "1.1.55"') && !out.includes("example.com") && !out.includes("someone") && !out.includes("y.png");
})());
check("Lifecycle diagnostics redact emails in text", redactDiagnosticText("Logged in as a.b@example.com") === "Logged in as <邮箱已隐去>");
check("Lifecycle diagnostics redact authorization link parameters", redactDiagnosticText("open https://qoder.com/device/selectAccounts?challenge=abc&nonce=1 now") === "open https://qoder.com/device/selectAccounts?<已隐去> now");
{
  const probed = await probeDeniedPath(new URL(import.meta.url).pathname);
  check("Main-process probe can open a readable file without reading content", probed.appCanOpen === true && probed.parentAccess === "ok" && typeof probed.mode === "string" && !("content" in probed), probed);
  const missing = await probeDeniedPath("/nonexistent/ading/machine_id");
  check("Main-process probe gives an error code for a missing file", missing.appCanOpen === false && missing.appOpenError === "ENOENT", missing);
}

check("Codex official npm package", AGENT_LIFECYCLE_SPECS.codex.packageName === "@openai/codex");
check("Claude Code official npm package", AGENT_LIFECYCLE_SPECS["claude-code"].packageName === "@anthropic-ai/claude-code");
check("Qoder official npm package", AGENT_LIFECYCLE_SPECS.qoder.packageName === "@qoder-ai/qodercli");
check("Qoder CN official npm package", AGENT_LIFECYCLE_SPECS["qoder-cn"].packageName === "@qodercn-ai/qoderclicn");
check("Codex signs in with device auth", AGENT_LIFECYCLE_SPECS.codex.loginArgs.includes("--device-auth"));
check("Claude uses auth status", AGENT_LIFECYCLE_SPECS["claude-code"].statusArgs.join(" ") === "auth status");
check("Qoder uses JSON status", AGENT_LIFECYCLE_SPECS.qoder.statusArgs.join(" ") === "status -o json");
check("Qoder CN uses JSON status", AGENT_LIFECYCLE_SPECS["qoder-cn"].statusArgs.join(" ") === "status -o json");

const dir = await mkdtemp(path.join(os.tmpdir(), "ading-lifecycle-"));
const npmLog = path.join(dir, "npm.log");
const fakeNpm = path.join(dir, "npm");
await writeFile(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(npmLog)}, process.argv.slice(2).join(" ") + "\\n");
console.log("installed");
`);
await chmod(fakeNpm, 0o755);

const installPrefix = path.join(dir, "prefix");
await mkdir(path.join(installPrefix, "bin"), { recursive: true });
const brokenQoderShim = path.join(installPrefix, "bin", "qodercli");
await symlink(path.join(dir, "missing-qodercli"), brokenQoderShim);
const service = new AgentLifecycleService(fakeNpm, installPrefix);
const denied = await service.install("qoder", false);
check("Cannot install without confirmation", denied.ok === false && denied.requiresUserAction === true, denied);
const installProgress = [];
const installed = await service.install("qoder", true, text => installProgress.push(text));
check("Raw npm logs are not shown in the install progress bar", !installProgress.includes("installed") && installProgress.length > 0, installProgress);
check("Can install after confirmation", installed.ok === true, installed);
check("Install args are not shell-concatenated and land in the user directory",
  (await readFile(npmLog, "utf8")).trim() === `install -g --prefix ${installPrefix} @qoder-ai/qodercli`);
let staleShimRemoved = false;
try { await lstat(brokenQoderShim); } catch { staleShimRemoved = true; }
check("Removes stale launch links with the same name before installing", staleShimRemoved);

async function fakeAgent(kind) {
  const state = path.join(dir, `${kind}.state`);
  await writeFile(state, "in");
  const executable = path.join(dir, kind);
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
const signedIn = fs.readFileSync(state, "utf8").trim() === "in";
if (args.join(" ") === "login status") console.log(signedIn ? "Logged in using ChatGPT" : "Not logged in");
else if (args.join(" ") === "auth status") console.log(JSON.stringify({loggedIn:signedIn}));
else if (args.join(" ") === "status -o json") console.log(JSON.stringify({logged_in:signedIn}));
else if (args.includes("logout")) { fs.writeFileSync(state, "out"); console.log("Logged out"); }
else if (args.includes("login")) { fs.writeFileSync(state, "in"); console.error("Open authentication page"); console.log("Login completed"); }
else { console.error("unexpected args", args); process.exitCode = 2; }
`);
  await chmod(executable, 0o755);
  return { localUuid: `${kind}@test`, kind, name: kind, version: "test", executablePath: executable, nodeName: "test" };
}

const codex = await fakeAgent("codex");
check("Status command can detect signed-in", (await service.authStatus(codex)).state === "signed-in");
const logout = await service.logout(codex, true);
check("Codex can sign out and recheck status", logout.ok && logout.auth?.state === "signed-out", logout);
const loginProgress = [];
const login = await service.login(codex, true, (line) => loginProgress.push(line));
check("Codex can sign in and recheck status", login.ok && login.auth?.state === "signed-in", login);
check("Sign-in passes through auth prompts from stderr", loginProgress.includes("Open authentication page"), loginProgress);

const claude = await fakeAgent("claude-code");
check("Claude Code status command connected", (await service.authStatus(claude)).state === "signed-in");
const qoder = await fakeAgent("qoder");
check("Qoder status command connected", (await service.authStatus(qoder)).state === "signed-in");
const qoderLogout = await service.logout(qoder, true);
check("Qoder explicitly marks unsupported when there is no non-interactive sign-out", qoderLogout.unsupported === true && qoderLogout.requiresUserAction === true, qoderLogout);

console.log(`lifecycle: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
