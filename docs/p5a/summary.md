# P5a 章节结论：多分身对话（Group 与公共频道）

P5a 把对话从「一个 Human 对一个分身」扩展成三种形态：群组可以有多个 Human 与多个分身、每个 Project 有一条公共频道、单聊保持 P4b 的形状。对话不再是单行配置，而是一个有成员、有所有者、有唤醒策略、有治理版本的实体；谁能读到、谁能发言、谁被唤醒、谁能治理，全部由一张封闭的能力表加一条当前成员事实决定。

## 交付范围

- 契约与数据形状：`docs/p5a/contracts.md`，迁移 `drizzle/0021`–`0024`。
- 领域：`src/domain/chat.ts`（群创建、成员增删、标题、解散）、`src/domain/chat-actors.ts` 与 `src/domain/chat-capabilities.ts`（能力表与治理事实的唯一判定）、`src/domain/chat-wake.ts`（唤醒路由）、`src/domain/chat-session.ts`（三种会话变体）、`src/domain/agent-run.ts`（多分身扇出与输入归属）。
- 契约：`src/contracts/chat.ts`、`src/contracts/chat-capabilities.ts`、`src/contracts/info-hub.ts`。
- 页面：`src/components/chat/**`（消息区、右栏详情、成员管理与治理段）、`src/routes/_authed/projects.$projectId.chats*`。
- 门禁：`i2-group-chat`、`i3-public-channel`、`i4-agent-fanout`、`i5-project-removal`、`i6-chat-info`、`i7-chat-scope`、`az-p5a-live-worker`（真实 Worker）、`aq-p5a-pages`（真实 Chromium）。

## 数据形状

| 形状         | 建模                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------- |
| 对话         | `chat.kind` 为 `dm`、`group`、`public_channel`；公共频道每个 Project 至多一条                        |
| 成员         | `chat_member` 记成员行，`chat_effective_member` 视图只给出当下有效的成员                              |
| 行动者       | `ChatActor` 分 Human 与 Agent 两支，Agent 必须带 `instanceId` 与 `runId`，权限不看宿主传的 `userId` |
| 治理         | 能力表 `CHAT_CAPABILITIES` 是唯一来源；`chatGovernanceFacts` 一次算好，页面只读                      |
| 动作与事实   | `factsAllow` 是「动作 → `can*`」的唯一映射，领域断言与页面入口都从这里取                              |
| 唤醒         | `chat.wakePolicy` 为 `mention_only`、`owner_led`、`contextual`；路由优先级点名 → owner_led → 空集      |
| 输入归属     | `agent_run_input` 以 `(runId, inputId)` 联合主键归属到具体分身的 run                                 |
| Info Hub 聚合 | `ProjectInfoHub.chats` 一次给出每个会话的去重 Agent 数、分状态 run 计数与活跃 run id                  |

## 1. 群里的人与分身共同参与，单聊行为保持不变

群组的成员表、消息归属与右栏详情都按多个参与者建模；单聊仍走 P4b 的两栏形状，右栏不渲染成员治理段。

## 2. 公共频道在一个 Project 内唯一，成员资格来自 Project 成员

公共频道不发成员行，参与权由 Project 成员派生，因此加入或退出 Project 直接改变频道参与权，不需要额外的入群动作。

## 3. 多分身扇出与输入归属

一条 Human 消息可以唤醒多个分身，每个分身各有自己的 run 与输入队列；晚到的输入落到对应分身的下一轮，而不是被合并到别人的 run 里。
