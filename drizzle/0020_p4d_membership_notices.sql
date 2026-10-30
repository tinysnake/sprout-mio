CREATE TABLE `project_machine_membership` (
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`state` text NOT NULL,
	`joined_at` integer NOT NULL,
	`requested_by` text,
	`request_id` text,
	`payload_hash` text,
	`requested_at` integer,
	`removal_mutation_id` text,
	`removed_at` integer,
	`revoked_generation` integer,
	PRIMARY KEY(`project_id`, `machine_id`, `epoch`),
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `project_machine`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`removal_mutation_id`) REFERENCES `lease_mutation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_machine_membership_check_1" CHECK(typeof("project_machine_membership"."epoch")='integer' AND "project_machine_membership"."epoch" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "project_machine_membership_check_2" CHECK("project_machine_membership"."state" IN ('active','detaching','removed')),
	CONSTRAINT "project_machine_membership_check_3" CHECK(typeof("project_machine_membership"."joined_at")='integer' AND "project_machine_membership"."joined_at">=0),
	CONSTRAINT "project_machine_membership_check_4" CHECK("project_machine_membership"."requested_at" IS NULL OR (typeof("project_machine_membership"."requested_at")='integer' AND "project_machine_membership"."requested_at">="project_machine_membership"."joined_at")),
	CONSTRAINT "project_machine_membership_check_5" CHECK("project_machine_membership"."removed_at" IS NULL OR (typeof("project_machine_membership"."removed_at")='integer' AND "project_machine_membership"."removed_at">=0 AND "project_machine_membership"."requested_at" IS NOT NULL AND "project_machine_membership"."removed_at">="project_machine_membership"."requested_at")),
	CONSTRAINT "project_machine_membership_check_6" CHECK("project_machine_membership"."payload_hash" IS NULL OR (length("project_machine_membership"."payload_hash")=64 AND "project_machine_membership"."payload_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "project_machine_membership_check_7" CHECK("project_machine_membership"."revoked_generation" IS NULL OR (typeof("project_machine_membership"."revoked_generation")='integer' AND "project_machine_membership"."revoked_generation" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "project_machine_membership_check_8" CHECK(("project_machine_membership"."state"='active' AND "project_machine_membership"."requested_by" IS NULL AND "project_machine_membership"."request_id" IS NULL AND "project_machine_membership"."payload_hash" IS NULL AND "project_machine_membership"."requested_at" IS NULL AND "project_machine_membership"."removal_mutation_id" IS NULL AND "project_machine_membership"."removed_at" IS NULL AND "project_machine_membership"."revoked_generation" IS NULL) OR
        ("project_machine_membership"."state"='detaching' AND "project_machine_membership"."requested_by" IS NOT NULL AND "project_machine_membership"."request_id" IS NOT NULL AND "project_machine_membership"."payload_hash" IS NOT NULL AND "project_machine_membership"."requested_at" IS NOT NULL AND "project_machine_membership"."removal_mutation_id" IS NOT NULL AND "project_machine_membership"."removed_at" IS NULL AND "project_machine_membership"."revoked_generation" IS NULL) OR
        ("project_machine_membership"."state"='removed' AND "project_machine_membership"."requested_by" IS NOT NULL AND "project_machine_membership"."request_id" IS NOT NULL AND "project_machine_membership"."payload_hash" IS NOT NULL AND "project_machine_membership"."requested_at" IS NOT NULL AND "project_machine_membership"."removed_at" IS NOT NULL AND "project_machine_membership"."revoked_generation" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_machine_membership_one_live_epoch` ON `project_machine_membership` (`project_id`,`machine_id`) WHERE state IN ('active','detaching');--> statement-breakpoint
CREATE UNIQUE INDEX `project_machine_membership_actor_request_unique` ON `project_machine_membership` (`requested_by`,`request_id`) WHERE request_id IS NOT NULL;--> statement-breakpoint
-- 回填既有绑定：每行一段 epoch=1/active 的生命周期，joined_at 取该关系 created_at。
-- drizzle-kit 不会生成数据迁移，这一段是手写的。
INSERT INTO `project_machine_membership` (`project_id`, `machine_id`, `epoch`, `state`, `joined_at`)
SELECT `project_id`, `machine_id`, 1, 'active', `created_at` FROM `project_machine`;--> statement-breakpoint
CREATE TABLE `run_resource_notice` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`run_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`cause_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`project_id`,`machine_id`) REFERENCES `project_machine`(`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`instance_id`,`project_id`,`chat_id`) REFERENCES `agent_run`(`id`,`instance_id`,`project_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_resource_notice_check_1" CHECK("run_resource_notice"."kind" IN ('lease_handed_off','lease_released','lease_reclaimed','machine_removed')),
	CONSTRAINT "run_resource_notice_check_2" CHECK(CASE WHEN json_valid("run_resource_notice"."payload_json") THEN json_type("run_resource_notice"."payload_json")='object' ELSE 0 END),
	CONSTRAINT "run_resource_notice_check_3" CHECK(typeof("run_resource_notice"."created_at")='integer' AND "run_resource_notice"."created_at">=0),
	CONSTRAINT "run_resource_notice_check_4" CHECK("run_resource_notice"."delivered_at" IS NULL OR (typeof("run_resource_notice"."delivered_at")='integer' AND "run_resource_notice"."delivered_at">="run_resource_notice"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_resource_notice_kind_cause_id_run_id_unique` ON `run_resource_notice` (`kind`,`cause_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `run_resource_notice_undelivered_idx` ON `run_resource_notice` (`run_id`,`created_at`,`id`) WHERE delivered_at IS NULL;--> statement-breakpoint
CREATE INDEX `remote_execution_scope_idx` ON `remote_execution` (`project_id`,`machine_id`,`created_at`,`id`);