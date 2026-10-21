# Info Hub：核心范围与决策记录

状态：讨论中。本文记录已确认的产品决定，不代表实现已经完成。分期以 core-scope.md 为准；Info Hub 多视角、快照和变更提示保持一期，挂靠、自动协调及强制移除善后的关联信息随二期能力接入。

参考：原 Sprout issue [#266（Working group glance）](https://github.com/tinysnake/sprout/issues/266)。本轮决定优先于旧 issue；旧 issue 的具体实现和其他要求不自动纳入第一版。

## 已确认的核心

### 定位与信息来源

- Info Hub 是功能模块，承担 Sprout 基本信息的统一聚合与访问，为 Human 界面展示和 Agent 信息获取提供支持；其职责不以某个页面或展示位置为边界。
- 目的：以尽量简单的方式，让 Human 和 Agents 获取足够全面的基本信息，理解当前协作局面。
- 基本信息来自已有的 Project、Chat、Agent 分身、Task、Machine 和租约等对象。源对象维护各自的事实与操作，Info Hub 聚合信息、关联对象并提供查询，各界面负责呈现。
- 任何需要展示相关信息的页面或组件，都可以按需从 Info Hub 获取，包括列表、摘要、侧边栏和详情；不能把 Info Hub 限定为少数页面上的信息区域。同一状态和关联应沿用模块提供的一致含义，不由各页面分别推导。
- 第一版不在 Info Hub 中独立发布或维护公告、笔记等内容。
- 聚合范围不限于 Group；API、内部模块划分及各处的具体界面布局尚未确定。
- 前端按上下文分散展示 Info Hub 信息，包括 Project 页面、Chat 侧边栏或手机对应的信息视图、Task 详情、Agent 简单信息与详细信息等相关位置，不设置独立的一级 Info Hub 页面。
- 各处支持通过 link 定位关联对象，沿用 SPA 的 URL 定位要求；具体导航与客户端方向见 [Web UI 与 PWA](web-ui-decisions.md)。

### 多视角获取

| 视角 | 第一版需要回答的问题 |
| --- | --- |
| Project → Agents | 分别展示各 Agent 的 status（运行中、待机中、出错及具体错误），以及其按 Chat 关联的正在运行的 agent-runs；没有活动 run 的 Chat 不进入这份运行列表。 |
| Project → Machines | 当前 Project 已加入哪些 Machines？连接状态及本 Project 内持有者是谁？二期另展示挂靠、自动归还或交接请求、结果及保留原因。 |
| Chat → 自身与成员 | 对话属于哪种类型？是否已归档？有哪些成员？各成员 Agent 的 status 是什么？该对话中有哪些正在运行的 agent-runs？ |
| Chat → Tasks | 对话承接了哪些 Tasks？各 Task 的基本状态是什么？ |
| Chat → Machines | 展示该 Chat 中分身持有的 Machines 和租约状态；二期另展示挂靠到 Group / Public Channel 的租约。 |
| Agent 分身 → Machines | 该分身当前持有哪些 Machine 租约？ |

Chat 的定义及三种类型见 [core-scope.md](core-scope.md)。Public Channel 成员跟随 Project，其余规则与 Group 相同，包括 owner、Task、一期直接交接和二期挂靠。DM 只有一位 Agent，可以承接 Task，由唯一分身推进，选择“立即开始”时唤醒它；一期不提供挂靠，二期挂靠也不面向 DM。

### 成员变化与归档状态

- 一期 Agent 有活动 runs、持有租约、承担 owner 职责或其 DM 仍有 assigned Tasks 时阻止移除；Human 先手动处理这些关联。Info Hub 展示实际关联，不自行完成清理或责任转移。
- 正常移除后展示 Public Channel、普通 Group 更新后的成员及 DM 归档状态；历史、施工记录和已结束 Tasks 保留。重新加入时展示 Public Channel 和既有 DM 恢复，普通 Group 不自动恢复。
- 二期强制移除及自动善后上线后，再展示 runs 中止、Human 接任 owner、DM Tasks 退回及租约撤销结果；无法确认撤权时保留待处理占用，不误报释放成功。
- Info Hub 展示源对象事实，不自行执行成员调整、对话恢复或自动善后；文件和进程保持独立生命周期。

### Machine 移出 Project 的状态

- 没有本项目租约的 Machine 可直接移除；有持有租约时，Human 经警告确认强制移除后，由成员与租约机制撤销本项目租约及操作权，二期新增挂靠租约同样适用。Info Hub 展示源对象的成员与处置结果。
- 无法确认撤权成功时，仍展示待处理占用及需 Human 处理的事实，不能因 Machine 已移出可申请列表就把租约显示为已释放或处置成功。
- 受影响的正在运行的 agent-runs 收到明确的资源撤销通知，自行决定如何继续；Info Hub 不据此推断 run 已结束或 Task 状态改变。
- 文件、进程和其他 Projects 的独立租约保持原有生命周期。

### 基本状态与关联

| 对象 | 第一版基本信息 |
| --- | --- |
| Agent status | Agent 的汇总状态：运行中、待机中、出错；出错时附带对应 agent-run 的具体错误。 |
| Agent 的活动 runs | 按 Chat 展示正在运行的具体 agent-runs；该 Agent 在某个 Chat 没有活动 run 时，不显示该 Chat 的运行条目。 |
| Agent 分身 | profile × Chat 的身份、所在 Chat，以及该分身持有的 Machine 租约。 |
| Machine | 当前 Project 的 Machine 连接状态、空闲或分身持有状态及持有者；二期另展示挂靠状态和目标。 |
| Chat | 类型、是否归档、成员、owner 或 Task 推进责任方。 |
| Task | proposed、assigned、finished、canceled 四态，以及承接它的 Chat。 |

- Agent status 与按 Chat 展示的活动 run 列表是两项独立信息；不再将每个分身的三态列表作为这两项信息的替代。
- 有活动 agent-run 时，Agent status 显示运行中；新 run 启动即按此规则显示，不设置 turn 数门槛。上一轮错误保留在对应 run 的记录中，不阻止显示当前运行状态。
- 所有相关 agent-runs 都已结束，且最后一个 agent-run 报错时，Agent status 显示出错，并展示该 run 的具体错误。都已结束且不满足此出错条件时，显示待机中。
- 查询、刷新或发送尚未启动 run 的消息不改变运行事实，也不自行清除出错状态。
- 不将最近一轮 run 的结果作为独立的基本信息展示项；只按上述规则取出当前出错状态对应的具体错误。
- status 仅汇总当前 Project 内该 Agent 的 runs，活动 run 列表同样限于当前 Project。其他 Project 的 runs 不影响本项目 status，不向该 Agent 展示。
- Machine 连接与项目内租约状态分别表达。例如 Machine 离线时仍可能被本项目租约占用；无法确认的事实明确表示未知，不能误显示为空闲或成功。
- 同一物理 Machine 可加入多个 Projects，各项目租约独立。其他 Project 的租约不影响本项目空闲/占用显示，变化也不向本项目 Agents 发出通知。

### “在做什么”的深度

- 第一版分别提供 Agent status、各 Chat 中具体运行的 agent-runs，以及明确记录的 Task 和 Machine 租约关联。
- 不生成“正在排查什么、已经发现什么、下一步准备做什么”等工作内容摘要。
- 工作关联以源对象已有的明确记录为依据。Task 分配给对话不等于其中每个分身都在执行该 Task，不以运行状态推导 Task 状态。

### 可见范围与权限

- 同一 Project 内的基本信息对 Human 和 Agents 全部可见，不要求 Agent 参与对应对话才能查询这些基本信息。
- 这一决定覆盖其他对话中的成员活动、Task 状态及 Machine 与租约关联。
- 基本信息的可见性不授予源对象的操作权，也不自动开放聊天正文。
- Project 是 Sprout 管理的 Agent 信息和上下文的硬边界。查询、自动快照、变更提示、错误与租约协调均限于当前 Project，不通过 Sprout 暴露其他 Projects 的活动。
- Machine 需加入当前 Project 才可被该项目 Agents 查询和申请；不能查询其他 Projects 的 Machine 成员集合、持有者、挂靠记录或协调请求。
- 硬隔离限定在 Sprout 层，不通过 Info Hub 提供跨 Project 占用信息或仲裁。共享 Machine 内部的文件、进程可见性与系统资源竞争由 Project organization 负责，Sprout 不提供操作系统层面的项目隔离。

### Agent 获取方式

- 采用必要上下文自动提供与按需主动查询相结合的方式。
- 每轮 run 开始时自动提供以下基本信息；具体字段与体积控制留待实现设计：
  - 当前 Project、Chat 的名称与类型，以及自己的分身身份。
  - 当前 Chat 的成员、各成员 Agent 的 status（出错时含具体错误）、该对话中的活动 agent-run 信息，以及 owner 或 Task 推进责任方。
  - 当前 Chat 承接的 Tasks 及其基本状态。
  - 本分身已持有的 Machine 租约；二期为 Group / Public Channel 额外提供挂靠到该对话的租约。
- 同一分身可以跨 run 保留租约；每轮开始从源记录提供实际持有状态，二期另提供挂靠状态，不依赖模型记忆。
- Info Hub 可以按需查询分身实际持有的租约，不由自动上下文的展示范围推断持有关系。
- 完整的 Project 基本信息可以按需查询，包括本项目其他 Chat 的活动、其他 Agents 的状态和本项目完整 Machine 列表。
- 本轮不继承旧 #266 的“仅查询内容、唤醒只携带条目数量指针”限制。

### 信息更新与变更提示

- Human 界面自动刷新，展示最新基本信息；刷新所用事件和传输机制留待实现设计。
- Agent 每轮 run 开始时获取当时的基本信息快照。
- Agent 运行期间，相关基本信息变化时插入简短通知，例如：“当前 Chat 的 Task 信息出现了变化；如果你对此信息感兴趣，请主动获取，否则忽略它。”
- 通知指出变化的信息范围或类型，并提示主动查询；不自动插入完整变更记录，不要求 Agent 回复或查询。收到通知后查询得到的源记录才表示查询时的状态。
- 普通基本信息变化不单独唤醒空闲分身；下一轮自动快照提供当前状态。
- 需要采取行动的事件沿用明确的通知或唤醒规则，例如 Task 的“立即开始”、小脑判定需要接续的负责人唤醒、二期租约归还或交接请求，以及 Machine 移出 Project 后对受影响的活动 runs 发送的明确资源撤销通知；人类的暂停控制仍有效。
- 普通变更提示默认覆盖当前 Chat，以及该分身自己持有或正在申请的 Machine／租约。
- Project 其他 Chat、Agents 和 Machines 的基本信息仍可主动查询；不因 Project 内全部基本信息可见而向每个运行中的分身推送全部变化。
- 合并重复提示、控制通知频率等属于实现设计，需保持“Agent 可选择主动获取或忽略”的行为。

### 与其他生命周期的边界

- Info Hub 展示已有事实，不因聚合展示而驱动 Task 完成、分身停止或租约释放。
- 租约操作使用分身身份授权；同一分身可经历多轮 run。
- 同一分身允许跨 run 保留租约。结束前软性要求判断保留、直接交接或释放；二期增加挂靠选项。不因正常 run 结束自动释放。
- 一期机器占用由 owner、持有者或 Human 通过对话协调；二期租约与沟通机制再提供申请遇阻自动协调。Info Hub 届时展示请求、结果及保留原因，不自行唤醒或改变租约。
- 一期直接交接原子变更持有者并保持占用；二期挂靠保留占用但交出原持有者操作权，领取成功后才获得操作权。

