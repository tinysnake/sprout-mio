-- 挑战码是 10 分钟的临时记录，旧行没有可回读的明文，直接丢弃比补默认值干净。
DELETE FROM `feishu_challenge`;
--> statement-breakpoint
ALTER TABLE `feishu_challenge` ADD `code` text NOT NULL;
