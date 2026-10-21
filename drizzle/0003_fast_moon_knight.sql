PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`project_id` text NOT NULL,
	`request_id` text NOT NULL,
	`status` text NOT NULL,
	`queued_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`settled_at` integer,
	`stop_reason` text,
	`error_code` text,
	`error_message` text,
	`session_id` text NOT NULL,
	`config_snapshot` text,
	`assistant_message_id` text,
	FOREIGN KEY (`instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_status_check" CHECK("__new_agent_run"."status" in ('queued', 'running', 'completed', 'failed', 'aborted', 'interrupted')),
	CONSTRAINT "agent_run_timestamps_check" CHECK((
      ("__new_agent_run"."status" = 'queued' and "__new_agent_run"."started_at" is null and "__new_agent_run"."settled_at" is null)
      or ("__new_agent_run"."status" = 'running' and "__new_agent_run"."started_at" is not null and "__new_agent_run"."settled_at" is null)
      or ("__new_agent_run"."status" in ('completed', 'failed', 'aborted', 'interrupted') and "__new_agent_run"."settled_at" is not null)
    )),
	CONSTRAINT "agent_run_completed_check" CHECK("__new_agent_run"."status" != 'completed' or (
      "__new_agent_run"."assistant_message_id" is not null and "__new_agent_run"."config_snapshot" is not null
      and "__new_agent_run"."started_at" is not null and "__new_agent_run"."stop_reason" is not null and "__new_agent_run"."stop_reason" = 'stop'
      and "__new_agent_run"."error_code" is null and "__new_agent_run"."error_message" is null
    )),
	CONSTRAINT "agent_run_failed_check" CHECK("__new_agent_run"."status" != 'failed' or (
      "__new_agent_run"."error_code" is not null and "__new_agent_run"."error_message" is not null and "__new_agent_run"."error_message" != ''
    ))
);
--> statement-breakpoint
INSERT INTO `__new_agent_run`("id", "instance_id", "chat_id", "project_id", "request_id", "status", "queued_at", "started_at", "settled_at", "stop_reason", "error_code", "error_message", "session_id", "config_snapshot", "assistant_message_id") SELECT "id", "instance_id", "chat_id", "project_id", "request_id", "status", "queued_at", "started_at", "settled_at", "stop_reason", "error_code", "error_message", "session_id", "config_snapshot", "assistant_message_id" FROM `agent_run`;--> statement-breakpoint
DROP TABLE `agent_run`;--> statement-breakpoint
ALTER TABLE `__new_agent_run` RENAME TO `agent_run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_one_active_instance` ON `agent_run` (`instance_id`) WHERE "agent_run"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `agent_run_chat_queued_idx` ON `agent_run` (`chat_id`,`queued_at`);