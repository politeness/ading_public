import path from "node:path";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";

export interface SupportUploadOutcome {
  file: string;
  ok: boolean;
  /** true means this report won't be retried: the backend rejects the request itself, so retrying never helps. */
  permanent?: boolean;
  httpStatus?: number;
  error?: string;
  /** data from the backend receipt, included on success (issue reports include the OSS address). */
  receipt?: unknown;
}

export interface SupportUploaderOptions {
  pendingDirectory: string;
  endpoint: string;
  timeoutMs?: number;
  onResult?: (result: SupportUploadOutcome) => void;
}

/** The backend always returns { code, message, data }; a non-OK code also counts as failure. */
interface ResultEnvelope {
  code?: string;
  message?: string;
  data?: unknown;
}

/**
 * Only an invalid request counts as a permanent failure: resending it later never gets better.
 * 408/429 and 5xx mean "not this time"; keep it in pending and retry next round.
 */
function isPermanent(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

function parseEnvelope(text: string): ResultEnvelope | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ResultEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

export async function uploadPendingReportsOnce(
  options: SupportUploaderOptions
): Promise<void> {
  const endpoint = options.endpoint.trim();
  if (!endpoint) return;
  await mkdir(options.pendingDirectory, { recursive: true });
  const root = path.dirname(options.pendingDirectory);
  const sentDirectory = path.join(root, "sent");
  const failedDirectory = path.join(root, "failed");
  const files = (await readdir(options.pendingDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();

  for (const file of files) {
    const source = path.join(options.pendingDirectory, file);
    const settle = async (status: number, message: string): Promise<void> => {
      const permanent = isPermanent(status);
      if (permanent) {
        await mkdir(failedDirectory, { recursive: true });
        await rename(source, path.join(failedDirectory, file));
        await writeFile(
          path.join(failedDirectory, file.replace(/\.json$/, ".error.txt")),
          `${new Date().toISOString()} ${message}\n`,
          "utf8"
        );
      }
      options.onResult?.({ file, ok: false, permanent, httpStatus: status, error: message });
    };
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await readFile(source, "utf8"),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000)
      });
      const text = await response.text();
      const envelope = parseEnvelope(text);

      if (!response.ok) {
        const message = envelope?.message?.trim() || text.slice(0, 300);
        await settle(response.status, `HTTP ${response.status}: ${message}`);
        continue;
      }
      if (envelope?.code && envelope.code !== "OK") {
        // 200 but the business code isn't OK: treat as the backend rejecting this report, no retry.
        await settle(400, `${envelope.code}: ${envelope.message ?? ""}`.trim());
        continue;
      }

      await mkdir(sentDirectory, { recursive: true });
      await rename(source, path.join(sentDirectory, file));
      // Store the receipt separately: if email isn't configured or fails to send, the OSS address can only be recovered from here.
      if (envelope?.data !== undefined) {
        await writeFile(
          path.join(sentDirectory, file.replace(/\.json$/, ".receipt.json")),
          JSON.stringify(envelope.data, null, 2),
          "utf8"
        );
      }
      options.onResult?.({ file, ok: true, httpStatus: response.status, receipt: envelope?.data });
    } catch (error) {
      // Network error or timeout: keep in pending, continue next round.
      options.onResult?.({ file, ok: false, permanent: false, error: String(error) });
    }

  }
}
