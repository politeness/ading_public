import assert from "node:assert/strict";
import { CloudPush } from "../dist/store/cloud-push.js";

// When the server returns enabled:false or credentials can't be fetched, keep retrying MQTT with backoff and log it. Connecting, receiving frames, reconnecting and sleep are covered in mqtt.test.mjs.
const until = async (check, what) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), what);
};
const pushes = [];
try {
  const logs = [];
  let requests = 0, connected = 0;
  const disabled = new CloudPush({
    credentials: async () => { requests += 1; return { enabled: false }; },
    onConversationChanged() {}, onConnected: () => { connected += 1; },
    log: (event, data) => { logs.push({ event, ...data }); }, maxRetryMs: 20
  });
  pushes.push(disabled);
  disabled.start();
  await until(() => logs.filter((entry) => entry.event === "cloud-mqtt-disabled").length >= 3, "keeps retrying MQTT and logging while enabled:false");
  assert.ok(requests >= 3, "every retry fetches credentials again");
  assert.equal(connected, 0);
  assert.equal(disabled.send("TURN_PROGRESS", {}), false, "nothing can be sent while not connected");

  // No credential fetches during sleep; retry immediately on wake
  disabled.pause();
  const paused = requests;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests, paused, "no retries while asleep");
  disabled.resume();
  await until(() => requests > paused, "retries immediately on wake");
  disabled.stop();
  const stopped = requests;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests, stopped, "no more retries after stop");

  const failing = new CloudPush({
    credentials: async () => { throw new Error("MQTT credentials unavailable"); },
    onConversationChanged() {}, onConnected() {},
    log: (event, data) => { logs.push({ event, ...data }); }, maxRetryMs: 20
  });
  pushes.push(failing);
  failing.start();
  await until(() => logs.filter((entry) => entry.event === "cloud-mqtt-credentials-failed").length >= 3, "keeps retrying MQTT and logging when the credentials endpoint fails");
  failing.stop();
  assert.ok(logs.find((entry) => entry.event === "cloud-mqtt-credentials-failed").reason.includes("MQTT credentials unavailable"), "the credentials-failure log includes the specific reason");
} finally {
  for (const push of pushes) push.stop();
}
console.log("cloud-push: retry on disabled/unavailable credentials, sleep/wake and stop passed");
