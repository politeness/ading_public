# conductor

ADing's server: accounts, node registration, friendships, conversations, message routing, and offline catch-up.

**Boundary**: conductor is a messaging hub, not an execution hub. Agent processes, workspaces, and permission dialogs always stay on the desktop.
The strings `codex`, `claude`, and `qoder` never appear in this code; the agent type is just a pass-through field.

## Verification status (2026-09-13)

`mvn clean verify` passes: 74 tests (2 of which need real OSS credentials and are skipped by default),
producing `target/conductor-0.4.0.jar`, renamed to `ading_conductor.jar` at deployment.

The ECS production (`prod`), ECS pre-release (`pre`), and Synology NAS development (`dev`) environments all run as JAR + systemd;
see the [deployment guide](docs/deployment.md) for details. Real HTTP verification covers registration, login,
token refresh, idempotent node and Agent registration, independent conversations, message retries, concurrent contiguous seq,
sending on behalf of Agents, conversation saving, read positions, and offline catch-up; issue reporting and contacting the developer have been verified for real in both environments.

This means the basic messaging backend runs; it does not mean the full connected product is done:
`desktop_mac/src/store/remote.ts` is still a placeholder and desktop integration is not finished;
server-side turn scheduling, memory read/write, and friend requests are still to be implemented.
Attachment messages: files are in OSS (the `attachments/` directory of the same bucket as issue reports);
the client first calls `POST /api/v1/conversations/{cid}/attachments` to register and get a signed URL for direct upload, then includes `attachments` when sending the message;
download URLs are fetched on demand via `GET /api/v1/conversations/{cid}/attachments/{aid}/url`, available only to conversation members.

## Tech stack

- Java 25 + Spring Boot 4.1.1 (JSON uses Boot 4's default Jackson 3, package `tools.jackson`, not `com.fasterxml.jackson`)
- MyBatis (annotation-based mappers, no XML)
- MySQL 8, without database version management: only one up-to-date `docs/create-database.sql` is maintained
- Alibaba Cloud MQTT (real-time terminal channel, see [MQTT and unified terminals](docs/mqtt.md))
- No third-party JWT / BCrypt dependencies: JWT is hand-written with the JDK's HMAC-SHA256, passwords use the JDK's PBKDF2

## Directory structure

```
com.politeness.ading.conductor/
  controller/   REST controllers + global exception handler
  service/      Task / Message / Relation / Agent / Auth / Node — business orchestration
  manager/      NodeRegistry — wrapper for external nodes, connections, and online status
  dal/          entity + mapper
  error/        BizError interface + per-domain error enums
  common/
    config/     Spring configuration classes
    auth/       tokens, interceptors, request-scoped identity context
    Result / BizException / IdGenerator / PasswordEncoder
```

One hard constraint: `service` depends only on the `manager/NodeRegistry` interface; MQTT details are confined to the `mqtt` package.

## Three places worth reading first

| Location | Why it matters |
|---|---|
| `service/MessageWriter` | The seq allocator. Increments via a row lock on `conversations.last_seq`, rolling back entirely on failure, guaranteeing seq has no gaps |
| `manager/NodeRegistry` | The single entry point for pushing to terminals and querying online status, implemented in the `mqtt` package |
| `service/AgentService#update` | conductor's first proactively pushed command (`AGENT_UPDATED`), which exercised the whole NodeRegistry path end to end |

## Running locally

Requires JDK 25 and Maven 3.9+.

```bash
# 1. Create the database and tables (run once for a new environment; the service never creates or alters tables on startup)
mysql -h <host> -uroot -p < docs/create-database.sql

# 2. Start
export ADING_DB_HOST=<NAS-host>
export ADING_DB_USER=root
export ADING_DB_PASSWORD='...'          # never put this in code or docs
export ADING_AUTH_SECRET="$(openssl rand -base64 48)"
mvn spring-boot:run
```

Each environment must configure its own stable random `ADING_AUTH_SECRET` of at least 32 bytes via its runtime environment. Changing the secret invalidates that environment's existing tokens.

## Deployment

ECS (production) and NAS (development) both use JAR + systemd; see the [deployment guide](docs/deployment.md).

## Docs

| Doc | Contents |
|---|---|
| [deployment.md](docs/deployment.md) | Deployment, directory layout, updating the jar, and troubleshooting for both environments |
| [mqtt.md](docs/mqtt.md) | Real-time terminal channel: protocol, online status, configuration, legacy client compatibility |
| [support-reporting.md](docs/support-reporting.md) | Issue reporting and contacting the developer |
| [create-database.sql](docs/create-database.sql) | Database and table creation script, always the latest complete schema; see column comments for field meanings |

## Smoke test

```bash
BASE=http://localhost:8080/api/v1

# Register + log in
curl -s -XPOST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"username":"politeness","password":"at-least-8-chars","displayName":"Boss"}'

TOKEN=$(curl -s -XPOST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"politeness","password":"at-least-8-chars"}' | jq -r .data.accessToken)

# Register a node and get a node token
curl -s -XPOST $BASE/terminals/register -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"fingerprint":"test-fp-001","name":"My Mac"}'

# Idempotency check: call again; terminalId must be the same
```

**Three idempotency cases you must verify** (the most error-prone part of phase 1):

1. `POST /terminals/register` with the same fingerprint twice → the same `terminalId`
2. `POST /agents/register` with the same `localUuid` twice → the same `userId`
3. `POST /conversations` DIRECT between the same two people twice → **two different `conversationId`s** (a conversation is a piece of work, not a chat window; deliberately not idempotent)

There is also a seq invariant: after sending N messages in a row, `seq` must be 1..N, contiguous with no gaps —
the client relies on "seq == local max + 1" to detect lost messages; gaps would trigger a catch-up for every message.

## API

See the Yuque doc "ADing Backend (API) Design", or read the six classes under `controller/` directly.
The current HTTP API and compatibility aliases are defined by `controller/`.

## Not in phase 1

The turn engine `TurnService`, agents triggering each other via @, `memories` read/write,
cross-node interconnection, mobile APIs, image/file messages, the friend request flow.
