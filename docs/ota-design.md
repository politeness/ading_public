# ADing macOS Client OTA Update Design

**Status: implemented** (`desktop_mac/src/update/`): update checks, gray rollout by account / computer, download and sha256 verification,
pre-install checks, replace on quit / one-click restart to update, crash rollback.
Squirrel is not used; instead the .app is replaced by ADing itself. The reasons and approach are in "0. Implementation (self-replacing install)" below.
Sections 1 to 5 below are the original design draft, kept for background; where they conflict with Section 0, Section 0 takes precedence.

---

## 0. Implementation (Self-Replacing Install)

Squirrel.Mac requires both the old and new packages to be Developer ID signed with the same Team ID, and it refuses all of the current ad-hoc packages;
waiting for a certificate would mean OTA stays unusable. So ADing replaces itself instead; **this works with today's ad-hoc packages, and the flow won't need to change once the certificate arrives**:

1. **Check** (`updater.ts`): once 30 seconds after launch, then every 6 hours, call the conductor check API (see "Gray rollout" in Section 2).
2. **Download**: saved to `updates/packages/<version>/`, computing sha256 while downloading; deleted on mismatch. Only one version is kept.
3. **Stage** (`stageUpdate` in `installer.ts`, while the app is still running):
   mount with `hdiutil attach` → copy the .app out with `ditto` into `updates/staging.noindex/` → unmount, then verify:
   - the version in the package's `Contents/Resources/app/package.json` must equal the version provided by the server;
   - `codesign --verify --deep --strict` passes;
   - the signing identifier must be `com.politeness.ading`;
   - **when the current package has a Team ID, the new package must have the same Team ID** (this takes effect automatically once the certificate arrives,
     the same security baseline as Squirrel; ad-hoc packages have no Team ID, so this check has no effect for now).
   If any check fails, staging is deleted and the UI falls back to "Open installer" so the user installs manually.
4. **Replace** (after the app quits): `install.sh` runs as a separate process, waits until the ADing process has really exited (up to 120 seconds),
   moves the old package to `updates/rollback.noindex/` and moves the new package in; if placing the new package fails, the old one is put back. The log is in `updates/install.log`.
   The staging and rollback directory names carry `.noindex` so Spotlight doesn't index the .app inside; searching "ADing" shows only the one in Applications.
   - User clicks "Restart to update": if tasks are running, a confirmation dialog appears first, then quit → replace → reopen.
   - User doesn't click: on the next normal quit it's replaced automatically and not reopened (i.e. "takes effect on next launch").
   - The quit flow runs `stopAgentsGracefully()` first (Section 3, step 3); the replace script starts only at the very end.
5. **Rollback** (`health.ts`): if a version installed by OTA dies within 60 seconds of launch twice in a row (normal quits don't count),
   a dialog on the next launch asks whether to roll back. Rolling back uses the same script to swap the old package in `rollback.noindex/` back in;
   rolled-back versions (version + sha256) are recorded in `health.json`, and later update checks skip them.
   Once the new version has run healthily once (a full 60 seconds or a normal quit), the rollback copy is deleted so auto-update doesn't leave an extra copy of ADing on the user's computer;
   crashes that appear only after that no longer offer one-click rollback, and the old version can only be installed manually.

In these cases automatic replacement isn't possible and only "Open installer" is offered: development mode (`pnpm start`), running directly from the install disk image,
running under macOS quarantine (App Translocation, opened without being dragged into Applications), and no write permission to the install location.

Known limitations:
- Ad-hoc signatures differ on every build, so after switching packages macOS may ask again for keychain / folder and other permissions, just as with installing a new version manually.
- Replacement is two renames with a very short gap; if power is lost at exactly that instant, ADing may be temporarily missing from Applications;
  the old package is in `updates/rollback.noindex/ADing.app.swap` (or the new package in `updates/staging.noindex/`), and can simply be dragged back.

---
This was written before implementation because if several of its constraints (signing, child-process exit, channel isolation) were only discovered while writing code,
the rework would cost far more than thinking them through now.

---

## 1. Why We Must Wait for the Certificate

Auto-update on macOS goes through Squirrel.Mac (it is what `electron-updater` uses underneath).
**Before installing, Squirrel verifies the new package's code signature and requires it to belong to the same
Developer ID as the running copy (same Team ID)**. This is not an option that can be turned off; it is Squirrel's security model:
otherwise any program able to write to the download directory could swap the user's app for something else.

The current package is ad-hoc signed (`codesign --sign -`) and has no Team ID. Therefore:

- What **can** be implemented and verified before getting the certificate: version checks, download, checksum comparison, UI prompts,
  and wrapping up agents before the upgrade.
- What **cannot** be verified before getting the certificate: the step where Squirrel actually replaces the app bundle and restarts.

Forcing that step on an unsigned package yields failure information with no reference value — the reason it fails
(no Team ID) simply doesn't exist in the release build. So that step is left for verification after the certificate arrives.

The accompanying requirement is in [`scripts/sign-mac.mjs`](../desktop_mac/scripts/sign-mac.mjs): signing must include
`--timestamp`. Without a trusted timestamp, once the certificate expires or is replaced, **the old versions already installed on users' machines
will all stop working at once**, and OTA won't be able to rescue them either.

---

## 2. Version Source

> **The client does not read `release.json` to check for updates; it calls the conductor's
> `POST /api/v1/app/updates/check`**, because a static file can't know which account a request comes from and so can't do gray rollout.
> Rules and operations are in the "Gray rollout" section below. `release.json` is still used by the landing page.

The landing page's version source is already live:

```
https://www.coffeestudy.com.cn/ading/release.json
```

It is generated at release time by [`scripts/release.mjs`](../desktop_mac/scripts/release.mjs),
produced in the same pipeline run as the DMG, so **the version, size and sha256 naturally match the actual package**.
Current content:

```json
{
  "version": "0.2.0",
  "channel": "release",
  "arch": "arm64",
  "file": "ADing-0.2.0-arm64.dmg",
  "sizeMb": 134.3,
  "sha256": "3034b682…48cf",
  "url": "https://<OSS bucket>.oss-cn-shanghai.aliyuncs.com/ota/desktop_mac/releases/0.2.0/ADing-0.2.0-arm64.dmg",
  "releasedAt": "2026-09-13T09:37:00.581Z",
  "signed": false,
  "teamId": null
}
```

When implementing OTA, two fields need to be added to it:

| Field | Purpose |
|---|---|
| `minSupportedVersion` | Clients below this version can't upgrade incrementally and must download the full package again |
| `mandatory` | Marks a security fix; the user can't keep choosing "Later" |

`signed` and `teamId` are already there — the client should **refuse to use a `signed: false` version
as an auto-update target**, so that even if an unsigned package is released by mistake, it won't be pushed to all users.

### Channel visibility

The channel comes from `adingChannel` in `package.json` and is not parsed from the version string
(see the root [`README.md`](../README.md#versioning-and-release-channels)).

**The release and pre-release channels can see each other; the develop channel is isolated.**

- `release` ⇄ `pre`: both come from the same source and share one database. Pre-release builds are pushed by name to release users on the gray list for gray testing;
  once the release build is fully rolled out, the gray users are brought back onto the release track. Who sees what is controlled by `rollout` and the gray list,
  not by channel isolation — with channel isolation, pre-release users would be stuck on pre-release builds forever, while the UI told them "You're on the latest version".
- `develop` sees only itself: it connects to the NAS, may be rebuilt a dozen times a day, and its version strings carry the build time.
  Mixing it in would only push in-development packages to real users, or replace a development machine's build with a release package and interrupt development.

See `AppUpdateService.visibleChannels` for the implementation.

| Channel | Version source |
|---|---|
| `release` | Check API of the ECS production service `https://www.coffeestudy.com.cn` |
| `pre` | Check API of the ECS pre-release service `https://www.coffeestudy.com.cn/pre` (pre-release gray builds) |
| `develop` | Check API of the NAS development service `http://<NAS address>:8080` |

Pre-release and production share RDS, so the records of both channels in `app_releases` / `app_release_grays` are in the same table, distinguished by `channel`.

Comparison uses semver precedence rules. Because development builds are pre-releases,
`0.3.0-2026.9.13-093005-dev < 0.3.0`, so a development build will never "upgrade" itself to a state before the release build with the same number; the same applies to `-pre` pre-release builds.

---

### Gray rollout

Each version is registered as one row in the conductor's `app_releases` table, and `rollout` decides who receives it:

| rollout | Who receives it |
|---|---|
| `GRAY` | Only the accounts or computers named in `app_release_grays` (**default for new versions**) |
| `ALL` | All clients on the same channel and architecture |
| `OFF` | Nobody; clients that already downloaded it delete the installer on the next check |

Each row of the gray list names one target, attached by `(channel, version)`:

- `USER`: the online-edition account's `user_id`. The client checks with its token when logged in; if the token has expired it refreshes the token first and then checks.
- `MACHINE`: the computer identifier, i.e. the hash of the hardware UUID, the same value as `terminals.fingerprint`.
  The standalone edition has no account and relies on this to take part in gray rollout. How to get the value: for computers that have logged in, look in the `terminals` table;
  for the standalone edition, look at the `update-check` event in the client log (problem reports include logs).

Pre-release builds also look at account tags: accounts with the "pre-release gray" tag (`user_tags.tag = 'PRE_GRAY'`), and the computers those accounts have registered (`terminals.type = 'DESKTOP'`, including in standalone mode),
automatically see all `pre` versions, without being registered for every release. The tag only opens `pre` and doesn't affect gray rollout on the `release` channel. `app_release_grays` is kept for targets named separately for a given release.

From the versions that are "fully rolled out + matched by the list", the server picks the highest one above the client's current version.
The version comparison rules are in the conductor's `SemVer.java` and the client's `src/update/version.ts`, and the two agree:
there is only one difference from standard semver — the last segment of a development version is "day-HHMMSS-dev", which standard semver would compare as a whole string, giving
`2026.9.9-235959-dev > 2026.9.16-000000-dev`; here the leading number (the day) is compared first, then the rest is compared as text.
HHMMSS is always 6 digits, so text order is time order, and two development packages built on the same day can still be ordered, so testing OTA doesn't require changing the version number.

Common operations (`scripts/release.mjs` generates an `app-release.sql` with the version filled in among the release artifacts):

```sql
-- 1. Register a new version (default GRAY) — use the INSERT in app-release.sql

-- 2. Name gray targets
INSERT INTO app_release_grays (channel, version, target_type, target_id, remark) VALUES
  ('release', '0.4.0', 'USER',    'u_01J...', 'Internal test: Alice'),
  ('release', '0.4.0', 'MACHINE', '3f9a... (64 lowercase hex chars)', 'Standalone: Bob''s MacBook');

-- 3. See which gray versions an account / computer can get
SELECT * FROM app_release_grays WHERE target_type = 'USER' AND target_id = 'u_01J...';

-- 4. Verified OK, roll out to everyone
UPDATE app_releases SET rollout = 'ALL' WHERE channel = 'release' AND version = '0.4.0';

-- 5. Problem found, emergency takedown
UPDATE app_releases SET rollout = 'OFF' WHERE channel = 'release' AND version = '0.4.0';
```

Note: the API can be called anonymously and the computer identifier isn't secret, so gray rollout only decides "who it's pushed to"; **it is not access control**.
The installers themselves sit in a public-read OSS directory, so don't put anything that must not leak into a gray version.

## 3. Upgrade Flow

### 1. When to check

- About 30 seconds after the app launches (avoiding the startup peak, when agent probing is also running)
- Then once every 6 hours
- When the user clicks check manually under "Support"

Check failures are always silent: an unreachable update service isn't the user's problem and shouldn't interrupt them with a dialog.

### 2. Download and verification

Downloaded to `~/Library/Application Support/ADing/updates/<version>/`.
**After the download completes, the sha256 must be compared with the one in `release.json`**; on mismatch, delete and start over.

This step can't be skipped. The release pipeline has already hit a related pitfall: DMGs are not reproducible builds, and generating one twice from the same
`.app` gives different sha256 values, which is why [`release.mjs`](../desktop_mac/scripts/release.mjs)
chains the whole pipeline as "generate the artifact only once, and point every later reference at it". The same goes for the client —
the checksum is the only way to confirm "what the user downloaded is the same file we released".

### 3. Wrapping up before the upgrade (critical)

**This is where ADing differs most from an ordinary Electron app.** ADing spawns a batch of agent child processes,
and they are `detached: true` independent process groups — when the app process exits, they don't go with it.
If Squirrel simply restarted the app, it would leave behind a batch of orphan agent processes still holding workspace file handles,
which might fight with the new version once it starts.

Reuse the existing [`stopAgentsGracefully()`](../desktop_mac/src/main.ts) (`src/main.ts:110`):

```
scheduler.shutdown()            // stop dispatching new work
registry.cancelEverything()     // SIGTERM each agent first
registry.waitForAllExit(...)    // wait for actual exit, not a blind fixed delay
```

[`waitForExit`](../desktop_mac/src/agents/process-runner.ts) (`process-runner.ts:98`)
polls the `running` set; if a process exits instantly it returns right away, and if it exits slowly it won't let things through before it has fully exited.
`cancel` sends SIGTERM first and follows up with SIGKILL after 3 seconds, so **this must wait for actual exit**:
waiting too short lets things through before SIGKILL takes effect, and waiting too long needlessly slows the upgrade.

The returned `stubborn` list contains agents that still hadn't exited at the timeout. Their process groups have already received SIGKILL,
so logging it is enough; it no longer blocks the upgrade.

### 4. When to install

Don't restart while the user is working. Default policy:

- After the download completes, only show "A new version is ready and will take effect on next launch"
- Install immediately only when the user actively clicks "Restart to update now"
- When tasks are running, confirm first even if the user clicked — interrupting a task costs more than installing a few minutes later

Security fixes marked `mandatory` can be more forceful, but must still complete the wrap-up of step 3.

---

## 4. Rollback

Squirrel itself provides no rollback. A feasible fallback:

1. Keep the previous version's DMG under `updates/`, at most one copy
2. If the new version crashes twice within 60 seconds of launch, prompt the user to roll back to the kept copy
3. Installers already published on OSS are kept by default, so historical versions can be downloaded again; cleanup is the user's decision (the same copies are kept locally in `releases/publish/`)

### OSS directories

The bucket's (name in the deployment environment's `ADING_OSS_BUCKET`) top-level directories are planned by the user (2026-11-02); don't add or change them on your own:

| Directory | Contents | Access |
| --- | --- | --- |
| `ota/desktop_mac/releases\|prereleases/<version>/` | Installers for desktop release and pre-release builds | Public read |
| `ota/mobile_ios/releases\|prereleases/<version>/` | Reserved for mobile; mobile goes through the App Store and currently uploads no installers | Public read |
| `bug_report/<userId>/<report ID>/` | Screenshots and logs from problem reports; lookups go through the ops console's database | Private |
| `attachments/<userId>/image\|video\|file/<attachment ID>.<extension>` | Chat attachments, by uploading account, then by type | Private; the client uploads and downloads via temporary URLs signed by the backend |
| `communication/<userId>/<contact ID>/` | Attachments for user communication (contact the developer) | Private |
| `skill/<userId>/` | User skills, for future cloud use; currently empty | Private |
| `memory/<userId>/` | User memory, for future cloud use; currently empty | Private |

When the standalone edition has no account, `bug_report` and `communication` use the computer identifier (`terminals.fingerprint`) in place of userId; old clients carry neither and go under `anonymous`.

The bucket policy allows anonymous reads only for `ota/*`; other directories stay private.
Installer download URLs are therefore valid long-term and don't depend on signed-URL expiry.

---

## 5. Rollout Order

Once the certificate arrives, do it in this order; each step can be verified on its own:

1. Get signing and notarization working, confirm `security find-identity` shows the certificate
   and `spctl --assess` passes — without this step, everything after is built on sand
2. Add `minSupportedVersion` / `mandatory` to `release.json`
3. Implement check + download + sha256 verification in the client; the UI only prompts, no install yet
4. Hook up `stopAgentsGracefully()` and verify agents are really cleaned up before the upgrade
   (no orphan processes left in `ps`)
5. ~~Finally hook up Squirrel's install and restart~~ Changed to self-replacing install (see Section 0). A full upgrade verification
   with two real version numbers still needs to be done once on the NAS development channel

The first four steps are verified on the development channel (NAS); step 5 must use a properly signed package.
