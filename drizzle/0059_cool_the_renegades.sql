CREATE TABLE `attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attachment_filename_check" CHECK(length(trim("attachment"."filename")) > 0),
	CONSTRAINT "attachment_mime_type_check" CHECK(length(trim("attachment"."mime_type")) > 0),
	CONSTRAINT "attachment_byte_size_check" CHECK(typeof("attachment"."byte_size") = 'integer' and "attachment"."byte_size" > 0)
);
--> statement-breakpoint
CREATE INDEX `attachment_message_idx` ON `attachment` (`chat_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `message_attachment` (
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	FOREIGN KEY (`message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_attachment_offsets_check" CHECK(typeof("message_attachment"."start") = 'integer' and typeof("message_attachment"."end") = 'integer'
      and "message_attachment"."start" >= 0 and "message_attachment"."end" > "message_attachment"."start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_attachment_position_unique` ON `message_attachment` (`chat_id`,`message_id`,`start`);--> statement-breakpoint
CREATE INDEX `message_attachment_message_idx` ON `message_attachment` (`chat_id`,`message_id`);