# 沟通渠道：核心范围与决策记录

状态：讨论中。本文记录已确认的产品决定，不代表实现已经完成。分期以 core-scope.md 为准：一期为当前范围，二期明确要做，未来方向时间未定。

## 已确认的核心

### Project 范围

- Conversation（对话）统一表示 DM、Group 和 Public Channel，是 Project 内持久的沟通与协作单元；聊天窗口是其界面呈现。
- 每个 Project 拥有各自独立的 DM、Group 和 Public Channel。
- 不同 Project 的对话、历史、Agent status、运行列表和资源协调信息在 Sprout 层硬隔离，Sprout 不向 Agent 提供其他 Projects 的活动；Machine 内部的文件、进程及共享资源由 Project organization 负责。
- Project 维护自己的 Agent 成员集合，支持添加和移除 Agent；这修正了此前“不设项目级 Agent 成员名单”的决定。
- Public Channel 的 Agent 成员集合始终等于当前 Project 的 Agent 成员集合。Project 添加 Agent A，频道就加入 A；Project 移除 A，频道也移除 A。不能在频道内单独调整成员。
- Public Channel 的唤醒候选来自当前 Project 的 Agent 成员；首次被唤醒时建立对应频道中的分身。成员身份不要求预先启动分身。
- Public Channel 除成员来源与同步方式外，其余规则与 Group 相同，包括 owner 管理、Task 承接和推进、一期直接租约交接、二期租约挂靠及上下文唤醒。
- DM 只有一位 Agent，可以承接 Task；由该 DM 的唯一 Agent 分身负责推进，选择“立即开始”时唤醒它。一期不提供挂靠；二期挂靠也不面向 DM，机器信息展示该分身实际持有的 Machines 和租约状态。
- 分身由 Agent profile × Conversation 唯一确定。
- 同一 Project 内，各 Conversation 的成员活动、Task 和租约等基本信息由 Info Hub 聚合，对 Human 和 Agents 全部可见；这一决定不自动开放其他对话的聊天正文。

### 一期：Project 成员移除与对话状态

- Agent 有活动 runs、持有租约、承担 owner 职责或其 DM 仍有 assigned Tasks 时阻止移除；Human 先手动停止、释放或交接、变更 owner、重新分配任务，再移除。
- 正常移除后，Public Channel 和普通 Group 移除该 Agent，其 DM 归档、不可继续聊天。旧 run、待处理唤醒和新消息不能恢复被撤销的参与权；历史、施工记录及已结束 Tasks 保留，其他 Projects 不受影响。
- 同一 Agent 重新加入 Project 时，自动加入 Public Channel、恢复既有 DM；不自动加回原普通 Group。

### 二期：强制移除与自动善后

- Human 确认强制移除后，中止该 Agent 在本项目的所有活动 runs、剥夺参与和操作权，不要求先逐项清理。
- 原为 Group / Public Channel owner 时默认由 Human 接任，Tasks 留在原对话；其 DM 未完成 Tasks 退回 proposed，清除当前分配，历史与已有结果保留。
- 确认旧操作权撤销后自动释放租约；无法确认时保留待处理占用。文件和进程不自动清理。

### Group 管理

- 每个 Group 有一个当前 owner，可以是人类或 Agent。
- 第一版只有人类可以调整普通 Group 成员、变更 owner 或解散 Group。Public Channel 同样由人类指定和变更 owner，但成员只能跟随 Project，不能在频道内单独调整。
- Agent owner 可以组织工作、管理任务和协作说明，不能自行执行上述 Group 管理变更。

### Group 内的分工与回报

- 第一版由 owner 直接通过群聊交代工作，成员在同一 Conversation 中回报进度、结果或阻碍，owner 汇总并安排后续工作。Public Channel 沿用同一规则。
- 分工细节保留在对话和 Task checklist 中，不增加独立的委派单对象或固定开发流转阶段。
- 分工与回报消息进入现有上下文唤醒判定，由所选小脑/JEV 判定器接续相关成员；有 assigned Task 时另按周期检查规则防止工作静默遗失。

### 未来方向：Group 管理申请

保留建设意图，实施时间未定，不承诺一期或二期：

- Agent owner 可以申请调整普通 Group 成员、变更 owner 或解散 Group；Public Channel 不提供独立的成员调整路径。
- 人类在该 Agent 的聊天窗口点击“允许”后，执行对应申请。
- 这提供申请与人类批准的路径，不授予 Agent 自行执行这些变更的权限。
- 申请呈现、有效期及状态变化时的校验细节留待后续设计。

### 自动接续与人类控制

- Agents 之间连续自动接续不设固定轮数上限。
- 普通聊天的自动接续由所选判定器决定是否还需要唤醒；无人需要回应时自然结束。明确的 Task 行动事件按其规则投递。
- Conversation 中只要有 assigned Task，系统就定期唤醒小脑，依据 Task、对话上下文和当前运行情况判断是否需要唤醒负责人继续推进；没有 assigned Task 时停止该对话的 Task 周期检查。不以所有 Agents 停止执行为前提，也不在每次检查时直接唤醒负责人。Task 保留四态，不增加执行状态或强制结构化接续记录。需要接续时，Group / Public Channel 找当前 owner，DM 找唯一 Agent 分身，Human owner 则收到提醒。人类暂停和停止控制仍然有效；检查周期及与普通聊天判定器的关系留待设计，具体规则见 tasks-decisions.md。
- 人类可以随时暂停自动唤醒或停止分身运行；Task 自动接续不得立即抵消人类的停止操作。

### 忙碌分身与新消息

- 分身正在工作时，后续需要它处理的消息优先送入当前一轮，让它尽快看到并调整工作。
- 当前一轮结束前仍未处理的消息进入下一轮。
- 同一分身保持串行执行，不为后续消息另外启动并行运行。

### Info Hub 变更提示

- Agent 每轮 run 开始时由 Info Hub 提供基本信息快照；运行中出现相关信息变化时，插入简短通知，标明变化的范围或类型，并提示“感兴趣请主动获取，否则忽略”。
- 提示不自动附带完整变更记录，不强制回复或查询，不为普通状态变化单独唤醒空闲分身。
- 需要行动的事件按明确规则通知或唤醒，例如 Task 的“立即开始”、经上下文判断需要接续的任务负责人唤醒，以及二期的系统租约协调请求；Machine 移出 Project 后，受影响的活动 runs 收到明确的资源撤销通知，自行决定换 Machine、继续其他工作或结束，不一律强制中止。人类暂停控制仍然有效。
- 普通变更提示默认覆盖当前 Conversation，以及该分身自己持有或正在申请的 Machine／租约；Project 其他信息仍可主动查询。具体内容与信息来源见 info-hub-decisions.md。

### 二期：系统租约协调请求

一期机器占用由 Agent owner、持有者或 Human 通过对话协调，可直接交接；本节的自动请求与有限尝试流程属于二期。

- 请求、候选 Machine、持有分身和协调结果均限于当前 Project；其他 Projects 在同一物理 Machine 上持有独立租约，不触发本项目协调。
- Machine 申请遇阻时，系统可以将明确的归还或交接请求送达当前持有分身；不依赖小脑/JEV 的上下文判定。
- 空闲持有者被唤醒，忙碌持有者在当前轮接收请求，同一分身仍保持串行。
- 每次申请只自动协调一轮，同一租约的重复请求合并，尝试次数有限，不广播或持续催促。
- 协调不要求先获得空闲 Machine；原有成员、领取范围、租约授权及人类控制边界仍适用。
- 持有者释放、挂靠交接或说明保留原因；无法响应或状态不确定时再交给 Human。完整规则见 machines-decisions.md。

### 上下文唤醒判定

- Group 和 Public Channel 需要根据上下文判断是否唤醒以及唤醒哪些 Agents，不限定为仅明确点名才能启动。
- 原定的小脑使用特别便宜的模型执行唤醒判定；小脑不是固定负责回答所有未点名消息的 Agent。
- JEV 已确认为 TypeSafe 的 Jev（https://docs.typesafe.ai/introduction），作为成本较低的结构化上下文判定路径。
- 小脑与 JEV 是可选的两种实现，每个 Project 选择其中一种；一次判定只走所选路径，不默认级联调用。
- Agent 在 Group / Public Channel 中的普通回复也进入唤醒判定，判定器可以据此唤醒其他 Agents，接续协作；不要求每次都明确 @ 对方。
- 一次判定可以选择并唤醒多名 Agents；被选中的分身独立运行和回复，需要 Machine 时分别申请租约。
- 已核对 Jev 官方文档：支持共享 state 下多个独立问题的批量求值，可用候选分身各自的 Noul 问题实现多 Agent 判定。接口、成本与验证建议见 jev-wake-routing.md；实际判定效果尚未验证。

