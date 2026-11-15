DROP VIEW IF EXISTS `chat_effective_member`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `chat_kind_immutable`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_chat_changed`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_control_disabled`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_delete`;--> statement-breakpoint
CREATE TABLE `delegation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_crew_chat_id` text NOT NULL,
	`child_chat_id` text NOT NULL,
	`dispatch_lead_profile_id` text NOT NULL,
	`crew_epoch` integer NOT NULL,
	`worker_profile_id` text NOT NULL,
	`worker_instance_id` text,
	`request_summary` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`result_revision` integer DEFAULT 0 NOT NULL,
	`client_request_id` text NOT NULL,
	`terminal_summary` text,
	`terminal_reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`settled_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dispatch_lead_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_crew_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delegation_status_check" CHECK("delegation"."status" in ('queued', 'running', 'blocked', 'completed', 'failed', 'canceling', 'canceled')),
	CONSTRAINT "delegation_attempt_check" CHECK("delegation"."attempt" >= 1),
	CONSTRAINT "delegation_revision_check" CHECK("delegation"."result_revision" >= 0),
	CONSTRAINT "delegation_terminal_check" CHECK(("delegation"."status" in ('queued', 'running', 'blocked', 'canceling') and "delegation"."settled_at" is null and "delegation"."terminal_reason" is null) or ("delegation"."status" in ('completed', 'failed', 'canceled') and "delegation"."settled_at" is not null and "delegation"."terminal_reason" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delegation_child_chat_unique` ON `delegation` (`child_chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `delegation_crew_request_unique` ON `delegation` (`parent_crew_chat_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `delegation_crew_status_idx` ON `delegation` (`parent_crew_chat_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `delegation_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`delegation_id` text NOT NULL,
	`event_id` text NOT NULL,
	`lead_profile_id` text NOT NULL,
	`crew_epoch` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`run_id` text,
	`message_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`attention_reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`bound_at` integer,
	`injected_at` integer,
	`acknowledged_at` integer,
	FOREIGN KEY (`delegation_id`) REFERENCES `delegation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `delegation_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delegation_delivery_state_check" CHECK("delegation_delivery"."state" in ('pending', 'bound', 'injected', 'acknowledged', 'stale', 'attention')),
	CONSTRAINT "delegation_delivery_shape_check" CHECK(("delegation_delivery"."state" in ('bound', 'injected', 'acknowledged') and "delegation_delivery"."run_id" is not null and "delegation_delivery"."message_id" is not null) or ("delegation_delivery"."state" in ('pending', 'stale', 'attention') and "delegation_delivery"."run_id" is null and "delegation_delivery"."message_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delegation_delivery_event_unique` ON `delegation_delivery` (`event_id`);--> statement-breakpoint
CREATE INDEX `delegation_delivery_state_idx` ON `delegation_delivery` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `delegation_event` (
	`id` text PRIMARY KEY NOT NULL,
	`delegation_id` text NOT NULL,
	`kind` text NOT NULL,
	`revision` integer NOT NULL,
	`summary` text NOT NULL,
	`result_artifact_id` text,
	`progress_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`delegation_id`) REFERENCES `delegation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delegation_event_kind_check" CHECK("delegation_event"."kind" in ('dispatched', 'blocked', 'completed', 'failed', 'canceled')),
	CONSTRAINT "delegation_event_revision_check" CHECK("delegation_event"."revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delegation_event_revision_unique` ON `delegation_event` (`delegation_id`,`revision`,`kind`);--> statement-breakpoint
CREATE TABLE `delegation_result` (
	`id` text PRIMARY KEY NOT NULL,
	`delegation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`mime_type` text DEFAULT 'text/html' NOT NULL,
	`byte_size` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`delegation_id`) REFERENCES `delegation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delegation_result_size_check" CHECK("delegation_result"."byte_size" between 1 and 262144)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delegation_result_delegation_unique` ON `delegation_result` (`delegation_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`parent_crew_chat_id` text,
	`lead_profile_id` text,
	`crew_epoch` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`wake_policy` text DEFAULT 'owner_led' NOT NULL,
	`governance_revision` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_profile_id`) REFERENCES `agent_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_crew_chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_kind_check" CHECK("__new_chat"."kind" in ('dm', 'crew', 'delegation')),
	CONSTRAINT "chat_title_check" CHECK("__new_chat"."title" is null or length(trim("__new_chat"."title")) between 1 and 80),
	CONSTRAINT "chat_owner_kind_check" CHECK("__new_chat"."owner_kind" in ('human', 'agent')),
	CONSTRAINT "chat_owner_id_check" CHECK(length(trim("__new_chat"."owner_id")) > 0),
	CONSTRAINT "chat_wake_policy_check" CHECK("__new_chat"."wake_policy" in ('mention_only', 'owner_led', 'contextual')),
	CONSTRAINT "chat_governance_revision_check" CHECK(typeof("__new_chat"."governance_revision") = 'integer' and "__new_chat"."governance_revision" >= 0),
	CONSTRAINT "chat_dm_owner_check" CHECK("__new_chat"."kind" <> 'dm' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_crew_owner_check" CHECK("__new_chat"."kind" <> 'crew' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_crew_epoch_check" CHECK(typeof("__new_chat"."crew_epoch") = 'integer' and "__new_chat"."crew_epoch" >= 0),
	CONSTRAINT "chat_crew_lead_check" CHECK("__new_chat"."kind" <> 'crew' or "__new_chat"."lead_profile_id" is null or length(trim("__new_chat"."lead_profile_id")) > 0),
	CONSTRAINT "chat_crew_wake_check" CHECK("__new_chat"."kind" <> 'crew' or "__new_chat"."wake_policy" <> 'contextual'),
	CONSTRAINT "chat_delegation_parent_check" CHECK(("__new_chat"."kind" = 'delegation' and "__new_chat"."parent_crew_chat_id" is not null) or ("__new_chat"."kind" <> 'delegation' and "__new_chat"."parent_crew_chat_id" is null)),
	CONSTRAINT "chat_delegation_owner_check" CHECK("__new_chat"."kind" <> 'delegation' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_lead_scope_check" CHECK("__new_chat"."kind" = 'crew' or "__new_chat"."lead_profile_id" is null)
);
--> statement-breakpoint
INSERT INTO `__new_chat`("id", "project_id", "kind", "title", "parent_crew_chat_id", "lead_profile_id", "crew_epoch", "archived_at", "owner_kind", "owner_id", "wake_policy", "governance_revision", "created_by", "created_at", "updated_at") SELECT "id", "project_id", "kind", "title", NULL, "lead_profile_id", "crew_epoch", "archived_at", "owner_kind", "owner_id", "wake_policy", "governance_revision", "created_by", "created_at", "updated_at" FROM `chat`;--> statement-breakpoint
DROP TABLE `chat`;--> statement-breakpoint
ALTER TABLE `__new_chat` RENAME TO `chat`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_id_project_unique` ON `chat` (`id`,`project_id`);--> statement-breakpoint
CREATE INDEX `chat_project_updated_idx` ON `chat` (`project_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `chat_project_owner_idx` ON `chat` (`project_id`,`owner_kind`,`owner_id`);--> statement-breakpoint
ALTER TABLE `message` ADD `delegation_id` text;--> statement-breakpoint
ALTER TABLE `message` ADD `delegation_prompt_for_chat_id` text REFERENCES chat(id);--> statement-breakpoint
CREATE INDEX `message_delegation_prompt_idx` ON `message` (`delegation_prompt_for_chat_id`);
--> statement-breakpoint
CREATE VIEW `chat_effective_member` AS 
  SELECT
    c.id AS chat_id,
    c.project_id,
    cm.member_kind,
    cm.member_id,
    cm.added_at,
    'chat_member' AS source
  FROM chat c
  JOIN chat_member cm ON cm.chat_id = c.id
  WHERE c.kind IN ('dm', 'crew') AND (
    cm.member_kind = 'human' OR c.kind = 'dm' OR EXISTS (
      SELECT 1 FROM project_member pm
      WHERE pm.project_id = c.project_id AND pm.agent_profile_id = cm.member_id
    )
  )
  UNION ALL
  SELECT c.id, c.project_id, 'human', cm.member_id, cm.added_at, 'delegation'
  FROM chat c
  JOIN delegation d ON d.child_chat_id = c.id
  JOIN chat p ON p.id = d.parent_crew_chat_id
  JOIN chat_member cm ON cm.chat_id = p.id AND cm.member_kind = 'human'
  WHERE c.kind = 'delegation'
  UNION ALL
  SELECT c.id, c.project_id, 'agent', p.lead_profile_id, d.created_at, 'delegation'
  FROM chat c
  JOIN delegation d ON d.child_chat_id = c.id
  JOIN chat p ON p.id = d.parent_crew_chat_id
  WHERE c.kind = 'delegation' AND p.lead_profile_id IS NOT NULL
  UNION ALL
  SELECT c.id, c.project_id, 'agent', d.worker_profile_id, d.created_at, 'delegation'
  FROM chat c
  JOIN delegation d ON d.child_chat_id = c.id
  WHERE c.kind = 'delegation'
;--> statement-breakpoint
CREATE TRIGGER `chat_kind_immutable` BEFORE UPDATE OF kind, project_id, id, created_by ON chat
WHEN NEW.kind <> OLD.kind OR NEW.project_id <> OLD.project_id OR
     NEW.id <> OLD.id OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'chat_identity_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `p6a_chat_changed` AFTER UPDATE OF owner_kind,owner_id,archived_at,wake_policy,governance_revision ON chat BEGIN
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.id AND state IN ('pending','claimed','retry_wait');
  UPDATE continuation_delivery SET state='canceled',cancel_reason=CASE WHEN NEW.archived_at IS NOT NULL THEN 'chat_archived' ELSE 'task_context_changed' END,next_attempt_at=NULL WHERE chat_id=NEW.id AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id=NEW.id AND state='presented';
  DELETE FROM chat_schedule WHERE chat_id=NEW.id AND NEW.archived_at IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `p6a_control_disabled` AFTER UPDATE OF mode,epoch ON chat_continuation_control WHEN NEW.mode<>'enabled' BEGIN
  DELETE FROM chat_schedule WHERE chat_id=NEW.chat_id;
  UPDATE wake_evaluation SET state='canceled',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state='pending';
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('claimed','retry_wait');
  UPDATE continuation_delivery SET state='canceled',cancel_reason='human_disabled',next_attempt_at=NULL WHERE chat_id=NEW.chat_id AND state IN ('pending','bound') AND admitted_at IS NULL;
  UPDATE continuation_delivery SET state='stale' WHERE chat_id=NEW.chat_id AND state='presented';
END;--> statement-breakpoint
CREATE TRIGGER `p6a_task_insert` AFTER INSERT ON task WHEN NEW.status='assigned' BEGIN
  INSERT OR IGNORE INTO chat_continuation_control(chat_id) VALUES(NEW.chat_id);
  INSERT OR IGNORE INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at)
    SELECT NEW.chat_id,NEW.project_id,NEW.updated_at+300000,coalesce((SELECT max(round) FROM wake_evaluation WHERE chat_id=NEW.chat_id),0),'',NEW.updated_at
    WHERE EXISTS(SELECT 1 FROM chat_continuation_control WHERE chat_id=NEW.chat_id AND mode='enabled')
      AND EXISTS(SELECT 1 FROM chat WHERE id=NEW.chat_id AND archived_at IS NULL);
END;--> statement-breakpoint
CREATE TRIGGER `p6a_task_update` AFTER UPDATE ON task BEGIN
  UPDATE continuation_delivery SET state='canceled',cancel_reason='task_context_changed',next_attempt_at=NULL
    WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state IN ('pending','bound') AND admitted_at IS NULL
      AND evaluation_id IN (SELECT id FROM wake_evaluation WHERE source='task_periodic');
  UPDATE continuation_delivery SET state='stale' WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state='presented'
      AND evaluation_id IN (SELECT id FROM wake_evaluation WHERE source='task_periodic');
  UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL
    WHERE chat_id IN (OLD.chat_id,NEW.chat_id) AND state IN ('pending','claimed','retry_wait') AND source='task_periodic';
  DELETE FROM chat_schedule WHERE chat_id IN (OLD.chat_id,NEW.chat_id)
    AND NOT EXISTS(SELECT 1 FROM task WHERE task.chat_id=chat_schedule.chat_id AND task.status='assigned');
  INSERT OR IGNORE INTO chat_continuation_control(chat_id) SELECT NEW.chat_id WHERE NEW.status='assigned';
  INSERT OR IGNORE INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at)
    SELECT NEW.chat_id,NEW.project_id,NEW.updated_at+300000,coalesce((SELECT max(round) FROM wake_evaluation WHERE chat_id=NEW.chat_id),0),'',NEW.updated_at
    WHERE NEW.status='assigned' AND EXISTS(SELECT 1 FROM chat_continuation_control WHERE chat_id=NEW.chat_id AND mode='enabled')
      AND EXISTS(SELECT 1 FROM chat WHERE id=NEW.chat_id AND archived_at IS NULL);
  UPDATE chat_schedule SET next_due_at=coalesce(next_due_at,NEW.updated_at+300000),updated_at=NEW.updated_at WHERE chat_id IN (OLD.chat_id,NEW.chat_id);
END;--> statement-breakpoint
CREATE TRIGGER `p6a_task_delete` AFTER DELETE ON task BEGIN
  DELETE FROM chat_schedule WHERE chat_id=OLD.chat_id AND NOT EXISTS(SELECT 1 FROM task WHERE chat_id=OLD.chat_id AND status='assigned');
END;
