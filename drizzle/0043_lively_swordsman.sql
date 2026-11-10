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
	CONSTRAINT "agent_run_input_cancel_reason_check" CHECK("__new_agent_run_input"."cancel_reason" is null or "__new_agent_run_input"."cancel_reason" in ('membership_revoked', 'human_stop', 'group_dissolved', 'task_context_changed', 'automation_context_changed', 'assistant_context_changed')),
	CONSTRAINT "agent_run_input_admitted_at_check" CHECK("__new_agent_run_input"."admitted_at" is null or (typeof("__new_agent_run_input"."admitted_at")='integer' and "__new_agent_run_input"."admitted_at">=0))
);
--> statement-breakpoint
INSERT INTO `__new_agent_run_input`("run_id", "message_id", "disposition", "delivered_at", "cancelled_at", "admitted_at", "cancel_reason") SELECT "run_id", "message_id", "disposition", "delivered_at", "cancelled_at", "admitted_at", "cancel_reason" FROM `agent_run_input`;--> statement-breakpoint
DROP TABLE `agent_run_input`;--> statement-breakpoint
ALTER TABLE `__new_agent_run_input` RENAME TO `agent_run_input`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_run_input_message_idx` ON `agent_run_input` (`message_id`);--> statement-breakpoint
CREATE INDEX `agent_run_input_run_disposition_idx` ON `agent_run_input` (`run_id`,`disposition`);
--> statement-breakpoint
CREATE TRIGGER task_input_admission_guard BEFORE UPDATE ON agent_run_input WHEN (OLD.admitted_at IS NOT NULL AND (NEW.admitted_at IS NOT OLD.admitted_at OR NEW.message_id<>OLD.message_id)) OR (NEW.admitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message WHERE id=NEW.message_id AND (task_record_kind='start' OR sender_kind IN ('automation','assistant_work')))) BEGIN SELECT RAISE(ABORT,'task_input_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER task_input_admission_guard_insert BEFORE INSERT ON agent_run_input WHEN NEW.admitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message WHERE id=NEW.message_id AND (task_record_kind='start' OR sender_kind IN ('automation','assistant_work'))) BEGIN SELECT RAISE(ABORT,'task_input_invalid'); END;
