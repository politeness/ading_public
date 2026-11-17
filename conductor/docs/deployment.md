# conductor deployment guide

Three environments, the same code, the same directory layout. They differ only in what relates to production releases and testing.
For versioning and channel rules see the repo root [README](../../README.md#versioning-and-release-channels): development `-dev` connects to the NAS,
pre-release (gray) `-pre` connects to the ECS pre-release service, and production `a.b.c` connects to the ECS production service.

**This document is maintained only in the repo; do not copy it to servers.** Each machine once kept its own
`DEPLOYMENT.md`; both fell behind the changes, and the NAS copy even set the profile to `prod`.
An outdated deployment note is more dangerous than none, because people follow it when things go wrong.

---

## 1. The three environments

| | Development (NAS) | Pre-release (ECS) | Production (ECS) |
| --- | --- | --- | --- |
| Desktop channel | `develop`, version `a.b.c-date-time-dev` | `pre`, version `a.b.c-date-time-pre` | `release`, version `a.b.c` |
| Machine | Synology DS224+, <NAS-host> | Shared with production: ECS instance `<ECS-instance-ID>`, public <ECS-public-IP>, private <ECS-private-IP>, Ubuntu 24.04 | Same as left |
| Login | `ssh <NAS-user>@<NAS-host>` (use `sudo` for admin operations) | `ssh root@<ECS-public-IP>` | Same as left |
| Deploy directory | `<NAS-deploy-dir (volume path)>` (equivalent to `<NAS-deploy-dir>` over SSH) | `<pre-deploy-dir>` | `<prod-deploy-dir>` |
| systemd service | `ading_service` | `ading_service_pre` | `ading_service` |
| Port | 8080 | 8180 | 8080 |
| profile (`SPRING_PROFILES_ACTIVE`) | `dev` | `pre` (a profile group that includes all of `prod`'s config) | `prod` |
| Database | Local MariaDB 10.11.6 on the NAS, `localhost:3306/ading` | **Shared with production** RDS database | RDS MySQL 8.0.36, `<RDS-private-domain>:3306/ading`, resolving inside ECS to private <RDS-private-IP> |
| OSS endpoint | `oss-cn-shanghai` (public) | `oss-cn-shanghai-internal` (VPC private) | Same as left |
| Java | `/volume1/opt/java` (Temurin JRE 25), shared machine-wide, not in the app directory | System package `temurin-25-jre`, `/usr/bin/java` | Same as left |
| Run-as user | `politeness:users` | root | root |
| JVM memory | `-Xms128m -Xmx768m` | `-Xms128m -Xmx512m` | `-Xms128m -Xmx512m` |
| Public entry | `http://<NAS-host>:8080` | `https://www.coffeestudy.com.cn/pre` (Nginx reverse-proxies `/pre/` to 127.0.0.1:8180) | `https://www.coffeestudy.com.cn` (Nginx reverse-proxies to 8080) |

NAS database CLI: `sudo mysql -hlocalhost -P3306 -uroot -p'<password>' -Dading`.
Over non-interactive SSH, `sudo`'s PATH lacks `/usr/local/bin`, so use the full path `sudo /usr/local/bin/mysql …`.

**Pre-release and production are the same environment**: the same ECS, the same RDS database, the same OSS private endpoint;
only the service directory (with its `env`, logs, and backups), service name, and port differ. Therefore:

- Schema changes used by the pre-release backend are changes to the production database. Back up and ask the user first, make only backward-compatible additions,
  and never let them break the live production backend.
- Pre-release and production client versions are registered in the same `app_releases` table, distinguished by `channel` (`pre` / `release`), never mixed.
- 8180 listens only for Nginx and is not opened to the public in the security group; pre-release clients always go through `https://www.coffeestudy.com.cn/pre`.

The NAS database and RDS are independent, with no replication or sync.

**The profile decides whether OSS goes over the private or public network, and getting it wrong has concrete consequences**: the NAS is not inside the Alibaba Cloud VPC,
so private domains don't resolve; starting with `prod` makes reports hang until TCP timeout (about 24 seconds measured) before failing.
Conversely, ECS using the public endpoint makes a needless trip over the internet. At startup `SupportStartupCheck`
logs the current profile and the endpoint actually used, with a WARN if misconfigured.

Alibaba Cloud components (ECS, RDS, OSS) always talk over private IPs or private domains. Correct any misuse of public addresses.

---

## 2. Directory layout (same in all three environments)

```
ading/
├─ ading_conductor.jar      Spring Boot executable JAR
├─ env                      config, mode 600, contains credentials, not in the repo
├─ backup/                  all backups; don't scatter them in the root
└─ log/                     all logs
```

Java is not in the app directory; each machine uses its own system Java, see below.

- **The jar file name has no version**, so the unit doesn't need changing on upgrade. The version is on the first line of the startup log
  (`Starting ConductorApplication v0.3.0 ...`) and in `Implementation-Version` of
  `META-INF/MANIFEST.MF` inside the jar.
- **`env` contains the database password, auth secret, OSS credentials, and ops console token**; its mode must be 600.
- **Connected mode is open in all regions; the region restriction applies only to the client's add-friend entry**: registration, login, token refresh, friend APIs, and the desktop push connection are never rejected by region.
  Login and token refresh responses include `canAddFriend`; logged-in clients can also refresh the permission for their current IP via `GET /api/v1/auth/region-policy`.
  Mainland China IPv4 / IPv6 returns no add-friend; Hong Kong, Macau, Taiwan, and overseas can; accounts tagged "mainland add-friend" (`user_tags.tag = 'MAINLAND_ADD_FRIEND'`) can still add friends from the mainland.
  Tag changes take effect immediately without restart; the backend returns only the caller's own permission and never sends the list. The former `ADING_REGION_BLOCK_MAINLAND` and `ADING_REGION_EXEMPT_USERS` are no longer used.
- **One log file per day, uncompressed**: `log/ading.<date>.<index>.log`, with today's in `log/ading.log`,
  kept for 14 days with a 2 GB total cap. Not compressing is deliberate — compressed logs must be unpacked before reading history.
  All related settings are in `LOGGING_*` in `env`.
- **Java is uniformly 25 (the current latest LTS), but the two machines get it differently.** It was briefly upgraded to 26 and rolled back to 25 because 26 is not LTS (support ends around 2027-03).
  ECS is Ubuntu: the Adoptium apt repo was added to install `temurin-25-jre`, a real system package that follows apt updates; the unit uses `/usr/bin/java` directly without pinning a versioned path.
  The NAS is Synology: **there is no package manager at all** (no `apt`/`yum`/`opkg`), and the Package Center
  `java-installer` hard-codes `JDK_URL` to JDK 23 via the ghproxy.cn mirror (on this machine
  the download failed verification and wouldn't install). So it can only be unpacked manually, into **`/volume1/opt/java`** —
  shared machine-wide, outside the app directory, usable by other programs too, and symlinked to `/usr/local/bin/java`.
  **Don't install into `/usr/local` or `/opt`**: both are on the system partition `/dev/md0`, which DSM updates
  rewrite (evidence: `/usr/local/lib`, `/usr/local/SynologyApplicationService`, and
  `/usr/lib` have timestamps in the same minute). The unit uses absolute `/volume1/...` paths, so even if
  the `/usr/local/bin` symlink is wiped by an update, the service still starts.
- **The compile target is Java 25** (`<java.version>` in `pom.xml`), bytecode major version 69.
- **Spring Boot 4.1.1.** Upgrading from 3.3.5 changed only two things: the parent version and
  `mybatis-spring-boot-starter` 3.0.3 → 4.1.0 (MyBatis's major version follows Spring Boot).
  The only code change was **Jackson 2 → Jackson 3**: in Boot 4, `com.fasterxml.jackson` is
  entirely gone from the dependencies (showing up as a runtime `NoClassDefFound`, not caught at compile time); switching the imports in 6 files
  to `tools.jackson.databind` was enough, with the API calls themselves unchanged.

### Where the systemd unit is

**`/etc/systemd/system/ading_service.service`, and only there**; the pre-release service on ECS is `/etc/systemd/system/ading_service_pre.service`.
The pre-release unit differs from the production unit only in `WorkingDirectory`, `EnvironmentFile`, the jar path, and `SyslogIdentifier` (all pointing at `<pre-deploy-dir>` and `ading_service_pre`);
the pre-release `env` is copied from the production `env`, changing only `SPRING_PROFILES_ACTIVE=pre`, `SERVER_PORT=8180`, and the log path to `<pre-deploy-dir>/log/`.

A copy used to live in the deploy directory; systemd never read it, it was purely "just in case". Both machines' copies
fell behind — at the 2026-09-13 check, the NAS copy lacked the UTF-8 flags and the ECS copy still pointed at the renamed
old jar. Restoring from it would garble Chinese or start the wrong version, which is more dangerous than no copy, so it has been deleted.
To back up, take a fresh copy: `cp /etc/systemd/system/ading_service.service backup/`.

---

## 3. A logging pitfall: the NAS must specify UTF-8 explicitly

Synology has no UTF-8 locale (`LANG` is empty), so the JVM's `sun.jnu.encoding` is
`ANSI_X3.4-1968` (pure ASCII), and Chinese in logs, OSS object names, and ops console content all becomes `?`.
**This did not change after moving to Java 25** (the default is still ASCII, measured), so in the NAS unit
ExecStart must always include:

```
-Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8
```

ECS is Ubuntu, whose locale is UTF-8 already, so it doesn't have this problem.

---

## 4. Updating the JAR

```sh
# 1. Build and confirm tests pass (currently 74, local JDK 25); clean is required, or stale output from deleted sources gets included
mvn -B clean package

# 2. Copy to the server as .jar.new
#    scp directly for ECS; for the NAS see the next section
# 3. In the deploy directory, back up the old one, replace, and restart (pre-release: <pre-deploy-dir> + ading_service_pre)
cp ading_conductor.jar backup/ading_conductor.jar.bak-$(date +%Y%m%d-%H%M%S)
mv ading_conductor.jar.new ading_conductor.jar
systemctl restart ading_service
```

A version is promoted in the order **NAS (development) → ECS pre-release → ECS production**; each stage must run the same jar verified by the previous one (compare sha256).
During development only the NAS is deployed; pre-release and production are both on ECS and are touched only when the user asks for a pre-release or production release.

- Swapping the jar alone needs no `daemon-reload`; only unit changes do.
- **Database migrations must be evaluated separately: rolling back the jar does not roll back the database.**
- **The database has no version management, and the service never alters tables on startup.** Only one up-to-date `docs/create-database.sql` is maintained;
  to bring an existing environment up to the new schema, ALTER statements are evaluated and run separately, backing up the database first:
  `MYSQL_PWD=… mysqldump --single-transaction ading > backup/ading-db.bak-<time>.sql`.
- The same version runs the same jar in all three environments. All environment differences are carried by `env` and the profile; never build
  a separate package for one environment.

### Copying files to the NAS

Synology's SFTP subsystem is modified to confine the path space to a virtual root of DSM shared folders
(only `/docker`, `/home`, `/homes`, `/web`, `/web_packages`). This causes two pitfalls:

- **`root` over SFTP is disconnected immediately**, logging `not found share [volume1]`, because root
  has no corresponding share mapping.
- **`politeness` works over SFTP, but the path differs**: in SFTP the deploy directory is
  `<NAS-deploy-dir (SFTP path)>`, not `<NAS-deploy-dir>` as under SSH.

Since OpenSSH 9, `scp` uses the SFTP protocol by default, so `scp root@…:/var/services/…` fails
(showing `scp: Connection closed`). Three working forms:

```bash
# 1) Default scp: use politeness + the shared virtual root path
scp target/*.jar <NAS-user>@<NAS-host>:<NAS-deploy-dir (SFTP path)>/

# 2) scp -O: force the legacy SCP protocol, bypassing the sftp subsystem, so the real SSH path works
scp -O target/*.jar <NAS-user>@<NAS-host>:<NAS-deploy-dir>/

# 3) Without scp
ssh <NAS-user>@<NAS-host> 'cat > <NAS-deploy-dir>/x.jar.new' < local-file
```

No switches need changing in DSM.

---

## 5. Management commands

```sh
systemctl status ading_service --no-pager
systemctl restart ading_service
journalctl -u ading_service -n 100 --no-pager

# Health check: returns {"status":"UP"} normally; becomes DOWN (HTTP 503) if the database is unreachable
curl -s http://127.0.0.1:8080/actuator/health

# Today's log
tail -f <deploy-dir>/log/ading.log
```

- For ECS pre-release, change the service name to `ading_service_pre` and the port to 8180; check from outside via Nginx:
  `curl -s https://www.coffeestudy.com.cn/pre/actuator/health`.
- For the NAS, log in with `ssh <NAS-user>@<NAS-host>` and prefix systemctl with `sudo`.

---

## 6. Current status and boundaries

- 74 unit tests pass, 2 of which are real-upload cases that run only with real OSS credentials and are skipped by default.
- Issue reporting and contacting the developer are verified for real in both environments: images, desktop logs (tail text +
  tar.gz), and backend logs (`服务端日志.log.gz`, at the time the last 2 MB of the current log, compressed to about 25 KB measured; now the last 48 hours, see support-reporting.md)
  all uploaded successfully, links reachable from outside, Sina Mail sending succeeded, and duplicate submissions return `duplicate`.
- The OSS object prefix is `bug_report` (real-upload tests use `bug_report/test`),
  overridden by `ADING_OSS_KEY_PREFIX`, with the default in `application.yml`.
  See [Support: issue reporting and contacting the developer](support-reporting.md).
- `https://www.coffeestudy.com.cn` has a Let's Encrypt certificate with auto-renewal enabled.
- `/actuator/health` is available for external probing and returns only UP/DOWN without details; the mail health check is disabled
  to avoid occasional SMTP slowness marking the whole service DOWN. **No monitoring probes it on a schedule yet.**
- Nonexistent paths return 404, wrong methods 405, and invalid JSON bodies 400,
  no longer falling back to 500, so the error log keeps only real server faults.
- **Unverified**: both machines are configured to start on boot, but neither has been verified with an actual full reboot.
- **Not implemented**: in phase 1 the desktop CloudStore syncs only conversations, members, messages, workspaces, and the user's own profile; server-side TurnService, the memories API,
  and friend requests are not implemented yet.
- **Attachment messages (2026-09-28)**: before rollout run `docs/alter-2026-09-28-attachments.sql` (adds a table and a column only; old jars unaffected).
  Attachments use the support OSS config (endpoint, bucket, AccessKey), independent of `ADING_SUPPORT_ENABLED`;
  without OSS configured, the attachment APIs return the "attachment service unavailable" error (`FILE_008`). Registered but unsent attachments stay in OSS;
  consider a lifecycle rule on the bucket's `attachments/` prefix to clean them up.

## Mobile push: APNs

Pushes are sent only when `ADING_APNS_KEY_ID`, `ADING_APNS_TEAM_ID`, and `ADING_APNS_KEY_PATH` (path to the `.p8` file, mode 600) are all set; if one is missing or the key can't be read, it simply doesn't send and the backend starts normally.
`ADING_APNS_TOPIC` defaults to `com.politeness.ading`, the same for pre-release and production packages. Pre-release and production share RDS, so both environments' env must be configured.
Which APNs server each notification goes to is decided by the `environment` the phone reports (`push_devices` table). When Apple returns 410 or `BadDeviceToken`, the token is deleted.
`api.push.apple.com` and `api.sandbox.push.apple.com` use port 443, so ECS needs outbound internet access.

## Real-time terminal channel: MQTT

The real-time channel for terminals (computers, phones) is Alibaba Cloud MQTT. See [MQTT and unified terminals](mqtt.md) for the protocol and configuration,
and `mqtt-cn-shanghai.env.example` for actual settings. Pre-release, production, and development deployments must all set `ADING_MQTT_ENABLED=true`;
without it the backend starts but there is no real-time push at all, and every terminal shows offline.

- Notifications are only hints: message bodies stay in `messages`, and `MessageWriter` sends the message ID and seq over MQTT after the transaction commits;
  send failures are only logged as WARN and don't affect saved data. Clients catch up by conversation seq, and duplicate notifications are resolved by message ID and seq.
- The desktop checks for message differences on startup, reconnect, wake, activation, and 30 seconds after each sync round.
  `/api/v1/conversations/sync-cursors` reads seqs paged by stable ID according to conversation membership, then only changed conversations are caught up.
- Notification delivery doesn't mean the Agent has run; database messages, incremental catch-up, and the original scheduler's processing watermark are the business source of truth.
  No exactly-once guarantee is provided for external side effects, and task scheduling and pause rules are unchanged.
- Execution progress is reported over MQTT and forwarded to conversation member accounts; `TurnActivityBoard` keeps only the latest state in the memory of the instance handling the report,
  for phones to poll `/api/v1/agents/activity`; it clears after 30 seconds without new reports, and does not span instances or restarts.
- Online status is determined by MQTT connection queries; on query failure it returns "unknown" (`NODE_006`) rather than offline.
- 0.8.x desktops have no real-time channel: the HTTP API and OTA update checks still work, so they can upgrade to the new version.

### Remote task pause and resume

The desktop reports `CONVERSATION_CONTROL` (`pause` / `resume`) over MQTT;
the server verifies conversation membership and Agent ownership, finds the executing computer for each Agent in the conversation, and sends the command to it over MQTT.
The server returns the list of target computers, and each executing computer replies separately with `CONVERSATION_CONTROL_RESULT`; acceptance of the request does not mean it has been executed.
If any target computer is offline or its status unknown, the whole request is rejected and the initiator receives a receipt with an error code (`AGENT_009` / `NODE_006`).
The pause receipt is sent after all local execution for that conversation has finished; the caller switches to resume only after receiving success receipts from all target computers.
Commands expire after 30 seconds and are not replayed on reconnect; caller timeouts or disconnects report an explicit error.
The same Agent's other conversations keep their own schedulers and process identifiers and are not stopped by this pause.

It takes effect only when the initiator, the executor, and both backends are updated; when an old client or backend doesn't support receipts, it times out, which must not be treated as a successful pause.
This feature adds no tables. Pause remains in-run state; it doesn't change the conversation's stored permanent switch, and control commands are never written into user chat messages.
