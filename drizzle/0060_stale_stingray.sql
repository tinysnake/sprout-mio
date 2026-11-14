DROP VIEW IF EXISTS `chat_effective_member`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `chat_member_no_channel_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `chat_kind_immutable`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_chat_changed`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_control_disabled`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_delete`;--> statement-breakpoint
CREATE TABLE `crew_control` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'active' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "crew_control_mode_check" CHECK("crew_control"."mode" in ('active', 'stopped'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
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
	CONSTRAINT "chat_kind_check" CHECK("__new_chat"."kind" in ('dm', 'crew')),
	CONSTRAINT "chat_title_check" CHECK("__new_chat"."title" is null or length(trim("__new_chat"."title")) between 1 and 80),
	CONSTRAINT "chat_owner_kind_check" CHECK("__new_chat"."owner_kind" in ('human', 'agent')),
	CONSTRAINT "chat_owner_id_check" CHECK(length(trim("__new_chat"."owner_id")) > 0),
	CONSTRAINT "chat_wake_policy_check" CHECK("__new_chat"."wake_policy" in ('mention_only', 'owner_led', 'contextual')),
	CONSTRAINT "chat_governance_revision_check" CHECK(typeof("__new_chat"."governance_revision") = 'integer' and "__new_chat"."governance_revision" >= 0),
	CONSTRAINT "chat_dm_owner_check" CHECK("__new_chat"."kind" <> 'dm' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_crew_owner_check" CHECK("__new_chat"."kind" <> 'crew' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_crew_epoch_check" CHECK(typeof("__new_chat"."crew_epoch") = 'integer' and "__new_chat"."crew_epoch" >= 0),
	CONSTRAINT "chat_crew_lead_check" CHECK("__new_chat"."kind" <> 'crew' or "__new_chat"."lead_profile_id" is null or length(trim("__new_chat"."lead_profile_id")) > 0),
	CONSTRAINT "chat_crew_wake_check" CHECK("__new_chat"."kind" <> 'crew' or "__new_chat"."wake_policy" <> 'contextual')
);
--> statement-breakpoint
INSERT INTO `__new_chat`("id", "project_id", "kind", "title", "lead_profile_id", "crew_epoch", "archived_at", "owner_kind", "owner_id", "wake_policy", "governance_revision", "created_by", "created_at", "updated_at") SELECT "id", "project_id", CASE WHEN "kind" = 'dm' THEN 'dm' ELSE 'crew' END, "title", CASE WHEN "kind" = 'dm' THEN NULL WHEN "owner_kind" = 'agent' THEN "owner_id" ELSE NULL END, 0, "archived_at", CASE WHEN "kind" = 'dm' THEN "owner_kind" ELSE 'human' END, CASE WHEN "kind" = 'dm' THEN "owner_id" ELSE "created_by" END, CASE WHEN "kind" = 'dm' THEN "wake_policy" WHEN "wake_policy" = 'contextual' THEN 'owner_led' ELSE "wake_policy" END, "governance_revision", "created_by", "created_at", "updated_at" FROM `chat`;--> statement-breakpoint
DROP TABLE `chat`;--> statement-breakpoint
ALTER TABLE `__new_chat` RENAME TO `chat`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_id_project_unique` ON `chat` (`id`,`project_id`);--> statement-breakpoint
CREATE INDEX `chat_project_updated_idx` ON `chat` (`project_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `chat_project_owner_idx` ON `chat` (`project_id`,`owner_kind`,`owner_id`);--> statement-breakpoint
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
