# Prompt prune arm D

基线 `9e0405f`，分支 `t3/prompt-prune-arm-d`。裁剪须同时满足 live 零调用与产品/提示词无 Crew 能力承诺；保留第一轮角色差异。

## 工具证据

Live 来源：`/tmp/promptprune-arm-D.md` 对 `/tmp/crew-ab-prune1/` 的 10 格统计。字符按该 brief 的工具说明及参数说明计数。
查证范围：`docs/crew-core.md`、`docs/*-decisions.md`、`docs/feature-map/**`、`src/extension/agent-prompt.ts`；同时查工具名与对应能力语义。

| 候选 | 字符 | 10 格调用 | 决定及文档依据 |
| --- | ---: | ---: | --- |
| `codemode` | 1422 | 1 | 保留：不满足零调用。文档/提示词未将它承诺为 Crew 能力，但不能绕过第一条证据。宿主显式 factory 和 allowlist 均在 runner，可过滤；本次不裁剪。 |
| `sprout_remote_execution_cancel` | 411 | 0 | 保留：`docs/feature-map/remote-execution.md` 的 `execution-cancel` 与 Agent 取消链路为产品承诺，未限定 DM。 |
| `sprout_remote_process_signal` | 335 | 0 | 保留：`docs/machines-decisions.md`「第一版操作能力」承诺进程操作；「长时间执行与恢复查询」承诺管理已有执行，未限定 DM。 |
| `sprout_remote_process_list` | 317 | 0 | 保留：同上，进程查询与操作属于已承诺远端工具能力。 |
| `sprout_chat_get` | 42 | 0 | 裁剪：没有将此工具或主动读取当前 Chat 正文列为 Crew 能力；`docs/crew-core.md` 的 worker 结果回流走委派事件，非此 Chat 查询。 |
| `sprout_chat_continuation_get` | 109 | 0 | 裁剪：`docs/communication-decisions.md`「对话接续与人类控制」描述服务端路由/控制，未承诺 Crew 工具读取接续状态；提示词未点名。 |

## 保留边界

- `sprout_remote_execution_wait/get/log/list`：正规执行观察与等待手段，不能把 lead 推回 sleep。
- `sleep`：保留真实工具，使 eventDrivenWait 仍能发现睡眠退化。
- `sprout_resource_request/approve/revoke/takeover/release`：资源申请、审批与归还为 Crew 承诺；保持第一轮 worker 只有 request/release 的角色边界。
- `sprout_task_*`：保留第一轮 lead 面与 DM 面；worker 仍不声明 Task 工具。
- `sprout_delegation_input/cancel/list`：保留 lead 编排能力；worker 仍是 complete/block。
- `read/ls/grep/find/git_read/current_time/tool_search`：宿主读工具与状态查询保留。
- 两个 Chat 查询仅对 `crew_lead || delegation_worker` 同时过滤注册与 allowlist。DM 全保留；assistant 独立工厂和工具表不变。

## 验证范围

真实 runner fixture 检查 HTTP 模型请求与 registry：Crew 无两个 Chat 查询，DM 有；观察/控制与宿主工具仍在；继续覆盖 DM session 恢复为 Crew。提示词改动另独立提交，三条原文规则与每角色 sprout 名称必须对应其可见工具。
