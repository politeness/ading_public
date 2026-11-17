import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execFileSync as run } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { brandedMacExecutable, identityForChannel } from "./start.mjs";
import { buildNative } from "./build-native.mjs";
import { devApiBaseUrl } from "./local-env.mjs";
import { findSigningIdentity, signApp } from "./sign-mac.mjs";
import { describeRelease } from "../dist/shared/release.js";
import { copyRuntimeDependencies } from "./runtime-dependencies.mjs";

if (process.platform !== "darwin") throw new Error("This dev package is for macOS only");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releases = path.join(root, "releases");
await mkdir(releases, { recursive: true });
const wanted = process.env.ADING_CHANNEL?.trim() || manifest.adingChannel || "develop";
// Dev builds use their own bundle id and app name so they can be installed alongside release/pre-release builds on one machine (see start.mjs)
const identity = identityForChannel(wanted);

/**
 * Dev builds always use one fixed directory; release packages still get a new one each time.
 *
 * During development the app is repackaged dozens of times a day. A new directory each time means dozens of
 * 286MB packages piling up on disk, dozens of LaunchServices registrations, and, because macOS treats a new
 * path as a different app, Accessibility and Screen Recording having to be granted again. A fixed path solves all three.
 *
 * The release flow (release.mjs also calls this script) keeps creating a new one each time: it produces the
 * official artifacts to be signed, notarized and uploaded, which must not be overwritten by the next build.
 */
async function devOutput(dir) {
  const bundle = path.join(dir, `${identity.name}.app`);
  // Overwriting a running bundle makes processes that still map the old files misbehave, so quit it first.
  let pids = runningPids(bundle);
  if (pids.length) {
    console.log(`Quitting the running dev build (pid ${pids.join(", ")})`);
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
    for (let waited = 0; waited < 100 && runningPids(bundle).length; waited += 1) await sleep(100);
    pids = runningPids(bundle);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
    if (pids.length) await sleep(500);
  }
  // Delete and recreate the whole thing so old and new files don't mix in one bundle
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

function runningPids(bundle) {
  try {
    return run("/usr/bin/pgrep", ["-f", `${bundle}/Contents/MacOS/`], { encoding: "utf8" })
      .split("\n").map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0);
  } catch {
    return []; // pgrep exits non-zero when nothing matches
  }
}

/**
 * Release packages are placed under releases/build.noindex/.
 *
 * Each contains a complete release-identity ADing.app. Without .noindex in the directory name, Spotlight would
 * index every copy as yet another ADing, and the system would show several apps with the same name. mkdtemp can
 * only append a random suffix to the name, so .noindex goes on the parent directory.
 * release.mjs deletes this temp directory once it has collected the artifacts; this is the fallback before
 * that deletion (or when a release fails midway).
 */
const releaseBuilds = path.join(releases, "build.noindex");
if (wanted !== "develop") await mkdir(releaseBuilds, { recursive: true });
const output = wanted === "develop"
  ? await devOutput(path.join(releases, `ading-dev-${process.arch}`))
  : await mkdtemp(path.join(releaseBuilds, `ading-${manifest.version}-${process.arch}-`));
const bundle = path.join(output, `${identity.name}.app`);
await brandedMacExecutable(bundle, identity);
const contents = path.join(bundle, "Contents");
const application = path.join(contents, "Resources", "app");
await mkdir(path.join(application, "src"), { recursive: true });
await cp(path.join(root, "dist"), path.join(application, "dist"), { recursive: true });
await cp(path.join(root, "src/index.html"), path.join(application, "src/index.html"));
await cp(path.join(root, "src/ui"), path.join(application, "src/ui"), { recursive: true });
await cp(path.join(root, "src/assets"), path.join(application, "src/assets"), { recursive: true });
await cp(path.join(root, "build"), path.join(application, "build"), { recursive: true });
// Standalone installs must contain production modules required by the compiled main process.
await copyRuntimeDependencies(root, application);
// ADing's bundled native helper (background computer control, ading-computer) goes in Resources/bin/,
// and is signed with Developer ID along with the other binaries in release builds. Without it, Agents can only operate UIs by bringing apps to the foreground.
const nativeTools = await buildNative();
await mkdir(path.join(contents, "Resources", "bin"), { recursive: true });
for (const tool of nativeTools) {
  await cp(tool, path.join(contents, "Resources", "bin", path.basename(tool)));
}
if (!nativeTools.some((tool) => path.basename(tool) === "ading-computer")) throw new Error("Packaging aborted: ading-computer was not built");
// The channel decides which backend to connect to; the build time appears only in dev builds and is fixed at packaging time.
// Versioning rules are implemented once in src/shared/release.ts; use the compiled output here so two copies of the rules can't drift.
const { channel, buildTime, baseVersion, displayVersion } = describeRelease({
  version: manifest.version,
  adingChannel: process.env.ADING_CHANNEL?.trim() || manifest.adingChannel || "develop"
}, {});
await writeFile(path.join(application, "package.json"), JSON.stringify({
  name: manifest.name, productName: manifest.productName, version: displayVersion,
  adingChannel: channel, adingBuildTime: buildTime,
  // The dev server address for dev builds is not in the repo; it is baked in from the local .env at packaging time
  ...(channel === "develop" && devApiBaseUrl() ? { adingApiBaseUrl: devApiBaseUrl() } : {}),
  main: "dist/main.js", private: true,
  ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {})
}, null, 2));
// CFBundleShortVersionString / CFBundleVersion accept only 1-3 numeric components (Apple requirement),
// so write the three-part base version here; the full string stays in package.json and the UI.
for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
  execFileSync("/usr/bin/plutil", ["-replace", key, "-string", baseVersion, path.join(contents, "Info.plist")]);
}
// ADing's built-in background computer-control tool targets the macOS 14 SDK/runtime as its minimum.
// The app itself must declare the same minimum so users on older systems don't find features missing only after downloading.
execFileSync("/usr/bin/plutil", [
  "-replace", "LSMinimumSystemVersion", "-string", "14.0", path.join(contents, "Info.plist")
]);
// When an Agent controls another app via AppleScript, the system prompts "ADing wants to control xxx" under ADing's identity.
// Without a usage description, the system denies outright without even showing the prompt, and the task just fails.
execFileSync("/usr/bin/plutil", [
  "-replace", "NSAppleEventsUsageDescription", "-string",
  "阿钉里的 Agent 需要控制其他应用，来完成你交给它的任务。Agents in ADing control other apps to complete the tasks you give them.",
  path.join(contents, "Info.plist")
]);
// Dev builds connect to a NAS on the local network. Since macOS 15, LAN access requires Local Network permission;
// again, without a usage description it is denied with no prompt, showing up as every request failing with fetch failed.
// Pre-release and release builds connect to public domains, don't need this permission, and never show the prompt.
execFileSync("/usr/bin/plutil", [
  "-replace", "NSLocalNetworkUsageDescription", "-string",
  "阿钉开发版需要访问局域网里的开发服务器。ADing Dev connects to the development server on your local network.",
  path.join(contents, "Info.plist")
]);
// The renamed Electron bundle must not keep a broken upstream signature.
// Ad-hoc signing validates this local build; it is not Developer ID signing/notarization.
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--identifier", identity.bundleId, bundle]);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
/**
 * Local dev builds are signed with a Developer ID certificate when one is available.
 *
 * An ad-hoc signature's identity is this build's hash, which changes with every repackage: the Accessibility and
 * Screen Recording grants for "ADing Dev" in System Settings no longer match the new package and have no effect even
 * when switched on, so they must be re-granted after every build. With a certificate the identity is
 * "bundle id + Team ID", so grants survive repackaging.
 * The dev build's bundle id differs from pre-release and release, so their permission records are separate and don't interfere.
 *
 * Dev builds only: pre-release and release builds are signed and notarized by release.mjs after packaging; not touched here.
 * Machines without a certificate keep the ad-hoc signature.
 */
const devIdentity = channel === "develop" ? findSigningIdentity() : null;
if (devIdentity) signApp(bundle, devIdentity, { timestamp: false });
await writeFile(path.join(output, "README.txt"), `${identity.name} ${manifest.version} local development build\nDouble-click ${identity.name}.app to open it; it does not depend on the source directory.\n${devIdentity ? "Signed with a Developer ID certificate (not notarized)" : "Ad-hoc signed on this machine, without Developer ID signing or notarization"}, not for distribution.\nStartup checks use an isolated directory and a lightweight handshake with tools and extensions turned off; resources are accessed on demand only for real tasks.\n`);
console.log(`LOCAL_SIGNED=${devIdentity ? "developer-id" : "ad-hoc"}`);
console.log(`LOCAL_CHANNEL=${channel}`);
console.log(`LOCAL_VERSION=${displayVersion}`);
console.log(`LOCAL_APP=${bundle}`);
