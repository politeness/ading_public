/**
 * Generates the Homebrew Cask file.
 *
 * Why a separate script: the sha256 in the cask must match the published DMG byte for byte.
 * Copying it by hand goes wrong every time — and the mistake isn't caught at commit time; the user's
 * `brew install` fails halfway. So it must be computed from the real artifact, never written by hand.
 *
 * Put the generated cask in the self-hosted tap repo and it is usable immediately:
 *   brew tap politeness/ading && brew install --cask ading
 *
 * Submitting to the official homebrew-cask is a different matter: it requires the app to be
 * Developer ID signed and notarized; unsigned casks are not accepted.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ossDownloadBase } from "./local-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dmgPath = process.argv[2];
if (!dmgPath) throw new Error("Usage: node scripts/make-cask.mjs <dmg path> [download URL prefix]");

/** Download URL prefix. Defaults to OSS — it has HTTPS built in and suits large files */
const baseUrl = (process.argv[3] ?? `${ossDownloadBase()}/ota/desktop_mac/releases`)
  .replace(/\/+$/, "");

const bytes = await readFile(dmgPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const dmgName = path.basename(dmgPath);

// Take the version from the file name: ADing-<version>-<arch>.dmg
const parsed = /^ADing-(.+)-(arm64|x64)\.dmg$/.exec(dmgName);
if (!parsed) throw new Error(`DMG file name does not match ADing-<version>-<arch>.dmg: ${dmgName}`);
const [, version, arch] = parsed;

// Release versions are plain three-part versions; those with -pre / -dev are pre-release or development builds and don't belong in Homebrew.
const isPrerelease = version.includes("-");

const cask = `cask "ading" do
  version "${version}"
  sha256 "${sha256}"

  url "${baseUrl}/#{version}/ADing-#{version}-${arch}.dmg"
  name "阿钉"
  name "ADing"
  desc "Chat-style workspace that puts your local coding agents on one team"
  homepage "https://www.coffeestudy.com.cn/ading/"

  depends_on macos: ">= :sonoma"
  depends_on arch: :${arch === "arm64" ? "arm64" : "x86_64"}

  app "ADing.app"

  zap trash: [
    "~/Library/Application Support/ADing",
    "~/Library/Preferences/com.politeness.ading.plist",
    "~/Library/Saved Application State/com.politeness.ading.savedState",
  ]
end
`;

const tapDir = path.join(root, "releases", "homebrew-tap", "Casks");
await mkdir(tapDir, { recursive: true });
const caskPath = path.join(tapDir, "ading.rb");
await writeFile(caskPath, cask, "utf8");

console.log(`CASK_PATH=${caskPath}`);
console.log(`CASK_VERSION=${version}`);
console.log(`CASK_ARCH=${arch}`);
console.log(`CASK_SHA256=${sha256}`);
console.log(`CASK_URL=${baseUrl}/${version}/${dmgName}`);
if (isPrerelease) {
  console.log("CASK_WARNING=This is a development build (the version has a suffix). Homebrew should only get release versions; repackage with ADING_CHANNEL=release before publishing.");
}
