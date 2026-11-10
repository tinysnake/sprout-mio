CREATE TABLE `assistant_watch_cursor` (
	`watch_id` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`next_due_at` integer NOT NULL,
	`message_rowid` integer NOT NULL,
	FOREIGN KEY (`watch_id`) REFERENCES `assistant_watch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_watch_cursor_due_idx` ON `assistant_watch_cursor` (`next_due_at`);--> statement-breakpoint
ALTER TABLE `assistant_event` ADD `decision_resolved_at` integer;
--> statement-breakpoint
UPDATE assistant_event AS e SET suppressed_at=unixepoch()*1000
WHERE e.message_id IS NULL AND e.suppressed_at IS NULL AND json_extract(e.fact,'$.runId') IS NOT NULL
  AND EXISTS (SELECT 1 FROM assistant_interest i WHERE i.assistant_chat_id=e.assistant_chat_id AND i.run_id=json_extract(e.fact,'$.runId') AND i.origin_kind='watch')
  AND NOT EXISTS (SELECT 1 FROM assistant_interest i WHERE i.assistant_chat_id=e.assistant_chat_id AND i.run_id=json_extract(e.fact,'$.runId') AND i.origin_kind='proposal');
--> statement-breakpoint
UPDATE assistant_run_cursor AS c SET terminal_captured_at=unixepoch()*1000
WHERE c.terminal_captured_at IS NULL
  AND EXISTS (SELECT 1 FROM agent_run r WHERE r.id=c.run_id AND r.status NOT IN ('queued','running'))
  AND NOT EXISTS (SELECT 1 FROM assistant_interest i WHERE i.assistant_chat_id=c.assistant_chat_id AND i.run_id=c.run_id AND i.origin_kind='proposal');
--> statement-breakpoint
INSERT INTO assistant_watch_cursor(watch_id,window_started_at,next_due_at,message_rowid)
SELECT w.id,unixepoch()*1000,unixepoch()*1000+w.interval_seconds*1000,
  coalesce((SELECT max(m.rowid) FROM message m WHERE m.chat_id=w.target_chat_id),0)
FROM assistant_watch w WHERE w.revoked_at IS NULL;
--> statement-breakpoint
UPDATE assistant_event AS e SET decision_resolved_at=unixepoch()*1000
WHERE json_extract(e.fact,'$.watchIntent')=1 AND (
  EXISTS (SELECT 1 FROM assistant_watch w WHERE w.assistant_chat_id=e.assistant_chat_id
    AND w.target_project_id=json_extract(e.fact,'$.targetProjectId')
    AND w.target_chat_id=json_extract(e.fact,'$.targetChatId')
    AND coalesce(w.revoked_at,w.consented_at)>=e.created_at)
  OR EXISTS (SELECT 1 FROM assistant_event newer WHERE newer.assistant_chat_id=e.assistant_chat_id
    AND json_extract(newer.fact,'$.watchIntent')=1
    AND json_extract(newer.fact,'$.targetProjectId')=json_extract(e.fact,'$.targetProjectId')
    AND json_extract(newer.fact,'$.targetChatId')=json_extract(e.fact,'$.targetChatId')
    AND (newer.created_at>e.created_at OR (newer.created_at=e.created_at AND newer.rowid>e.rowid)))
);