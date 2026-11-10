ALTER TABLE `agent_run_input` ADD `assistant_context` text;--> statement-breakpoint
ALTER TABLE `agent_run_input` ADD `assistant_context_submitted_at` integer;--> statement-breakpoint
CREATE TRIGGER agent_run_input_assistant_context_immutable
BEFORE UPDATE ON agent_run_input
WHEN (OLD.assistant_context IS NOT NULL AND NEW.assistant_context IS NOT OLD.assistant_context
  AND NOT (OLD.assistant_context_submitted_at IS NULL AND NEW.run_id <> OLD.run_id AND NEW.assistant_context IS NULL))
  OR (OLD.assistant_context_submitted_at IS NOT NULL AND NEW.assistant_context_submitted_at IS NOT OLD.assistant_context_submitted_at)
BEGIN
  SELECT RAISE(ABORT, 'assistant_input_context_immutable');
END;--> statement-breakpoint
CREATE TRIGGER agent_run_input_assistant_context_valid
BEFORE UPDATE ON agent_run_input
WHEN NEW.assistant_context IS NOT NULL AND (
  NOT json_valid(NEW.assistant_context)
  OR json_extract(NEW.assistant_context, '$.runId') IS NOT NEW.run_id
  OR json_extract(NEW.assistant_context, '$.messageId') IS NOT NEW.message_id
  OR length(json_extract(NEW.assistant_context, '$.contentHash')) IS NOT 64
  OR length(CAST(json_extract(NEW.assistant_context, '$.serializedText') AS BLOB)) > 8192
  OR (NEW.assistant_context_submitted_at IS NOT NULL AND NEW.disposition <> 'delivered')
)
BEGIN
  SELECT RAISE(ABORT, 'assistant_input_context_invalid');
END;