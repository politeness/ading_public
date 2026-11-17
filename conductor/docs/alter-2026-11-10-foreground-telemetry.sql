-- Device telemetry is now reported while the window is in the foreground — the ops console computes computer DAU from device_telemetry_hour.
-- Both tables keep their original structure — only device_telemetry_hour is now written directly by conductor (previously collected by the ops console).
-- These two tables have always existed on production RDS, so nothing changes there — the NAS dev database ran the old retirement script and recreates them here.
-- Idempotent and add-only — can run while the old jar is running.

CREATE TABLE IF NOT EXISTS `device_telemetry` (
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

CREATE TABLE IF NOT EXISTS `device_telemetry_hour` (
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
