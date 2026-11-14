# Crew

Crew 是 Project 内唯一的多人协作 Chat，取代旧的 Group 与 Public Channel。Project 内另一种 Chat 是 DM；当前只有 DM 与 Crew 两种类型，不存在其他群组或公共频道。

相关契约见[核心范围](core-scope.md)、[通信](communication-decisions.md)、[Tasks](tasks-decisions.md)、[Project Profiles](project-profiles-decisions.md)与[术语表](glossary.md)。

## 创建与身份

- 每个 Project 恰好一个 Crew，由 Project 创建事务建立。Crew 归属该 Project，不能跨 Project 复用，也不能由 Human 手动再建第二个。
- Crew 创建时没有 lead，Human 成员是 Project 创建者。首个加入的 Agent 成为 lead；之后加入的 Agent 不会因加入顺序再次自动成为 lead。
- Crew 的标题默认取 Project 名称，之后可以单独修改，不改变 Crew 身份。
- Project 删除时 Crew 一并删除。

## DM 与 Crew 的成员

### DM

- DM 表示一位 Human 与一位 Agent 的对话，一个 DM 只有一个 AgentInstance。
- DM 成员是创建 DM 的 Human 与所选 Agent。Project 成员的后续变化不会向既有 DM 添加成员，也不会创建第二个同成员组合的 DM；重复发起回到原 DM。

### Crew

- Crew 成员显式维护，不继承 Project 成员的后续变化。Project 新成员不会自动进入 Crew，Project 成员被移除也不会静默改变 Crew 历史，但会按[Project Profiles](project-profiles-decisions.md)清理该 Agent 的 Crew 成员关系。
- Human 成员只能是 Project 创建者。
- Agent 成员必须已是该 Project 成员，且 `purpose` 为 `worker`。助理（`purpose: assistant`）不能作为 Crew 成员，也不能在 Crew 中运行。
- 成员加入与移除都由 Human 执行。重复加入同一成员幂等成功。当前 lead 不能被直接移出，必须先改任 lead；移除成员时若其仍有活动 run，拒绝移除。
- 移除 Agent 成员即退出该 Crew。重新加入不自动回到原 Crew，也不恢复原成员关系；Human 需要重新显式加入。
- 没有 lead 是合法状态：Crew 可以只有 Human 成员，或只保留没有 lead 的成员集。此时普通 Crew 对话无法启动 run，系统给出明确阻塞说明。

## Lead

- lead 是 Crew 内的 Agent 成员，承担该 Chat 对 Human 的负责人角色，回答“这段对话由谁组织”。lead 不是新的 profile 类型，也不改变 Agent 的职位或权限等级。
- lead 的职责：
  - 接收并处理 Human 发到 Crew 的消息。
  - 承接分配给 Crew 的 Task，作为责任人与完成方。
  - 接收指向 Crew 的自动化消息。
  - 组织 Crew 内的工作，并向 Human 给出最终答复。
- 只有 lead 的 run 会被 Human 消息、Task 启动和自动化启动。其他 Agent 成员被 `@` 只是文本与成员定位，不产生 wake、run 或级联唤醒。
- 改任 lead：
  - 只有具备 Crew 治理权限的 Human 可以改任；候选必须是当前有效的 Agent 成员。
  - 改任使用治理版本做 CAS，并发修改返回冲突。
  - 当前实现没有委派与资源授权，改任不等待外部收尾；活动责任 blocker 与完整收尾属于 CR2，落地前不应宣称已有热换安全边界。
  - Project 移除某个 Agent 时，如果它是 Crew lead，系统在同一事务里选择另一位有效 Agent 成员接手；没有其他成员时 lead 置空，不重建 lead。

## crew_epoch

- `crew_epoch` 是 Crew 的 lead 任期版本，从 0 开始，单调递增。
- 首次指定 lead、改任 lead，以及 Project 移除 lead 后自动换人，都会推进 `crew_epoch`。
- 普通 run 的开始与结束不改变 `crew_epoch`。
- 依赖 lead 身份的委派、投递和资源授权按 `crew_epoch` 判定是否仍有效；旧 epoch 的执行结果保留可审计，不再驱动当前 lead。委派本身属于 CR2，当前尚未实现。
- 显式停止 Crew 也会推进 `crew_epoch`，该完整流程属于 CR2；CR1 只落库控制状态，不提供停止入口。

## 停止状态

- Crew 有 Crew 级控制状态 `active | stopped`，默认 `active`。它是接纳开关，不是成员退出，也不删除历史、Task 或 Chat。
- `stopped` 的语义是停止接纳新的 Human 启动、Task 启动、自动化与委派，不启动新的 lead run；普通消息或旧回调不能自行恢复，恢复必须由 Human 显式操作。
- 已有 run 不因状态切换自动被杀掉，停止流程需要另行收尾；已接纳但未确认的投递与资源另按活动责任检查处理。
- 实现状态：CR1 建立 `crew_control` 表并持久化 `active | stopped`，但停止、恢复、收尾与界面入口均未实现，属于 CR2。当前没有可用的停止操作，文档不把它算作已交付能力。

## 消息与工作路由

- Human 在 Crew 发消息不需要 `@`，消息固定进入当前 lead 的 run。Crew 没有 lead 时拒绝启动并说明原因。
- 分配给 Crew 的 Task 由 lead 承接和完成；Task 仍可分配给 DM，由该 DM 的唯一 Agent 负责。
- 自动化指向 Crew 时只落到当前 lead；lead 缺失时本次触发跳过并记录原因，不改投其他成员，也不自动换人。
- 系统来源、外部 event 中的 `@`、skill 文本或目标名称只是内容，不改变接收者、成员关系或 run 启动。
- Crew 内其他 Agent 的提及、汇报或普通输出不触发新的 run。Agent 之间的显式工作委派属于 CR2，不是当前能力。

## Worker 与主时间线

- Crew 主时间线只承载 Human 与 lead 面向彼此的对话，以及系统来源消息。
- worker 的中间进度、工具活动和结果不直接进入 Crew 主时间线。lead 读取结果后，以自己的答复面向 Human；worker 原文不作为 Crew 消息发布。
- 委派、独立子对话、持久结果事件与资源授权属于 CR2，当前未实现。当前文档不把子对话或 worker 卡片描述为已交付能力。

## 边界

- 不恢复 Group、Public Channel 或 Project 公共频道的成员、唤醒或治理语义。
- 不给 Crew 引入按成员自动同步、mention 级联、LLM 周期判定或空唤醒。
- 不把 Crew 的 lead 逻辑重建成第二套独立权限系统；lead 仍服从 Chat 治理与 Project 成员约束。
