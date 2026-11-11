CREATE TABLE `memory_config` (
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`secrets` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`updated_by_human_id` text,
	PRIMARY KEY(`project_id`, `provider`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_human_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_config_enabled_check" CHECK("memory_config"."enabled" in (0,1)),
	CONSTRAINT "memory_config_revision_check" CHECK("memory_config"."revision" >= 0),
	CONSTRAINT "memory_config_settings_json_check" CHECK(json_valid("memory_config"."settings")),
	CONSTRAINT "memory_config_secrets_json_check" CHECK(json_valid("memory_config"."secrets"))
);
--> statement-breakpoint
CREATE TABLE `memory_install` (
	`machine_id` text NOT NULL,
	`component` text NOT NULL,
	`version` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `component`),
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_install_status_check" CHECK("memory_install"."status" in ('missing','installing','ready','failed'))
);
