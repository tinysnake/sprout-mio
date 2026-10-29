-- 裁定 d9：`agent_run.assistant_message_id` 必须与 run 同属一个 chat。SQLite 不能在既有表上追加复合外键，
-- 因此按「建新表 → 复制数据 → 删旧表 → 改名」重建，既有列、4 条 CHECK、4 个外键与 4 个索引逐条保留。
-- 唯一改动：单列 `assistant_message_id` → `message(id)` 换成复合 `(assistant_message_id, chat_id)` →
-- `message(id, chat_id)`；目标由 0021 建的唯一索引 `message_id_chat_unique` 提供，跨 chat 绑定因此有物理底线。
-- agent_run 本身没有 DEFERRABLE 外键（该修饰只出现在 worker_exchange_frame 那组），本次重建不涉及它；
-- 引用 agent_run 的既有复合外键（remote_execution、lease 等）在改名后继续指向同名表，定义与可延迟性都不变。
-- PRAGMA foreign_keys 在事务内无效，连接级关闭由 src/db/migrate.ts 负责；这里的显式开关与 0021 一致。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`project_id` text NOT NULL,
	`request_id` text NOT NULL,
	`status` text NOT NULL,
	`queued_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`settled_at` integer,
	`stop_reason` text,
	`error_code` text,
	`error_message` text,
	`session_id` text NOT NULL,
	`config_snapshot` text,
	`assistant_message_id` text,
	FOREIGN KEY (`instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assistant_message_id`,`chat_id`) REFERENCES `message`(`id`,`chat_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_status_check" CHECK("__new_agent_run"."status" in ('queued', 'running', 'completed', 'failed', 'aborted', 'interrupted')),
	CONSTRAINT "agent_run_timestamps_check" CHECK((
      ("__new_agent_run"."status" = 'queued' and "__new_agent_run"."started_at" is null and "__new_agent_run"."settled_at" is null)
      or ("__new_agent_run"."status" = 'running' and "__new_agent_run"."started_at" is not null and "__new_agent_run"."settled_at" is null)
      or ("__new_agent_run"."status" in ('completed', 'failed', 'aborted', 'interrupted') and "__new_agent_run"."settled_at" is not null)
    )),
	CONSTRAINT "agent_run_completed_check" CHECK("__new_agent_run"."status" != 'completed' or (
      "__new_agent_run"."assistant_message_id" is not null and "__new_agent_run"."config_snapshot" is not null
      and "__new_agent_run"."started_at" is not null and "__new_agent_run"."stop_reason" is not null and "__new_agent_run"."stop_reason" = 'stop'
      and "__new_agent_run"."error_code" is null and "__new_agent_run"."error_message" is null
    )),
	CONSTRAINT "agent_run_failed_check" CHECK("__new_agent_run"."status" != 'failed' or (
      "__new_agent_run"."error_code" is not null and "__new_agent_run"."error_message" is not null and "__new_agent_run"."error_message" != ''
    ))
);
--> statement-breakpoint
INSERT INTO `__new_agent_run`("id", "instance_id", "chat_id", "project_id", "request_id", "status", "queued_at", "started_at", "settled_at", "stop_reason", "error_code", "error_message", "session_id", "config_snapshot", "assistant_message_id") SELECT "id", "instance_id", "chat_id", "project_id", "request_id", "status", "queued_at", "started_at", "settled_at", "stop_reason", "error_code", "error_message", "session_id", "config_snapshot", "assistant_message_id" FROM `agent_run`;--> statement-breakpoint
DROP TABLE `agent_run`;--> statement-breakpoint
ALTER TABLE `__new_agent_run` RENAME TO `agent_run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_one_active_instance` ON `agent_run` (`instance_id`) WHERE "agent_run"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `agent_run_chat_queued_idx` ON `agent_run` (`chat_id`,`queued_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_assistant_message_unique` ON `agent_run` (`assistant_message_id`) WHERE "agent_run"."assistant_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_bound_identity_unique` ON `agent_run` (`id`,`instance_id`,`project_id`,`chat_id`);
