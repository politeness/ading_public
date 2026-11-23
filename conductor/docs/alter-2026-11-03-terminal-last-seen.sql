-- Add last_seen_at to terminals: the last time this account registered (login, launch) on this device or was observed connected to MQTT — for ops statistics only.
-- Null if there is no record since rollout — no estimated backfill.
-- Nullable column addition only — old conductor versions do not know it and are unaffected. The new conductor and new ops console both depend on it, so run this before both.
-- Back up first. Safe to rerun.

SET @has_column = (SELECT COUNT(*) FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'terminals' AND COLUMN_NAME = 'last_seen_at');
SET @ddl = IF(@has_column = 0,
  "ALTER TABLE terminals ADD COLUMN last_seen_at DATETIME DEFAULT NULL COMMENT 'Last registration (login, launch) or observed MQTT connection time, for ops statistics only, business online checks still rely on MQTT queries'",
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_index = (SELECT COUNT(*) FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'terminals' AND INDEX_NAME = 'idx_last_seen_at');
SET @ddl = IF(@has_index = 0, 'ALTER TABLE terminals ADD KEY idx_last_seen_at (last_seen_at)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
