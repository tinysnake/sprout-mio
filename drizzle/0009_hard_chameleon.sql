CREATE TABLE `execution_result` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`authorization_generation` integer NOT NULL,
	`holder_instance_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`outcome` text NOT NULL,
	`payload_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`,`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`) REFERENCES `remote_execution`(`id`,`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "execution_result_check_1" CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "execution_result_check_2" CHECK(outcome IN ('succeeded','failed','rejected','timed_out','unknown')),
	CONSTRAINT "execution_result_check_3" CHECK(CASE WHEN json_valid(payload_json) THEN json_type(payload_json)='object' ELSE 0 END),
	CONSTRAINT "execution_result_check_4" CHECK(typeof(recorded_at)='integer' AND recorded_at>=0)
);
--> statement-breakpoint
CREATE TABLE `lease_authorization` (
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
	CONSTRAINT "lease_authorization_check_2" CHECK(state IN ('free','active','draining','revoked')),
	CONSTRAINT "lease_authorization_check_3" CHECK(typeof(issued_at)='integer' AND issued_at>=0),
	CONSTRAINT "lease_authorization_check_4" CHECK(reason IN ('initial','acquire','release','handoff','reclaim')),
	CONSTRAINT "lease_authorization_check_9" CHECK((state='free' AND holder_instance_id IS NULL AND revoked_at IS NULL) OR
        (state IN ('active','draining') AND holder_instance_id IS NOT NULL AND revoked_at IS NULL) OR
        (state='revoked' AND revoked_at IS NOT NULL AND typeof(revoked_at)='integer' AND revoked_at>=issued_at)),
	CONSTRAINT "lease_authorization_check_10" CHECK(generation>0 OR holder_instance_id IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lease_authorization_project_id_machine_id_generation_holder_instance_id_unique` ON `lease_authorization` (`project_id`,`machine_id`,`generation`,`holder_instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_one_live_authorization` ON `lease_authorization` (`project_id`,`machine_id`) WHERE state IN ('free','active','draining');--> statement-breakpoint
CREATE TABLE `lease_mutation` (
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
	CONSTRAINT "lease_mutation_check_3" CHECK(action IN ('acquire','release','handoff','reclaim')),
	CONSTRAINT "lease_mutation_check_4" CHECK(typeof(expected_generation)='integer' AND expected_generation BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "lease_mutation_check_5" CHECK(state IN ('pending','completed')),
	CONSTRAINT "lease_mutation_check_6" CHECK(typeof(created_at)='integer' AND created_at>=0),
	CONSTRAINT "lease_mutation_check_12" CHECK((action='handoff' AND target_instance_id IS NOT NULL) OR (action!='handoff' AND target_instance_id IS NULL)),
	CONSTRAINT "lease_mutation_check_13" CHECK((actor_kind='agent' AND action IN ('acquire','release','handoff')) OR (actor_kind='human' AND action='reclaim')),
	CONSTRAINT "lease_mutation_check_14" CHECK((state='pending' AND action!='acquire' AND completed_at IS NULL AND completed_generation IS NULL) OR
        (state='completed' AND completed_at IS NOT NULL AND typeof(completed_at)='integer' AND completed_at>=created_at
          AND completed_generation IS NOT NULL AND typeof(completed_generation)='integer'
          AND completed_generation BETWEEN expected_generation AND 9007199254740991)),
	CONSTRAINT "lease_mutation_check_15" CHECK(state='pending' OR completed_generation=expected_generation+1 OR
        (action='acquire' AND completed_generation=expected_generation))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lease_mutation_actor_kind_actor_id_request_id_unique` ON `lease_mutation` (`actor_kind`,`actor_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lease_one_pending_mutation` ON `lease_mutation` (`project_id`,`machine_id`) WHERE state='pending';--> statement-breakpoint
CREATE TABLE `machine_lease` (
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`generation` integer NOT NULL,
	`state` text NOT NULL,
	`holder_instance_id` text,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `machine_id`),
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `project_machine`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_instance_id`,`project_id`) REFERENCES `agent_instance`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "machine_lease_check_1" CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "machine_lease_check_2" CHECK(state IN ('free','held','fencing')),
	CONSTRAINT "machine_lease_check_3" CHECK(typeof(changed_at)='integer' AND changed_at>=0),
	CONSTRAINT "machine_lease_check_7" CHECK((state='free' AND holder_instance_id IS NULL) OR
        (state IN ('held','fencing') AND holder_instance_id IS NOT NULL)),
	CONSTRAINT "machine_lease_check_8" CHECK(state='free' OR generation>0)
);
--> statement-breakpoint
CREATE TRIGGER machine_lease_generation_monotone BEFORE UPDATE OF generation ON machine_lease
  WHEN NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
  BEGIN SELECT RAISE(ABORT,'lease generation must advance by one'); END;
--> statement-breakpoint
CREATE TABLE `remote_execution` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`authorization_generation` integer NOT NULL,
	`holder_instance_id` text NOT NULL,
	`run_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`operation_json` text NOT NULL,
	`directory_revision` integer,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`dispatch_connection_generation` integer,
	`dispatch_seq` integer,
	`dispatched_at` integer,
	`drained_at` integer,
	`terminal_at` integer,
	`failure_reason` text,
	FOREIGN KEY (`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`,`holder_instance_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`holder_instance_id`,`project_id`,`chat_id`) REFERENCES `agent_run`(`id`,`instance_id`,`project_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`,`dispatch_connection_generation`,`dispatch_seq`) REFERENCES `worker_exchange_frame`(`machine_id`,`connection_generation`,`seq`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "remote_execution_check_1" CHECK(typeof(authorization_generation)='integer' AND authorization_generation BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "remote_execution_check_2" CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_execution_check_3" CHECK(CASE WHEN json_valid(operation_json) THEN json_type(operation_json)='object' ELSE 0 END),
	CONSTRAINT "remote_execution_check_4" CHECK(directory_revision IS NULL OR (typeof(directory_revision)='integer' AND directory_revision BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "remote_execution_check_5" CHECK(state IN ('queued','dispatched','running','draining','succeeded','failed','rejected','timed_out','unknown')),
	CONSTRAINT "remote_execution_check_6" CHECK(typeof(created_at)='integer' AND created_at>=0),
	CONSTRAINT "remote_execution_check_7" CHECK(typeof(deadline_at)='integer' AND deadline_at>created_at),
	CONSTRAINT "remote_execution_check_8" CHECK(failure_reason IN ('stale_generation','not_holder','authorization_revoked','deadline','worker_lost','executor_error','capability_unavailable','directory_unavailable')),
	CONSTRAINT "remote_execution_check_14" CHECK((dispatch_connection_generation IS NULL AND dispatch_seq IS NULL AND dispatched_at IS NULL AND drained_at IS NULL) OR
        (dispatch_connection_generation IS NOT NULL AND typeof(dispatch_connection_generation)='integer' AND dispatch_connection_generation>=1
          AND dispatch_seq IS NOT NULL AND typeof(dispatch_seq)='integer' AND dispatch_seq>=1
          AND dispatched_at IS NOT NULL AND typeof(dispatched_at)='integer' AND dispatched_at>=created_at)),
	CONSTRAINT "remote_execution_check_15" CHECK(drained_at IS NULL OR (typeof(drained_at)='integer' AND dispatched_at IS NOT NULL AND drained_at>=dispatched_at)),
	CONSTRAINT "remote_execution_check_16" CHECK(state NOT IN ('dispatched','running','draining') OR dispatch_connection_generation IS NOT NULL),
	CONSTRAINT "remote_execution_check_17" CHECK(state!='queued' OR dispatch_connection_generation IS NULL),
	CONSTRAINT "remote_execution_check_18" CHECK(state!='succeeded' OR (dispatch_connection_generation IS NOT NULL AND drained_at IS NOT NULL)),
	CONSTRAINT "remote_execution_check_19" CHECK((state IN ('queued','dispatched','running','draining') AND terminal_at IS NULL AND failure_reason IS NULL) OR
        (state='succeeded' AND terminal_at IS NOT NULL AND typeof(terminal_at)='integer' AND terminal_at>=created_at AND failure_reason IS NULL) OR
        (state IN ('failed','rejected','timed_out','unknown') AND terminal_at IS NOT NULL AND typeof(terminal_at)='integer' AND terminal_at>=created_at AND failure_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_execution_holder_instance_id_request_id_unique` ON `remote_execution` (`holder_instance_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_execution_id_project_id_machine_id_authorization_generation_holder_instance_id_unique` ON `remote_execution` (`id`,`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`);--> statement-breakpoint
CREATE TABLE `remote_tool_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`run_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`project_id`,`user_id`) REFERENCES `project`(`id`,`created_by`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`instance_id`,`project_id`,`chat_id`) REFERENCES `agent_run`(`id`,`instance_id`,`project_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "remote_tool_grant_check_2" CHECK(length(secret_hash)=64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_tool_grant_check_4" CHECK(typeof(issued_at)='integer' AND issued_at>=0),
	CONSTRAINT "remote_tool_grant_check_5" CHECK(typeof(expires_at)='integer' AND expires_at>issued_at),
	CONSTRAINT "remote_tool_grant_check_6" CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=issued_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_tool_grant_secret_hash_unique` ON `remote_tool_grant` (`secret_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_tool_grant_run_id_unique` ON `remote_tool_grant` (`run_id`);--> statement-breakpoint
CREATE TABLE `worker_exchange_frame` (
	`machine_id` text NOT NULL,
	`connection_generation` integer NOT NULL,
	`seq` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `connection_generation`, `seq`),
	FOREIGN KEY (`machine_id`,`connection_generation`) REFERENCES `machine_connection`(`machine_id`,`generation`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "worker_exchange_frame_check_1" CHECK(typeof(connection_generation)='integer' AND connection_generation BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "worker_exchange_frame_check_2" CHECK(typeof(seq)='integer' AND seq BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "worker_exchange_frame_check_3" CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "worker_exchange_frame_check_4" CHECK(CASE WHEN json_valid(response_json) THEN json_type(response_json)='object' ELSE 0 END),
	CONSTRAINT "worker_exchange_frame_check_5" CHECK(typeof(created_at)='integer' AND created_at>=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_id_project_unique` ON `agent_instance` (`id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_bound_identity_unique` ON `agent_run` (`id`,`instance_id`,`project_id`,`chat_id`);