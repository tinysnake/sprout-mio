CREATE TABLE `message_skill` (
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`name` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	FOREIGN KEY (`message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_skill_name_check" CHECK(length(trim("message_skill"."name")) > 0),
	CONSTRAINT "message_skill_offsets_check" CHECK(typeof("message_skill"."start") = 'integer' and typeof("message_skill"."end") = 'integer' and "message_skill"."start" >= 0 and "message_skill"."end" > "message_skill"."start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_skill_position_unique` ON `message_skill` (`chat_id`,`message_id`,`start`);