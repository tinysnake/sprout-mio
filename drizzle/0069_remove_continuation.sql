DROP TRIGGER IF EXISTS `webhook_trigger_no_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `assistant_proposal_operation_immutable`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `automation_receipt_source_guard`;--> statement-breakpoint
DROP VIEW IF EXISTS `chat_effective_member`;--> statement-breakpoint
UPDATE `webhook_trigger` SET `snapshot` = json_remove(json_set(`snapshot`, '$.action.kind', 'crew'), '$.action.agentProfileId') WHERE json_extract(`snapshot`, '$.action.kind') IN ('group_agent','group_owner');--> statement-breakpoint
UPDATE `assistant_proposal` SET `target` = json_remove(json_set(`target`, '$.kind', 'crew'), '$.agentProfileId') WHERE json_extract(`target`, '$.kind') IN ('group_agent','group_owner');--> statement-breakpoint
CREATE TRIGGER webhook_trigger_no_update BEFORE UPDATE ON webhook_trigger BEGIN SELECT RAISE(ABORT,'webhook_trigger_immutable'); END;--> statement-breakpoint
CREATE TRIGGER assistant_proposal_operation_immutable BEFORE UPDATE ON assistant_proposal WHEN NEW.assistant_chat_id != OLD.assistant_chat_id OR NEW.source_run_id != OLD.source_run_id OR NEW.human_id != OLD.human_id OR NEW.target != OLD.target OR NEW.target_project_id != OLD.target_project_id OR NEW.target_chat_id != OLD.target_chat_id OR NEW.agent_profile_id != OLD.agent_profile_id OR NEW.instance_id != OLD.instance_id OR NEW.body != OLD.body OR NEW.operation_hash != OLD.operation_hash OR NEW.version != OLD.version OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at BEGIN SELECT RAISE(ABORT, 'assistant operation is immutable'); END;--> statement-breakpoint
ALTER TABLE `project` RENAME COLUMN "wake_policy" TO "runtime_policy";--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_chat_changed`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_control_disabled`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `p6a_task_delete`;--> statement-breakpoint
DROP TABLE `chat_continuation_abort`;--> statement-breakpoint
DROP TABLE `chat_continuation_command`;--> statement-breakpoint
DROP TABLE `chat_continuation_control`;--> statement-breakpoint
DROP TABLE `chat_message_wake`;--> statement-breakpoint
DROP TABLE `chat_schedule`;--> statement-breakpoint
DROP TABLE `continuation_delivery`;--> statement-breakpoint
DROP TABLE `continuation_delivery_task`;--> statement-breakpoint
DROP TABLE `project_wake_policy_command`;--> statement-breakpoint
DROP TABLE `wake_evaluation`;--> statement-breakpoint
DROP TABLE `wake_evaluation_attempt`;--> statement-breakpoint
DROP TABLE `wake_evaluation_task`;--> statement-breakpoint
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
	CONSTRAINT "chat_governance_revision_check" CHECK(typeof("__new_chat"."governance_revision") = 'integer' and "__new_chat"."governance_revision" >= 0),
	CONSTRAINT "chat_dm_owner_check" CHECK("__new_chat"."kind" <> 'dm' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_crew_owner_check" CHECK("__new_chat"."kind" <> 'crew' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_crew_epoch_check" CHECK(typeof("__new_chat"."crew_epoch") = 'integer' and "__new_chat"."crew_epoch" >= 0),
	CONSTRAINT "chat_crew_lead_check" CHECK("__new_chat"."kind" <> 'crew' or "__new_chat"."lead_profile_id" is null or length(trim("__new_chat"."lead_profile_id")) > 0),
	CONSTRAINT "chat_delegation_parent_check" CHECK(("__new_chat"."kind" = 'delegation' and "__new_chat"."parent_crew_chat_id" is not null) or ("__new_chat"."kind" <> 'delegation' and "__new_chat"."parent_crew_chat_id" is null)),
	CONSTRAINT "chat_delegation_owner_check" CHECK("__new_chat"."kind" <> 'delegation' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_lead_scope_check" CHECK("__new_chat"."kind" = 'crew' or "__new_chat"."lead_profile_id" is null)
);
--> statement-breakpoint
INSERT INTO `__new_chat`("id", "project_id", "kind", "title", "parent_crew_chat_id", "lead_profile_id", "crew_epoch", "archived_at", "owner_kind", "owner_id", "governance_revision", "created_by", "created_at", "updated_at") SELECT "id", "project_id", "kind", "title", "parent_crew_chat_id", "lead_profile_id", "crew_epoch", "archived_at", "owner_kind", "owner_id", "governance_revision", "created_by", "created_at", "updated_at" FROM `chat`;--> statement-breakpoint
DROP TABLE `chat`;--> statement-breakpoint
ALTER TABLE `__new_chat` RENAME TO `chat`;--> statement-breakpoint
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
  UNION ALL
  SELECT c.id, c.project_id, 'human', cm.member_id, cm.added_at, 'delegation'
  FROM chat c
  JOIN chat p ON p.id = c.parent_crew_chat_id
  JOIN chat_member cm ON cm.chat_id = p.id AND cm.member_kind = 'human'
  WHERE c.kind = 'delegation'
    AND NOT EXISTS (SELECT 1 FROM delegation d WHERE d.child_chat_id = c.id)
  UNION ALL
  SELECT c.id, c.project_id, 'agent', p.lead_profile_id, c.created_at, 'delegation'
  FROM chat c
  JOIN chat p ON p.id = c.parent_crew_chat_id
  WHERE c.kind = 'delegation'
    AND p.lead_profile_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM delegation d WHERE d.child_chat_id = c.id);
--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_id_project_unique` ON `chat` (`id`,`project_id`);--> statement-breakpoint
CREATE INDEX `chat_project_updated_idx` ON `chat` (`project_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `chat_project_owner_idx` ON `chat` (`project_id`,`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE TRIGGER `chat_kind_immutable` BEFORE UPDATE OF kind, project_id, id, created_by ON chat
WHEN NEW.kind <> OLD.kind OR NEW.project_id <> OLD.project_id OR
     NEW.id <> OLD.id OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'chat_identity_immutable');
END;--> statement-breakpoint
CREATE TABLE `__new_webhook_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`revision` integer NOT NULL,
	`instruction` text NOT NULL,
	`action` text NOT NULL,
	`source` text DEFAULT 'webhook' NOT NULL,
	`secret_digest` text,
	`recoverable_secret` text,
	`expression` text,
	`timezone` text,
	`next_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_rule_revision_check" CHECK(typeof("__new_webhook_rule"."revision")='integer' and "__new_webhook_rule"."revision">=0),
	CONSTRAINT "webhook_rule_secret_check" CHECK(coalesce(("__new_webhook_rule"."source"='webhook' and length("__new_webhook_rule"."secret_digest")=64 and "__new_webhook_rule"."secret_digest" not glob '*[^0-9a-f]*' and "__new_webhook_rule"."expression" is null and "__new_webhook_rule"."timezone" is null and "__new_webhook_rule"."next_at" is null) or ("__new_webhook_rule"."source"='cron' and "__new_webhook_rule"."secret_digest" is null and length(trim("__new_webhook_rule"."expression"))>0 and length(trim("__new_webhook_rule"."timezone"))>0 and (("__new_webhook_rule"."enabled"=1 and typeof("__new_webhook_rule"."next_at")='integer') or ("__new_webhook_rule"."enabled"=0 and "__new_webhook_rule"."next_at" is null))),0)),
	CONSTRAINT "automation_source_check" CHECK("__new_webhook_rule"."source" in ('webhook','cron')),
	CONSTRAINT "webhook_rule_action_check" CHECK(json_valid("__new_webhook_rule"."action") and coalesce(json_extract("__new_webhook_rule"."action", '$.kind') in ('dm_agent','crew') and (json_type("__new_webhook_rule"."action", '$.chatId')='text' or (json_extract("__new_webhook_rule"."action", '$.kind')='dm_agent' and json_type("__new_webhook_rule"."action", '$.chatId') is null)) and (json_extract("__new_webhook_rule"."action", '$.kind')='dm_agent' or json_type("__new_webhook_rule"."action", '$.chatId')='text') and (json_extract("__new_webhook_rule"."action", '$.kind')='crew' or json_type("__new_webhook_rule"."action", '$.agentProfileId')='text'),0))
);
--> statement-breakpoint
INSERT INTO `__new_webhook_rule`("id", "project_id", "created_by", "name", "enabled", "revision", "instruction", "action", "source", "secret_digest", "recoverable_secret", "expression", "timezone", "next_at", "created_at", "updated_at") SELECT "id", "project_id", "created_by", "name", "enabled", "revision", "instruction", (CASE WHEN json_extract(`action`, '$.kind') IN ('group_agent','group_owner') THEN json_remove(json_set(`action`, '$.kind', 'crew'), '$.agentProfileId') ELSE `action` END), "source", "secret_digest", "recoverable_secret", "expression", "timezone", "next_at", "created_at", "updated_at" FROM `webhook_rule`;--> statement-breakpoint
DROP TABLE `webhook_rule`;--> statement-breakpoint
ALTER TABLE `__new_webhook_rule` RENAME TO `webhook_rule`;--> statement-breakpoint
CREATE TRIGGER `automation_receipt_source_guard` BEFORE INSERT ON webhook_trigger WHEN NEW.source NOT IN ('webhook','cron') OR NOT EXISTS (SELECT 1 FROM webhook_rule r WHERE r.id=NEW.rule_id AND r.source=NEW.source) OR (NEW.source='cron' AND NOT coalesce(json_type(NEW.snapshot,'$.cron.expression')='text' AND json_type(NEW.snapshot,'$.cron.timezone')='text' AND ((NEW.mode='live' AND json_type(NEW.snapshot,'$.cron.scheduledAt')='text') OR (NEW.mode='trial' AND json_type(NEW.snapshot,'$.cron.scheduledAt')='null')),0)) OR (NEW.source='webhook' AND json_type(NEW.snapshot,'$.cron') IS NOT NULL) BEGIN SELECT RAISE(ABORT,'automation_receipt_source_invalid'); END;--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_rule_id_project_unique` ON `webhook_rule` (`id`,`project_id`);
--> statement-breakpoint
CREATE TRIGGER automation_rule_source_immutable BEFORE UPDATE OF source ON webhook_rule WHEN NEW.source<>OLD.source BEGIN SELECT RAISE(ABORT,'automation_rule_source_immutable'); END;