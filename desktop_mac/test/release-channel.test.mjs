import assert from "node:assert/strict";
import {
  baseVersionOf,
  buildTimeOf,
  describeRelease,
  formatBuildTime,
  formatVersion,
  resolveChannel
} from "../dist/shared/release.js";

// Official semver.org regex, copied verbatim
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
import { resolveSupportEndpoints, API_BASE_URL } from "../dist/support/endpoints.js";

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); passed += 1; }
  catch (error) { failed += 1; console.error(`FAIL: ${label} -> ${error?.message ?? error}`); }
}

check("defaults to dev", () => {
  assert.equal(resolveChannel({ version: "0.1.0" }, {}), "develop");
  assert.equal(resolveChannel({ version: "0.1.0", adingChannel: "develop" }, {}), "develop");
});

check("release must be declared explicitly", () => {
  assert.equal(resolveChannel({ version: "0.1.0", adingChannel: "release" }, {}), "release");
});

check("pre-release must be declared explicitly", () => {
  assert.equal(resolveChannel({ version: "0.1.0", adingChannel: "pre" }, {}), "pre");
  assert.equal(resolveChannel({ version: "0.1.0", adingChannel: "develop" }, { ADING_CHANNEL: "PRE" }), "pre");
});

check("environment variable can override the channel", () => {
  assert.equal(
    resolveChannel({ version: "0.1.0", adingChannel: "release" }, { ADING_CHANNEL: "develop" }),
    "develop"
  );
});

// Unrecognized values are always treated as dev: better to fail to reach the dev machine than let a misspelled channel name
// point a dev build at production.
check("unrecognized channel name falls back to dev", () => {
  assert.equal(resolveChannel({ version: "0.1.0", adingChannel: "produktion" }, {}), "develop");
  assert.equal(resolveChannel({ version: "0.1.0" }, { ADING_CHANNEL: "prod" }), "develop");
});

check("version string has the agreed format", () => {
  assert.equal(formatVersion("0.1.0", "2026.9.12-093005", "develop"), "0.1.0-2026.9.12-093005-dev");
  assert.equal(formatVersion("0.1.0", "2026.9.12-093005", "pre"), "0.1.0-2026.9.12-093005-pre");
  assert.equal(formatVersion("0.1.0", "2026.9.12-093005", "release"), "0.1.0");
});

// The version string goes into package.json version and must be valid semver, or the packager rejects it.
check("both version strings are valid semver", () => {
  assert.match("0.1.0-2026.9.12-093005-dev", SEMVER);
  assert.match("0.1.0", SEMVER);
  assert.match(formatVersion("0.1.0", formatBuildTime(new Date()), "develop"), SEMVER);
});

// A dev build is a prerelease of its release version: 0.1.0-2026.9.12-093005-dev < 0.1.0.
check("dev has prerelease, release does not", () => {
  assert.equal(SEMVER.exec("0.1.0-2026.9.12-093005-dev")[4], "2026.9.12-093005-dev");
  assert.equal(SEMVER.exec("0.1.0")[4], undefined);
});

// Zero-padding month and day makes semver invalid; h/m/s joined with -dev forms an alphanumeric segment where padding is valid, and it must be fixed-width to compare as text.
check("build time: no padding for month/day, h/m/s padded to 6 digits", () => {
  assert.equal(formatBuildTime(new Date(2026, 8, 12, 9, 30, 5)), "2026.9.12-093005");
  assert.equal(formatBuildTime(new Date(2026, 10, 3, 23, 59, 59)), "2026.11.3-235959");
  assert.equal(formatBuildTime(new Date(2026, 0, 1, 0, 0, 0)), "2026.1.1-000000");
  assert.doesNotMatch("0.1.0-2026.09.12-093005-dev", SEMVER);
  for (let month = 0; month < 12; month += 1) {
    for (const hour of [0, 9, 10, 23]) {
      const version = formatVersion("0.1.0", formatBuildTime(new Date(2026, month, 5, hour, 1, 2)), "develop");
      assert.match(version, SEMVER, version);
    }
  }
});

// In the packaged app, version is already the full string; appending again must not stack.
check("full string is not appended twice", () => {
  assert.equal(baseVersionOf("0.1.0-2026.9.12-093005-dev"), "0.1.0");
  assert.equal(baseVersionOf("0.1.0"), "0.1.0");
  assert.equal(
    formatVersion("0.1.0-2026.9.12-093005-dev", "2026.9.13-101010", "develop"),
    "0.1.0-2026.9.13-101010-dev"
  );
  const packaged = describeRelease(
    { version: "0.1.0-2026.9.12-093005-dev", adingChannel: "develop", adingBuildTime: "2026.9.12-093005" }, {}
  );
  assert.equal(packaged.displayVersion, "0.1.0-2026.9.12-093005-dev");
  assert.equal(packaged.baseVersion, "0.1.0");
});

check("uses now when build time is missing or malformed", () => {
  const now = new Date(2026, 8, 12, 8, 7, 6);
  assert.equal(buildTimeOf({ version: "0.1.0" }, now), "2026.9.12-080706");
  assert.equal(buildTimeOf({ version: "0.1.0", adingBuildTime: "garbage" }, now), "2026.9.12-080706");
  assert.equal(buildTimeOf({ version: "0.1.0", adingBuildTime: "2026.1.5-235959" }, now), "2026.1.5-235959");
  // Padded month/day makes semver invalid; non-fixed-width time breaks ordering; the old date-only format is not accepted either
  assert.equal(buildTimeOf({ version: "0.1.0", adingBuildTime: "2026.09.12-080706" }, now), "2026.9.12-080706");
  assert.equal(buildTimeOf({ version: "0.1.0", adingBuildTime: "2026.9.12-80706" }, now), "2026.9.12-080706");
  assert.equal(buildTimeOf({ version: "0.1.0", adingBuildTime: "2026.9.12-246000" }, now), "2026.9.12-080706");
  assert.equal(buildTimeOf({ version: "0.1.0", adingBuildTime: "2026.9.12" }, now), "2026.9.12-080706");
});

check("overall description", () => {
  const dev = describeRelease(
    { version: "0.1.0", adingChannel: "develop", adingBuildTime: "2026.9.12-093005" }, {}
  );
  assert.equal(dev.displayVersion, "0.1.0-2026.9.12-093005-dev");
  assert.equal(dev.channel, "develop");

  // Release is a clean three-part version, with no date or tag
  const release = describeRelease(
    { version: "0.1.0", adingChannel: "release", adingBuildTime: "2026.9.12-093005" }, {}
  );
  assert.equal(release.displayVersion, "0.1.0");
  assert.equal(release.channel, "release");
});

// This is what the mechanism really guarantees: dev connects to localhost by default, release connects to production.
check("dev backend defaults to localhost", () => {
  const endpoints = resolveSupportEndpoints("develop", {});
  assert.equal(endpoints.report, `${API_BASE_URL.develop}/api/v1/support/reports`);
  assert.equal(new URL(endpoints.report).hostname, "localhost");
});

check("release backend is ECS", () => {
  const endpoints = resolveSupportEndpoints("release", {});
  assert.equal(endpoints.report, `${API_BASE_URL.release}/api/v1/support/reports`);
  assert.match(endpoints.report, /coffeestudy\.com\.cn/);
  assert.doesNotMatch(endpoints.report, /192\.168\./);
});

// Pre-release and production services both run on ECS; Nginx proxies the /pre/ prefix to 8180. It must never connect to the NAS or production.
check("pre-release backend is the pre-release service on ECS", () => {
  const endpoints = resolveSupportEndpoints("pre", {});
  assert.equal(endpoints.report, "https://www.coffeestudy.com.cn/pre/api/v1/support/reports");
  assert.notEqual(API_BASE_URL.pre, API_BASE_URL.release);
  for (const url of Object.values(endpoints)) assert.match(url, /^https:\/\//, url);
});

// Reports upload screenshots and runtime logs; release goes over the public internet, so plaintext is unacceptable.
check("release must use HTTPS", () => {
  for (const url of Object.values(resolveSupportEndpoints("release", {}))) {
    assert.match(url, /^https:\/\//, url);
  }
  // Hardcoding an IP means re-releasing when the server changes, and IPs cannot get certificates
  assert.doesNotMatch(API_BASE_URL.release, /^https?:\/\/\d+\.\d+\.\d+\.\d+/);
});

check("explicitly configured address takes precedence over the channel default", () => {
  const endpoints = resolveSupportEndpoints("release", { ADING_API_BASE_URL: "http://127.0.0.1:8080" });
  assert.equal(endpoints.report, "http://127.0.0.1:8080/api/v1/support/reports");
});

console.log(`release-channel: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
