import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AccountUser } from "./session";
import {
  normalizeAvatarUrl,
  normalizeDisplayName,
  normalizeEmail,
  normalizePhone
} from "../store/profile-patch";

/**
 * Profile of the signed-in account: nickname, avatar, phone number, email.
 *
 * The backend has no profile API yet, so it's stored locally by account userId and will be synced once an API exists.
 * It is completely separate from the offline-mode own profile (LocalStore's profile.json):
 * signing in, signing out and switching accounts never touch the offline copy.
 */

export interface AccountProfile {
  userId: string;
  /** From the account itself, read-only */
  username: string;
  displayName: string;
  avatarUrl?: string;
  phone?: string;
  email?: string;
}

export interface AccountProfilePatch {
  displayName?: string;
  avatarUrl?: string;
  phone?: string;
  email?: string;
}

type StoredProfile = Omit<AccountProfile, "userId" | "username">;

export class AccountProfiles {
  /**
   * Reads the file only once; all callers share the same result object.
   * If each load read the file and assigned the cache separately, concurrent saves at startup would each get their own object and overwrite each other on disk.
   */
  private loading: Promise<Record<string, StoredProfile>> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** For accounts with no saved profile, the nickname defaults to the account nickname */
  async get(user: AccountUser): Promise<AccountProfile> {
    const stored = (await this.load())[user.userId];
    return {
      userId: user.userId,
      username: user.username,
      displayName: stored?.displayName || user.displayName,
      avatarUrl: stored?.avatarUrl,
      phone: stored?.phone,
      email: stored?.email
    };
  }

  /**
   * Read-modify-write is fully serialized: concurrent saves (even of different fields) never overwrite others' changes with stale data;
   * a previous failure must not block later saves.
   */
  update(user: AccountUser, patch: AccountProfilePatch): Promise<AccountProfile> {
    const run = this.queue.catch(() => undefined).then(() => this.apply(user, patch));
    this.queue = run;
    return run;
  }

  private async apply(user: AccountUser, patch: AccountProfilePatch): Promise<AccountProfile> {
    const current = await this.get(user);
    // Validate all fields first: if any is invalid, the whole change is rejected, leaving nothing half-applied
    const next: StoredProfile = {
      displayName:
        patch.displayName !== undefined ? normalizeDisplayName(patch.displayName) : current.displayName,
      avatarUrl: patch.avatarUrl !== undefined ? normalizeAvatarUrl(patch.avatarUrl) : current.avatarUrl,
      phone: patch.phone !== undefined ? normalizePhone(patch.phone) : current.phone,
      email: patch.email !== undefined ? normalizeEmail(patch.email) : current.email
    };
    const all = await this.load();
    // Write to disk first and update memory only on success: on write failure memory stays consistent with disk
    await this.write({ ...all, [user.userId]: next });
    all[user.userId] = next;
    return this.get(user);
  }

  private load(): Promise<Record<string, StoredProfile>> {
    this.loading ??= readFile(this.file, "utf8")
      .then((text) => {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, StoredProfile>)
          : {};
      })
      .catch(() => ({}));
    return this.loading;
  }

  private async write(all: Record<string, StoredProfile>): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
