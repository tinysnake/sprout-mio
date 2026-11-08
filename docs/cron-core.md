# Project cron

## 实现范围

Project settings 的定时规则区域提供五段 cron、显式时区、下一时点、启停、真实 Trial 和最近 50 条历史。消息动作与 [Project webhook](webhook-core.md)共用目标校验、事务接纳、系统来源消息、普通 run input 和发送前权限检查，不增加独立执行器。规则只能由有 Project 权限的 Human 管理，不开放外部 bearer 入口。

## 调度契约

- 固定使用 `cron-parser@5.10.4`。只接受数字、`*`、`,`、`-`、`/` 构成的五段表达式（分钟、小时、日、月、星期），不接受秒、宏、`L`、`#`、名称或偏移时区。日和星期同时受限时遵循 OR。无有效未来时点的配置被拒绝。
- 显式保存 IANA 时区（包括 UTC），不从浏览器或服务器默认时区推断。严格从给定时点之后求下一次，搜索上限为 12 个日历年。DST 遵循该固定版本：春季缺失的 02:30 顺延至 03:30，秋季重复的 01:30 只触发首次。边界由 parser 测试固定。
- 服务启动在恢复现有 run 后，以 bootNow 将启用规则的持久 `nextAt` 重设为严格未来时点。服务端每秒重设一个 timeout；停止、失败启动和 shutdown 都清理 timer。extension 不持有调度。
- 配置编辑、cursor 推进、同规则重叠检查和接纳均使用 SQLite immediate transaction。编辑使用 revision CAS，启用或编辑按当前时间重算，停用清空 cursor。
- 到期时直接推进到 now 之后，不逐个枚举遗漏时点。距 cursor 不超过 10 秒且本次时钟间隔不超过 10 秒时可以接纳；超过窗口、长停顿或时钟倒退后的到期规则至多记录一条 `schedule_missed`。离线与重启不补跑。时点 ISO 作为 live 去重键，时钟回拨也不能重复接纳相同瞬间。
- Trial 是真实提交，与 live 分开去重，不推进 cursor，仍遵守启用、当前目标和同规则重叠检查。live 与 Trial 共用重叠判定：该规则消息的当前 input 未取消，且当前关联 run 为 queued / running 即占用，包括 delivered 和发送结果不确定；terminal 或取消输入释放。carry 后以当前 run 为准。其他规则彼此独立。
- 停用只阻止新接纳，不撤回既有消息或工作。初始 prompt 和 steer 真正发送前仍检查当前权限、Chat、Agent 及 owner；失效时取消输入，不自动换人。

## 数据与来源

保留物理表 `webhook_rule` / `webhook_trigger` 及既有 ID。0038 只重建规则表以强制 source 对应的 credential / schedule / cursor CHECK，收据 additive 增加不可变 source；SQL insert guard 强制收据与规则 source 及冻结配置形状一致。旧 webhook credential、HTTP 与 replay 行为不变，HTTP 认证和 webhook Trial 两处均拒绝 cron 规则。

公开规则与收据按 source 区分。cron Source 为 `project_cron`，包含冻结的 expression、timezone、instruction、scheduledAt 和 live / trial mode；历史编辑不改变旧快照或 Chat / run 关联。Source 不是 Human、Agent、system prompt 或授权。正文中的 @、skill 和外部文字不产生 mention / skill span，也不能指定接收者。

历史按 createdAt、rowid 倒序取最新 50 条，返回当前 input disposition、cancelReason、run 状态及原 Chat / run 链接。UI 明确标识 Project cron，不回退到 Agent persona 或 run-activity。编辑器在保存 / Trial pending 时锁定；请求 generation 与 Project key 隔离跨规则 / 路由响应。网络结果不确定时提示可能已经提交并要求刷新，不显示伪重试。

## 验证入口

```sh
bash scripts/verify/cron-core.sh
pnpm typecheck
pnpm check
pnpm build
bash scripts/verify/cron-browser.sh
bash scripts/verify/f-docs.sh
```

`cron-core` 登记在 CI API 组；`cron-browser` 为 local gate，复用 webhook 的 production harness，而非另建服务基础设施。

| 风险 | 证据 |
| --- | --- |
| 方言、无未来时点、DST 与闰世纪 | `tests/cron-schedule.test.ts` |
| source / NULL / credential 约束及旧数据丢失 | `tests/cron-migration.test.ts` 的真实 SQL 负例与有数据 0037 升级 |
| timer 泄漏、启动补跑、10 秒边界、长间隔与回拨 | `tests/cron-core.test.ts` 的 fake-clock 生命周期及事务断言 |
| live / Trial 重叠、取消、terminal 与独立规则 | cron core 的真实 DB / input / run 测试 |
| initial / steer 权限撤销与来源提升 | cron core 的 executeRun 协议 fixture；共享 webhook 回归 |
| UI、管理权限和生产调度脱节 | `tests/fixtures/cron-browser.mjs`：真实 session、保存、Trial pending 锁、实际墙钟到期、生产 runtime、实际 Pi runner 与回环模型 |

生产门禁保存 `.verify/cron-*` 内的日志、收据 JSON、桌面 / 手机设置页及 Source Chat 截图，结束时关闭自己的服务、浏览器与模型 fixture。模型为本地隔离 fixture（`paid-model-calls=0`），不证明真实付费模型、公网部署、跨机器时钟或断电。技术验证与 Human UI 体验确认分开；本单元不包含助理、飞书、语音、一次性调度或通用工作流。
