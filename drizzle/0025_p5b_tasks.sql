CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`constraints` text DEFAULT '' NOT NULL,
	`completion_requirements` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`assignment_revision` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`created_by`) REFERENCES `project`(`id`,`created_by`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_status_check" CHECK("task"."status" in ('proposed','assigned','finished','canceled')),
	CONSTRAINT "task_assignment_check" CHECK(("task"."status"='proposed' and "task"."chat_id" is null) or ("task"."status" in ('assigned','finished') and "task"."chat_id" is not null) or "task"."status"='canceled'),
	CONSTRAINT "task_title_check" CHECK(length(trim("task"."title")) between 1 and 120),
	CONSTRAINT "task_description_check" CHECK(length("task"."description")<=8000),
	CONSTRAINT "task_constraints_check" CHECK(length("task"."constraints")<=8000),
	CONSTRAINT "task_requirements_check" CHECK(length("task"."completion_requirements")<=8000),
	CONSTRAINT "task_revision_check" CHECK(typeof("task"."revision")='integer' and "task"."revision" between 1 and 9007199254740991),
	CONSTRAINT "task_assignment_revision_check" CHECK(typeof("task"."assignment_revision")='integer' and "task"."assignment_revision" between 0 and 9007199254740991),
	CONSTRAINT "task_timestamps_check" CHECK(typeof("task"."created_at")='integer' and "task"."created_at">=0 and typeof("task"."updated_at")='integer' and "task"."updated_at">="task"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_id_project_unique` ON `task` (`id`,`project_id`);--> statement-breakpoint
CREATE INDEX `task_project_status_updated_idx` ON `task` (`project_id`,`status`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `task_chat_status_idx` ON `task` (`chat_id`,`status`,`id`);--> statement-breakpoint
CREATE TABLE `task_checklist_item` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`position` integer NOT NULL,
	`body` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_checklist_position_check" CHECK(typeof("task_checklist_item"."position")='integer' and "task_checklist_item"."position" between 1 and 9007199254740991),
	CONSTRAINT "task_checklist_body_check" CHECK(length(trim("task_checklist_item"."body")) between 1 and 1000),
	CONSTRAINT "task_checklist_checked_check" CHECK("task_checklist_item"."checked" in (0,1)),
	CONSTRAINT "task_checklist_timestamps_check" CHECK(typeof("task_checklist_item"."created_at")='integer' and "task_checklist_item"."created_at">=0 and typeof("task_checklist_item"."updated_at")='integer' and "task_checklist_item"."updated_at">="task_checklist_item"."created_at" and ("task_checklist_item"."removed_at" is null or (typeof("task_checklist_item"."removed_at")='integer' and "task_checklist_item"."removed_at">="task_checklist_item"."created_at")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_checklist_position_unique` ON `task_checklist_item` (`task_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_checklist_task_id_unique` ON `task_checklist_item` (`task_id`,`id`);--> statement-breakpoint
CREATE TABLE `task_event` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`seq` integer NOT NULL,
	`action` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_run_id` text,
	`from_status` text,
	`to_status` text NOT NULL,
	`from_chat_id` text,
	`to_chat_id` text,
	`record_seq_at_event` integer,
	`checklist_item_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`project_id`) REFERENCES `task`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`record_seq_at_event`) REFERENCES `message`(`task_id`,`task_record_seq`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`checklist_item_id`) REFERENCES `task_checklist_item`(`task_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_event_seq_check" CHECK(typeof("task_event"."seq")='integer' and "task_event"."seq" between 1 and 9007199254740991),
	CONSTRAINT "task_event_action_check" CHECK("task_event"."action" in ('create', 'update', 'assign', 'reassign', 'unassign', 'start', 'checklist_add', 'checklist_update', 'checklist_remove', 'record_append', 'complete', 'cancel', 'correct', 'reopen')),
	CONSTRAINT "task_event_actor_check" CHECK("task_event"."actor_kind" in ('human','agent') and length(trim("task_event"."actor_id"))>0 and (("task_event"."actor_kind"='human' and "task_event"."actor_run_id" is null) or ("task_event"."actor_kind"='agent' and "task_event"."actor_run_id" is not null))),
	CONSTRAINT "task_event_status_check" CHECK(("task_event"."from_status" is null or "task_event"."from_status" in ('proposed','assigned','finished','canceled')) and "task_event"."to_status" in ('proposed','assigned','finished','canceled')),
	CONSTRAINT "task_event_record_seq_check" CHECK("task_event"."record_seq_at_event" is null or (typeof("task_event"."record_seq_at_event")='integer' and "task_event"."record_seq_at_event" between 1 and 9007199254740991)),
	CONSTRAINT "task_event_create_check" CHECK(("task_event"."action"='create' and "task_event"."from_status" is null and "task_event"."from_chat_id" is null and "task_event"."to_status"='proposed') or ("task_event"."action"<>'create' and "task_event"."from_status" is not null)),
	CONSTRAINT "task_event_checklist_check" CHECK(("task_event"."action" in ('checklist_add','checklist_update','checklist_remove') and "task_event"."checklist_item_id" is not null) or ("task_event"."action" not in ('checklist_add','checklist_update','checklist_remove') and "task_event"."checklist_item_id" is null)),
	CONSTRAINT "task_event_created_at_check" CHECK(typeof("task_event"."created_at")='integer' and "task_event"."created_at">=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_event_task_seq_unique` ON `task_event` (`task_id`,`seq`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_run_input` (
	`run_id` text NOT NULL,
	`message_id` text NOT NULL,
	`disposition` text DEFAULT 'pending' NOT NULL,
	`delivered_at` integer,
	`cancelled_at` integer,
	`admitted_at` integer,
	`cancel_reason` text,
	PRIMARY KEY(`run_id`, `message_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_input_disposition_check" CHECK((
      ("__new_agent_run_input"."disposition" = 'pending' and "__new_agent_run_input"."delivered_at" is null and "__new_agent_run_input"."cancelled_at" is null and "__new_agent_run_input"."cancel_reason" is null)
      or ("__new_agent_run_input"."disposition" = 'delivered' and "__new_agent_run_input"."delivered_at" is not null and "__new_agent_run_input"."cancelled_at" is null and "__new_agent_run_input"."cancel_reason" is null)
      or ("__new_agent_run_input"."disposition" = 'cancelled' and "__new_agent_run_input"."delivered_at" is null and "__new_agent_run_input"."cancelled_at" is not null and "__new_agent_run_input"."cancel_reason" is not null)
    )),
	CONSTRAINT "agent_run_input_cancel_reason_check" CHECK("__new_agent_run_input"."cancel_reason" is null or "__new_agent_run_input"."cancel_reason" in ('membership_revoked', 'human_stop', 'group_dissolved', 'task_context_changed')),
	CONSTRAINT "agent_run_input_admitted_at_check" CHECK("__new_agent_run_input"."admitted_at" is null or (typeof("__new_agent_run_input"."admitted_at")='integer' and "__new_agent_run_input"."admitted_at">=0))
);
--> statement-breakpoint
INSERT INTO `__new_agent_run_input`("run_id", "message_id", "disposition", "delivered_at", "cancelled_at", "admitted_at", "cancel_reason") SELECT "run_id", "message_id", "disposition", "delivered_at", "cancelled_at", NULL, "cancel_reason" FROM `agent_run_input`;--> statement-breakpoint
DROP TABLE `agent_run_input`;--> statement-breakpoint
ALTER TABLE `__new_agent_run_input` RENAME TO `agent_run_input`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_run_input_message_idx` ON `agent_run_input` (`message_id`);--> statement-breakpoint
CREATE INDEX `agent_run_input_run_disposition_idx` ON `agent_run_input` (`run_id`,`disposition`);--> statement-breakpoint
CREATE TABLE `__new_message` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`sender_kind` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`task_id` text,
	`task_project_id` text,
	`task_record_seq` integer,
	`task_record_kind` text,
	`task_reference_message_id` text,
	`task_author_run_id` text,
	`task_assignment_revision` integer,
	`task_governance_revision` integer,
	`task_start_recipient_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_author_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`task_project_id`) REFERENCES `task`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`task_project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_reference_message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_sender_kind_check" CHECK("__new_message"."sender_kind" in ('human', 'agent')),
	CONSTRAINT "message_task_shape_check" CHECK((
      ("__new_message"."task_id" is null and "__new_message"."task_project_id" is null and "__new_message"."task_record_seq" is null
        and "__new_message"."task_record_kind" is null and "__new_message"."task_reference_message_id" is null
        and "__new_message"."task_author_run_id" is null and "__new_message"."task_assignment_revision" is null
        and "__new_message"."task_governance_revision" is null and "__new_message"."task_start_recipient_id" is null)
      or ("__new_message"."task_id" is not null and "__new_message"."task_project_id" is not null
        and "__new_message"."task_record_seq" is not null and typeof("__new_message"."task_record_seq")='integer'
        and "__new_message"."task_record_seq" between 1 and 9007199254740991
        and "__new_message"."task_record_kind" is not null and "__new_message"."task_record_kind" in ('start','progress','correction')
        and length(trim("__new_message"."body")) between 1 and 8000
        and (("__new_message"."sender_kind"='human' and "__new_message"."task_author_run_id" is null)
          or ("__new_message"."sender_kind"='agent' and "__new_message"."task_author_run_id" is not null))
        and (("__new_message"."task_record_kind"='start' and "__new_message"."sender_kind"='human'
          and "__new_message"."task_reference_message_id" is null
          and typeof("__new_message"."task_assignment_revision")='integer' and "__new_message"."task_assignment_revision" between 0 and 9007199254740991
          and typeof("__new_message"."task_governance_revision")='integer' and "__new_message"."task_governance_revision" between 0 and 9007199254740991
          and "__new_message"."task_start_recipient_id" is not null and length(trim("__new_message"."task_start_recipient_id"))>0)
        or ("__new_message"."task_record_kind" in ('progress','correction') and "__new_message"."task_assignment_revision" is null
          and "__new_message"."task_governance_revision" is null and "__new_message"."task_start_recipient_id" is null)))
    ))
);
--> statement-breakpoint
INSERT INTO `__new_message`("id", "chat_id", "sender_kind", "sender_id", "body", "task_id", "task_project_id", "task_record_seq", "task_record_kind", "task_reference_message_id", "task_author_run_id", "task_assignment_revision", "task_governance_revision", "task_start_recipient_id", "created_at") SELECT "id", "chat_id", "sender_kind", "sender_id", "body", NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, "created_at" FROM `message`;--> statement-breakpoint
DROP TABLE `message`;--> statement-breakpoint
ALTER TABLE `__new_message` RENAME TO `message`;--> statement-breakpoint
CREATE INDEX `message_chat_created_at_idx` ON `message` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_id_chat_unique` ON `message` (`id`,`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_task_seq_unique` ON `message` (`task_id`,`task_record_seq`);