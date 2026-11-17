/**
 * Notarization and stapling.
 *
 * Notarization is not app review — nobody looks at what the app does, checks features or cares about the sandbox; it is
 * Apple's automated malware scan and usually returns within minutes. But it is mandatory for Developer ID distribution:
 * since macOS 10.15, Gatekeeper blocks un-notarized apps on first launch.
 *
 * We submit the DMG (a zip also works). After notarization passes it must be stapled, embedding the ticket in
 * the file — otherwise Gatekeeper checks with Apple online every time, and on a poor network the first launch
 * can hang for a long time or fail, especially in mainland China.
 *
 * Two credential options; prefer an API key (revocable on its own, not tied to the Apple ID password):
 *   ADING_NOTARY_KEY_ID / ADING_NOTARY_KEY_ISSUER / ADING_NOTARY_KEY_PATH
 * or an app-specific password:
 *   ADING_NOTARY_APPLE_ID / ADING_NOTARY_PASSWORD / ADING_NOTARY_TEAM_ID
 */
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Build notarytool credential arguments; returns null when credentials are missing */
export function notaryCredentials(env = process.env) {
  const keyId = env.ADING_NOTARY_KEY_ID?.trim();
  const issuer = env.ADING_NOTARY_KEY_ISSUER?.trim();
  const keyPath = env.ADING_NOTARY_KEY_PATH?.trim();
  if (keyId && issuer && keyPath) {
    return { kind: "api-key", args: ["--key", keyPath, "--key-id", keyId, "--issuer", issuer] };
  }

  const appleId = env.ADING_NOTARY_APPLE_ID?.trim();
  const password = env.ADING_NOTARY_PASSWORD?.trim();
  const teamId = env.ADING_NOTARY_TEAM_ID?.trim();
  if (appleId && password && teamId) {
    return {
      kind: "apple-id",
      args: ["--apple-id", appleId, "--password", password, "--team-id", teamId]
    };
  }
  return null;
}

export function notarize(targetPath, credentials) {
  // --wait blocks until Apple returns a result, within a few minutes.
  // notarytool still exits 0 when the result is Invalid, so check status ourselves —
  // otherwise we'd go on to staple and only get an unexplained "Record not found / Error 65".
  const output = execFileSync("/usr/bin/xcrun", [
    "notarytool", "submit", targetPath, ...credentials.args, "--wait", "--output-format", "json"
  ], { encoding: "utf8" });
  const submitted = JSON.parse(output.trim().split("\n").at(-1));
  if (submitted.status !== "Accepted") {
    const log = JSON.parse(execFileSync("/usr/bin/xcrun", [
      "notarytool", "log", submitted.id, ...credentials.args
    ], { encoding: "utf8" }));
    const issues = (log.issues ?? []).map(issue => `  ${issue.path}\n    ${issue.message}`).join("\n");
    throw new Error(`Notarization failed (${submitted.status}, submission ID ${submitted.id}): ${log.statusSummary ?? ""}\n${issues}`);
  }

  // Staple the ticket so Gatekeeper verification works offline afterwards
  execFileSync("/usr/bin/xcrun", ["stapler", "staple", targetPath], { stdio: "inherit" });
  execFileSync("/usr/bin/xcrun", ["stapler", "validate", targetPath], { stdio: "inherit" });
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: node scripts/notarize-mac.mjs <path to dmg or zip>");

  const credentials = notaryCredentials();
  if (!credentials) {
    console.log("NOTARY_SKIPPED=1");
    console.log("NOTARY_REASON=No notarization credentials configured; skipping notarization");
    console.log("NOTARY_HINT=Set ADING_NOTARY_KEY_ID/KEY_ISSUER/KEY_PATH (recommended), or APPLE_ID/PASSWORD/TEAM_ID");
    process.exit(0);
  }

  notarize(target, credentials);
  console.log(`NOTARY_KIND=${credentials.kind}`);
  console.log(`NOTARY_TARGET=${path.basename(target)}`);
  console.log("NOTARY_STAPLED=1");
}
