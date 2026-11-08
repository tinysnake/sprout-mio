# 原生助理契约

本单元在现有 Project DM 中实现独立助理。Feishu、语音和外部 channel 仍在后续范围。Human UI 体验确认保持 pending。

## Profile 与运行边界

`agent_profile.purpose` 为 `worker | assistant`，默认 worker，创建后不可修改。旧行与缺少 purpose 的历史 snapshot 按 worker 解释。助理仍使用自己的 model、effort、persona，属于 Project 成员；只可在 Human 所有的普通 DM 运行，不能成为 Group 成员、Public Channel 隐式成员或 webhook / cron / Task 工作目标。

助理不准备 repo checkout、lease、remote execution 或 inherited resources。实际安装的 Pi 在注册和声明两个层面只接受 `sprout_status` 与 `sprout_assistant_observe`、`sprout_assistant_propose`、`sprout_assistant_watch`；runner 会核对完整 registry。普通工作 session 不会作为助理的 previous session 重新打开。工具定义与 gateway admission 共享 `ASSISTANT_TOOL_SPEC`。

Gateway grant 冻结 purpose。身份只能沿 grant → running run → instance → DM → Human 当前权限取得，调用者不能指定 principal。助理 call 不能用于 worker grant，worker call 不能用于助理 grant。普通 Agent 的 Project equality 与 Chat/instance 隔离继续执行。观察接口分页有界，只返回当前 Human 可见的 factual Project、Chat、run 和活动信息；不替目标 Agent 推断业务成功。

## 提案与确认

提案目标为 `dm_agent`、`group_agent`、`group_owner`。提案时解析并固定目标 Project、Chat、profile、instance、body、version 与 operation hash。提案有效期 24 小时；仅 Human 可确认。确认事务重新检查来源 DM、目标可见性、成员、purpose 和精确目标。Group owner 变化要求重新提案；Human owner 的 Group 可以指定某个工作 Agent。

确认在 IMMEDIATE 事务内创建一个原生 `assistant_work` message，直接给所选 instance 分配 input，不经过 Human 消息 fanout。重复确认先校验当前权限与目标，再返回同一 message receipt。消息来源明确是 Human 已确认的程序提案，不伪装为 Human 或工作 Agent 发言。

第一次 prompt 和每次 steer 前再次核对 Human 权限、来源 DM、固定目标、message/instance/run lineage。无效的未投递 input 取消为 `assistant_context_changed`。只在真实 admission 时写 `admittedAt` 并建立 proposal interest；未投递 input 被 carry 后只跟随实际接收它的 run。此前 run 的完成不表示该提案完成。queued 失败或取消会产生事实性 intervention。

`admittedAt` 在外部 send 前持久化，发生不确定的传输异常后不盲目再次发送。这是 durable at-most-once admission；不声称分布式 exactly-once 或外部执行成功。

## Watch、时钟与通知

六张表分别为 `assistant_proposal`、`assistant_watch`、`assistant_preferences`、`assistant_interest`、`assistant_run_cursor`、`assistant_event`。interest 保留 watch/proposal 两种来源，clock 按 DM/run 合并，event key 在 DM 内唯一。

模型只能提出 watch intent，由 Human 激活。watch 持久关注 Chat，覆盖已有和随后新建的工作 run，包括多 Agent 与短 run。run 分配事务同步建立 watch interest，终态只停止该 run 的 clock，保留 Chat watch。取消后再次激活创建新 watch id。

默认周期 300 秒，Human 可配置 60–86400 秒。Runtime 每秒进行有界扫描，按注入的时钟采样当前动作与经过时间；动作未变化仍发周期事实。运行时读取 live activity；终态读取 persisted activity，缺失时明确说明。`completed`、`intervention`、`periodic`、`decision` 分开记录，aborted 不伪装 failed，无最终回复不推断业务成功。

watch 与 proposal 重合时，同一 DM 的同一 run 事件只生成一条消息；不同 DM 分别收到自己的事件。capture 与 clock 原子推进，数据库错误回滚，重试不会重跑工作。capture 和 delivery 均重新校验当前可见性及有效来源；撤销后的 pending event 被永久 suppress。Observer 不唤醒工作 Agent，也不自动启动助理模型。

## 原生历史与下一轮上下文

`assistant_event` 与 `assistant_work` 是消息的原生 source，带可核对的 FK、CHECK 与不可变保护，与普通历史读取共用路径。UI 显示真实来源、提案确认/撤销、watch 开关、周期与实际 run 链接。

助理下一次 turn capture 包含最近最多 50 条 native program messages，受现有 8192-byte context budget 限制；过长 body 截断，超限时移除较旧条目并标记 truncated。内容参与既有序列化、hash 与提交 receipt。已经 capture 的 turn 不因后来的通知变化；下一个实际模型请求才取得新事实。Worker 的 context 行为不变。

## 验证入口

```sh
bash scripts/verify/assistant-core.sh
bash scripts/verify/assistant-browser.sh
```

Core 使用真实迁移的 SQLite、runtime grant 与生命周期，覆盖 purpose、权限矩阵、确认重放、final admission、Group owner、carry、uncertain send、持久 watch、周期时钟、重复通知、多个 DM、撤销 suppression 和事务失败回滚；同时回归 webhook、cron、chat 与 runtime。

Browser 门禁使用 production app、已安装 Pi 和 loopback model fixture，零付费调用。它核对实际 registered/exposed tools、status、observation、提案、Human UI 确认、独立 worker、通知去重、真实下一次模型 context 及 receipt，并保存 desktop/mobile/watch controls/run-link 截图。证据目录为 `.verify/assistant-<timestamp>`。此技术验证不等于 Human UI 体验批准。
