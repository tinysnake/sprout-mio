DROP TRIGGER task_finished_record;
--> statement-breakpoint
DROP TRIGGER message_task_append_guard;
--> statement-breakpoint
DROP TRIGGER message_task_no_update;
--> statement-breakpoint
DROP TRIGGER message_task_no_delete;
--> statement-breakpoint
DROP TRIGGER task_event_boundary;
--> statement-breakpoint
DROP TRIGGER agent_run_no_task_assistant;
--> statement-breakpoint
DROP TRIGGER agent_run_no_task_assistant_update;
--> statement-breakpoint
DROP TRIGGER task_input_admission_guard;
--> statement-breakpoint
DROP TRIGGER task_input_admission_guard_insert;
--> statement-breakpoint
CREATE TABLE `assistant_event` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_chat_id` text NOT NULL,
	`event_key` text NOT NULL,
	`fact` text NOT NULL,
	`created_at` integer NOT NULL,
	`message_id` text,
	`suppressed_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`assistant_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_event_message_id_unique` ON `assistant_event` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_event_key_unique` ON `assistant_event` (`assistant_chat_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `assistant_event_pending_idx` ON `assistant_event` (`message_id`,`suppressed_at`);--> statement-breakpoint
CREATE TABLE `assistant_interest` (
	`assistant_chat_id` text NOT NULL,
	`run_id` text NOT NULL,
	`origin_kind` text NOT NULL,
	`origin_id` text NOT NULL,
	PRIMARY KEY(`assistant_chat_id`, `run_id`, `origin_kind`, `origin_id`),
	FOREIGN KEY (`assistant_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `assistant_preferences` (
	`assistant_chat_id` text PRIMARY KEY NOT NULL,
	`interval_seconds` integer DEFAULT 300 NOT NULL,
	FOREIGN KEY (`assistant_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assistant_interval_check" CHECK("assistant_preferences"."interval_seconds" between 60 and 86400)
);
--> statement-breakpoint
CREATE TABLE `assistant_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_chat_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`human_id` text NOT NULL,
	`target` text NOT NULL,
	`target_project_id` text NOT NULL,
	`target_chat_id` text NOT NULL,
	`agent_profile_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`body` text NOT NULL,
	`operation_hash` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_by` text,
	`confirmed_at` integer,
	`work_message_id` text,
	FOREIGN KEY (`assistant_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_proposal_work_message_id_unique` ON `assistant_proposal` (`work_message_id`);--> statement-breakpoint
CREATE TABLE `assistant_run_cursor` (
	`assistant_chat_id` text NOT NULL,
	`run_id` text NOT NULL,
	`next_due_at` integer NOT NULL,
	`terminal_captured_at` integer,
	PRIMARY KEY(`assistant_chat_id`, `run_id`),
	FOREIGN KEY (`assistant_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_cursor_due_idx` ON `assistant_run_cursor` (`terminal_captured_at`,`next_due_at`);--> statement-breakpoint
CREATE TABLE `assistant_watch` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_chat_id` text NOT NULL,
	`target_project_id` text NOT NULL,
	`target_chat_id` text NOT NULL,
	`consented_by` text NOT NULL,
	`consented_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`assistant_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`consented_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_watch_active_unique` ON `assistant_watch` (`assistant_chat_id`,`target_chat_id`) WHERE "assistant_watch"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `assistant_watch_target_idx` ON `assistant_watch` (`target_chat_id`,`revoked_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_message` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`sender_kind` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`assistant_event_id` text,
	`assistant_proposal_id` text,
	`automation_trigger_id` text,
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
	FOREIGN KEY (`assistant_event_id`) REFERENCES `assistant_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assistant_proposal_id`) REFERENCES `assistant_proposal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_trigger_id`) REFERENCES `webhook_trigger`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_author_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_trigger_id`,`id`,`chat_id`) REFERENCES `webhook_trigger`(`id`,`message_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`task_project_id`) REFERENCES `task`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`task_project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_reference_message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_sender_kind_check" CHECK("__new_message"."sender_kind" in ('human', 'agent', 'automation', 'assistant_event', 'assistant_work')),
	CONSTRAINT "message_automation_shape_check" CHECK(("__new_message"."sender_kind"='automation' and "__new_message"."automation_trigger_id" is not null and "__new_message"."sender_id"="__new_message"."automation_trigger_id" and "__new_message"."task_id" is null) or ("__new_message"."sender_kind"<>'automation' and "__new_message"."automation_trigger_id" is null)),
	CONSTRAINT "message_assistant_source_check" CHECK(("__new_message"."sender_kind"='assistant_event' and "__new_message"."assistant_event_id"="__new_message"."sender_id" and "__new_message"."assistant_event_id" is not null and "__new_message"."assistant_proposal_id" is null and "__new_message"."task_id" is null) or ("__new_message"."sender_kind"='assistant_work' and "__new_message"."assistant_proposal_id"="__new_message"."sender_id" and "__new_message"."assistant_proposal_id" is not null and "__new_message"."assistant_event_id" is null and "__new_message"."task_id" is null) or ("__new_message"."sender_kind" not in ('assistant_event','assistant_work') and "__new_message"."assistant_event_id" is null and "__new_message"."assistant_proposal_id" is null)),
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
INSERT INTO `__new_message`("id", "chat_id", "sender_kind", "sender_id", "body", "assistant_event_id", "assistant_proposal_id", "automation_trigger_id", "task_id", "task_project_id", "task_record_seq", "task_record_kind", "task_reference_message_id", "task_author_run_id", "task_assignment_revision", "task_governance_revision", "task_start_recipient_id", "created_at") SELECT "id", "chat_id", "sender_kind", "sender_id", "body", NULL, NULL, "automation_trigger_id", "task_id", "task_project_id", "task_record_seq", "task_record_kind", "task_reference_message_id", "task_author_run_id", "task_assignment_revision", "task_governance_revision", "task_start_recipient_id", "created_at" FROM `message`;--> statement-breakpoint
DROP TABLE `message`;--> statement-breakpoint
ALTER TABLE `__new_message` RENAME TO `message`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `message_assistant_event_unique` ON `message` (`assistant_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_assistant_proposal_unique` ON `message` (`assistant_proposal_id`);--> statement-breakpoint
CREATE INDEX `message_chat_created_at_idx` ON `message` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_id_chat_unique` ON `message` (`id`,`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_task_seq_unique` ON `message` (`task_id`,`task_record_seq`);--> statement-breakpoint
CREATE TRIGGER task_finished_record BEFORE UPDATE ON task WHEN NEW.status='finished' AND NOT EXISTS (SELECT 1 FROM message WHERE task_id=NEW.id AND task_record_seq=(SELECT max(task_record_seq) FROM message WHERE task_id=NEW.id) AND task_record_kind IN ('progress','correction')) BEGIN SELECT RAISE(ABORT,'task_record_required'); END;
--> statement-breakpoint
CREATE TRIGGER message_task_append_guard BEFORE INSERT ON message WHEN NEW.task_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM task t WHERE t.id=NEW.task_id AND t.project_id=NEW.task_project_id AND t.chat_id=NEW.chat_id AND ((NEW.task_record_kind IN ('start','progress') AND t.status='assigned') OR (NEW.task_record_kind='correction' AND t.status='finished' AND NEW.sender_kind='human'))) OR NEW.task_record_seq<>(SELECT coalesce(max(task_record_seq),0)+1 FROM message WHERE task_id=NEW.task_id) OR (NEW.sender_kind='agent' AND NOT EXISTS (SELECT 1 FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id AND i.project_id=r.project_id AND i.chat_id=r.chat_id WHERE r.id=NEW.task_author_run_id AND r.status IN ('queued','running') AND r.project_id=NEW.task_project_id AND r.chat_id=NEW.chat_id AND i.agent_profile_id=NEW.sender_id))) BEGIN SELECT RAISE(ABORT,'task_record_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER message_task_no_update BEFORE UPDATE ON message WHEN OLD.task_id IS NOT NULL OR NEW.task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'task_record_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER message_task_no_delete BEFORE DELETE ON message WHEN OLD.task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'task_record_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER task_event_boundary BEFORE INSERT ON task_event WHEN NOT EXISTS (SELECT 1 FROM task t WHERE t.id=NEW.task_id AND t.project_id=NEW.project_id AND t.revision=NEW.seq AND t.status=NEW.to_status AND t.chat_id IS NEW.to_chat_id AND NEW.record_seq_at_event IS (SELECT max(task_record_seq) FROM message WHERE task_id=t.id)) BEGIN SELECT RAISE(ABORT,'task_event_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER agent_run_no_task_assistant BEFORE INSERT ON agent_run WHEN NEW.assistant_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM message WHERE id=NEW.assistant_message_id AND task_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'task_record_not_assistant'); END;
--> statement-breakpoint
CREATE TRIGGER agent_run_no_task_assistant_update BEFORE UPDATE OF assistant_message_id ON agent_run WHEN NEW.assistant_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM message WHERE id=NEW.assistant_message_id AND task_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'task_record_not_assistant'); END;
--> statement-breakpoint
CREATE TRIGGER task_input_admission_guard BEFORE UPDATE ON agent_run_input WHEN (OLD.admitted_at IS NOT NULL AND (NEW.admitted_at IS NOT OLD.admitted_at OR NEW.message_id<>OLD.message_id)) OR (NEW.admitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message WHERE id=NEW.message_id AND (task_record_kind='start' OR sender_kind='automation'))) BEGIN SELECT RAISE(ABORT,'task_input_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER task_input_admission_guard_insert BEFORE INSERT ON agent_run_input WHEN NEW.admitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message WHERE id=NEW.message_id AND (task_record_kind='start' OR sender_kind='automation')) BEGIN SELECT RAISE(ABORT,'task_input_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER message_automation_no_update BEFORE UPDATE ON message WHEN OLD.sender_kind='automation' OR NEW.sender_kind='automation' BEGIN SELECT RAISE(ABORT,'automation_message_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER message_automation_no_delete BEFORE DELETE ON message WHEN OLD.sender_kind='automation' BEGIN SELECT RAISE(ABORT,'automation_message_immutable'); END;
--> statement-breakpoint
ALTER TABLE `agent_profile` ADD `purpose` text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE `remote_tool_grant` ADD `purpose` text DEFAULT 'worker' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER agent_profile_purpose_immutable BEFORE UPDATE OF purpose ON agent_profile WHEN NEW.purpose != OLD.purpose BEGIN SELECT RAISE(ABORT, 'agent purpose is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER assistant_proposal_operation_immutable BEFORE UPDATE ON assistant_proposal WHEN NEW.assistant_chat_id != OLD.assistant_chat_id OR NEW.source_run_id != OLD.source_run_id OR NEW.human_id != OLD.human_id OR NEW.target != OLD.target OR NEW.target_project_id != OLD.target_project_id OR NEW.target_chat_id != OLD.target_chat_id OR NEW.agent_profile_id != OLD.agent_profile_id OR NEW.instance_id != OLD.instance_id OR NEW.body != OLD.body OR NEW.operation_hash != OLD.operation_hash OR NEW.version != OLD.version OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at BEGIN SELECT RAISE(ABORT, 'assistant operation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER assistant_event_fact_immutable BEFORE UPDATE ON assistant_event WHEN NEW.assistant_chat_id != OLD.assistant_chat_id OR NEW.event_key != OLD.event_key OR NEW.fact != OLD.fact OR NEW.created_at != OLD.created_at BEGIN SELECT RAISE(ABORT, 'assistant fact is immutable'); END;
--> statement-breakpoint
DROP VIEW chat_effective_member;
--> statement-breakpoint
CREATE VIEW chat_effective_member AS
  SELECT
    c.id AS chat_id,
    c.project_id,
    cm.member_kind,
    cm.member_id,
    cm.added_at,
    'chat_member' AS source
  FROM chat c
  JOIN chat_member cm ON cm.chat_id = c.id
  WHERE c.kind IN ('dm', 'group') AND (
    cm.member_kind = 'human' OR c.kind = 'dm' OR EXISTS (
      SELECT 1 FROM project_member pm
      WHERE pm.project_id = c.project_id AND pm.agent_profile_id = cm.member_id
    )
  )
  UNION ALL
  SELECT
    c.id AS chat_id,
    c.project_id,
    'agent' AS member_kind,
    pm.agent_profile_id AS member_id,
    pm.added_at,
    'project_member' AS source
  FROM chat c
  JOIN project_member pm ON pm.project_id = c.project_id
  WHERE c.kind = 'public_channel' AND EXISTS (SELECT 1 FROM agent_profile a WHERE a.id=pm.agent_profile_id AND a.purpose='worker')
  UNION ALL
  SELECT
    c.id AS chat_id,
    c.project_id,
    'human' AS member_kind,
    p.created_by AS member_id,
    p.created_at AS added_at,
    'project_owner' AS source
  FROM chat c
  JOIN project p ON p.id = c.project_id
  WHERE c.kind = 'public_channel';
--> statement-breakpoint
CREATE TRIGGER message_assistant_no_update BEFORE UPDATE ON message WHEN OLD.sender_kind IN ('assistant_event','assistant_work') OR NEW.sender_kind IN ('assistant_event','assistant_work') BEGIN SELECT RAISE(ABORT,'assistant_message_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER message_assistant_no_delete BEFORE DELETE ON message WHEN OLD.sender_kind IN ('assistant_event','assistant_work') BEGIN SELECT RAISE(ABORT,'assistant_message_immutable'); END;
