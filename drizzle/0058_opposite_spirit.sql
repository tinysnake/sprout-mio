ALTER TABLE `agent_run` ADD `attention_policy_snapshot` text;--> statement-breakpoint
ALTER TABLE `agent_run` ADD `attention_at` integer;--> statement-breakpoint
ALTER TABLE `agent_run` ADD `human_required_at` integer;--> statement-breakpoint
ALTER TABLE `agent_run` ADD `human_notified_at` integer;--> statement-breakpoint
ALTER TABLE `agent_run` ADD `attention_message_id` text;--> statement-breakpoint
ALTER TABLE `agent_run` ADD `attention_notice_next_at` integer;--> statement-breakpoint
ALTER TABLE `agent_run` ADD `attention_notice_attempts` integer DEFAULT 0 NOT NULL;