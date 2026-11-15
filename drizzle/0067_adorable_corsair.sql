PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_automation_no_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_automation_no_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_finished_record`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_task_append_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_task_no_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_task_no_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_event_boundary`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `agent_run_no_task_assistant`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `agent_run_no_task_assistant_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_input_admission_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_input_admission_guard_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_assistant_no_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_assistant_no_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `assistant_message_no_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `assistant_message_no_delete`;--> statement-breakpoint
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
	`delegation_id` text,
	`delegation_prompt_for_chat_id` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assistant_event_id`) REFERENCES `assistant_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assistant_proposal_id`) REFERENCES `assistant_proposal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_trigger_id`) REFERENCES `webhook_trigger`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_author_run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delegation_prompt_for_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_trigger_id`,`id`,`chat_id`) REFERENCES `webhook_trigger`(`id`,`message_id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`task_project_id`) REFERENCES `task`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`task_project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_reference_message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_sender_kind_check" CHECK("__new_message"."sender_kind" in ('human', 'agent', 'automation', 'assistant_event', 'assistant_work', 'delegation_event')),
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
INSERT INTO `__new_message`("id", "chat_id", "sender_kind", "sender_id", "body", "assistant_event_id", "assistant_proposal_id", "automation_trigger_id", "task_id", "task_project_id", "task_record_seq", "task_record_kind", "task_reference_message_id", "task_author_run_id", "task_assignment_revision", "task_governance_revision", "task_start_recipient_id", "delegation_id", "delegation_prompt_for_chat_id", "created_at") SELECT "id", "chat_id", "sender_kind", "sender_id", "body", "assistant_event_id", "assistant_proposal_id", "automation_trigger_id", "task_id", "task_project_id", "task_record_seq", "task_record_kind", "task_reference_message_id", "task_author_run_id", "task_assignment_revision", "task_governance_revision", "task_start_recipient_id", "delegation_id", "delegation_prompt_for_chat_id", "created_at" FROM `message`;--> statement-breakpoint
DROP TABLE `message`;--> statement-breakpoint
ALTER TABLE `__new_message` RENAME TO `message`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `message_assistant_event_unique` ON `message` (`assistant_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_delegation_event_unique` ON `message` (`delegation_id`) WHERE "message"."sender_kind" = 'delegation_event';--> statement-breakpoint
CREATE UNIQUE INDEX `message_assistant_proposal_unique` ON `message` (`assistant_proposal_id`);--> statement-breakpoint
CREATE INDEX `message_chat_created_at_idx` ON `message` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_id_chat_unique` ON `message` (`id`,`chat_id`);--> statement-breakpoint
CREATE INDEX `message_delegation_prompt_idx` ON `message` (`delegation_prompt_for_chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_task_seq_unique` ON `message` (`task_id`,`task_record_seq`);--> statement-breakpoint
INSERT INTO `message` (`id`,`chat_id`,`sender_kind`,`sender_id`,`body`,`delegation_id`,`created_at`)
SELECT 'msg_' || lower(hex(randomblob(8))), d.parent_crew_chat_id, 'delegation_event', d.id,
       coalesce(d.terminal_summary, ''), d.id, coalesce(d.settled_at, d.updated_at)
FROM `delegation` d
WHERE d.status IN ('completed','failed','canceled')
  AND NOT EXISTS (
    SELECT 1 FROM `message` m
    WHERE m.delegation_id = d.id AND m.sender_kind = 'delegation_event'
  );
--> statement-breakpoint
CREATE TRIGGER message_automation_no_update BEFORE UPDATE ON message WHEN OLD.sender_kind='automation' OR NEW.sender_kind='automation' BEGIN SELECT RAISE(ABORT,'automation_message_immutable'); END;--> statement-breakpoint
CREATE TRIGGER message_automation_no_delete BEFORE DELETE ON message WHEN OLD.sender_kind='automation' BEGIN SELECT RAISE(ABORT,'automation_message_immutable'); END;--> statement-breakpoint
CREATE TRIGGER task_finished_record BEFORE UPDATE ON task WHEN NEW.status='finished' AND NOT EXISTS (SELECT 1 FROM message WHERE task_id=NEW.id AND task_record_seq=(SELECT max(task_record_seq) FROM message WHERE task_id=NEW.id) AND task_record_kind IN ('progress','correction')) BEGIN SELECT RAISE(ABORT,'task_record_required'); END;--> statement-breakpoint
CREATE TRIGGER message_task_append_guard BEFORE INSERT ON message WHEN NEW.task_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM task t WHERE t.id=NEW.task_id AND t.project_id=NEW.task_project_id AND t.chat_id=NEW.chat_id AND ((NEW.task_record_kind IN ('start','progress') AND t.status='assigned') OR (NEW.task_record_kind='correction' AND t.status='finished' AND NEW.sender_kind='human'))) OR NEW.task_record_seq<>(SELECT coalesce(max(task_record_seq),0)+1 FROM message WHERE task_id=NEW.task_id) OR (NEW.sender_kind='agent' AND NOT EXISTS (SELECT 1 FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id AND i.project_id=r.project_id AND i.chat_id=r.chat_id WHERE r.id=NEW.task_author_run_id AND r.status IN ('queued','running') AND r.project_id=NEW.task_project_id AND r.chat_id=NEW.chat_id AND i.agent_profile_id=NEW.sender_id))) BEGIN SELECT RAISE(ABORT,'task_record_invalid'); END;--> statement-breakpoint
CREATE TRIGGER message_task_no_update BEFORE UPDATE ON message WHEN OLD.task_id IS NOT NULL OR NEW.task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'task_record_immutable'); END;--> statement-breakpoint
CREATE TRIGGER message_task_no_delete BEFORE DELETE ON message WHEN OLD.task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'task_record_immutable'); END;--> statement-breakpoint
CREATE TRIGGER task_event_boundary BEFORE INSERT ON task_event WHEN NOT EXISTS (SELECT 1 FROM task t WHERE t.id=NEW.task_id AND t.project_id=NEW.project_id AND t.revision=NEW.seq AND t.status=NEW.to_status AND t.chat_id IS NEW.to_chat_id AND NEW.record_seq_at_event IS (SELECT max(task_record_seq) FROM message WHERE task_id=t.id)) BEGIN SELECT RAISE(ABORT,'task_event_invalid'); END;--> statement-breakpoint
CREATE TRIGGER agent_run_no_task_assistant BEFORE INSERT ON agent_run WHEN NEW.assistant_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM message WHERE id=NEW.assistant_message_id AND task_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'task_record_not_assistant'); END;--> statement-breakpoint
CREATE TRIGGER agent_run_no_task_assistant_update BEFORE UPDATE OF assistant_message_id ON agent_run WHEN NEW.assistant_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM message WHERE id=NEW.assistant_message_id AND task_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'task_record_not_assistant'); END;--> statement-breakpoint
CREATE TRIGGER task_input_admission_guard BEFORE UPDATE ON agent_run_input WHEN (OLD.admitted_at IS NOT NULL AND (NEW.admitted_at IS NOT OLD.admitted_at OR NEW.message_id<>OLD.message_id)) OR (NEW.admitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message WHERE id=NEW.message_id AND (task_record_kind='start' OR sender_kind IN ('automation','assistant_work')))) BEGIN SELECT RAISE(ABORT,'task_input_invalid'); END;--> statement-breakpoint
CREATE TRIGGER task_input_admission_guard_insert BEFORE INSERT ON agent_run_input WHEN NEW.admitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message WHERE id=NEW.message_id AND (task_record_kind='start' OR sender_kind IN ('automation','assistant_work'))) BEGIN SELECT RAISE(ABORT,'task_input_invalid'); END;--> statement-breakpoint
CREATE TRIGGER message_assistant_no_update BEFORE UPDATE ON message WHEN OLD.sender_kind IN ('assistant_event','assistant_work') OR NEW.sender_kind IN ('assistant_event','assistant_work') BEGIN SELECT RAISE(ABORT,'assistant_message_immutable'); END;--> statement-breakpoint
CREATE TRIGGER message_assistant_no_delete BEFORE DELETE ON message WHEN OLD.sender_kind IN ('assistant_event','assistant_work') BEGIN SELECT RAISE(ABORT,'assistant_message_immutable'); END;--> statement-breakpoint
CREATE TRIGGER assistant_message_no_update BEFORE UPDATE ON message WHEN OLD.sender_kind IN ('assistant_event', 'assistant_work') BEGIN SELECT RAISE(ABORT, 'assistant messages are immutable'); END;--> statement-breakpoint
CREATE TRIGGER assistant_message_no_delete BEFORE DELETE ON message WHEN OLD.sender_kind IN ('assistant_event', 'assistant_work') BEGIN SELECT RAISE(ABORT, 'assistant messages are immutable'); END;
