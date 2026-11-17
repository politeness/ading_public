/**
 * Developer ID signing.
 *
 * It differs from the development-time ad-hoc signature (codesign --sign -) in three ways, all required:
 *
 *   1. Signing with a real certificate is what puts a TeamIdentifier in the signature. Gatekeeper trusts
 *      that identity, and Squirrel auto-update only installs when the old and new Team IDs match.
 *   2. --options runtime enables the Hardened Runtime. It is a hard prerequisite for notarization,
 *      and must be paired with entitlements that allow V8's JIT, or the signed app won't launch.
 *   3. --timestamp requests a trusted timestamp from Apple. With it, previously signed builds keep
 *      running after the certificate expires or is revoked; without it, every certificate change
 *      would break the old versions users have installed.
 *
 * Signing must go from the inside out: the outer signature covers the hashes of inner files, so signing
 * the outer layer first and then touching the inner layer invalidates it. Apple explicitly advises
 * against relying on --deep for this.
 *
 * Without a certificate it doesn't fail; it just reports and skips. That lets it sit in the everyday
 * packaging flow: once a certificate is available, setting an env var is enough to produce release builds.
 */
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Mach-O header magic numbers: 64-bit / 32-bit (both byte orders) and universal binaries */
const MACHO_MAGICS = new Set(["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe", "bebafeca"]);

const isMachO = (file) => {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGICS.has(head.toString("hex"));
  } finally {
    closeSync(fd);
  }
};

/** A bundle's own main executable is signed with the bundle, not separately */
const isBundleMain = (file) => {
  if (/\.app\/Contents\/MacOS\/[^/]+$/.test(file)) return true;
  const framework = file.match(/\/([^/]+)\.framework\/Versions\/[^/]+\/([^/]+)$/);
  return Boolean(framework && framework[1] === framework[2]);
};

/** Loose Mach-O files in the bundle: dylibs inside frameworks, helper programs under Helpers and Resources */
function looseBinaries(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Skip symlinks: a framework's Versions/Current points at the real directory, following it would sign twice
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...looseBinaries(full));
    else if (entry.isFile() && !isBundleMain(full) && isMachO(full)) found.push(full);
  }
  return found;
}

/** Find a usable Developer ID Application certificate */
export function findSigningIdentity() {
  const explicit = process.env.ADING_SIGN_IDENTITY?.trim();
  if (explicit) return explicit;
  let listed = "";
  try {
    listed = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8"
    });
  } catch {
    return null;
  }
  // Looks like: 1) ABC123 "Developer ID Application: Some Name (TEAMID)"
  const match = listed.match(/"(Developer ID Application: [^"]+)"/);
  return match ? match[1] : null;
}

/** Extract the parenthesised Team ID from the certificate name */
export function teamIdOf(identity) {
  return identity?.match(/\(([A-Z0-9]{10})\)\s*$/)?.[1] ?? null;
}

const sign = (identity, entitlements, target, timestamp = true) => {
  const args = [
    "--force",
    "--sign", identity,
    "--options", "runtime",   // Hardened Runtime
    // Trusted timestamp keeps the signature valid after the certificate expires. Local dev builds skip it: it needs network access, and dev builds are never distributed
    timestamp ? "--timestamp" : "--timestamp=none",
  ];
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(target);
  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
};

/**
 * @param timestamp Whether to request a trusted timestamp from Apple. Required for release builds; local dev builds pass false so packaging works offline
 */
export function signApp(appPath, identity, { timestamp = true } = {}) {
  const entitlements = path.join(root, "build", "entitlements.mac.plist");
  const frameworks = path.join(appPath, "Contents", "Frameworks");

  // Innermost: loose dylibs and helper programs in the bundle (libEGL, libffmpeg, chrome_crashpad_handler, ShipIt...).
  // codesign doesn't sign them when signing the framework; any left out keep the packaging-time ad-hoc
  // signature and notarization rejects them as Invalid. Sort deepest path first so inner files are signed first.
  const loose = looseBinaries(path.join(appPath, "Contents"))
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  // The native helper ading-computer queries and requests Automation permission, so it alone gets an Apple Events entitlement; other bare binaries get none
  const helperEntitlements = path.join(root, "build", "entitlements.helper.plist");
  for (const target of loose) sign(identity, path.basename(target) === "ading-computer" ? helperEntitlements : null, target, timestamp);

  // Middle layer: frameworks and helpers. Helpers need entitlements too:
  // renderer processes also run V8 and won't start without allow-jit.
  let inner = [];
  try {
    inner = execFileSync("/usr/bin/find", [
      frameworks, "-maxdepth", "1", "(", "-name", "*.framework", "-o", "-name", "*.app", ")"
    ], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    inner = [];
  }

  for (const target of inner) {
    const needsEntitlements = target.endsWith(".app");
    sign(identity, needsEntitlements ? entitlements : null, target, timestamp);
  }

  // Sign the outermost layer last
  sign(identity, entitlements, appPath, timestamp);

  // Verify: --strict also catches inner components that weren't signed properly
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit"
  });
  return loose.length + inner.length + 1;
}

// When run directly: sign the given .app
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const appPath = process.argv[2];
  if (!appPath) throw new Error("Usage: node scripts/sign-mac.mjs <path to ADing.app>");

  const identity = findSigningIdentity();
  if (!identity) {
    console.log("SIGN_SKIPPED=1");
    console.log("SIGN_REASON=No Developer ID Application certificate on this machine; skipping signing");
    console.log("SIGN_HINT=No code changes needed once a certificate is installed; set ADING_SIGN_IDENTITY to choose a specific one");
    process.exit(0);
  }

  const manifest = JSON.parse(
    await readFile(path.join(appPath, "Contents", "Resources", "app", "package.json"), "utf8")
  );
  const signed = signApp(appPath, identity);
  console.log(`SIGN_IDENTITY=${identity}`);
  console.log(`SIGN_TEAM_ID=${teamIdOf(identity) ?? "unknown"}`);
  console.log(`SIGN_COMPONENTS=${signed}`);
  console.log(`SIGN_VERSION=${manifest.version}`);
}
