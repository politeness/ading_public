/**
 * UI language (main-process side).
 *
 * Native dialogs shown by the main process itself, errors thrown for the UI to display, and update and install prompts
 * all follow the user's choice in "Settings -> Language". When the renderer starts or switches language
 * it tells the main process via `app:set-language`, and the main process saves it in userData
 * so the next launch (dialogs before the window appears) can use it too.
 *
 * Dictionaries live under ./locales/ (main / services / orchestration); each entry has both Chinese and English.
 * Prompts sent to Agents and text written to logs don't go through here and stay as they are.
 */
import fs from "node:fs";
import { mainMessages } from "./locales/main.js";
import { servicesMessages } from "./locales/services.js";
import { orchestrationMessages } from "./locales/orchestration.js";
import { writePreference } from "./platform/preferences.js";

export type Language = "zh-CN" | "en";
export type Entry = { readonly zh: string; readonly en: string };
export type Catalog = Readonly<Record<string, Entry>>;
const catalog = { ...mainMessages, ...servicesMessages, ...orchestrationMessages };
export type MainMessageKey = keyof typeof catalog;

let language: Language = "zh-CN";
let preferenceFile: string | undefined;

export function normalizeLanguage(value: unknown): Language {
  return value === "en" ? "en" : "zh-CN";
}

export function mainLanguage(): Language {
  return language;
}

/** Reads back the last saved language from userData; stays Chinese if it can't be read */
export function loadMainLanguage(file: string): Language {
  preferenceFile = file;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { language?: unknown };
    language = normalizeLanguage(saved.language);
  } catch {
    language = "zh-CN";
  }
  return language;
}

export function setMainLanguage(value: unknown): Language {
  language = normalizeLanguage(value);
  // Failing to save only affects the dialog language before the first screen on next launch; other preferences in the same file are kept
  if (preferenceFile) writePreference(preferenceFile, "language", language);
  return language;
}

export function tm(key: MainMessageKey, params?: Record<string, string | number>): string {
  const entry: Entry | undefined = (catalog as Catalog)[key as string];
  if (!entry) return String(key);
  const text = language === "en" ? entry.en : entry.zh;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  );
}
