-- 唤醒判定历史行里的 provider 值 small_brain -> llm（仅改数据，schema 不变）
-- 0034 只回填了 project.wake_policy 与 project_wake_policy_command，漏了 wake_evaluation 的
-- input/result 快照；旧值会让读取轮次时间线时整页报 validation_failed。
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
UPDATE `wake_evaluation` SET `input` = replace(`input`, '"small_brain"', '"llm"') WHERE `input` LIKE '%"small_brain"%';
--> statement-breakpoint
UPDATE `wake_evaluation` SET `result` = replace(`result`, '"small_brain"', '"llm"') WHERE `result` LIKE '%"small_brain"%';
--> statement-breakpoint
PRAGMA foreign_keys=ON;
