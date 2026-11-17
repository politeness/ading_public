/**
 * Prompts sent to Agents, system messages the scheduler writes into chat, and execution progress text follow the UI language.
 *
 * User decision on 2026-09-19: users of the English UI shouldn't see Chinese AI output, so the prompts themselves switch language too;
 * system messages are written in the UI language at generation time, and historical messages keep their original language without retroactive translation.
 *
 * The pattern is Chinese and English side by side in place: p("Chinese", "English"). There are hundreds of prompt sentences, and putting them in a locale bundle keyed by ID would hide
 * the original text when reading code and make review hard; side by side, you can see at a glance whether the two match.
 * The English is a faithful translation that doesn't change the meaning; changing prompts (in either language) still requires user approval first.
 * Text written to logs and regexes used to parse replies don't go through here.
 */
import { mainLanguage } from "./i18n";

export function p(zh: string, en: string): string {
  return mainLanguage() === "en" ? en : zh;
}

export function isEnglish(): boolean {
  return mainLanguage() === "en";
}
