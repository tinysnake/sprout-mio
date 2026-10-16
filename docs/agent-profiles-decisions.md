# Agent profiles：核心范围与决策记录

状态：讨论中。本文记录已确认的产品决定，不代表实现已经完成。分期以 core-scope.md 为准：一期为当前范围，二期明确要做，未来方向时间未定。

## 已确认的核心

### 人设与执行配置

- Agent profile 包含名称、人设指令，以及默认的 harness、model、effort。
- 创建分身时直接使用 profile 的默认配置，不要求逐个分身另行选择。
- Profile 可用于不同 Project；各 Project 维护自己的 Agent 成员集合，支持添加和移除 Agent。Public Channel 成员自动跟随该集合。
- 从 Project 移除 Agent 时，它同时退出 Public Channel 和普通 Group，与人类的既有 DM 归档、不可继续聊天。
- 同一 Agent 重新加入 Project 时，自动加入 Public Channel，既有 DM 重新激活；不自动加回原来的普通 Group，需另行添加。
- 一期 Agent 有活动 runs、持有租约、承担 owner 职责或其 DM 仍有 assigned Tasks 时阻止移除；Human 先手动处理这些关联，再正常移除。
- 二期提供强制移除及自动善后：中止 runs、撤权，Human 接任 owner、DM 未完成 Tasks 退回 proposed，确认撤权后释放租约；无法确认时保留占用。历史、施工记录、文件、进程及其他 Projects 不随之删除或改变。完整规则见 core-scope.md。

### 配置更新

- 修改 profile 的人设、model 或 effort 后，已有分身从下一轮运行开始使用新配置。
- 正在执行的一轮不受此次修改影响。
- 配置更新保留各分身的对话历史、身份和已持有租约，不重建分身。

### 分身身份

- 一个分身由 Agent profile × Conversation 唯一确定，同一 profile 在一段对话中最多有一个分身。
- 同一对话中的多轮运行属于同一个分身，运行结束或服务重启不改变其身份。
- 不同对话中的分身是独立个体，不能共享或代用彼此的 Machine 租约。

### Agent status 与活动 run 信息

- Info Hub 分别展示 Agent 的 status（运行中、待机中、出错及具体错误），以及按 Conversation 关联的正在运行的 agent-runs。
- 该 Agent 在某个 Conversation 没有活动 run 时，不显示该 Conversation 的运行条目；这不改变对话成员、分身身份或租约记录。
- 有活动 agent-run 时，status 为运行中；新 run 启动即按此规则显示，不设置 turn 数门槛。
- 所有相关 agent-runs 都已结束，且最后一个 run 报错时，status 为出错，展示该 run 的具体错误；都已结束且不满足此条件时为待机中。
- 上一轮错误保留在对应 run 的记录中，不阻止当前状态显示运行中。最近一轮 run 的结果不作为独立基本信息展示项。
- status 仅汇总当前 Project 内该 Agent 的全部 runs。Project 是 Sprout 信息和上下文硬边界，Sprout 不提供其他 Projects 的活动；同一 profile 在其他 Projects 的 runs 不影响当前 status，也不进入活动 run 列表。

### Pi 配置与认证来源

- 默认沿用宿主机已有的 Pi skills、extensions 和工具配置，再加载 Sprout extension。
- 模型认证同样复用宿主 Pi 的现有配置；profile 负责选择 model 和 effort。
- 第一版不另建 Sprout 专用的默认工具配置或模型凭据管理功能。
- 配置与认证来源的复用不改变各对话分身的独立身份、历史和租约归属。

### 本地与远端工具

- 原有 Pi 文件、shell 及其他工具保持原有行为，继续操作 harness 所在机器。
- Sprout extension 另提供明确指定 Machine 的远端操作工具。
- 两套工具并存，由 Agent 选择使用；不将原有工具自动重定向到 Machine。
- Agent 可以通过 Project 的宿主侧仓库入口分析分支、源码和历史等，无需 Machine 租约，也无需先创建 Task。宿主副本与 Machine 现场分别识别，回答依据的来源和版本不能混用。
- 需要读取或操作 Machine 现场时，包括机器相关的环境排查和任务中的只读确认，仍使用远端工具并取得对应租约；DM 中可以直接申请，Task 不是租约申请的前提。
- 远端 Machine 操作必须核验分身所属 Project、Machine 是否加入该 Project，以及分身在该 Project × Machine 上的持有租约。其他 Project 的租约不授予本项目操作权。
- Project 硬隔离限定在 Sprout 数据、上下文和授权层。原有宿主本地工具与获租约后的整机操作能力继续保留，不承诺由 Sprout 提供操作系统层面的项目隔离；Machine 内部由 Project organization 负责。

### 远端工作

- Harness 运行在 Machine 之外，通过 harness 扩展或 MCP tools 操作 sprout-worker 提供的 Machine 能力。
- Machine 不要求安装 agent harness。
- 第一版只接入 Pi，通过 Pi extension 打通对话、分身和远端 Machine 操作。
- 其他 harness 及其 MCP tools 接入属于未来方向，实施时间未定，不承诺二期。

## 未来方向：模型用量与成本

- 保留按 run 和 Conversation 的 token 用量与费用记录、查询能力的建设意图；实施时间未定，不纳入一期，也不承诺二期。
- 费用估算口径、价格来源及呈现方式留待后续设计。
