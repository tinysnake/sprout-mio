# 原生助理契约

本单元在现有 Project DM 中实现独立助理。Feishu、语音和外部 channel 仍在后续范围。Human UI 体验确认保持 pending。

## Profile 与运行边界

`agent_profile.purpose` 为 `worker | assistant`，默认 worker，创建后不可修改。旧行与缺少 purpose 的历史 snapshot 按 worker 解释。助理仍使用自己的 model、effort、persona，属于 Project 成员；只可在 Human 所有的普通 DM 运行，不能成为 Group 成员、Public Channel 隐式成员或 webhook / cron / Task 工作目标。

助理不准备 repo checkout、lease、remote execution 或 inherited resources。实际安装的 Pi 在注册和声明两个层面只接受 `sprout_status` 与 `sprout_assistant_observe`、`sprout_assistant_propose`、`sprout_assistant_watch`；runner 会核对完整 registry。普通工作 session 不会作为助理的 previous session 重新打开。工具定义与 gateway admission 共享 `ASSISTANT_TOOL_SPEC`。

Gateway grant 冻结 purpose。身份只能沿 grant → running run → instance → DM → Human 当前权限取得，调用者不能指定 principal。助理 call 不能用于 worker grant，worker call 不能用于助理 grant。普通 Agent 的 Project equality 与 Chat/instance 隔离继续执行。观察接口分页有界，只返回当前 Human 可见的 factual Project、Chat、run 和活动信息；不替目标 Agent 推断业务成功。Remote client 先按严格的助理响应契约解析 observe/propose/watch，避免落入普通执行或租约分支造成 `invalid_response`。

## 提案与确认

提案目标为 `dm_agent`、`group_agent`、`group_owner`。DM 提案允许只给 Project 与 Agent，由入口解析或创建规范 DM；观察结果提供名称和标识供模型选择，不要求 Human 手工填写 Chat ID。提案时解析并固定目标 Project、Chat、profile、instance、body、version 与 operation hash。提案有效期 24 小时；仅 Human 可确认。确认事务重新检查来源 DM、目标可见性、成员、purpose 和精确目标。Group owner 变化要求重新提案；Human owner 的 Group 可以指定某个工作 Agent。

确认在 IMMEDIATE 事务内创建一个原生 `assistant_work` message，直接给所选 instance 分配 input，不经过 Human 消息 fanout。重复确认先校验当前权限与目标，再返回同一 message receipt。消息来源明确是 Human 已确认的程序提案，不伪装为 Human 或工作 Agent 发言。

第一次 prompt 和每次 steer 前再次核对 Human 权限、来源 DM、固定目标、message/instance/run lineage。无效的未投递 input 取消为 `assistant_context_changed`。只在真实 admission 时写 `admittedAt` 并建立 proposal interest；未投递 input 被 carry 后只跟随实际接收它的 run。此前 run 的完成不表示该提案完成。queued 失败或取消会产生事实性 intervention。

`admittedAt` 在外部 send 前持久化，发生不确定的传输异常后不盲目再次发送。这是 durable at-most-once admission；不声称分布式 exactly-once 或外部执行成功。

## Watch、时钟与通知

八张表分别为 `assistant_proposal`、`assistant_watch`、`assistant_watch_cursor`、`assistant_preferences`、`assistant_interest`、`assistant_run_cursor`、`assistant_event`、`assistant_watch_summary`。interest 保留 watch/proposal 两种来源，proposal clock 按 DM/run 合并，watch cursor 按关注关系保存窗口与消息游标，event key 在 DM 内唯一。

模型通过 `sprout_assistant_watch` 提出 watch intent，由 Human 激活。watch 持久关注 Chat，覆盖已有和随后新建的工作 run，包括多 Agent 与短 run。`active: false` 可直接停止当前助理 DM 的相应关注，重复调用保持停止状态，不要求 Human 再点击界面，也不取消目标工作。Human 可从标题栏始终可见的“正在关注”入口查看全部有效关注，包含 DM / Group /公共频道类型、目标名、Project 和周期；没有关注时显示“暂无关注”。即使目标 DM 已归档，也可以取消原有关注；目标访问检查只限制新增关注。

每条 watch 独立保存周期，默认 300 秒，范围 60–86400 秒。工具可设置或调整已有 watch 的周期，首次关注仍需 Human 确认，改周期不能改变关注目标或授权。确认携带对应 intent 的 `eventId`。Human 可拒绝准确的待确认 intent，拒绝持久化且可重放，不会停止已经有效的关注。确认、拒绝与取消会消费对应旧 intent，刷新页面不会重新弹出旧确认。取消后新的明确关注请求仍可产生新 intent；重新激活创建新 watch id。

Runtime 按每条 watch 的持久窗口汇总普通 Human、Agent、自动化消息和工作活动。只因 watch 关注的 run 不再逐个即时发送终态通知。窗口无消息、无活动时不发空通知；有内容时各保留最多 50 条消息与 50 个 run 的来源标识，正文摘录最多 4 条消息与 3 条 run 活动，并在来源超限时明确标记。分批读取候选 run，先检查窗口内变化再计入限额，避免无变化的旧 run 挤掉后续活动。当前动作和持续时间来自程序事实。窗口原始消息与 run 事实不可变保存，独立总结进程使用助理配置的模型与 effort，归纳发生了什么、变化和待 Human 决策事项。总结进程没有 tools、session history 或 extensions，不启动目标工作 Agent；输入作为不可信资料处理，不推断未证实的业务成功。

proposal interest 继续使用既有即时完成/介入通知及默认 300 秒的工作进展时钟。已由 proposal 通知覆盖的输入与回复从 watch 摘要排除，避免重复转发。同一 DM 内按 event key 去重，不同 DM 分别保存事件。Run 终态只停止该 run 的 clock，保留 Chat watch。

窗口、消息游标与 event 原子推进，数据库错误回滚，重试不会重跑工作。capture 和 delivery 均重新校验当前可见性及有效来源；失权窗口关闭且不补发，撤销后的 pending event 被永久 suppress。无法继续读取的旧提案也写入 suppressed outcome，让扫描继续推进。Observer 不唤醒工作 Agent，模型总结通过独立 durable job 执行，不进入助理对话 session。job 全局并发最多 2，lease 为 120 秒，子进程硬超时 90 秒，最多尝试 3 次；失效 lease 重领使用 token fencing，重试等待按 30 秒指数递增。claim、生成结束和投递前重新检查权限及有效关注。原始事实与最多 800 字摘要分开保存；仅完成或明确失败的总结进入投递限额，100 条未完成任务不会挡住其他 DM 的就绪通知。失败显示生成失败，不把原文当摘要。旧版 digest 明确标注旧记录，不自动补算或重发。窗口迁移从当前边界初始化已有有效 watch，保留 consent，不回放旧历史。

## 原生历史与下一轮上下文

`assistant_event` 与 `assistant_work` 是消息的原生 source，带可核对的 FK、CHECK 与不可变保护，与普通历史读取共用路径。UI 显示真实来源、提案确认/撤销、watch 开关、周期与实际 run 链接。

助理初始 turn capture 包含最近最多 50 条 native program messages，读取时核对目标的当前可见性，受现有 8192-byte context budget 限制；过长 body 截断，超限时移除较旧条目并标记 truncated。内容参与既有序列化、hash 与提交 receipt。已经 capture 的初始 turn 保持不变。

活跃助理收到新的 Human steer 时，重新采样当时可见的 native facts，另存最多 8192 bytes 的 `agent_run_input.assistant_context`。runner 校验 run/message 身份与 hash，将该快照与 Human 输入一起交给 Pi steer。只有匹配的 runner ACK 才同时写入输入 delivered 与 `assistant_context_submitted_at`；这证明 Pi 接纳了该输入，不独自证明模型已消费。尚未接纳的输入若 carry 到下一轮，清除未提交的快照，由下一轮重新 capture。已提交的初始上下文和输入快照不可变。Worker 的 context 与 steer 文本保持原行为。

## 验证入口

```sh
bash scripts/verify/assistant-core.sh
bash scripts/verify/assistant-browser.sh
```

Core 使用真实迁移的 SQLite、runtime grant 与生命周期，覆盖 purpose、权限矩阵、确认重放、final admission、Group owner、carry、uncertain send、持久 watch、周期时钟、重复通知、多个 DM、撤销 suppression 和事务失败回滚；同时回归 webhook、cron、chat 与 runtime。新增回归覆盖归档后取消关注、100 条失权旧提案后的其他 DM 投递，以及每条 Human steer 的快照、错误 hash 拒收和未提交 carry。

Browser 还让助理在工作汇总事件到达时保持 streaming，再投递 Human steer。该 fixture 注入 watch 截止时间，核对 watch 不即时发送完成通知，以及原始 turn 未变化、每条输入的快照与 ACK，并由 loopback 模型请求中的实际 JSON context 核对新 event/message id。59/60/120 秒窗口与重启边界由注入时钟的 core 用例验证，不把浏览器截止时间注入当作真实 60 秒墙钟证明。

Browser 门禁使用 production app、已安装 Pi 和 loopback model fixture，零付费调用。它也验证独立总结与保持 streaming 的助理 session 并行、空 tools、模型摘要投递及 Reject 刷新后不复活。独立 Pi 测试覆盖配置继承、tool-call 拒绝与挂起 child abort；回环输出证明链路，不证明真实付费模型的语义质量。它核对实际 registered/exposed tools、status、observation、提案、Human UI 确认、独立 worker、通知去重、真实下一次模型 context 及 receipt。延迟 panel 响应在另一条助理 DM 完成加载后释放，核对当前面板不显示旧 DM 的提案，覆盖既有 Chat 路由的实例隔离。它保存 desktop/mobile/watch controls/run-link 截图。证据目录为 `.verify/assistant-<timestamp>`。此技术验证不等于 Human UI 体验批准。
