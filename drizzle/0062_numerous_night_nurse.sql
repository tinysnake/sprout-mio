CREATE TABLE `lease_grant` (
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
	FOREIGN KEY (`project_id`,`machine_id`,`generation`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`crew_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grantor_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grantee_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lease_grant_check_1" CHECK(state IN ('active','revoked')),
	CONSTRAINT "lease_grant_check_2" CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_generation_grantee_unique` ON `lease_grant` (`project_id`,`machine_id`,`generation`,`grantee_instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_grantor_request_unique` ON `lease_grant` (`grantor_instance_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_one_active_per_machine` ON `lease_grant` (`project_id`,`machine_id`) WHERE state = 'active';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lease_authorization` (
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`generation` integer NOT NULL,
	`holder_instance_id` text,
	`state` text NOT NULL,
	`issued_at` integer NOT NULL,
	`revoked_at` integer,
	`reason` text NOT NULL,
	PRIMARY KEY(`project_id`, `machine_id`, `generation`),
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `machine_lease`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lease_authorization_check_1" CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "lease_authorization_check_2" CHECK(state IN ('free','active','draining','escrowed','revoked')),
	CONSTRAINT "lease_authorization_check_3" CHECK(typeof(issued_at)='integer' AND issued_at>=0),
	CONSTRAINT "lease_authorization_check_4" CHECK(reason IN ('initial','acquire','release','handoff','reclaim','escrow','claim','escrow_cancel','grant','revoke_grant')),
	CONSTRAINT "lease_authorization_check_9" CHECK((state='free' AND holder_instance_id IS NULL AND revoked_at IS NULL) OR
        (state IN ('active','draining','escrowed') AND holder_instance_id IS NOT NULL AND revoked_at IS NULL) OR
        (state='revoked' AND revoked_at IS NOT NULL AND typeof(revoked_at)='integer' AND revoked_at>=issued_at)),
	CONSTRAINT "lease_authorization_check_10" CHECK(generation>0 OR holder_instance_id IS NULL)
);
--> statement-breakpoint
INSERT INTO `__new_lease_authorization`("project_id", "machine_id", "generation", "holder_instance_id", "state", "issued_at", "revoked_at", "reason") SELECT "project_id", "machine_id", "generation", "holder_instance_id", "state", "issued_at", "revoked_at", "reason" FROM `lease_authorization`;--> statement-breakpoint
DROP TABLE `lease_authorization`;--> statement-breakpoint
ALTER TABLE `__new_lease_authorization` RENAME TO `lease_authorization`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `lease_authorization_project_id_machine_id_generation_holder_instance_id_unique` ON `lease_authorization` (`project_id`,`machine_id`,`generation`,`holder_instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_one_live_authorization` ON `lease_authorization` (`project_id`,`machine_id`) WHERE state IN ('free','active','draining','escrowed');--> statement-breakpoint
CREATE TABLE `__new_lease_mutation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`action` text NOT NULL,
	`expected_generation` integer NOT NULL,
	`target_instance_id` text,
	`state` text NOT NULL,
	`completed_generation` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `machine_lease`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`machine_id`,`expected_generation`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`machine_id`,`completed_generation`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lease_mutation_check_1" CHECK(actor_kind IN ('agent','human')),
	CONSTRAINT "lease_mutation_check_2" CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "lease_mutation_check_3" CHECK(action IN ('acquire','release','handoff','reclaim','grant','revoke_grant')),
	CONSTRAINT "lease_mutation_check_4" CHECK(typeof(expected_generation)='integer' AND expected_generation BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "lease_mutation_check_5" CHECK(state IN ('pending','completed')),
	CONSTRAINT "lease_mutation_check_6" CHECK(typeof(created_at)='integer' AND created_at>=0),
	CONSTRAINT "lease_mutation_check_12" CHECK((action IN ('handoff','grant') AND target_instance_id IS NOT NULL) OR (action NOT IN ('handoff','grant') AND target_instance_id IS NULL)),
	CONSTRAINT "lease_mutation_check_13" CHECK((actor_kind='agent' AND action IN ('acquire','release','handoff','grant','revoke_grant')) OR (actor_kind='human' AND action='reclaim')),
	CONSTRAINT "lease_mutation_check_14" CHECK((state='pending' AND action!='acquire' AND completed_at IS NULL AND completed_generation IS NULL) OR
        (state='completed' AND completed_at IS NOT NULL AND typeof(completed_at)='integer' AND completed_at>=created_at
          AND completed_generation IS NOT NULL AND typeof(completed_generation)='integer'
          AND completed_generation BETWEEN expected_generation AND 9007199254740991)),
	CONSTRAINT "lease_mutation_check_15" CHECK(state='pending' OR completed_generation=expected_generation+1 OR
        (action='acquire' AND completed_generation=expected_generation))
);
--> statement-breakpoint
INSERT INTO `__new_lease_mutation`("id", "project_id", "machine_id", "actor_kind", "actor_id", "request_id", "payload_hash", "action", "expected_generation", "target_instance_id", "state", "completed_generation", "created_at", "completed_at") SELECT "id", "project_id", "machine_id", "actor_kind", "actor_id", "request_id", "payload_hash", "action", "expected_generation", "target_instance_id", "state", "completed_generation", "created_at", "completed_at" FROM `lease_mutation`;--> statement-breakpoint
DROP TABLE `lease_mutation`;--> statement-breakpoint
ALTER TABLE `__new_lease_mutation` RENAME TO `lease_mutation`;--> statement-breakpoint
CREATE UNIQUE INDEX `lease_mutation_actor_kind_actor_id_request_id_unique` ON `lease_mutation` (`actor_kind`,`actor_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_one_pending_mutation` ON `lease_mutation` (`project_id`,`machine_id`) WHERE state='pending';