/**
 * Validation and normalization of human profile fields.
 *
 * The standalone user profile (LocalStore's profile.json) and the signed-in account profile (account/profiles)
 * share this one set of rules: both sides' messages and limits must match, so we don't write two.
 */
import { tm } from "../i18n";

export function normalizeDisplayName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error(tm("main.profile.nameEmpty"));
  if (name.length > 30) throw new Error(tm("main.profile.nameTooLong"));
  return name;
}

/** Empty string means clear the avatar */
export function normalizeAvatarUrl(value: string): string | undefined {
  if (value && !value.startsWith("data:image/")) throw new Error(tm("main.profile.avatarInvalid"));
  if (value.length > 1_400_000) throw new Error(tm("main.profile.avatarTooLarge"));
  return value || undefined;
}

export function normalizePhone(value: string): string | undefined {
  const phone = value.trim();
  if (phone.length > 30) throw new Error(tm("main.profile.phoneTooLong"));
  return phone || undefined;
}

export function normalizeEmail(value: string): string | undefined {
  const email = value.trim();
  if (email.length > 254) throw new Error(tm("main.profile.emailTooLong"));
  return email || undefined;
}
