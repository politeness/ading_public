# Ops console (ops) deployment guide

ADing's ops dashboard: registered users, devices, DAU/MAU. It is a **standalone Spring Boot project**,
with no code dependency on conductor: no shared jars, no shared systemd service, no shared port.
The two only meet through two things: the same business database (ops is read-only on business tables except for adding/removing account tags), and a prefix on nginx.

The direct benefit: the ops package can be built, deployed and rolled back on its own,
and conductor's in-progress code will never ship to production with this package.

---

## Online usage statistics (2026-11-08)

DAU, MAU, trends, recent activity and usage duration all read the server-side `terminal_sessions` online intervals, the same for PC and mobile. Background online time counts; offline telemetry and foreground reports are no longer used as activity signals. An interval runs from online_at to offline_at; if no disconnect was received it only accumulates up to last_seen_at, so lost connections don't keep accumulating. Intervals spanning days are bucketed by calendar day, durations are summed across devices, and overlaps on the same device are deduplicated. Online status still uses open sessions plus a 90-second connection observation window.

Standalone offline use doesn't count toward online DAU or duration. Device telemetry, foreground collection and the old hourly aggregates are retired. Drop the tables per conductor/docs/alter-2026-11-08-retire-telemetry.sql, after first stopping all old writer services.

## 1. What it reads and writes

| Table | Access | Purpose |
| --- | --- | --- |
| `users` | Read-only | Ops account password check, registered user list, Agent count |
| `terminals` | Read-only | Node online status, device-to-node mapping |
| `user_tags` | Read/write (tag add/remove only) | Account tags (pre-release gray, mainland add-friend, etc.), maintained by conductor's DDL script |
| `ops_feedback`, `ops_contact`, `ops_support_attachment` | Read/write | **ops's own tables**: problem feedback, user contacts and the attachment index; see "Problem feedback and user contacts" |

On business tables only account tag add/remove is open; all other business data is read-only. Attachment content lives only in OSS; ops reads it and never writes.

### Database account: reuse conductor's account

On 2026-11-01 the user decided not to create a dedicated ops database account; ops uses conductor's existing RDS account directly (`ADING_DB_USER` / `ADING_DB_PASSWORD` in `<production deploy dir>/env`).
"Read-only on business tables" is enforced in code: ops Mappers only SELECT from `users` and `terminals`, `UserTagMapper` adds/removes `user_tags`, and other writes only touch ops's own support inbox tables. The cost: if ops ever had an injection or RCE, this account has write access to the whole business database; to tighten it later, create a dedicated account with table-level grants as needed.

### Prerequisites

The business database must have devices, terminals and terminal_sessions. Ops no longer depends on the old telemetry or hourly aggregate tables.

### Excluding Apple review test data

Since 2026-11-07, statistics queries exclude, by exact username, the accounts listed in `ADING_OPS_EXCLUDED_USERS` in env (comma-separated, for app store review accounts) and the Agents they own; nothing is excluded if unset.
Devices are identified by combining account records in terminals and historical connection sessions: a device is excluded only if its only login records are from these review accounts; if any other non-empty account was ever recorded, the whole device is kept. Anonymous records don't count as another account. On shared devices, test account activity is still filtered per account, and regular account and anonymous activity is kept.
Connection sessions are also excluded by the account in the record, so review account activity that exists only in history doesn't count toward DAU/MAU either.
Overview, user/device lists and pagination totals, online counts, DAU/MAU, trends, active duration and details all use this definition; for regular account details, device count, recent activity and online status also ignore these devices.
Filtering happens only when reading statistics: accounts aren't disabled, login authentication isn't changed, and the problem feedback/user contact inbox isn't hidden. No database migration needed. The rules live in `StatisticsScope`.

### Start of activity data

Activity data starts from the earliest confirmed online interval in terminal_sessions; offline telemetry isn't backfilled as activity.

---

## 2. Environment and directories

| | Value |
| --- | --- |
| Machine | Same ECS as conductor `<ECS instance ID>` (public <ECS public IP>) |
| Login | `ssh root@<ECS public IP>` |
| Deploy directory | `<ops deploy dir>/` |
| systemd service | `ading_ops_service` |
| Port | 8280, listening only on 127.0.0.1, not in the security group |
| profile | `prod` |
| Public URL | `https://www.coffeestudy.com.cn/ading/ops/` |
| jar | `target/ading_ops.jar` (`mvn -B clean package`, file name without version) |

Directory layout matches conductor:

```
ading_ops/
├─ ading_ops.jar
├─ env          mode 600, contains the DB password and ops session secret
├─ backup/
└─ log/
```

Only one instance is deployed. Pre-release and production share the same RDS, so activity data is the same; a second instance would only show duplicate numbers.

### Keys required in env

```
SPRING_PROFILES_ACTIVE=prod
SERVER_PORT=8280
ADING_DB_HOST=…            # same RDS private address as conductor
ADING_DB_PORT=3306
ADING_DB_NAME=ading
ADING_DB_USER=…            # same account as conductor (<production deploy dir>/env)
ADING_DB_PASSWORD=…
ADING_OPS_USERS=<ops account username>    # ops account list, ADing usernames, comma-separated; restart after changing
ADING_OPS_EXCLUDED_USERS=…  # accounts excluded from statistics (app store review accounts), comma-separated usernames; restart after changing
ADING_OSS_BUCKET=…         # bucket holding attachments, same as conductor
ADING_OPS_AUTH_SECRET=…    # ≥32 bytes, signing key for ops session tokens
                           # must differ from conductor's ADING_AUTH_SECRET
LOGGING_FILE_NAME=<ops deploy dir>/log/ading_ops.log
ADING_OPS_INGEST_TOKEN=…   # internal API token, same value as in conductor's env (production, pre-release, NAS)
OSS_ACCESS_KEY_ID=…        # for reading attachments, same set as conductor (<production deploy dir>/env)
OSS_ACCESS_KEY_SECRET=…
# ADING_OSS_ENDPOINT need not be set: prod defaults to the OSS internal endpoint
```

If `ADING_OPS_AUTH_SECRET` is unset or too short, **every profile except dev refuses to start** (the ops console is exposed publicly,
and a weak key means anyone can forge a session); only dev falls back to a random key, at the cost of logging in again after restart.

When `ADING_OPS_USERS` is empty nobody can log in, and the startup log WARNs. The list comparison is case-insensitive,
matching the `utf8mb4_unicode_ci` collation of `users.username`.

`ADING_OPS_ZONE` need not be set; it defaults to `Asia/Shanghai`. If set, it must match **conductor JVM's default time zone**; see "6. Known limits".

### First deployment

`scripts/deploy.sh` only swaps the jar; the first time, prepare the directory, env and systemd unit manually (all on the ECS):

```sh
mkdir -p <ops deploy dir>/backup <ops deploy dir>/log
touch <ops deploy dir>/env && chmod 600 <ops deploy dir>/env
vi <ops deploy dir>/env          # fill in per "Keys required in env" above; keep passwords off the command line
grep -n ExecStart /etc/systemd/system/ading_service.service   # check the java path conductor uses and copy it below
```

`/etc/systemd/system/ading_ops_service.service`:

```ini
[Unit]
Description=ADing ops console
After=network-online.target
Wants=network-online.target

[Service]
User=root
WorkingDirectory=<ops deploy dir>
EnvironmentFile=<ops deploy dir>/env
# copy the java path from conductor's unit (same JDK 25 on the ECS); add JVM options such as heap size as needed, none preset here
ExecStart=<java path from conductor unit> -Dfile.encoding=UTF-8 -jar <ops deploy dir>/ading_ops.jar
SuccessExitStatus=143
Restart=on-failure
RestartSec=5
SyslogIdentifier=ading_ops_service

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable ading_ops_service
# first time there is no old jar: run mvn -B clean package locally, then ./scripts/deploy.sh to upload and start
```

`User=root` matches conductor's current setup (the deploy directory is under `/root`); to run with lower privileges later,
change the owner of the directory, env and logs together.

---

## 3. nginx

In the `www.coffeestudy.com.cn` server block, add **before** `location /ading`:

```nginx
# ops console: standalone service serving both static pages and API
location = /ading/ops {
    return 301 /ading/ops/;
}
location /ading/ops/ {
    proxy_pass http://127.0.0.1:8280;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
```

`proxy_pass` has no URI, so the original path `/ading/ops/…` is passed to the app unchanged,
matching its `server.servlet.context-path=/ading/ops`.
nginx matches the longest prefix, so this works before or after `location /ading`;
putting it first just makes it obvious to readers that the ops console doesn't use the static directory.

After editing, run `nginx -t` then `nginx -s reload`.

**Login rate limiting relies on `X-Real-IP` being the true value overwritten by nginx** (the app listens only on 127.0.0.1,
unreachable by browsers). If it is ever changed to listen publicly, the assumption in `common/ClientIp.java` no longer holds.

---

## 4. Updating the jar

```sh
mvn -B clean package          # in the repo's ops/ directory; unit tests must all pass with 0 skipped
./scripts/deploy.sh           # upload jar, back up the old one, replace, restart; switch back automatically if the health check fails
```

The script first uploads the jar as `ading_ops.jar.upload-<time>`, then backs up, replaces, restarts and health-checks in a single ssh session.
If the health check doesn't pass within 20 seconds, it moves the failed jar to `backup/ading_ops.jar.failed-<time>`,
restores the backup just made, restarts, and exits non-zero; on first deployment there is no old jar, so it only reports an error.

Manual equivalent:

```sh
cp ading_ops.jar backup/ading_ops.jar.bak-$(date +%Y%m%d-%H%M%S)
mv ading_ops.jar.new ading_ops.jar
systemctl restart ading_ops_service
```

Rollback means restoring the backed-up jar and restarting. After the tables are dropped, never roll back to an old Ops that depends on the telemetry tables; the online-session version must be used.

### Verification

```sh
systemctl status ading_ops_service --no-pager
curl -s http://127.0.0.1:8280/ading/ops/actuator/health     # {"status":"UP"}
curl -s -o /dev/null -w '%{http_code}\n' https://www.coffeestudy.com.cn/ading/ops/   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://www.coffeestudy.com.cn/ading/ops/api/me  # 401
```

The last one must be 401: ops console APIs always return 401 without a session, which proves the gate is still in place.
Then open `https://www.coffeestudy.com.cn/ading/ops/` in a browser, log in with an ops account, and check all four tabs.

---

## 5. Ops accounts and security boundaries

- An ops account is an ADing account: log in with the ADing password, then it's checked against `ADING_OPS_USERS`.
  Accounts outside the list are **never compared against their real hash**: otherwise this public endpoint would become a password oracle for every account on the site.
- Not on the list, nonexistent account, Agent, or wrong password all return `OPS_002` "Incorrect username or password, or the account has no ops permission",
  and all still query the DB once and run PBKDF2 once (with a random decoy if there's no hash to compare), so neither the error code nor timing reveals who is an ops account.
  Only with a correct password does it return `OPS_004` account disabled. `OPS_003` is retired.
- The session is an HttpOnly + SameSite=Strict cookie expiring in 12 hours; page scripts can't read the token.
- **Logout only clears the cookie in the browser; the token itself stays valid for up to 12 hours** (inherent to stateless JWT).
  The real revocation is **changing the password in ADing**: `users.token_epoch` is incremented and all ops sessions are invalidated immediately.
  Disabling the account also takes effect immediately.
- Login is rate-limited per IP: at most 5 attempts in 10 minutes, blocked for 10 minutes from the 5th (unblocked if the 5th itself succeeds).
  The slot is taken atomically before password verification, so concurrent requests can't squeeze past the check together. Single-instance in-memory counter, reset on restart.
- `/api/**` responses (including login and 401) all carry `Cache-Control: no-store`, so phone numbers and emails don't stay in browser caches or proxies.
- The only write APIs the page uses are login/logout and changing feedback status. The session cookie is SameSite=Strict and status-change request bodies must be JSON, so no extra CSRF token is needed.
- `/api/internal/**` are service-to-service APIs that ignore sessions and accept only `X-Ops-Internal-Token` (constant-time comparison); without a configured token they always return 401. They're publicly reachable via nginx (the NAS dev environment needs them), so the token must be long enough.
- Attachments are proxied through ops; browsers never get signed OSS links. Only png/jpeg/webp display inline; everything else is `attachment` + `application/octet-stream` + `nosniff`, so user-uploaded HTML never executes under the ops console domain.
- All text from APIs on the page goes through escaping or `textContent`; `app.js` has no `innerHTML`.
- All responses carry a strict Content Security Policy (`SecurityHeadersFilter`): only this site's `app.js`, `app.css`, `icon.svg` may load, only this site's APIs may be called,
  and it can't be embedded in other sites' iframes. So `index.html` must not contain inline `<script>`/`<style>`, inline event handlers or `style` attributes; a unit test guards this.
- At most 1 password verification runs at a time (`VerificationGate`, `ading.ops.login-max-concurrent-verifications`); queuing longer than 3 seconds returns OPS_008 "Too many login requests, please try again later",
  without consuming this IP's attempts. This prevents many IPs hitting the login endpoint at once from saturating the 2-core ECS shared with production conductor.

---

## 6. Known limits

- Online duration isn't estimated while the backend hasn't observed a connection; a lost interval ends at the last confirmed online time.
- conductor and Ops use the same statistics time zone, defaulting to Asia/Shanghai.
- "7-day average" is the average DAU over the 7 full calendar days before yesterday inclusive, excluding today (today isn't over, so including it would skew low).

## Ops UI

The top level keeps Overview and Activity. The registered user, Agent and terminal lists are entered from the Overview numbers and exited via browser Back.
Total terminals are deduplicated by devices; online terminals are the logged-in registered terminals whose connection is online.
Daily active devices are deduplicated by device_uuid and daily active users by logged-in human user_id; multiple devices of the same account count as one user.

Frontend regression (using isolated local mock data):

```sh
../desktop_mac/node_modules/.bin/electron test/console-ui.cjs
```

Overview activity metrics: active devices today, active users today, active devices in the last 30 days, active users in the last 30 days. The Activity page switches cards, trend charts and detail tables between "Users / Devices"; on the user dimension, multiple devices of the same account are deduplicated by account.

Activity details: activity counts on Overview and Activity, and the counts in daily/hourly tables, can be clicked to open a paginated list.
`GET /api/active/members` uses the same online sessions and calendar-day range as the metrics; users are deduplicated by human account, terminals by device_uuid.
The logged-in/standalone filter is judged by the selected online interval, not by the terminal's current login state. Averages are statistics and have no member list.
The page consistently says "terminal"; the API's existing devices fields and routes stay compatible.

Page switches, activity filters, list filters and pagination are written to browser history; Back/Forward restore the view and filters, and refresh keeps the current view. The page no longer has a separate back button.

The active user trend uses a line chart connecting buckets in time order, drawing zero-activity buckets as 0, with exact values on hover; the active terminal trend uses the same style of line chart, still showing the logged-in and standalone breakdown on hover.

## Problem feedback and user contacts

After conductor receives a report from desktop, it uploads attachments to OSS, then calls `POST /api/internal/feedback` and `POST /api/internal/contacts` to persist the body and attachment index, idempotent by `report_id` / `contact_id`. See `conductor/docs/support-reporting.md` for the data flow.

Feedback statuses: `PENDING` pending (default), `IGNORED` ignored, `ACCEPTED` accepted, `RESOLVED` resolved.

- Ops staff choose accept or ignore on the page and can switch between them if chosen wrongly; the page doesn't offer "resolved".
- The processing flow (skill `ading-issue-report-analysis`) only takes accepted ones and calls `POST /api/internal/feedback/{reportId}/resolve` when done. Only feedback claimed as in progress by this task can be marked resolved, and resolved can't be changed manually again.
- User contacts have no status.

## Account tags

The registered user list shows tags from `user_tags`; display names are in `USER_TAG_TEXT` in `app.js`. In the ops console user list, the × to the right of each tag removes it, and the trailing + opens a vertical option list to its right for adding tags not yet present; + is hidden when all available tags already exist. Each change is saved automatically and takes effect immediately. The tags that can be added are `PRE_GRAY` (pre-release gray) and `MAINLAND_ADD_FRIEND` (mainland add-friend); other existing tags are still displayed and can be removed.

Only ops sessions can call `POST /api/users/{userId}/tags`, which requires JSON and the `X-Ops-Request: user-tags` header, relies on the SameSite=Strict cookie, and has no CORS. It locks the user row and commits in a transaction; repeated adds/removes are idempotent, and the server log records the operator and change; other account fields remain read-only. No schema change needed. Manual SQL is for troubleshooting only:

```sql
INSERT INTO user_tags (user_id, tag, remark) VALUES ('u_xxx', 'PRE_GRAY', 'why it was added');
```

The registered terminal count in the user list counts devices linked in terminals; activity data reads server-side online sessions.

The user list keeps only username, display name, status, tags, recent activity and online status. Clicking a username opens details showing phone number, email, registration time, registered terminal count and Agent count; both counts still lead to their lists. The user list no longer shows the 30-day active terminal count. The page has a max width of 1800px and tags stay in a row. The Overview online terminals number opens the terminal list with scope=online, filtered by the same open sessions and connection records within 90 seconds as Overview, deduplicated by device, with search and pagination.

The main terminal table keeps terminal name, version, city, recent activity and status; clicking the name opens terminal details showing the full UUID, type and OS version, all linked accounts, available Agents and first registration time (from first_seen_at). User and terminal lists both put online first, then sort by recent activity descending within each group, sorted before database pagination; entries without activity go last within the group.


### Feedback claiming and closure by the handler (2026-11-04)

A new status `IN_PROGRESS` (in progress) reuses the existing VARCHAR(16), handled_by and status_changed_at, so no table migration is needed. The internal API `POST /api/internal/feedback/{reportId}/claim?operator=<unique ID per task>` atomically changes ACCEPTED to IN_PROGRESS; among concurrent claims only one succeeds and the others return 409.

Accept and ignore are still toggled manually in the ops console. Latest user authorization (2026-11-04): after the Agent fixes and verifies, it closes the feedback itself without further manual confirmation. The internal resolve API requires the internal token and a unique operator, and checks IN_PROGRESS and handled_by in a single conditional update; closing another task's feedback is forbidden. No release API is exposed. Logged-in staff can still close via the status API, and the UI's confirmation step is kept. Feedback stays in progress while the cause is unclear, the fix is unfinished or verification is blocked; when a task includes a release, finish the release before closing. An interrupted task isn't unlocked automatically; staff can move it back to accepted or ignored; resolved is a final state that can't be changed.

Feedback list column order: problem description, version, environment, status, reported time, resolved time, actions. Resolved time shows status_changed_at only for RESOLVED and "—" for other statuses; occurrence time stays in the details. status_changed_at is written when the handler closes it, so resolved time never mistakenly uses the claim or accept time.
