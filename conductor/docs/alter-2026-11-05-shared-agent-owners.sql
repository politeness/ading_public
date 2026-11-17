-- Back up the target database before running. No schema changes.
-- Preserve DIRECT participants; add missing Agent owners only to existing groups.
INSERT INTO conversation_user_rel (conversation_id, user_id, role, last_read_seq, last_delivered_seq)
SELECT DISTINCT c.conversation_id, a.owner, 'ENGINEER', 0, 0
  FROM conversations c
  JOIN conversation_user_rel r ON r.conversation_id = c.conversation_id
  JOIN users a ON a.user_id = r.user_id AND a.is_agent = 1
  JOIN users o ON o.user_id = a.owner AND o.is_agent = 0
  LEFT JOIN conversation_user_rel own ON own.conversation_id = c.conversation_id AND own.user_id = a.owner
 WHERE c.type = 'GROUP' AND c.is_deleted = 0 AND own.user_id IS NULL;

-- Must return 0 after migration.
SELECT COUNT(*) AS groups_missing_agent_owner
  FROM conversations c JOIN conversation_user_rel r ON r.conversation_id = c.conversation_id
  JOIN users a ON a.user_id = r.user_id AND a.is_agent = 1
  LEFT JOIN conversation_user_rel own ON own.conversation_id = c.conversation_id AND own.user_id = a.owner
 WHERE c.type = 'GROUP' AND c.is_deleted = 0 AND own.user_id IS NULL;
