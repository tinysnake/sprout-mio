CREATE TABLE `assistant_watch_summary` (
	`event_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`next_attempt_at` integer NOT NULL,
	`summary` text,
	`error` text,
	`model` text,
	`effort` text,
	FOREIGN KEY (`event_id`) REFERENCES `assistant_event`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_watch_summary_due_idx` ON `assistant_watch_summary` (`status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `assistant_event` ADD `decision_rejected_at` integer;