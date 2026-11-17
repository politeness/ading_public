import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildTelemetryBody, describeTelemetry, postTelemetryAnonymously, TELEMETRY_ROUTE } from "../dist/support/telemetry.js";

let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`); passed += 1; };
const fingerprint = "f".repeat(64);

const full = buildTelemetryBody({ fingerprint, platform: "darwin", phone: " 13800000000 ", email: "a@b.com", readyAgents: ["qoder", "codex", "qoder"] });
check("device type mac", full.deviceType === "mac");
check("device id is the computer id", full.deviceUuid === fingerprint);
check("available Agents deduplicated and sorted", JSON.stringify(full.agents) === JSON.stringify(["codex", "qoder"]), full.agents);
check("phone number whitespace removed", full.phone === "13800000000");
const bare = buildTelemetryBody({ fingerprint, platform: "darwin", phone: "", email: "  ", readyAgents: [] });
check("phone and email omitted when absent", !("phone" in bare) && !("email" in bare), bare);
check("empty list when no Agents are available", Array.isArray(bare.agents) && bare.agents.length === 0);
const described = JSON.stringify(describeTelemetry(full));
check("log does not record phone or email contents", !described.includes("13800000000") && !described.includes("a@b.com") && described.includes('"phone":true'), described);

// Anonymous report: success, backend error, unreachable
let received;
const server = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
  const bad = received.body.deviceUuid === "bad";
  res.writeHead(bad ? 400 : 200, { "Content-Type": "application/json" }).end(JSON.stringify(bad ? { code: "BAD", message: "invalid device id format" } : { code: "OK" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const ok = await postTelemetryAnonymously(base, full);
  check("anonymous report succeeds", ok.ok === true, ok);
  check("hits the telemetry endpoint", received.url === TELEMETRY_ROUTE);
  check("anonymous report carries no token and no user_id", received.auth === undefined && !("userId" in received.body), received);
  const rejected = await postTelemetryAnonymously(base, { ...full, deviceUuid: "bad" });
  check("returns the reason when the backend rejects", rejected.ok === false && rejected.message === "invalid device id format", rejected);
} finally {
  server.close();
}
const offline = await postTelemetryAnonymously("http://127.0.0.1:1", full, 2000);
check("returns failure without throwing when unreachable", offline.ok === false && offline.message.length > 0, offline);

console.log(`telemetry: ${passed} passed, 0 failed`);
