# MQTT and unified terminals

## Protocol

| Environment | Report | Deliver | Terminal Group ID | Server Group ID |
|---|---|---|---|---|
| Development | `report_dev/{terminalId}` | `deliver_dev/user/{userId}`, `deliver_dev/terminal/{terminalId}` | `GID_TERMINAL_DEV` | `GID_SERVER_DEV` |
| Pre-release | `report_pre/{terminalId}` | `deliver/user/{userId}`, `deliver/terminal/{terminalId}` | `GID_TERMINAL` | `GID_SERVER_PRE` |
| Production | `report/{terminalId}` | Shared with pre-release | `GID_TERMINAL` | `GID_SERVER` |

The terminal Client ID is `{GroupID}@@@{terminalId}`. Each backend process's MQTT delivery connection uses its own random worker ID and the corresponding server Group ID. By default, report intake uses the Alibaba Cloud cloud-side SDK protocol: multiple backends in the same environment compete to consume the queue of that environment's first-level report topic, and each normal message goes to one of the consumers. Every report is ACKed once after processing: neither explicitly rejected reports nor ones that fail mid-processing are requeued - processing may already have recorded activity or forwarded part of it, so redelivery would repeat those side effects, and reports are all transient anyway (busy is re-reported every 10 seconds, task control expires after 30 seconds). A failed forward/delivery is only logged; it does not count as a processing failure and does not close the consumer channel. When the channel is already closed, no ACK is sent on it, and the broker redelivers unacknowledged messages. Different environments have different first-level report topics, so there is no cross-environment competition or duplicate forwarding.

`report-transport=mqtt` selects the standard `$share/{serverGroupID}/{first-level report topic}/+` mode, but the current Serverless instance does not use this mode; only choose it on instances where standard shared subscriptions have been verified. In this mode the shared subscription name and the Group ID are configured as separate concepts.

A terminal reads the two delivery topics for its own account and its own terminal, and can only write the report topic of the environment its terminal belongs to. The server picks the environment from trusted deployment configuration; the credential endpoint does not accept a user-supplied owner, topic, or environment. After the backend verifies the terminal, agent ownership, and conversation membership, a report is delivered to the accounts of the conversation members. Human and agent members are resolved to accounts and deduplicated, so that shared conversations reach all of the other party's terminals too.

An MQTT frame is `{type, payload}`; reports additionally carry an `eventId` and a monotonically increasing `sentAt`. Shared subscriptions are at-least-once delivery: the progress receiver filters duplicate and late frames by source order; task control relies on request IDs and deduplication at the executor. MQTT does not store message history; after receiving a notification or reconnecting, clients still catch up on database messages by seq.

The executor reports immediately on start/finish, and re-reports busy every 10 seconds while working; the receiver clears the busy state after 30 seconds without new progress. Re-reports do not append duplicate activity-feed text, and the activity feed keeps the latest 30 lines.

## Terminals

- `terminals.type` currently accepts `DESKTOP` / `MOBILE`.
- Only DESKTOP is an executor. A MOBILE terminal is an auxiliary client: it can register a terminal, exchange MQTT credentials, receive deliveries, and initiate task control; executor actions always return `NODE_007` (registering Agents, writing conversation threads, reporting Agent state, binding a workspace to this terminal), and MQTT reports of `TURN_PROGRESS` and `CONVERSATION_CONTROL_RESULT` are likewise rejected. The checks are centralized in `NodeService.requireExecutionTerminal` / `requireExecution`.
- The endpoint entry is `/api/v1/terminals`; the token payload uses `terminalId`, and tokens with both fields conflicting with `did` are rejected.
- iOS keeps the install identity UUID in the Keychain, registers MOBILE with a normal user token, and uses the terminal token to request temporary MQTT credentials. Normal REST still uses the user access/refresh tokens.
- Credential failures are only retried; MQTT authentication is never bypassed.

## Online status

Terminal online status is determined by MQTT's `QuerySessionByClientId` connection query; there is no application heartbeat, and `terminals.status` is only used to mark a terminal as disabled. A failed query means unknown (`PresenceUnknownException`, error code `NODE_006`): contacts and `/terminals/me` do not make up "offline" and show unknown instead; task control replies to the initiator with a `CONVERSATION_CONTROL_ACCEPTED` carrying `error: NODE_006`, and "Refresh Agent status" returns HTTP 400 with `NODE_006`; neither waits for a timeout or turns into a 500.

The current implementation uses a 5-second in-memory cache to reduce repeated queries for the same terminal, and queries registered terminals every 15 seconds, notifying the account to refresh when a connection state change is found. It polls the MQTT server's connection state, not a terminal business heartbeat. Business decisions do not read the database; the polling results are additionally recorded in `terminal_sessions` (`TerminalSessionTracker`), used only by the ops console to compute active time. The MQTT connection Keep Alive is set to 20 seconds; an abnormal network drop still has to wait for the Broker's detection timeout. Polling starts only after the backend delivery connection is established; the state found by the first query after a restart is only used as a baseline and does not trigger notifications (a backend restart does not change any terminal's broker connection, and notifying everyone would only make every account refetch at the same time). Both query maintenance and connection maintenance run on `mqttScheduler`.

Alibaba Cloud also offers subscriptions to connect/disconnect events. Once an instance is available, we can verify whether to use those events as the refresh trigger to reduce the queries above; the current connection-state query logic can still be used for initialization and correction. We do not pretend here that a notification SDK that has not been tested is already wired up.

## Connection sessions

One row per connection: the first observation of a connection opens a row, an observed disconnect closes it, and active time is offline minus online. Pre-release and production query the same broker (Client IDs are both `GID_TERMINAL@@@{terminalId}`, same instance) and write the same table, so all state lives in the database: the `open_terminal_id` unique key guarantees that a terminal has only one open row; closing is conditional and does not close if the other side recorded a connection after this observation. While connected, `last_seen_at` is written about every 30 seconds, throttled by the value in the database, and `terminals.last_seen_at` and `devices.last_active_at` are written at the same time.

- Disconnect seen directly (this process saw it connected in the previous round): the offline time is this observation.
- Disconnect only discovered after a restart, or the terminal was disabled and is no longer polled: the end time is `last_seen_at`.
- Seen connected again after no process has observed it for more than 5 minutes: the old session ends at `last_seen_at`, a new row is opened, and the gap is not counted.
- Query failed and state is unknown: nothing changes this round.

## Backend configuration

MQTT is the only terminal channel; pre-release, production, and development deployments must all set `ADING_MQTT_ENABLED=true`. The code default is still `false`, only for local runs and tests without a broker: in that case the backend starts normally and logs a WARN, there is no real-time push at all, and all terminals show as offline. Deployment environment configuration:

```dotenv
ADING_MQTT_ENABLED=true
ADING_MQTT_ENVIRONMENT=pre
ADING_MQTT_INSTANCE_ID=<instance-id>
ADING_MQTT_REGION_ID=<region-id>
# By default reuses the existing OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET; no need to set the AK again.
# To override, set ADING_MQTT_ACCESS_KEY_ID / ADING_MQTT_ACCESS_KEY_SECRET.
ADING_MQTT_BROKER_URL=ssl://<verified-tls-endpoint>:8883
ADING_MQTT_PUBLIC_BROKER_URL=mqtts://<public-tls-endpoint>:8883
ADING_MQTT_REPORT_TRANSPORT=cloud
ADING_MQTT_CLOUD_DOMAIN=<verified-cloud-SDK-endpoint>
ADING_MQTT_CLOUD_PORT=5672
# Only used when report-transport=mqtt; the current Serverless instance should use cloud.
ADING_MQTT_SHARED_SUBSCRIPTION=true
# Optional: control-plane API endpoint; leave empty to derive from region
ADING_MQTT_API_DOMAIN=
```

By user convention, MQTT reuses the existing OSS AK by default; the dedicated MQTT environment variables take precedence. Do not write real credentials into the repository. RAM needs the actual call permissions such as ApplyToken and QuerySessionByClientId, plus the necessary permissions on the instance, topics, and Group IDs. In Token mode the username contains the AccessKey ID per the protocol; the AccessKey Secret stays only on the backend. The client MQTT password is `R|<read-token>|W|<write-token>`, with separately scoped permissions, and temporary credentials are not written to the client's disk. Before expiry, the client requests new ones, reconnects, and catches up on missed data.

When the configured environment is empty, it is derived from the Spring profile, with `pre` taking precedence over the `prod` it includes. The public MQTT endpoint and instance must be the same for pre-release and production; development terminals only subscribe to `deliver_dev`.

References: [Alibaba Cloud Token API](https://help.aliyun.com/zh/apsaramq-for-mqtt/mqtt-upgraded/developer-reference/client-related-operations-in-token-based-authentication), [connection query](https://help.aliyun.com/en/apsaramq-for-mqtt/api-querysessionbyclientid), [shared subscription limits](https://help.aliyun.com/zh/apsaramq-for-mqtt/mqtt-upgraded/developer-reference/shared-subscription).

## Terminal protocol

`/api/v1/terminals` and the token `terminalId` field are used uniformly, and registration must explicitly pass `DESKTOP` or `MOBILE`. The old `/nodes` alias, `did` tokens, and the token exchange endpoint have been removed.

## Measured instance findings (2026-10-30, `cn-shanghai` Serverless instance)

- Standard `$share` subscriptions cause the connection to be closed, so report intake uses cloud-side SDK cluster consumption (`report-transport=cloud`).
- With the cloud-side SDK, bursts sent right after the subscription is established lose messages, so leave a window for the subscription to stabilize; a first sample that waits only 1 second may observe no delivery, and that alone does not mean the Topic or permissions failed.
