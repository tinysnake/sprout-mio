PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat` (
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
	CONSTRAINT "chat_kind_check" CHECK("__new_chat"."kind" in ('dm')),
	CONSTRAINT "chat_title_check" CHECK("__new_chat"."title" is null or length(trim("__new_chat"."title")) between 1 and 80)
);
--> statement-breakpoint
INSERT INTO `__new_chat`("id", "project_id", "kind", "title", "archived_at", "created_by", "created_at", "updated_at") SELECT "id", "project_id", "kind", "title", "archived_at", "created_by", "created_at", "updated_at" FROM `chat`;--> statement-breakpoint
DROP TABLE `chat`;--> statement-breakpoint
ALTER TABLE `__new_chat` RENAME TO `chat`;--> statement-breakpoint
PRAGMA foreign_keys=ON;