import { mkdtemp } from "./tmp.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { AccountProfiles } from "../dist/account/profiles.js";

let passed = 0;
const dir = await mkdtemp(path.join(os.tmpdir(), "ading-account-profiles-"));
const file = path.join(dir, "account", "profiles.json");
const sampleuser = { userId: "u_x", username: "sampleuser", displayName: "sampleuser" };
const other = { userId: "u_o", username: "other", displayName: "其他人" };

// No saved profile: the display name uses the account nickname, and the username comes from the account
{
  const profiles = new AccountProfiles(file);
  assert.deepEqual(await profiles.get(sampleuser), {
    userId: "u_x",
    username: "sampleuser",
    displayName: "sampleuser",
    avatarUrl: undefined,
    phone: undefined,
    email: undefined
  });
  passed++;
}

// Changes are persisted and survive reopening; leading/trailing spaces are trimmed as in standalone mode
{
  const profiles = new AccountProfiles(file);
  const saved = await profiles.update(sampleuser, {
    displayName: "  老板  ",
    avatarUrl: "data:image/png;base64,eA==",
    phone: " 13800138000 ",
    email: "boss@example.com"
  });
  assert.equal(saved.displayName, "老板");
  assert.equal(saved.phone, "13800138000");
  const reopened = await new AccountProfiles(file).get(sampleuser);
  assert.equal(reopened.displayName, "老板");
  assert.equal(reopened.avatarUrl, "data:image/png;base64,eA==");
  assert.equal(reopened.email, "boss@example.com");
  assert.equal(reopened.username, "sampleuser", "username always comes from the account");
  passed++;
}

// Validation matches standalone mode; if any field is invalid, the whole update is rejected
{
  const profiles = new AccountProfiles(file);
  await assert.rejects(profiles.update(sampleuser, { displayName: "   " }), /花名不能为空/);
  await assert.rejects(
    profiles.update(sampleuser, { displayName: "改了名", avatarUrl: "https://x/y.png" }),
    /头像格式无效/
  );
  await assert.rejects(profiles.update(sampleuser, { phone: "1".repeat(31) }), /手机号不能超过 30 个字符/);
  assert.equal((await profiles.get(sampleuser)).displayName, "老板", "a failed update leaves nothing half-applied");
  passed++;
}

// Clear phone and avatar; profiles of different accounts don't affect each other
{
  const profiles = new AccountProfiles(file);
  const cleared = await profiles.update(sampleuser, { phone: "", avatarUrl: "" });
  assert.equal(cleared.phone, undefined);
  assert.equal(cleared.avatarUrl, undefined);
  assert.equal((await profiles.get(other)).displayName, "其他人");
  await profiles.update(other, { displayName: "另一个" });
  assert.equal((await profiles.get(sampleuser)).displayName, "老板");
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(onDisk).sort(), ["u_o", "u_x"]);
  passed++;
}

// Concurrent saves of different fields right after opening: none overwrites another, all are persisted
{
  const fresh = path.join(dir, "concurrent-fields", "profiles.json");
  const profiles = new AccountProfiles(fresh);
  await Promise.all([
    profiles.update(sampleuser, { displayName: "甲" }),
    profiles.update(sampleuser, { phone: "123" }),
    profiles.update(sampleuser, { email: "a@b.c" })
  ]);
  const reopened = await new AccountProfiles(fresh).get(sampleuser);
  assert.deepEqual(
    [reopened.displayName, reopened.phone, reopened.email],
    ["甲", "123", "a@b.c"]
  );
  passed++;
}

// Consecutive saves of the same field right after opening: persisted in order, the last one wins
{
  const profiles = new AccountProfiles(file);
  await Promise.all([
    profiles.update(sampleuser, { displayName: "一" }),
    profiles.update(sampleuser, { displayName: "二" }),
    profiles.update(sampleuser, { displayName: "三" })
  ]);
  assert.equal((await new AccountProfiles(file).get(sampleuser)).displayName, "三");
  passed++;
}

console.log(`account-profiles: ${passed} passed, 0 failed`);
