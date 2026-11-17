/**
 * How Agent default names are displayed in the UI.
 *
 * Names stored in the database don't change with language: newly discovered Agents are registered with Chinese default names (小c / 小cc / 小q / 小q-cn, see the main process's
 * src/agents/default-names.ts; tests keep the two in sync). The English UI must not show Chinese, so Agents still using a default name
 * are displayed with the corresponding English name; names the user changed are shown as is. Prompts sent to Agents use the stored names and are unaffected.
 */
import { currentLanguage } from "./i18n.js";

export const AGENT_DEFAULT_NAMES: Readonly<Record<string, { zh: string; en: string }>> = {
  codex: { zh: "小c", en: "Cody" },
  "claude-code": { zh: "小cc", en: "Cleo" },
  qoder: { zh: "小q", en: "Quinn" },
  "qoder-cn": { zh: "小q-cn", en: "Quincy" },
  "qwen-code": { zh: "小qw", en: "Gwen" },
  kiro: { zh: "小k", en: "Kira" },
  copilot: { zh: "小cp", en: "Cooper" },
  antigravity: { zh: "小a", en: "Ava" }
};

/** Display name: in the English UI, Agents still using a Chinese default name get the English name */
export function localizedAgentName(kind: string | undefined, name: string, language = currentLanguage()): string {
  const names = kind ? AGENT_DEFAULT_NAMES[kind] : undefined;
  return names && language === "en" && name === names.zh ? names.en : name;
}

/** Name for saving: an unchanged English default name is saved back as the Chinese default, so switching back to the Chinese UI won't show English */
export function storedAgentName(kind: string | undefined, name: string): string {
  const names = kind ? AGENT_DEFAULT_NAMES[kind] : undefined;
  return names && name.trim() === names.en ? names.zh : name;
}

/** Replace Agent names in a user object with display names (doesn't modify the passed object) */
export function withLocalizedName<T extends { isAgent?: boolean; kind?: string; displayName: string }>(user: T): T {
  if (!user.isAgent) return user;
  const displayName = localizedAgentName(user.kind, user.displayName);
  return displayName === user.displayName ? user : { ...user, displayName };
}
