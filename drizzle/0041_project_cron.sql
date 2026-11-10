PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "webhook_rule_action_check" CHECK(json_valid("__new_webhook_rule"."action") and coalesce(json_extract("__new_webhook_rule"."action", '$.kind') in ('dm_agent','group_agent','group_owner') and json_type("__new_webhook_rule"."action", '$.chatId')='text' and (json_extract("__new_webhook_rule"."action", '$.kind')='group_owner' or json_type("__new_webhook_rule"."action", '$.agentProfileId')='text'),0))
);
--> statement-breakpoint
INSERT INTO `__new_webhook_rule`("id", "project_id", "created_by", "name", "enabled", "revision", "instruction", "action", "source", "secret_digest", "expression", "timezone", "next_at", "created_at", "updated_at") SELECT "id", "project_id", "created_by", "name", "enabled", "revision", "instruction", "action", 'webhook', "secret_digest", NULL, NULL, NULL, "created_at", "updated_at" FROM `webhook_rule` ORDER BY rowid;--> statement-breakpoint
DROP TABLE `webhook_rule`;--> statement-breakpoint
ALTER TABLE `__new_webhook_rule` RENAME TO `webhook_rule`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_rule_id_project_unique` ON `webhook_rule` (`id`,`project_id`);--> statement-breakpoint
ALTER TABLE `webhook_trigger` ADD `source` text DEFAULT 'webhook' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER automation_rule_source_immutable BEFORE UPDATE OF source ON webhook_rule WHEN NEW.source<>OLD.source BEGIN SELECT RAISE(ABORT,'automation_rule_source_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER automation_receipt_source_guard BEFORE INSERT ON webhook_trigger WHEN NEW.source NOT IN ('webhook','cron') OR NOT EXISTS (SELECT 1 FROM webhook_rule r WHERE r.id=NEW.rule_id AND r.source=NEW.source) OR (NEW.source='cron' AND NOT coalesce(json_type(NEW.snapshot,'$.cron.expression')='text' AND json_type(NEW.snapshot,'$.cron.timezone')='text' AND ((NEW.mode='live' AND json_type(NEW.snapshot,'$.cron.scheduledAt')='text') OR (NEW.mode='trial' AND json_type(NEW.snapshot,'$.cron.scheduledAt')='null')),0)) OR (NEW.source='webhook' AND json_type(NEW.snapshot,'$.cron') IS NOT NULL) BEGIN SELECT RAISE(ABORT,'automation_receipt_source_invalid'); END;