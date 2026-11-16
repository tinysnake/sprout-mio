PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`purpose` text DEFAULT 'worker' NOT NULL,
	`job_title` text,
	`description` text,
	`persona` text DEFAULT '' NOT NULL,
	`harness` text DEFAULT 'pi' NOT NULL,
	`model` text,
	`effort` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_profile_description_check" CHECK("__new_agent_profile"."description" IS NULL OR length("__new_agent_profile"."description") <= 500)
);
--> statement-breakpoint
INSERT INTO `__new_agent_profile`("id", "name", "purpose", "job_title", "description", "persona", "harness", "model", "effort", "created_by", "created_at", "updated_at") SELECT "id", "name", "purpose", "job_title", NULL, "persona", "harness", "model", "effort", "created_by", "created_at", "updated_at" FROM `agent_profile`;--> statement-breakpoint
DROP TABLE `agent_profile`;--> statement-breakpoint
ALTER TABLE `__new_agent_profile` RENAME TO `agent_profile`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profile_owner_name_unique` ON `agent_profile` (`created_by`,`name`);--> statement-breakpoint
CREATE TRIGGER agent_profile_purpose_immutable BEFORE UPDATE OF purpose ON agent_profile WHEN NEW.purpose != OLD.purpose BEGIN SELECT RAISE(ABORT, 'agent purpose is immutable'); END;
--> statement-breakpoint
CREATE TABLE `__new_project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`wake_policy` text,
	`kind` text DEFAULT 'custom' NOT NULL,
	`agent_prompt` text,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_kind_check" CHECK("__new_project"."kind" IN ('coding', 'work', 'custom')),
	CONSTRAINT "project_agent_prompt_check" CHECK("__new_project"."agent_prompt" IS NULL OR length("__new_project"."agent_prompt") <= 2000)
);
--> statement-breakpoint
INSERT INTO `__new_project`("id", "name", "wake_policy", "kind", "agent_prompt", "description", "created_by", "created_at", "updated_at") SELECT "id", "name", "wake_policy", 'custom', NULL, "description", "created_by", "created_at", "updated_at" FROM `project`;--> statement-breakpoint
DROP TABLE `project`;--> statement-breakpoint
ALTER TABLE `__new_project` RENAME TO `project`;--> statement-breakpoint
CREATE UNIQUE INDEX `project_id_owner_unique` ON `project` (`id`,`created_by`);