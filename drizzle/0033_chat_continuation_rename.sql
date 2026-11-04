PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_control_disabled`;--> statement-breakpoint
CREATE TABLE `__new_chat_continuation_control` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'enabled' NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`changed_by` text,
	`changed_at` integer,
	`reason` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "continuation_mode_check" CHECK(`mode` in ('enabled','off')),
	CONSTRAINT "continuation_revision_check" CHECK(`epoch` between 1 and 9007199254740991 and `revision` between 1 and 9007199254740991),
	CONSTRAINT "continuation_audit_check" CHECK((`changed_by` is null) = (`changed_at` is null))
);
--> statement-breakpoint
INSERT INTO `__new_chat_continuation_control`("chat_id", "mode", "epoch", "revision", "changed_by", "changed_at", "reason") SELECT "chat_id", "mode", "epoch", "revision", "changed_by", "changed_at", "reason" FROM `chat_automation_control`;--> statement-breakpoint
DROP TABLE `chat_automation_control`;--> statement-breakpoint
ALTER TABLE `__new_chat_continuation_control` RENAME TO `chat_continuation_control`;--> statement-breakpoint
ALTER TABLE `chat_automation_command` RENAME TO `chat_continuation_command`;--> statement-breakpoint
ALTER TABLE `chat_automation_abort` RENAME TO `chat_continuation_abort`;--> statement-breakpoint
CREATE TRIGGER `p6a_task_insert` AFTER INSERT ON task WHEN NEW.status='assigned' BEGIN
  INSERT OR IGNORE INTO chat_continuation_control(chat_id) VALUES(NEW.chat_id);
  INSERT OR IGNORE INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at)
    SELECT NEW.chat_id,NEW.project_id,NEW.updated_at+300000,coalesce((SELECT max(round) FROM wake_evaluation WHERE chat_id=NEW.chat_id),0),'',NEW.updated_at
    WHERE EXISTS(SELECT 1 FROM chat_continuation_control WHERE chat_id=NEW.chat_id AND mode='enabled')
      AND EXISTS(SELECT 1 FROM chat WHERE id=NEW.chat_id AND archived_at IS NULL);
END;--> statement-breakpoint
CREATE TRIGGER `p6a_task_update` AFTER UPDATE ON task BEGIN
  UPDATE continuation_delivery SET state='canceled',cancel_reason='task_context_changed',next_attempt_at=NULL
    WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state IN ('pending','bound') AND admitted_at IS NULL
      AND evaluation_id IN (SELECT id FROM wake_evaluation WHERE source='task_periodic');
  UPDATE continuation_delivery SET state='stale' WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state='presented'
      AND evaluation_id IN (SELECT id FROM wake_evaluation WHERE source='task_periodic');
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL
    WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state IN ('pending','claimed','retry_wait') AND source='task_periodic';
  DELETE FROM chat_schedule WHERE chat_id IN (OLD.chat_id,NEW.chat_id)
    AND NOT EXISTS(SELECT 1 FROM task WHERE task.chat_id=chat_schedule.chat_id AND task.status='assigned');
  INSERT OR IGNORE INTO chat_continuation_control(chat_id) SELECT NEW.chat_id WHERE NEW.status='assigned';
  INSERT OR IGNORE INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at)
    SELECT NEW.chat_id,NEW.project_id,NEW.updated_at+300000,coalesce((SELECT max(round) FROM wake_evaluation WHERE chat_id=NEW.chat_id),0),'',NEW.updated_at
    WHERE NEW.status='assigned' AND EXISTS(SELECT 1 FROM chat_continuation_control WHERE chat_id=NEW.chat_id AND mode='enabled')
      AND EXISTS(SELECT 1 FROM chat WHERE id=NEW.chat_id AND archived_at IS NULL);
  UPDATE chat_schedule SET next_due_at=coalesce(next_due_at,NEW.updated_at+300000),updated_at=NEW.updated_at WHERE chat_id IN (OLD.chat_id,NEW.chat_id);
END;--> statement-breakpoint
CREATE TRIGGER `p6a_control_disabled` AFTER UPDATE OF mode,epoch ON chat_continuation_control WHEN NEW.mode<>'enabled' BEGIN
  DELETE FROM chat_schedule WHERE chat_id=NEW.chat_id;
  UPDATE wake_evaluation SET state='canceled',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state='pending';
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('claimed','retry_wait');
  UPDATE continuation_delivery SET state='canceled',cancel_reason='human_disabled',next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id=NEW.chat_id AND state='presented';
END;--> statement-breakpoint
PRAGMA foreign_keys=ON;
