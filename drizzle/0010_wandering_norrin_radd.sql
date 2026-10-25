CREATE TABLE `mcp_frame` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`direction` text NOT NULL,
	`seq` integer NOT NULL,
	`payload_base64` text,
	`payload_bytes` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`sent_at` integer,
	`terminal_at` integer,
	`terminal_reason` text,
	FOREIGN KEY (`session_id`) REFERENCES `mcp_session`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mcp_seq_integer" CHECK(typeof(seq)='integer' AND seq BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_created_at_integer" CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_payload_hash_hash" CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "mcp_frame_direction" CHECK(direction IN ('client_to_server','server_to_client')),
	CONSTRAINT "mcp_frame_state" CHECK(state IN ('queued','sent','acked','cancelled','dropped')),
	CONSTRAINT "mcp_frame_bytes" CHECK(typeof(payload_bytes)='integer' AND payload_bytes BETWEEN 1 AND 131072),
	CONSTRAINT "mcp_frame_base64" CHECK(payload_base64 IS NULL OR (length(payload_base64) BETWEEN 4 AND 174764 AND length(payload_base64)%4=0 AND payload_base64 NOT GLOB '*[^A-Za-z0-9+/=]*')),
	CONSTRAINT "mcp_frame_expires" CHECK(typeof(expires_at)='integer' AND expires_at>created_at),
	CONSTRAINT "mcp_frame_sent_at" CHECK(sent_at IS NULL OR (typeof(sent_at)='integer' AND sent_at>=created_at)),
	CONSTRAINT "mcp_frame_terminal_at" CHECK(terminal_at IS NULL OR (typeof(terminal_at)='integer' AND terminal_at>=created_at)),
	CONSTRAINT "mcp_frame_lifecycle" CHECK((state='queued' AND payload_base64 IS NOT NULL AND sent_at IS NULL AND terminal_at IS NULL AND terminal_reason IS NULL) OR
    (state='sent' AND payload_base64 IS NOT NULL AND sent_at IS NOT NULL AND terminal_at IS NULL AND terminal_reason IS NULL) OR
    (state='acked' AND sent_at IS NOT NULL AND terminal_at IS NOT NULL AND terminal_reason IS NULL) OR
    (state IN ('cancelled','dropped') AND terminal_at IS NOT NULL AND terminal_reason IS NOT NULL AND length(terminal_reason) BETWEEN 1 AND 128))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_frame_sequence_unique` ON `mcp_frame` (`session_id`,`direction`,`seq`);--> statement-breakpoint
CREATE TABLE `mcp_server_process` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`registration_id` text NOT NULL,
	`registration_revision` integer NOT NULL,
	`transport` text NOT NULL,
	`config_hash` text NOT NULL,
	`worker_incarnation_id` text NOT NULL,
	`launch_nonce` text NOT NULL,
	`state` text NOT NULL,
	`pid` integer,
	`endpoint` text,
	`started_at` integer NOT NULL,
	`last_observed_at` integer NOT NULL,
	`ended_at` integer,
	`stop_reason` text,
	`state_revision` integer NOT NULL,
	`state_hash` text NOT NULL,
	FOREIGN KEY (`registration_id`,`registration_revision`,`project_id`,`machine_id`) REFERENCES `mcp_server_registration`(`id`,`revision`,`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mcp_registration_revision_integer" CHECK(typeof(registration_revision)='integer' AND registration_revision BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_state_revision_integer" CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_started_at_integer" CHECK(typeof(started_at)='integer' AND started_at BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_state_hash_hash" CHECK(length(state_hash)=64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "mcp_config_hash_hash" CHECK(length(config_hash)=64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "mcp_process_transport" CHECK(transport IN ('stdio','streamableHttp')),
	CONSTRAINT "mcp_process_state" CHECK(state IN ('starting','running','stopping','stopped','failed','lost')),
	CONSTRAINT "mcp_process_pid" CHECK(pid IS NULL OR (typeof(pid)='integer' AND pid BETWEEN 1 AND 2147483647)),
	CONSTRAINT "mcp_process_observed_at" CHECK(typeof(last_observed_at)='integer' AND last_observed_at>=started_at),
	CONSTRAINT "mcp_process_lifecycle" CHECK((state='starting' AND ended_at IS NULL AND stop_reason IS NULL) OR
    (state='running' AND ended_at IS NULL AND stop_reason IS NULL AND
      ((transport='stdio' AND pid IS NOT NULL AND endpoint IS NULL) OR (transport='streamableHttp' AND endpoint IS NOT NULL))) OR
    (state IN ('stopped','failed','lost') AND ended_at IS NOT NULL AND typeof(ended_at)='integer' AND ended_at>=started_at AND stop_reason IS NOT NULL AND length(stop_reason) BETWEEN 1 AND 128))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_process_launch_unique` ON `mcp_server_process` (`machine_id`,`worker_incarnation_id`,`launch_nonce`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_process_session_identity_unique` ON `mcp_server_process` (`id`,`project_id`,`machine_id`,`registration_id`,`registration_revision`,`worker_incarnation_id`);--> statement-breakpoint
CREATE TABLE `mcp_server_registration` (
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`config_ref` text NOT NULL,
	`config_hash` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`retired_at` integer,
	PRIMARY KEY(`id`, `revision`),
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `project_machine`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mcp_revision_integer" CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_created_at_integer" CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_config_hash_hash" CHECK(length(config_hash)=64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "mcp_registration_name" CHECK(length(name) BETWEEN 1 AND 64 AND name NOT GLOB '*[^a-z0-9_-]*' AND substr(name,1,1) GLOB '[a-z]'),
	CONSTRAINT "mcp_registration_transport" CHECK(transport IN ('stdio','streamableHttp')),
	CONSTRAINT "mcp_registration_ref" CHECK(length(config_ref) BETWEEN 1 AND 128),
	CONSTRAINT "mcp_registration_config_object" CHECK(CASE WHEN json_valid(config_json) THEN json_type(config_json)='object' ELSE 0 END),
	CONSTRAINT "mcp_registration_config_transport" CHECK(CASE WHEN json_valid(config_json) THEN json_extract(config_json,'$.transport') IS transport ELSE 0 END),
	CONSTRAINT "mcp_registration_retired_at" CHECK(retired_at IS NULL OR (typeof(retired_at)='integer' AND retired_at>=created_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_registration_identity_unique` ON `mcp_server_registration` (`id`,`revision`,`project_id`,`machine_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_registration_config_unique` ON `mcp_server_registration` (`id`,`revision`,`project_id`,`machine_id`,`transport`,`config_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_registration_live_name` ON `mcp_server_registration` (`project_id`,`machine_id`,`name`) WHERE retired_at IS NULL;--> statement-breakpoint
CREATE TABLE `mcp_session` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`registration_id` text NOT NULL,
	`registration_revision` integer NOT NULL,
	`process_id` text NOT NULL,
	`authorization_generation` integer NOT NULL,
	`holder_instance_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`open_request_id` text NOT NULL,
	`open_fingerprint` text NOT NULL,
	`worker_boot_id` text NOT NULL,
	`worker_connection_generation` integer NOT NULL,
	`worker_attempt_id` text NOT NULL,
	`worker_incarnation_id` text NOT NULL,
	`protocol_version` text,
	`state` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`initialized_at` integer,
	`closed_at` integer,
	`host_ack_server_seq` integer NOT NULL,
	`client_accepted_through` integer NOT NULL,
	`server_accepted_through` integer NOT NULL,
	`client_high_water` integer NOT NULL,
	`server_high_water` integer NOT NULL,
	`worker_state_revision` integer NOT NULL,
	`worker_state_hash` text,
	FOREIGN KEY (`process_id`,`project_id`,`machine_id`,`registration_id`,`registration_revision`,`worker_incarnation_id`) REFERENCES `mcp_server_process`(`id`,`project_id`,`machine_id`,`registration_id`,`registration_revision`,`worker_incarnation_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`,`holder_instance_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`,`worker_connection_generation`,`worker_boot_id`,`worker_attempt_id`) REFERENCES `machine_connection`(`machine_id`,`generation`,`boot_id`,`attempt_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grant_id`,`project_id`,`holder_instance_id`,`run_id`,`chat_id`) REFERENCES `remote_tool_grant`(`id`,`project_id`,`instance_id`,`run_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mcp_registration_revision_integer" CHECK(typeof(registration_revision)='integer' AND registration_revision BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_authorization_generation_integer" CHECK(typeof(authorization_generation)='integer' AND authorization_generation BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_worker_connection_generation_integer" CHECK(typeof(worker_connection_generation)='integer' AND worker_connection_generation BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "mcp_created_at_integer" CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_host_ack_server_seq_integer" CHECK(typeof(host_ack_server_seq)='integer' AND host_ack_server_seq BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_client_accepted_through_integer" CHECK(typeof(client_accepted_through)='integer' AND client_accepted_through BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_server_accepted_through_integer" CHECK(typeof(server_accepted_through)='integer' AND server_accepted_through BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_client_high_water_integer" CHECK(typeof(client_high_water)='integer' AND client_high_water BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_server_high_water_integer" CHECK(typeof(server_high_water)='integer' AND server_high_water BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_worker_state_revision_integer" CHECK(typeof(worker_state_revision)='integer' AND worker_state_revision BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "mcp_open_fingerprint_hash" CHECK(length(open_fingerprint)=64 AND open_fingerprint NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "mcp_session_state" CHECK(state IN ('connecting','active','draining','closed','failed')),
	CONSTRAINT "mcp_session_protocol" CHECK(protocol_version IS NULL OR length(protocol_version) BETWEEN 1 AND 64),
	CONSTRAINT "mcp_session_cursors" CHECK(host_ack_server_seq<=server_high_water AND client_accepted_through<=client_high_water AND server_accepted_through<=server_high_water),
	CONSTRAINT "mcp_session_worker_state" CHECK((worker_state_revision=0 AND worker_state_hash IS NULL) OR (worker_state_revision>0 AND worker_state_hash IS NOT NULL AND length(worker_state_hash)=64 AND worker_state_hash NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "mcp_session_closed" CHECK((state IN ('connecting','active','draining') AND closed_at IS NULL AND reason IS NULL) OR (state IN ('closed','failed') AND closed_at IS NOT NULL AND typeof(closed_at)='integer' AND closed_at>=created_at AND reason IS NOT NULL AND length(reason) BETWEEN 1 AND 128)),
	CONSTRAINT "mcp_session_active" CHECK(state<>'active' OR (protocol_version IS NOT NULL AND initialized_at IS NOT NULL)),
	CONSTRAINT "mcp_session_initialized" CHECK(initialized_at IS NULL OR (typeof(initialized_at)='integer' AND initialized_at>=created_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_session_open_unique` ON `mcp_session` (`grant_id`,`open_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_session_process_unique` ON `mcp_session` (`process_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_connection_mcp_session_unique` ON `machine_connection` (`machine_id`,`generation`,`boot_id`,`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_tool_grant_mcp_session_unique` ON `remote_tool_grant` (`id`,`project_id`,`instance_id`,`run_id`,`chat_id`);