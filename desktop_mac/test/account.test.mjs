import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { AccountSession } from "../dist/account/session.js";

let passed = 0;

/** Fake system encryption: prefixed base64 that throws if it can't decrypt, matching how safeStorage fails; the interface is async like the real one */
const secrets = (available = true) => ({
  available: async () => available,
  encrypt: async (plain) => Buffer.from(`sealed:${Buffer.from(plain).toString("base64")}`),
  decrypt: async (data) => {
    const text = data.toString();
    if (!text.startsWith("sealed:")) throw new Error("not sealed");
    return Buffer.from(text.slice("sealed:".length), "base64").toString();
  }
});

/** Decryption hangs (simulating waiting for keychain authorization) until released manually */
function slowSecrets() {
  const base = secrets();
  let release;
  const box = {
    ...base,
    decrypt: (data) => new Promise((resolve, reject) => {
      release = () => base.decrypt(data).then(resolve, reject);
    })
  };
  const decrypting = async () => {
    while (!release) await new Promise((resolve) => setTimeout(resolve, 2));
  };
  return { box, decrypting, release: () => release() };
}

const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const tokens = (username = "alice", n = 1) =>
  json(200, {
    code: "OK",
    data: {
      accessToken: `a${n}`,
      refreshToken: `r${n}`,
      user: { userId: "u_1", username, displayName: "" }
    }
  });

function server(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    const route = new URL(url).pathname;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ route, body });
    const handler = handlers[route];
    if (!handler) throw new Error(`unexpected request to ${route}`);
    return handler(body);
  };
  return { fetch, calls };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const dir = await mkdtemp(path.join(os.tmpdir(), "ading-account-"));
let sequence = 0;
const fileFor = () => path.join(dir, `s${++sequence}`, "session.bin");
const make = (fetch, options = {}) =>
  new AccountSession({
    baseUrl: "https://example.test",
    file: options.file ?? fileFor(),
    secrets: options.secrets ?? secrets(),
    channel: options.channel,
    fetch,
    timeoutMs: options.timeoutMs
  });
const offline = async () => {
  throw new TypeError("fetch failed");
};

// Registration only creates the account without signing in: tokens the backend returns along the way aren't saved
{
  const file = fileFor();
  const api = server({ "/api/v1/auth/register": () => tokens("alice") });
  const session = make(api.fetch, { file });
  const result = await session.register("  alice  ", "long-enough");
  assert.deepEqual(result, { ok: true, status: { signedIn: false } });
  assert.deepEqual(api.calls[0].body, { username: "alice", password: "long-enough" });
  assert.equal(await exists(file), false, "registration doesn't persist a session");
  passed++;
}

// Successful login: the session is encrypted and persisted, and can be read back after restart without network
{
  const file = fileFor();
  const api = server({ "/api/v1/auth/login": () => tokens("alice") });
  const session = make(api.fetch, { file });
  const result = await session.login("  alice  ", "long-enough");
  assert.equal(result.ok, true);
  assert.deepEqual(result.status, {
    signedIn: true,
    user: { userId: "u_1", username: "alice", displayName: "alice" }
  });
  assert.deepEqual(api.calls[0].body, { username: "alice", password: "long-enough" });
  const raw = await readFile(file, "utf8");
  assert.ok(raw.startsWith("sealed:") && !raw.includes("refreshToken"), "tokens must not be written to disk in plaintext");
  const restored = make(offline, { file });
  assert.equal((await restored.init()).signedIn, true);
  passed++;
}

// Errors that can be detected locally don't send a request
{
  const api = server({});
  assert.deepEqual(await make(api.fetch).register("bob", ""), {
    ok: false,
    message: "请输入密码"
  });
  assert.deepEqual(await make(api.fetch).login("   ", "whatever"), {
    ok: false,
    message: "请输入用户名"
  });
  assert.deepEqual(await make(api.fetch).login("bob", ""), { ok: false, message: "请输入密码" });
  assert.equal(api.calls.length, 0);
  passed++;
}

// No password rules for now: even very short or all-space passwords are submitted to the backend as usual
{
  const api = server({ "/api/v1/auth/register": () => tokens("carol") });
  assert.equal((await make(api.fetch).register("carol", "1")).ok, true);
  assert.equal((await make(api.fetch).register("carol", "   ")).ok, true);
  assert.deepEqual(api.calls.map((c) => c.body.password), ["1", "   "]);
  passed++;
}

// Server rejection: relay the backend's Chinese reason verbatim without changing the sign-in state
{
  const api = server({
    "/api/v1/auth/login": () => json(401, { code: "AUTH_002", message: "用户名或密码不正确" })
  });
  const session = make(api.fetch);
  assert.deepEqual(await session.login("alice", "wrong-pass"), {
    ok: false,
    message: "用户名或密码不正确"
  });
  assert.equal(session.status().signedIn, false);
  passed++;
}

// No network, reverse-proxy error pages, and timeouts all get a human-readable message
{
  assert.deepEqual(await make(offline).login("alice", "long-enough"), {
    ok: false,
    message: "连不上阿钉服务器，请检查网络后重试"
  });
  const gateway = make(async () => ({ status: 502, text: async () => "<html>Bad Gateway</html>" }));
  assert.deepEqual(await gateway.login("alice", "long-enough"), {
    ok: false,
    message: "服务器暂时不可用，请稍后再试"
  });
  const hanging = make(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted")))
      ),
    { timeoutMs: 20 }
  );
  assert.deepEqual(await hanging.login("alice", "long-enough"), {
    ok: false,
    message: "连不上阿钉服务器，请检查网络后重试"
  });
  passed++;
}

// Logout: clear the session in memory and on disk
{
  const file = fileFor();
  const session = make(server({ "/api/v1/auth/login": () => tokens() }).fetch, { file });
  await session.login("alice", "long-enough");
  assert.equal(await exists(file), true);
  assert.deepEqual(await session.logout(), { signedIn: false });
  assert.equal(await exists(file), false);
  passed++;
}

// Startup revalidation: a successful refresh swaps in new tokens; no network keeps the sign-in state; only a server rejection signs out
{
  const file = fileFor();
  let refresh = () => tokens("alice", 2);
  const api = server({
    "/api/v1/auth/login": () => tokens("alice", 1),
    "/api/v1/auth/refresh": (body) => refresh(body)
  });
  const session = make(api.fetch, { file });
  await session.login("alice", "long-enough");

  assert.equal((await session.revalidate()).signedIn, true);
  assert.equal(api.calls.at(-1).body.refreshToken, "r1");

  refresh = () => {
    throw new TypeError("offline");
  };
  assert.equal((await session.revalidate()).signedIn, true, "no network keeps the sign-in state");
  assert.equal(api.calls.at(-1).body.refreshToken, "r2", "the new token from the previous refresh takes effect");

  refresh = () => json(401, { code: "AUTH_004", message: "访问令牌无效" });
  assert.equal((await session.revalidate()).signedIn, false, "only a server rejection signs out");
  assert.equal(await exists(file), false);
  passed++;
}

// User logs out while a refresh is still pending: the late new token must not sign them back in
{
  const file = fileFor();
  let release;
  const api = server({
    "/api/v1/auth/login": () => tokens(),
    "/api/v1/auth/refresh": () =>
      new Promise((resolve) => {
        release = () => resolve(tokens("alice", 9));
      })
  });
  const session = make(api.fetch, { file });
  await session.login("alice", "long-enough");
  const pending = session.revalidate();
  await new Promise((resolve) => setImmediate(resolve));
  await session.logout();
  release();
  assert.equal((await pending).signedIn, false);
  assert.equal(await exists(file), false);
  passed++;
}

// Restoring the old session is stuck on keychain authorization and the user signs in again meanwhile: the new login wins, the old session must not overwrite it, and the new session file must not be deleted
{
  const file = fileFor();
  await make(server({ "/api/v1/auth/login": () => tokens("old", 1) }).fetch, { file }).login("old", "pw");
  const slow = slowSecrets();
  const session = make(server({ "/api/v1/auth/login": () => tokens("new", 2) }).fetch, {
    file,
    secrets: slow.box
  });
  const restoring = session.init();
  await slow.decrypting();
  await session.login("new", "pw");
  slow.release();
  await restoring;
  assert.equal(session.status().user.username, "new");
  assert.equal(await exists(file), true);
  passed++;
}

// Restoring the old session is stuck on keychain authorization and the user logs out meanwhile: once released, the old session must not sign them back in
{
  const file = fileFor();
  await make(server({ "/api/v1/auth/login": () => tokens("old", 1) }).fetch, { file }).login("old", "pw");
  const slow = slowSecrets();
  const session = make(offline, { file, secrets: slow.box });
  const restoring = session.init();
  await slow.decrypting();
  await session.logout();
  slow.release();
  await restoring;
  assert.equal(session.status().signedIn, false);
  passed++;
}

// System encryption unavailable: sign in as usual, but keep it in memory only
{
  const file = fileFor();
  const session = make(server({ "/api/v1/auth/login": () => tokens() }).fetch, {
    file,
    secrets: secrets(false)
  });
  assert.equal((await session.login("alice", "long-enough")).ok, true);
  assert.equal(session.status().signedIn, true);
  assert.equal(await exists(file), false, "nothing is persisted when system encryption is unavailable");
  passed++;
}

// Session file can't be decrypted (signature changed, keychain cleared, content corrupted): treat as signed out and clear it
{
  const file = fileFor();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "not sealed at all");
  const session = make(offline, { file });
  assert.equal((await session.init()).signedIn, false);
  assert.equal(await exists(file), false);
  passed++;
}

// Register the computer: send the access token and upload only a hash of the hardware UUID; the computer token is encrypted and saved with the sign-in state and survives restart
{
  const file = fileFor();
  const seen = [];
  const fetch = async (url, init) => {
    const route = new URL(url).pathname;
    seen.push({ route, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (route === "/api/v1/auth/login") return tokens("alice", 1);
    if (route === "/api/v1/terminals/register") {
      return json(200, { code: "OK", data: { terminalId: "d_1", name: "MacBook", nodeToken: "sensitive-node-token-registration-fixture" } });
    }
    throw new Error(`unexpected request to ${route}`);
  };
  const session = make(fetch, { file });
  await session.login("alice", "pw");
  const fingerprint = "f".repeat(64);
  const result = await session.registerComputer({ fingerprint, name: "MacBook" });
  assert.equal(result.ok, true);
  assert.deepEqual(seen.at(-1), {
    route: "/api/v1/terminals/register",
    auth: "Bearer a1",
    body: { fingerprint, name: "MacBook", type: "DESKTOP" }
  });
  assert.equal(seen[0].auth, undefined, "login request carries no token");
  assert.ok(!(await readFile(file, "utf8")).includes("sensitive-node-token-registration-fixture"), "the computer token must not be written to disk in plaintext");
  const restored = make(offline, { file });
  await restored.init();
  assert.deepEqual(restored.computer(), { terminalId: "d_1", name: "MacBook", nodeToken: "sensitive-node-token-registration-fixture", fingerprint });
  passed++;
}

// Access token expired: refresh once, then register; later refreshes must not lose the registered computer
{
  let registerCalls = 0;
  const api = server({
    "/api/v1/auth/login": () => tokens("alice", 1),
    "/api/v1/auth/refresh": () => tokens("alice", 2),
    "/api/v1/terminals/register": () =>
      ++registerCalls === 1
        ? json(401, { code: "AUTH_005", message: "访问令牌已过期" })
        : json(200, { code: "OK", data: { terminalId: "d_1", name: "Mac", nodeToken: "n1" } })
  });
  const session = make(api.fetch);
  await session.login("alice", "pw");
  assert.equal((await session.registerComputer({ fingerprint: "f1", name: "Mac" })).ok, true);
  assert.deepEqual(api.calls.map((call) => call.route), [
    "/api/v1/auth/login",
    "/api/v1/terminals/register",
    "/api/v1/auth/refresh",
    "/api/v1/terminals/register"
  ]);
  await session.revalidate();
  assert.equal(session.computer()?.terminalId, "d_1", "token refresh keeps the computer registration");
  passed++;
}

// Can't reach the server: registration fails but the user stays signed in
{
  const api = server({
    "/api/v1/auth/login": () => tokens("alice", 1),
    "/api/v1/terminals/register": () => {
      throw new TypeError("fetch failed");
    }
  });
  const session = make(api.fetch);
  await session.login("alice", "pw");
  const result = await session.registerComputer({ fingerprint: "f1", name: "Mac" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "network");
  assert.equal(session.status().signedIn, true);
  assert.equal(session.computer(), undefined);
  passed++;
}

// User logs out while registration is pending: the late result is discarded and must not write the session back to disk
{
  const file = fileFor();
  let release;
  const api = server({
    "/api/v1/auth/login": () => tokens(),
    "/api/v1/terminals/register": () =>
      new Promise((resolve) => {
        release = () => resolve(json(200, { code: "OK", data: { terminalId: "d_1", name: "Mac", nodeToken: "n1" } }));
      })
  });
  const session = make(api.fetch, { file });
  await session.login("alice", "pw");
  const pending = session.registerComputer({ fingerprint: "f1", name: "Mac" });
  await new Promise((resolve) => setImmediate(resolve));
  await session.logout();
  release();
  assert.equal((await pending).ok, false);
  assert.equal(await exists(file), false);
  assert.equal(session.status().signedIn, false);
  passed++;
}

// Current region permissions follow sign-in and backend queries; offline failures don't sign out, and old permissions on disk aren't reused.
{
  let allowed = false;
  const file = fileFor();
  const api = server({
    "/api/v1/auth/login": () => json(200, { code: "OK", data: {
      accessToken: "a1", refreshToken: "r1", user: { userId: "u_1", username: "alice" }, canAddFriend: false
    } }),
    "/api/v1/auth/region-policy": () => json(200, { code: "OK", data: { canAddFriend: allowed } })
  });
  const session = make(api.fetch, { file });
  assert.equal((await session.login("alice", "pw")).status.canAddFriend, false);
  assert.equal(session.status().signedIn, true, "mainland region keeps online sign-in");
  allowed = true;
  assert.equal((await session.refreshRegionPermissions()).canAddFriend, true, "allowed for allowlist or overseas networks");
  allowed = false;
  assert.equal((await session.refreshRegionPermissions()).canAddFriend, false, "entry disabled after switching back to mainland");
  const restored = make(offline, { file });
  await restored.init();
  assert.equal(restored.status().canAddFriend, undefined, "old IP permissions aren't trusted after restart");
  assert.equal((await restored.refreshRegionPermissions()).signedIn, true, "a failed query doesn't sign out");
  passed++;
}

// Only the dev channel bypasses region permissions, covering sign-in, permission refresh, and offline restore; sign-in is still required after logout.
for (const channel of ["develop", "pre", "release"]) {
  const file = fileFor();
  const api = server({
    "/api/v1/auth/login": () => json(200, { code: "OK", data: {
      accessToken: "a1", refreshToken: "r1", user: { userId: "u_1", username: "alice" }, canAddFriend: false
    } }),
    "/api/v1/auth/region-policy": () => json(200, { code: "OK", data: { canAddFriend: false } })
  });
  const session = make(api.fetch, { file, channel });
  assert.deepEqual(session.status(), { signedIn: false });
  assert.equal((await session.login("alice", "pw")).status.canAddFriend, channel === "develop");
  assert.equal((await session.refreshRegionPermissions()).canAddFriend, channel === "develop");
  const restored = make(offline, { file, channel });
  assert.equal((await restored.init()).canAddFriend, channel === "develop" ? true : undefined);
  assert.equal((await restored.refreshRegionPermissions()).canAddFriend, channel === "develop" ? true : undefined);
  assert.deepEqual(await restored.logout(), { signedIn: false });
  passed++;
}

// A delayed region response must not sign the user back in or write old permissions into a new session.
{
  let release;
  const api = server({
    "/api/v1/auth/login": () => tokens(),
    "/api/v1/auth/region-policy": () => new Promise(resolve => { release = () => resolve(json(200, {
      code: "OK", data: { canAddFriend: true }
    })); })
  });
  const session = make(api.fetch);
  await session.login("alice", "pw");
  const pending = session.refreshRegionPermissions();
  await new Promise(resolve => setImmediate(resolve));
  await session.logout();
  await session.login("alice", "pw");
  release();
  await pending;
  assert.equal(session.status().canAddFriend, undefined);
  passed++;
}

// Eligibility survives encrypted session restore and updates on policy refresh.
{
  const file = fileFor();
  const api = server({
    "/api/v1/auth/login": () => json(200, {code:"OK", data:{accessToken:"a",refreshToken:"r",user:{userId:"u_preview",username:"preview",displayName:"Preview"},onboardingEligible:true}}),
    "/api/v1/auth/region-policy": () => json(200, {code:"OK",data:{canAddFriend:true,onboardingEligible:false}})
  });
  const session = make(api.fetch, {file});
  assert.equal((await session.login("preview", "long-enough")).status.onboardingEligible, true);
  const restored = make(api.fetch, {file});
  assert.equal((await restored.init()).onboardingEligible, true);
  assert.equal((await restored.refreshRegionPermissions()).onboardingEligible, false);
  passed++;
}

console.log(`account: ${passed} passed, 0 failed`);
