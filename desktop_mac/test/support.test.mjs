import { mkdtemp } from "./tmp.mjs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { SupportReportQueue, validateSupportReport } from "../dist/support/report.js";

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};
const expectError = (name, fn, text) => {
  try { fn(); check(name, false, "did not throw"); }
  catch (error) { check(name, String(error).includes(text), String(error)); }
};

const image = (name = "screen.png") => ({
  name,
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,aGVsbG8="
});
const occurredAt = "2026-09-03T12:34:00.000Z";
const report = (patch = {}) => ({ occurredAt, description: "按钮无法正常点击", images: [], ...patch });

check("description is trimmed", validateSupportReport(report({ description: "  按钮无法点击  " })).description === "按钮无法点击");
expectError("occurrence time is required", () => validateSupportReport(report({ occurredAt: "" })), "发生时间");
expectError("description cannot be too short", () => validateSupportReport(report({ description: "坏了" })), "至少");
expectError("at most five images", () => validateSupportReport(report({ images: Array.from({ length: 6 }, (_, i) => image(`${i}.png`)) })), "最多");
expectError("rejects non-image attachments", () => validateSupportReport(report({ images: [{ ...image(), mimeType: "text/plain", dataUrl: "data:text/plain;base64,WA==" }] })), "格式");
expectError("rejects forged data URL", () => validateSupportReport(report({ images: [{ ...image(), dataUrl: "https://example.com/a.png" }] })), "无效");
check("automatic screenshot is validated with the report", Boolean(validateSupportReport(report({ screenshot: image() })).screenshot));
check("occurrence time truncated to seconds", validateSupportReport(report({ occurredAt: "2026-09-03T12:34:59.999Z" })).occurredAt === "2026-09-03T12:34:59.000Z");

const dir = await mkdtemp(path.join(os.tmpdir(), "ading-support-"));
const queue = new SupportReportQueue(dir);
const queued = await queue.enqueue(
  report({ description: "点击发送以后没有任何反应", screenshot: image(), images: [image("extra.png")] }),
  { appVersion: "0.1.0", platform: "darwin", arch: "arm64", mode: "local", logs: [{ name: "last-run.log", content: "safe log" }] }
);
check("report enters pending-upload", queued.status === "pending-upload", queued);
const saved = JSON.parse(await readFile(queued.filePath, "utf8"));
check("description intact after report is persisted", saved.description === "点击发送以后没有任何反应", saved);
check("report with occurrence time uses schema v3", saved.schemaVersion === 3, saved.schemaVersion);
check("report stores a separate occurrence time", saved.occurredAt === occurredAt, saved.occurredAt);
check("report includes runtime context and logs automatically", saved.context.platform === "darwin" && saved.context.logs[0].content === "safe log", saved.context);
check("report includes screenshot and user images automatically", saved.screenshot.name === "screen.png" && saved.images[0].name === "extra.png");


console.log(`support: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
