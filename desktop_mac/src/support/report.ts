import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tm } from "../i18n";

export const MAX_SUPPORT_IMAGES = 5;
export const MAX_SUPPORT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SUPPORT_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;

function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  return Math.ceil((dataUrl.length - comma - 1) * 0.75);
}

function safeImage(image: SupportImagePayload): SupportImagePayload {
  const name = path.basename(image.name.trim()).slice(0, 160) || "image.png";
  if (!/^image\/(png|jpeg|webp)$/i.test(image.mimeType)) {
    throw new Error(tm("svc.support.imageFormat", { type: image.mimeType || tm("svc.support.unknownType") }));
  }
  if (!image.dataUrl.startsWith(`data:${image.mimeType};base64,`)) {
    throw new Error(tm("svc.support.imageInvalid", { name }));
  }
  const bytes = dataUrlBytes(image.dataUrl);
  if (bytes > MAX_SUPPORT_IMAGE_BYTES) {
    throw new Error(tm("svc.support.imageTooLarge", { name }));
  }
  return { name, mimeType: image.mimeType, dataUrl: image.dataUrl };
}

export function validateSupportReport(
  input: SupportReportInput
): SupportReportInput {
  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error(tm("svc.support.timeRequired"));
  occurredAt.setMilliseconds(0);
  const description = input.description.trim();
  if (description.length < 5) throw new Error(tm("svc.support.descriptionTooShort"));
  if (description.length > 4000) throw new Error(tm("svc.support.descriptionTooLong"));
  if (input.images.length > MAX_SUPPORT_IMAGES) {
    throw new Error(tm("svc.support.tooManyImages", { max: MAX_SUPPORT_IMAGES }));
  }
  const images = input.images.map(safeImage);
  const screenshot = input.screenshot ? safeImage(input.screenshot) : undefined;
  const total = [...images, ...(screenshot ? [screenshot] : [])]
    .reduce((sum, image) => sum + dataUrlBytes(image.dataUrl), 0);
  if (total > MAX_SUPPORT_TOTAL_IMAGE_BYTES) {
    throw new Error(tm("svc.support.imagesTooLarge"));
  }
  return { occurredAt: occurredAt.toISOString(), description, images, screenshot };
}

/**
 * Reliable upload outbox until OSS is wired up. Each report is self-contained, so app crashes or restarts lose nothing.
 * Later the OSS uploader only needs to read the JSON files here one by one and move them into sent/ after upload succeeds.
 */
export class SupportReportQueue {
  constructor(private readonly directory: string) {}

  async enqueue(
    input: SupportReportInput,
    context: SupportReportContext
  ): Promise<SupportReportResult> {
    const safe = validateSupportReport(input);
    const reportId = `report_${randomUUID()}`;
    const payload = {
      schemaVersion: 3,
      reportId,
      createdAt: new Date().toISOString(),
      status: "pending-upload",
      ...safe,
      context
    };
    await mkdir(this.directory, { recursive: true });
    const filePath = path.join(this.directory, `${reportId}.json`);
    await writeFile(filePath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
    return { reportId, status: "pending-upload", filePath, backgroundUpload: false };
  }
}
