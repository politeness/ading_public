import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tm } from "../i18n";

const SUBJECT_LIMIT = 120;
const CONTENT_LIMIT = 4000;
const REPLY_TO_LIMIT = 200;
export const MAX_CONTACT_ATTACHMENTS = 5;
export const MAX_CONTACT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_CONTACT_ATTACHMENT_TOTAL_BYTES = 15 * 1024 * 1024;

function oneLine(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function validateAttachments(
  attachments: DeveloperContactAttachment[] | undefined
): DeveloperContactAttachment[] {
  const files = attachments ?? [];
  if (files.length > MAX_CONTACT_ATTACHMENTS) {
    throw new Error(tm("svc.support.tooManyAttachments", { max: MAX_CONTACT_ATTACHMENTS }));
  }
  let total = 0;
  const safe = files.map((file) => {
    const name = path.basename(String(file.name ?? "").trim()).slice(0, 160) || "file";
    const bytes = Buffer.byteLength(String(file.base64 ?? ""), "base64");
    if (bytes > MAX_CONTACT_ATTACHMENT_BYTES) {
      throw new Error(tm("svc.support.imageTooLarge", { name }));
    }
    total += bytes;
    return { name, mimeType: String(file.mimeType ?? "").slice(0, 100), base64: String(file.base64 ?? "") };
  });
  if (total > MAX_CONTACT_ATTACHMENT_TOTAL_BYTES) {
    throw new Error(tm("svc.support.attachmentsTooLarge"));
  }
  return safe;
}

export function validateDeveloperContact(
  input: DeveloperContactInput
): DeveloperContactInput {
  const subject = oneLine(input?.subject, SUBJECT_LIMIT);
  const content = String(input?.content ?? "").trim().slice(0, CONTENT_LIMIT);
  const replyTo = oneLine(input?.replyTo, REPLY_TO_LIMIT);
  if (!subject) throw new Error(tm("svc.support.subjectRequired"));
  if (!content) throw new Error(tm("svc.support.contentRequired"));
  return { subject, content, replyTo, attachments: validateAttachments(input?.attachments) };
}

/**
 * The same reliable outbox as issue reports. IPC only writes to disk; the actual network request is done by the Worker.
 */
export class DeveloperContactQueue {
  constructor(private readonly directory: string) {}

  async enqueue(
    input: DeveloperContactInput,
    context: DeveloperContactContext
  ): Promise<DeveloperContactResult> {
    const safe = validateDeveloperContact(input);
    const contactId = `contact_${randomUUID()}`;
    const payload = {
      schemaVersion: 1,
      contactId,
      createdAt: new Date().toISOString(),
      status: "pending-send",
      ...safe,
      context
    };
    await mkdir(this.directory, { recursive: true });
    const filePath = path.join(this.directory, `${contactId}.json`);
    await writeFile(filePath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
    return { contactId, status: "pending-send", filePath, backgroundUpload: false };
  }
}
