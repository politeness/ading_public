-- Reminders for @-mentioning a human (2026-11-02): ALTER statements to bring existing environments (NAS, ECS) up to create-database.sql.
-- The service never alters tables on startup — back up first (see deployment.md).
-- The new jar uses this column both when sending messages and when marking read, so alter the table before swapping the jar — add-only, old jars unaffected.

ALTER TABLE `conversation_user_rel`
  ADD COLUMN `first_unread_mention_seq` BIGINT(20) DEFAULT NULL
  COMMENT 'seq of the first unread message that @-mentions this human, for reminders, null if none'
  AFTER `last_processed_seq`;
