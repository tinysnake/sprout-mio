PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_remote_execution` (
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
	`dispatch_deadline_at` integer NOT NULL,
	`runtime_deadline_at` integer,
	`max_runtime_ms` integer,
	`runner_token` text,
	`log_state` text DEFAULT 'none' NOT NULL,
	`log_sealed` integer DEFAULT false NOT NULL,
	`produced_through_seq` integer,
	`acknowledged_through_seq` integer,
	`available_from_seq` integer,
	`dispatch_connection_generation` integer,
	`dispatch_seq` integer,
	`dispatched_at` integer,
	`drained_at` integer,
	`terminal_at` integer,
	`failure_reason` text,
	`recovery_reason` text,
	`recovery_reported_at` integer,
	FOREIGN KEY (`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`,`holder_instance_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`holder_instance_id`,`project_id`,`chat_id`) REFERENCES `agent_run`(`id`,`instance_id`,`project_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`,`dispatch_connection_generation`,`dispatch_seq`) REFERENCES `worker_exchange_frame`(`machine_id`,`connection_generation`,`seq`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "remote_execution_check_1" CHECK(typeof(authorization_generation)='integer' AND authorization_generation BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "remote_execution_check_2" CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_execution_check_3" CHECK(CASE WHEN json_valid(operation_json) THEN json_type(operation_json)='object' ELSE 0 END),
	CONSTRAINT "remote_execution_check_4" CHECK(directory_revision IS NULL OR (typeof(directory_revision)='integer' AND directory_revision BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "remote_execution_check_5" CHECK(state IN ('queued','dispatched','running','draining','succeeded','failed','rejected','timed_out','unknown')),
	CONSTRAINT "remote_execution_check_6" CHECK(typeof(created_at)='integer' AND created_at>=0),
	CONSTRAINT "remote_execution_check_7" CHECK(typeof(dispatch_deadline_at)='integer' AND dispatch_deadline_at>created_at),
	CONSTRAINT "remote_execution_check_8" CHECK(failure_reason IS NULL OR failure_reason IN ('stale_generation','not_holder','authorization_revoked','cancelled','deadline','worker_lost','executor_error','capability_unavailable','directory_unavailable')),
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
        (state IN ('failed','rejected','timed_out','unknown') AND terminal_at IS NOT NULL AND typeof(terminal_at)='integer' AND terminal_at>=created_at AND failure_reason IS NOT NULL)),
	CONSTRAINT "remote_execution_check_20" CHECK(runner_token IS NULL OR (length(runner_token)=32 AND runner_token NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "remote_execution_check_21" CHECK(log_state IN ('none','partial','full','gap','truncated')),
	CONSTRAINT "remote_execution_check_22" CHECK((max_runtime_ms IS NULL AND runtime_deadline_at IS NULL) OR
        (max_runtime_ms IS NOT NULL AND typeof(max_runtime_ms)='integer' AND max_runtime_ms BETWEEN 1 AND 9007199254740991
          AND runtime_deadline_at IS NOT NULL AND typeof(runtime_deadline_at)='integer'
          AND dispatched_at IS NOT NULL AND runtime_deadline_at>=dispatched_at)),
	CONSTRAINT "remote_execution_check_23" CHECK((produced_through_seq IS NULL OR (typeof(produced_through_seq)='integer' AND produced_through_seq>=1))
        AND (acknowledged_through_seq IS NULL OR (typeof(acknowledged_through_seq)='integer' AND acknowledged_through_seq>=1))
        AND (available_from_seq IS NULL OR (typeof(available_from_seq)='integer' AND available_from_seq>=1))
        AND (acknowledged_through_seq IS NULL OR produced_through_seq IS NOT NULL)
        AND (acknowledged_through_seq IS NULL OR produced_through_seq IS NULL OR acknowledged_through_seq<=produced_through_seq)
        AND (available_from_seq IS NULL OR produced_through_seq IS NULL OR available_from_seq<=produced_through_seq+1)),
	CONSTRAINT "remote_execution_check_24" CHECK(log_state='none' OR produced_through_seq IS NOT NULL),
	CONSTRAINT "remote_execution_check_25" CHECK(log_state!='full' OR acknowledged_through_seq IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_remote_execution`("id", "project_id", "machine_id", "authorization_generation", "holder_instance_id", "run_id", "chat_id", "request_id", "payload_hash", "operation_json", "directory_revision", "state", "created_at", "dispatch_deadline_at", "runtime_deadline_at", "max_runtime_ms", "runner_token", "log_state", "log_sealed", "produced_through_seq", "acknowledged_through_seq", "available_from_seq", "dispatch_connection_generation", "dispatch_seq", "dispatched_at", "drained_at", "terminal_at", "failure_reason", "recovery_reason", "recovery_reported_at") SELECT "id", "project_id", "machine_id", "authorization_generation", "holder_instance_id", "run_id", "chat_id", "request_id", "payload_hash", "operation_json", "directory_revision", "state", "created_at", "dispatch_deadline_at", "runtime_deadline_at", "max_runtime_ms", "runner_token", "log_state", "log_sealed", "produced_through_seq", "acknowledged_through_seq", "available_from_seq", "dispatch_connection_generation", "dispatch_seq", "dispatched_at", "drained_at", "terminal_at", "failure_reason", "recovery_reason", "recovery_reported_at" FROM `remote_execution`;--> statement-breakpoint
DROP TABLE `remote_execution`;--> statement-breakpoint
ALTER TABLE `__new_remote_execution` RENAME TO `remote_execution`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `remote_execution_holder_instance_id_request_id_unique` ON `remote_execution` (`holder_instance_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_execution_id_project_id_machine_id_authorization_generation_holder_instance_id_unique` ON `remote_execution` (`id`,`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`);