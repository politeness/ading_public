import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

/** App-local save location, retained across restarts without sharing language preferences. */
export class AttachmentSaveDirectory {
  constructor(private readonly file: string, private readonly fallback: string) {}

  async defaultPath(name: string): Promise<string> {
    let directory = this.fallback;
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as { directory?: unknown };
      if (typeof saved.directory === "string" && path.isAbsolute(saved.directory) &&
          (await stat(saved.directory)).isDirectory()) directory = saved.directory;
    } catch {
      // A missing, invalid or disconnected location falls back to Downloads.
    }
    return path.join(directory, path.basename(name));
  }

  async remember(destination: string): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, JSON.stringify({ directory: path.dirname(path.resolve(destination)) }), { mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Export the original attachment bytes, using only the destination chosen by the user. */
export async function saveAttachmentFile(input: {
  name: string;
  chooseDestination(name: string): Promise<string | undefined>;
  sourceFile(): Promise<string>;
  onSaved?(destination: string): Promise<void>;
}): Promise<boolean> {
  const destination = await input.chooseDestination(path.basename(input.name));
  if (!destination) return false;
  const source = await input.sourceFile();
  if (path.resolve(source) !== path.resolve(destination)) await copyFile(source, destination);
  await input.onSaved?.(destination);
  return true;
}
