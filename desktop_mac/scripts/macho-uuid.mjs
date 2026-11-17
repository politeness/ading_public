import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

/**
 * Gives the development build's main executable its own Mach-O UUID.
 *
 * The development, pre-release and release main executables are all renamed Electron binaries with identical LC_UUIDs.
 * macOS tracks Local Network permission by this UUID (see Apple TN3179), so the apps are treated as one program:
 * the development build neither prompts nor gets access, every LAN NAS connection fails with EHOSTUNREACH, and changing the bundle id doesn't help.
 *
 * The new UUID is derived from a seed (the bundle id) and is stable: repackaging yields the same one, so a granted "Allow" stays valid.
 * Must be called before signing — patching the binary invalidates the existing signature.
 */
export async function giveUniqueMachOUuid(executable, seed) {
  const data = await readFile(executable);
  const uuid = createHash("sha256").update(`ading-macho-uuid:${seed}`).digest().subarray(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x40; // set the version and variant bits per the UUID v4 format
  uuid[8] = (uuid[8] & 0x3f) | 0x80;

  const slices = [];
  const fatMagic = data.readUInt32BE(0);
  if (fatMagic === 0xcafebabe) {
    const count = data.readUInt32BE(4);
    for (let i = 0; i < count; i++) slices.push(data.readUInt32BE(8 + i * 20 + 8));
  } else {
    slices.push(0);
  }

  let patched = 0;
  for (const base of slices) {
    if (data.readUInt32LE(base) !== 0xfeedfacf) throw new Error(`Not a 64-bit Mach-O: ${executable}`);
    const ncmds = data.readUInt32LE(base + 16);
    let offset = base + 32;
    for (let i = 0; i < ncmds; i++) {
      const cmd = data.readUInt32LE(offset);
      const size = data.readUInt32LE(offset + 4);
      if (cmd === 0x1b) { // LC_UUID
        uuid.copy(data, offset + 8);
        patched++;
        break;
      }
      offset += size;
    }
  }
  if (patched !== slices.length) throw new Error(`LC_UUID not found: ${executable}`);
  await writeFile(executable, data);
  return [...uuid].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
