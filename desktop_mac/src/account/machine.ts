import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { tm } from "../i18n";

/**
 * Identity of this computer.
 *
 * The cloud identifies a computer by unique ID, not by name: names can collide or be changed by the user, so they're display-only.
 * The unique ID is the macOS hardware UUID (IOPlatformUUID):
 *   - unchanged by reinstalling the OS or replacing RAM/disks;
 *   - unchanged by deleting app data or reinstalling ADing (an app-generated random ID can't do that);
 *   - when moving to a new Mac with Migration Assistant, the new Mac has its own UUID (a random ID would be copied over, merging two computers into one).
 * Before upload it is SHA-256 hashed with an ADing-specific prefix; the server stores only the hash and never sees the raw hardware ID.
 */

export interface MachineIdentity {
  /** Hash of the hardware UUID, used as the cloud terminals.fingerprint */
  fingerprint: string;
  /** The macOS "Computer Name", display-only */
  name: string;
}

export type RunCommand = (file: string, args: string[]) => Promise<string>;

const FINGERPRINT_PREFIX = "ading-desktop:";

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** Extracts IOPlatformUUID from the output of `ioreg -rd1 -c IOPlatformExpertDevice` */
export function parsePlatformUuid(output: string): string | undefined {
  const match = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(output);
  return match?.[1].toUpperCase();
}

export function machineFingerprint(hardwareUuid: string): string {
  return createHash("sha256").update(FINGERPRINT_PREFIX + hardwareUuid.toUpperCase()).digest("hex");
}

export async function readMachineIdentity(run: RunCommand = runCommand): Promise<MachineIdentity> {
  const uuid = parsePlatformUuid(await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
  if (!uuid) throw new Error(tm("svc.account.noHardwareUuid"));
  let name = "";
  try {
    name = (await run("/usr/sbin/scutil", ["--get", "ComputerName"])).trim();
  } catch {
    // A missing computer name doesn't affect identification; fall back to the hostname
  }
  return { fingerprint: machineFingerprint(uuid), name: name || os.hostname() };
}

/** The hardware UUID doesn't change while the app runs; read it once */
let cached: Promise<MachineIdentity> | undefined;

export function machineIdentity(): Promise<MachineIdentity> {
  cached ??= readMachineIdentity().catch((error) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

/**
 * Identity of a local Agent: "type@computer UUID", the same for offline and online modes.
 *
 * The computer UUID is the first 128 bits of the computer fingerprint (hash of the hardware UUID), in standard UUID format:
 * it doesn't expose the raw hardware ID, survives computer renames, and fits the cloud local_uuid column.
 * If the hardware UUID can't be read, fall back to the hostname so the Agent still works.
 */
export async function agentLocalUuid(kind: string): Promise<string> {
  try {
    const hex = (await machineIdentity()).fingerprint.slice(0, 32);
    return `${kind}@${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  } catch {
    return `${kind}@${os.hostname()}`;
  }
}
