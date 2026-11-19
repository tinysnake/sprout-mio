CREATE TABLE `chat_read_marker` (
	`chat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`chat_id`, `user_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE no action
);
