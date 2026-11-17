-- Back up before running. Run once before deploying the new backend.
ALTER TABLE users ADD COLUMN onboarding_v1_steps TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Onboarding v1 confirmed-or-skipped step bitmap, 0 not started, 255 all done';
UPDATE users SET onboarding_v1_steps = 255 WHERE is_agent = 0 AND username NOT IN ('<internal-test-account-username>');
