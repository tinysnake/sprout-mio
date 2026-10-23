CREATE TABLE `directory_observation` (
	`machine_id` text NOT NULL,
	`generation` integer NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`seq` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`kind` text NOT NULL,
	`real_path` text,
	`reason` text,
	PRIMARY KEY(`machine_id`, `generation`, `project_id`, `revision`),
	FOREIGN KEY (`machine_id`,`generation`) REFERENCES `machine_connection`(`machine_id`,`generation`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `project_machine`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "directory_observation_revision_check" CHECK(typeof("directory_observation"."revision") = 'integer' and "directory_observation"."revision" between 1 and 9007199254740991),
	CONSTRAINT "directory_observation_seq_check" CHECK(typeof("directory_observation"."seq") = 'integer' and "directory_observation"."seq" between 1 and 9007199254740991),
	CONSTRAINT "directory_observation_result_check" CHECK(("directory_observation"."kind" = 'accessible' and "directory_observation"."real_path" is not null and "directory_observation"."reason" is null and length("directory_observation"."real_path") between 1 and 4096 and substr("directory_observation"."real_path", 1, 1) = '/' and instr("directory_observation"."real_path", char(0)) = 0) or ("directory_observation"."kind" = 'unavailable' and "directory_observation"."real_path" is null and "directory_observation"."reason" is not null and "directory_observation"."reason" in ('missing', 'not_directory', 'denied', 'io_error')))
);
--> statement-breakpoint
CREATE TABLE `machine` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "machine_name_check" CHECK(length(trim("machine"."name")) between 1 and 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_id_owner_unique` ON `machine` (`id`,`created_by`);--> statement-breakpoint
CREATE TABLE `machine_connection` (
	`machine_id` text NOT NULL,
	`generation` integer NOT NULL,
	`attempt_id` text NOT NULL,
	`boot_id` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`closed_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	`capability` text,
	`last_payload_hash` text,
	PRIMARY KEY(`machine_id`, `generation`),
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`boot_id`) REFERENCES `runtime_boot`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "machine_generation_check" CHECK(typeof("machine_connection"."generation") = 'integer' and "machine_connection"."generation" between 1 and 9007199254740991),
	CONSTRAINT "machine_seq_check" CHECK(typeof("machine_connection"."seq") = 'integer' and "machine_connection"."seq" between 0 and 9007199254740991),
	CONSTRAINT "machine_attempt_check" CHECK(length("machine_connection"."attempt_id") > 0),
	CONSTRAINT "machine_connection_status_check" CHECK(("machine_connection"."status" = 'open' and "machine_connection"."closed_at" is null) or ("machine_connection"."status" = 'closed' and "machine_connection"."closed_at" is not null)),
	CONSTRAINT "machine_connection_payload_check" CHECK(("machine_connection"."seq" = 0 and "machine_connection"."capability" is null and "machine_connection"."last_payload_hash" is null) or ("machine_connection"."seq" > 0 and "machine_connection"."capability" is not null and "machine_connection"."last_payload_hash" is not null and length("machine_connection"."last_payload_hash") = 64 and "machine_connection"."last_payload_hash" not glob '*[^0-9a-f]*')),
	CONSTRAINT "machine_capability_json_check" CHECK(case when "machine_connection"."capability" is null then 1 when json_valid("machine_connection"."capability") then json_type("machine_connection"."capability") = 'object' else 0 end)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_connection_attempt_unique` ON `machine_connection` (`machine_id`,`attempt_id`);--> statement-breakpoint
CREATE TABLE `machine_connection_counter` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`high_water` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "machine_high_water_check" CHECK(typeof("machine_connection_counter"."high_water") = 'integer' and "machine_connection_counter"."high_water" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `machine_credential` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`ticket_hash` text NOT NULL,
	`ticket_expires_at` integer NOT NULL,
	`secret_hash` text,
	`activated_at` integer,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "machine_ticket_hash_check" CHECK(length("machine_credential"."ticket_hash") = 64 and "machine_credential"."ticket_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "machine_secret_hash_check" CHECK("machine_credential"."secret_hash" is null or (length("machine_credential"."secret_hash") = 64 and "machine_credential"."secret_hash" not glob '*[^0-9a-f]*')),
	CONSTRAINT "machine_activation_check" CHECK(("machine_credential"."secret_hash" is null and "machine_credential"."activated_at" is null) or ("machine_credential"."secret_hash" is not null and "machine_credential"."activated_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_ticket_hash_unique` ON `machine_credential` (`ticket_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_secret_hash_unique` ON `machine_credential` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `project_machine` (
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`created_by` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`directory` text,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `machine_id`),
	FOREIGN KEY (`project_id`,`created_by`) REFERENCES `project`(`id`,`created_by`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`,`created_by`) REFERENCES `machine`(`id`,`created_by`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_machine_revision_check" CHECK(typeof("project_machine"."revision") = 'integer' and "project_machine"."revision" between 1 and 9007199254740991),
	CONSTRAINT "project_machine_description_check" CHECK(length("project_machine"."description") <= 500),
	CONSTRAINT "project_machine_directory_check" CHECK("project_machine"."directory" is null or (length("project_machine"."directory") between 1 and 4096 and substr("project_machine"."directory", 1, 1) = '/' and instr("project_machine"."directory", char(0)) = 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_id_owner_unique` ON `project` (`id`,`created_by`);