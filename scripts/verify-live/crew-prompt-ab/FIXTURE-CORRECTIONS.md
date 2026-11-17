# Crew A/B fixture corrections

本次仅修正 harness 的结算与产物断言；不修改产品代码、任务 prompt、预注册读数或冻结臂，也不运行新的 live A/B。

## 证据

来源：`/tmp/crew-ab-paired3b/diagnosed.jsonl`。

- `donot-delegate-small-edit` 的 A r3、B r1/r2/r3：lead `running`、worker `queued`，`leadFinalReplyText` 为空；禁止委派的快速返回把在途快照送进了判分。A r1 已完成且通过；A r2 已完成但失败。
- `delegate-parallel-two` 的 A r1、B r1/r2/r3 的 `parallel` 子进程以 `AssertionError [ERR_ASSERTION]: lead names retry file src/retry.js` 失败；A r2 的 `parallel` 通过，但整行仍失败。账本中的 A r3 是 `timeout` 且没有产物断言，因此不是 brief 所称的第五个命名断言失败。

## 改动

- 把结算谓词抽到 `settlement.mjs`，由实际 `run-task.mjs` 等待循环调用。移除禁止委派的提前返回，继续要求 `settled(latest)` 且完整快照稳定至少 1000ms。快照变化重新计时。`classifyRuns` 的终态异常消息与 `runClassification` 保持原样；外层 `until` 的预算和 `AB_TIMEOUT` 路径不变。`preserveOutcome` 未修改，禁止委派仍失败。
- `parallel` 断言载荷携带两个 `machineScopes[].worktree`，验证恰好两个不同的真实根目录，并读取两份 clone 的全部目标文件。至少一个 README 包含完整 `Requires Node 22.` 行且无 `Requires Node 18.` 行；至少一个 JS 导出数字 `retryCount === 3`；至少一个 JSON 含数字 `retryCount === 5`。这些证据可以分布在不同 clone。
- 每份 clone 至少有一个符合目标且内容不同于初始夹具的目标文件。初始夹具已经将 retryCount 设为 3/5，单凭值正确无法证明改动，因此额外比较 `fixtureDefinition(...).files` 的原始内容。
- lead 点名 README、retry 路径与对应值只写入 `row.reportSignals`；产物断言与 `judge` 不使用这些信号。原有 workersDone、attribution、afterComplete、validFinal 与 corrected parallel 门保持不变。旧的行号解析测试改为直接验证报告信号解析器。

## 红绿验证

以下测试命令从仓库根运行；日志均保存在 `/tmp`。红灯时只恢复指定旧逻辑，随后立即恢复修正。

1. 结算红灯：在提取的实际结算谓词中临时恢复原有 `forbiddenDelegation(oracle, latest.delegations.length)` 提前返回。
   `node --test --test-name-pattern='waits for runs|settlement still' scripts/verify-live/crew-prompt-ab/fixture-corrections.test.mjs` → **1**（两个在途快照测试和终态异常测试失败）。日志：`/tmp/crew-fixtures-red-settlement.log`。
2. 产物红灯：临时用 `git show edc63a0:scripts/verify-live/crew-prompt-ab/artifacts.mjs` 的原版替换断言。
   `node --test --test-name-pattern='parallel' scripts/verify-live/crew-prompt-ab/fixture-corrections.test.mjs` → **1**（无路径点名的正确产物被拒绝；未改 clone 与错误 retry 值被旧逻辑放过）。日志：`/tmp/crew-fixtures-red-parallel.log`。
3. 恢复修正：`node --test scripts/verify-live/crew-prompt-ab/fixture-corrections.test.mjs` → **0**，9/9 通过。日志：`/tmp/crew-fixtures-green.log`。
4. 完整门禁：`node --test scripts/verify-live/crew-prompt-ab/*.test.mjs` → **0**，47/47 通过。日志：`/tmp/crew-fixtures-suite.log`。

## 格式与 dry 冒烟

- 使用 `./node_modules/.bin/vp fmt` 格式化本次变更的 7 个文件，并用同一入口 `--check` 检查；两次退出码均为 **0**，不直接调用 oxfmt。
- 从 `scripts/verify-live/crew-prompt-ab` 运行：
  `AB_DRY=1 AB_TASKS=delegate-parallel-two,donot-delegate-small-edit AB_REF_A=277f506c15fe771bbd337efa259dc517c3ffc1cd AB_REF_B=3c0f25c75f77689bfbf79349149cbe2abae6d1a7 AB_MODEL=fixture-only AB_OUT=/tmp/crew-fixtures-dry-valid.jsonl bash ../crew-prompt-ab-run.sh`。
- dry 完成，退出码 **0**，4/4 调用执行完毕；合成任务行均为 failed，不作真实模型结果。日志：`/tmp/crew-fixtures-dry-valid.log`；退出码：`/tmp/crew-fixtures-dry-valid.exit`。占位 SHA `111…`/`222…` 的首次尝试退出 1，因为脚本仍解析 commit；需要实际存在且不同的提交。

## 仍存在的局限

- 由于两个 retry 值在初始夹具中已经正确，文件字节变化（包括格式变化）加正确最终内容只能证明 clone 的目标文件发生变化；不能证明对应 worker 曾把错误 retry 值修成正确值。worker 的归属仍由原有 attribution 证据验证。
- 每个 clone 的目标文件必须存在且可读取；JS 导出通过独立断言子进程加载。重复根目录或旧 Node 行不能充当第二份有效工作证据。
- 历史账本和 `rejudge.mjs` 的既有行号修正审计路径未重写；新修正不能补齐旧的在途快照，也没有重新判分旧批次。新批次会记录基于双 clone 内容的两组断言。
- dry 只证明流程可运行；本次没有测量真实模型的 A/B 成功率或耗时变化。
