# Tasks：核心范围与决策记录

状态：讨论中。本文记录已确认的产品决定，不代表实现已经完成。分期以 core-scope.md 为准：一期为当前范围，二期明确要做，未来方向时间未定。

参考：原 Sprout issue #260（WG-assigned Tasks and chat-owned execution）及 #261–#264。旧 issue 的其他决定作为讨论基线，不自动视为本轮全部确认。

## 已确认的核心

### 任务归属与推进责任

- Task 属于 Project，分配给一个 Chat；DM 与 Project 的 Crew 都可以承接 Task。
- Chat 只有 DM 与 Crew 两种对话，见 core-scope.md；每个 Project 唯一的 Crew 由 lead 对 Human 负责。
- Crew 的 Task 责任人是 lead，由 lead 组织 Crew 内成员推进；DM 只有一位 Agent，由该 DM 的唯一 Agent 分身负责推进其承接的 Task。
- Crew 成员显式加入，不随 Project 成员自动同步；lead 必须是 Crew 的 Agent 成员。Crew 成员与 lead 的调整仅由 Human 执行，未来 Agent 申请与聊天窗口批准路径记录在 communication-decisions.md。
- Task 分配给 Chat，不直接分配给某次 run 或任意分身；DM 的唯一 Agent 分身或 Crew 的 lead 承担推进责任，不改变 Task 的 Chat 归属。

### Task 状态

- Task 只保留 proposed、assigned、finished、canceled 四种状态，不增加 begin/running 状态或额外的已启动标志。
- proposed 表示待分配；assigned 表示已分配给 Chat；finished 表示已完成；canceled 表示已取消。
- 是否已开始工作、当前应继续还是等待，由 Agent 依据对话上下文判断，不要求通过额外 Task 执行状态表达。
- Task 状态、Agent 运行及 Machine 租约分别独立。

### 当前开发流程

- 当前阶段由承接 Task 的 Chat 自行组织开发流程；Crew 的 lead 或 DM 的唯一 Agent 分身根据任务决定实现、review 和测试方式，Crew 内的分工由 lead 组织。
- Task 提供目标、约束、完成要求、checklist 和施工记录；完成结果保存在最后一条施工记录中。Sprout 提供沟通、任务记录与 Machine 操作能力。
- 第一版 Crew 只有 lead 运行，lead 根据任务决定实现、review 和测试方式；其他成员不因正文 mention 或对话安排被启动。显式分工、成员回报与 worker 子对话属 CR2，当前未实现。分工细节只保留在 Task checklist 中，不增加独立的委派单对象。
- 当前不内置固定开发阶段、阶段负责人及流转条件。
- 这是当前阶段的选择；以后是否增加内置 workflow 尚未决定。

### 分配与启动

- Task 分配给 Chat 时，可选择“立即开始”。
- 选中时，Crew 通知或唤醒 lead，DM 唤醒其中的唯一 Agent 分身；未选中时只保存分配，不自动启动工作。
- 分配本身不代表任务已经在执行。

### 未完成任务的继续

- 没有周期性的自动判定。存在 assigned Task 不改变路由：Crew 仍只交给 lead，DM 交给唯一 Agent 分身。
- Crew 的 lead 根据 Task、对话上下文和当前运行情况继续组织工作；worker 的输入来自 lead 的显式委派（CR2）。DM 的唯一分身自行继续。
- 不增加 Task 执行状态或额外启动标志，也不要求负责人强制填写结构化的下一步或等待条件；对话已有上下文可以承载这些信息。
- 需 Human 处理时，由 lead 或 DM 分身说明阻碍并在对话中请求；Human 负责的分配由 Human 自行推动。
- 分配本身不代表已经启动。未选择“立即开始”的 assigned Task 也不会自动反复启动负责人；run 结束本身也不代表 Task 已完成或无需继续。
- 投递时核对 Task 状态和当前责任归属，保持同一分身串行，不重复启动并行 run。人类停止运行的控制优先，任何自动投递都不得立即抵消它。
- 不为此引入固定开发 workflow。

### 施工记录

- Task 可以留存施工记录，记录工作过程中的进展、发现、验证、阻碍及相关交付物引用。详细讨论仍可保留在 Chat 中，施工记录可以引用对应消息。
- 完成结果就是任务完成时的最后一条施工记录，不另设独立的结果填写流程。记录可以包含简短说明及 commit、文件、链接等引用。
- 施工记录不构成固定开发阶段，也不要求每次工具调用或每轮 run 都新增记录。

### 完成与验收

- 负责推进的 Crew lead 或 DM 唯一 Agent 分身可以根据任务要求直接将 Task 标记完成，以最后一条施工记录留存完成结果。
- 人类可以检查、纠正或重新打开任务。
- 不增加强制待验收状态，也不要求通过独立 completion claim / validation 流程才能完成。
- 具体任务若需要人类验收，可以在任务的完成要求中明确约定。
- 完成结果沿用施工记录，不增加单独的结果字段或强制验收步骤。

### Agent 成员移除与任务责任

- 一期 Agent 有活动 runs、持有租约、担任 Crew lead 或其 DM 仍有 assigned Tasks 时阻止移除；Human 先手动停止或交接、改任 lead、重新分配任务。
- 以下自动善后属于二期强制移除的行为，一期不执行：Human 确认后中止该 Agent 在本项目的活动 runs 并剥夺权限。
- 若其为 Crew lead，默认由 Human 接任；Tasks 继续留在原 Chat，状态不因 lead 接任而改变。
- 其 DM 中尚未完成、仍分配给该 DM 的 Tasks 退回 proposed，清除当前分配，等待重新分配；历史与已有结果保留。
- 已 finished 或 canceled 的 Tasks 保持原状态；强制中止 run 不代表 Task 已完成或已取消。

### 与 Machine 租约的关系

- 一期 Machine 租约由具体 Agent 分身持有、直接交接和释放；二期增加挂靠与领取。
- Task 的归属和推进责任不代替分身的租约身份与操作权。

## 待收敛

- ~~Task 标题、说明、约束、完成要求、checklist 及施工记录的具体记录形式。~~ **P5b 已定**：元数据在 `task`；checklist 为独立条目表，position 按 Task 内历史最大值递增，软删除且不复用位置；施工记录为承接 Chat 的 message，按 Task 内 seq 递增、不可改删，分 start/progress/correction。完成结果沿用末条进度或纠正记录，只有 start 不能完成；Human 对 finished 的纠正追加记录并保留历史完成引用。具体形状见 [P5b 契约](p5b/contracts.md)。
- 重复检查和唤醒合并、持续失败时的重试或升级规则，以及人类停止后的恢复方式。
- Crew lead 的委派与 worker 子对话（CR2），以及子对话如何向主对话汇总结果。
