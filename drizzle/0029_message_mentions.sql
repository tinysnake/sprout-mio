CREATE TABLE `message_mention` (
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`member_kind` text NOT NULL,
	`member_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	FOREIGN KEY (`message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_mention_member_kind_check" CHECK("message_mention"."member_kind" in ('human', 'agent')),
	CONSTRAINT "message_mention_member_id_check" CHECK(length(trim("message_mention"."member_id")) > 0),
	CONSTRAINT "message_mention_offsets_check" CHECK(typeof("message_mention"."start") = 'integer' and typeof("message_mention"."end") = 'integer'
      and "message_mention"."start" >= 0 and "message_mention"."end" > "message_mention"."start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_mention_position_unique` ON `message_mention` (`chat_id`,`message_id`,`start`);--> statement-breakpoint
CREATE INDEX `message_mention_message_idx` ON `message_mention` (`chat_id`,`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profile_name_unique` ON `agent_profile` (`name`);