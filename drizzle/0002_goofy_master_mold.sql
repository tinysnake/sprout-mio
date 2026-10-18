CREATE TABLE `agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`conversation_id` text NOT NULL,
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
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_status_check" CHECK("agent_run"."status" in ('queued', 'running', 'completed', 'failed', 'aborted', 'interrupted')),
	CONSTRAINT "agent_run_timestamps_check" CHECK((
      ("agent_run"."status" = 'queued' and "agent_run"."started_at" is null and "agent_run"."settled_at" is null)
      or ("agent_run"."status" = 'running' and "agent_run"."started_at" is not null and "agent_run"."settled_at" is null)
      or ("agent_run"."status" in ('completed', 'failed', 'aborted', 'interrupted') and "agent_run"."settled_at" is not null)
    )),
	CONSTRAINT "agent_run_completed_check" CHECK("agent_run"."status" != 'completed' or (
      "agent_run"."assistant_message_id" is not null and "agent_run"."config_snapshot" is not null
      and "agent_run"."started_at" is not null and "agent_run"."stop_reason" is not null and "agent_run"."stop_reason" = 'stop'
      and "agent_run"."error_code" is null and "agent_run"."error_message" is null
    ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_one_active_instance` ON `agent_run` (`instance_id`) WHERE "agent_run"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `agent_run_conversation_queued_idx` ON `agent_run` (`conversation_id`,`queued_at`);--> statement-breakpoint
CREATE TABLE `agent_run_input` (
	`message_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`disposition` text DEFAULT 'pending' NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_input_disposition_check" CHECK((
      ("agent_run_input"."disposition" = 'pending' and "agent_run_input"."delivered_at" is null)
      or ("agent_run_input"."disposition" = 'delivered' and "agent_run_input"."delivered_at" is not null)
    ))
);
--> statement-breakpoint
CREATE INDEX `agent_run_input_run_idx` ON `agent_run_input` (`run_id`);