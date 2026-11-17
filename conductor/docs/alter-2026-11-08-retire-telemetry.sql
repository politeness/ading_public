-- Retire foreground timing and the telemetry snapshot columns on devices.
-- mysqldump a backup first — switch all conductor and Ops instances to new versions that don't reference them.
-- Production and pre-release share the RDS, so run only after both conductors have stopped the old writes.
-- device_telemetry and device_telemetry_hour are not dropped: telemetry is now reported while the window is in the foreground, and DAU is computed from them,
-- see alter-2026-11-10-foreground-telemetry.sql.
DROP TABLE IF EXISTS `foreground_usage`;

-- Available Agents come from readiness in users — standalone mode reads device_telemetry.agents — devices no longer keeps its own copy.
SET @ddl = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `devices` DROP COLUMN `agents`', 'DO 0')
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='devices' AND COLUMN_NAME='agents');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- Clean up old tables and index names left from desktops → terminals and WebSocket → MQTT.
-- Idempotent and backward compatible: the code does not reference these tables or index names, so it can run while the old jar is running. Run on both production RDS and NAS.
-- Back up per the release process first.
--
-- 2026-11-03 read-only check:
--   RDS (MySQL 8.0.36): all three old tables are gone — all five indexes still have old names.
--   NAS (MariaDB 10.11): all three old tables are gone — only users.uk_desktop_local has the old name.

DROP TABLE IF EXISTS `node_events`;
DROP TABLE IF EXISTS `node_leases`;

-- Drop desktops only if terminals already exists — never touch an unmigrated database
SET @sql = (SELECT IF(COUNT(*) > 0, 'DROP TABLE IF EXISTS `desktops`', 'DO 0')
            FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name = 'terminals');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `terminals` RENAME INDEX `uk_desktop_id` TO `uk_terminal_id`', 'DO 0')
            FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'terminals' AND index_name = 'uk_desktop_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `users` RENAME INDEX `idx_desktop_id` TO `idx_terminal_id`', 'DO 0')
            FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'idx_desktop_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `users` RENAME INDEX `uk_desktop_local` TO `uk_terminal_local`', 'DO 0')
            FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'uk_desktop_local');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `conversations` RENAME INDEX `idx_desktop_id` TO `idx_terminal_id`', 'DO 0')
            FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'conversations' AND index_name = 'idx_desktop_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `workspaces` RENAME INDEX `idx_desktop_id` TO `idx_terminal_id`', 'DO 0')
            FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'workspaces' AND index_name = 'idx_desktop_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
