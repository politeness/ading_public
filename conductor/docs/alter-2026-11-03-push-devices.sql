-- Create push_devices: APNs device tokens for phones.
-- New table only — old conductor versions are unaffected. The new conductor depends on it (looking up recipient phones after sending, phones reporting tokens), so run this before deploying the new conductor.
-- Back up first. Safe to rerun.

CREATE TABLE IF NOT EXISTS `push_devices` (
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
