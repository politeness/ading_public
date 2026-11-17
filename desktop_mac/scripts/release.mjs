/**
 * End-to-end release: package -> DMG -> checksum -> Homebrew cask -> landing page data.
 *
 * Why one script instead of several commands run by hand:
 * **DMGs are not reproducible builds.** They embed timestamps, so the same .app produces a different
 * sha256 each time. If the flow generates the DMG twice, the hash in the cask won't match the file
 * actually published, and that error doesn't surface at release time: it only fails when a user's
 * `brew install` verifies the download. So the whole chain must "produce the artifact once and have
 * every later reference point to it".
 *
 * Usage:
 *   node scripts/release.mjs                     # uses adingChannel from package.json
 *   ADING_CHANNEL=pre node scripts/release.mjs
 *   ADING_CHANNEL=release node scripts/release.mjs
 *   ADING_MANDATORY=1 ADING_CHANNEL=release node scripts/release.mjs   # mandatory update: older clients must upgrade before they can be used
 *
 * Pre-release builds (pre) are for gray testing: the package goes to OSS under ota/desktop_mac/prereleases/<version>/,
 * with no Homebrew cask and no update to the landing page download data.
 * Pre-releases are signed but not notarized: notarization takes Apple from a few to twenty-odd minutes, while
 * pre-releases mainly ship via OTA to the gray list, and the OTA installer strips the quarantine attribute and
 * checks only the signature and Team ID, without relying on notarization. The cost is that a pre-release DMG
 * downloaded manually in a browser is blocked by Gatekeeper on first open and must be allowed in
 * System Settings -> Privacy & Security. Release builds must be notarized.
 * Development builds (develop) are only packaged locally: no OSS upload and no version registration SQL.
 */
import { mkdir, readFile, writeFile, cp, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { releasePrefix } from "./upload-oss.mjs";
import { ossDownloadBase } from "./local-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const run = (file, args) =>
  execFileSync(process.execPath, [path.join(root, "scripts", file), ...args], { encoding: "utf8" });

/**
 * Parse the KEY=VALUE lines a script prints into an object.
 * Some keys contain digits (DMG_SHA256), so the character class must include 0-9. Otherwise those
 * lines are silently dropped, downstream gets undefined, and undefined === undefined makes checks falsely pass.
 */
const fields = (output) =>
  Object.fromEntries(
    output.split("\n")
      .filter(line => /^[A-Z0-9_]+=/.test(line))
      .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );

/** Values used as guards must actually exist, or a check would "pass" between two undefineds */
const required = (value, name) => {
  if (!value) throw new Error(`Release aborted: could not get ${name} from the previous step`);
  return value;
};

console.log("① Packaging app...");
const packed = fields(run("package-local.mjs", []));
const appPath = required(packed.LOCAL_APP, "LOCAL_APP");
console.log(`   channel ${packed.LOCAL_CHANNEL} · version ${packed.LOCAL_VERSION}`);

console.log("② Signing...");
const signed = fields(run("sign-mac.mjs", [appPath]));
if (signed.SIGN_SKIPPED) {
  // Pre-release and release both ship via OTA: the installer requires the new package's Team ID to match
  // the installed version, so unsigned packages are rejected. Release builds also need notarization, which
  // requires a Developer ID signature. Only local dev builds may be unsigned.
  if (packed.LOCAL_CHANNEL !== "develop") {
    throw new Error(`Release aborted: the ${packed.LOCAL_CHANNEL} channel requires a Developer ID signature, but signing was skipped (${signed.SIGN_REASON}). ${signed.SIGN_HINT ?? ""}`);
  }
  console.log(`   ⚠️  ${signed.SIGN_REASON}`);
  console.log(`      ${signed.SIGN_HINT}`);
} else {
  console.log(`   ${signed.SIGN_IDENTITY}`);
  console.log(`   Team ID ${signed.SIGN_TEAM_ID} · signed ${signed.SIGN_COMPONENTS} components`);
}

console.log("③ Building DMG... (built only once; everything after refers to it)");
const dmg = fields(run("make-dmg.mjs", [appPath]));
console.log(`   ${dmg.DMG_NAME} · ${dmg.DMG_SIZE_MB} MB`);
console.log(`   sha256 ${dmg.DMG_SHA256}`);

console.log("④ Notarizing...");
const notarized = packed.LOCAL_CHANNEL === "pre"
  ? { NOTARY_SKIPPED: "1", NOTARY_BY_POLICY: "1" }
  : fields(run("notarize-mac.mjs", [dmg.DMG_PATH]));
if (notarized.NOTARY_BY_POLICY) {
  console.log("   Pre-release is not notarized (signed only): OTA updates are unaffected; a browser-downloaded copy must be allowed in Privacy & Security on first open");
} else if (notarized.NOTARY_SKIPPED) {
  // Release builds must be notarized: an unnotarized package won't open after a browser download, and Gatekeeper also blocks Homebrew installs.
  if (packed.LOCAL_CHANNEL === "release") {
    throw new Error(`Release aborted: release builds must be notarized, but notarization was skipped (${notarized.NOTARY_REASON}). ${notarized.NOTARY_HINT ?? ""}`);
  }
  console.log(`   ⚠️  ${notarized.NOTARY_REASON}`);
  console.log(`      ${notarized.NOTARY_HINT}`);
} else {
  console.log(`   Notarized and ticket stapled (${notarized.NOTARY_KIND})`);
  // Stapling writes the ticket into the DMG, changing its contents and invalidating the sha256 from step ③.
  // Users download the stapled copy, so the checksum must be recomputed from it, or the cask fails verification mid-install.
  const stapled = await readFile(dmg.DMG_PATH);
  dmg.DMG_SHA256 = createHash("sha256").update(stapled).digest("hex");
  dmg.DMG_SIZE_MB = (stapled.length / 1024 / 1024).toFixed(1);
  await writeFile(`${dmg.DMG_PATH}.sha256`, `${dmg.DMG_SHA256}  ${dmg.DMG_NAME}\n`, "utf8");
  console.log(`   sha256 after stapling ${dmg.DMG_SHA256}`);
}

const isRelease = packed.LOCAL_CHANNEL === "release";
const OSS_BASE = ossDownloadBase();
required(dmg.DMG_SHA256, "DMG_SHA256");
let cask;
if (isRelease) {
  console.log("⑤ Generating Homebrew cask...");
  cask = fields(run("make-cask.mjs", [dmg.DMG_PATH, `${OSS_BASE}/ota/desktop_mac/releases`]));
  required(cask.CASK_SHA256, "CASK_SHA256");
  if (cask.CASK_SHA256 !== dmg.DMG_SHA256) {
    throw new Error(
      `cask sha256 does not match the DMG; releasing would leave users unable to install:\n` +
      `  DMG  ${dmg.DMG_SHA256}\n  cask ${cask.CASK_SHA256}`
    );
  }
  console.log("   Hash matches the DMG ✓");
  if (cask.CASK_WARNING) console.log(`   ⚠️  ${cask.CASK_WARNING}`);
} else {
  console.log("⑤ Pre-release / dev builds are not published to Homebrew; skipping cask");
}
const isDevelop = packed.LOCAL_CHANNEL === "develop";
const downloadUrl = isRelease
  ? required(cask.CASK_URL, "CASK_URL")
  : isDevelop ? null : `${OSS_BASE}/${releasePrefix(dmg.DMG_VERSION)}/${dmg.DMG_VERSION}/${dmg.DMG_NAME}`;

console.log("⑥ Collecting release artifacts...");
const outDir = path.join(root, "releases", "publish", dmg.DMG_VERSION);
await mkdir(outDir, { recursive: true });
await cp(dmg.DMG_PATH, path.join(outDir, dmg.DMG_NAME));
await cp(`${dmg.DMG_PATH}.sha256`, path.join(outDir, `${dmg.DMG_NAME}.sha256`));
if (isRelease) await cp(cask.CASK_PATH, path.join(outDir, "ading.rb"));

/** Metadata for the landing page, kept with the artifacts so the page's version never drifts from the actual package */
const meta = {
  version: dmg.DMG_VERSION,
  channel: packed.LOCAL_CHANNEL,
  arch: dmg.DMG_ARCH,
  file: dmg.DMG_NAME,
  sizeMb: Number(dmg.DMG_SIZE_MB),
  sha256: dmg.DMG_SHA256,
  url: downloadUrl,
  releasedAt: new Date().toISOString(),
  /** Whether it has a Developer ID signature. Tracked separately from notarization: pre-releases are signed but not notarized by policy */
  signed: !signed.SIGN_SKIPPED,
  /** Without notarization, a browser-downloaded package is blocked by Gatekeeper on first open; the landing page must say so */
  notarized: !notarized.NOTARY_SKIPPED,
  teamId: signed.SIGN_TEAM_ID ?? null
};
await writeFile(path.join(outDir, "release.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

if (isDevelop) {
  console.log(`\nDev build packaged locally only, not uploaded to OSS: ${path.join(outDir, dmg.DMG_NAME)}`);
  process.exit(0);
}

console.log("⑦ Generating version registration SQL (gray list only by default)...");
/**
 * Clients check for updates against conductor's app_releases table, not release.json.
 * Every new version is registered as GRAY: verify on a few named accounts or machines first, then roll out to ALL by hand.
 * That way even a bad package only affects the people on the list.
 */
const sqlText = (value) => (value === null || value === undefined)
  ? "NULL"
  : `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
const dmgBytes = (await stat(dmg.DMG_PATH)).size;
/** Mandatory updates must be explicitly specified by the releaser (ask the user before releasing); not mandatory by default */
const mandatory = process.env.ADING_MANDATORY === "1";
const releaseSql = `-- ADing ${meta.version} (${meta.channel} / ${meta.arch}) version registration, generated by scripts/release.mjs
-- Run against the RDS behind ECS (shared by release and pre-release; get approval first). For gray and rollout steps see the gray release section of docs/ota-design.md.
-- mandatory = ${mandatory ? 1 : 0}: ${mandatory ? "mandatory update; older clients must upgrade before they can keep using the app" : "regular version, not mandatory"}
INSERT INTO app_releases
  (platform, channel, version, arch, url, size_bytes, sha256, signed, team_id, mandatory, rollout, released_at)
VALUES
  ('mac', ${sqlText(meta.channel)}, ${sqlText(meta.version)}, ${sqlText(meta.arch)}, ${sqlText(meta.url)},
   ${dmgBytes}, ${sqlText(meta.sha256)}, ${meta.signed ? 1 : 0}, ${sqlText(meta.teamId)}, ${mandatory ? 1 : 0}, 'GRAY', NOW());

-- Long-term pre-release recipients need no entry: accounts tagged PRE_GRAY (user_tags.tag = 'PRE_GRAY') and their registered machines see it automatically.
-- Only targets named specifically for this release go on the gray list (copy rows as needed):
-- INSERT INTO app_release_grays (channel, version, target_type, target_id, remark) VALUES
--   (${sqlText(meta.channel)}, ${sqlText(meta.version)}, 'USER',    'u_xxx', 'who/why'),
--   (${sqlText(meta.channel)}, ${sqlText(meta.version)}, 'MACHINE', '<machine id>', 'who/why');

-- Once verified, roll out to everyone:
-- UPDATE app_releases SET rollout = 'ALL' WHERE platform = 'mac' AND channel = ${sqlText(meta.channel)} AND version = ${sqlText(meta.version)};
-- Emergency pull if problems are found (clients that already downloaded it delete the package on their next check):
-- UPDATE app_releases SET rollout = 'OFF' WHERE platform = 'mac' AND channel = ${sqlText(meta.channel)} AND version = ${sqlText(meta.version)};
`;
await writeFile(path.join(outDir, "app-release.sql"), releaseSql, "utf8");
console.log(`   ${path.join(outDir, "app-release.sql")}`);

if (isRelease) {
  console.log("⑧ Updating landing page download data...");
  // The landing page body doesn't change per version, so releases don't regenerate it; only update the release.json it reads (download URL, latest version)
  const siteDir = path.join(root, "releases", "site");
  await mkdir(siteDir, { recursive: true });
  await cp(path.join(outDir, "release.json"), path.join(siteDir, "release.json"));
  console.log(`   ${path.join(siteDir, "release.json")}`);
} else {
  console.log("⑧ Pre-release / dev builds don't update landing page download data; skipping");
}

console.log(`\nRelease artifacts ready: ${outDir}`);
if (isRelease) console.log(`  Landing page download data: releases/site/release.json (upload to the homepage directory)`);
console.log(`  ${dmg.DMG_NAME}`);
console.log(`  ${dmg.DMG_NAME}.sha256`);
if (isRelease) {
  console.log(`  ading.rb          (put under Casks/ in the tap repo)`);
  console.log(`  release.json      (read by the landing page)`);
}
console.log(`  app-release.sql   (register in conductor; clients check for updates from it; gray list only by default)`);
console.log(`\nNext: node scripts/upload-oss.mjs ${dmg.DMG_VERSION} ${path.join(outDir, dmg.DMG_NAME)} (uploads to ${path.posix.dirname(downloadUrl)}/)`);

// The temporary packaging directory is deleted only at the very end: every earlier step (including ⑦ reading the DMG size)
// still needs its files. In the 0.8.1 release it was deleted right after ⑥, so ⑦ couldn't find the DMG and aborted.
// Uploading and registration afterwards use the copies in publish/.
// If left behind, the release-identity ADing.app inside it would be treated by the system as yet another ADing,
// so unregister it first and then delete the whole directory.
// Dev builds exit after ⑥ and never reach this point; they use the fixed directory ading-dev-<arch>, which is the
// dev build the user opens by double-clicking, and must not be deleted.
try {
  execFileSync(LSREGISTER, ["-u", appPath], { stdio: "ignore" });
} catch { /* never registered, nothing to unregister */ }
await rm(path.dirname(appPath), { recursive: true, force: true });
