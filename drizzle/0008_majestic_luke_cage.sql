PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_machine` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_directory` text,
	`root_revision` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "machine_name_check" CHECK(length(trim("__new_machine"."name")) between 1 and 80),
	CONSTRAINT "machine_root_directory_check" CHECK("__new_machine"."root_directory" is null or (length("__new_machine"."root_directory") between 1 and 4096 and substr("__new_machine"."root_directory", 1, 1) = '/' and instr("__new_machine"."root_directory", char(0)) = 0)),
	CONSTRAINT "machine_root_revision_check" CHECK(typeof("__new_machine"."root_revision") = 'integer' and "__new_machine"."root_revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_machine`("id", "name", "root_directory", "root_revision", "created_by", "created_at", "updated_at") SELECT "id", "name", "root_directory", "root_revision", "created_by", "created_at", "updated_at" FROM `machine`;--> statement-breakpoint
DROP TABLE `machine`;--> statement-breakpoint
ALTER TABLE `__new_machine` RENAME TO `machine`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_id_owner_unique` ON `machine` (`id`,`created_by`);