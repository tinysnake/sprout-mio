CREATE TABLE `lease_escrow` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`state` text NOT NULL,
	`chat_id` text NOT NULL,
	`target_agent_profile_id` text,
	`escrowed_by_instance_id` text NOT NULL,
	`escrowed_at` integer NOT NULL,
	`escrow_request_id` text NOT NULL,
	`escrow_payload_hash` text NOT NULL,
	`escrow_generation` integer NOT NULL,
	`claimed_by_instance_id` text,
	`claimed_at` integer,
	`claimed_generation` integer,
	`claim_request_id` text,
	`claim_payload_hash` text,
	`closed_at` integer,
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `machine_lease`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_agent_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`escrowed_by_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claimed_by_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lease_escrow_check_1" CHECK(state IN ('escrowed','claimed','cancelled','superseded')),
	CONSTRAINT "lease_escrow_check_2" CHECK(typeof(escrowed_at)='integer' AND escrowed_at>=0),
	CONSTRAINT "lease_escrow_check_3" CHECK(typeof(escrow_generation)='integer' AND escrow_generation BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "lease_escrow_check_4" CHECK(length(escrow_payload_hash)=64 AND escrow_payload_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "lease_escrow_check_5" CHECK((state='escrowed' AND claimed_by_instance_id IS NULL AND claimed_at IS NULL AND claimed_generation IS NULL AND claim_request_id IS NULL AND claim_payload_hash IS NULL AND closed_at IS NULL) OR
        (state<>'escrowed' AND closed_at IS NOT NULL AND typeof(closed_at)='integer' AND closed_at>=escrowed_at)),
	CONSTRAINT "lease_escrow_check_6" CHECK((state='claimed' AND claimed_by_instance_id IS NOT NULL AND typeof(claimed_generation)='integer' AND claimed_generation>escrow_generation) OR
        (state<>'claimed' AND claimed_by_instance_id IS NULL AND claimed_generation IS NULL)),
	CONSTRAINT "lease_escrow_check_7" CHECK((claimed_at IS NULL AND claim_request_id IS NULL AND claim_payload_hash IS NULL) OR
        (claimed_at IS NOT NULL AND typeof(claimed_at)='integer' AND claimed_at>=escrowed_at AND claim_request_id IS NOT NULL AND length(claim_payload_hash)=64 AND claim_payload_hash NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lease_escrow_id_project_unique` ON `lease_escrow` (`id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_one_live_escrow` ON `lease_escrow` (`project_id`,`machine_id`) WHERE state='escrowed';--> statement-breakpoint
CREATE UNIQUE INDEX `lease_escrow_escrow_request_unique` ON `lease_escrow` (`escrowed_by_instance_id`,`escrow_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_escrow_claim_request_unique` ON `lease_escrow` (`claimed_by_instance_id`,`claim_request_id`);--> statement-breakpoint
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
	CONSTRAINT "lease_authorization_check_4" CHECK(reason IN ('initial','acquire','release','handoff','reclaim','escrow','claim','escrow_cancel')),
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
CREATE UNIQUE INDEX `lease_one_live_authorization` ON `lease_authorization` (`project_id`,`machine_id`) WHERE state IN ('free','active','draining','escrowed');