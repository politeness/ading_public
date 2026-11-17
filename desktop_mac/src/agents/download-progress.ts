import { readFile, stat } from "node:fs/promises";
import type { RunResult } from "./process-runner";
import { p } from "../prompt-language";

export type InstallProgress = (text: string, download?: AgentDownloadProgress) => void;
type Run = (executable: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

/** Only the last complete HTTP response describes the archive. Redirect bodies
 * and partial-response Content-Length values are not the full download size. */
export function downloadTotal(headers: string): number | undefined {
  const blocks = headers.split(/\r?\n\r?\n/);
  const pending = blocks.pop();
  if (pending && /^HTTP\/\S+ \d{3}/.test(pending)) return undefined;
  const block = blocks.filter(value => /^HTTP\/\S+ \d{3}/.test(value)).at(-1);
  if (!block) return undefined;
  const lines = block.split(/\r?\n/), status = Number(lines.shift()?.split(/\s+/)[1]);
  const values = new Map(lines.map(line => { const at = line.indexOf(":"); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]; }));
  if (values.has("content-encoding") && values.get("content-encoding") !== "identity") return undefined;
  const range = values.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  const raw = status === 206 ? range?.[3] : status === 200 && !values.has("transfer-encoding") ? values.get("content-length") : undefined;
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const size = Number(raw);
  if (range && (Number(range[1]) > Number(range[2]) || Number(range[2]) >= size)) return undefined;
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

/** Inspect headers from the actual GET, so redirects and range resumes share
 * the same transfer and cancellation lifecycle; no extra HEAD request is needed. */
export async function downloadArchive(url: string, archive: string, run: Run, report: InstallProgress,
  label: string, httpsOnly = true): Promise<void> {
  const headers = `${archive}.headers`;
  let active = true, reporting = false, totalBytes: number | undefined;
  const progress = async () => {
    if (reporting) return;
    reporting = true;
    try {
      const [receivedBytes, raw] = await Promise.all([stat(archive).then(s => s.size, () => 0), readFile(headers, "utf8").catch(() => "")]);
      totalBytes = downloadTotal(raw);
      if (totalBytes !== undefined && receivedBytes > totalBytes) totalBytes = undefined;
      if (active) report(p(`${label}：正在下载，已接收 ${(receivedBytes / 1048576).toFixed(1)} MB`,
        `${label}: downloading, received ${(receivedBytes / 1048576).toFixed(1)} MB`), { receivedBytes, totalBytes });
    } finally { reporting = false; }
  };
  await progress();
  const timer = setInterval(() => { void progress(); }, 1000);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--location",
        ...(httpsOnly ? ["--proto", "=https", "--proto-redir", "=https"] : []),
        "--connect-timeout", "20", "--speed-limit", "1024", "--speed-time", "60", "--continue-at", "-",
        "--max-time", "1200", "--dump-header", headers, "--output", archive, url], 1_230_000);
      if (!result.failure && !result.cancelled && result.exitCode === 0) { await progress(); return; }
      const response = await readFile(headers, "utf8").catch(() => "");
      const status = Number([...response.matchAll(/^HTTP\/\S+ (\d{3})/gm)].at(-1)?.[1]);
      // Retrying access denial cannot repair a blocked download endpoint.
      const retryHttp = result.exitCode === 22 && [408, 429, 500, 502, 503, 504].includes(status);
      if (result.cancelled || attempt === 2 || (!retryHttp && ![5, 6, 7, 18, 28, 35, 52, 55, 56, 92].includes(result.exitCode ?? -1))) {
        if (status === 403) throw new Error(p("下载服务器拒绝访问（HTTP 403），请检查此电脑的网络后重试", "The download server denied access (HTTP 403). Check this computer's network and try again"));
        throw new Error(result.failure || result.stderr || p("下载未完成", "Download did not complete"));
      }
      report(p(`${label}：下载中断，正在续传`, `${label}: download interrupted, resuming`));
    }
  } finally { active = false; clearInterval(timer); }
}
