PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__feishu_project_attribution_guard` (
  `invalid_slots` integer NOT NULL,
  CONSTRAINT `feishu_identity_slot_requires_route_or_challenge_project` CHECK (`invalid_slots` = 0)
);
--> statement-breakpoint
INSERT INTO `__feishu_project_attribution_guard`
SELECT count(*) FROM `feishu_identity_slot` s
WHERE NOT EXISTS (SELECT 1 FROM `feishu_route` r WHERE r.human_id = s.human_id)
  AND NOT EXISTS (SELECT 1 FROM `feishu_challenge` c WHERE c.human_id = s.human_id)
  OR (s.app_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `feishu_route` r WHERE r.human_id = s.human_id
      AND r.closed_at_ms IS NULL AND r.app_id = s.app_id
      AND r.tenant_key = s.tenant_key AND r.open_id = s.open_id
  ));
--> statement-breakpoint
DROP TABLE `__feishu_project_attribution_guard`;
--> statement-breakpoint
CREATE TABLE `channel_config` (
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`secrets` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`updated_by_human_id` text,
	PRIMARY KEY(`project_id`, `kind`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_human_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channel_config_enabled_check" CHECK("channel_config"."enabled" in (0,1)),
	CONSTRAINT "channel_config_revision_check" CHECK("channel_config"."revision" >= 0),
	CONSTRAINT "channel_config_settings_json_check" CHECK(json_valid("channel_config"."settings")),
	CONSTRAINT "channel_config_secrets_json_check" CHECK(json_valid("channel_config"."secrets"))
);
--> statement-breakpoint
CREATE TABLE `__new_feishu_challenge` (
	`hash` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`revision` integer NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`consumed_at_ms` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`,`project_id`) REFERENCES `feishu_identity_slot`(`human_id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_feishu_challenge`("hash", "human_id", "revision", "project_id", "chat_id", "expires_at_ms", "consumed_at_ms") SELECT "hash", "human_id", "revision", "project_id", "chat_id", "expires_at_ms", "consumed_at_ms" FROM `feishu_challenge`;--> statement-breakpoint
DROP TABLE `feishu_challenge`;--> statement-breakpoint
ALTER TABLE `__new_feishu_challenge` RENAME TO `feishu_challenge`;--> statement-breakpoint
CREATE TABLE `__new_feishu_route` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`revision` integer NOT NULL,
	`app_id` text NOT NULL,
	`tenant_key` text NOT NULL,
	`open_id` text NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`opened_at_ms` integer DEFAULT 0 NOT NULL,
	`closed_at_ms` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`,`project_id`) REFERENCES `feishu_identity_slot`(`human_id`,`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_feishu_route`("id", "human_id", "revision", "app_id", "tenant_key", "open_id", "project_id", "chat_id", "opened_at_ms", "closed_at_ms") SELECT "id", "human_id", "revision", "app_id", "tenant_key", "open_id", "project_id", "chat_id", "opened_at_ms", "closed_at_ms" FROM `feishu_route`;--> statement-breakpoint
DROP TABLE `feishu_route`;--> statement-breakpoint
ALTER TABLE `__new_feishu_route` RENAME TO `feishu_route`;--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_route_generation_unique` ON `feishu_route` (`human_id`,`project_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_route_active_unique` ON `feishu_route` (`human_id`,`project_id`) WHERE "feishu_route"."closed_at_ms" IS NULL;--> statement-breakpoint
CREATE TABLE `__new_feishu_identity_slot` (
	`human_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`app_id` text,
	`tenant_key` text,
	`open_id` text,
	PRIMARY KEY(`human_id`, `project_id`),
	FOREIGN KEY (`human_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feishu_slot_revision" CHECK("__new_feishu_identity_slot"."revision" >= 0),
	CONSTRAINT "feishu_slot_identity" CHECK(("__new_feishu_identity_slot"."app_id" IS NULL AND "__new_feishu_identity_slot"."tenant_key" IS NULL AND "__new_feishu_identity_slot"."open_id" IS NULL) OR ("__new_feishu_identity_slot"."app_id" IS NOT NULL AND "__new_feishu_identity_slot"."tenant_key" IS NOT NULL AND "__new_feishu_identity_slot"."open_id" IS NOT NULL AND length("__new_feishu_identity_slot"."app_id") > 0 AND length("__new_feishu_identity_slot"."tenant_key") > 0 AND length("__new_feishu_identity_slot"."open_id") > 0))
);
--> statement-breakpoint
INSERT INTO `__new_feishu_identity_slot`("human_id", "project_id", "revision", "app_id", "tenant_key", "open_id")
SELECT s.human_id, p.project_id, s.revision,
  CASE WHEN r.id IS NOT NULL THEN s.app_id END,
  CASE WHEN r.id IS NOT NULL THEN s.tenant_key END,
  CASE WHEN r.id IS NOT NULL THEN s.open_id END
FROM `feishu_identity_slot` s
JOIN (SELECT human_id, project_id FROM `feishu_route` UNION SELECT human_id, project_id FROM `feishu_challenge`) p ON p.human_id = s.human_id
LEFT JOIN `feishu_route` r ON r.human_id = s.human_id AND r.project_id = p.project_id
  AND r.closed_at_ms IS NULL AND r.app_id = s.app_id AND r.tenant_key = s.tenant_key AND r.open_id = s.open_id;--> statement-breakpoint
DROP TABLE `feishu_identity_slot`;--> statement-breakpoint
ALTER TABLE `__new_feishu_identity_slot` RENAME TO `feishu_identity_slot`;--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_identity_active_unique` ON `feishu_identity_slot` (`app_id`,`tenant_key`,`open_id`);
--> statement-breakpoint
CREATE TRIGGER feishu_route_immutable BEFORE UPDATE ON feishu_route
WHEN NEW.id IS NOT OLD.id OR NEW.human_id IS NOT OLD.human_id OR NEW.revision IS NOT OLD.revision OR NEW.app_id IS NOT OLD.app_id OR NEW.tenant_key IS NOT OLD.tenant_key OR NEW.open_id IS NOT OLD.open_id OR NEW.project_id IS NOT OLD.project_id OR NEW.chat_id IS NOT OLD.chat_id OR NEW.opened_at_ms IS NOT OLD.opened_at_ms OR (OLD.closed_at_ms IS NOT NULL AND NEW.closed_at_ms IS NOT OLD.closed_at_ms)
BEGIN SELECT RAISE(ABORT, 'feishu route is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER feishu_route_activation_required BEFORE INSERT ON feishu_route
WHEN NEW.opened_at_ms <= 0
BEGIN SELECT RAISE(ABORT, 'feishu route activation required'); END;
--> statement-breakpoint
PRAGMA foreign_keys=ON;