CREATE TABLE `turn_context` (
	`run_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`serialized_text` text NOT NULL,
	`content_hash` text NOT NULL,
	`basis_revision` text NOT NULL,
	`captured_at` integer NOT NULL,
	`record` text NOT NULL,
	`delivery_state` text NOT NULL,
	`submitted_at` integer,
	`failure_code` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "turn_context_text_budget" CHECK(length(cast("turn_context"."serialized_text" as blob)) between 1 and 8192),
	CONSTRAINT "turn_context_hash_check" CHECK(length("turn_context"."content_hash") = 64 and "turn_context"."content_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "turn_context_record_check" CHECK(json_valid("turn_context"."record")),
	CONSTRAINT "turn_context_delivery_check" CHECK(("turn_context"."delivery_state" = 'prepared' and "turn_context"."submitted_at" is null and "turn_context"."failure_code" is null) or ("turn_context"."delivery_state" = 'submitted' and "turn_context"."submitted_at" >= "turn_context"."captured_at" and "turn_context"."failure_code" is null) or ("turn_context"."delivery_state" = 'failed' and "turn_context"."submitted_at" is null and "turn_context"."failure_code" is not null))
);
--> statement-breakpoint
CREATE INDEX `turn_context_project_idx` ON `turn_context` (`project_id`);
--> statement-breakpoint
CREATE TRIGGER turn_context_identity_insert BEFORE INSERT ON turn_context
WHEN NOT EXISTS (SELECT 1 FROM agent_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id AND r.instance_id = NEW.instance_id)
BEGIN SELECT RAISE(ABORT, 'turn_context_identity_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER turn_context_immutable BEFORE UPDATE OF run_id, project_id, instance_id, serialized_text, content_hash, basis_revision, captured_at, record ON turn_context
BEGIN SELECT RAISE(ABORT, 'turn_context_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER turn_context_delivery_transition BEFORE UPDATE OF delivery_state, submitted_at, failure_code ON turn_context
WHEN (OLD.delivery_state <> 'prepared' AND (NEW.delivery_state <> OLD.delivery_state OR NEW.submitted_at IS NOT OLD.submitted_at OR NEW.failure_code IS NOT OLD.failure_code))
BEGIN SELECT RAISE(ABORT, 'turn_context_delivery_final'); END;
--> statement-breakpoint
CREATE TRIGGER turn_context_no_delete BEFORE DELETE ON turn_context
BEGIN SELECT RAISE(ABORT, 'turn_context_immutable'); END;