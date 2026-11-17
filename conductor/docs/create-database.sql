-- ADing conductor — database and table creation script
--
-- This script is always the latest complete schema. The database has no version management:
-- change the schema directly here, without incremental migration scripts — the service never alters the database on startup.
-- Run once for a new environment: mysql -h <host> -u <user> -p < docs/create-database.sql
-- To bring an existing environment up to the new schema, ALTER statements are evaluated and run separately at release time (get approval first for the ECS production database).
--
-- Conventions: every table uses an auto-increment BIGINT id as the physical primary key and xxx_id VARCHAR(64) as the external business key
--       Business IDs are prefixed ULIDs: u_ user / d_ desktop node / t_ conversation / m_ message / s_ agent session
--       (t_ used to be c_ — data created before the rename stays valid — business IDs are opaque strings)
--
-- Fields fall into two kinds (connected mode phase 1, design in section 6 of docs/cloud-data-design.md):
--   those the backend queries or filters on become separate columns,
--   runtime state only the desktop scheduler understands (charter, workPlan, brainstorm, steps, agentReply, etc.)
--   goes into the JSON column extra, which the backend only stores and never parses. These structures still evolve with the scheduler and aren't worth a schema change and release each time.

CREATE DATABASE IF NOT EXISTS `ading`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `ading`;

-- ---------------------------------------------------------------------------
-- users: users (humans and agents stored together)
-- ---------------------------------------------------------------------------
CREATE TABLE `users` (
  `id`               BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `user_id`          VARCHAR(64)  NOT NULL COMMENT 'User business ID',
  `username`         VARCHAR(64)  NOT NULL COMMENT 'Login username, Agents also use a system-wide unique username',
  `display_name`     VARCHAR(64)  NOT NULL COMMENT 'Display name or Agent nickname',
  `avatar_url`       MEDIUMTEXT            DEFAULT NULL COMMENT 'Avatar, currently a data URL, later an object storage URL, null for Agents',
  `phone`            VARCHAR(30)           DEFAULT NULL COMMENT 'Phone number, null for Agents',
  `email`            VARCHAR(254)          DEFAULT NULL COMMENT 'Email, null for Agents',
  `is_agent`         TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Whether this is an Agent: 0 no, 1 yes',
  `password`         VARCHAR(255)          DEFAULT NULL COMMENT 'Password hash, null for Agents, plaintext passwords are never stored',
  `status`           VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'Account status: ACTIVE normal (installed, for Agents), DISABLED disabled, NOT_INSTALLED not installed (Agents only)',
  `agent_type`       VARCHAR(32)           DEFAULT NULL COMMENT 'Agent type, null for humans: CODEX, CLAUDE_CODE, QODER, QODER_CN, QWEN_CODE, KIRO, COPILOT, ANTIGRAVITY',
  `agent_version`    VARCHAR(64)           DEFAULT NULL COMMENT 'Agent version, null for humans',
  `permission_level` VARCHAR(32)           DEFAULT NULL COMMENT 'Agent permission: READ_ONLY, ASK_EVERY_TIME, ALWAYS_ALLOW, null for humans',
  `persona`          TEXT                  DEFAULT NULL COMMENT 'Agent personality, preferences, and identity settings, null for humans',
  `owner`            VARCHAR(64)           DEFAULT NULL COMMENT 'user_id of the human who owns the Agent, null for humans',
  `terminal_id`       VARCHAR(64)           DEFAULT NULL COMMENT 'terminal_id of the desktop node hosting the Agent, an Agent belongs to exactly one computer, null for humans',
  `local_uuid`       VARCHAR(64)           DEFAULT NULL COMMENT 'Local ID of the Agent on its computer (stable desktop-side ID), registration is idempotent on (terminal_id, local_uuid), null for humans',
  `readiness`        VARCHAR(32)           DEFAULT NULL COMMENT 'Agent readiness on its computer, reported by that computer: unknown/missing/found/unauthorized/ready/exhausted/error, offline takes precedence when the computer is offline, null for humans',
  `model_state`      VARCHAR(1024)         DEFAULT NULL COMMENT 'Agent current model (JSON: selected, selectedLabel, nativeModel), reported by its computer, the backend only stores it and does not interpret it, null for Agents on old clients and for humans',
  `onboarding_v1_steps` TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Onboarding v1 confirmed-or-skipped step bitmap, 0 not started, 255 all done',
  `token_epoch`      INT(11)      NOT NULL DEFAULT 0 COMMENT 'Token epoch, incremented on password change, invalidating all previously issued tokens',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_id`  (`user_id`),
  UNIQUE KEY `uk_username` (`username`),
  KEY `idx_is_agent`   (`is_agent`),
  KEY `idx_status`     (`status`),
  KEY `idx_agent_type` (`agent_type`),
  KEY `idx_owner`      (`owner`),
  UNIQUE KEY `uk_terminal_local` (`terminal_id`, `local_uuid`),
  KEY `idx_terminal_id` (`terminal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Users (humans and agents stored together)';

-- ---------------------------------------------------------------------------
-- terminals: account-device associations: one row per account per device (owner + fingerprint), with terminal_id, token, and Agent ownership.
-- Device parameters live in devices — name is kept only for old backends and new code does not read it
-- ---------------------------------------------------------------------------
CREATE TABLE `terminals` (
  `id`           BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `terminal_id`   VARCHAR(64)  NOT NULL COMMENT 'Desktop node business ID',
  `name`         VARCHAR(100) NOT NULL COMMENT 'Desktop node name',
  `type`         VARCHAR(32) NOT NULL DEFAULT 'DESKTOP' COMMENT 'Terminal type: DESKTOP computer (executor, runs Agents) / MOBILE phone (companion, only sends and receives messages), extensible',
  `fingerprint`  VARCHAR(128) NOT NULL COMMENT 'Device fingerprint',
  `status`       VARCHAR(32)  NOT NULL DEFAULT 'OFFLINE' COMMENT 'Node status: DISABLED disabled, other values (OFFLINE, ONLINE written by old versions) do not mean online, online status is determined by MQTT connection queries',
  `owner`        VARCHAR(64)  NOT NULL COMMENT 'user_id of the human who owns the desktop node',
  `last_seen_at` DATETIME              DEFAULT NULL COMMENT 'Last time this account registered (login, launch) on this device or was observed connected to MQTT, for ops statistics only, business online checks still rely on MQTT queries',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_terminal_id`        (`terminal_id`),
  UNIQUE KEY `uk_owner_fingerprint` (`owner`, `fingerprint`),
  KEY `idx_fingerprint` (`fingerprint`),
  KEY `idx_status`      (`status`),
  KEY `idx_owner`       (`owner`),
  KEY `idx_last_seen_at` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Account-device associations (terminals)';

-- ---------------------------------------------------------------------------
-- users_rel: friendships (stored as two rows, one per direction)
-- ---------------------------------------------------------------------------
CREATE TABLE `users_rel` (
  `id`           BIGINT(20)  NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `user_id`      VARCHAR(64) NOT NULL COMMENT 'user_id of the current user',
  `friend_id`    VARCHAR(64) NOT NULL COMMENT 'user_id of the friend',
  `status`       VARCHAR(32) NOT NULL DEFAULT 'ACCEPTED' COMMENT 'Relation status: PENDING awaiting approval, ACCEPTED friends, BLOCKED blocked, SHARED Agent access granted by the owner',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_friend` (`user_id`, `friend_id`),
  KEY `idx_user_id`   (`user_id`),
  KEY `idx_friend_id` (`friend_id`),
  KEY `idx_status`    (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Friendships (stored as two rows, one per direction)';

-- ---------------------------------------------------------------------------
-- conversations: conversations
--
-- One row = one piece of work, not "a chat window with someone". You can open several conversations with the same Agent at once,
-- each with its own thread and its own memory — so there is **deliberately no** direct-chat idempotency key here:
-- adding one would mean "you can only have one conversation with a given Agent", which is exactly the model to avoid.
--
-- last_seq is the in-conversation message seq allocator — sending a message runs UPDATE ... last_seq = last_seq + 1 in a transaction to take a row lock
-- ---------------------------------------------------------------------------
CREATE TABLE `conversations` (
  `id`              BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `conversation_id`         VARCHAR(64)  NOT NULL COMMENT 'Conversation business ID',
  `gmt_created`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `name`            VARCHAR(100) NOT NULL COMMENT 'Conversation name. Required even for direct chats: a conversation is a piece of work, not a chat window with someone',
  `creator`         VARCHAR(64)  NOT NULL COMMENT 'user_id of the creator',
  `owner`           VARCHAR(64)  NOT NULL COMMENT 'user_id of the current owner',
  `type`            VARCHAR(32)  NOT NULL COMMENT 'Conversation type: DIRECT one-on-one, GROUP group',
  `last_seq`        BIGINT(20)   NOT NULL DEFAULT 0 COMMENT 'In-conversation message seq allocator',
  `terminal_id`      VARCHAR(64)           DEFAULT NULL COMMENT 'Desktop node owning the conversation, fixed to one machine in phase 1, reserved for cross-node',
  `workspace_id`    VARCHAR(64)           DEFAULT NULL COMMENT 'workspace_id of the owning workspace, conversations not belonging to any project go to the "No workspace" of that account',
  `state`           VARCHAR(32)  NOT NULL DEFAULT 'IDLE' COMMENT 'Turn state: IDLE idle, RUNNING discussing, PAUSED paused (used by TurnService in phase 2)',
  `round_budget`    INT(11)      NOT NULL DEFAULT 8 COMMENT 'Max round budget per discussion (used by TurnService in phase 2)',
  `status`          VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'Conversation status: ACTIVE in progress, DONE done, ARCHIVED archived',
  `paused`          TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Whether paused by a human: 0 no, 1 yes',
  `auto_title`      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Whether waiting to be auto-named from the first reply: 0 no, 1 yes',
  `seed_key`        VARCHAR(128)          DEFAULT NULL COMMENT 'Stable key supplied when created from a task list, used for dedup on reapply',
  `extra`           JSON                  DEFAULT NULL COMMENT 'Desktop scheduler runtime state (charter, workPlan, brainstorm, followUp, workspacePath), the backend only stores it and does not parse it',
  `is_deleted`      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Whether deleted: 0 no, 1 yes',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_conversation_id` (`conversation_id`),
  KEY `idx_creator`        (`creator`),
  KEY `idx_owner`          (`owner`),
  KEY `idx_type`           (`type`),
  KEY `idx_terminal_id`     (`terminal_id`),
  KEY `idx_workspace_id`   (`workspace_id`),
  KEY `idx_owner_seed_key` (`owner`, `seed_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Conversations';

-- ---------------------------------------------------------------------------
-- conversation_user_rel: conversation members
-- last_read_seq is the single read position in the whole system, shared by humans and agents
-- ---------------------------------------------------------------------------
CREATE TABLE `conversation_user_rel` (
  `id`                 BIGINT(20)  NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `conversation_id`            VARCHAR(64) NOT NULL COMMENT 'Conversation business ID',
  `user_id`            VARCHAR(64) NOT NULL COMMENT 'user_id of the member, human or Agent',
  `role`               VARCHAR(32) NOT NULL DEFAULT 'ENGINEER' COMMENT 'Project role: LEADER lead, ENGINEER engineer, REVIEWER reviewer, OBSERVER observer (never called on to speak)',
  `last_read_seq`      BIGINT(20)  NOT NULL DEFAULT 0 COMMENT 'In-conversation seq read up to',
  `last_delivered_seq` BIGINT(20)  NOT NULL DEFAULT 0 COMMENT 'In-conversation seq delivered up to, for offline redelivery',
  `last_processed_seq` BIGINT(20)           DEFAULT NULL COMMENT 'In-conversation seq the Agent has processed up to, separate from the human read position, falls back to last_read_seq when null',
  `first_unread_mention_seq` BIGINT(20) DEFAULT NULL COMMENT 'seq of the first unread message that @-mentions this human, for reminders, null if none',
  `paused`             TINYINT(1)  NOT NULL DEFAULT 0 COMMENT 'Whether this Agent is paused in this conversation only: 0 no, 1 yes',
  `resume_on_continue` TINYINT(1)  NOT NULL DEFAULT 0 COMMENT 'Whether to auto-resume this Agent when the conversation continues: 0 no, 1 yes',
  `owner_paused`       TINYINT(1)  NOT NULL DEFAULT 0 COMMENT 'Whether a shared Agent is paused by its owner in this conversation: 0 no, 1 yes (other humans cannot send messages while paused)',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_conversation_user` (`conversation_id`, `user_id`),
  KEY `idx_conversation_id`         (`conversation_id`),
  KEY `idx_user_id`         (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Conversation members';

-- ---------------------------------------------------------------------------
-- messages: messages
-- (conversation_id, seq) is the sole anchor for incremental pulls and read positions
-- ---------------------------------------------------------------------------
CREATE TABLE `messages` (
  `id`              BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `message_id`      VARCHAR(64)  NOT NULL COMMENT 'Message business ID, generated by the client, used for retry idempotency',
  `conversation_id`         VARCHAR(64)  NOT NULL COMMENT 'conversation_id of the owning conversation',
  `seq`             BIGINT(20)   NOT NULL COMMENT 'Monotonically increasing in-conversation seq',
  `sender_id`       VARCHAR(64)  NOT NULL COMMENT 'user_id of the sender, human or Agent',
  `content`         LONGTEXT     NOT NULL COMMENT 'Message content',
  `type`            VARCHAR(32)  NOT NULL DEFAULT 'USER' COMMENT 'Message type: USER user or Agent message, SYSTEM system message, TASK task assignment card, SKILL skill-related message',
  `mentions`        VARCHAR(512)          DEFAULT NULL COMMENT 'Comma-separated list of @-mentioned user_ids',
  `reply_to`        VARCHAR(64)           DEFAULT NULL COMMENT 'message_id of the message being replied to',
  `status`          VARCHAR(32)  NOT NULL DEFAULT 'SENT' COMMENT 'Message status: SENDING sending, SENT sent, FAILED failed',
  `turn_id`         VARCHAR(64)           DEFAULT NULL COMMENT 'Owning discussion turn (used by TurnService in phase 2)',
  `is_deleted`      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Whether deleted: 0 no, 1 yes',
  `internal`        TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Whether this is an internal scheduler message (shown only in the process panel): 0 no, 1 yes',
  `report`          TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Whether generated by the Leader in response to a "report" request: 0 no, 1 yes',
  `failed`          TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Whether this is a failure receipt: 0 no, 1 yes',
  `extra`           JSON                  DEFAULT NULL COMMENT 'Extra info from the desktop scheduler (steps, agentReply, coordination), the backend only stores it and does not parse it',
  `attachments`     JSON                  DEFAULT NULL COMMENT 'Attachment list (attachmentId, name, mimeType, size, kind), details in the attachments table',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_message_id`       (`message_id`),
  UNIQUE KEY `uk_conversation_seq`       (`conversation_id`, `seq`),
  KEY `idx_sender_id` (`sender_id`),
  KEY `idx_type`      (`type`),
  KEY `idx_turn_id`   (`turn_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Messages';

-- ---------------------------------------------------------------------------
-- attachments: message attachments
-- Files are in OSS (object_key) — only metadata and ownership are recorded here. The client registers first to get an upload URL, uploads, then sends with a message,
-- unsent ones stay PENDING. attachment_id is generated by the client, so retries and offline replays never register twice.
-- ---------------------------------------------------------------------------
CREATE TABLE `attachments` (
  `id`            BIGINT(20)    NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `attachment_id` VARCHAR(64)   NOT NULL COMMENT 'Attachment business ID, generated by the client, used for retry idempotency',
  `conversation_id`       VARCHAR(64)   NOT NULL COMMENT 'conversation_id of the owning conversation, only conversation members can download',
  `uploader_id`   VARCHAR(64)   NOT NULL COMMENT 'user_id of the uploader, must match the message sender',
  `message_id`    VARCHAR(64)            DEFAULT NULL COMMENT 'Message it was sent with, null if not sent yet',
  `name`          VARCHAR(255)  NOT NULL COMMENT 'Original file name, for display and download',
  `mime_type`     VARCHAR(128)  NOT NULL COMMENT 'File type',
  `size_bytes`    BIGINT(20)    NOT NULL DEFAULT 0 COMMENT 'File size (bytes), updated to the actual OSS size when the message is sent',
  `kind`          VARCHAR(16)   NOT NULL COMMENT 'Category: IMAGE image, VIDEO video, FILE other file',
  `object_key`    VARCHAR(512)  NOT NULL COMMENT 'OSS object name',
  `status`        VARCHAR(16)   NOT NULL DEFAULT 'PENDING' COMMENT 'Status: PENDING registered but not sent, READY sent with a message',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_attachment_id` (`attachment_id`),
  KEY `idx_conversation_id`    (`conversation_id`),
  KEY `idx_message_id` (`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Message attachments';

-- ---------------------------------------------------------------------------
-- agent_sessions: an agent's CLI session resume token within a conversation
-- Each conversation has its own thread — never shared between conversations
-- Read positions are not here — they all live in conversation_user_rel.last_read_seq
-- ---------------------------------------------------------------------------
CREATE TABLE `agent_sessions` (
  `id`                 BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `session_id`         VARCHAR(64)  NOT NULL COMMENT 'Agent session business ID',
  `conversation_id`            VARCHAR(64)  NOT NULL COMMENT 'conversation_id of the owning conversation',
  `user_id`            VARCHAR(64)  NOT NULL COMMENT 'user_id of the Agent',
  `provider_thread_id` VARCHAR(128)          DEFAULT NULL COMMENT 'Agent CLI session resume token, e.g. codex thread_id',
  `workspace_path`     VARCHAR(512)          DEFAULT NULL COMMENT 'Project directory the agent works in for this conversation',
  `status`             VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'Status: ACTIVE valid, STALE expired, must be rebuilt',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_session_id` (`session_id`),
  UNIQUE KEY `uk_conversation_user`  (`conversation_id`, `user_id`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Agent session resume tokens';

-- ---------------------------------------------------------------------------
-- memories: memories
-- ---------------------------------------------------------------------------
CREATE TABLE `memories` (
  `id`           BIGINT(20)  NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `memory_id`    VARCHAR(64) NOT NULL COMMENT 'Memory business ID',
  `content`      LONGTEXT    NOT NULL COMMENT 'Memory content',
  `owner`        VARCHAR(64) NOT NULL COMMENT 'user_id for USER, conversation_id for CONVERSATION',
  `type`         VARCHAR(32) NOT NULL COMMENT 'Memory scope: USER user memory, CONVERSATION conversation memory',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_memory_id` (`memory_id`),
  KEY `idx_owner` (`owner`),
  KEY `idx_type`  (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Memories';

-- ---------------------------------------------------------------------------
-- workspaces: workspaces
-- Each account has exactly one INBOX ("No workspace"), created by the server on first use.
-- workspace_id is generated by the client: created locally while offline, uploaded unchanged once online — replays never create duplicates.
-- ---------------------------------------------------------------------------
CREATE TABLE `workspaces` (
  `id`           BIGINT(20)    NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `workspace_id` VARCHAR(64)   NOT NULL COMMENT 'Workspace business ID',
  `owner`        VARCHAR(64)   NOT NULL COMMENT 'user_id of the owning human',
  `terminal_id`   VARCHAR(64)            DEFAULT NULL COMMENT 'Computer hosting the directory (DESKTOP terminals only), null for INBOX',
  `name`         VARCHAR(100)  NOT NULL COMMENT 'Workspace name',
  `path`         VARCHAR(1024)          DEFAULT NULL COMMENT 'Directory path, valid only on the owning computer, null for INBOX',
  `kind`         VARCHAR(32)   NOT NULL COMMENT 'Type: FOLDER bound to a directory, INBOX no workspace',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workspace_id` (`workspace_id`),
  KEY `idx_owner`      (`owner`),
  KEY `idx_terminal_id` (`terminal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Workspaces';

-- ---------------------------------------------------------------------------
-- app_releases: upgradable desktop client versions
-- The release pipeline (desktop_mac/scripts/release.mjs) generates the matching INSERT, with rollout = GRAY by default.
-- Versions are identified externally by (channel, version, arch) — there is no separate business ID.
-- For gray release and rollout operations, see the "Gray release" section of desktop_mac's docs/ota-design.md.
-- ---------------------------------------------------------------------------
CREATE TABLE `app_releases` (
  `id`                    BIGINT(20)    NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `platform`              VARCHAR(10)   NOT NULL DEFAULT 'mac' COMMENT 'Platform: mac desktop, ios mobile',
  `channel`               VARCHAR(20)   NOT NULL COMMENT 'Release channel: develop development, pre pre-release, release production',
  `version`               VARCHAR(50)   NOT NULL COMMENT 'Version, semver, e.g. 0.4.0, 0.4.0-2026.9.16-093005-pre, or 0.4.0-2026.9.16-093005-dev',
  `arch`                  VARCHAR(30)   NOT NULL COMMENT 'CPU architecture, e.g. arm64',
  `url`                   VARCHAR(1024) NOT NULL COMMENT 'Installer download URL, must be https, the App Store page for mobile',
  `size_bytes`            BIGINT(20)             DEFAULT NULL COMMENT 'Installer size in bytes',
  `sha256`                CHAR(64)               DEFAULT NULL COMMENT 'Installer sha256, required for desktop, and the client must verify it after download, null for mobile',
  `signed`                TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'Whether signed and notarized',
  `team_id`               VARCHAR(20)            DEFAULT NULL COMMENT 'Team ID of the signing certificate',
  `min_supported_version` VARCHAR(50)            DEFAULT NULL COMMENT 'Versions below this cannot upgrade incrementally and need the full package',
  `mandatory`             TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'Whether the upgrade is mandatory: clients below this version must upgrade before continuing',
  `notes`                 VARCHAR(2000)          DEFAULT NULL COMMENT 'Release notes shown to users',
  `rollout`               VARCHAR(16)   NOT NULL DEFAULT 'GRAY' COMMENT 'Rollout state: ALL everyone, GRAY gray list only, OFF withdrawn',
  `released_at`           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Release time',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_platform_channel_version_arch` (`platform`, `channel`, `version`, `arch`),
  KEY `idx_platform_channel_arch_rollout` (`platform`, `channel`, `arch`, `rollout`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Client releases (desktop and mobile)';

-- ---------------------------------------------------------------------------
-- app_release_grays: gray list
-- Each row names one account or one computer. Keyed by (channel, version), regardless of architecture or platform (mobile goes through the App Store with no gray release).
--   USER    target_id = users.user_id (connected-mode login account)
--   MACHINE target_id = computer ID, i.e. terminals.fingerprint (standalone mode has it too — see client log update-check-*)
-- ---------------------------------------------------------------------------
CREATE TABLE `app_release_grays` (
  `id`           BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `channel`      VARCHAR(20)  NOT NULL COMMENT 'Release channel: develop / pre / release',
  `version`      VARCHAR(50)  NOT NULL COMMENT 'Gray-released version',
  `target_type`  VARCHAR(16)  NOT NULL COMMENT 'Target: USER account, MACHINE computer',
  `target_id`    VARCHAR(128) NOT NULL COMMENT 'user_id for USER, computer ID (lowercase hex sha256) for MACHINE',
  `remark`       VARCHAR(200)          DEFAULT NULL COMMENT 'Remark, e.g. who it is and why it was added',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_release_target` (`channel`, `version`, `target_type`, `target_id`),
  KEY `idx_target` (`target_type`, `target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Desktop client gray list';

-- ---------------------------------------------------------------------------
-- user_tags: account tags
-- Allowlist-style capabilities all hang off tags — an account can have multiple tags. Read by conductor, shown in the ops console.
--   PRE_GRAY            receives pre-release builds: the account itself and the computers it has registered (also in standalone mode)
--   MAINLAND_ADD_FRIEND can still add friends from mainland China IPs
-- ---------------------------------------------------------------------------
CREATE TABLE `user_tags` (
  `id`           BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `user_id`      VARCHAR(64)  NOT NULL COMMENT 'users.user_id',
  `tag`          VARCHAR(32)  NOT NULL COMMENT 'PRE_GRAY pre-release gray, MAINLAND_ADD_FRIEND mainland add-friend',
  `remark`       VARCHAR(200)          DEFAULT NULL COMMENT 'Remark, e.g. why it was added',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_tag` (`user_id`, `tag`),
  KEY `idx_tag` (`tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Account tags, allowlist-style capabilities all hang off this';

-- ---------------------------------------------------------------------------
-- device_telemetry: device telemetry: one row per device, storing the latest report.
-- The desktop app reports while its window is in the foreground, at most once per hour — nothing is reported while in the background. Unique by device_uuid: inserted first, updated afterwards.
-- Standalone mode (not logged in) reports too, with user_id null — phone and email come from the profile, null if absent.
-- user_id is just the last reporting account and must not be used for attribution in statistics. City is inferred offline by the backend from the request IP — the IP itself is never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE `device_telemetry` (
  `id`             BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time (first report)',
  `gmt_modified`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `device_uuid`    VARCHAR(128) NOT NULL COMMENT 'Unique device ID, i.e. the desktop computer ID (lowercase hex sha256)',
  `user_id`        VARCHAR(64)           DEFAULT NULL COMMENT 'user_id of the logged-in account, per the token, null in standalone mode',
  `device_type`    VARCHAR(16)  NOT NULL COMMENT 'Device type: mac',
  `phone`          VARCHAR(30)           DEFAULT NULL COMMENT 'Phone number, reported if present in the profile',
  `email`          VARCHAR(254)          DEFAULT NULL COMMENT 'Email, reported if present in the profile',
  `city`           VARCHAR(64)           DEFAULT NULL COMMENT 'City inferred from the request IP, null for private networks or lookup misses',
  `agents`         VARCHAR(255)          DEFAULT NULL COMMENT 'Agent types detected as available, comma-separated, e.g. codex,qoder',
  `last_report_at` DATETIME     NOT NULL COMMENT 'Last report time',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_device_uuid` (`device_uuid`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_last_report_at` (`last_report_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Device telemetry';

-- ---------------------------------------------------------------------------
-- device_telemetry_hour: device foreground-active hourly buckets: one row means "this computer's window was in the foreground during this hour".
-- conductor writes idempotently by (stat_hour, device_uuid) on receiving telemetry — the ops console computes computer DAU and MAU from it.
-- Rows from 2026-11-09 and earlier come from old background reports (launch, day rollover, wake), which were recorded even without the UI open.
-- ---------------------------------------------------------------------------
CREATE TABLE `device_telemetry_hour` (
  `id`           BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `stat_hour`    DATETIME     NOT NULL COMMENT 'Hourly bucket, e.g. 2026-10-30 14:00:00, split by conductor system time zone',
  `device_uuid`  VARCHAR(128) NOT NULL COMMENT 'Unique device ID, same as devices.device_uuid',
  `user_id`      VARCHAR(64)           DEFAULT NULL COMMENT 'Logged-in account at the latest report in this bucket, null in standalone mode',
  `device_type`  VARCHAR(16)  NOT NULL COMMENT 'Device type: mac etc., from telemetry',
  `reported_at`  DATETIME     NOT NULL COMMENT 'Latest report time within this bucket',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hour_device` (`stat_hour`, `device_uuid`),
  KEY `idx_stat_hour` (`stat_hour`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Device foreground-active hourly buckets';

-- ---------------------------------------------------------------------------
-- devices: devices: one copy of a device's parameters, keyed by device_uuid, not by account.
-- device_uuid is the same as terminals.fingerprint and device_telemetry.device_uuid.
-- Accounts and devices are many-to-many, linked through terminals (owner + fingerprint). Standalone mode has no account, only one row in this table.
-- ---------------------------------------------------------------------------
CREATE TABLE `devices` (
  `id`             BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `device_uuid`    VARCHAR(128) NOT NULL COMMENT 'Unique device ID: sha256 of the hardware UUID for computers, the keychain UUID for phones',
  `device_type`    VARCHAR(16)  NOT NULL COMMENT 'Device type: mac, windows from telemetry, desktop, mobile for register-only',
  `name`           VARCHAR(100)          DEFAULT NULL COMMENT 'Device name, null for standalone installs that only reported telemetry',
  `os_version`     VARCHAR(64)           DEFAULT NULL COMMENT 'OS version, null for old clients that do not report it',
  `app_version`    VARCHAR(50)           DEFAULT NULL COMMENT 'ADing version, from registration, telemetry, or update check, null if never sent',
  `city`           VARCHAR(64)           DEFAULT NULL COMMENT 'City inferred from the registration or telemetry request IP',
  `first_seen_at`  DATETIME              DEFAULT NULL COMMENT 'First seen time',
  `last_active_at` DATETIME              DEFAULT NULL COMMENT 'Last active time: observed connected to MQTT, null if no record',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_device_uuid` (`device_uuid`),
  KEY `idx_last_active_at` (`last_active_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Devices';

-- ---------------------------------------------------------------------------
-- terminal_sessions: terminal connection sessions: one row per MQTT connection — active duration = offline time - online time.
-- There is no app heartbeat — conductor polls broker connection state to open and close sessions (MqttPresence). Pre-release and production query the same broker
-- and write the same table — the unique key on open_terminal_id guarantees at most one open row per terminal, so the two processes never open duplicates.
-- An open session has open_terminal_id = terminal_id, cleared to null when it ends (the unique key allows multiple NULLs).
-- ---------------------------------------------------------------------------
CREATE TABLE `terminal_sessions` (
  `id`               BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `terminal_id`      VARCHAR(64)  NOT NULL COMMENT 'terminals.terminal_id',
  `device_uuid`      VARCHAR(128) NOT NULL COMMENT 'devices.device_uuid',
  `user_id`          VARCHAR(64)  NOT NULL COMMENT 'Account for this connection, terminals.owner',
  `online_at`        DATETIME     NOT NULL COMMENT 'Online time: when the connection was first observed',
  `offline_at`       DATETIME              DEFAULT NULL COMMENT 'Offline time: when the disconnect was observed, last_seen_at if not observed (backend was down), null while open',
  `last_seen_at`     DATETIME     NOT NULL COMMENT 'Last time the connection was observed',
  `open_terminal_id` VARCHAR(64)           DEFAULT NULL COMMENT 'Equals terminal_id while open, null after it ends, a unique key ensures one open row per terminal',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_open_terminal_id` (`open_terminal_id`),
  KEY `idx_online_at` (`online_at`),
  KEY `idx_last_seen_at` (`last_seen_at`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_device_uuid` (`device_uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Terminal connection sessions';

-- ---------------------------------------------------------------------------
-- knowledge_locks: sync lock for uploading user skills and memory to the cloud
-- ---------------------------------------------------------------------------
CREATE TABLE `knowledge_locks` (
  `user_id`     VARCHAR(64) NOT NULL COMMENT 'users.user_id, one lock per user at a time',
  `lock_token`  VARCHAR(64) NOT NULL COMMENT 'Lock token, required when writing OSS and renewing',
  `expires_at`  DATETIME    NOT NULL COMMENT 'Expiry time: expires automatically if the holder crashes or goes offline',
  `gmt_created` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Time the lock was acquired',
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Sync lock for uploading user skills and memory to the cloud';

-- ---------------------------------------------------------------------------
-- push_devices: APNs device tokens for phones
-- ---------------------------------------------------------------------------
CREATE TABLE `push_devices` (
  `id`              BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `terminal_id`     VARCHAR(64)  NOT NULL COMMENT 'Phone terminal, terminals.terminal_id',
  `owner`           VARCHAR(64)  NOT NULL COMMENT 'user_id currently logged in on this phone',
  `device_token`    VARCHAR(200) NOT NULL COMMENT 'APNs device token (lowercase hex)',
  `environment`     VARCHAR(16)  NOT NULL COMMENT 'sandbox for dev builds / production for TestFlight and App Store',
  `language`        VARCHAR(8)   NOT NULL COMMENT 'Notification text language, reported by the phone: zh / en',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_terminal_id`  (`terminal_id`),
  UNIQUE KEY `uk_device_token` (`device_token`),
  KEY `idx_owner` (`owner`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Phone push devices';
