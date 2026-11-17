-- Add model_state to users: the current model reported by the Agent's computer, shown by other computers while it is offline.
-- Nullable column addition only — old conductor versions don't know it and are unaffected. The new conductor writes this column when reporting state, so run this before deploying the new conductor.
-- Back up first. Safe to rerun.

SET @has_column = (SELECT COUNT(*) FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'model_state');
SET @ddl = IF(@has_column = 0,
  "ALTER TABLE users ADD COLUMN model_state VARCHAR(1024) DEFAULT NULL COMMENT 'Agent current model (JSON: selected, selectedLabel, nativeModel), reported by its computer, the backend only stores it and does not interpret it, null for Agents on old clients and for humans'",
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
