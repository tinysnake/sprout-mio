CREATE TABLE `crew_resource_event` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`audience` text NOT NULL,
	`crew_epoch` integer NOT NULL,
	`state` text NOT NULL,
	`payload_json` text NOT NULL,
	`message_id` text,
	`bound_run_id` text,
	`attention_reason` text,
	FOREIGN KEY (`request_id`) REFERENCES `crew_resource_request`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bound_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "crew_resource_event_state_check" CHECK(state IN ('pending','bound','acked','attention') AND audience IN ('worker','lead','human'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crew_resource_event_delivery_unique` ON `crew_resource_event` (`request_id`,`revision`,`kind`,`audience`);--> statement-breakpoint
CREATE TABLE `crew_resource_request` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`crew_chat_id` text NOT NULL,
	`crew_epoch` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`subject_kind` text NOT NULL,
	`delegation_id` text,
	`attempt` integer,
	`run_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`membership_epoch` integer NOT NULL,
	`directory_real_path` text NOT NULL,
	`directory_revision` integer NOT NULL,
	`operations_json` text NOT NULL,
	`client_request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`approval` text NOT NULL,
	`approved_by_profile_id` text,
	`approved_by_instance_id` text,
	`state` text NOT NULL,
	`mutation_id` text,
	`grant_id` text,
	`generation` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`released_at` integer,
	`reason` text,
	FOREIGN KEY (`delegation_id`) REFERENCES `delegation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mutation_id`) REFERENCES `lease_mutation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grant_id`) REFERENCES `lease_grant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`crew_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`instance_id`,`project_id`,`chat_id`) REFERENCES `agent_run`(`id`,`instance_id`,`project_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`machine_id`,`membership_epoch`) REFERENCES `project_machine_membership`(`project_id`,`machine_id`,`epoch`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "crew_resource_subject_check" CHECK((subject_kind='delegation' AND delegation_id IS NOT NULL AND attempt IS NOT NULL AND attempt>=1) OR (subject_kind='lead_run' AND delegation_id IS NULL AND attempt IS NULL)),
	CONSTRAINT "crew_resource_state_check" CHECK(state IN ('queued','allocated','active','releasing','released','held','attention') AND approval IN ('pending','approved','revoked') AND crew_epoch>=0 AND revision>=0),
	CONSTRAINT "crew_resource_active_check" CHECK(state!='active' OR (grant_id IS NOT NULL AND generation IS NOT NULL AND approval='approved')),
	CONSTRAINT "crew_resource_released_check" CHECK(state!='released' OR released_at IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crew_resource_client_unique` ON `crew_resource_request` (`crew_chat_id`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `crew_resource_subject_machine_unique` ON `crew_resource_request` (`run_id`,`machine_id`) WHERE state != 'released';--> statement-breakpoint
CREATE UNIQUE INDEX `crew_resource_machine_slot` ON `crew_resource_request` (`project_id`,`machine_id`) WHERE state IN ('allocated','active','releasing','held');--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_machine_lease` (
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`generation` integer NOT NULL,
	`state` text NOT NULL,
	`holder_instance_id` text,
	`owner_kind` text,
	`holder_crew_chat_id` text,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `machine_id`),
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `project_machine`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_crew_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "machine_lease_check_1" CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "machine_lease_check_2" CHECK(state IN ('free','held','fencing')),
	CONSTRAINT "machine_lease_check_3" CHECK(typeof(changed_at)='integer' AND changed_at>=0),
	CONSTRAINT "machine_lease_check_7" CHECK((state='free' AND holder_instance_id IS NULL AND owner_kind IS NULL AND holder_crew_chat_id IS NULL) OR
        (state IN ('held','fencing') AND owner_kind IS NOT NULL AND ((owner_kind='instance' AND holder_instance_id IS NOT NULL AND holder_crew_chat_id IS NULL) OR (owner_kind='crew' AND holder_instance_id IS NULL AND holder_crew_chat_id IS NOT NULL)))),
	CONSTRAINT "machine_lease_check_8" CHECK(state='free' OR generation>0)
);
--> statement-breakpoint
INSERT INTO `__new_machine_lease`("project_id", "machine_id", "generation", "state", "holder_instance_id", "owner_kind", "holder_crew_chat_id", "changed_at") SELECT "project_id", "machine_id", "generation", "state", "holder_instance_id", CASE WHEN "holder_instance_id" IS NULL THEN NULL ELSE 'instance' END, NULL, "changed_at" FROM `machine_lease`;--> statement-breakpoint
DROP TABLE `machine_lease`;--> statement-breakpoint
ALTER TABLE `__new_machine_lease` RENAME TO `machine_lease`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_lease_authorization` (
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`generation` integer NOT NULL,
	`holder_instance_id` text,
	`owner_kind` text,
	`owner_crew_chat_id` text,
	`state` text NOT NULL,
	`issued_at` integer NOT NULL,
	`revoked_at` integer,
	`reason` text NOT NULL,
	PRIMARY KEY(`project_id`, `machine_id`, `generation`),
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `machine_lease`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_crew_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lease_authorization_check_1" CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "lease_authorization_check_2" CHECK(state IN ('free','active','draining','escrowed','revoked')),
	CONSTRAINT "lease_authorization_check_3" CHECK(typeof(issued_at)='integer' AND issued_at>=0),
	CONSTRAINT "lease_authorization_check_4" CHECK(reason IN ('initial','acquire','release','handoff','reclaim','escrow','claim','escrow_cancel','grant','revoke_grant')),
	CONSTRAINT "lease_authorization_check_9" CHECK((state='free' AND holder_instance_id IS NULL AND revoked_at IS NULL) OR
        (state IN ('active','draining','escrowed') AND holder_instance_id IS NOT NULL AND revoked_at IS NULL) OR
        (state='revoked' AND revoked_at IS NOT NULL AND typeof(revoked_at)='integer' AND revoked_at>=issued_at)),
	CONSTRAINT "lease_authorization_check_10" CHECK(generation>0 OR holder_instance_id IS NULL),
	CONSTRAINT "lease_authorization_owner_check" CHECK((owner_kind IS NULL AND owner_crew_chat_id IS NULL AND holder_instance_id IS NULL) OR (owner_kind IS NOT NULL AND owner_kind='instance' AND owner_crew_chat_id IS NULL AND holder_instance_id IS NOT NULL) OR (owner_kind IS NOT NULL AND owner_kind='crew' AND owner_crew_chat_id IS NOT NULL AND holder_instance_id IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_lease_authorization`("project_id", "machine_id", "generation", "holder_instance_id", "owner_kind", "owner_crew_chat_id", "state", "issued_at", "revoked_at", "reason") SELECT "project_id", "machine_id", "generation", "holder_instance_id", CASE WHEN "holder_instance_id" IS NULL THEN NULL ELSE 'instance' END, NULL, "state", "issued_at", "revoked_at", "reason" FROM `lease_authorization`;--> statement-breakpoint
DROP TABLE `lease_authorization`;--> statement-breakpoint
ALTER TABLE `__new_lease_authorization` RENAME TO `lease_authorization`;--> statement-breakpoint
CREATE UNIQUE INDEX `lease_authorization_project_id_machine_id_generation_holder_instance_id_unique` ON `lease_authorization` (`project_id`,`machine_id`,`generation`,`holder_instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_one_live_authorization` ON `lease_authorization` (`project_id`,`machine_id`) WHERE state IN ('free','active','draining','escrowed');--> statement-breakpoint
CREATE TABLE `__new_lease_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`generation` integer NOT NULL,
	`crew_chat_id` text NOT NULL,
	`crew_epoch` integer NOT NULL,
	`subject_kind` text NOT NULL,
	`delegation_id` text,
	`attempt` integer,
	`expires_at` integer NOT NULL,
	`grantor_instance_id` text NOT NULL,
	`grantee_instance_id` text NOT NULL,
	`grantee_run_id` text NOT NULL,
	`state` text NOT NULL,
	`request_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`delegation_id`) REFERENCES `delegation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`machine_id`,`generation`,`grantee_instance_id`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`,`holder_instance_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grantee_run_id`,`project_id`) REFERENCES `agent_run`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`crew_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grantor_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grantee_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lease_grant_check_1" CHECK(state IN ('active','revoked')),
	CONSTRAINT "lease_grant_subject_check" CHECK(crew_epoch>=0 AND expires_at>issued_at AND ((subject_kind='delegation' AND delegation_id IS NOT NULL AND attempt IS NOT NULL AND attempt>=1) OR (subject_kind='lead_run' AND delegation_id IS NULL AND attempt IS NULL))),
	CONSTRAINT "lease_grant_check_2" CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL)),
	CONSTRAINT "lease_grant_check_3" CHECK(typeof(issued_at)='integer' AND issued_at>=0 AND (revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=issued_at)))
);
--> statement-breakpoint
INSERT INTO `__new_lease_grant`("id", "project_id", "machine_id", "generation", "crew_chat_id", "crew_epoch", "subject_kind", "delegation_id", "attempt", "expires_at", "grantor_instance_id", "grantee_instance_id", "grantee_run_id", "state", "request_id", "issued_at", "revoked_at") SELECT "id", "project_id", "machine_id", "generation", "crew_chat_id", (SELECT crew_epoch FROM chat WHERE chat.id=lease_grant.crew_chat_id), 'delegation', (SELECT id FROM delegation WHERE worker_instance_id=lease_grant.grantee_instance_id LIMIT 1), (SELECT attempt FROM delegation WHERE worker_instance_id=lease_grant.grantee_instance_id LIMIT 1), issued_at+86400000, "grantor_instance_id", "grantee_instance_id", "grantee_run_id", "state", "request_id", "issued_at", "revoked_at" FROM `lease_grant`;--> statement-breakpoint
DROP TABLE `lease_grant`;--> statement-breakpoint
ALTER TABLE `__new_lease_grant` RENAME TO `lease_grant`;--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_generation_grantee_unique` ON `lease_grant` (`project_id`,`machine_id`,`generation`,`grantee_instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_grantor_request_unique` ON `lease_grant` (`grantor_instance_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_grant_one_active_per_machine` ON `lease_grant` (`project_id`,`machine_id`) WHERE state = 'active';--> statement-breakpoint
CREATE TRIGGER machine_lease_generation_monotone BEFORE UPDATE OF generation ON machine_lease
  WHEN NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
  BEGIN SELECT RAISE(ABORT,'lease generation must advance by one'); END;
--> statement-breakpoint
ALTER TABLE `lease_mutation` ADD `resource_request_id` text REFERENCES crew_resource_request(id);--> statement-breakpoint
ALTER TABLE `lease_mutation` ADD `target_run_id` text REFERENCES agent_run(id);--> statement-breakpoint
ALTER TABLE `lease_mutation` ADD `target_attempt` integer;--> statement-breakpoint
ALTER TABLE `lease_mutation` ADD `crew_epoch` integer;--> statement-breakpoint
CREATE TRIGGER `lease_grant_run_instance_guard` BEFORE INSERT ON lease_grant
WHEN NOT EXISTS (
  SELECT 1 FROM agent_run r
  WHERE r.id = NEW.grantee_run_id
    AND r.project_id = NEW.project_id
    AND r.instance_id = NEW.grantee_instance_id
)
BEGIN
  SELECT RAISE(ABORT, 'lease_grant_run_instance_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `lease_grant_run_instance_guard_update` BEFORE UPDATE OF grantee_run_id, grantee_instance_id, project_id ON lease_grant
WHEN NOT EXISTS (
  SELECT 1 FROM agent_run r
  WHERE r.id = NEW.grantee_run_id
    AND r.project_id = NEW.project_id
    AND r.instance_id = NEW.grantee_instance_id
)
BEGIN
  SELECT RAISE(ABORT, 'lease_grant_run_instance_mismatch');
END;
