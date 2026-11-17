import { readFile } from "node:fs/promises";

/** JSON with comments/trailing commas; preserve strings verbatim and reject
 * malformed data. Provider settings may contain URLs, so regex stripping is unsafe. */
export async function readJsoncSettings(file: string): Promise<Record<string, any>> {
  let source: string;
  try { source = (await readFile(file, "utf8")).replace(/^\uFEFF/, ""); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  let cleaned = "", quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      cleaned += c;
      if (c === "\\") cleaned += source[++i] ?? "";
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; cleaned += c; }
    else if (c === "/" && source[i + 1] === "/") {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++;
      cleaned += " ";
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new SyntaxError("Unterminated JSON comment");
      i = end + 1; cleaned += " ";
    } else cleaned += c;
  }
  let json = ""; quoted = false;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (quoted) {
      json += c;
      if (c === "\\") json += cleaned[++i] ?? "";
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; json += c; }
    else if (c !== "," || !/^[\s]*[}\]]/.test(cleaned.slice(i + 1))) json += c;
  }
  const value = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Settings must be a JSON object");
  return value;
}
