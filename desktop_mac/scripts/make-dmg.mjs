/**
 * Packs the built .app into a DMG and computes the checksum for distribution.
 *
 * Uses the built-in hdiutil instead of electron-builder: this step only "puts a directory into a disk image",
 * which doesn't justify pulling in a whole packaging framework. Reconsider when adding delta updates (blockmap).
 *
 * File names are always English: they appear in download URLs, brew commands and the user's Downloads folder,
 * where Chinese either gets percent-encoded into a long string or needs quoting on the command line.
 */
import { mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin") throw new Error("DMGs can only be built on macOS");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const appPath = process.argv[2];
if (!appPath) {
  throw new Error("Usage: node scripts/make-dmg.mjs <path to ADing.app> [output directory]");
}
const outputDir = process.argv[3] ?? path.dirname(appPath);

/** Take the version from the package.json bundled in the app, not the repo's — that is this package's real version */
const bundled = JSON.parse(
  await readFile(path.join(appPath, "Contents", "Resources", "app", "package.json"), "utf8")
);
const version = bundled.version ?? manifest.version;
const arch = process.argv[4] ?? process.arch;
const dmgName = `ADing-${version}-${arch}.dmg`;
const dmgPath = path.join(outputDir, dmgName);

// Stage in a temp directory: the DMG root needs both the app and a symlink to /Applications,
// so users install with a single drag, the conventional macOS install method.
const staging = path.join(outputDir, ".dmg-staging");
/** Node's rm occasionally hits ENOTEMPTY on macOS bundles; the system rm is more reliable */
const removeStaging = () => execFileSync("/bin/rm", ["-rf", staging]);
removeStaging();
await mkdir(staging, { recursive: true });
execFileSync("/bin/cp", ["-R", appPath, path.join(staging, path.basename(appPath))]);
await symlink("/Applications", path.join(staging, "Applications"));

await rm(dmgPath, { force: true });
execFileSync("/usr/bin/hdiutil", [
  "create",
  "-volname", `ADing ${version}`,
  "-srcfolder", staging,
  "-ov",
  "-format", "UDZO",      // compressed; shrinks the 286MB app considerably
  dmgPath
], { stdio: "inherit" });
removeStaging();

const bytes = await readFile(dmgPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sizeMb = (bytes.length / 1024 / 1024).toFixed(1);

// Write the checksum to its own file: the landing page and the Homebrew cask both use it,
// and a wrong sha256 in the cask only fails halfway through the user's install.
await writeFile(`${dmgPath}.sha256`, `${sha256}  ${dmgName}\n`, "utf8");

console.log(`DMG_PATH=${dmgPath}`);
console.log(`DMG_NAME=${dmgName}`);
console.log(`DMG_VERSION=${version}`);
console.log(`DMG_ARCH=${arch}`);
console.log(`DMG_SHA256=${sha256}`);
console.log(`DMG_SIZE_MB=${sizeMb}`);
