CREATE TABLE `feishu_connection_lease` (
	`app_id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`expires_at_ms` integer NOT NULL
);
