CREATE TABLE `agent_instance` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_instance_profile_conversation` ON `agent_instance` (`profile_id`,`conversation_id`);--> statement-breakpoint
CREATE TABLE `agent_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`persona` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_agent_run_status" CHECK("agent_run"."status" in ('active','completed','failed','canceled')),
	CONSTRAINT "ck_agent_run_ended_at" CHECK(("agent_run"."status" = 'active') = ("agent_run"."ended_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_run_active_instance` ON `agent_run` (`instance_id`) WHERE "agent_run"."status" = 'active';--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `machine_lease` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`holder_instance_id` text NOT NULL,
	`generation` integer NOT NULL,
	`state` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`holder_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_machine_lease_state" CHECK("machine_lease"."state" in ('active','released','revoked')),
	CONSTRAINT "ck_machine_lease_ended_at" CHECK(("machine_lease"."state" = 'active') = ("machine_lease"."ended_at" is null)),
	CONSTRAINT "ck_machine_lease_generation" CHECK("machine_lease"."generation" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_machine_lease_active_project_machine` ON `machine_lease` (`project_id`,`machine_id`) WHERE "machine_lease"."state" = 'active';--> statement-breakpoint
CREATE INDEX `ix_machine_lease_holder` ON `machine_lease` (`holder_instance_id`);--> statement-breakpoint
CREATE TABLE `remote_execution` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_remote_execution_state" CHECK("remote_execution"."state" in ('running','exited','unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_remote_execution_machine_request` ON `remote_execution` (`machine_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `ix_remote_execution_project` ON `remote_execution` (`project_id`);--> statement-breakpoint
CREATE TABLE `wake_request` (
	`id` text PRIMARY KEY NOT NULL,
	`target_instance_id` text NOT NULL,
	`source` text NOT NULL,
	`dedup_key` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`enqueued_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`target_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_wake_request_target_dedup` ON `wake_request` (`target_instance_id`,`dedup_key`);--> statement-breakpoint
CREATE INDEX `ix_wake_request_pending` ON `wake_request` (`target_instance_id`,`processed_at`);