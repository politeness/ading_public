import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { p } from "../prompt-language";

const exec = promisify(execFile);
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Maximum nesting depth allowed for the shim. Normal nesting (node -> npm -> tsc) is nowhere near it; it only stops infinite self-relaunching. */
const MAX_SHIM_DEPTH = 12;

/**
 * Whether the target is an Electron executable.
 *
 * This must be derived from the target itself, not passed in as a boolean by the caller: once the caller says "not
 * Electron" while the target is actually a GUI app, the shim written out becomes something named node that actually launches
 * the whole desktop app - and the desktop app probes node again after starting, so it relaunches itself forever.
 */
export function isElectronExecutable(executablePath: string): boolean {
  const resolved = path.resolve(executablePath);
  if (process.versions.electron && resolved === path.resolve(process.execPath)) return true;
  // macOS app bundle: .../Foo.app/Contents/MacOS/Foo
  return /\.app\/Contents\/MacOS\/[^/]+$/.test(resolved);
}

/**
 * Generates the node shim script. Two safeguards:
 * 1. if the target is Electron, always export ELECTRON_RUN_AS_NODE so it degrades to plain Node instead of opening a window;
 * 2. track the nesting depth so that if recursion still happens, it errors out at level MAX_SHIM_DEPTH instead of multiplying.
 */
export function buildNodeShim(executablePath: string): string {
  const electron = isElectronExecutable(executablePath);
  return [
    "#!/bin/sh",
    `ADING_NODE_SHIM_DEPTH=$((\${ADING_NODE_SHIM_DEPTH:-0} + 1))`,
    "export ADING_NODE_SHIM_DEPTH",
    `if [ "$ADING_NODE_SHIM_DEPTH" -gt ${MAX_SHIM_DEPTH} ]; then`,
    `  echo "ADing: node shim nested more than ${MAX_SHIM_DEPTH} levels; aborted to avoid self-relaunching" >&2`,
    "  exit 127",
    "fi",
    ...(electron ? ["export ELECTRON_RUN_AS_NODE=1"] : []),
    `exec ${quote(executablePath)} "$@"`,
    ""
  ].join("\n");
}

/** One environment for discovery, verification, login and execution. Never edits shell profiles. */
export async function prepareCliEnvironment(options: {
  baseEnv: NodeJS.ProcessEnv;
  home: string;
  runtimeDirectory: string;
  executablePath: string;
}): Promise<{ env: NodeJS.ProcessEnv; nodeVersion: string; bundled: boolean }> {
  const directories = [
    ...(options.baseEnv.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(options.home, ".local/bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    path.join(options.home, ".volta/bin")
  ];
  const nvm = path.join(options.home, ".nvm/versions/node");
  try {
    const versions = (await readdir(nvm)).filter(version => /^v\d+\.\d+\.\d+$/.test(version));
    versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    directories.push(...versions.map(version => path.join(nvm, version, "bin")));
  } catch { /* nvm is optional. */ }
  const env = { ...options.baseEnv, PATH: [...new Set(directories)].join(path.delimiter) };
  const probe = async (): Promise<string> => {
    const result = await exec("node", ["--version"], { env, timeout: 3000 });
    const version = result.stdout.trim();
    if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(p("Node 版本检查未返回有效结果", "The Node version check didn't return a valid result"));
    return version;
  };
  try { return { env, nodeVersion: await probe(), bundled: false }; }
  catch { /* Finder may have no standalone Node; use this app's own runtime. */ }

  // Separate by app path so rebuilding/moving an app cannot redirect another running build.
  const key = createHash("sha256").update(options.executablePath).digest("hex").slice(0, 16);
  const bin = path.join(options.runtimeDirectory, key, "bin");
  await mkdir(bin, { recursive: true });
  const shim = path.join(bin, "node");
  await writeFile(shim, buildNodeShim(options.executablePath), { mode: 0o700 });
  await chmod(shim, 0o700);
  env.PATH = bin + path.delimiter + env.PATH;
  return { env, nodeVersion: await probe(), bundled: true };
}
