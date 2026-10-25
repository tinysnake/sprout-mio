PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mcp_server_process` (
	`id` text PRIMARY KEY NOT NULL,
	`registration_id` text NOT NULL,
	`registration_revision` integer NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`transport` text NOT NULL,
	`config_hash` text NOT NULL,
	`worker_incarnation_id` text NOT NULL,
	`launch_nonce` text NOT NULL,
	`pid` integer,
	`process_started_at` integer,
	`endpoint` text,
	`state` text NOT NULL,
	`state_revision` integer NOT NULL,
	`state_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_observed_at` integer NOT NULL,
	`ended_at` integer,
	`exit_code` integer,
	`end_reason` text,
	FOREIGN KEY (`registration_id`,`registration_revision`,`project_id`,`machine_id`) REFERENCES `mcp_server_registration`(`id`,`revision`,`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mcp_registration_revision_integer" CHECK(typeof(registration_revision)='integer' AND registration_revision BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_state_revision_integer" CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_created_at_integer" CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_last_observed_at_integer" CHECK(typeof(last_observed_at)='integer' AND last_observed_at BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_state_hash_hash" CHECK(length(state_hash)=64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "mcp_config_hash_hash" CHECK(length(config_hash)=64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "mcp_process_started_at_integer" CHECK(process_started_at IS NULL OR (typeof(process_started_at)='integer' AND process_started_at BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "mcp_ended_at_integer" CHECK(ended_at IS NULL OR (typeof(ended_at)='integer' AND ended_at BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "mcp_process_pid" CHECK(pid IS NULL OR (typeof(pid)='integer' AND pid BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "mcp_process_exit_code" CHECK(exit_code IS NULL OR (typeof(exit_code)='integer' AND exit_code BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "mcp_process_transport" CHECK(transport IN ('stdio','streamableHttp')),
	CONSTRAINT "mcp_process_state" CHECK(state IN ('starting','running','stopping','exited','failed','lost')),
	CONSTRAINT "mcp_process_endpoint" CHECK(transport='streamableHttp' OR endpoint IS NULL),
	CONSTRAINT "mcp_process_running" CHECK(state<>'running' OR (pid IS NOT NULL OR (transport='streamableHttp' AND endpoint IS NOT NULL))),
	CONSTRAINT "mcp_process_lifecycle" CHECK((state IN ('starting','running','stopping') AND ended_at IS NULL AND end_reason IS NULL AND exit_code IS NULL) OR (state IN ('exited','failed','lost') AND ended_at IS NOT NULL AND end_reason IS NOT NULL)),
	CONSTRAINT "mcp_process_end_reason" CHECK(end_reason IS NULL OR end_reason IN ('owner_stopped','spawn_failed','exited','crashed','unreachable','worker_lost','config_retired'))
);
--> statement-breakpoint
INSERT INTO `__new_mcp_server_process`("id", "registration_id", "registration_revision", "project_id", "machine_id", "transport", "config_hash", "worker_incarnation_id", "launch_nonce", "pid", "process_started_at", "endpoint", "state", "state_revision", "state_hash", "created_at", "last_observed_at", "ended_at", "exit_code", "end_reason") SELECT "id", "registration_id", "registration_revision", "project_id", "machine_id", "transport", "config_hash", "worker_incarnation_id", "launch_nonce", "pid", "process_started_at", "endpoint", "state", "state_revision", "state_hash", "created_at", "last_observed_at", "ended_at", "exit_code", "end_reason" FROM `mcp_server_process`;--> statement-breakpoint
DROP TABLE `mcp_server_process`;--> statement-breakpoint
ALTER TABLE `__new_mcp_server_process` RENAME TO `mcp_server_process`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_process_session_identity_unique` ON `mcp_server_process` (`id`,`registration_id`,`registration_revision`,`project_id`,`machine_id`,`transport`,`worker_incarnation_id`);