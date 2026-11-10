CREATE TABLE `channel_action_grant` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`action` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `channel_delivery`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `channel_action_receipt` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`result` text NOT NULL,
	`consumed_at_ms` integer NOT NULL,
	FOREIGN KEY (`token_hash`) REFERENCES `channel_action_grant`(`token_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `channel_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`number` integer NOT NULL,
	`armed_at_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`code` text,
	`platform_message_id` text,
	FOREIGN KEY (`delivery_id`) REFERENCES `channel_delivery`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channel_attempt_outcome" CHECK("channel_attempt"."outcome" IN ('armed','accepted','not_accepted','suppressed','uncertain'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_attempt_number_unique` ON `channel_attempt` (`delivery_id`,`number`);--> statement-breakpoint
CREATE TABLE `channel_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter` text NOT NULL,
	`message_id` text NOT NULL,
	`route` text NOT NULL,
	`envelope` text NOT NULL,
	`state` text NOT NULL,
	`uuid` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`due_at_ms` integer NOT NULL,
	`deadline_ms` integer NOT NULL,
	`platform_message_id` text,
	`error` text,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channel_delivery_state" CHECK("channel_delivery"."state" IN ('ready','armed','accepted','suppressed','failed','uncertain')),
	CONSTRAINT "channel_delivery_attempts" CHECK("channel_delivery"."attempts" >= 0 AND "channel_delivery"."attempts" <= 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_delivery_source_unique` ON `channel_delivery` (`adapter`,`message_id`);--> statement-breakpoint
CREATE INDEX `channel_delivery_due_idx` ON `channel_delivery` (`adapter`,`state`,`due_at_ms`);