import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tm } from "../i18n";
import { describeError } from "../orchestration/diagnostics";
import { p } from "../prompt-language";
import type { ReleaseChannel } from "../shared/release";

/**
 * ADing account session; runs only in the main process.
 *
 * The renderer's CSP only allows same-origin requests, so backend access and token storage live here.
 * Tokens are encrypted with system-provided encryption before hitting disk (Electron safeStorage; on macOS the key is held by the Keychain);
 * without system encryption they stay in memory only and expire when the app quits — never written to disk in plaintext.
 *
 * After sign-in, this computer is also registered in the cloud (idempotent by hardware UUID hash), and the computer token is saved with the session.
 */

export interface AccountUser {
  userId: string;
  username: string;
  displayName: string;
}

export type AccountStatus =
  | { signedIn: false }
  | { signedIn: true; user: AccountUser; canAddFriend?: boolean; onboardingEligible?: boolean };

/** Result for the renderer. Returned rather than thrown: errors thrown over IPC get wrapped by Electron with an English prefix. */
export type AccountResult =
  | { ok: true; status: AccountStatus }
  | { ok: false; message: string };

/** Cloud registration result for this computer. The computer token is used only in the main process, never given to the renderer */
export interface ComputerRegistration {
  terminalId: string;
  name: string;
  nodeToken: string;
  /** Hardware UUID hash used at registration */
  fingerprint: string;
}

export type ComputerResult =
  | { ok: true; computer: ComputerRegistration }
  | { ok: false; kind: Failure["kind"] | "signed-out"; message: string };

/**
 * System encryption. Fully async: macOS may show a Keychain authorization prompt the first time the key is fetched,
 * and a sync API would block the whole main process while waiting, so no window could even open.
 */
export interface SecretBox {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "DELETE";

export type FetchLike = (
  url: string,
  init: { method: ApiMethod; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<HttpResponse>;

/**
 * Result of calling the backend with the sign-in token. code is the backend business error code (e.g. TASK_005),
 * which callers use to tell "already in this state" from a real failure.
 */
export type ApiResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: Failure["kind"] | "signed-out"; status: number; code?: string; message: string };

export interface AccountSessionOptions {
  /** The dev channel skips the region restriction on adding friends; other channels follow server permissions. */
  channel?: ReleaseChannel;
  /** Backend base URL, e.g. https://www.coffeestudy.com.cn */
  baseUrl: string;
  /** Encrypted session file */
  file: string;
  secrets: SecretBox;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Diagnostic log. The UI only says "can't connect" for network failures; the cause (with its cause chain) is preserved only here */
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** The server doesn't offer online mode in the current region (mainland China): the session is signed out; the caller must switch to offline mode and tell the user */
  onRegionBlocked?: (message: string) => void;
}

/** Server error code for "online service not available in this region" */
const REGION_BLOCKED = "REGION_001";

interface Session {
  accessToken: string;
  refreshToken: string;
  user: AccountUser;
  canAddFriend?: boolean;
  onboardingEligible?: boolean;
  computer?: ComputerRegistration;
}

/**
 * rejected: the server explicitly refused (wrong password, invalid token); the reason must be shown to the user;
 * network / server: transient failures; they don't mean the account has a problem.
 */
type Failure = { kind: "rejected" | "network" | "server"; message: string; status: number; code?: string };
type Success = { kind: "ok"; data: unknown };

const NETWORK_MESSAGE = () => tm("svc.account.network");
const SERVER_MESSAGE = () => tm("svc.account.server");

export class AccountSession {
  private session: Session | undefined;
  /** Changes on every sign-in, sign-out and token refresh. Used to tell whether a slow restore result is stale */
  private changes = 0;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: AccountSessionOptions) {
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  status(): AccountStatus {
    return this.session
      ? {
          signedIn: true,
          user: { ...this.session.user },
          ...(this.session.onboardingEligible === undefined ? {} : { onboardingEligible: this.session.onboardingEligible }),
          ...(this.options.channel === "develop"
            ? { canAddFriend: true }
            : this.session.canAddFriend === undefined ? {} : { canAddFriend: this.session.canAddFriend })
        }
      : { signedIn: false };
  }

  /** Registration result for this computer; empty until registration succeeds */
  computer(): ComputerRegistration | undefined {
    return this.session?.computer && { ...this.session.computer };
  }

  /**
   * Restores the last saved session. Reads only the local file, no network.
   * Decryption may wait for the user to approve Keychain access; if the user signs in or out meanwhile, the user's action wins.
   */
  async init(): Promise<AccountStatus> {
    const startedAt = this.changes;
    let data: Buffer;
    try {
      data = await readFile(this.options.file);
    } catch {
      return this.status();
    }
    try {
      if (!(await this.options.secrets.available())) throw new Error(p("系统加密不可用", "System encryption is unavailable"));
      const restored = parseSession(JSON.parse(await this.options.secrets.decrypt(data)));
      if (!restored) throw new Error(p("会话文件内容无效", "The session file content is invalid"));
      // The IP may have changed; old permissions on disk can't be trusted for the current region.
      delete restored.canAddFriend;
      if (this.changes === startedAt) this.session = restored;
    } catch {
      // Can't decrypt (app re-signed, Keychain access denied) or content corrupted: treat as signed out and let the user sign in again.
      // But if the user signed in meanwhile, the file is a new session and must not be deleted
      if (this.changes === startedAt) await rm(this.options.file, { force: true });
    }
    return this.status();
  }

  async login(username: string, password: string): Promise<AccountResult> {
    const name = username.trim();
    if (!name) return fail(tm("svc.account.usernameRequired"));
    if (!password) return fail(tm("svc.account.passwordRequired"));
    return this.authenticate("/api/v1/auth/login", { username: name, password });
  }

  /**
   * Registration only creates the account without signing in: afterwards return to the sign-in screen so the user signs in once with the new password.
   * The backend register API also returns tokens; they are deliberately discarded and never saved.
   */
  async register(username: string, password: string): Promise<AccountResult> {
    const name = username.trim();
    // Keep username rules consistent with the backend RegisterRequest so the server's English validation messages aren't shown to users verbatim.
    // No password length/complexity rules for now; whatever the user sets is accepted. Only empty passwords are rejected.
    if (!name) return fail(tm("svc.account.usernameRequired"));
    if (name.length > 64) return fail(tm("svc.account.usernameTooLong"));
    if (!password) return fail(tm("svc.account.passwordRequired"));
    const result = await this.requestSession("/api/v1/auth/register", { username: name, password });
    if (!("session" in result)) return fail(result.message);
    return { ok: true, status: this.status() };
  }

  /**
   * Changes the account password.
   *
   * After a password change the backend revokes **all** previously issued tokens — someone else having seen the password is a common reason to change it,
   * and keeping old tokens would defeat the change. This includes the local tokens, so the backend returns a new pair in the response,
   * which is swapped in immediately so the user's own machine isn't signed out.
   *
   * The computer token is revoked too and isn't in this response: the registration result is dropped on save, and the caller re-registers this computer for a new one.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<AccountResult> {
    const current = this.session;
    if (!current) return fail(tm("svc.account.notSignedIn"));
    const result = await this.api("POST", "/api/v1/auth/password", { currentPassword, newPassword });
    if (!result.ok) return fail(result.message);
    // The user signed out or switched accounts during the request: the password did change, but these tokens don't belong to the current session; discard them
    if (!this.session || this.session.user.userId !== current.user.userId) {
      return { ok: true, status: this.status() };
    }
    const renewed = parseSession(result.data);
    if (!renewed) return fail(SERVER_MESSAGE());
    await this.save(renewed);
    return { ok: true, status: this.status() };
  }

  /** Backend tokens are stateless with no logout API; signing out just discards the locally saved tokens. */
  async logout(): Promise<AccountStatus> {
    this.changes++;
    this.session = undefined;
    await rm(this.options.file, { force: true });
    return this.status();
  }

  /** Reads permissions determined by the current IP and allowlist from the backend; on failure the current session is kept. */
  async refreshRegionPermissions(): Promise<AccountStatus> {
    const current = this.session;
    if (!current) return this.status();
    const generation = this.changes;
    const result = await this.api("GET", "/api/v1/auth/region-policy");
    // Discard stale responses if the account changed. If tokens were refreshed meanwhile, the new token response already carries region permissions.
    if (this.changes !== generation || this.session !== current) return this.status();
    const data = result.ok ? (result.data as { canAddFriend?: unknown; onboardingEligible?: unknown } | null) : null;
    if (typeof data?.onboardingEligible === "boolean") current.onboardingEligible = data.onboardingEligible;
    if (typeof data?.canAddFriend === "boolean") current.canAddFriend = data.canAddFriend;
    return this.status();
  }

  /**
   * Uses the refresh token to confirm the session is still valid, getting a new token pair along the way.
   * Sign out only on explicit server rejection; keep the session when the network is down —
   * the dev build can't reach the NAS off the home network, and that mustn't sign the user out.
   */
  async revalidate(): Promise<AccountStatus> {
    const current = this.session;
    if (!current) return this.status();
    const result = await this.requestSession("/api/v1/auth/refresh", {
      refreshToken: current.refreshToken
    });
    // The user signed out or switched accounts during the request; discard this result
    if (this.session !== current) return this.status();
    // Refreshing tokens doesn't change the computer: keep the existing registration
    if ("session" in result) await this.save({ ...result.session, computer: current.computer });
    else if (result.kind === "rejected" && result.code === REGION_BLOCKED) await this.dropForRegion(result.message);
    else if (result.kind === "rejected") await this.logout();
    return this.status();
  }

  /**
   * Registers this computer in the cloud. The server is idempotent by (account, fingerprint), so it's safe to call on every sign-in and launch,
   * which also syncs a changed computer name.
   *
   * Access tokens expire after two hours and leaving the app open overnight is common: on an invalid token, refresh once and retry.
   * If the user signs out or switches accounts during registration, the result is discarded; the old account's computer must not be written into the new session.
   */
  async registerComputer(identity: { fingerprint: string; name: string; appVersion?: string; osVersion?: string }): Promise<ComputerResult> {
    const userId = this.session?.user.userId;
    const result = await this.api("POST", "/api/v1/terminals/register", {
      fingerprint: identity.fingerprint,
      name: identity.name,
      type: "DESKTOP",
      ...(identity.appVersion ? { appVersion: identity.appVersion } : {}),
      ...(identity.osVersion ? { osVersion: identity.osVersion } : {})
    });
    if (!result.ok) return { ok: false, kind: result.kind, message: result.message };
    const owner = this.session;
    if (!owner || owner.user.userId !== userId) return signedOut();
    const computer = parseComputer(result.data, identity.fingerprint);
    if (!computer) return { ok: false, kind: "server", message: SERVER_MESSAGE() };
    await this.save({ ...owner, computer });
    return { ok: true, computer: { ...computer } };
  }

  /**
   * Calls the backend with the sign-in token. Access tokens expire after two hours and leaving the app open overnight is common:
   * on an invalid token, refresh once and retry. If the user signs out or switches accounts during the request, the result is discarded.
   */
  async api(method: ApiMethod, route: string, body?: object): Promise<ApiResult> {
    const current = this.session;
    if (!current) return { ok: false, kind: "signed-out", status: 0, message: tm("svc.account.notSignedIn") };

    let result = await this.call(route, body, current.accessToken, method);
    if (result.kind === "rejected" && result.status === 401 && this.session === current) {
      await this.revalidate();
      const renewed = this.session;
      if (!renewed || renewed.user.userId !== current.user.userId) {
        return { ok: false, kind: "signed-out", status: 0, message: tm("svc.account.sessionChanged") };
      }
      result = await this.call(route, body, renewed.accessToken, method);
    }

    const owner = this.session;
    if (!owner || owner.user.userId !== current.user.userId) {
      return { ok: false, kind: "signed-out", status: 0, message: tm("svc.account.sessionChanged") };
    }
    if (result.kind === "ok") return { ok: true, data: result.data };
    if (result.code === REGION_BLOCKED) return this.dropForRegion(result.message);
    return { ok: false, kind: result.kind, status: result.status, code: result.code, message: result.message };
  }

  /**
   * Calls the backend with the computer token (e.g. to register local agents). The computer token is valid for a year and needs no refresh;
   * if the user signs out or switches accounts during the request, the result is discarded.
   */
  async nodeApi(method: ApiMethod, route: string, body?: object): Promise<ApiResult> {
    const current = this.session;
    const token = current?.computer?.nodeToken;
    if (!current || !token) return { ok: false, kind: "signed-out", status: 0, message: tm("svc.account.computerNotRegistered") };
    const result = await this.call(route, body, token, method);
    if (!this.session || this.session.user.userId !== current.user.userId) {
      return { ok: false, kind: "signed-out", status: 0, message: tm("svc.account.sessionChanged") };
    }
    if (result.kind === "ok") return { ok: true, data: result.data };
    if (result.code === REGION_BLOCKED) return this.dropForRegion(result.message);
    return { ok: false, kind: result.kind, status: result.status, code: result.code, message: result.message };
  }

  /** Online mode isn't offered in this region: sign out (local data untouched) and let the caller switch to offline mode */
  private async dropForRegion(message: string): Promise<ApiResult & { ok: false }> {
    this.options.log?.("account-region-blocked", {});
    await this.logout();
    this.options.onRegionBlocked?.(message);
    return { ok: false, kind: "signed-out", status: 403, code: REGION_BLOCKED, message };
  }

  private async authenticate(route: string, body: object): Promise<AccountResult> {
    const result = await this.requestSession(route, body);
    if (!("session" in result)) return fail(result.message);
    await this.save(result.session);
    return { ok: true, status: this.status() };
  }

  private async requestSession(route: string, body: object): Promise<{ session: Session } | Failure> {
    const result = await this.call(route, body);
    if (result.kind !== "ok") return result;
    const session = parseSession(result.data);
    return session ? { session } : { kind: "server", message: SERVER_MESSAGE(), status: 200 };
  }

  private async call(
    route: string,
    body: object | undefined,
    accessToken?: string,
    method: ApiMethod = "POST"
  ): Promise<Success | Failure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status = 0;
    let text = "";
    try {
      const response = await this.fetch(`${this.options.baseUrl}${route}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      this.options.log?.("account-request-failed", { method, route, error: describeError(error) });
      return { kind: "network", message: NETWORK_MESSAGE(), status: 0 };
    } finally {
      clearTimeout(timer);
    }

    let payload: { code?: unknown; message?: unknown; data?: unknown } | undefined;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    // 5xx, or the response isn't backend JSON at all (e.g. a reverse proxy error page)
    if (status >= 500 || !payload || typeof payload !== "object") {
      return { kind: "server", message: SERVER_MESSAGE(), status };
    }
    if (payload.code === "OK") return { kind: "ok", data: payload.data };
    // The server returns Chinese text; this one is phrased in the UI language
    const message = payload.code === REGION_BLOCKED
      ? tm("svc.account.regionUnavailable")
      : typeof payload.message === "string" && payload.message.trim()
        ? payload.message
        : tm("svc.account.requestFailed");
    return {
      kind: "rejected",
      message,
      status,
      ...(typeof payload.code === "string" ? { code: payload.code } : {})
    };
  }

  private async save(session: Session): Promise<void> {
    this.changes++;
    this.session = session;
    if (!(await this.options.secrets.available())) return;
    const file = this.options.file;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, await this.options.secrets.encrypt(JSON.stringify(session)), {
      mode: 0o600
    });
    await rename(temporary, file);
  }
}

function fail(message: string): AccountResult {
  return { ok: false, message };
}

function signedOut(): ComputerResult {
  return { ok: false, kind: "signed-out", message: tm("svc.account.sessionChanged") };
}

function parseComputer(value: unknown, fingerprint: string): ComputerRegistration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const terminalId = data.terminalId;
  if (typeof terminalId !== "string" || typeof data.nodeToken !== "string") return undefined;
  return {
    terminalId,
    name: typeof data.name === "string" ? data.name : "",
    nodeToken: data.nodeToken,
    fingerprint
  };
}

function parseSession(value: unknown): Session | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const user = data.user as Record<string, unknown> | undefined;
  if (
    typeof data.accessToken !== "string" ||
    typeof data.refreshToken !== "string" ||
    !user ||
    typeof user.userId !== "string" ||
    typeof user.username !== "string"
  ) {
    return undefined;
  }
  const saved = data.computer as Record<string, unknown> | undefined;
  const computer =
    saved && typeof saved.fingerprint === "string" ? parseComputer(saved, saved.fingerprint) : undefined;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: {
      userId: user.userId,
      username: user.username,
      displayName:
        typeof user.displayName === "string" && user.displayName ? user.displayName : user.username
    },
    ...(typeof data.onboardingEligible === "boolean" ? { onboardingEligible: data.onboardingEligible } : {}),
    ...(typeof data.canAddFriend === "boolean" ? { canAddFriend: data.canAddFriend } : {}),
    ...(computer ? { computer } : {})
  };
}
