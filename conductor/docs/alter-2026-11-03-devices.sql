-- Initial tables for devices and online sessions — back up before running incremental migrations on an existing database. Device info is backfilled only from registered terminals, not from retired telemetry.

CREATE TABLE IF NOT EXISTS `devices` (
  `id`             BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `gmt_modified`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Modified time',
  `device_uuid`    VARCHAR(128) NOT NULL COMMENT 'Unique device ID: sha256 of the hardware UUID for computers, the keychain UUID for phones',
  `device_type`    VARCHAR(16)  NOT NULL COMMENT 'Device type: mac, windows from device info, desktop, mobile for register-only',
  `name`           VARCHAR(100)          DEFAULT NULL COMMENT 'Device name',
  `os_version`     VARCHAR(64)           DEFAULT NULL COMMENT 'OS version, null for old clients that do not report it',
  `app_version`    VARCHAR(50)           DEFAULT NULL COMMENT 'ADing version, from registration or update check, null if never sent',
  `city`           VARCHAR(64)           DEFAULT NULL COMMENT 'City inferred from the registration request IP',
  `first_seen_at`  DATETIME              DEFAULT NULL COMMENT 'First seen time',
  `last_active_at` DATETIME              DEFAULT NULL COMMENT 'Last active time: observed connected to MQTT, null if no record',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_device_uuid` (`device_uuid`),
  KEY `idx_last_active_at` (`last_active_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Devices';

CREATE TABLE IF NOT EXISTS `terminal_sessions` (
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

INSERT INTO devices (device_uuid, device_type, name, first_seen_at)
SELECT t.fingerprint, LOWER(t.type), t.name, t.gmt_created
FROM terminals t
WHERE t.id = (SELECT MAX(t2.id) FROM terminals t2 WHERE t2.fingerprint=t.fingerprint)
ON DUPLICATE KEY UPDATE name=COALESCE(devices.name, VALUES(name));
