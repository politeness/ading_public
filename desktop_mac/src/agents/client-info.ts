/**
 * The identity ADing reports to vendors.
 *
 * Codex's app-server handshake requires clientInfo (`required: ["name","version"]`; it's rejected without it),
 * and vendors use it to track "which client and version is calling". It used to be hardcoded to 0.1.0 and never updated across several releases,
 * so when investigating "a certain version has issues calling Codex", the vendor saw only 0.1.0 and couldn't tell them apart.
 *
 * The version is set once by the main process at startup: the modules with these two call sites are imported directly by plain node tests
 * and can't import electron, so they don't read the app's package.json themselves.
 * If unset it reports "0", explicitly meaning "unknown", rather than claiming a specific version.
 */
let version = "0";

export function setClientVersion(value: string): void {
  const trimmed = value.trim();
  if (trimmed) version = trimmed;
}

/** clientInfo sent to vendors. name is fixed; version follows the actually running version */
export function clientInfo(): { name: string; version: string } {
  return { name: "ading", version };
}
