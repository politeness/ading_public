import assert from "node:assert/strict";
import { machineFingerprint, parsePlatformUuid, readMachineIdentity } from "../dist/account/machine.js";

let passed = 0;

const sample = `+-o MacBookPro18,1  <class IOPlatformExpertDevice, id 0x100000234, registered, matched, active, busy 0 (1 ms), retain 34>
    {
      "IOPlatformSerialNumber" = "XXXXXXXXXX"
      "IOPlatformUUID" = "9a0f33e6-77c6-5a84-aa51-d580cadabfbf"
    }`;

// Take the hardware UUID from ioreg output, normalizing case
{
  assert.equal(parsePlatformUuid(sample), "9A0F33E6-77C6-5A84-AA51-D580CADABFBF");
  assert.equal(parsePlatformUuid("nothing here"), undefined);
  passed++;
}

// The fingerprint is a hash: always the same on one computer, different across computers, and the original UUID cannot be seen
{
  const fingerprint = machineFingerprint("9A0F33E6-77C6-5A84-AA51-D580CADABFBF");
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, machineFingerprint("9a0f33e6-77c6-5a84-aa51-d580cadabfbf"));
  assert.notEqual(fingerprint, machineFingerprint("00000000-0000-0000-0000-000000000000"));
  assert.ok(!fingerprint.toUpperCase().includes("9A0F33E6"), "The server never touches the raw hardware ID");
  passed++;
}

// When the computer name is unavailable fall back to the host name; when the hardware UUID is unavailable throw, never pad with a random value
{
  const identity = await readMachineIdentity(async (file) => {
    if (file.endsWith("ioreg")) return sample;
    throw new Error("scutil unavailable");
  });
  assert.equal(identity.fingerprint, machineFingerprint("9A0F33E6-77C6-5A84-AA51-D580CADABFBF"));
  assert.ok(identity.name.length > 0);
  await assert.rejects(readMachineIdentity(async () => ""), /硬件 UUID/);
  passed++;
}

console.log(`machine: ${passed} passed, 0 failed`);
