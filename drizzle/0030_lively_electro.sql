CREATE TABLE `chat_message_wake` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`first_due_at` integer NOT NULL,
	`due_at` integer NOT NULL,
	`evaluation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_id`) REFERENCES `wake_evaluation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_message_wake_due_check" CHECK("chat_message_wake"."due_at">="chat_message_wake"."first_due_at")
);
--> statement-breakpoint
CREATE INDEX `chat_message_wake_due_idx` ON `chat_message_wake` (`due_at`);--> statement-breakpoint
DROP INDEX `continuation_pending_chat_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `continuation_pending_recipient_unique` ON `continuation_delivery` (`chat_id`,`recipient_kind`,`recipient_id`) WHERE "continuation_delivery"."state" in ('pending','bound');--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_control_disabled`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_chat_changed`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_wake_evaluation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`source` text DEFAULT 'task_periodic' NOT NULL,
	`trigger_message_id` text,
	`round` integer NOT NULL,
	`control_epoch` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`claim_token` text,
	`lease_until` integer,
	`next_attempt_at` integer,
	`input` text,
	`result` text,
	`error_code` text,
	`request_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`evaluated_at` integer,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wake_evaluation_state_check" CHECK("__new_wake_evaluation"."state" in ('pending','claimed','retry_wait','decided','attention','stale','canceled')),
	CONSTRAINT "wake_evaluation_source_check" CHECK(("__new_wake_evaluation"."source"='message') = ("__new_wake_evaluation"."trigger_message_id" is not null)),
	CONSTRAINT "wake_evaluation_attempt_check" CHECK("__new_wake_evaluation"."attempt" between 0 and 3 and "__new_wake_evaluation"."round">0 and "__new_wake_evaluation"."control_epoch">0),
	CONSTRAINT "wake_evaluation_claim_check" CHECK(("__new_wake_evaluation"."state"='claimed' and "__new_wake_evaluation"."claim_token" is not null and "__new_wake_evaluation"."lease_until" is not null) or ("__new_wake_evaluation"."state"<>'claimed' and "__new_wake_evaluation"."claim_token" is null and "__new_wake_evaluation"."lease_until" is null))
);
--> statement-breakpoint
INSERT INTO `__new_wake_evaluation`("id", "project_id", "chat_id", "source", "trigger_message_id", "round", "control_epoch", "fingerprint", "state", "attempt", "claim_token", "lease_until", "next_attempt_at", "input", "result", "error_code", "request_id", "created_at", "evaluated_at") SELECT "id", "project_id", "chat_id", "source", NULL, "round", "control_epoch", "fingerprint", "state", "attempt", "claim_token", "lease_until", "next_attempt_at", "input", "result", "error_code", "request_id", "created_at", "evaluated_at" FROM `wake_evaluation`;--> statement-breakpoint
DROP TABLE `wake_evaluation`;--> statement-breakpoint
ALTER TABLE `__new_wake_evaluation` RENAME TO `wake_evaluation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `wake_evaluation_scope_unique` ON `wake_evaluation` (`id`,`project_id`,`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wake_evaluation_project_unique` ON `wake_evaluation` (`id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wake_evaluation_round_unique` ON `wake_evaluation` (`chat_id`,`round`);--> statement-breakpoint
CREATE UNIQUE INDEX `wake_evaluation_active_unique` ON `wake_evaluation` (`chat_id`) WHERE "wake_evaluation"."state" in ('pending','claimed','retry_wait');--> statement-breakpoint
CREATE TRIGGER `p6a_task_insert` AFTER INSERT ON task WHEN NEW.status='assigned' BEGIN
  INSERT OR IGNORE INTO chat_automation_control(chat_id) VALUES(NEW.chat_id);
  INSERT OR IGNORE INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at)
    SELECT NEW.chat_id,NEW.project_id,NEW.updated_at+300000,coalesce((SELECT max(round) FROM wake_evaluation WHERE chat_id=NEW.chat_id),0),'',NEW.updated_at
    WHERE EXISTS(SELECT 1 FROM chat_automation_control WHERE chat_id=NEW.chat_id AND mode='enabled')
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
  INSERT OR IGNORE INTO chat_automation_control(chat_id) SELECT NEW.chat_id WHERE NEW.status='assigned';
  INSERT OR IGNORE INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at)
    SELECT NEW.chat_id,NEW.project_id,NEW.updated_at+300000,coalesce((SELECT max(round) FROM wake_evaluation WHERE chat_id=NEW.chat_id),0),'',NEW.updated_at
    WHERE NEW.status='assigned' AND EXISTS(SELECT 1 FROM chat_automation_control WHERE chat_id=NEW.chat_id AND mode='enabled')
      AND EXISTS(SELECT 1 FROM chat WHERE id=NEW.chat_id AND archived_at IS NULL);
  UPDATE chat_schedule SET next_due_at=coalesce(next_due_at,NEW.updated_at+300000),updated_at=NEW.updated_at WHERE chat_id IN (OLD.chat_id,NEW.chat_id);
END;--> statement-breakpoint
CREATE TRIGGER `p6a_control_disabled` AFTER UPDATE OF mode,epoch ON chat_automation_control WHEN NEW.mode<>'enabled' BEGIN
  DELETE FROM chat_schedule WHERE chat_id=NEW.chat_id;
  UPDATE wake_evaluation SET state='canceled',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state='pending';
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('claimed','retry_wait');
  UPDATE continuation_delivery SET state='canceled',cancel_reason='human_disabled',next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id=NEW.chat_id AND state='presented';
END;--> statement-breakpoint
CREATE TRIGGER `p6a_chat_changed` AFTER UPDATE OF owner_kind,owner_id,archived_at,wake_policy,governance_revision ON chat BEGIN
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.id AND state IN ('pending','claimed','retry_wait');
  UPDATE continuation_delivery SET state='canceled',cancel_reason=CASE WHEN NEW.archived_at IS NOT NULL THEN 'chat_archived' ELSE 'task_context_changed' END,next_attempt_at=NULL WHERE chat_id=NEW.id AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id=NEW.id AND state='presented';
  DELETE FROM chat_schedule WHERE chat_id=NEW.id AND NEW.archived_at IS NOT NULL;
END;--> statement-breakpoint
UPDATE `chat` SET `wake_policy`='contextual' WHERE `kind`='public_channel' AND `wake_policy`='owner_led';
