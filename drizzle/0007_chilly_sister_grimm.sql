PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_machine` (
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`created_by` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `machine_id`),
	FOREIGN KEY (`project_id`,`created_by`) REFERENCES `project`(`id`,`created_by`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`,`created_by`) REFERENCES `machine`(`id`,`created_by`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_machine_revision_check" CHECK(typeof("__new_project_machine"."revision") = 'integer' and "__new_project_machine"."revision" between 1 and 9007199254740991),
	CONSTRAINT "project_machine_description_check" CHECK(length("__new_project_machine"."description") <= 500)
);
--> statement-breakpoint
INSERT INTO `__new_project_machine`("project_id", "machine_id", "created_by", "description", "revision", "created_at", "updated_at") SELECT "project_id", "machine_id", "created_by", "description", "revision", "created_at", "updated_at" FROM `project_machine`;--> statement-breakpoint
DROP TABLE `project_machine`;--> statement-breakpoint
ALTER TABLE `__new_project_machine` RENAME TO `project_machine`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `machine` ADD `root_directory` text;--> statement-breakpoint
ALTER TABLE `machine` ADD `root_revision` integer DEFAULT 1 NOT NULL;