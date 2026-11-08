DROP TRIGGER task_finished_record;
--> statement-breakpoint
DROP TRIGGER message_task_append_guard;
--> statement-breakpoint
DROP TRIGGER message_task_no_update;
--> statement-breakpoint
DROP TRIGGER message_task_no_delete;
--> statement-breakpoint
DROP TRIGGER task_event_boundary;
--> statement-breakpoint
DROP TRIGGER agent_run_no_task_assistant;
--> statement-breakpoint
DROP TRIGGER agent_run_no_task_assistant_update;
--> statement-breakpoint
DROP TRIGGER task_input_admission_guard;
--> statement-breakpoint
DROP TRIGGER task_input_admission_guard_insert;
--> statement-breakpoint
CREATE TABLE `webhook_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`revision` integer NOT NULL,
	`instruction` text NOT NULL,
	`action` text NOT NULL,
	`secret_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_rule_revision_check" CHECK(typeof("webhook_rule"."revision")='integer' and "webhook_rule"."revision">=0),
	CONSTRAINT "webhook_rule_secret_check" CHECK(length("webhook_rule"."secret_digest")=64 and "webhook_rule"."secret_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "webhook_rule_action_check" CHECK(json_valid("webhook_rule"."action") and coalesce(json_extract("webhook_rule"."action", '$.kind') in ('dm_agent','group_agent','group_owner') and json_type("webhook_rule"."action", '$.chatId')='text' and (json_extract("webhook_rule"."action", '$.kind')='group_owner' or json_type("webhook_rule"."action", '$.agentProfileId')='text'),0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_rule_id_project_unique` ON `webhook_rule` (`id`,`project_id`);--> statement-breakpoint
CREATE TABLE `webhook_trigger` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`project_id` text NOT NULL,
	`mode` text NOT NULL,
	`event_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`snapshot` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`chat_id` text,
	`agent_profile_id` text,
	`message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_id`,`project_id`) REFERENCES `webhook_rule`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_trigger_mode_check" CHECK("webhook_trigger"."mode" in ('live','trial')),
	CONSTRAINT "webhook_trigger_decision_check" CHECK(("webhook_trigger"."decision"='accepted' and "webhook_trigger"."reason" is null and "webhook_trigger"."chat_id" is not null and "webhook_trigger"."agent_profile_id" is not null and "webhook_trigger"."message_id" is not null) or ("webhook_trigger"."decision"='skipped' and "webhook_trigger"."reason" is not null and length(trim("webhook_trigger"."reason"))>0 and "webhook_trigger"."message_id" is null and "webhook_trigger"."chat_id" is null and "webhook_trigger"."agent_profile_id" is null)),
	CONSTRAINT "webhook_trigger_snapshot_check" CHECK(json_valid("webhook_trigger"."snapshot"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_trigger_event_unique` ON `webhook_trigger` (`rule_id`,`mode`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_trigger_message_unique` ON `webhook_trigger` (`message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_trigger_source_unique` ON `webhook_trigger` (`id`,`message_id`,`chat_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_run_input` (
	`run_id` text NOT NULL,
	`message_id` text NOT NULL,
	`disposition` text DEFAULT 'pending' NOT NULL,
	`delivered_at` integer,
	`cancelled_at` integer,
	`admitted_at` integer,
	`cancel_reason` text,
	PRIMARY KEY(`run_id`, `message_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_input_disposition_check" CHECK((
      ("__new_agent_run_input"."disposition" = 'pending' and "__new_agent_run_input"."delivered_at" is null and "__new_agent_run_input"."cancelled_at" is null and "__new_agent_run_input"."cancel_reason" is null)
      or ("__new_agent_run_input"."disposition" = 'delivered' and "__new_agent_run_input"."delivered_at" is not null and "__new_agent_run_input"."cancelled_at" is null and "__new_agent_run_input"."cancel_reason" is null)
      or ("__new_agent_run_input"."disposition" = 'cancelled' and "__new_agent_run_input"."delivered_at" is null and "__new_agent_run_input"."cancelled_at" is not null and "__new_agent_run_input"."cancel_reason" is not null)
    )),
	CONSTRAINT "agent_run_input_cancel_reason_check" CHECK("__new_agent_run_input"."cancel_reason" is null or "__new_agent_run_input"."cancel_reason" in ('membership_revoked', 'human_stop', 'group_dissolved', 'task_context_changed', 'automation_context_changed')),
	CONSTRAINT "agent_run_input_admitted_at_check" CHECK("__new_agent_run_input"."admitted_at" is null or (typeof("__new_agent_run_input"."admitted_at")='integer' and "__new_agent_run_input"."admitted_at">=0))
);
--> statement-breakpoint
INSERT INTO `__new_agent_run_input`("run_id", "message_id", "disposition", "delivered_at", "cancelled_at", "admitted_at", "cancel_reason") SELECT "run_id", "message_id", "disposition", "delivered_at", "cancelled_at", "admitted_at", "cancel_reason" FROM `agent_run_input`;--> statement-breakpoint
DROP TABLE `agent_run_input`;--> statement-breakpoint
ALTER TABLE `__new_agent_run_input` RENAME TO `agent_run_input`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_run_input_message_idx` ON `agent_run_input` (`message_id`);--> statement-breakpoint
CREATE INDEX `agent_run_input_run_disposition_idx` ON `agent_run_input` (`run_id`,`disposition`);--> statement-breakpoint
CREATE TABLE `__new_message` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`sender_kind` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`automation_trigger_id` text,
	`task_id` text,
	`task_project_id` text,
	`task_record_seq` integer,
	`task_record_kind` text,
	`task_reference_message_id` text,
	`task_author_run_id` text,
	`task_assignment_revision` integer,
	`task_governance_revision` integer,
	`task_start_recipient_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_trigger_id`) REFERENCES `webhook_trigger`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_author_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`task_project_id`) REFERENCES `task`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`task_project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_reference_message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_trigger_id`,`id`,`chat_id`) REFERENCES `webhook_trigger`(`id`,`message_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_sender_kind_check" CHECK("__new_message"."sender_kind" in ('human', 'agent', 'automation')),
	CONSTRAINT "message_automation_shape_check" CHECK(("__new_message"."sender_kind"='automation' and "__new_message"."automation_trigger_id" is not null and "__new_message"."sender_id"="__new_message"."automation_trigger_id" and "__new_message"."task_id" is null) or ("__new_message"."sender_kind"<>'automation' and "__new_message"."automation_trigger_id" is null)),
	CONSTRAINT "message_task_shape_check" CHECK((
      ("__new_message"."task_id" is null and "__new_message"."task_project_id" is null and "__new_message"."task_record_seq" is null
        and "__new_message"."task_record_kind" is null and "__new_message"."task_reference_message_id" is null
        and "__new_message"."task_author_run_id" is null and "__new_message"."task_assignment_revision" is null
        and "__new_message"."task_governance_revision" is null and "__new_message"."task_start_recipient_id" is null)
      or ("__new_message"."task_id" is not null and "__new_message"."task_project_id" is not null
        and "__new_message"."task_record_seq" is not null and typeof("__new_message"."task_record_seq")='integer'
        and "__new_message"."task_record_seq" between 1 and 9007199254740991
        and "__new_message"."task_record_kind" is not null and "__new_message"."task_record_kind" in ('start','progress','correction')
        and length(trim("__new_message"."body")) between 1 and 8000
        and (("__new_message"."sender_kind"='human' and "__new_message"."task_author_run_id" is null)
          or ("__new_message"."sender_kind"='agent' and "__new_message"."task_author_run_id" is not null))
        and (("__new_message"."task_record_kind"='start' and "__new_message"."sender_kind"='human'
          and "__new_message"."task_reference_message_id" is null
          and typeof("__new_message"."task_assignment_revision")='integer' and "__new_message"."task_assignment_revision" between 0 and 9007199254740991
          and typeof("__new_message"."task_governance_revision")='integer' and "__new_message"."task_governance_revision" between 0 and 9007199254740991
          and "__new_message"."task_start_recipient_id" is not null and length(trim("__new_message"."task_start_recipient_id"))>0)
        or ("__new_message"."task_record_kind" in ('progress','correction') and "__new_message"."task_assignment_revision" is null
          and "__new_message"."task_governance_revision" is null and "__new_message"."task_start_recipient_id" is null)))
    ))
);
--> statement-breakpoint
INSERT INTO `__new_message`("id", "chat_id", "sender_kind", "sender_id", "body", "automation_trigger_id", "task_id", "task_project_id", "task_record_seq", "task_record_kind", "task_reference_message_id", "task_author_run_id", "task_assignment_revision", "task_governance_revision", "task_start_recipient_id", "created_at") SELECT "id", "chat_id", "sender_kind", "sender_id", "body", NULL, "task_id", "task_project_id", "task_record_seq", "task_record_kind", "task_reference_message_id", "task_author_run_id", "task_assignment_revision", "task_governance_revision", "task_start_recipient_id", "created_at" FROM `message`;--> statement-breakpoint
DROP TABLE `message`;--> statement-breakpoint
ALTER TABLE `__new_message` RENAME TO `message`;--> statement-breakpoint
CREATE INDEX `message_chat_created_at_idx` ON `message` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_id_chat_unique` ON `message` (`id`,`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_task_seq_unique` ON `message` (`task_id`,`task_record_seq`);
--> statement-breakpoint
CREATE TRIGGER task_finished_record BEFORE UPDATE ON task WHEN NEW.status='finished' AND NOT EXISTS (SELECT 1 FROM message WHERE task_id=NEW.id AND task_record_seq=(SELECT max(task_record_seq) FROM message WHERE task_id=NEW.id) AND task_record_kind IN ('progress','correction')) BEGIN SELECT RAISE(ABORT,'task_record_required'); END;
--> statement-breakpoint
CREATE TRIGGER message_task_append_guard BEFORE INSERT ON message WHEN NEW.task_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM task t WHERE t.id=NEW.task_id AND t.project_id=NEW.task_project_id AND t.chat_id=NEW.chat_id AND ((NEW.task_record_kind IN ('start','progress') AND t.status='assigned') OR (NEW.task_record_kind='correction' AND t.status='finished' AND NEW.sender_kind='human'))) OR NEW.task_record_seq<>(SELECT coalesce(max(task_record_seq),0)+1 FROM message WHERE task_id=NEW.task_id) OR (NEW.sender_kind='agent' AND NOT EXISTS (SELECT 1 FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id AND i.project_id=r.project_id AND i.chat_id=r.chat_id WHERE r.id=NEW.task_author_run_id AND r.status IN ('queued','running') AND r.project_id=NEW.task_project_id AND r.chat_id=NEW.chat_id AND i.agent_profile_id=NEW.sender_id))) BEGIN SELECT RAISE(ABORT,'task_record_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER message_task_no_update BEFORE UPDATE ON message WHEN OLD.task_id IS NOT NULL OR NEW.task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'task_record_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER message_task_no_delete BEFORE DELETE ON message WHEN OLD.task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'task_record_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER task_event_boundary BEFORE INSERT ON task_event WHEN NOT EXISTS (SELECT 1 FROM task t WHERE t.id=NEW.task_id AND t.project_id=NEW.project_id AND t.revision=NEW.seq AND t.status=NEW.to_status AND t.chat_id IS NEW.to_chat_id AND NEW.record_seq_at_event IS (SELECT max(task_record_seq) FROM message WHERE task_id=t.id)) BEGIN SELECT RAISE(ABORT,'task_event_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER agent_run_no_task_assistant BEFORE INSERT ON agent_run WHEN NEW.assistant_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM message WHERE id=NEW.assistant_message_id AND task_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'task_record_not_assistant'); END;
--> statement-breakpoint
CREATE TRIGGER agent_run_no_task_assistant_update BEFORE UPDATE OF assistant_message_id ON agent_run WHEN NEW.assistant_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM message WHERE id=NEW.assistant_message_id AND task_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'task_record_not_assistant'); END;
--> statement-breakpoint
CREATE TRIGGER task_input_admission_guard BEFORE UPDATE ON agent_run_input WHEN (OLD.admitted_at IS NOT NULL AND (NEW.admitted_at IS NOT OLD.admitted_at OR NEW.message_id<>OLD.message_id)) OR (NEW.admitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message WHERE id=NEW.message_id AND (task_record_kind='start' OR sender_kind='automation'))) BEGIN SELECT RAISE(ABORT,'task_input_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER task_input_admission_guard_insert BEFORE INSERT ON agent_run_input WHEN NEW.admitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message WHERE id=NEW.message_id AND (task_record_kind='start' OR sender_kind='automation')) BEGIN SELECT RAISE(ABORT,'task_input_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER webhook_trigger_no_update BEFORE UPDATE ON webhook_trigger BEGIN SELECT RAISE(ABORT,'webhook_trigger_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER webhook_trigger_no_delete BEFORE DELETE ON webhook_trigger BEGIN SELECT RAISE(ABORT,'webhook_trigger_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER message_automation_no_update BEFORE UPDATE ON message WHEN OLD.sender_kind='automation' OR NEW.sender_kind='automation' BEGIN SELECT RAISE(ABORT,'automation_message_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER message_automation_no_delete BEFORE DELETE ON message WHEN OLD.sender_kind='automation' BEGIN SELECT RAISE(ABORT,'automation_message_immutable'); END;