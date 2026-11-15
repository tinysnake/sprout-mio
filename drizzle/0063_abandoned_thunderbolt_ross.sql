PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lease_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`generation` integer NOT NULL,
	`crew_chat_id` text NOT NULL,
	`grantor_instance_id` text NOT NULL,
	`grantee_instance_id` text NOT NULL,
	`grantee_run_id` text NOT NULL,
	`state` text NOT NULL,
	`request_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`project_id`,`machine_id`,`generation`,`grantee_instance_id`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`,`holder_instance_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grantee_run_id`,`project_id`) REFERENCES `agent_run`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`crew_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grantor_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grantee_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lease_grant_check_1" CHECK(state IN ('active','revoked')),
	CONSTRAINT "lease_grant_check_2" CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL)),
	CONSTRAINT "lease_grant_check_3" CHECK(typeof(issued_at)='integer' AND issued_at>=0 AND (revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=issued_at)))
);
--> statement-breakpoint
INSERT INTO `__new_lease_grant`("id", "project_id", "machine_id", "generation", "crew_chat_id", "grantor_instance_id", "grantee_instance_id", "grantee_run_id", "state", "request_id", "issued_at", "revoked_at") SELECT "id", "project_id", "machine_id", "generation", "crew_chat_id", "grantor_instance_id", "grantee_instance_id", "grantee_run_id", "state", "request_id", "issued_at", "revoked_at" FROM `lease_grant`;--> statement-breakpoint
DROP TABLE `lease_grant`;--> statement-breakpoint
ALTER TABLE `__new_lease_grant` RENAME TO `lease_grant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_generation_grantee_unique` ON `lease_grant` (`project_id`,`machine_id`,`generation`,`grantee_instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_grantor_request_unique` ON `lease_grant` (`grantor_instance_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_one_active_per_machine` ON `lease_grant` (`project_id`,`machine_id`) WHERE state = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_id_project_unique` ON `agent_run` (`id`,`project_id`);