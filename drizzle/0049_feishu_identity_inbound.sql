CREATE TABLE `feishu_challenge` (
	`hash` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`revision` integer NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`consumed_at_ms` integer,
	FOREIGN KEY (`human_id`) REFERENCES `feishu_identity_slot`(`human_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `feishu_connection_epoch` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`opened_at_ms` integer NOT NULL,
	`opened_by` text NOT NULL,
	`closed_at_ms` integer,
	CONSTRAINT "feishu_epoch_reason" CHECK("feishu_connection_epoch"."opened_by" IN ('ready','reconnected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_epoch_active_unique` ON `feishu_connection_epoch` (`app_id`) WHERE "feishu_connection_epoch"."closed_at_ms" IS NULL;--> statement-breakpoint
CREATE TABLE `feishu_identity_slot` (
	`human_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`app_id` text,
	`tenant_key` text,
	`open_id` text,
	FOREIGN KEY (`human_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feishu_slot_revision" CHECK("feishu_identity_slot"."revision" >= 0),
	CONSTRAINT "feishu_slot_identity" CHECK(("feishu_identity_slot"."app_id" IS NULL AND "feishu_identity_slot"."tenant_key" IS NULL AND "feishu_identity_slot"."open_id" IS NULL) OR ("feishu_identity_slot"."app_id" IS NOT NULL AND "feishu_identity_slot"."tenant_key" IS NOT NULL AND "feishu_identity_slot"."open_id" IS NOT NULL AND length("feishu_identity_slot"."app_id") > 0 AND length("feishu_identity_slot"."tenant_key") > 0 AND length("feishu_identity_slot"."open_id") > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_identity_active_unique` ON `feishu_identity_slot` (`app_id`,`tenant_key`,`open_id`);--> statement-breakpoint
CREATE TABLE `feishu_inbound_receipt` (
	`app_id` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`route_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`app_id`, `platform_message_id`),
	FOREIGN KEY (`route_id`) REFERENCES `feishu_route`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`epoch_id`) REFERENCES `feishu_connection_epoch`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_receipt_message_unique` ON `feishu_inbound_receipt` (`message_id`);--> statement-breakpoint
CREATE TABLE `feishu_route` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`revision` integer NOT NULL,
	`app_id` text NOT NULL,
	`tenant_key` text NOT NULL,
	`open_id` text NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`closed_at_ms` integer,
	FOREIGN KEY (`human_id`) REFERENCES `feishu_identity_slot`(`human_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`,`project_id`) REFERENCES `chat`(`id`,`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_route_generation_unique` ON `feishu_route` (`human_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_route_active_unique` ON `feishu_route` (`human_id`) WHERE "feishu_route"."closed_at_ms" IS NULL;
--> statement-breakpoint
CREATE TRIGGER feishu_route_immutable BEFORE UPDATE ON feishu_route
WHEN NEW.id IS NOT OLD.id OR NEW.human_id IS NOT OLD.human_id OR NEW.revision IS NOT OLD.revision OR NEW.app_id IS NOT OLD.app_id OR NEW.tenant_key IS NOT OLD.tenant_key OR NEW.open_id IS NOT OLD.open_id OR NEW.project_id IS NOT OLD.project_id OR NEW.chat_id IS NOT OLD.chat_id OR (OLD.closed_at_ms IS NOT NULL AND NEW.closed_at_ms IS NOT OLD.closed_at_ms)
BEGIN SELECT RAISE(ABORT, 'feishu route is immutable'); END;