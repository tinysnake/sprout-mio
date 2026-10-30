-- I-P5a 多人 Chat 数据形状：chat 合并所有者与唤醒策略、chat_member 只承载 DM 与 Group 并加保护触发器、
-- agent_run_input 主键改 (run_id, message_id) 以支持一条消息扇出给多条 run、message 与 agent_run 补回复归属索引。
-- 结构变更全部按「建新表 → 复制数据 → 删旧表 → 改名」执行，既有列与外键逐条保留。
-- PRAGMA foreign_keys 在事务内无效，连接级关闭由 src/db/migrate.ts 负责；这里的显式开关与 0010 保持一致。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`archived_at` integer,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`wake_policy` text DEFAULT 'owner_led' NOT NULL,
	`governance_revision` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_kind_check" CHECK("__new_chat"."kind" in ('dm', 'group', 'public_channel')),
	CONSTRAINT "chat_title_check" CHECK("__new_chat"."title" is null or length(trim("__new_chat"."title")) between 1 and 80),
	CONSTRAINT "chat_owner_kind_check" CHECK("__new_chat"."owner_kind" in ('human', 'agent')),
	CONSTRAINT "chat_owner_id_check" CHECK(length(trim("__new_chat"."owner_id")) > 0),
	CONSTRAINT "chat_wake_policy_check" CHECK("__new_chat"."wake_policy" in ('mention_only', 'owner_led', 'contextual')),
	CONSTRAINT "chat_governance_revision_check" CHECK(typeof("__new_chat"."governance_revision") = 'integer' and "__new_chat"."governance_revision" >= 0),
	CONSTRAINT "chat_dm_owner_check" CHECK("__new_chat"."kind" <> 'dm' or ("__new_chat"."owner_kind" = 'human' and "__new_chat"."owner_id" = "__new_chat"."created_by")),
	CONSTRAINT "chat_public_channel_archived_check" CHECK("__new_chat"."kind" <> 'public_channel' or "__new_chat"."archived_at" is null)
);
--> statement-breakpoint
-- 既有对话全部是 DM，按裁定 C-4 回填：所有者即创建者，唤醒策略 owner_led，治理版本 0。
INSERT INTO `__new_chat`("id", "project_id", "kind", "title", "archived_at", "owner_kind", "owner_id", "wake_policy", "governance_revision", "created_by", "created_at", "updated_at")
  SELECT "id", "project_id", "kind", "title", "archived_at", 'human', "created_by", 'owner_led', 0, "created_by", "created_at", "updated_at" FROM `chat`;--> statement-breakpoint
DROP TABLE `chat`;--> statement-breakpoint
ALTER TABLE `__new_chat` RENAME TO `chat`;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_id_project_unique` ON `chat` (`id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_public_channel_project_unique` ON `chat` (`project_id`) WHERE "chat"."kind" = 'public_channel';--> statement-breakpoint
CREATE INDEX `chat_project_updated_idx` ON `chat` (`project_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `chat_project_owner_idx` ON `chat` (`project_id`,`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_chat_member` (
	`chat_id` text NOT NULL,
	`member_kind` text NOT NULL,
	`member_id` text NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`chat_id`, `member_kind`, `member_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_member_kind_check" CHECK("__new_chat_member"."member_kind" in ('human', 'agent')),
	CONSTRAINT "chat_member_id_check" CHECK(length(trim("__new_chat_member"."member_id")) > 0)
);
--> statement-breakpoint
INSERT INTO `__new_chat_member`("chat_id", "member_kind", "member_id", "added_at") SELECT "chat_id", "member_kind", "member_id", "added_at" FROM `chat_member`;--> statement-breakpoint
DROP TABLE `chat_member`;--> statement-breakpoint
ALTER TABLE `__new_chat_member` RENAME TO `chat_member`;--> statement-breakpoint
CREATE INDEX `chat_member_identity_idx` ON `chat_member` (`member_kind`,`member_id`,`chat_id`);--> statement-breakpoint
CREATE TABLE `__new_agent_run_input` (
	`run_id` text NOT NULL,
	`message_id` text NOT NULL,
	`disposition` text DEFAULT 'pending' NOT NULL,
	`delivered_at` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	PRIMARY KEY(`run_id`, `message_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_input_disposition_check" CHECK((
      ("__new_agent_run_input"."disposition" = 'pending' and "__new_agent_run_input"."delivered_at" is null and "__new_agent_run_input"."cancelled_at" is null and "__new_agent_run_input"."cancel_reason" is null)
      or ("__new_agent_run_input"."disposition" = 'delivered' and "__new_agent_run_input"."delivered_at" is not null and "__new_agent_run_input"."cancelled_at" is null and "__new_agent_run_input"."cancel_reason" is null)
      or ("__new_agent_run_input"."disposition" = 'cancelled' and "__new_agent_run_input"."delivered_at" is null and "__new_agent_run_input"."cancelled_at" is not null and "__new_agent_run_input"."cancel_reason" is not null)
    )),
	CONSTRAINT "agent_run_input_cancel_reason_check" CHECK("__new_agent_run_input"."cancel_reason" is null or "__new_agent_run_input"."cancel_reason" in ('membership_revoked', 'human_stop', 'group_dissolved'))
);
--> statement-breakpoint
-- 旧行只可能有 pending / delivered 两态，取消事实列一律留空。
INSERT INTO `__new_agent_run_input`("run_id", "message_id", "disposition", "delivered_at", "cancelled_at", "cancel_reason")
  SELECT "run_id", "message_id", "disposition", "delivered_at", NULL, NULL FROM `agent_run_input`;--> statement-breakpoint
DROP TABLE `agent_run_input`;--> statement-breakpoint
ALTER TABLE `__new_agent_run_input` RENAME TO `agent_run_input`;--> statement-breakpoint
CREATE INDEX `agent_run_input_message_idx` ON `agent_run_input` (`message_id`);--> statement-breakpoint
CREATE INDEX `agent_run_input_run_disposition_idx` ON `agent_run_input` (`run_id`,`disposition`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_id_chat_unique` ON `message` (`id`,`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_assistant_message_unique` ON `agent_run` (`assistant_message_id`) WHERE "agent_run"."assistant_message_id" is not null;--> statement-breakpoint
-- 公共频道成员是在读派生事实，写进成员表就是第二份真值；触发器给出物理底线。
CREATE TRIGGER chat_member_no_channel_insert BEFORE INSERT ON chat_member
WHEN EXISTS (SELECT 1 FROM chat WHERE id = NEW.chat_id AND kind = 'public_channel')
BEGIN
  SELECT RAISE(ABORT, 'public_channel_members_derived');
END;
--> statement-breakpoint
CREATE TRIGGER chat_member_no_channel_delete BEFORE DELETE ON chat_member
WHEN EXISTS (SELECT 1 FROM chat WHERE id = OLD.chat_id AND kind = 'public_channel')
BEGIN
  SELECT RAISE(ABORT, 'public_channel_members_derived');
END;
--> statement-breakpoint
CREATE TRIGGER chat_member_identity_immutable BEFORE UPDATE ON chat_member
BEGIN
  SELECT RAISE(ABORT, 'chat_member_identity_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_kind_immutable BEFORE UPDATE OF kind, project_id, id, created_by ON chat
WHEN NEW.kind <> OLD.kind OR NEW.project_id <> OLD.project_id OR
     NEW.id <> OLD.id OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'chat_identity_immutable');
END;
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
  WHERE c.kind = 'public_channel'
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
  WHERE c.kind = 'public_channel';--> statement-breakpoint
PRAGMA foreign_keys=ON;
