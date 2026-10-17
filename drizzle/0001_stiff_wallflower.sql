CREATE TABLE `agent_instance` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_profile_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agent_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_profile_conversation_unique` ON `agent_instance` (`agent_profile_id`,`conversation_id`);--> statement-breakpoint
CREATE TABLE `agent_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`persona` text DEFAULT '' NOT NULL,
	`harness` text DEFAULT 'pi' NOT NULL,
	`model` text,
	`effort` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`archived_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_kind_check" CHECK("conversation"."kind" in ('dm'))
);
--> statement-breakpoint
CREATE TABLE `conversation_member` (
	`conversation_id` text NOT NULL,
	`member_kind` text NOT NULL,
	`member_id` text NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`conversation_id`, `member_kind`, `member_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_member_kind_check" CHECK("conversation_member"."member_kind" in ('human', 'agent'))
);
--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_kind` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_sender_kind_check" CHECK("message"."sender_kind" in ('human', 'agent'))
);
--> statement-breakpoint
CREATE INDEX `message_conversation_created_at_idx` ON `message` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_member` (
	`project_id` text NOT NULL,
	`agent_profile_id` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`project_id`, `agent_profile_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_profile` (
	`project_id` text PRIMARY KEY NOT NULL,
	`git_remote` text,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`work_directory` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
