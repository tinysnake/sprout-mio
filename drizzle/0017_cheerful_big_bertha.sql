-- 取消的失败原因扩展为第三种：`exit_not_observed`。
-- Worker 观测到进程已不再运行，但 runner 没有落盘 result（例如 KILL 连 runner 一起打死）时，
-- 取消不能写 `exited_observed`（那是声称已确认退出），也没有诚实可用的既有原因：
-- `signal_failed` 说的是信号调用失败，`delivery_unconfirmed` 说的是意图没送到，两者都不成立。
-- 只放宽 failure_reason 的取值，其余状态组合约束不动；存量行不受影响。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_execution_cancellation` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`request_id` text NOT NULL,
	`project_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`authorization_generation` integer NOT NULL,
	`holder_instance_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`state` text NOT NULL,
	`signal_outcome` text DEFAULT 'none' NOT NULL,
	`policy` text DEFAULT 'term_then_kill' NOT NULL,
	`term_wait_ms` integer DEFAULT 2000 NOT NULL,
	`requested_at` integer NOT NULL,
	`delivered_at` integer,
	`exited_at` integer,
	`failure_reason` text,
	FOREIGN KEY (`execution_id`) REFERENCES `remote_execution`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`) REFERENCES `lease_authorization`(`project_id`,`machine_id`,`generation`,`holder_instance_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "execution_cancellation_check_1" CHECK(state IN ('requested','delivered','exited_observed','already_exited','failed','unknown')),
	CONSTRAINT "execution_cancellation_check_2" CHECK(signal_outcome IN ('none','term_delivered','kill_delivered')),
	CONSTRAINT "execution_cancellation_check_3" CHECK(typeof(requested_at)='integer' AND requested_at>=0),
	CONSTRAINT "execution_cancellation_check_4" CHECK(delivered_at IS NULL OR (typeof(delivered_at)='integer' AND delivered_at>=requested_at)),
	CONSTRAINT "execution_cancellation_check_5" CHECK(exited_at IS NULL OR (typeof(exited_at)='integer' AND delivered_at IS NOT NULL AND exited_at>=delivered_at)),
	CONSTRAINT "execution_cancellation_check_6" CHECK(failure_reason IS NULL OR failure_reason IN ('signal_failed','delivery_unconfirmed','exit_not_observed')),
	CONSTRAINT "execution_cancellation_check_7" CHECK((state='requested' AND delivered_at IS NULL AND exited_at IS NULL AND failure_reason IS NULL AND signal_outcome='none') OR
        (state='delivered' AND delivered_at IS NOT NULL AND exited_at IS NULL AND failure_reason IS NULL) OR
        (state IN ('exited_observed','already_exited') AND delivered_at IS NOT NULL AND exited_at IS NOT NULL AND failure_reason IS NULL) OR
        (state='failed' AND delivered_at IS NOT NULL AND exited_at IS NULL AND failure_reason IS NOT NULL) OR
        (state='unknown' AND exited_at IS NULL AND failure_reason IS NOT NULL)),
	CONSTRAINT "execution_cancellation_check_8" CHECK(length(request_id)>7 AND substr(request_id,1,7)='cancel:'),
	CONSTRAINT "execution_cancellation_check_9" CHECK(policy IN ('term_then_kill','kill')),
	CONSTRAINT "execution_cancellation_check_10" CHECK(term_wait_ms BETWEEN 1 AND 10000),
	CONSTRAINT "execution_cancellation_check_11" CHECK(actor_kind IN ('agent','human')),
	CONSTRAINT "execution_cancellation_check_12" CHECK(length(actor_id)>0)
);
--> statement-breakpoint
INSERT INTO `__new_execution_cancellation`("id", "execution_id", "request_id", "project_id", "machine_id", "authorization_generation", "holder_instance_id", "actor_kind", "actor_id", "state", "signal_outcome", "policy", "term_wait_ms", "requested_at", "delivered_at", "exited_at", "failure_reason") SELECT "id", "execution_id", "request_id", "project_id", "machine_id", "authorization_generation", "holder_instance_id", "actor_kind", "actor_id", "state", "signal_outcome", "policy", "term_wait_ms", "requested_at", "delivered_at", "exited_at", "failure_reason" FROM `execution_cancellation`;--> statement-breakpoint
DROP TABLE `execution_cancellation`;--> statement-breakpoint
ALTER TABLE `__new_execution_cancellation` RENAME TO `execution_cancellation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `execution_cancellation_holder_instance_id_request_id_unique` ON `execution_cancellation` (`holder_instance_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_cancellation_id_project_id_machine_id_authorization_generation_holder_instance_id_unique` ON `execution_cancellation` (`id`,`project_id`,`machine_id`,`authorization_generation`,`holder_instance_id`);