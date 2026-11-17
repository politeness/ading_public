import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  DeveloperContactQueue,
  validateDeveloperContact
} from "../dist/support/developer.js";

const clean = validateDeveloperContact({
  subject: "  功能   建议  ",
  content: "  希望增加任务模板。  ",
  replyTo: "  reader@example.com  "
});
assert.equal(clean.subject, "功能 建议");
assert.equal(clean.content, "希望增加任务模板。");
assert.equal(clean.replyTo, "reader@example.com");

assert.throws(
  () => validateDeveloperContact({ subject: " ", content: "内容", replyTo: "" }),
  /请填写主题/
);
assert.throws(
  () => validateDeveloperContact({ subject: "主题", content: " ", replyTo: "" }),
  /请填写内容/
);
assert.equal(
  validateDeveloperContact({ subject: "问候", content: "你好", replyTo: "" }).replyTo,
  ""
);

const withFiles = validateDeveloperContact({
  subject: "合作",
  content: "看下方案",
  replyTo: "",
  attachments: [{ name: "../../方案.pdf", mimeType: "application/pdf", base64: "AAAA" }]
});
assert.equal(withFiles.attachments[0].name, "方案.pdf");
assert.equal(validateDeveloperContact({ subject: "问候", content: "你好", replyTo: "" }).attachments.length, 0);
const file = (bytes) => ({ name: "a.bin", mimeType: "", base64: "A".repeat(Math.ceil(bytes / 3) * 4) });
assert.throws(
  () => validateDeveloperContact({ subject: "主题", content: "内容", replyTo: "", attachments: Array(6).fill(file(1)) }),
  /最多可以添加 5 个附件/
);
assert.throws(
  () => validateDeveloperContact({ subject: "主题", content: "内容", replyTo: "", attachments: [file(5 * 1024 * 1024 + 3)] }),
  /不能超过 5 MB/
);
assert.throws(
  () => validateDeveloperContact({ subject: "主题", content: "内容", replyTo: "", attachments: Array(4).fill(file(4 * 1024 * 1024)) }),
  /附件总大小不能超过 15 MB/
);

const directory = await mkdtemp(path.join(os.tmpdir(), "ading-developer-contact-"));
const queue = new DeveloperContactQueue(directory);
const queued = await queue.enqueue(clean, {
  appVersion: "0.1.0",
  platform: "darwin",
  arch: "arm64",
  mode: "remote",
  userId: "u_test",
  terminalId: "terminal_test"
});
assert.equal(queued.status, "pending-send");
const saved = JSON.parse(await readFile(queued.filePath, "utf8"));
assert.equal(saved.subject, "功能 建议");
assert.equal(saved.context.platform, "darwin");
assert.equal(saved.context.userId, "u_test");
assert.equal(saved.context.terminalId, "terminal_test");
assert.match(saved.contactId, /^contact_/);

console.log("developer-contact: 14 passed, 0 failed");
