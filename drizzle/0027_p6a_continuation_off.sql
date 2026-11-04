PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER p6a_task_insert;--> statement-breakpoint
DROP TRIGGER p6a_task_update;--> statement-breakpoint
DROP TRIGGER p6a_control_disabled;--> statement-breakpoint
CREATE TABLE `__new_chat_automation_control` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'enabled' NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`changed_by` text,
	`changed_at` integer,
	`reason` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "automation_mode_check" CHECK("__new_chat_automation_control"."mode" in ('enabled','off')),
	CONSTRAINT "automation_revision_check" CHECK("__new_chat_automation_control"."epoch" between 1 and 9007199254740991 and "__new_chat_automation_control"."revision" between 1 and 9007199254740991),
	CONSTRAINT "automation_audit_check" CHECK(("__new_chat_automation_control"."changed_by" is null) = ("__new_chat_automation_control"."changed_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_chat_automation_control`("chat_id", "mode", "epoch", "revision", "changed_by", "changed_at", "reason") SELECT "chat_id", CASE WHEN "mode"='enabled' THEN 'enabled' ELSE 'off' END, "epoch", "revision", "changed_by", "changed_at", "reason" FROM `chat_automation_control`;--> statement-breakpoint
DROP TABLE `chat_automation_control`;--> statement-breakpoint
ALTER TABLE `__new_chat_automation_control` RENAME TO `chat_automation_control`;--> statement-breakpoint
UPDATE continuation_delivery SET cancel_reason=CASE cancel_reason WHEN 'human_paused' THEN 'human_disabled' WHEN 'human_stopped' THEN 'human_aborted' END WHERE cancel_reason IN ('human_paused','human_stopped');
--> statement-breakpoint
CREATE TRIGGER p6a_task_insert AFTER INSERT ON task WHEN NEW.status='assigned' BEGIN
  INSERT OR IGNORE INTO chat_automation_control(chat_id) VALUES(NEW.chat_id);
  INSERT OR IGNORE INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at)
    SELECT NEW.chat_id,NEW.project_id,NEW.updated_at+300000,coalesce((SELECT max(round) FROM wake_evaluation WHERE chat_id=NEW.chat_id),0),'',NEW.updated_at
    WHERE EXISTS(SELECT 1 FROM chat_automation_control WHERE chat_id=NEW.chat_id AND mode='enabled')
      AND EXISTS(SELECT 1 FROM chat WHERE id=NEW.chat_id AND archived_at IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER p6a_task_update AFTER UPDATE ON task BEGIN
  UPDATE continuation_delivery SET state='canceled',cancel_reason='task_context_changed',next_attempt_at=NULL
    WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state='presented';
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL
    WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state IN ('pending','claimed','retry_wait');
  DELETE FROM chat_schedule WHERE chat_id IN (OLD.chat_id,NEW.chat_id)
    AND NOT EXISTS(SELECT 1 FROM task WHERE task.chat_id=chat_schedule.chat_id AND task.status='assigned');
  INSERT OR IGNORE INTO chat_automation_control(chat_id) SELECT NEW.chat_id WHERE NEW.status='assigned';
  INSERT OR IGNORE INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at)
    SELECT NEW.chat_id,NEW.project_id,NEW.updated_at+300000,coalesce((SELECT max(round) FROM wake_evaluation WHERE chat_id=NEW.chat_id),0),'',NEW.updated_at
    WHERE NEW.status='assigned' AND EXISTS(SELECT 1 FROM chat_automation_control WHERE chat_id=NEW.chat_id AND mode='enabled')
      AND EXISTS(SELECT 1 FROM chat WHERE id=NEW.chat_id AND archived_at IS NULL);
  UPDATE chat_schedule SET next_due_at=coalesce(next_due_at,NEW.updated_at+300000),updated_at=NEW.updated_at WHERE chat_id IN (OLD.chat_id,NEW.chat_id);
END;
--> statement-breakpoint
CREATE TRIGGER p6a_control_disabled AFTER UPDATE OF mode,epoch ON chat_automation_control WHEN NEW.mode<>'enabled' BEGIN
  DELETE FROM chat_schedule WHERE chat_id=NEW.chat_id;
  UPDATE wake_evaluation SET state='canceled',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state='pending';
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('claimed','retry_wait');
  UPDATE continuation_delivery SET state='canceled',cancel_reason='human_disabled',next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id=NEW.chat_id AND state='presented';
END;
--> statement-breakpoint
PRAGMA foreign_keys=ON;