# 自动化

## Sub-features

- Human 管理 Project webhook / cron，配置一个 DM Agent、Group 指定 Agent 或 Group 当前 owner 消息动作。
- Cron 使用五段表达式、显式时区与下一时点；同规则重叠跳过，离线 / 重启不补跑。
- 外部 POST 的 bearer 认证、实际流量上限、事件去重及冲突。
- 真实 Trial、停用和目标失效跳过、最近触发记录、输入取消原因与 Chat / run 关联。
- 系统来源消息进入普通 Chat，触发既有 Pi run 并保留结果。

## How to get to it (user POV)

登录后选择 Project，打开 Project settings，进入 Webhook 自动化区域。创建规则时选择目标 Chat 与 Agent 或 owner 动作，填写 Instruction。创建成功只展示一次 secret 和 curl 示例。再次读取规则不会取回 secret。

外部系统向显示的 endpoint 发送 JSON object，同时携带 bearer secret 与稳定的 `X-Sprout-Event-Id`。页面的 Trial 会真实向所选 Chat 提交。最近触发记录可以跳到接收消息的 Chat；编辑规则后旧记录仍指向原来的 Chat。

Cron 在同页的定时规则区域。先选消息动作与有效目标，再填写五段表达式和显式 IANA 时区；启用保存后显示下一时点。Trial 真实开工但不推进计划 cursor；历史区分 Trial / Schedule 并提供 Chat / run 链接。Run 链接按明确 runId 打开其状态与失败原因，不依赖该 run 是否最新或是否有回复消息。停用不撤回已接纳工作。

## Driving it with …

前置条件为可用的 Human 账号、Project、有效 Agent 成员及 DM / Group。Group owner 动作要求当前 owner 是有效 Agent。专项浏览器门禁自动创建独立数据，使用实际 Pi runner 和回环模型 fixture，无需付费模型凭据。

```sh
bash scripts/verify/webhook-core.sh
pnpm build
bash scripts/verify/webhook-browser.sh
bash scripts/verify/cron-core.sh
bash scripts/verify/cron-browser.sh
```

`webhook-core` 覆盖 domain、HTTP 流、迁移和相关 Chat / Task 回归。浏览器门禁从页面创建规则，经真实 HTTP 到系统来源消息、run 和结果，并检查重复事件、Trial、停用、无 session / 外部账号管理拒绝、有效成员候选和 Group 目标。延迟保存响应的场景还检查编辑锁与两条规则的持久目标，防止跨规则覆盖。

Cron 门禁还种入较早、没有回复关联的 failed run，并在已有较新 run 的情况下点击历史链接，检查目标状态和错误信息；无 session 或 Chat 不匹配的 run 查询会被拒绝。

产物在脚本输出的 `.verify/webhook-<timestamp>` 目录，包含 `result.json`、服务日志与桌面 / 手机截图。核对结果标记、HTTP 状态、消息及输入数量、页面错误、来源标记和目标候选。模型模式为 `model-fixture`，记录 `paid-model-calls=0`。

## Gotchas

- Trial 会真实开工，使用独立去重空间，仍遵守规则启用与目标检查。
- 同一事件 ID 的等价 JSON 返回原收据，不同内容冲突。别用每次随机 ID 测试重复投递。
- 门禁使用当前 checkout 的 production build。先构建，且不要在同一 checkout 并行执行会覆盖 `.output` 的脚本。数据库和服务端口由本次门禁隔离。
- 系统来源不是 Chat member，也不获得 Agent 的权限。event 内的目标、mention 或 skill 文本不能改写配置的动作。
- 技术链路使用真实 SDK / runner，但模型是 fixture。它不代表真实付费模型、公网提供方或 Human UI 体验已验收。
- Webhook 与 cron 单元已实现并完成技术验证；Cron 门禁在 `.verify/cron-<timestamp>` 保存真实墙钟触发、Trial、实际 Pi runner 回环模型、桌面 / 手机设置与 Source Chat 证据。Human UI 体验未确认。助理、飞书、语音与一次性调度仍待后续单元。状态见[总计划](../development-plan.md#首版推进顺序)，细节见 [Webhook 契约](../webhook-core.md)与 [Cron 契约](../cron-core.md)。
