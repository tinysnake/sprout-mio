-- 取消意图必须记住调用方声明的策略与宽限期。
-- 0013 建的 execution_cancellation 没有这两列，服务端下发时只能用常量
-- term_then_kill / 2000，等于对调用方声明了做不到的能力。
-- 存量行按当时的实际行为（固定 term_then_kill / 2000）回填，不留给后端猜。
ALTER TABLE `execution_cancellation` ADD COLUMN `policy` text NOT NULL DEFAULT 'term_then_kill'
	CONSTRAINT "execution_cancellation_check_9" CHECK(policy IN ('term_then_kill','kill'));--> statement-breakpoint
ALTER TABLE `execution_cancellation` ADD COLUMN `term_wait_ms` integer NOT NULL DEFAULT 2000
	CONSTRAINT "execution_cancellation_check_10" CHECK(term_wait_ms BETWEEN 1 AND 10000);--> statement-breakpoint
UPDATE `execution_cancellation` SET `policy` = 'term_then_kill', `term_wait_ms` = 2000;
