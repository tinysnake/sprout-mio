# P3 轮次语义

本 unit 让同一分身上的轮次串行，让活跃 run 期间投递的新 human 消息以 steer 语义进入当前轮，让用户能停止排队中或运行中的 run，并让失败以可解释结果呈现。证明分界沿用 p3-a：`bash scripts/verify/o-turn-semantics.sh` 用协议桩证明宿主行为与 SQLite 不变量；`bash scripts/verify-live/pi-dm-turn.sh` 用真实模型证明投递、停止与 profile 下一轮生效。

## 投递语义的选择

「新消息进入当前轮」冻结为 steer 语义，不是 followUp，也不是另起 run。P0 实测（`docs/p0/pi-integration.md` 的 c 节）：steer 在工具调用结束后、下一次 LLM 调用之前送达，模型放弃原任务，消息以 user 角色进入会话历史；不带 `streamingBehavior` 的普通 prompt 会被 SDK **显式拒绝**而不是静默排队。因此宿主必须显式选择语义，不能依赖默认值。

协议在 `src/server/pi-host/protocol.ts` 新增两条消息，其余事件语义与关闭时限不变：

| 方向            | 新增消息                                        | 含义                                        |
| --------------- | ----------------------------------------------- | ------------------------------------------- |
| 父进程给 runner | `steer`（`id`、`messageId`、`text`）            | 把一条 pending 输入送进当前轮               |
| runner 给父进程 | `input_rejected`（`id`、`messageId`、`reason`） | 会话不在运行或拒绝该消息；reason 是可读原因 |

runner 的 `deliverSteer` 先检查 `session.isStreaming`，再调用 `session.steer(text, undefined, { source: "rpc" })`。成功发 `input_delivered`，失败或会话不在线发 `input_rejected`。

## 领域路径

- 串行与追加由 p3-a 的 `appendHumanRunInput` 与 `agent_run_one_active_instance` 部分唯一索引保证：活跃 run 存在时新消息不产生第二个 run，只追加一行 `pending` 输入。
- 宿主的 `execute()` 在 run 进入 `running` 后启动 100ms 投递轮询（`src/server/pi-host/index.ts`），对每条未发送的 pending 输入调用 `PiSessionProcess.steer()`。`input_delivered` 事件经既有 `markRunInputDelivered` 置 `delivered` 并写 `deliveredAt`；用户停止后迟到的确认保持 pending，不升级为进程故障。
- `input_rejected` 或 steer 发送失败走 `recordRunInputDeliveryFailure`：写 `agent_run.input_delivery_failed` warn 诊断（含可读原因），输入保持 `pending`。投递不走 `agent_run_input` 与 run 状态机之外的任何旁路。
- 停止入口 `abortAgentRun(id, ctx)`（`src/domain/agent-run.ts`）经 `transitionAgentRun` 把 queued 或 running 的 run 置为 `aborted`，`stopReason = 'aborted'`，不写入任何 agent 回复消息。边界 `abortAgentRunFn`（`src/server/functions/agent-run.ts`）沿用 Project 授权与 instance 校验，落库后再调用 `pi-host` 的 `signalRunAbort(runId)` 向还活着的子进程发 `abort`；停止的真值在 run 状态机，进程信号只是传导。两种情形结果一致：queued 的 run 不会再被调度，running 的 run 使 `session.abort()` 生效且 `completeAgentRun` 被状态机拒绝。

## 失败必须可解释

- 数据库新增 `agent_run_failed_check`（迁移 `drizzle/0003_fast_moon_knight.sql`）：`status = 'failed'` 时 `error_code` 与非空 `error_message` 必须存在。按 SO28，CHECK 显式使用 `IS NOT NULL` 守卫，反证不走领域层直接 INSERT 非法组合。
- 领域入口 `transitionAgentRun` 对 `failed` 迁移同样要求 `errorCode` 与非空 `errorMessage`，否则 `conflict`。
- UI 把 `failed` 显示为「失败」加 `errorMessage` 与 `requestId`（`run-failure`、`run-failure-request`），绝不显示为已完成或空回复。

## UI

对话页发送区上方新增运行状态面板（`src/components/chat/run-status.tsx`），数据来自 `getChatRunStateFn`。宿主已启用且尚无 run 时属于空闲，不渲染状态行；其余情况把状态、未投递条数与恢复入口合并为一行（窄屏自然换行），失败块单独显示：

| 状态         | 文案           | 判定                                       |
| ------------ | -------------- | ------------------------------------------ |
| 宿主未启用   | 宿主未启用     | `SPROUT_PI_ENABLED=false`                  |
| 空闲         | 不显示         | 宿主已启用且无 run                         |
| 排队中       | 排队中         | run `queued`                               |
| 运行中       | 运行中         | run `running`                              |
| 有未投递输入 | N 条输入未投递 | 任意 run 存在 `pending` 输入               |
| 已停止       | 已停止         | run `aborted`                              |
| 失败         | 失败           | run `failed`，附 errorMessage 与 requestId |

`pending` 输入只以「未投递」出现，任何界面都不显示为已处理。停止按钮（`run-stop`）只在 queued/running 出现，调用 `abortAgentRunFn` 后经路由重新取数。页面在 queued/running 期间每 1.2 秒轮询刷新，其余时间不轮询。P2 的静态「未接入真实 Pi 运行」说明随真实接入移除，`k-acceptance-flow.mjs` 的对应断言改为「宿主未启用」（见下节）。

## profile 只影响下一轮

run 的快照在进入 `running` 时由 `ready` 事件落库，此后编辑 profile 不改写（p3-a 已证 hermetic 一半）。本 unit 补齐另一半：下一轮的 `open` 用编辑后的 profile，快照与实际执行都换新。hermetic 与 live 各有两侧断言：`.verify/o-turn-semantics/evidence.json` 的 `profile edit affects only the next turn`、live 的 `profile edit takes effect on the next turn only`。

## 既有断言的最小更新

SO17 例外一条，被「真实接入后移除静态说明」打破：

| 文件与原行号                                         | 原文                                                                                         | 新文                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `scripts/browser/k-acceptance-flow.mjs`（chat 分支） | `assert.match(await test(page, "chat-runtime-note").textContent(), /P2 未接入真实 Pi 运行/)` | `await sameText(page, "pi-host-status", "宿主未启用")` |

k-acceptance 在 `SPROUT_PI_ENABLED=false` 下运行，新断言验证同一页面位置显示「宿主未启用」。其余既有精确断言（迁移计数、索引清单）未被本 unit 打破：迁移计数自 p3-a 起从 `drizzle/*.sql` 文件数推导。

## 可复跑证据

长命令都后台执行，日志与退出码写 `/tmp/p3-b-*.log`。验收只用独立 `.verify` 数据库。

| 命令                                                    | 结论                                                               | 产物                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                        | 0，锁文件未修改                                                    | `/tmp/p3-b-install.log`                                       |
| `pnpm db:generate`                                      | 0，生成 0003 迁移（`agent_run_failed_check`）                      | `/tmp/p3-b-generate.log`                                      |
| `node --import tsx .verify/p3-b-failed-check-probe.mjs` | 0，红绿反证：0002 库放行非法 failed，0003 库拒绝                   | `/tmp/p3-b-failed-check.log`                                  |
| `pnpm test`                                             | 0，15 个文件、108 个测试通过                                       | `/tmp/p3-b-test.log`                                          |
| `pnpm check`                                            | 0，格式、lint、类型检查                                            | `/tmp/p3-b-check4.log`                                        |
| `bash scripts/verify/o-turn-semantics.sh`               | 0，协议桩下的串行、投递、停止、失败可解释、profile 下一轮、UI 断言 | `.verify/o-turn-semantics/evidence.json`、`/tmp/p3-b-o.log`   |
| `bash scripts/verify.sh`                                | 0，18 个脚本全部通过                                               | `/tmp/p3-b-verify.log`                                        |
| `bash scripts/verify-live/pi-dm-turn.sh`                | 0，真实模型三轮复述、跨重启、steer、停止、profile 下一轮           | `.verify/live-pi-dm-turn/evidence.json`、`/tmp/p3-b-live.log` |

o 脚本断言清单：懒启动无子进程、首条输入 delivered 且写 deliveredAt、活跃 run 期间新消息不产生第二个 run 且被 steer 置 delivered、投递被拒保持 pending 且有 warn 诊断、停止 running 得 aborted 且无 agent 回复且子进程退出、`failed` 全部带 errorCode 与非空 errorMessage、编辑 profile 不改写运行中快照且下一轮用新 profile、禁用宿主报告 `enabled=false` 且停止 queued 得 aborted、UI 失败/运行中/已停止三态与 pending 输入不显示为已处理、页面无 console 错误。

live 增量断言：真实模型一轮运行中投递 `STEER_OK` 指令，同一 run、同一 session、`delivered` 且回复只含 `STEER_OK`；`sleep 120` 运行中编辑 persona 不改写该轮快照，`abortAgentRunFn` 停止后 run 为 `aborted`、`stop_reason=aborted`、无 agent 回复消息；下一轮用新 persona，确定性断言为真实 transcript 的 system prompt 含新 persona，模型断言为回复含 `PROFILE_V2`，session 文件与 session ID 与首轮一致。首轮 live 失败为模型波动（旧提示词下模型无视新人设直接回答了数学问题），换用依指令回答的提示词后通过，与 p3-a 记录的口令复述同类风险。

截图（真实 Chromium，hermetic 协议桩驱动页面）：`docs/p3/evidence/p3-b-run-failed.png`、`p3-b-run-running-pending.png`、`p3-b-run-aborted.png`。

## 未验证项

- codemode、tool_search、MCP 三个内置 extension 的 SDK 加载与工具接线仍未验证（沿用 p3-a）。
- 口令复述与 steer 到达时机依赖模型行为。模型偶尔不按指令使用工具或不复述会使严格断言失败；失败时先看完整 transcript 与 run 状态，区分集成错误与模型波动（沿用 p3-a）。
- magpie native provider 的真实推理与缺省模型回退未由本 unit 验证（沿用 p3-a）。
- 多分身并发、stdout 消费背压、超大工具输出、长工具进程被强杀后的全部后代清理、Windows 与 dev worker 信号转发未验证（沿用 p3-a）。
- 被拒投递后的人工重试入口未实现：输入保持 pending，等待后续 unit 决定重投或清理策略。
- follow_up 语义（本轮结束后同 run 内补一轮）未接入，本 unit 只接 steer。
