/**
 * Compiles ADing's bundled native helpers (currently only ading-computer, for background computer control).
 *
 * Output goes to dist-native/ and is copied into ADing.app/Contents/Resources/bin/ at packaging time;
 * the release signing script signs it with Developer ID along with the other binaries in the bundle.
 * Skip recompiling when the source is unchanged; swiftc takes over ten seconds per run.
 */
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NATIVE_TOOLS = [
  { name: "ading-computer", source: path.join(root, "native", "ading-computer", "main.swift") }
];
export const nativeOutput = path.join(root, "dist-native");

async function mtime(file) {
  try { return (await stat(file)).mtimeMs; } catch { return 0; }
}

export async function buildNative({ force = false } = {}) {
  if (process.platform !== "darwin") return [];
  await mkdir(nativeOutput, { recursive: true });
  const built = [];
  for (const tool of NATIVE_TOOLS) {
    const output = path.join(nativeOutput, tool.name);
    if (!force && (await mtime(output)) >= (await mtime(tool.source))) { built.push(output); continue; }
    execFileSync("/usr/bin/xcrun", [
      "swiftc", "-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
      "-o", output, tool.source
    ], { stdio: ["ignore", "inherit", "inherit"] });
    built.push(output);
  }
  return built;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  for (const file of await buildNative({ force: process.argv.includes("--force") })) console.log(`NATIVE_TOOL=${file}`);
}
