import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AttachmentSaveDirectory, saveAttachmentFile } from "../dist/support/save-attachment.js";

const root = await mkdtemp(path.join(os.tmpdir(), "ading-save-image-"));
try {
  const source = path.join(root, "original.png"), destination = path.join(root, "saved.png");
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,255,0,128]);
  await writeFile(source, bytes);
  let sourceReads = 0, defaultName;
  const sourceFile = async () => { sourceReads++; return source; };
  assert.equal(await saveAttachmentFile({ name: "../original.png", sourceFile, chooseDestination: async name => { defaultName = name; return undefined; } }), false);
  assert.equal(defaultName, "original.png", "the save dialog receives a filename without directories");
  assert.equal(sourceReads, 0, "cancelling never downloads or writes the attachment");
  assert.equal(await saveAttachmentFile({ name: "original.png", sourceFile, chooseDestination: async () => destination }), true);
  assert.deepEqual(await readFile(destination), bytes, "the saved file retains the exact original bytes");
  assert.deepEqual(await readFile(source), bytes, "saving keeps the original attachment unchanged");
  assert.equal(await saveAttachmentFile({ name: "original.png", sourceFile, chooseDestination: async () => source }), true);
  assert.deepEqual(await readFile(source), bytes, "saving to the original path does not rewrite it");
  await assert.rejects(saveAttachmentFile({ name: "original.png", sourceFile, chooseDestination: async () => path.join(root, "missing", "image.png") }), /ENOENT/);
  await assert.rejects(saveAttachmentFile({ name: "original.png", sourceFile: async () => { throw Error("download failed"); }, chooseDestination: async () => destination }), /download failed/);
  assert.deepEqual(await readFile(destination), bytes, "a failed download does not damage an existing destination");

  const downloads = path.join(root, "downloads"), chosen = path.join(root, "chosen");
  await mkdir(downloads); await mkdir(chosen);
  const preferences = path.join(root, "preferences", "attachment-save.json");
  const directory = new AttachmentSaveDirectory(preferences, downloads);
  assert.equal(await directory.defaultPath("../first.png"), path.join(downloads, "first.png"), "first use starts in Downloads with the current filename");
  const savedPath = path.join(chosen, "first.png");
  await saveAttachmentFile({ name: "first.png", sourceFile, chooseDestination: async () => savedPath, onSaved: file => directory.remember(file) });
  assert.equal(await directory.defaultPath("second.png"), path.join(chosen, "second.png"), "the next image uses the previous successful save directory");
  const restarted = new AttachmentSaveDirectory(preferences, downloads);
  assert.equal(await restarted.defaultPath("after-restart.png"), path.join(chosen, "after-restart.png"), "the directory survives an app restart");
  const onSaved = file => restarted.remember(file);
  await saveAttachmentFile({ name: "cancelled.png", sourceFile, chooseDestination: async () => undefined, onSaved });
  assert.equal(await restarted.defaultPath("next.png"), path.join(chosen, "next.png"), "cancellation keeps the previous directory");
  await assert.rejects(saveAttachmentFile({ name: "failed.png", sourceFile, chooseDestination: async () => path.join(root, "missing", "failed.png"), onSaved }), /ENOENT/);
  assert.equal(await restarted.defaultPath("next.png"), path.join(chosen, "next.png"), "failed saves do not replace the previous directory");
  assert.deepEqual(await readdir(path.dirname(preferences)), ["attachment-save.json"], "atomic writes leave no temporary files");
  await rm(chosen, { recursive: true });
  assert.equal(await restarted.defaultPath("missing-directory.png"), path.join(downloads, "missing-directory.png"), "a deleted or disconnected location falls back to Downloads");
  await writeFile(preferences, "invalid JSON");
  assert.equal(await restarted.defaultPath("invalid.png"), path.join(downloads, "invalid.png"), "invalid preferences do not block saving");
  console.log("save-attachment: original bytes, cancellation, filename, remembered directory, restart, fallback and failures passed");
} finally { await rm(root, { recursive: true, force: true }); }
