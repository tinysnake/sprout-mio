PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER automation_receipt_source_guard;--> statement-breakpoint
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
	CONSTRAINT "webhook_rule_action_check" CHECK(json_valid("__new_webhook_rule"."action") and coalesce(json_extract("__new_webhook_rule"."action", '$.kind') in ('dm_agent','group_agent','group_owner') and (json_type("__new_webhook_rule"."action", '$.chatId')='text' or (json_extract("__new_webhook_rule"."action", '$.kind')='dm_agent' and json_type("__new_webhook_rule"."action", '$.chatId') is null)) and (json_extract("__new_webhook_rule"."action", '$.kind')='group_owner' or json_type("__new_webhook_rule"."action", '$.agentProfileId')='text'),0))
);
--> statement-breakpoint
INSERT INTO `__new_webhook_rule`("id", "project_id", "created_by", "name", "enabled", "revision", "instruction", "action", "source", "secret_digest", "recoverable_secret", "expression", "timezone", "next_at", "created_at", "updated_at") SELECT "id", "project_id", "created_by", "name", "enabled", "revision", "instruction", "action", "source", "secret_digest", NULL, "expression", "timezone", "next_at", "created_at", "updated_at" FROM `webhook_rule`;--> statement-breakpoint
DROP TABLE `webhook_rule`;--> statement-breakpoint
ALTER TABLE `__new_webhook_rule` RENAME TO `webhook_rule`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_rule_id_project_unique` ON `webhook_rule` (`id`,`project_id`);--> statement-breakpoint
CREATE TABLE `__new_assistant_watch` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_chat_id` text NOT NULL,
	`target_project_id` text NOT NULL,
	`target_chat_id` text NOT NULL,
	`consented_by` text NOT NULL,
	`interval_seconds` integer DEFAULT 300 NOT NULL,
	`consented_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`assistant_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`consented_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assistant_watch_interval_check" CHECK(typeof("__new_assistant_watch"."interval_seconds")='integer' and "__new_assistant_watch"."interval_seconds" between 60 and 86400)
);
--> statement-breakpoint
INSERT INTO `__new_assistant_watch`("id", "assistant_chat_id", "target_project_id", "target_chat_id", "consented_by", "interval_seconds", "consented_at", "revoked_at") SELECT w."id", w."assistant_chat_id", w."target_project_id", w."target_chat_id", w."consented_by", coalesce((SELECT p.interval_seconds FROM assistant_preferences p WHERE p.assistant_chat_id=w.assistant_chat_id),300), w."consented_at", w."revoked_at" FROM `assistant_watch` w;--> statement-breakpoint
DROP TABLE `assistant_watch`;--> statement-breakpoint
ALTER TABLE `__new_assistant_watch` RENAME TO `assistant_watch`;--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_watch_active_unique` ON `assistant_watch` (`assistant_chat_id`,`target_chat_id`) WHERE "assistant_watch"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `assistant_watch_target_idx` ON `assistant_watch` (`target_chat_id`,`revoked_at`);
--> statement-breakpoint

CREATE TRIGGER automation_rule_source_immutable BEFORE UPDATE OF source ON webhook_rule WHEN NEW.source<>OLD.source BEGIN SELECT RAISE(ABORT,'automation_rule_source_immutable'); END;

--> statement-breakpoint

CREATE TRIGGER automation_receipt_source_guard BEFORE INSERT ON webhook_trigger WHEN NEW.source NOT IN ('webhook','cron') OR NOT EXISTS (SELECT 1 FROM webhook_rule r WHERE r.id=NEW.rule_id AND r.source=NEW.source) OR (NEW.source='cron' AND NOT coalesce(json_type(NEW.snapshot,'$.cron.expression')='text' AND json_type(NEW.snapshot,'$.cron.timezone')='text' AND ((NEW.mode='live' AND json_type(NEW.snapshot,'$.cron.scheduledAt')='text') OR (NEW.mode='trial' AND json_type(NEW.snapshot,'$.cron.scheduledAt')='null')),0)) OR (NEW.source='webhook' AND json_type(NEW.snapshot,'$.cron') IS NOT NULL) BEGIN SELECT RAISE(ABORT,'automation_receipt_source_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER assistant_watch_consent_immutable BEFORE UPDATE ON assistant_watch WHEN NEW.assistant_chat_id IS NOT OLD.assistant_chat_id OR NEW.target_project_id IS NOT OLD.target_project_id OR NEW.target_chat_id IS NOT OLD.target_chat_id OR NEW.consented_by IS NOT OLD.consented_by OR NEW.consented_at IS NOT OLD.consented_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) BEGIN SELECT RAISE(ABORT, 'assistant watch consent is immutable'); END;