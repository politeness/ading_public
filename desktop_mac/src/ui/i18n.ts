/**
 * UI language (renderer side).
 *
 * Copy is split by source into several dictionaries under ./locales/, each entry written in both Chinese and English,
 * so keys are naturally consistent across languages, and a missing translation fails to compile.
 *
 * - Static HTML: `data-i18n="key"` on an element replaces textContent,
 *   `data-i18n-attr="placeholder:key;aria-label:key2"` replaces attributes.
 *   Buttons with icons must wrap the text in `<span data-i18n>`; never replace the whole button's textContent.
 * - Dynamic copy: `t("key", { name })`, placeholders written as `{name}`.
 *
 * The language is stored in localStorage (synchronously readable at startup, so the first screen doesn't flash Chinese) and also sent to the main process,
 * so native dialogs and errors the main process throws to the UI switch along. After switching language the whole page reloads,
 * replacing all dynamically rendered text at once without chasing each view to refresh.
 */
import { htmlMessages } from "./locales/html.js";
import { rendererMessages } from "./locales/renderer.js";
import { moduleMessages } from "./locales/modules.js";

export type Language = "zh-CN" | "en";
export type Entry = { readonly zh: string; readonly en: string };
export type Catalog = Readonly<Record<string, Entry>>;

const catalog = { ...htmlMessages, ...rendererMessages, ...moduleMessages };
export type MessageKey = keyof typeof catalog;

export const LANGUAGE_KEY = "ading.language";

function readLanguage(): Language {
  try {
    return localStorage.getItem(LANGUAGE_KEY) === "en" ? "en" : "zh-CN";
  } catch {
    return "zh-CN";
  }
}

const language: Language = readLanguage();

export function currentLanguage(): Language {
  return language;
}

/** Locale for Intl */
export function intlLocale(): string {
  return language === "en" ? "en-US" : "zh-CN";
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const entry: Entry | undefined = (catalog as Catalog)[key as string];
  if (!entry) return String(key);
  const text = language === "en" ? entry.en : entry.zh;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  );
}

/** Replace all data-i18n / data-i18n-attr markers under root with the current language */
export function applyTranslations(root: ParentNode = document): void {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-i18n]"))) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key as MessageKey);
  }
  for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-i18n-attr]"))) {
    for (const pair of (node.dataset.i18nAttr ?? "").split(";")) {
      const [attribute, key] = pair.split(":").map((part) => part.trim());
      if (attribute && key) node.setAttribute(attribute, t(key as MessageKey));
    }
  }
}

/** Call once at startup: translate the static page, set html lang, and sync the current language to the main process */
export function installLanguage(syncToMain?: (language: Language) => unknown): void {
  document.documentElement.lang = language;
  applyTranslations();
  try {
    void Promise.resolve(syncToMain?.(language)).catch(() => undefined);
  } catch {
    // If the main process doesn't receive it, only native dialog language is affected; the UI works as usual
  }
}

/** Save the new language and reload the page; do nothing if the language didn't change */
export async function switchLanguage(
  next: Language,
  syncToMain?: (language: Language) => unknown
): Promise<void> {
  if (next === language) return;
  try {
    localStorage.setItem(LANGUAGE_KEY, next);
  } catch {
    // If it can't be stored, only remembering this choice is affected
  }
  try {
    await syncToMain?.(next);
  } catch {
    // Same as above
  }
  location.reload();
}
