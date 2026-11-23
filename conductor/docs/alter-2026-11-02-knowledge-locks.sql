-- Sync lock for uploading user skills and memory to the cloud: the multiple computers of a user queue up and never write OSS concurrently.
-- New table only — old conductor versions do not know it and are unaffected. Back up first. Safe to rerun.

CREATE TABLE IF NOT EXISTS `knowledge_locks` (
  `user_id`     VARCHAR(64) NOT NULL COMMENT 'users.user_id, one lock per user at a time',
  `lock_token`  VARCHAR(64) NOT NULL COMMENT 'Lock token, required when writing OSS and renewing',
  `expires_at`  DATETIME    NOT NULL COMMENT 'Expiry time: expires automatically if the holder crashes or goes offline',
  `gmt_created` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Time the lock was acquired',
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Sync lock for uploading user skills and memory to the cloud';
