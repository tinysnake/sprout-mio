-- 唤醒判定器 provider 值 small_brain -> llm（仅改数据，schema 不变）
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
UPDATE `project` SET `wake_policy` = replace(`wake_policy`, '"small_brain"', '"llm"') WHERE `wake_policy` LIKE '%"small_brain"%';
--> statement-breakpoint
UPDATE `project_wake_policy_command` SET `payload` = replace(`payload`, '"small_brain"', '"llm"') WHERE `payload` LIKE '%"small_brain"%';
--> statement-breakpoint
UPDATE `project_wake_policy_command` SET `result` = replace(`result`, '"small_brain"', '"llm"') WHERE `result` LIKE '%"small_brain"%';
--> statement-breakpoint
PRAGMA foreign_keys=ON;
