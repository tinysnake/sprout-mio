# Prompt prune arm D

基线 `9e0405f`，分支 `t3/prompt-prune-arm-d`。首轮只声明热工具；长尾能力仍注册，通过 `tool_search` 激活。`sprout_lease_*` 继续沿用第一轮删除，worker 的 Task 与三项资源决策仍不注册。

## 工具证据与体量

Live 来源：`/tmp/promptprune-arm-D.md` 对 `/tmp/crew-ab-prune1/` 的 10 格统计。`codemode` 与 execution_list 各调用 1 次，其余下表工具均为 0；延迟暴露不删除产品能力，所以这两项也按指定名单延迟。
字符数由本分支 `scripts/verify-live/crew-prompt-ab/prompt-inventory.mjs` 的真实 SDK 初始活动集测量，工具名清单与注册清单分别报告。每项首轮节省与激活后恢复的说明字符相等；JSON 语法与工具名长度不计入此口径。

| deferred 工具 | 字符 / 首轮省 / 激活恢复 | 10 格调用 | 角色 |
| --- | ---: | ---: | --- |
| codemode | 1422 / 1422 / 1422 | 1 | lead + worker |
| sprout_remote_execution_cancel | 411 / 411 / 411 | 0 | lead + worker |
| sprout_remote_execution_wait | 351 / 351 / 351 | 0 | lead + worker |
| sprout_remote_execution_log | 349 / 349 / 349 | 0 | lead + worker |
| sprout_remote_execution_get | 230 / 230 / 230 | 0 | lead + worker |
| sprout_remote_execution_list | 259 / 259 / 259 | 1 | lead + worker |
| sprout_remote_process_list | 317 / 317 / 317 | 0 | lead + worker |
| sprout_remote_process_signal | 335 / 335 / 335 | 0 | lead + worker |
| sprout_resource_request | 210 / 210 / 210 | 0 | lead + worker |
| sprout_resource_approve | 119 / 119 / 119 | 0 | lead |
| sprout_resource_revoke | 97 / 97 / 97 | 0 | lead |
| sprout_resource_takeover | 177 / 177 / 177 | 0 | lead |
| sprout_task_list | 38 / 38 / 38 | 0 | lead |
| sprout_task_get | 49 / 49 / 49 | 0 | lead |
| sprout_task_update | 48 / 48 / 48 | 0 | lead |
| sprout_task_checklist_add | 49 / 49 / 49 | 0 | lead |
| sprout_task_checklist_update | 52 / 52 / 52 | 0 | lead |
| sprout_task_checklist_remove | 52 / 52 / 52 | 0 | lead |
| sprout_task_record_append | 45 / 45 / 45 | 0 | lead |
| sprout_task_complete | 62 / 62 / 62 | 0 | lead |
| sprout_task_cancel | 45 / 45 / 45 | 0 | lead |
| sprout_chat_get | 42 / 42 / 42 | 0 | lead + worker |
| sprout_chat_continuation_get | 109 / 109 / 109 | 0 | lead + worker |

文档核对范围：`docs/crew-core.md`、`docs/*-decisions.md`、`docs/feature-map/**` 与 `src/extension/agent-prompt.ts`。`docs/feature-map/remote-execution.md` 承诺取消、查询与日志；`docs/machines-decisions.md` 承诺进程操作；Crew 文档承诺资源审批、Task 归属和编排。因此这些工具保持可发现、可激活。两个 Chat 查询没有工具级 Crew 承诺，仍保留可发现能力。

## 暴露边界

- 热工具保持原活动集：`read/ls/grep/find/git_read/current_time/sleep/tool_search`、`sprout_status`、`sprout_info_hub_get`、各角色原有 `sprout_delegation_*`、远端 shell/file_read/file_write、resource_release。
- `rolePi` 给长尾工具添加 `exposure: "deferred"`，allowlist 保留注册权限，session 绑定完后显式清理其初始活动集。`codemode` 是 runner 显式加载的 extension factory，包装其注册即可设置 exposure，无需 customTools 覆写 SDK 内置定义。
- 条件仅限 `crew_lead || delegation_worker`；DM 和个人助理行为保持原样。第一笔提交中删掉的两个 Chat 查询在 deferred 提交恢复注册。
- Pi 1.5.2 `tool_search` 按 deferred/codemode exposure 发现工具并激活；调用后描述会回到后续模型请求，所以节省仅针对首次未加载的工具。

## 测量与验证

Inventory 保留原 AST/工厂采集，随后使用真实 SDK session 的 `getActiveToolNames()` 与 `getAllTools()` 分别测量初始活动集与注册集，单列 deferred。未发模型请求。
真实 runner fixture 用模型 HTTP 请求的 tools 数组作 ground truth：首轮与 ready.tools 完全相同，遍历发现 lead 23 项与 worker 11 项，每项都在后续请求出现；DM 全部候选仍直接声明，DM session 恢复成 Crew 后重新按角色延迟。
A/B harness `scripts/verify-live/crew-prompt-ab/evidence.mjs:187` 读取 `r.configSnapshot?.tools`，其源头是 ready.snapshot.tools 的活动集；registeredTools 是独立字段，因此 availableTools 可反映首轮裁面。
工具改造后：lead 1271 + 5528（18 active / 41 registered），worker 986 + 4728（16 / 27）；分别首轮节省 4868、4035 字符。提示词压缩与最终验收随后独立提交记录。
