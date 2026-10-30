# P5a 章节结论：多分身对话（Group 与公共频道）

P5a 把对话从「一个 Human 对一个分身」扩展成三种形态：群组可以有多个 Human 与多个分身、每个 Project 有一条公共频道、单聊保持 P4b 的形状。对话不再是单行配置，而是一个有成员、有所有者、有唤醒策略、有治理版本的实体；谁能读到、谁能发言、谁被唤醒、谁能治理，全部由一张封闭的能力表加一条当前成员事实决定。

## 交付范围

- 契约与数据形状：`docs/p5a/contracts.md`，迁移 `drizzle/0021`–`0024`。
- 领域：`src/domain/chat.ts`（群创建、成员增删、标题、解散）、`src/domain/chat-actors.ts` 与 `src/domain/chat-capabilities.ts`（能力表与治理事实的唯一判定）、`src/domain/chat-wake.ts`（唤醒路由）、`src/domain/chat-session.ts`（三种会话变体）、`src/domain/agent-run.ts`（多分身扇出与输入归属）。
- 契约：`src/contracts/chat.ts`、`src/contracts/chat-capabilities.ts`、`src/contracts/info-hub.ts`。
- 页面：`src/components/chat/**`（消息区、右栏详情、成员管理与治理段）、`src/routes/_authed/projects.$projectId.chats*`。
- 门禁：`i2-group-chat`、`i3-public-channel`、`i4-agent-fanout`、`i5-project-removal`、`i6-chat-info`、`i7-chat-scope`、`az-p5a-live-worker`（真实 Worker）、`aq-p5a-pages`（真实 Chromium）。

## 数据形状

| 形状          | 建模                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| 对话          | `chat.kind` 为 `dm`、`group`、`public_channel`；公共频道每个 Project 至多一条                       |
| 成员          | `chat_member` 记成员行，`chat_effective_member` 视图只给出当下有效的成员                            |
| 行动者        | `ChatActor` 分 Human 与 Agent 两支，Agent 必须带 `instanceId` 与 `runId`，权限不看宿主传的 `userId` |
| 治理          | 能力表 `CHAT_CAPABILITIES` 是唯一来源；`chatGovernanceFacts` 一次算好，页面只读                     |
| 动作与事实    | `factsAllow` 是「动作 → `can*`」的唯一映射，领域断言与页面入口都从这里取                            |
| 唤醒          | `chat.wakePolicy` 为 `mention_only`、`owner_led`、`contextual`；路由优先级点名 → owner_led → 空集   |
| 输入归属      | `agent_run_input` 以 `(runId, inputId)` 联合主键归属到具体分身的 run                                |
| Info Hub 聚合 | `ProjectInfoHub.chats` 一次给出每个会话的去重 Agent 数、分状态 run 计数与活跃 run id                |

## 1. 群里的人与分身共同参与，单聊行为保持不变

群组的成员表、消息归属与右栏详情都按多个参与者建模；单聊仍走 P4b 的两栏形状，右栏不渲染成员治理段。

提交 `6179ec2`。重跑 `bash scripts/verify/i2-group-chat.sh`、`bash scripts/verify/i3-public-channel.sh`、`bash scripts/verify/i-chat.sh`。

## 2. 公共频道在一个 Project 内唯一，成员资格来自 Project 成员

公共频道不发成员行，参与权由 Project 成员派生，因此加入或退出 Project 直接改变频道参与权，不需要额外的入群动作。

提交 `9462cb6`。重跑 `bash scripts/verify/i3-public-channel.sh`、`bash scripts/verify/i5-project-removal.sh`、`bash scripts/verify/i7-chat-scope.sh`。

## 3. 多分身扇出与输入归属

一条 Human 消息可以唤醒多个分身，每个分身各有自己的 run 与输入队列；晚到的输入落到对应分身的下一轮，而不是被合并到别人的 run 里。

提交 `6f66223`。重跑 `bash scripts/verify/i4-agent-fanout.sh`、`bash scripts/verify/i6-chat-info.sh`、`bash scripts/verify/o-turn-semantics.sh`。

## 技术验收证据

`1014e50` 上执行过一次完整 `bash scripts/verify.sh`：61 个 gate、0 失败、386 秒（`Verification scripts=61 failed=0`）。阶段内的单点修复按 `docs/verification.md` 只复跑受影响范围，不重复整段复核。

| 证据                       | 复跑命令                                                                                                                      | 结果                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 全量门禁                   | `bash scripts/verify.sh`                                                                                                      | 61 gate 0 失败（`1014e50`）                                                                      |
| 常规验收不产生付费模型调用 | `bash scripts/verify.sh --only az-p5a-live-worker`                                                                            | 两个场景 `mode=model-fixture`、`paidModelCalls=0`，仍是真实 Chat、Pi SDK、Worker 与 remote shell |
| 领域契约与治理             | `bash scripts/verify.sh --only i2-group-chat,i3-public-channel,i4-agent-fanout,i5-project-removal,i6-chat-info,i7-chat-scope` | 0 失败                                                                                           |
| 真实页面                   | `bash scripts/verify.sh --only aq-p5a-pages,as-p5a-pages`                                                                     | 0 失败，四种会话两档宽度截图                                                                     |
| 真实 Worker 全链           | `bash scripts/verify.sh --only az-p5a-live-worker`                                                                            | group fanout 与 channel mention 通过                                                             |
| 独立验收                   | `orchestrate/sprout-mio-p5a/reports/acceptance-r11.md`                                                                        | PASS，无阻断项                                                                                   |

交付提交 `2fd0ee9`（run 汇总行排序与着色，Human 最终反馈）、`1ecd7e7` 与 `b1a27a6`（交付验证暴露的两处测试脆弱点：期限窗口小于 runner 启动、移除断言只等对话框关闭）之后，在 `f47b575` 上执行 `pnpm verify:local`：19 个 macOS 与真实 Pi 门禁、0 失败（`Verification scripts=19 failed=0`）。其余 42 个门禁由 CI 的 Linux 分组覆盖，因此本机不再重复整段 61 项。交付期间四次 `bash scripts/verify.sh` 失败均为满载假红：那次机器 load average 在 11 到 160 之间（我留下的 24 个 `yes` 进程、Spotlight 索引、两个常驻 agent 会话），失败脚本每次不同且单独跑全部通过。这条环境约束已写进 `docs/verification.md`。

模型选择只经 `scripts/verify/lib/live-model.sh` 进入：`live` 模式必须由人类命名模型（`SPROUT_VERIFY_PI_MODEL` 或仓库 `.env`），缺失时在准备产物前退出，脚本里没有内置默认提供商。

重跑 `bash scripts/verify/b-tooling.sh`、`bash scripts/verify/az-p5a-live-worker.sh`、`bash scripts/verify/as-p5a-chat-ui.sh`。

## 功能交付证据

范围、版本与已知限制见「交付范围」与「数据形状」。功能线以领域与 HTTP 门禁取证，覆盖 Group 创建与治理、公共频道成员随 Project 同步、扇出与输入归属；页面证据单独列在下一节。

提交 `6179ec2`。重跑 `bash scripts/verify/i2-group-chat.sh`、`bash scripts/verify/i3-public-channel.sh`、`bash scripts/verify/i4-agent-fanout.sh`、`bash scripts/verify/i5-project-removal.sh`、`bash scripts/verify/i6-chat-info.sh`、`bash scripts/verify/i7-chat-scope.sh`。

## UI 交付证据

页面按 Human 选定的形状交付：群创建与成员管理、成员行资料块、右栏治理段（owner 变更与标题治理）、底部按钮行（更改 Owner、重命名、复制 Chat ID）、成员移除二次确认，以及公共频道不出现成员治理入口。四种会话各有真实 Chromium 截图，两档宽度下主要操作可达。

提交 `e3ae056`。重跑 `bash scripts/verify/as-p5a-chat-ui.sh`、`bash scripts/verify/i-chat.sh`。

## human-体验确认

- 确认记录：Human 亲自体验确认通过，版本 `2fd0ee9`
- 确认范围：群创建与成员管理、成员行资料块、右栏治理段、成员移除二次确认、底部「更改 Owner」「✏ 重命名」「复制 Chat ID」按钮行、DM 与群聊切换、Info Hub 分身的 run 汇总行（完成在前、失败在后，绿色与红色分别标出两类结果）。
- 待办事项：无。
