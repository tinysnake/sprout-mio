# Project webhook

## 实现范围

Human 在 Project settings 的 Webhook 自动化区域创建、编辑、启停规则，配置一个 DM Agent、Group 指定 Agent 或 Group 当前 owner 动作。页面提供一次性 secret、curl 示例、真实 Trial、最近 50 条触发记录及 Chat 跳转。Agent 候选来自所选 Chat 的当前有效成员。系统来源消息复用普通 Chat 历史与 Agent run 输入，不增加 Chat kind 或独立执行器。

外部入口为 `POST /api/webhooks/$ruleId`。认证使用 `Authorization: Bearer <secret>`，事件使用 `X-Sprout-Event-Id`，正文为 `application/json` 的 object。服务在读取正文前认证，限制实际流入的正文为 64 KiB，并在原子接纳时重新检查当前规则。响应不等待模型完成，不回显 secret 或框架错误。管理入口使用 Human session 和 Project 权限；外部 POST 使用 HTTP 状态表达错误，属于内部 `AppResult` 约定的外部协议例外。

## 业务契约

- 每条规则归属一个 Project，只有一个消息动作。目标必须属于该 Project。创建返回 32 字节随机 secret，数据库只保存 SHA-256 digest。页面不把 secret 写入浏览器存储。
- 去重键为 `(ruleId, live|trial, eventId)`。同一键与等价 JSON 返回原收据，内容不同返回冲突。Trial 有独立去重空间，但会真实投递，遵守启用、权限和目标检查。
- 接纳事务保存规则快照、固定接收 Agent，并原子写入收据、系统来源消息及普通 run input。停用或目标失效产生跳过记录，不产生消息。编辑只影响后续新事件，停用不取消已接纳的工作。
- `automation` 是消息来源，不是 Human、Agent、Chat member 或 owner。消息来源关联真实 trigger。公开发消息 API 仍只接受 Human / Agent。外部 event 保持数据身份，不解析为 recipient、mention 或 skill，也不提升为 system prompt。
- 实际初始输入或 steer 发送前，再检查当前 Project 权限、Chat 状态、Agent 有效成员资格及 owner。目标改变时取消尚未发送的输入，不换人接手。Group owner 为 Human 时，显式指定有效 Agent 的动作仍然成立。
- `admittedAt` 记录尝试发送的边界。无法确认的 wire 发送不自动重试，不承诺进程崩溃下模型执行恰好一次。没有新增恢复 worker、通用事件总线或通知重发执行机制。
- 历史按创建时间及同时间戳内的插入顺序倒序取最近 50 条。Chat / run 来自原触发消息的输入关联，不从规则当前目标推算。历史显示输入 disposition、取消原因及当前 run 状态，收据本身保持不可变。

## 风险与验证

| 风险 | 可重复证据 |
| --- | --- |
| 外部数据伪造 Human、Agent、mention、skill 或修改接收者 | `tests/automation-core.test.ts` 的公开来源拒绝与三种动作测试 |
| 无效 credential 先读取正文、chunked 绕过大小限制、错误正文 | `tests/automation-http.test.ts` 的真实 Request / ReadableStream 边界测试 |
| 读取正文期间规则失效 | `tests/automation-http.test.ts` 在流读取时停用规则，检查最终接纳重新校验 |
| 等价重试重复开工、不同内容复用事件 ID、Trial 混入 live | core / HTTP 测试和生产服务浏览器门禁 |
| 同时间戳漏掉最新历史、旧收据跟随规则换目标 | HTTP 历史排序测试与 core 快照、关联测试 |
| SQLite NULL、外键或旧数据迁移回归 | `tests/automation-migration.test.ts` 的负例与有数据的 0036 升级测试 |
| 权限撤销后仍发 prompt / steer、owner 自动换人、失败重发 | core 的实际 `executeRun` 协议 fixture 与最终权限边界测试 |
| 系统来源误显示 Agent 身份或人设 | `tests/run-activity-ui.test.ts` 与 source Chat 截图 |
| 无 session / 外部账号管理规则、页面目标候选越界 | `tests/fixtures/webhook-live.mjs` 的真实 session server functions 与页面候选断言 |
| UI 与真实 HTTP / runner 脱节 | 同一浏览器门禁从页面建规则，经 POST、源消息、真实 Pi runner 到 Chat 结果，并覆盖 Trial、重复事件、Group 指定 Agent 与无效 owner |

## 验证入口与边界

```sh
bash scripts/verify/webhook-core.sh
pnpm build
bash scripts/verify/webhook-browser.sh
pnpm typecheck
pnpm check
```

`webhook-core` 已登记在 CI API 组。`webhook-browser` 已登记为 local gate，使用当前 production build、独立数据库、回环模型 fixture、实际安装的 Pi SDK / runner 与 Chromium。它输出日志、JSON、桌面 / 手机设置页及 source Chat 截图，报告 `paid-model-calls=0`。门禁结束关闭自己启动的服务和 fixture。

已实际跑通上述生产服务链路，并检查桌面与手机截图。模型响应来自 fixture，未证明真实付费模型、真实外部 webhook 提供方或公网部署。技术验证不等于 Human UI 体验确认。Cron、个人助理、飞书和语音仍在后续单元，状态见[开发总计划](development-plan.md#首版推进顺序)。操作入口见[自动化功能地图](feature-map/automation.md)。
