/**
 * userData/preferences.json: preferences the main process needs right at startup (before the window appears, or when running headless),
 * e.g. UI language and keeping the computer awake while running tasks. Each item is written separately; changing one won't wipe the others.
 */
import fs from "node:fs";
import path from "node:path";

export function readPreferences(file: string): Record<string, unknown> {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Failing to save only affects the default at next launch; callers don't need to handle failure */
export function writePreference(file: string, key: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...readPreferences(file), [key]: value }, null, 2));
  } catch {
    // Same as above
  }
}
