CREATE TABLE `chat_automation_abort` (
	`run_id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`signaled_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_automation_command` (
	`request_id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`payload` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_automation_control` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'enabled' NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`changed_by` text,
	`changed_at` integer,
	`reason` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "automation_mode_check" CHECK("chat_automation_control"."mode" in ('enabled','paused','stopped')),
	CONSTRAINT "automation_revision_check" CHECK("chat_automation_control"."epoch" between 1 and 9007199254740991 and "chat_automation_control"."revision" between 1 and 9007199254740991),
	CONSTRAINT "automation_audit_check" CHECK(("chat_automation_control"."changed_by" is null) = ("chat_automation_control"."changed_at" is null))
);
--> statement-breakpoint
CREATE TABLE `chat_schedule` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`next_due_at` integer,
	`round` integer DEFAULT 0 NOT NULL,
	`fingerprint` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_schedule_round_check" CHECK("chat_schedule"."round" >= 0)
);
--> statement-breakpoint
CREATE INDEX `chat_schedule_due_idx` ON `chat_schedule` (`next_due_at`);--> statement-breakpoint
CREATE TABLE `continuation_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`recipient_kind` text NOT NULL,
	`recipient_id` text NOT NULL,
	`instance_id` text,
	`run_id` text,
	`control_epoch` integer NOT NULL,
	`snapshot_hash` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`envelope` text,
	`created_at` integer NOT NULL,
	`admitted_at` integer,
	`delivered_at` integer,
	`presented_at` integer,
	`next_attempt_at` integer,
	`cancel_reason` text,
	`error_code` text,
	`supersedes_delivery_id` text,
	FOREIGN KEY (`instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_id`,`project_id`,`chat_id`) REFERENCES `wake_evaluation`(`id`,`project_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`instance_id`,`project_id`,`chat_id`) REFERENCES `agent_run`(`id`,`instance_id`,`project_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "continuation_supersedes_check" CHECK("continuation_delivery"."supersedes_delivery_id" is null or "continuation_delivery"."supersedes_delivery_id"<>"continuation_delivery"."id"),
	CONSTRAINT "continuation_state_check" CHECK("continuation_delivery"."state" in ('pending','bound','admitted','delivered','attention','canceled','presented','stale')),
	CONSTRAINT "continuation_attempt_check" CHECK("continuation_delivery"."attempt" between 0 and 3 and "continuation_delivery"."control_epoch">0),
	CONSTRAINT "continuation_recipient_check" CHECK(("continuation_delivery"."recipient_kind"='human' and "continuation_delivery"."instance_id" is null and "continuation_delivery"."run_id" is null and "continuation_delivery"."admitted_at" is null and "continuation_delivery"."delivered_at" is null and "continuation_delivery"."state" in ('presented','stale','canceled')) or ("continuation_delivery"."recipient_kind"='agent' and "continuation_delivery"."instance_id" is not null and "continuation_delivery"."presented_at" is null and "continuation_delivery"."state"<>'presented')),
	CONSTRAINT "continuation_admission_check" CHECK(("continuation_delivery"."state" not in ('bound','admitted','delivered') or "continuation_delivery"."run_id" is not null) and ("continuation_delivery"."admitted_at" is null or ("continuation_delivery"."run_id" is not null and "continuation_delivery"."attempt">0 and "continuation_delivery"."state" in ('admitted','delivered','attention'))) and ("continuation_delivery"."state" not in ('admitted','delivered') or "continuation_delivery"."admitted_at" is not null)),
	CONSTRAINT "continuation_ack_check" CHECK(("continuation_delivery"."state"='delivered') = ("continuation_delivery"."delivered_at" is not null) and ("continuation_delivery"."delivered_at" is null or "continuation_delivery"."delivered_at">="continuation_delivery"."admitted_at")),
	CONSTRAINT "continuation_cancel_check" CHECK(("continuation_delivery"."state"='canceled') = ("continuation_delivery"."cancel_reason" is not null)),
	CONSTRAINT "continuation_retry_check" CHECK("continuation_delivery"."next_attempt_at" is null or ("continuation_delivery"."state"='pending' and "continuation_delivery"."admitted_at" is null and "continuation_delivery"."attempt"<3)),
	CONSTRAINT "continuation_unknown_check" CHECK("continuation_delivery"."error_code" is null or "continuation_delivery"."error_code"<>'delivery_unknown' or ("continuation_delivery"."state"='attention' and "continuation_delivery"."admitted_at" is not null and "continuation_delivery"."next_attempt_at" is null and "continuation_delivery"."delivered_at" is null)),
	CONSTRAINT "continuation_attention_check" CHECK("continuation_delivery"."state"<>'attention' or "continuation_delivery"."error_code" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `continuation_scope_unique` ON `continuation_delivery` (`id`,`project_id`,`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `continuation_project_unique` ON `continuation_delivery` (`id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `continuation_evaluation_recipient_unique` ON `continuation_delivery` (`evaluation_id`,`recipient_kind`,`recipient_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `continuation_pending_chat_unique` ON `continuation_delivery` (`chat_id`) WHERE "continuation_delivery"."state" in ('pending','bound');--> statement-breakpoint
CREATE TABLE `continuation_delivery_task` (
	`delivery_id` text NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`delivery_id`, `task_id`),
	FOREIGN KEY (`delivery_id`) REFERENCES `continuation_delivery`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivery_id`,`project_id`) REFERENCES `continuation_delivery`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`project_id`) REFERENCES `task`(`id`,`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_wake_policy_command` (
	`request_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`payload` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wake_evaluation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`source` text DEFAULT 'task_periodic' NOT NULL,
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
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wake_evaluation_state_check" CHECK("wake_evaluation"."state" in ('pending','claimed','retry_wait','decided','attention','stale','canceled')),
	CONSTRAINT "wake_evaluation_attempt_check" CHECK("wake_evaluation"."attempt" between 0 and 3 and "wake_evaluation"."round">0 and "wake_evaluation"."control_epoch">0),
	CONSTRAINT "wake_evaluation_claim_check" CHECK(("wake_evaluation"."state"='claimed' and "wake_evaluation"."claim_token" is not null and "wake_evaluation"."lease_until" is not null) or ("wake_evaluation"."state"<>'claimed' and "wake_evaluation"."claim_token" is null and "wake_evaluation"."lease_until" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wake_evaluation_scope_unique` ON `wake_evaluation` (`id`,`project_id`,`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wake_evaluation_project_unique` ON `wake_evaluation` (`id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wake_evaluation_round_unique` ON `wake_evaluation` (`chat_id`,`round`);--> statement-breakpoint
CREATE UNIQUE INDEX `wake_evaluation_active_unique` ON `wake_evaluation` (`chat_id`) WHERE "wake_evaluation"."state" in ('pending','claimed','retry_wait');--> statement-breakpoint
CREATE TABLE `wake_evaluation_task` (
	`evaluation_id` text NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`assignment_revision` integer NOT NULL,
	PRIMARY KEY(`evaluation_id`, `task_id`),
	FOREIGN KEY (`evaluation_id`) REFERENCES `wake_evaluation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`project_id`) REFERENCES `task`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_id`,`project_id`) REFERENCES `wake_evaluation`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wake_evaluation_task_revision_check" CHECK("wake_evaluation_task"."revision">0 and "wake_evaluation_task"."assignment_revision">0)
);
--> statement-breakpoint
ALTER TABLE `project` ADD `wake_policy` text;
--> statement-breakpoint
-- Task mutation and schedule membership commit together. Times use Task's injected timestamp_ms.
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
CREATE TRIGGER p6a_task_delete AFTER DELETE ON task BEGIN
  DELETE FROM chat_schedule WHERE chat_id=OLD.chat_id AND NOT EXISTS(SELECT 1 FROM task WHERE chat_id=OLD.chat_id AND status='assigned');
END;
--> statement-breakpoint
CREATE TRIGGER p6a_control_disabled AFTER UPDATE OF mode,epoch ON chat_automation_control WHEN NEW.mode<>'enabled' BEGIN
  DELETE FROM chat_schedule WHERE chat_id=NEW.chat_id;
  UPDATE wake_evaluation SET state='canceled',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state='pending';
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('claimed','retry_wait');
  UPDATE continuation_delivery SET state='canceled',cancel_reason=CASE NEW.mode WHEN 'paused' THEN 'human_paused' ELSE 'human_stopped' END,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id=NEW.chat_id AND state='presented';
END;
--> statement-breakpoint
CREATE TRIGGER p6a_chat_changed AFTER UPDATE OF owner_kind,owner_id,archived_at,wake_policy,governance_revision ON chat BEGIN
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.id AND state IN ('pending','claimed','retry_wait');
  UPDATE continuation_delivery SET state='canceled',cancel_reason=CASE WHEN NEW.archived_at IS NOT NULL THEN 'chat_archived' ELSE 'task_context_changed' END,next_attempt_at=NULL WHERE chat_id=NEW.id AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id=NEW.id AND state='presented';
  DELETE FROM chat_schedule WHERE chat_id=NEW.id AND NEW.archived_at IS NOT NULL;
END;