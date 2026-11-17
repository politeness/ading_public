import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { uploadPendingReportsOnce } from "../dist/support/uploader.js";
import { resolveSupportEndpoints, API_BASE_URL } from "../dist/support/endpoints.js";

const root = await mkdtemp(path.join(os.tmpdir(), "ading-support-uploader-"));
const pending = path.join(root, "pending");
await mkdir(pending, { recursive: true });
const payload = {
  schemaVersion: 3,
  reportId: "report_test",
  occurredAt: "2026-09-03T12:34:00.000Z",
  description: "发送按钮无响应"
};
await writeFile(path.join(pending, "report_test.json"), JSON.stringify(payload), "utf8");

let received = "";
const server = http.createServer((request, response) => {
  request.setEncoding("utf8");
  request.on("data", (chunk) => { received += chunk; });
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"code":"OK"}');
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");

const results = [];
await uploadPendingReportsOnce({
  pendingDirectory: pending,
  endpoint: `http://127.0.0.1:${address.port}/api/v1/support/reports`,
  onResult: (result) => results.push(result)
});
await new Promise((resolve) => server.close(resolve));

assert.deepEqual(JSON.parse(received), payload);
assert.equal(results[0]?.ok, true);
assert.deepEqual(await readdir(pending), []);
const sent = path.join(root, "sent", "report_test.json");
assert.equal(JSON.parse(await readFile(sent, "utf8")).reportId, "report_test");

// The packaged app has no environment variables; the built-in per-channel address must keep the uploader working.
const fallback = resolveSupportEndpoints("develop", {});
assert.equal(fallback.report, `${API_BASE_URL.develop}/api/v1/support/reports`);
assert.equal(fallback.contact, `${API_BASE_URL.develop}/api/v1/support/contacts`);
assert.equal(fallback.config, `${API_BASE_URL.develop}/api/v1/support/config`);

const based = resolveSupportEndpoints("develop", { ADING_API_BASE_URL: "https://api.example.com/" });
assert.equal(based.report, "https://api.example.com/api/v1/support/reports");

// Old config with only reports set: the other addresses must be derivable.
const legacy = resolveSupportEndpoints("develop", {
  ADING_SUPPORT_REPORT_URL: "https://api.example.com/api/v1/support/reports"
});
assert.equal(legacy.contact, "https://api.example.com/api/v1/support/contacts");
assert.deepEqual(resolveSupportEndpoints("develop", { ADING_SUPPORT_DISABLED: "1" }), {});

// 400: the backend rejects the request itself; retrying is pointless, so it must leave pending.
const rejectPending = path.join(root, "reject", "pending");
await mkdir(rejectPending, { recursive: true });
await writeFile(path.join(rejectPending, "report_bad.json"), JSON.stringify(payload), "utf8");
const rejecting = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end('{"code":"COMMON_400","message":"发生时间必须精确到分钟"}');
  });
});
await new Promise((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
const rejected = [];
await uploadPendingReportsOnce({
  pendingDirectory: rejectPending,
  endpoint: `http://127.0.0.1:${rejecting.address().port}/api/v1/support/reports`,
  onResult: (result) => rejected.push(result)
});
await new Promise((resolve) => rejecting.close(resolve));
assert.equal(rejected[0]?.ok, false);
assert.equal(rejected[0]?.permanent, true);
assert.match(rejected[0]?.error ?? "", /发生时间必须精确到分钟/);
assert.deepEqual(await readdir(rejectPending), []);
assert.ok((await readdir(path.join(root, "reject", "failed"))).includes("report_bad.json"));

// 503: the server is temporarily unavailable; the report stays in pending for the next round.
const retryPending = path.join(root, "retry", "pending");
await mkdir(retryPending, { recursive: true });
await writeFile(path.join(retryPending, "report_retry.json"), JSON.stringify(payload), "utf8");
const unavailable = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"code":"COMMON_500","message":"OSS 配置不完整"}');
  });
});
await new Promise((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
const retried = [];
await uploadPendingReportsOnce({
  pendingDirectory: retryPending,
  endpoint: `http://127.0.0.1:${unavailable.address().port}/api/v1/support/reports`,
  onResult: (result) => retried.push(result)
});
await new Promise((resolve) => unavailable.close(resolve));
assert.equal(retried[0]?.permanent, false);
assert.deepEqual(await readdir(retryPending), ["report_retry.json"]);

// The success receipt is persisted separately: when email is not configured, the OSS address can only be recovered from here.
const receiptPending = path.join(root, "receipt", "pending");
await mkdir(receiptPending, { recursive: true });
await writeFile(path.join(receiptPending, "report_receipt.json"), JSON.stringify(payload), "utf8");
const withReceipt = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      code: "OK",
      data: {
        reportId: "report_receipt",
        status: "uploaded",
        images: { "screen.jpg": "https://oss.example/screen.jpg" }
      }
    }));
  });
});
await new Promise((resolve) => withReceipt.listen(0, "127.0.0.1", resolve));
const receipts = [];
await uploadPendingReportsOnce({
  pendingDirectory: receiptPending,
  endpoint: `http://127.0.0.1:${withReceipt.address().port}/api/v1/support/reports`,
  onResult: (result) => receipts.push(result)
});
await new Promise((resolve) => withReceipt.close(resolve));
assert.equal(receipts[0]?.ok, true);
assert.equal(receipts[0]?.receipt?.status, "uploaded");
const receiptFile = path.join(root, "receipt", "sent", "report_receipt.receipt.json");
assert.equal(
  JSON.parse(await readFile(receiptFile, "utf8")).images["screen.jpg"],
  "https://oss.example/screen.jpg"
);

console.log("support-uploader: 20 passed, 0 failed");
