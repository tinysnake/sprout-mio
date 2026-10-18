CREATE TABLE `repo_checkout` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`source_kind` text NOT NULL,
	`source` text NOT NULL,
	`ref` text NOT NULL,
	`commit` text NOT NULL,
	`fetched_at` integer,
	`resolved_at` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "repo_checkout_status_check" CHECK("repo_checkout"."status" in ('preparing', 'ready')),
	CONSTRAINT "repo_checkout_ready_check" CHECK("repo_checkout"."status" != 'ready' or (
      "repo_checkout"."path" != '' and "repo_checkout"."commit" != '' and "repo_checkout"."ref" != '' and "repo_checkout"."source" != ''
    ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_checkout_project_unique` ON `repo_checkout` (`project_id`);--> statement-breakpoint
CREATE TABLE `repo_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`checkout_id` text NOT NULL,
	`path` text NOT NULL,
	`source` text NOT NULL,
	`source_kind` text NOT NULL,
	`ref` text NOT NULL,
	`commit` text NOT NULL,
	`fresh` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`fetched_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkout_id`) REFERENCES `repo_checkout`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "repo_provenance_fresh_check" CHECK("repo_provenance"."fresh" in (0, 1)),
	CONSTRAINT "repo_provenance_commit_check" CHECK("repo_provenance"."commit" != '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_provenance_run_id_unique` ON `repo_provenance` (`run_id`);--> statement-breakpoint
CREATE INDEX `repo_provenance_project_idx` ON `repo_provenance` (`project_id`);