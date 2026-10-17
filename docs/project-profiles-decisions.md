# Project profiles：核心范围与决策记录

状态：讨论中。本文记录已确认的产品决定，不代表实现已经完成。分期以 core-scope.md 为准：一期为当前范围，二期明确要做，未来方向时间未定。

## 已确认的核心

### Project 与沟通范围

- Project 同时提供工作配置和在 Sprout 层硬隔离的协作空间。Sprout 只向 Agent 提供当前 Project 的对话、历史、Tasks、运行、租约及协调信息，不提供其他 Projects 的活动。
- Agent status 只汇总当前 Project 内该 Agent 的 runs；同一 profile 在不同 Projects 的状态、上下文及分身工作相互独立。
- 每个 Project 内的 DM、Group 和 Public Channel 各自属于该 Project；不同 Project 的对话和历史互不混用。
- 同一组参与者在不同 Project 中有独立的对话，不合并为全局对话。
- 分身仍由 Agent profile × Conversation 唯一确定，因此不同 Project 对话中的分身也是独立个体。
- Project 维护自己的 Agent 成员集合，支持添加和移除 Agent；这取代此前“不设 Project 成员名单、所有 profiles 默认参与任意 Project”的决定。
- Public Channel 是特殊 Group，其 Agent 成员始终等于当前 Project 的 Agent 成员集合；Project 添加或移除 Agent 时同步变化，不能在频道内单独调整。除此之外与 Group 规则相同。
- 第一版仍不设置项目级 Agent 角色或权限等级；Group 管理及未来申请批准机制见 communication-decisions.md。
- 从 Project 移除 Agent 时，Public Channel 和普通 Group 同时移除该 Agent；人类与其既有 DM 归档，不能继续聊天。
- 同一 Agent 重新加入 Project 时，自动加入 Public Channel，既有 DM 重新激活、可继续聊天；不自动恢复原来的普通 Group 成员关系，需另行添加。
- 一期 Agent 有活动 runs、持有租约、承担 owner 职责或其 DM 仍有 assigned Tasks 时阻止移除；Human 先手动停止、处理租约、变更 owner、重新分配任务，再正常移除。二期再提供强制移除及自动善后。
- 以上仅针对从当前 Project 移除 Agent，不等于全局删除 Agent profile，也不影响其在其他 Projects 的成员关系、runs 或租约。
- 二期强制移除时的默认责任接续：若该 Agent 是 Group 或 Public Channel owner，由 Human 接任，Tasks 继续留在原 Conversation；其 DM 中尚未完成、仍分配给该 DM 的 Tasks 退回 proposed，清除当前分配，等待重新分配，历史与已有结果保留。
- 二期强制移除时的默认租约处置：撤销该 Agent 在本项目各分身的旧操作权后，自动释放这些分身持有的租约；无法确认撤权成功时，保留占用并交由 Human 处理。文件和进程不随租约释放自动清理。

### Project 的 Machine 成员

- Project 维护 Machine 成员集合；Machine 需加入 Project，才能被该项目 Agents 查询和申请租约。
- 同一物理 Machine 可以加入多个 Projects。每个 Project × Machine 的租约独立，一期同一 Project 内只允许一个分身持有；二期挂靠期间也保持占用。
- 其他 Project 的租约不阻止本 Project 申请，不参与本项目占用显示、协调或收回。
- 共享物理 Machine 引起的工作和资源冲突由 Project organization 负责；Sprout 不做跨 Project 占用仲裁。
- Machine 没有本项目租约时，Human 可直接移除；有持有租约时，先警告 Human（二期挂靠租约同样适用），确认强制移除后撤销该项目在此 Machine 上的租约和操作权，禁止继续申请、认领或凭旧租约操作。
- 受影响的正在运行的 agent-runs 收到明确的资源撤销通知，自行决定换 Machine、继续其他工作或结束，不一律强制中止。
- 无法确认撤权成功时保留待处理占用并交由 Human 处理，不能显示处置成功。文件、进程及其他 Projects 的成员关系与独立租约不随移除而改变。

### 工作目录与仓库数量

- 一个 Project profile 管理一个主工作目录，最多一个 Git 仓库。
- 可以绑定已有目录，也可以通过 Git 配置建立 checkout。
- 同一个 profile 在不同 Machine 上可以有各自的实际工作目录。
- 主工作目录决定默认工作位置，不限制 worker 用户权限内的其他目录访问。Sprout 层的 Project 硬隔离不增加 Machine 文件或进程的操作系统隔离。
- 第一版不提供一个 profile 管理多个工作目录和多个 Git 仓库的配置体系。

### 宿主侧仓库访问

- Project 提供宿主侧仓库访问入口，供日常对话直接分析仓库，无需 Machine 租约，也无需创建 Task。适用范围包括分支与历史查询、源码搜索、代码行数统计及维护建议。
- 可以复用宿主已有副本或按需获取仓库数据，不要求默认完整 clone；宿主入口与各 Machine 的工作目录分别记录，仍对应本 Project 的同一个仓库。
- 分析默认依据已推送的仓库内容。需要最新事实时获取相应数据，并说明来源、版本或查询时点；宿主副本不自动包含各 Machine 的未推送分支、未提交改动或运行现场。
- Machine 上的依赖、配置、进程及启动差异等现场问题，仍通过对应 Machine 的租约和远端工具排查。
- 数据获取与更新方式、磁盘占用管理、宿主 Git 认证来源，以及多分身并发访问宿主副本的处理方式留待技术设计。

### 首次使用与目录复用

- Machine 上尚无该项目时，Agent 可以根据 profile 的 Git remote、默认分支和目录配置自行 clone。
- Agent 准备项目后，记录该 Machine 上的实际工作目录，供后续使用。
- 已有工作目录可以直接绑定和复用，不要求重新 clone。
- 人类不必为每台新增 Machine 提前逐个准备项目 checkout。
- 默认每个 Project × Machine 使用独立的工作目录和 checkout。不同 Project 即使指向同一个 Git 仓库，也分别保留分支、未提交改动和构建产物。
- 独立目录用于组织工作，不构成文件或进程访问隔离。Machine 内部的权限安排、可见性与共享资源冲突由 Project organization 负责。

### Git 认证

- Machine 上访问 Git 仓库使用该 Machine 本地的认证配置，例如 SSH key、credential helper；宿主侧仓库入口的认证来源另行设计。
- Sprout 不集中管理或向 Machine 分发 Git 凭据。
- 认证不可用时，Agent 报告需要补充的配置。

### Git 操作职责

- Profile 保存 Git remote、默认分支和 Git 工作约定。
- Agent 根据配置，通过 shell 完成 clone、pull、commit、push，并在对话中报告结果。
- 第一版不建设专门的 Git 操作界面和流程。
