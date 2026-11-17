import { tm } from "../i18n";
/**
 * Version comparison, using the same rules as SemVer.java in the server-side conductor.
 *
 * Standard semver compares mixed segments that start with digits, like `16-093005-dev`, as strings, which yields
 * `0.4.0-2026.9.9-235959-dev > 0.4.0-2026.9.16-000000-dev`. The last segment of ADing dev versions is exactly "day-HHMMSS-dev",
 * so segments starting with digits compare the number (day) first, then the rest as text (HHMMSS is always 6 digits, so text order is time order).
 * Otherwise identical to semver:
 * a prerelease is lower than the release with the same number, numeric segments are lower than string segments, fewer segments are lower, and build metadata is ignored.
 */

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

const PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(text: string): Parsed | undefined {
  const match = PATTERN.exec(text.trim());
  if (!match) return undefined;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (!core.every(Number.isSafeInteger)) return undefined;
  return { core, pre: match[4] ? match[4].split(".") : [] };
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== undefined;
}

/** Returns a negative number when a < b. Throws if either is invalid; callers filter with isValidVersion first */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(tm("svc.update.versionInvalid", { version: !pa ? a : b }));
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (!pa.pre.length || !pb.pre.length) {
    return (pa.pre.length ? 0 : 1) - (pb.pre.length ? 0 : 1);
  }
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const c = compareIdentifier(pa.pre[i], pb.pre[i]);
    if (c !== 0) return c;
  }
  return Math.sign(pa.pre.length - pb.pre.length);
}

const isNumeric = (s: string) => /^\d+$/.test(s);
const leadingDigits = (s: string) => /^\d*/.exec(s)?.[0] ?? "";

function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifier(a: string, b: string): number {
  const an = isNumeric(a);
  const bn = isNumeric(b);
  if (an && bn) return compareDigits(a, b);
  const ad = leadingDigits(a);
  const bd = leadingDigits(b);
  if (ad && bd) {
    return compareDigits(ad, bd) || compareText(a.slice(ad.length), b.slice(bd.length));
  }
  if (an !== bn) return an ? -1 : 1;
  return compareText(a, b);
}
