-- Account tags: the mainland add-friend list (formerly env ADING_REGION_EXEMPT_USERS) and fixed pre-release gray recipients become tags.
-- New table only — old conductor versions do not know it and are unaffected. Back up first. Safe to rerun.
-- Only tag accounts that actually exist in the database: dev and production databases have different accounts.

CREATE TABLE IF NOT EXISTS `user_tags` (
  `id`           BIGINT(20)   NOT NULL AUTO_INCREMENT COMMENT 'ID, auto-increment',
  `gmt_created`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
  `user_id`      VARCHAR(64)  NOT NULL COMMENT 'users.user_id',
  `tag`          VARCHAR(32)  NOT NULL COMMENT 'PRE_GRAY pre-release gray, MAINLAND_ADD_FRIEND mainland add-friend',
  `remark`       VARCHAR(200)          DEFAULT NULL COMMENT 'Remark, e.g. why it was added',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_tag` (`user_id`, `tag`),
  KEY `idx_tag` (`tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Account tags, allowlist-style capabilities all hang off this';

INSERT IGNORE INTO user_tags (user_id, tag, remark)
SELECT user_id, 'PRE_GRAY', '固定预发接收人' FROM users
 WHERE user_id IN ('<user_id>');

INSERT IGNORE INTO user_tags (user_id, tag, remark)
SELECT user_id, 'MAINLAND_ADD_FRIEND', '迁自 ADING_REGION_EXEMPT_USERS' FROM users
 WHERE user_id IN ('<user_id>');
