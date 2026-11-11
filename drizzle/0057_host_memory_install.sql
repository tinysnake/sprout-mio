PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_install` (
	`component` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "memory_install_status_check" CHECK("__new_memory_install"."status" in ('missing','installing','ready','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_memory_install`("component", "version", "status", "error", "updated_at_ms") SELECT "component", "version", "status", "error", "updated_at_ms" FROM `memory_install` WHERE "rowid" = (SELECT "m2"."rowid" FROM `memory_install` AS "m2" WHERE "m2"."component" = `memory_install`.`component` ORDER BY "m2"."updated_at_ms" DESC, "m2"."rowid" DESC LIMIT 1);--> statement-breakpoint
DROP TABLE `memory_install`;--> statement-breakpoint
ALTER TABLE `__new_memory_install` RENAME TO `memory_install`;--> statement-breakpoint
PRAGMA foreign_keys=ON;