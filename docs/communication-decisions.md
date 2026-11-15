# 沟通渠道：核心范围与决策记录

状态：讨论中。本文记录已确认的产品决定，不代表实现已经完成。分期以 core-scope.md 为准：一期为当前范围，二期明确要做，未来方向时间未定。

## 已确认的核心

### Project 范围

- Chat（对话）只有 DM 与 Crew 两种，是 Project 内持久的沟通与协作单元；聊天窗口是其界面呈现。
- 每个 Project 拥有各自独立的 DM，以及唯一的 Crew。
- 不同 Project 的对话、历史、Agent status、运行列表和资源协调信息在 Sprout 层硬隔离，Sprout 不向 Agent 提供其他 Projects 的活动；Machine 内部的文件、进程及共享资源由 Project organization 负责。
- Project 维护自己的 Agent 成员集合，支持添加和移除 Agent；这修正了此前“不设项目级 Agent 成员名单”的决定。
- Crew 由 Project 创建且唯一；成员显式加入，不随 Project 成员自动同步。Human 只能把本 Project 的 worker Agent 与 Project 创建者加入 Crew。
- Crew 有且只有一位 lead，是 Crew 内的 Agent 成员。Human 消息、任务与自动化只交给 lead；worker 由 lead 显式委派，正文里的 @ 只是文本，不启动 worker。委托属 CR2，当前契约未实现。
- DM 只有一位 Agent，可以承接 Task；由该 DM 的唯一 Agent 分身负责推进，选择“立即开始”时唤醒它。一期不提供挂靠；二期挂靠也不面向 DM，机器信息展示该分身实际持有的 Machines 和租约状态。
- 分身由 Agent profile × Chat 唯一确定。
- 同一 Project 内，各 Chat 的成员活动、Task 和租约等基本信息由 Info Hub 聚合，对 Human 和 Agents 全部可见；这一决定不自动开放其他对话的聊天正文。

### 一期：Project 成员移除与对话状态

- Agent 有活动 runs、持有租约、担任 Crew lead 或其 DM 仍有 assigned Tasks 时阻止移除；Human 先手动停止、释放或交接、改任 lead、重新分配任务，再移除。
- 正常移除后，该 Agent 退出所在 Crew，其 DM 归档、不可继续聊天。旧 run、待处理唤醒和新消息不能恢复被撤销的参与权；历史、施工记录及已结束 Tasks 保留，其他 Projects 不受影响。
- 同一 Agent 重新加入 Project 时，恢复既有 DM；不自动回到原 Crew，重新加入 Crew 需要 Human 显式添加。

### 二期：强制移除与自动善后

- Human 确认强制移除后，中止该 Agent 在本项目的所有活动 runs、剥夺参与和操作权，不要求先逐项清理。
- 原为 Crew lead 时默认由 Human 接任，Tasks 留在原对话；其 DM 未完成 Tasks 退回 proposed，清除当前分配，历史与已有结果保留。
- 确认旧操作权撤销后自动释放租约；无法确认时保留待处理占用。文件和进程不自动清理。

### Crew 管理

- 每个 Crew 有一位 lead，必须是本 Crew 的当前 Agent 成员。每个 Project 的 Crew 唯一，不提供创建、解散或合并。
- 第一版只有 Human 可以调整 Crew 成员和改任 lead。
- Agent lead 可以组织工作、管理任务和协作说明，不能自行执行上述 Crew 管理变更。

### Crew 内的分工与回报

- 第一版 Crew 只有 lead 的 run；其他成员不因 lead 在对话中的安排或正文 mention 被启动。显式委派、独立子对话与成员回报属 CR2，当前未实现。
- 第一版分工细节只保留在对话和 Task checklist 中，不增加独立的委派单对象或固定开发流转阶段。
- Human 消息只启动 lead 的 run；同一 lead 正在运行时，新输入优先送入当前一轮。

### 未来方向：Crew 管理申请

保留建设意图，实施时间未定，不承诺一期或二期：

- Agent lead 可以申请调整 Crew 成员或改任 lead。
- 人类在该 Agent 的聊天窗口点击“允许”后，执行对应申请。
- 这提供申请与人类批准的路径，不授予 Agent 自行执行这些变更的权限。
- 申请呈现、有效期及状态变化时的校验细节留待后续设计。

### 对话接续与人类控制

- Human 与 lead 的连续对话接续不设固定轮数上限；Agent 之间不按成员关系级联唤醒。
- Crew 只启动 lead 的 run：Human 消息、任务启动与自动化都路由给 lead。worker 不进入 Crew 主对话的唤醒候选，其输入来自 lead 的显式委派（CR2）。DM 保持给唯一 Agent 分身。
- 存在 assigned Task 不改变路由，也不启动周期 LLM 判定：Crew 仍交给 lead，DM 交给唯一分身。需要接续时由当前责任人在对话中继续；Human 暂停和停止控制仍然有效。
- 人类可以随时暂停自动唤醒或停止分身运行；对话接续不得立即抵消人类的停止操作。

### 忙碌分身与新消息

- 分身正在工作时，后续需要它处理的消息优先送入当前一轮，让它尽快看到并调整工作。
- 当前一轮结束前仍未处理的消息进入下一轮。
- 同一分身保持串行执行，不为后续消息另外启动并行运行。

### Info Hub 变更提示

- Agent 每轮 run 开始时由 Info Hub 提供基本信息快照；运行中出现相关信息变化时，插入简短通知，标明变化的范围或类型，并提示“感兴趣请主动获取，否则忽略”。
- 提示从简：同一 run 最多每 60 秒收到一条，多次变化合并进同一条；纯心跳（例如 Machine 连接每次上报的 `lastSeenAt`）不算变化，不产生提示。提示只属于当前 run，run 工作结束后待发的提示直接丢弃，不补发、不因此唤醒或延长 run。
- 提示不自动附带完整变更记录，不强制回复或查询，不为普通状态变化单独唤醒空闲分身。
- 需要行动的事件按明确规则通知或唤醒，例如 Task 的“立即开始”，以及二期的挂靠超时提醒；Machine 移出 Project 后，受影响的活动 runs 收到明确的资源撤销通知，自行决定换 Machine、继续其他工作或结束，不一律强制中止。人类暂停控制仍然有效。
- 普通变更提示默认覆盖当前 Chat，以及该分身自己持有或正在申请的 Machine／租约；Project 其他信息仍可主动查询。具体内容与信息来源见 info-hub-decisions.md。

### 二期：申请遇阻等待

一期机器占用由 Crew lead、持有者或 Human 通过对话协调，可直接交接；二期不再新增协调请求，申请遇阻时只等待。

- 等待、候选 Machine 与持有者均限于当前 Project；其他 Projects 在同一物理 Machine 上持有独立租约，不影响本项目判定。
- Machine 申请遇阻时，申请者进入一次**阻塞式**等待，等多久由它自己指定（建议 5 分钟，上限 1 小时，不提供按 Project 配置）；等待期间不抢占、不自动释放，也不向持有者发送任何请求，对持有者不可见；不从普通聊天文本推断意图。
- 不做协调事件通道，不依赖 LLM/JEV 唤醒持有者，不做有限尝试与重复合并，也不存在“协调请求”这个实体。
- 等待到点仍拿不到，就以“失败 + 原因”直接返回给申请方 Agent（阻塞式，结果同步可见），由它自己决定当前 run 是否需要提前中止并汇报。等待期间该身份不接其他工作。
- 原有成员、领取范围、租约授权及人类控制边界仍适用；等待本身永不释放租约。完整规则见 machines-decisions.md。

系统主动提醒包括挂靠超时与 Agent run 注意力阶梯，均写入发生地 Chat。挂靠首次提醒在 Agent lead 分支直接投递 lead input，Human 只收 Chat 消息；后续升级规则见 [Machines 决策](machines-decisions.md)。

Run 从 `startedAt` 起默认 30 分钟写注意力事实：Crew 的 lead 不是本 run 执行者时写系统消息并直接投递 lead input；lead 自己执行与 DM 只写事实，不提前发消息。第 60 分钟统一写一条人类提醒并暂停该 run 的 lead 自动重试；晚扫仍按理论 deadline 加 escalation 计算。系统来源固定为 `sprout.run-attention`，消息不走普通唤醒判定或自动续接。人类收件人从首条 human 输入发送者、执行 Profile 创建者及 Project 创建者收集，再按当前 Chat 成员及项目访问权过滤；仅在当前 Chat 提醒，无独立通知通道。Run 注意力不受 `SPROUT_CONTINUATION_ENABLED` 限制。

### Crew 与 DM 的路由

- Crew 不按上下文判定或成员广播选择收件人；Human 消息、任务启动与自动化固定交给 lead。lead 的 run 已在运行时，输入送入当前 run，不另起重复 run。
- worker 的正文 mention 只用于显示与消息记录，不产生唤醒、不启动 worker。worker 的输入只来自 lead 的显式委派（CR2）。
- DM 只有一位 Agent，消息直接交给它的唯一分身；DM 不适用 Crew 的 lead 路由。
- 不需要按 LLM/JEV 判定选择收件人，也不存在一次消息唤醒多名 Agents 的扇出。

