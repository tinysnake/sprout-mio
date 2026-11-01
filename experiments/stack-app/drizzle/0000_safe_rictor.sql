CREATE TABLE `stack_probes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`component` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
