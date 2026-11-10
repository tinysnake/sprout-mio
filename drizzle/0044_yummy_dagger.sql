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
  WHERE c.kind IN ('dm', 'group') AND (
    cm.member_kind = 'human' OR c.kind = 'dm' OR EXISTS (
      SELECT 1 FROM project_member pm
      WHERE pm.project_id = c.project_id AND pm.agent_profile_id = cm.member_id
    )
  )
  UNION ALL
  SELECT
    c.id AS chat_id,
    c.project_id,
    'agent' AS member_kind,
    pm.agent_profile_id AS member_id,
    pm.added_at,
    'project_member' AS source
  FROM chat c
  JOIN project_member pm ON pm.project_id = c.project_id
  JOIN agent_profile ap ON ap.id = pm.agent_profile_id AND ap.purpose = 'worker'
  WHERE c.kind = 'public_channel'
  UNION ALL
  SELECT
    c.id AS chat_id,
    c.project_id,
    'human' AS member_kind,
    p.created_by AS member_id,
    p.created_at AS added_at,
    'project_owner' AS source
  FROM chat c
  JOIN project p ON p.id = c.project_id
  WHERE c.kind = 'public_channel'
;
--> statement-breakpoint
CREATE TRIGGER assistant_message_no_update BEFORE UPDATE ON message WHEN OLD.sender_kind IN ('assistant_event', 'assistant_work') BEGIN SELECT RAISE(ABORT, 'assistant messages are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER assistant_message_no_delete BEFORE DELETE ON message WHEN OLD.sender_kind IN ('assistant_event', 'assistant_work') BEGIN SELECT RAISE(ABORT, 'assistant messages are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER assistant_confirmation_immutable BEFORE UPDATE ON assistant_proposal WHEN OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.confirmed_by IS NOT OLD.confirmed_by OR NEW.work_message_id IS NOT OLD.work_message_id) BEGIN SELECT RAISE(ABORT, 'assistant confirmation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER assistant_confirmation_human BEFORE UPDATE ON assistant_proposal WHEN NEW.status = 'submitted' AND (NEW.confirmed_by IS NOT NEW.human_id OR NEW.confirmed_at IS NULL OR NEW.work_message_id IS NULL) BEGIN SELECT RAISE(ABORT, 'assistant confirmation requires Human receipt'); END;
--> statement-breakpoint
CREATE TRIGGER assistant_watch_consent_immutable BEFORE UPDATE ON assistant_watch WHEN NEW.assistant_chat_id IS NOT OLD.assistant_chat_id OR NEW.target_project_id IS NOT OLD.target_project_id OR NEW.target_chat_id IS NOT OLD.target_chat_id OR NEW.consented_by IS NOT OLD.consented_by OR NEW.consented_at IS NOT OLD.consented_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) BEGIN SELECT RAISE(ABORT, 'assistant watch consent is immutable'); END;