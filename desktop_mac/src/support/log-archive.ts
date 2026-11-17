import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

const BLOCK = 512;

export interface ArchiveEntry {
  name: string;
  content: Buffer;
  modifiedAt?: number;
}

function octal(value: number, length: number): string {
  // tar numeric fields are octal ASCII, last byte reserved for NUL
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function writeField(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value.slice(0, length), offset, length, "utf8");
}

/**
 * ustar header for one file. The checksum must first be computed with "8 spaces", then written back —
 * that's what the tar format requires; get it wrong and macOS's archive utility rejects the whole archive.
 */
function tarHeader(entry: ArchiveEntry): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeField(header, entry.name, 0, 100);
  writeField(header, octal(0o644, 8), 100, 8);
  writeField(header, octal(0, 8), 108, 8);
  writeField(header, octal(0, 8), 116, 8);
  writeField(header, octal(entry.content.length, 12), 124, 12);
  writeField(header, octal(Math.floor((entry.modifiedAt ?? Date.now()) / 1000), 12), 136, 12);
  header.write("        ", 148, 8, "utf8");
  writeField(header, "0", 156, 1);
  writeField(header, "ustar\0", 257, 6);
  writeField(header, "00", 263, 2);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
  return header;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/** Tar then gzip. Double-clicking .tar.gz on macOS extracts it directly, no extra tools needed. */
export async function createLogArchive(entries: ArchiveEntry[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry), entry.content, padding(entry.content.length));
  }
  // tar ends with two all-zero blocks
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipAsync(Buffer.concat(parts), { level: 9 });
}

export function archiveFileName(at: Date = new Date()): string {
  return `阿钉日志-${at.toISOString().replace(/[:.]/g, "-")}.tar.gz`;
}
