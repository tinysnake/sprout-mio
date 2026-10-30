# P5b 数据形状：Task 四态、记录与开始投递

本章新增 Project 所有、Chat 承接的 Task，冻结契约见 `src/contracts/task.ts`、`src/contracts/task-capabilities.ts`；迁移为 `drizzle/0025_p5b_tasks.sql`，表定义为 `src/db/schema.ts`。本章同时收紧既有 Chat/run 的输入投递，并为当前 Group owner Agent 的显式点名开放一条例外；自动接续留给 P6。

## Task：`task`

| 列                                                               | 含义                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| `project_id`、`chat_id`                                          | 所属 Project 与当前承接 Chat；未分配时后者为空           |
| `status`                                                         | 只有 `proposed`、`assigned`、`finished`、`canceled`      |
| `title`、`description`、`constraints`、`completion_requirements` | 目标、说明、约束、完成要求；没有独立结果字段             |
| `revision`                                                       | 每次成功命令加一的乐观并发水位                           |
| `assignment_revision`                                            | 分配、改派、撤回、完成、取消、重开时加一，隔离旧开始输入 |
| `created_by`、`created_at`、`updated_at`                         | 来源与时间事实                                           |

`proposed` 必须没有 Chat，`assigned` 与 `finished` 必须有 Chat，`canceled` 可以保留原 Chat，也可以来自未分配任务。没有 begin、running、待验收或已启动标志。Task 与 run、租约之间没有绑定列，三者只能通过 Chat 与时间事实关联；记录的 `task_author_run_id`、事件的 `actor_run_id` 是作者审计身份，不是执行归属。run 结束不完成 Task，Task 完成不停止 run 或释放租约。依据：`src/db/schema.ts`、`drizzle/0025_p5b_tasks.sql`、`src/domain/task.ts`。

## 写入：`mutateTask`

`src/domain/task.ts` 的单一命令入口按 schema → 范围 → 能力 → `expectedRevision` → 迁移与目标 → 有界写入 → 取消旧输入 → 事件 → 详情执行，SQLite `immediate` 事务保证整笔提交或回滚。创建之外的写入必须带当前 revision；页面函数与 Agent gateway 都调用此入口，不自行实现状态变化。依据：`src/server/functions/task.ts`、`src/server/remote-agent-gateway.ts`。

创建得到 proposed；assign 为 proposed → assigned，reassign 保持 assigned 并更换 Chat，unassign 为 assigned → proposed；complete 为 assigned → finished；cancel 只接受 proposed/assigned；reopen 只接受 finished/canceled，回到 assigned，保留原 Chat，无原 Chat 时 Human 必须指定初始 Chat。update/checklist 只接受 proposed/assigned，record_append/start 只接受 assigned；correct 由 Human 在四态纠正元数据或清单，只有 finished 可以追加纠正结果记录。终态不能用普通编辑入口修改。依据：`src/domain/task-capabilities.ts`、`src/contracts/task.ts`。

## 身份：能力表与当前责任

`TASK_CAPABILITIES` 的五档为 `never`（禁止）、`project`（Project 可见）、`member`（当前承接 Chat 有效成员；proposed 按 Project 范围）、`responsible`（当前负责 Agent）、`human`（Human 专属且仍核对写范围）。范围在能力与版本之前核对；Agent 必须有本 Project、本 Chat、本 instance 的活动 run，跨范围统一隐藏为 `not_found`。

| 动作                                                             | Human   | Agent       |
| ---------------------------------------------------------------- | ------- | ----------- |
| create                                                           | project | never       |
| update                                                           | member  | responsible |
| assign、reassign、unassign、start                                | member  | never       |
| checklist_add、checklist_update、checklist_remove、record_append | member  | member      |
| complete、cancel                                                 | member  | responsible |
| correct、reopen                                                  | human   | never       |

责任不是创建者或 DM 的 Human owner：DM 取唯一有效 Agent，Group 取当前 owner，Public Channel 当前只接受 Project 创建者 Human。责任随 Chat 当前成员与治理事实计算，不固化到 Task。`taskCapabilityFacts` 返回 `allowedActions` 与带错误码的 `denials`，页面读同一结果。依据：`src/contracts/task-capabilities.ts`、`src/domain/task-capabilities.ts`、`src/components/tasks/task-forms.tsx`。

## 立即开始：四种情形

| 情形                                   | 持久事实与投递                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| 不勾选立即开始                         | 仅分配，不生成开始记录、run 或 input，不通知负责人                                       |
| DM                                     | 生成 Human 开始记录，投给唯一有效 Agent 的 instance                                      |
| Group owner 为 Agent                   | 仅投给当前 owner，不广播其他成员                                                         |
| Group owner 为 Human 或 Public Channel | 只生成承接 Chat 中的 Human 叙述消息，返回 `human_message`；不创建 Agent run 或独立 inbox |

显式 start 同样走本路径。快照包含 Task id、标题、说明、约束、完成要求和按 position 排列的有效 checklist；超过 8000 字符整笔 `validation_failed`，不截断。Agent 路径返回 `agent_input` 与 run id；同一 instance 已有活动 run 时复用并 steer，否则 queued 后 prompt，继续受单分身串行约束。依据：`src/domain/task-input.ts`、`src/domain/agent-run.ts`。

## 对既有输入与 ACK 语义的收紧

开始记录保存 assignment revision、Chat governance revision 与收件人。候选选择后、真正同步发送前再次从库核对 assigned、Chat/Project/instance、参与权与当前责任；发送尝试在 `immediate` 事务中先写 `agent_run_input.admitted_at`，再同步调用发送函数，异步等待在事务外。依据：`src/domain/task-input.ts`、`src/server/pi-host/run.ts`。

Task 生命周期变化或 Chat owner/成员变化只取消尚未尝试的 pending 开始输入，原因 `task_context_changed`；普通聊天输入不受此专用规则影响。已 admitted 的输入即使 ACK 丢失、同步抛错或随后改派，也不撤回、不盲重发；只有 runner 的投递确认才写 delivered。ACK 不是 Task 完成确认。正常 completed run 只把尚未 admitted 的 pending 输入交给同 instance 下一轮；异常终态不自动重投。依据：`src/domain/agent-run.ts`、`src/domain/task-input.ts`、`src/server/pi-host/run.ts`。

## 对既有 Chat 唤醒的例外：owner Agent 显式 @

当前 Group owner Agent 通过 `sprout_chat_send` 显式 `@名字` 或 `@id` 点名本 Chat 有效 Agent 成员时，可以唤醒对方；发言仍绑定本 run 身份。这是本章为 owner 组织协作新增的例外。它要求发送者就是当前 Group owner、目标有显式 @ 且不是自己；没有 @ 不走 owner_led 兜底，普通 Agent 成员的回报不派发，模型助手最终输出也不走此发送入口，因此不会从成员回复继续级联唤醒。DM 与公共频道不享有该 owner Agent 例外。依据：`src/domain/agent-run.ts`、`src/domain/chat-wake.ts`、`src/server/remote-agent-gateway.ts`；反向验证见 `tests/task-agent-tools.test.ts`。

## 清单与施工记录：`task_checklist_item`、`message`

checklist 用独立表，position 按 Task 内历史最大值递增；删除写 `removed_at`，不重排或复用位置。记录沿用 Chat 的 `message`，按 Task 内单调递增的 `task_record_seq` 排列，只有 start/progress/correction，正文不可改写或删除。可引用当前承接 Chat 中可读消息；历史 Chat 正文不可读时，详情只给 restricted 占位。依据：`src/domain/task.ts`、`src/contracts/task.ts`、`drizzle/0025_p5b_tasks.sql`。

`message` 新增九个可空 Task 归属列：`task_id`、`task_project_id`、`task_record_seq`、`task_record_kind`、`task_reference_message_id`、`task_author_run_id`、`task_assignment_revision`、`task_governance_revision`、`task_start_recipient_id`。普通消息全为空，记录按种类受约束。`sender_kind` 仍只有 `human|agent`，没有 system sender；Human 的开始动作以本人名义作为叙述消息出现。依据：`src/db/schema.ts`、`src/domain/task-input.ts`。

完成需要末条 progress/correction，单独 start 不算结果；可在 complete 同一事务中追加末条进度。完成结果就是记录本身，没有第二份结果表或结果字段。重开保留历史，通过 `completionHistory`、`previousCompletionRecord` 引用旧完成事实；finished 的 Human correction 可更新当前完成结果引用，同时保留原完成事件指向的记录。依据：`src/domain/task.ts`、`src/contracts/task.ts`。

Task 改派后，旧 Chat 的 Agent grant 读任务得到 `not_found`；新 Chat 的 Agent 可以读任务，但无权读旧 Chat 正文时只见 restricted 记录；跨 Chat 引用写入得到 `task_reference_forbidden`。这三种主体不混用。依据：`src/domain/task-capabilities.ts`、`src/domain/task.ts`、`tests/task-domain.test.ts`。

## 事件：`task_event`

每个成功命令追加一条不可变事件，`seq` 对齐 Task revision；保存 action、Human/Agent 行动者、可空 actor run、前后状态与 Chat、当时末条 record seq、可空 checklist item。事件不存正文或字段补丁，不是事件溯源或恢复队列；记录正文仍取 message。当前没有 system 行动者，P6 调度器不得伪造 Human context。依据：`src/db/schema.ts`、`src/domain/task.ts`、`drizzle/0025_p5b_tasks.sql`。

## Info Hub：Task 聚合

Project 的 `tasks` 返回 `available:true`、四态 `counts` 与 `items`；Chat 的 `tasks` 返回可用标志与 items；Project 的 Chat 聚合另带 `taskCounts`、`assignedTaskIds`。摘要包括 id、标题、状态、revision、可选 Chat/责任、清单总数与完成数、记录数、末条/上次完成引用与更新时间，不带消息正文。`context` 固定 `relation:"same_chat"`、`taskRunBinding:false`，`activeRunIds` 只表达同 Chat 活动。Human/Agent 的可见范围分别核对，详情再决定正文可读性。依据：`src/contracts/info-hub.ts`、`src/domain/info-hub.ts`、`src/domain/task.ts`。

## Agent 远端工具面

新增 `sprout_task_list/get/update/checklist_add/checklist_update/checklist_remove/record_append/complete/cancel` 与 `sprout_chat_get/send` 共 11 项。Agent 不获得 create、assign、reassign、unassign、start、correct、reopen；gateway 用真实 grant 注入本 run 身份，schema 拒绝调用者伪造 Project/Chat/actor。Chat get 的冻结字段集由同一 response schema 验证；Info Hub 的 `getChatInfo` 新增 `tasks` 键，同步更新 `tests/fixtures/chat-info.ts` 的 i6 冻结断言。现有远端工具登记、runner 冻结清单与 SDK 冒烟清单同步扩展。依据：`src/contracts/task.ts`、`src/contracts/remote.ts`、`src/extension/task-tools.ts`、`src/server/remote-agent-gateway.ts`、`tests/task-agent-tools.test.ts`、`tests/fixtures/remote-tools-runner.mjs`。

## 错误码

| 码                         | 何时与处理                                                                     |
| -------------------------- | ------------------------------------------------------------------------------ |
| `not_found`                | 任务、清单或读取范围不可见；核对 Project/Chat/活动 run 身份                    |
| `forbidden`                | 身份、参与权或责任不足；由当前 Human/负责人操作，公共频道变更 owner 也在此拒绝 |
| `conflict`                 | revision 或开始上下文已变化；刷新后重读事实再决定重试                          |
| `task_invalid_transition`  | 当前状态不接受该动作；proposed 先分配，终态走 Human 纠正或重开                 |
| `task_assignment_invalid`  | 目标归档、参与权/负责人无效，或重开未遵守原 Chat；先恢复目标或合法分配         |
| `task_record_required`     | 没有末条进度/纠正记录；追加实际结果后完成                                      |
| `task_record_immutable`    | 试图改删历史记录；用新记录或 Human correction 留痕                             |
| `task_reference_forbidden` | 引用不属于当前可读承接 Chat；改用本 Chat 可读消息                              |
| `validation_failed`        | 输入不合 schema 或完整开始快照超 8000；缩短后重提                              |

错误边界依据 `src/contracts/result.ts`、`src/domain/task.ts`、`src/domain/task-capabilities.ts`、`src/domain/task-input.ts`；未知数据库错误保留内部失败，不伪装成业务成功。
