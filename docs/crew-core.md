# Crew

Crew 是 Project 内的多人协作 Chat，取代旧的 Group 与 Public Channel。Project 内另一种 Chat 是 DM；委派产生的子对话是第三种内部类型，不对 Human 作为普通聊天开放，也不存在其他群组或公共频道。

相关契约见[核心范围](core-scope.md)、[通信](communication-decisions.md)、[Tasks](tasks-decisions.md)、[Project Profiles](project-profiles-decisions.md)与[术语表](glossary.md)。

## 创建与身份

- 产品语义上每个 Project 只有一个 Crew，由 Project 创建事务建立。Crew 归属该 Project，不能跨 Project 复用，也不能由 Human 手动再建第二个。数据库为兼容历史 Group/Public Channel 的转换不再保留 Project 唯一索引，代码始终复用已有 Crew。
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
  - 改任前必须结束活动 run、释放资源责任并处置未决委派；有活动责任时返回结构化 blocker，不提供边执行边热换。
  - Project 移除某个 Agent 时，如果它是 Crew lead，系统在同一事务里选择另一位有效 Agent 成员接手；没有其他成员时 lead 置空，不重建 lead。

## crew_epoch

- `crew_epoch` 是 Crew 的 lead 任期版本，从 0 开始，单调递增。
- 首次指定 lead、改任 lead，以及 Project 移除 lead 后自动换人，都会推进 `crew_epoch`。
- 普通 run 的开始与结束不改变 `crew_epoch`。
- 委派、投递和资源授权按 `crew_epoch` 判定是否仍有效；旧 epoch 的执行结果保留可审计，不再驱动当前 lead。
- 显式停止 Crew 会取消未结委派；当前实现由 Project 创建者切换 `active | stopped`，没有单独的 stopping 中间态。

## 停止状态

- Crew 有 Crew 级控制状态 `active | stopped`，默认 `active`。它是接纳开关，不是成员退出，也不删除历史、Task 或 Chat。
- `stopped` 的语义是停止接纳新的 Human 启动、Task 启动、自动化与委派，不启动新的 lead run；停止时取消未结委派。普通消息或旧回调不能自行恢复，恢复必须由 Human 显式操作。
- 已有 run 不因状态切换自动被杀掉，停止流程需要另行收尾；已接纳但未确认的投递与资源另按活动责任检查处理。
- 实现状态：`setCrewMode` 由 Project 创建者调用，落库 `crew_control` 并取消未结委派；界面入口仍属于 CR4。

## 消息与工作路由

- Human 在 Crew 发消息不需要 `@`，消息固定进入当前 lead 的 run。Crew 没有 lead 时拒绝启动并说明原因。
- 分配给 Crew 的 Task 由 lead 承接和完成；Task 仍可分配给 DM，由该 DM 的唯一 Agent 负责。
- 自动化指向 Crew 时只落到当前 lead；lead 缺失时本次触发跳过并记录原因，不改投其他成员，也不自动换人。
- 系统来源、外部 event 中的 `@`、skill 文本或目标名称只是内容，不改变接收者、成员关系或 run 启动。
- Crew 内其他 Agent 的提及、汇报或普通输出不触发新的 run。lead 只能通过委派工具把工作交给 Crew 成员。

## Worker 与主时间线

- Crew 主时间线只承载 Human 与 lead 面向彼此的对话，以及系统来源消息。
- worker 的中间进度、工具活动和结果不直接进入 Crew 主时间线。lead 读取结果后，以自己的答复面向 Human；worker 原文不作为 Crew 消息发布。

## 委派

- lead 通过 `sprout_delegation_start` 发起委派，也可以由有权限的 Human 经 server function 发起；worker 必须是本 Crew 的 Agent 成员，不能是 lead 自己。相同 `clientRequestId` 在同一个 Crew 内重放返回原委派，不新建子对话。
- 委派创建 `chat.kind='delegation'` 子对话，`parent_crew_chat_id` 指向 Crew，并固定 dispatch 时的 lead、`crew_epoch`、worker、请求摘要和 worker instance。子对话不进入普通 Chat 列表，也不参与 Crew 唤醒。
- 子对话的可读成员由父 Crew 派生：当前 lead、该委派的 worker、能读父 Crew 的 Human。其他 worker 读不到 sibling 子对话；成员移除后访问立即失效。
- Human 的 Crew 消息仍然只进入 lead。worker 的进度只写子对话；`sprout_delegation_input` 可以由 lead 或 Human 追加到运行中的 worker，不写 Crew 时间线。
- worker 用 `sprout_delegation_complete` 提交摘要与可选 HTML artifact，或用 `sprout_delegation_block` 报告 `needs_input`、`resource_unavailable`、`out_of_scope`、`failed`。摘要上限 8 KiB；报告正文超过 200 字时应使用 artifact。
- 每次结果写入 `delegation_event`（`delegation_id + revision + kind` 唯一），同一事务创建 pending delivery。delivery 快照 lead 与 epoch，投递前重读当前 lead、epoch 与停止状态；不匹配转 attention，不投给旧 lead。
- 投递把结果 prompt 写进子对话，并用 `delegation_prompt_for_chat_id` 指向父 Crew；lead 的 run 通过该别名消费，所以 Crew 主时间线没有 worker 原文或结果摘要消息。lead 空闲时创建下一轮，正在运行时附加到当前 run。
- 同一 lead、同一 epoch 的多个 pending 结果合并为一条 prompt，批量上限 32 KiB，超出的留到下一批。ack 由宿主在 admit 后统一标记；未 ack 的 bound 记录保留诊断。
- `sprout_delegation_cancel` 取消单个委派并中止 worker run；Crew 停止时取消所有未结委派。完成、失败、取消使用终态 CAS，迟到结果不能覆盖新 attempt；失败后重试会创建新的子对话与 attempt。
- scheduler 每轮先 `reconcileDelegations`：worker run 已 failed/interrupted/aborted 但委派仍在 running 时，补发 interrupted 失败事件；随后 `deliverPendingDelegations` 投递。这个兜底不依赖 worker 主动报告。
- 委派不自动承接或完成 Task；Task 责任仍按 Crew lead 与 DM Agent 的现有规则判断。


## 边界

- 不恢复 Group、Public Channel 或 Project 公共频道的成员、唤醒或治理语义。
- 不给 Crew 引入按成员自动同步、mention 级联、LLM 周期判定或空唤醒。
- 不把 Crew 的 lead 逻辑重建成第二套独立权限系统；lead 仍服从 Chat 治理与 Project 成员约束。

## 执行资源

CR3 的 Crew 资源协调器把需求、批准、占槽、授权和排空分开持久化。worker 用 `sprout_resource_request` 提交绑定原 delegation、attempt、run、instance、Machine membership epoch、目录与操作范围的请求；当前 lead 用 `sprout_resource_approve` 或 `sprout_resource_revoke` 决策，原执行 run 用 `sprout_resource_release` 归还。lead 也可为自身当前 run 申请资源。

- 同一 Crew 的 client request id 幂等，异 payload 冲突。批准只进入 FIFO 队列，不代表获配；协调器在 immediate 事务中取得 Project × Machine 唯一槽位，建立 Crew owner、实际执行 holder 的 authorization 与精确绑定原 run 的 grant，再放行 queued run 的 admission。dispatch 可在创建 worker run 的同一事务中登记并批准资源。
- Crew owner 与执行 holder 分开：`machine_lease` 记录 Crew，`lease_authorization` 记录实际执行实例。每次写入与下发还要检查 grant 的 epoch、attempt、run、有效期及请求批准的操作和目录范围。目录校验只约束工具参数，不是文件系统沙箱。DM 保留 instance owner 语义。
- stop、委派终态或成员参与权消失立即冻结新请求与写入并排空；父 lead run 结束不释放 worker 的资源。换 lead 与正常移除成员受未结束的资源责任阻塞。没有 pending mutation 的 held/孤立 Crew 租约先建立 recovery mutation，确认排空后才释放。
- 排空在事务外通过现有 Machine exchange 的持久 fencing 协议推进；已有终态但没有 drain 收据的已下发执行仍占槽。Human force reclaim 独立保留“未确认排空”事实，请求进入 attention 并阻止自动分配给下一位 worker。事件 outbox 绑定原 run，交付确认独立于授权建立。

已有显式 grant 工具继续使用唯一的 `lease_grant` 授权事实，新增 epoch、subject、attempt、expiry 及待完成 mutation 的固定目标 run：

- 授予由持有租约的当前 lead 发起（`sprout_lease_grant`），只接受同一 Crew 的 delegation 子对话里的 worker run；结果写入 `lease_grant`，记录 Crew、授予者实例、被授予实例与 run、代次和请求 id。授权落地后 `lease_authorization.holder_instance_id` 是该 worker 实例；grant 用作授权来源与撤销依据。
- 授予与撤销都走现有 fencing 流程。旧代次的远端执行没有排空时，mutation 保持 `pending`；排空确认后 generation 加一，新授权生效，旧 grant 一并标记撤销。撤销同样先进入 fencing，不能提前宣布 worker 已停。
- 同一 Machine 同时只有一份可写授权。lead 想更换 worker 时先撤销旧授予，再授予新的实例；不允许两个 worker 并行写同一 Machine。
- worker 在委派子对话中调用租约 mutation、挂靠、领取或撤销挂靠都会被拒绝，不能借 escrow 路径绕过。Crew 的租约变更只从 lead 所在 Crew 对话发起。lead 变更后，新 lead 可以撤销原 lead 授予出去的授权。
- worker 离线时撤销保持 `fencing`，不做超时自动释放。只有 Human 可以在租约页强制收回，且结果显式标记为未确认排空；不能把离线当作已排空。
