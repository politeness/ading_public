# ADing Mobile (iOS)

Use your phone to remotely put ADing on your computer to work. The phone doesn't run agents:

1. The phone writes messages to the cloud (conductor).
2. **Desktop ADing (online mode)**, signed in to the same account and running, gets a push via MQTT, pulls the messages, and hands them to the agent on the computer.
3. The desktop app writes the agent's reply back to the cloud, and the phone picks it up by polling.

So the prerequisite is: the computer is on and desktop ADing is signed in to the same account. The green/grey light next to an agent in Contacts shows whether its computer is connected to the server.
You can still send while the computer is offline; the desktop app pulls and processes the messages the next time it connects.

## Layout

- `ADing/App`: entry point, global state (`AppModel`), messages of a single conversation (`ChatModel`)
- `ADing/Networking`: API, login tokens (keychain), server environment, attachment upload. **This directory is also compiled into the share extension**, so it may only use extension-safe APIs
- `ADing/Views`: login, conversations, contacts, chat, me
- `ADing/Resources`: icons (taken from desktop), `Info.plist`, Chinese/English strings (`zh-Hans.lproj`, `en.lproj`; new strings must be added to both; the share extension uses them too)
- `ADingShare`: the "Share to ADing" extension
- `scripts/generate-project.py`: generates `ADing.xcodeproj` (two targets: App and share extension)

## Attachments

Chats can send photos and videos (from the photo library) and any file (from the Files app), up to 200 MB each and at most 9 per message; attachments can be sent without text.
Files don't go through the backend: first register with `POST /conversations/{id}/attachments`, PUT directly to OSS using the returned signed URL, and send the message once the upload completes.
HEIC photos from the library are converted to JPEG before sending, so both desktop and the agents on the computer can open them directly.
Received attachments are downloaded on demand to the cache directory (image thumbnails, file previews); videos play directly from the signed URL.

## Problem feedback

Problem feedback can be opened from "Me" and the login page. It uses the same `/api/v1/support/reports` endpoint as desktop to reach the ops console, with no system mail client needed. It attaches the time of occurrence, a problem description, up to 5 manually added images that can be viewed or removed, and the diagnostic logs of the last 48 hours for the current account and server. Each image is at most 5 MB, 15 MB in total; the entry page isn't captured automatically.

On submit, the report is first saved atomically to the App's private pending-upload directory; it shows as submitted and the local body is cleaned up only after an `uploaded` / `duplicate` receipt with a matching report ID. Offline, timeouts, 429 and temporary server failures keep the report, retrying on launch, on returning to the foreground, and every minute while in the foreground; a report keeps its original submission environment and isn't redirected when the server is switched. Permanent rejections are kept as failed and show the reason. Diagnostic logs are isolated per account and server and record only metadata such as events and error codes, never chat content, passwords, tokens or request/response bodies.

## Share extension

In another App, tap "Share → ADing", pick a conversation, add a note (optional) and send; the agent on the computer receives it as usual.
The extension shares login state with the App:

- Login tokens are in the keychain group `<Team>.com.politeness.ading.shared`
- The current user and server environment are in the App Group `group.com.politeness.ading`

The entitlements for both targets are already in place. The first time you run in Xcode, automatic signing creates the extension's App ID
(`com.politeness.ading.share`) in the developer portal and enables App Groups for both App IDs; if it reports missing permissions, do it manually in the
[developer portal](https://developer.apple.com/account/resources/identifiers/list):

1. Identifiers → App Groups: create `group.com.politeness.ading`
2. App ID `com.politeness.ading`: check App Groups and select the group above
3. Create App ID `com.politeness.ading.share`, likewise check App Groups and select the same group

The keychain group needs no portal configuration. Before release, add "Photos or Videos" (used for App Functionality, linked to the user) under "App Privacy" in App Store Connect.

## Push

When the App isn't in the foreground, new messages arrive as system notifications (APNs). The phone reports its device token every time it returns to the foreground (`PUT /api/v1/terminals/me/push-device`, using the phone's terminal token) and unregisters on logout.

- Environment: development builds use `sandbox`; TestFlight (pre-release) and App Store both use `production`, with the same bundle id `com.politeness.ading`.
- Capabilities: `ADing.entitlements` is written by the generator script; change capabilities in the script. After export, verify with `codesign -d --entitlements - <App>` that `aps-environment` is `production`.
- Content: notifications show the sender, the conversation name (none for direct chats) and the body. iOS asks for notification permission itself.
- In the foreground the phone suppresses the banner itself; tapping a notification opens the conversation; the badge is the sum of unread across all conversations.
- The text language is reported by the phone (the language chosen in Settings, or the system's when following the system).
- For backend configuration see "Mobile push" in `conductor/docs/deployment.md`.

## Generating the project

Regenerate after adding or removing files (output is deterministic; rerunning produces no diff):

```bash
python3 mobile_ios/scripts/generate-project.py
```

## Installing on an iPhone

Requires full Xcode (not just the command line tools), a developer account signed in under Xcode → Settings → Accounts, and `DEVELOPMENT_TEAM` set in `ADing/Resources/Build.local.xcconfig` (not in Git).

1. Connect the iPhone with a cable and enable "Settings → Privacy & Security → Developer Mode" on the iPhone.
2. Open `mobile_ios/ADing.xcodeproj`, select your iPhone, and run.
3. After the first install, trust the developer certificate on the iPhone under "Settings → General → VPN & Device Management".

## Tests

`tests/` contains pure logic tests independent of UI and networking. Compile and run them directly with swiftc (run from `mobile_ios/`, output goes to a temp directory); the exit code is non-zero on failure, with or without `-O`:

```bash
out=$(mktemp -d)
swiftc ADing/App/AppRules.swift tests/AppRulesTests.swift -o "$out/rules" && "$out/rules"
swiftc -parse-as-library ADing/App/MqttActivityState.swift tests/MqttActivityStateTests.swift -o "$out/mqtt" && "$out/mqtt"
swiftc -parse-as-library ADing/Networking/ProblemFeedback.swift ADing/Networking/L10n.swift ADing/Networking/SharedStore.swift tests/ProblemFeedbackTests.swift -o "$out/feedback" && "$out/feedback"
rm -rf "$out"
```

## TestFlight pre-release gray rollout

Pre-release builds are distributed through Apple TestFlight; there is no self-hosted iOS install service, and installation isn't controlled by phone UUID. Gray rollout targets testers or tester groups in App Store Connect; don't use a public invite link in place of targeted rollout.

1. In Xcode select the shared scheme **ADing Pre**, target **Any iOS Device**, and run Product → Archive. `Pre` uses Release optimization, but both the App and the share extension always connect to the pre-release server; an Archive from the regular `ADing` scheme is still a release build. Don't upload Debug builds to TestFlight.
2. Validate the archive in Organizer, then upload via **Distribute App → TestFlight & App Store**. Xcode can manage the Apple build number for each upload; the pre-release version shown in ADing's UI is still the build-time generated `0.8.0-<date>-<time>-pre`, without changing the three-part version Apple requires. Uploading and distributing change external state of the Apple account and must be confirmed and performed by the person responsible for the release.
3. In App Store Connect → TestFlight, create a dedicated gray group with automatic distribution off, add the build to that group first, then invite testers one by one. Builds for external testing may need Apple's Beta App Review. Later builds are also added only to the designated group; testers install and update in TestFlight, and regular App Store users never receive pre-release builds.

On launch and on returning to the foreground, pre-release builds check the ADing server for forced updates; once logged in they send the account token, so the server can return iOS versions by `USER` gray rollout, now compared using the full pre-release build number. Regular pre-release updates are prompted by TestFlight itself and **don't depend** on versions registered on the ADing server. If a forced update for `platform=ios` is registered separately, its `url` must point to an HTTPS TestFlight invite entry available to testers; for release builds `url` is still the App Store page. Tester groups are the install permission boundary; the ADing server's gray records are only in-app prompts and can't replace TestFlight authorization.

## Servers

The login page lets you choose: develop (NAS `http://<NAS address>:8080`, reachable only on the home LAN), pre-release, production. Pre-release is the default.

Math formulas in chat use the local KaTeX assets shared with desktop (`desktop_mac/src/assets/math`); project generation adds the whole directory to the App, so no network or CDN is needed. Regular chat still uses native text; formula messages are typeset with local WebKit, and copying keeps the original text.
