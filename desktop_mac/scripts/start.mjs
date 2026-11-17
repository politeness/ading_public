import { giveUniqueMachOUuid } from "./macho-uuid.mjs";
import { devApiBaseUrl } from "./local-env.mjs";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import {createHash} from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, errorMessage) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(errorMessage);
  }
}

async function installMacIcon(contents, workDirectory) {
  const source = path.join(projectRoot, "build", "icon.png");
  const iconset = path.join(workDirectory, "ADing.iconset");
  const target = path.join(contents, "Resources", "ading.icns");
  const sizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"]
  ];

  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  for (const [pixels, name] of sizes) {
    run(
      "/usr/bin/sips",
      ["-z", String(pixels), String(pixels), source, "--out", path.join(iconset, String(name))],
      "Failed to generate the ADing Dev icon"
    );
  }
  run(
    "/usr/bin/iconutil",
    ["-c", "icns", iconset, "-o", target],
    "Failed to write the ADing Dev icon"
  );
  await rm(iconset, { recursive: true, force: true });
}

/**
 * The dev build and the release build must be installable side by side on one machine.
 *
 * macOS identifies an app by bundle id, and the data directory by app name. If both match, dev and release share
 * ~/Library/Application Support/ADing — test tasks created while trying features in dev would land directly in the
 * data you use daily, and privacy permissions would conflict. So the dev build gets an entirely separate identity and becomes "another app".
 */
export const RELEASE_IDENTITY = { bundleId: "com.politeness.ading", name: "ADing", localizedName: "阿钉" };
export const DEV_IDENTITY = { bundleId: "com.politeness.ading.dev", name: "ADing Dev", localizedName: "阿钉 Dev" };

/**
 * Name shown in Finder, Dock, Launchpad and the menu bar: "阿钉" on Chinese systems, "ADing" in other languages.
 * The app bundle, executable and data directory names are always English (no Chinese directories on the user's machine); only the display name changes here.
 * Which one is used depends on the macOS system language, not ADing's UI language setting.
 * lproj directory names follow Electron's own (zh_CN, zh_TW, en); languages without InfoPlist.strings use the English name from Info.plist.
 */
async function localizeDisplayName(contents, identity) {
  const names = { en: identity.name, zh_CN: identity.localizedName, zh_TW: identity.localizedName };
  for (const [region, name] of Object.entries(names)) {
    const directory = path.join(contents, "Resources", `${region}.lproj`);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "InfoPlist.strings");
    await writeFile(file, JSON.stringify({ CFBundleName: name, CFBundleDisplayName: name }));
    run("/usr/bin/plutil", ["-convert", "binary1", file], "Failed to write the localized app name");
  }
  run("/usr/bin/plutil", ["-replace", "LSHasLocalizedDisplayName", "-bool", "YES", path.join(contents, "Info.plist")], "Failed to declare the localized app name");
}

export function identityForChannel(channel) {
  return channel === "develop" ? DEV_IDENTITY : RELEASE_IDENTITY;
}

export async function brandedMacExecutable(destination, identity = DEV_IDENTITY) {
  const sourceApp = path.resolve(path.dirname(electronExecutable), "../..");
  const sourceContents = path.join(sourceApp, "Contents");
  const bundleRoot = destination ?? path.join(
    homedir(), "Library", "Application Support", "ADing Development Host",
    `${identity.name}.app`
  );
  const contents = path.join(bundleRoot, "Contents");
  const executable = path.join(contents, "MacOS", "ADing");

  // A development host loads project code by argv. Keep its signature stable
  // across ordinary JS/UI rebuilds so macOS folder consent is not invalidated.
  const marker=path.join(path.dirname(bundleRoot),"host-fingerprint.json");
  const fingerprint=createHash("sha256").update(await readFile(path.join(sourceContents,"Info.plist"))).update(await readFile(path.join(projectRoot,"build/icon.png"))).update("ading-host-v3").update(identity.bundleId).digest("hex");
  if(!destination){
    try{
      const cached=JSON.parse(await readFile(marker,"utf8"));
      if(cached.fingerprint===fingerprint && spawnSync("/usr/bin/codesign",["--verify","--deep","--strict",bundleRoot],{stdio:"ignore"}).status===0)return executable;
    }catch{/* Build a host when missing or stale. */}
  }
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(path.dirname(bundleRoot), { recursive: true });
  run("/bin/cp", ["-cR", sourceApp, bundleRoot], "Failed to create the ADing Dev app bundle");
  await rename(path.join(contents, "MacOS", "Electron"), executable);
  // The dev build needs its own Mach-O UUID; otherwise it shares the Local Network permission with the release build and Electron, and can't reach the NAS on the LAN
  if (identity.bundleId !== RELEASE_IDENTITY.bundleId) await giveUniqueMachOUuid(executable, identity.bundleId);
  await installMacIcon(contents, path.dirname(bundleRoot));

  const sourceInfo = await readFile(path.join(sourceContents, "Info.plist"), "utf8");
  const info = sourceInfo
    .replace(
      /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${identity.name}$2`
    )
    .replace(
      /(<key>CFBundleExecutable<\/key>\s*<string>)[^<]*(<\/string>)/,
      "$1ADing$2"
    )
    .replace(
      /(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${identity.bundleId}$2`
    )
    .replace(
      /(<key>CFBundleIconFile<\/key>\s*<string>)[^<]*(<\/string>)/,
      "$1ading.icns$2"
    )
    .replace(
      /(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${identity.name}$2`
    );
  await writeFile(path.join(contents, "Info.plist"), info);
  await localizeDisplayName(contents, identity);

  if(!destination){
    run("/usr/bin/codesign",["--force","--deep","--sign","-","--identifier",identity.bundleId,bundleRoot],"Failed to sign the ADing Dev host");
    run("/usr/bin/codesign",["--verify","--deep","--strict",bundleRoot],"ADing Dev host signature verification failed");
    await writeFile(marker,JSON.stringify({fingerprint}));
  }
  return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const executable = process.platform === "darwin"
  ? await brandedMacExecutable()
  : electronExecutable;
// The dev server address used by the dev build is not in the repo; it is read from the local .env. An explicitly set ADING_API_BASE_URL takes precedence.
const devBaseUrl = devApiBaseUrl();
const launchEnv = devBaseUrl && !process.env.ADING_API_BASE_URL?.trim()
  && (process.env.ADING_CHANNEL?.trim() || "develop") === "develop"
  ? { ...process.env, ADING_API_BASE_URL: devBaseUrl }
  : process.env;
const child = spawn(executable, [projectRoot, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: launchEnv,
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
}
