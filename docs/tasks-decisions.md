# Tasks：核心范围与决策记录

状态：讨论中。本文记录已确认的产品决定，不代表实现已经完成。分期以 core-scope.md 为准：一期为当前范围，二期明确要做，未来方向时间未定。

参考：原 Sprout issue #260（WG-assigned Tasks and conversation-owned execution）及 #261–#264。旧 issue 的其他决定作为讨论基线，不自动视为本轮全部确认。

## 已确认的核心

### 任务归属与推进责任

- Task 属于 Project，分配给一个 Conversation；DM、Group 和 Public Channel 都可以承接 Task。
- Conversation 是三种对话的统一概念，见 core-scope.md；Public Channel 是特殊 Group。
- 当前 Group owner 负责推进该 Group 的 Task，可以组织组内其他 Agents 协作。Public Channel 沿用同一规则，由人类指定和变更 owner；其特殊之处仅在于成员始终跟随 Project。
- DM 只有一位 Agent，由该 DM 中的唯一 Agent 分身负责推进其承接的 Task。
- Group owner 可以是人类或 Agent；第一版普通 Group 成员调整、owner 变更及解散仅由人类执行。Public Channel 的成员只跟随 Project，不能单独调整。未来的 Agent 申请与聊天窗口批准路径记录在 communication-decisions.md。
- Task 分配给 Conversation，不直接分配给某次 run 或任意分身；DM 的唯一 Agent 分身承担推进责任，不改变 Task 的 Conversation 归属。

### Task 状态

- Task 只保留 proposed、assigned、finished、canceled 四种状态，不增加 begin/running 状态或额外的已启动标志。
- proposed 表示待分配；assigned 表示已分配给 Conversation；finished 表示已完成；canceled 表示已取消。
- 是否已开始工作、当前应继续还是等待，由 Agent 依据对话上下文判断，不要求通过额外 Task 执行状态表达。
- Task 状态、Agent 运行及 Machine 租约分别独立。

### 当前开发流程

- 当前阶段由承接 Task 的 Conversation 自行组织开发流程；Group owner 或 DM 的唯一 Agent 分身根据任务决定实现、review 和测试方式，Group 内的分工由 owner 组织。
- Task 提供目标、约束、完成要求、checklist 和施工记录；完成结果保存在最后一条施工记录中。Sprout 提供沟通、唤醒、任务记录与 Machine 操作能力。
- 第一版由 owner 直接在 Group / Public Channel 中安排分工，成员在同一对话中回报进度、结果或阻碍，owner 汇总并继续组织工作。分工细节保留在对话和 Task checklist 中，不增加独立的委派单对象。
- 当前不内置固定开发阶段、阶段负责人及流转条件。
- 这是当前阶段的选择；以后是否增加内置 workflow 尚未决定。

### 分配与启动

- Task 分配给 Conversation 时，可选择“立即开始”。
- 选中时，Group 和 Public Channel 通知或唤醒 owner，DM 唤醒其中的唯一 Agent 分身；未选中时只保存分配，不自动启动工作。
- 分配本身不代表任务已经在执行。

### 未完成任务的自动接续

- Conversation 中只要有 assigned Task，系统就定期唤醒小脑检查；同一 Conversation 的多个 assigned Tasks 在一次检查中结合判断。没有 assigned Task 时停止该对话的 Task 周期检查，proposed、finished、canceled 不触发此检查。
- 小脑依据 Task、对话上下文和当前运行情况，判断是否需要唤醒负责人继续推进。周期检查不以所有 Agents 停止执行为前提，也不代表每次都唤醒负责人。
- 不增加 Task 执行状态或额外启动标志，也不要求负责人强制填写结构化的下一步、等待条件或接续安排；对话已有上下文可以承载这些信息。
- 需要接续时，Group / Public Channel 通知或唤醒当前 owner，DM 通知或唤醒唯一 Agent 分身；owner 为 Human 时提醒 Human 处理。负责人根据上下文继续组织工作、等待已有结果或说明阻碍并请求 Human 处理。
- 分配本身不代表已经启动。未选择“立即开始”的 assigned Task 也进入小脑周期检查，但是否启动或继续由小脑结合对话上下文判断，不因 assigned 就直接反复唤醒负责人。run 结束本身也不代表 Task 已完成或无需继续。
- 投递时核对 Task 状态和当前责任归属，保持同一分身串行，不重复启动并行 run。人类暂停自动唤醒或停止运行的控制优先，自动接续不得立即抵消人类的停止操作。
- 不为此引入固定开发 workflow。小脑检查周期、上下文范围、与普通聊天判定器的关系、重复唤醒及持续失败的处理留待设计。

### 施工记录

- Task 可以留存施工记录，记录工作过程中的进展、发现、验证、阻碍及相关交付物引用。详细讨论仍可保留在 Conversation 中，施工记录可以引用对应消息。
- 完成结果就是任务完成时的最后一条施工记录，不另设独立的结果填写流程。记录可以包含简短说明及 commit、文件、链接等引用。
- 施工记录不构成固定开发阶段，也不要求每次工具调用或每轮 run 都新增记录。

### 完成与验收

- 负责推进的 Group owner 或 DM 唯一 Agent 分身可以根据任务要求直接将 Task 标记完成，以最后一条施工记录留存完成结果。
- 人类可以检查、纠正或重新打开任务。
- 不增加强制待验收状态，也不要求通过独立 completion claim / validation 流程才能完成。
- 具体任务若需要人类验收，可以在任务的完成要求中明确约定。
- 完成结果沿用施工记录，不增加单独的结果字段或强制验收步骤。

### Agent 成员移除与任务责任

- 一期 Agent 有活动 runs、持有租约、承担 owner 职责或其 DM 仍有 assigned Tasks 时阻止移除；Human 先手动停止或交接、变更 owner、重新分配任务。
- 以下默认接续属于二期强制移除的自动善后，一期不执行：Human 确认后中止该 Agent 在本项目的活动 runs 并剥夺权限。
- 若其为 Group 或 Public Channel owner，默认由 Human 接任；Tasks 继续留在原 Conversation，状态不因 owner 接任而改变。
- 其 DM 中尚未完成、仍分配给该 DM 的 Tasks 退回 proposed，清除当前分配，等待重新分配；历史与已有结果保留。
- 已 finished 或 canceled 的 Tasks 保持原状态；强制中止 run 不代表 Task 已完成或已取消。

### 与 Machine 租约的关系

- 一期 Machine 租约由具体 Agent 分身持有、直接交接和释放；二期增加挂靠与领取。
- Task 的归属和推进责任不代替分身的租约身份与操作权。

## 待收敛

- Task 标题、说明、约束、完成要求、checklist 及施工记录的具体记录形式。
- 小脑周期检查的间隔、上下文范围、与普通聊天所选小脑/JEV 判定路径的关系，以及如何提供相关 runs 或外部工作的事实。
- 重复检查和唤醒合并、持续失败时的重试或升级规则，以及人类停止后的恢复方式。
