# Support: issue reports and user contact

"Support" is **a capability the standalone edition needs too**. When the desktop app is not logged in it is the standalone edition, but the issue reports and
contact-the-developer features under "Support" still go through the backend, so these two endpoints are exempt from authentication in `WebMvcConfig`.

## How the data flows

```
Desktop (pending outbox) → conductor → attachments to OSS
                             → body and attachment index via the ops console internal API (/ading/ops/api/internal/*), stored in the ops console database
```

Email used to be sent; no mail is sent anymore. The "Issue reports" and "User contact" tabs on the ops console are the only entry points;
for the report status flow see `ops/docs/deployment.md`.

The client still talks only to conductor and never connects to the ops console directly, for three reasons: OSS credentials and the ops console token are both kept on the backend,
only conductor can collect the backend logs, and old clients can report to the ops console without upgrading.

## Reports are not lost on failure

If either OSS or the ops console is not configured or not reachable, the endpoint returns 503 and the desktop app keeps the report in the pending outbox to retry next round.
On retransmission the OSS object key stays the same, and the ops console is idempotent on the `report_id` / `contact_id` unique key, so no extra entry appears.

There is only one ops console, online; **the development, pre-release, and production channels all report to the same ops console**, and the page marks the channel by the version string suffix.
The NAS development environment uses the public address, and ECS uses the local `127.0.0.1:8280`; when the NAS is offline or the ops console is not deployed, development reports likewise stay in the pending outbox.

## Environment distinction

**The environment is determined by the Spring profile, with no runtime probing.**

| profile | Environment | Database | OSS endpoint |
|---|---|---|---|
| `prod` | ECS, production deployment | Alibaba Cloud RDS internal domain | `oss-cn-shanghai-internal.aliyuncs.com` |
| `dev` | NAS, development | NAS local MySQL | `oss-cn-shanghai.aliyuncs.com` |

Defaults are in `application-prod.yml` / `application-dev.yml` and can still be overridden with
environment variables such as `ADING_OSS_ENDPOINT` and `ADING_DB_HOST`.

Why not "try internal first, fall back to public if it fails": accessing an internal endpoint from outside the VPC does not fail immediately;
it waits for a TCP timeout - measured locally, it takes **24 seconds** to fail. Stalling every report for 24 seconds slows reporting down
and also makes "which route was actually used" uncertain, which is hard to debug when things go wrong.

**ECS must explicitly set `SPRING_PROFILES_ACTIVE=prod`**, otherwise it falls back to `dev`
and applies the development environment's public addresses. On startup the service logs the current profile and the endpoint actually in use;
if prod uses a public address (or dev uses an internal address), the log contains a WARN
(see `common/config/SupportStartupCheck`). This only warns and does not block:
a misconfigured endpoint should not keep the whole service from starting.

## Server configuration

Everything goes through environment variables; do not write it into code or docs:

| Variable | Description |
|---|---|
| `ADING_SUPPORT_ENABLED` | Enabled only when `true`; default `false` |
| `ADING_OSS_ENDPOINT` | Usually not needed, the default is taken by profile; when overriding, be careful not to configure the internal domain on the NAS |
| `ADING_OSS_BUCKET` | Bucket name, without the domain |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | A RAM sub-account is recommended, granted only `PutObject` on that bucket |
| `ADING_OSS_PUBLIC_ENDPOINT` | Public endpoint used to sign access links. If empty, it is derived by removing `-internal` from `ADING_OSS_ENDPOINT`; usually not needed |
| `ADING_OSS_PUBLIC_BASE_URL` | If set, it is used to build fixed URLs; otherwise presigned URLs with an expiry are issued |
| `ADING_OSS_KEY_PREFIX` | Default `bug_report` |
| `ADING_OSS_LINK_TTL_HOURS` | Presigned URL validity, default 168 hours |
| `ADING_OSS_COMMUNICATION_KEY_PREFIX` | Prefix for user contact attachments, default `communication` |
| `ADING_OPS_BASE_URL` | Ops console root URL, usually not needed: prod/pre default to `http://127.0.0.1:8280/ading/ops`, dev defaults to the public address |
| `ADING_OPS_INGEST_TOKEN` | Token for calling the ops console internal API; must match the value of the same name in the ops console env |

## Directory structure on OSS

```
<prefix>/<userId>/<reportId>/
  report.json                 Report body and all links, so the full report is visible outside the ops console too
  images/screenshot-<original file name>
  images/image-1-<original file name>
  logs/1-<original file name>              The part within 48 hours of the latest two logs, plain text
  logs/阿钉日志-<timestamp>.tar.gz     Archive of the desktop's last 48 hours of logs
  logs/服务端日志.log.gz            Backend logs from the last 48 hours
```

File names keep their Chinese characters (desktop screenshots are named "阿钉截图-…" by default) and carry a slot prefix,
so attachments with the same name do not overwrite each other.

User contact attachments are at `communication/<userId>/<contactId>/<index>-<original file name>`:
any file type, at most 5 files, each no more than 5 MB and no more than 15 MB in total.

**The directory layout is decided by the user; do not change it on your own** (for first-level directories see "OSS directories" in `docs/ota-design.md`). Flat by userId, not by date:
a specific entry is looked up via `object_key`, `user_id`, and `terminal_id` in the ops console database. In the standalone edition without an account, the computer identifier (`terminals.fingerprint`) is used instead of userId.
Old clients send neither, so their reports can only go under `anonymous`. Issue reports from before 2026-11-02 stay in the old path `bug_report/<yyyy>/<MM>/<dd>/` and are not migrated (user decision).

## Uploads go internal, links go public

These two have different goals and must be kept apart:

- **Uploads** use `ADING_OSS_ENDPOINT`. On ECS this is the internal domain, which is fast and not billed as public traffic.
- **Access links** are always signed with the public domain. Links are written into `report.json` and the receipt for people to open from outside;
  the internal domain **does not resolve at all** outside the VPC - measured, the connection simply fails.

The OSS SDK is used throughout, with no hand-written signatures. Links are generated by the SDK's `generatePresignedUrl`,
and the host it builds comes from the client's endpoint - so two clients are needed:
the upload one configured with the internal endpoint, the link one with the public endpoint. `generatePresignedUrl` makes no network request,
so an extra client adds no overhead.

## Log collection

**Only the last 48 hours of logs are uploaded**, consistently on desktop and backend. Log recording and retention rules are unchanged; logs are only trimmed at report time:
judged by the time at the start of each line, files entirely older than 48 hours are skipped, lines older than 48 hours inside a file are removed,
and continuation lines without a time (exception stack traces, etc.) follow the fate of the previous line. Trimming by line rather than by file is because the desktop's current file
only rotates once it reaches 1 MB, and often contains several days of records.

The desktop collects two things, for different purposes:

- **Text**: the part within 48 hours of the latest two logs (at most the last 1 MB of each), uploaded as plain text with the request, for a quick look;
- **Archive**: all logs within 48 hours (at most 10 MB raw, oldest dropped beyond that) packed into a `tar.gz` and uploaded separately.
  On macOS it unpacks with a double-click, no extra tools needed.

Packing is done on the desktop (`desktop_mac/src/support/log-archive.ts`, hand-written ustar + gzip,
no third-party dependencies), and only sent to the backend after compression - logs are highly repetitive JSON lines, the compression ratio is usually
above 10x, so compressing before sending significantly reduces the request body. The backend decodes it and uploads it to OSS as is, with a 10 MB limit.

A collection failure (for example a log file being locked) does not affect the report: without an archive, that field is simply omitted.

**Backend logs are reported too.** The report itself goes through the backend - OSS upload, forwarding to the ops console, and authentication all happen there,
so desktop logs alone show only half the picture. The backend reads the current day's log and the rolling files from the previous two days (`ading.<date>.<index>.log`),
trims to the last 48 hours, and when it exceeds `server-log-tail-bytes` (default 10 MB) keeps only the newest part, starting from the first complete line,
compresses it into `服务端日志.log.gz`, and uploads it over the internal network like other attachments. The path reuses the service's existing
`LOGGING_FILE_NAME`; if it is not configured nothing is collected, and a collection failure only omits this item without affecting the report.

## Endpoints

### `GET /api/v1/support/config`

No authentication. The desktop uses this to decide whether the support service is available and which limits to pre-validate against locally.

```json
{"code":"OK","data":{"enabled":true,"reportEnabled":true,"contactEnabled":true,
 "maxImages":5,"maxImageBytes":5242880,"maxLogs":2,"maxLogBytes":1048576,
 "maxLogArchiveBytes":10485760,"maxDescriptionLength":4000}}
```

### `POST /api/v1/support/reports`

No authentication. The request body is the raw JSON from the desktop's pending outbox (extra fields such as `schemaVersion` and `status`
are ignored). `occurredAt` is an ISO 8601 time with time zone, accurate to the second.

```json
{"code":"OK","data":{
  "reportId":"report_…",
  "status":"uploaded",
  "objectPrefix":"bug_report/2026/09/12/report_…",
  "images":{"阿钉截图.png":"https://…"},
  "logs":{"last-run.log":"https://…","阿钉日志-….tar.gz":"https://…"}}}
```

Retransmitting the same `reportId` (desktop timeout retry) only returns `"status":"duplicate"`,
without re-uploading or writing to the ops console again.

### `POST /api/v1/support/contacts`

No authentication. Returns `{"contactId":"…","status":"sent"}`; a duplicate submission returns `"duplicate"`.
`attachments` is optional, each item `{"name","mimeType","base64"}`; old clients do not have this field.

## How the desktop finds the backend

See `desktop_mac/src/support/endpoints.ts`. **Determined by the release channel**:

| Channel | Version string | Backend |
|---|---|---|
| `develop` | `0.1.0_2026.9.12_develop` | NAS `<NAS address>:8080` |
| `release` | `0.1.0_2026.9.12` | ECS `<ECS public IP>:8080` |

The channel is the explicit `adingChannel` property in `package.json`, not parsed from the version string
(the version number is a display field; one wrong character would connect to the wrong environment). Precedence: per-address environment variable >
`ADING_API_BASE_URL` > channel default.

**Built-in defaults are required**: a packaged app cannot see the development machine's environment variables. Early on only environment variables were read,
so the uploader in the production package was always disabled and reports only landed locally in
`~/Library/Application Support/阿钉/support/pending/`.

The development build cannot reach the NAS once it leaves the home network - this is an inherent limitation of the development build. Reports stay in the pending outbox
to be retried the next time it is online, and are not lost.

The uploader routes by result: success moves to `sent/` (and writes a separate `.receipt.json`),
4xx (except 408/429) moves to `failed/` with no more retries, and 5xx and network errors stay in `pending/` to retry next round.

## Verification

```bash
OSS_ACCESS_KEY_ID=… OSS_ACCESS_KEY_SECRET=… \
ADING_OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com ADING_OSS_BUCKET=… \
mvn test                       # includes two real uploads, service layer and HTTP entry; none may be skipped
```

After running (whether they pass or fail), the real-upload tests delete their own objects under `bug_report/test/`.
