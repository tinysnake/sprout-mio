DROP VIEW `chat_effective_member`;--> statement-breakpoint
CREATE VIEW `chat_effective_member` AS 
  SELECT
    c.id AS chat_id,
    c.project_id,
    cm.member_kind,
    cm.member_id,
    cm.added_at,
    'chat_member' AS source
  FROM chat c
  JOIN chat_member cm ON cm.chat_id = c.id
  WHERE c.kind IN ('dm', 'crew') AND (
    cm.member_kind = 'human' OR c.kind = 'dm' OR EXISTS (
      SELECT 1 FROM project_member pm
      WHERE pm.project_id = c.project_id AND pm.agent_profile_id = cm.member_id
    )
  )
  UNION ALL
  SELECT c.id, c.project_id, 'human', cm.member_id, cm.added_at, 'delegation'
  FROM chat c
  JOIN delegation d ON d.child_chat_id = c.id
  JOIN chat p ON p.id = d.parent_crew_chat_id
  JOIN chat_member cm ON cm.chat_id = p.id AND cm.member_kind = 'human'
  WHERE c.kind = 'delegation'
  UNION ALL
  SELECT c.id, c.project_id, 'agent', p.lead_profile_id, d.created_at, 'delegation'
  FROM chat c
  JOIN delegation d ON d.child_chat_id = c.id
  JOIN chat p ON p.id = d.parent_crew_chat_id
  WHERE c.kind = 'delegation' AND p.lead_profile_id IS NOT NULL
  UNION ALL
  SELECT c.id, c.project_id, 'agent', d.worker_profile_id, d.created_at, 'delegation'
  FROM chat c
  JOIN delegation d ON d.child_chat_id = c.id
  WHERE c.kind = 'delegation'
  UNION ALL
  SELECT c.id, c.project_id, 'human', cm.member_id, cm.added_at, 'delegation'
  FROM chat c
  JOIN chat p ON p.id = c.parent_crew_chat_id
  JOIN chat_member cm ON cm.chat_id = p.id AND cm.member_kind = 'human'
  WHERE c.kind = 'delegation'
    AND NOT EXISTS (SELECT 1 FROM delegation d WHERE d.child_chat_id = c.id)
  UNION ALL
  SELECT c.id, c.project_id, 'agent', p.lead_profile_id, c.created_at, 'delegation'
  FROM chat c
  JOIN chat p ON p.id = c.parent_crew_chat_id
  WHERE c.kind = 'delegation'
    AND p.lead_profile_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM delegation d WHERE d.child_chat_id = c.id)
;--> statement-breakpoint
CREATE TRIGGER `delegation_result_size_guard` BEFORE INSERT ON delegation_result
WHEN length(CAST(NEW.content AS BLOB)) <> NEW.byte_size OR NEW.byte_size > 262144
BEGIN
  SELECT RAISE(ABORT, 'delegation_result_size_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `delegation_result_size_guard_update` BEFORE UPDATE OF content, byte_size ON delegation_result
WHEN length(CAST(NEW.content AS BLOB)) <> NEW.byte_size OR NEW.byte_size > 262144
BEGIN
  SELECT RAISE(ABORT, 'delegation_result_size_mismatch');
END;
