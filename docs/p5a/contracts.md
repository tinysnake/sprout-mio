# P5a 数据形状：多人对话、成员真值与唤醒路由

本章把 Chat 从「单分身 DM」扩成三种对话。迁移 `drizzle/0021_p5a_multichat_schema.sql` 到 `drizzle/0024_p5a_agent_run_message_chat_fk.sql`，其中 `0023` 只删一条早期触发器，`0024` 重建 `agent_run` 以加复合外键。既有 DM 行不改写，靠默认值与回填保持可读。

## 对话：`chat`

| 列                                                 | 含义                                             |
| -------------------------------------------------- | ------------------------------------------------ |
| `kind`                                             | `dm`、`group`、`public_channel`                  |
| `owner_kind`、`owner_id`                           | 当前所有者，可以是 Human 或 Agent                |
| `wake_policy`                                      | `mention_only`、`owner_led`、`contextual`        |
| `governance_revision`                              | 治理写入的乐观并发水位，每次成员或所有者变更加一 |
| `title`、`archived_at`、`created_by`、`created_at` | 命名、归档与来源                                 |

约束表达四件事：`kind` 只有三个值；DM 的所有者恒为创建它的人；`public_channel` 不可归档；同一 Project 最多一个 `public_channel`（部分唯一索引 `chat_public_channel_project_unique`）。`chat_id_project_unique` 让 `agent_run` 能以 `(chat_id, ...)` 复合外键校验归属。

`wake_policy` 是对话的公共列而不是按 kind 的隐含行为：P5a 里 `contextual` 的即时扇出与 `owner_led` 同义；消息自动续接接入后，`contextual` 的判定器使用全部有效 Agent 候选，owner 仍是不选人时的回退。

## 消息：`message` 与 `message_mention`

`message` 只存正文（`body`）与发送者，不存渲染后的富文本。点名是另一张表 `message_mention` 的记录：`member_kind`、`member_id`、`start`、`end`，位置指向 `body` 里那段 `@名字`。

读模型把两者合成 `mentions` 一起返回（`Message` 带 `mentions`）。这样分工的原因是正文同时是 Agent 输入与 LLM 判定看到的原文：把 id 写进正文，隐藏的 id 就会被模型读到；在渲染层藏 id，正文就与服务端看到的不一致。id 留在记录里，正文是用户写下的那句话。

消息不可编辑，所以位置在写入时定一次就永久有效，读取侧不需要重新解析正文。`(chat_id, message_id, start)` 唯一，删消息级联删记录。

点名能成立的前提是名字在同一条对话里没有歧义，所以 `agent_profile.name` 在 `created_by` 内唯一（`agent_profile_owner_name_unique`）：同一个用户不能创建两个同名 Agent。

## 成员：`chat_effective_member` 视图

成员只有一个真值来源，是一张视图而不是第二张表：

| `source`         | 何时出现                                                        |
| ---------------- | --------------------------------------------------------------- |
| `chat_member`    | DM 与 Group 的显式成员行；Group 的 Agent 行仅在仍属本项目时可见 |
| `project_member` | Public Channel 的 Agent 成员，随 Project 成员当场派生           |
| `project_owner`  | Public Channel 的 Human 成员，取 `project.created_by`           |

频道不物化成员，所以「Public Channel 成员随 Project 自动同步」是读时事实，不需要级联维护，也不会漂移。独立增删频道成员一律 `channel_membership_managed`。

Group 的写路径仍然写 `chat_member`；`chat_member` 上有两条触发器，禁止写频道行（`chat_member_no_channel_insert`），并禁止改写成员身份（`chat_member_identity_immutable`）。早期一条误挡删除的触发器由 `0023` 删除，删除路径因此可以清理 Group 成员行。

## 输入：`agent_run_input`

主键是 `(run_id, message_id)`，因此一条 Human 消息可以同时挂到多条 run 上，实现一次发言扇出给多个分身；`run_id` 作为最左列继续服务按 run 读取。

| 列                              | 含义                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| `disposition`                   | `pending`、`delivered`、`cancelled`                                   |
| `delivered_at`                  | 被 run 取走时写入                                                     |
| `cancelled_at`、`cancel_reason` | 取消时点与原因：`membership_revoked`、`human_stop`、`group_dissolved` |

一条 CHECK 把三种状态各自的列约束固定下来：`pending` 三列皆空，`delivered` 只有 `delivered_at`，`cancelled` 只有后两列。run 正常完成时，仍留在 `pending` 的输入交给同 instance 的下一轮（`carryPendingInputsToNextRound`）——交接发生在终态落库之后，所以「下一轮」不会又挂回自己；异常终态（失败、中断、停止）不自动重投，`pending` 保持原样等 P6 的恢复策略。

## 回复归属：`agent_run`

`agent_run` 增加 `(assistant_message_id, chat_id)` 复合外键，指向 `message` 的 `(id, chat_id)` 唯一索引。回复消息必须与它所属的 run 在同一个对话里，跨对话绑定由数据库直接拒掉，不靠领域代码记得检查。

`agent_run_one_active_instance` 仍是「同一分身同时最多一条排队或运行中的 run」的唯一保障，因此多 Agent 协作不会让同一分身并行。

## 身份：`ChatActor` 与能力表

`ChatActor` 显式区分两种身份，不再从 `ctx.userId` 反推：

| 身份    | 携带                                                      |
| ------- | --------------------------------------------------------- |
| `human` | `userId`、`ProjectContext`                                |
| `agent` | `agentProfileId`、`instanceId`、`runId`、`ProjectContext` |

`CHAT_CAPABILITIES` 是静态封闭表，八项动作逐一列出 Human 与 Agent 的门槛（`never`、`member`、`owner`）：

| 动作                                                   | Human  | Agent  |
| ------------------------------------------------------ | ------ | ------ |
| `group_create`                                         | member | never  |
| `member_add`、`member_remove`                          | member | never  |
| `group_dissolve`、`owner_change`、`wake_policy_change` | owner  | never  |
| `title_change`                                         | member | never  |
| `message_send`                                         | member | member |

Agent 在所有治理动作上都是 `never`，因此「分身不能治理对话」是查表结果，不是散落在各入口的条件判断。`title_change` 的 Human 档是 `member`：标题写入没有 `expectedRevision`，收成 `owner` 会改变既有 Human 行为。成员增删同样是 `member` 档（裁定 d42）：群是人协作的地方，非 owner 的 Human 成员照常能加人、移人；`member` 档只回答「是不是人」，「是不是这条对话的有效成员」由调用点读 `chat_effective_member` 补判（裁定 d7），所以被移出群的 Human 再调增删会得到 `not_found`。

页面读的是同一份判定的结果：`chatOwnerFactsSchema`（`src/contracts/chat.ts`）把 `canChangeMembers`、`canChangeOwner`、`canChangeWakePolicy`、`canRenameTitle` 与 `readOnlyReason` 一起交给浏览器，三个会话变体各带一个 `governance` 字段。领域层在 `chatGovernanceFacts`（`src/domain/chat-capabilities.ts`）里用本表与裁定 d6 的 owner 兜底一次算完后，页面不再抄能力表、也不再自己比 owner。

## 唤醒：`routeWakeCandidates`

纯函数，只吃调用点已读出的事实，不查库：

1. 点名：`mentions` 里指向当前 Agent 成员的记录，按成员顺序返回；
2. 所有者优先：无人被点名且策略为 `owner_led` 时，Agent 所有者进入候选；`contextual` 在判定器接管前仍把 Agent owner 作为回退，接管后由消息判定器用全成员候选；
3. 其余退避为空集。

路由读 `message_mention` 的记录而不是正文，所以「谁被点名」是写入时的一次判定，不在每次扇出时重新猜。点名在写消息时按这条对话当前有效成员的展示名解析（`src/domain/message-mention.ts`），正文里写的就是 `@名字`，id 不进正文，也不靠渲染层隐藏。

两条规则都排除发消息的分身自己，并且只接受 `chat_effective_member` 给出的当前成员，所以移出 Project 的分身留在历史里但不会再被唤醒。

点名的强度分层：显式点名走规则分支直接派发，判定器无权否决；正文里出现名字但不构成点名时只作 `explicit=false` 的弱证据交给判定器，它可以说否。弱证据只看字面出现，不做词边界判断——多报一次只是让判定器多看一眼。

## 错误码

| 码                           | 何时                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `channel_membership_managed` | 对 Public Channel 独立增删成员                            |
| `not_found`                  | 调用者看不到该对话，或跨 Project、跨身份范围的读取        |
| `forbidden`                  | 身份看得见但无权执行该治理动作，或对已结束的 run 下发指令 |
| `conflict`                   | `governance_revision` 不匹配，成员或所有者已被别人改过    |
