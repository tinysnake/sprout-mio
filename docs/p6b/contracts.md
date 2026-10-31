# P6b 契约：Info Hub 一期视角、轮初快照与运行中提示

本文记录 I-P6b 在 `integration/p6b` 上冻结的共享契约与数据库形态，供 P6c 及后续章节引用。基线代码头 `4d9545c`（P6b 的最后一个代码/门禁提交；其后的提交只改文档）。

标注约定：**实测**＝本轮亲自执行并核对过输出；**引用**＝读源码、迁移或既有报告得出，未重复执行；**未验证**＝已知但未在本轮取证的推断。

本章的交付结论与已知限制见 [P6b 章节结论](summary.md)。

## 四个视角形状

四个视角各有一份读视图契约，**视图即投影**：字段集合、去重键与跨对象约束都写在 schema 的 `refine`/`superRefine` 里，不是领域层的口头约定。

| 视角    | Schema                                                     | 位置                              | 关键字段                                                                                       | 跨对象约束（`refine`）                                                                 |
| ------- | ---------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Project | `projectInfoHubSchema`                                     | `src/contracts/info-hub.ts`       | `tasks`（计数 + 条目）、`agents`（`agents` + `runs`）、`chats`、`machines`、`leases.available` | machines 与 leases 必须属于同一 Project                                                |
| Chat    | `chatInfoViewSchema`                                       | `src/contracts/info-hub.ts`       | `automation?`、`members`、`owner`、`instances`、`messages`、`runs`、`tasks`                    | 分身租约属于本 Project 且 holder 指向本 Chat；活动与最近 run 的 `chatId` 必须是本 Chat |
| Agent   | `agentInfoViewSchema`                                      | `src/contracts/info-hub-query.ts` | `agent`、`runs`（active/recent）、`instances`                                                  | run 的 `agentProfileId`、分身的 profile 与租约 Project 必须一致                        |
| Machine | `machineInfoViewSchema`（= `infoHubMachineSummarySchema`） | `src/contracts/info-hub-query.ts` | 连接状态、能力、最近探测、`lease`                                                              | 由 `infoHubViewSchema` 的 `superRefine` 校验 `projectId`/`machineId` 同一              |

共同约定（**引用**，`info-hub.ts`）：

- **唯一数组**：`chats`、`machines`、`members`、`instances`、`runs`、`tasks`、`leases` 全部用 `infoHubUniqueArray` 加去重键（`chatId`、`machineId`、`memberKind:memberId`、`instanceId`、`runId`、`taskId`），重复项直接判 schema 失败，读视图不会出现两条同 id 事实。
- **`unavailableFeatureSchema`**：能力缺失用「明确不可用」表达，不用空对象或省略字段冒充。
- **`chatRunAggregateSchema`**：Chat 的 run 摘要按 `agentCount`（按 profile 去重）、`statusCounts`（只列真实出现过的状态）、`activeRunIds` 聚合；P6a 的 `automation` 摘要（`mode`/`epoch`/`nextDueAt`/`lastDecision`/`attentionCode`/`remindedHuman`）以 `chatAutomationSummarySchema` 扩展进来，`mode` 不是 `enabled` 时 `nextDueAt` 必须为 null。
- **身份只从授权来**：`machineInfoViewSchema` 与 `agentInfoViewSchema` 的 `projectId` 字段是响应事实，不是入参；入参身份永远来自 live grant（见 [Agent 工具](#agent-工具-sprout_info_hub_get)）。

## 查询、游标与分页

`src/contracts/info-hub-query.ts`（**引用**）：

```ts
export const infoHubQuerySchema = z.discriminatedUnion("view", [
  { view: "project", section: "agents" | "chats" | "tasks" | "machines", cursor?, limit? },
  { view: "chat", chatId, section: "summary" | "members" | "runs" | "tasks" | "machines", cursor?, limit? },
  { view: "agent", agentProfileId, section: "summary" | "runs" | "instances" | "machines", cursor?, limit? },
  { view: "machine", machineId },   // 不分节、不分页
]);
```

- **判别联合的判别键是 `view`**：四视角只有 `machine` 没有 `section`/`cursor`/`limit`；`cursorPayloadSchema` 显式拒绝 `query.view === "machine"` 或带嵌套 cursor 的载荷。
- **分页语义**：`limit` 默认 `INFO_HUB_LIMITS.defaultPageSize`、上限 `maxPageSize`；`page = { total, nextCursor }`，`nextCursor` 为 null 表示结束。`infoHubViewSchema` 的 `superRefine` 要求 `page.total >= data.length`，且 `nextCursor` 非 null 时 `data` 不得为空（页元数据不许和事实矛盾）。
- **游标是签名信封，不是偏移量**：`signCursor` 写 `{ expiresAt: now + 5 分钟, payload }`，HMAC-SHA256 签名（进程内随机 secret）；`parseCursor` 做定长 `timingSafeEqual` 比较并检查过期。**5 分钟 TTL 在 `src/domain/info-hub.ts` 里写死，没有进 `INFO_HUB_LIMITS`**。
- **游标绑定五个事实**：`projectId`、`actorScope`、`query`（原范围，不含 cursor）、`revision`、`sort: "stable_id_asc"`。任一不匹配、签名不合法、过期、`after` 已不在结果里，一律 `info_hub_cursor_stale` —— 页面只需「从第一页重来」，不需要理解刷新原因。
- **排序固定**：`stable_id_asc`（按各节去重键 `localeCompare`），所以同一 revision 下页边界稳定。
- **响应预算**：超过 `maxResponseBytes` 时从尾部裁剪条目并重算游标；只剩 1 条仍超预算就 `too_many_requests`（宁可拒答，不返回被截断却自称完整的视图）。
- **`refreshInfoHub` 的判别联合**：`{ kind: "changed", view }` 或 `{ kind: "unchanged", projectId, query, revision, asOf }`；`unchanged` 只回 revision 与查询范围，不重发视图。恢复可见时丢弃 `knownRevision`（见 [轮询](#info_hub_polling-的每个取值)）。

## INFO_HUB_LIMITS 的每个取值

`src/contracts/info-hub.ts`（**引用**）。产品文档把合并与频率留在实现层（`docs/info-hub-decisions.md`「合并重复提示、控制通知频率等属于实现设计」），这里冻结的是实现必须共用的数值。

| 取值                    | 值       | 理由                                                                                        | 谁在读                                                           |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `defaultPageSize`       | `25`     | 一屏即可渲染完的默认页；调用方不必知道页容量就能拿到可用结果                                | `info-hub-query.ts` 的 `pagination.limit`                        |
| `maxPageSize`           | `100`    | 单页硬上限，防一次读把响应预算和渲染一起打爆；超出是 `validation_failed`                    | `info-hub-query.ts` 的 `limit.max` 与 `data.max`                 |
| `maxResponseBytes`      | `65_536` | 单个响应（JSON UTF-8）预算；与分页裁剪、游标重算绑定                                        | `info-hub-query.ts` 响应 schema、`domain/info-hub.ts` 的裁剪循环 |
| `maxTurnContextBytes`   | `8_192`  | 轮初快照的文本预算；与迁移 `0028` 的 `turn_context_text_budget` 同值，SQL 与 zod 都拒超预算 | `turn-context.ts`（zod `refine`）、`0028` CHECK                  |
| `maxHintBytes`          | `1_024`  | 单条提示的 UTF-8 预算；提示是转向输入，不是记录，超预算即 schema 失败                       | `info-hub-hint.ts` 的 `superRefine`                              |
| `hintMergeWindowMs`     | `2_000`  | 首个变化到发出一条提示至少等 2 秒，让同一窗口内的多个变化合成一条                           | `domain/info-hub-hint.ts#tick`                                   |
| `hintMinimumIntervalMs` | `5_000`  | 两条提示最小间隔 5 秒，防止逐 tick 投递把 run 淹没                                          | `domain/info-hub-hint.ts#tick`                                   |

`maxTurnContextBytes` 在两个地方各写一次（zod 与 SQL CHECK），改一处必须同步迁移；本轮没有把它变成单一来源。

## INFO_HUB_POLLING 的每个取值

`src/contracts/info-hub.ts`（**引用**），消费方是 `src/components/info-hub/use-info-hub-polling.ts`。

| 取值                          | 值       | 理由                                                                          | 实现落点                                                                          |
| ----------------------------- | -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `intervalMs`                  | `3_000`  | 页面「当前事实」的节拍；页面门禁断言相邻请求间隔不低于它                      | controller `schedule()`                                                           |
| `backoffMultiplier`           | `2`      | 连续失败时 `3 → 6 → 12 → 24 → 30s` 指数退避，成功即清零                       | controller `schedule()`/`request()`                                               |
| `maxBackoffMs`                | `30_000` | 退避上限，也钳住抖动后的延迟，避免无限拉长                                    | controller `schedule()`                                                           |
| `jitterRatio`                 | `0.1`    | ±10% 抖动，避免同一时刻打开的多个页面同步打点                                 | controller `schedule()`                                                           |
| `requestTimeoutMs`            | `10_000` | 单请求超时用 `AbortController` 中止，不让一个挂起的请求占住唯一在途名额       | controller `request()`                                                            |
| `maxInFlight`                 | `1`      | 一个可见上下文只有一个请求在途（页面只有一个轮询 owner）                      | **声明值**：controller 用 `inFlight` 单变量保证，测试与页面门禁断言「一个 owner」 |
| `pauseWhenHidden`             | `true`   | 隐藏即停：后台标签不产生流量                                                  | **声明值**：`paused()` 读 `document.visibilityState`                              |
| `pauseWhenOffline`            | `true`   | 离线即停，不用失败重试冒充在线                                                | **声明值**：`paused()` 读 `navigator.onLine`                                      |
| `refreshImmediatelyOnVisible` | `true`   | 恢复可见立即请求一次，不等下一个节拍                                          | **声明值**：`visibilitychange → resume()` 立即 `request()`                        |
| `fullRefreshOnResume`         | `true`   | 恢复时丢 `cursor` 与 `knownRevision`，取完整视图（断开期间可能错过 revision） | **声明值**：`resume()` 重置 `fullRefresh`/`revision`                              |
| `abortOnScopeChange`          | `true`   | scope 变化即中止在途请求，晚到的结果不得写进新 scope                          | **声明值**：`useEffect` 以 `JSON.stringify(input)` 为键，清理函数 `abort()`       |

`maxInFlight`、`pauseWhenHidden`、`pauseWhenOffline`、`refreshImmediatelyOnVisible`、`fullRefreshOnResume`、`abortOnScopeChange` 六个值**没有**被 controller 直接读取：行为由 `paused()`/`resume()`/`inFlight`/effect teardown 结构性实现，数值由 `tests/p6b-polling.test.ts` 与 `bf-p6b-pages` 钉住。把它们当成「读了这个常量才有这个行为」会误判改动面。

## 运行中提示

`src/contracts/info-hub-hint.ts` + `src/domain/info-hub-hint.ts`（**引用**）。提示是**宿主发往运行中 Agent run 的临时转向输入**，不是持久记录，也没有 Human 侧的收据（见 [已知限制](summary.md#human-侧提示合并与去重收据不交付)）。

- **七种变化种类**：`chat_members`、`chat_owner`、`chat_archived`、`task_summary`、`agent_status`、`machine_connection`、`machine_lease`。前五种带 `chatId`，后两种带 `machineId`（`infoHubHintChangeSchema` 按 `kind` 判别）。
- **作用域约束**：所有 `chatId` 变化必须等于提示自己的 `chatId`；所有 `machineId` 变化必须在该 run 的 `heldMachineIds` 里（这条间接要求：带 machine 变化的提示里 `heldMachineIds` 不可为空）。`changes` 至少 1 条，`heldMachineIds` 去重。
- **合并窗口与最小间隔**：`tick(at)` 收集变化 → 首次变化起满 `hintMergeWindowMs`（2s）且距上次投递满 `hintMinimumIntervalMs`（5s）才发一条；未发出的变化留在本 run 内存里继续等下一个窗口。
- **去重键**：`{ runId, kind, targetId, revision }`（`infoHubHintDedupeKeySchema`），只存在当前 run 的内存里，settle 时整体丢弃；同一 key 不重复投递。
- **字节预算**：整条提示 JSON 超过 `maxHintBytes`（1024）就按变化逐条试加，装不下就发已装下的部分，装不下的一条留到下次；一条都装不下则丢弃（`dispose()`）。
- **失败即丢弃**：`deliver` 抛错只吞掉，不重试、不排队、不写消息、不写 run/input/lease 行。
- **提示没有的字段**：`message`、`admission`、`retry`、`resource notice` 都不存在——这是 `infoHubHintSchema` 的注释级契约（`Run-local ephemeral steering, with no message, admission, retry or resource-notice fields`）。
- **时间由宿主注入**：`tick(at)` 不读时钟，合并窗口与最小间隔按同一时刻判断（`tests/tooling.test.ts` 的「参与判断的时间只能注入」要求）。

## 能力与错误码

`src/contracts/info-hub-capabilities.ts`（**引用**）。

四个动作（`INFO_HUB_ACTIONS`）与两个主体（Human / Agent）的授权矩阵：

| 动作                    | Human     | Agent     | 语义                                                             |
| ----------------------- | --------- | --------- | ---------------------------------------------------------------- |
| `basic.read`            | `project` | `project` | 四个视角的基本事实；Project 成员即可读                           |
| `turn_snapshot.read`    | `project` | `never`   | 读**已持久化**的轮初快照；Agent 不能用它读自己的（或别人的）快照 |
| `turn_snapshot.capture` | `never`   | `never`   | 只有宿主捕获，没有合成的 system Agent                            |
| `hint.deliver`          | `never`   | `never`   | 只有宿主投递；Human 与 Agent 都不能主动推提示                    |

八个错误码（`INFO_HUB_ERROR_CODES`，全部是 `APP_ERROR_CODES` 的子集）：

| 错误码                     | 触发                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `unauthorized`             | 没有会话                                                                           |
| `forbidden`                | 有身份但没有该动作（Agent 读快照、Agent 捕获/投递）                                |
| `not_found`                | 对象不存在，或存在但不属于调用者的 Project；外域 id 一律不区分「不存在」与「无权」 |
| `validation_failed`        | 入参 schema 失败（含页大小、节名、字段形态），带 `fieldErrors`                     |
| `too_many_requests`        | 单条事实就超过响应预算                                                             |
| `info_hub_cursor_stale`    | 游标签名/绑定/过期/`after` 失配，需要从第一页重来                                  |
| `turn_context_unavailable` | 快照未捕获、run 已不活跃、内容哈希与文本不符、收据与快照不符                       |
| `internal`                 | 未映射的异常，记 `info_hub.request_failed` 诊断                                    |

`tests/lease-contracts.test.ts` 把 `APP_ERROR_CODES` 的数量钉在 `36`（并守「无重复」与「与 remote 码表逐项一致」）；P6b 增加了其中 2 个：`info_hub_cursor_stale`、`turn_context_unavailable`。

## 轮初快照与提交收据

`src/contracts/turn-context.ts` + `src/domain/turn-context.ts`（**引用**）。

- **runId 是快照主键**：`captureTurnContext({ projectId, runId }, ctx)` 只按 runId 取身份，其余身份（`instanceId`、`agentProfileId`、`chatId`）由宿主从 `agent_run` 解析，**不从 Chat 的第一个分身推断**；`scopeFor` 还要求 run 属于该 Project，Agent 主体只能读自己的 run。
- **一次捕获，永不改写**：重复 `captureTurnContext` 返回**原始**快照（进程重启后一样），因为 `record`/`serializedText`/`contentHash` 列被触发器钉死。
- **文本与哈希**：`contentHash` = `sha256(serializedText)`，读取时重算比对，不符即 `turn_context_unavailable`（防止「记录说注入了 A、实际注入 B」）。
- **交付三态**：`prepared | submitted | failed`。`prepared` 表示已持久化但**尚未**进入 SDK prompt；`submitted` 必须带收据；`failed` 必须带 `failureCode`（`serialization_failed` / `persistence_failed` / `submission_failed`）。**`failed` 是为未来的投递失败预留的，当前无 producer**：领域层只写 `prepared`/`submitted`，但读路径已经处理它（`confirmTurnContext` 拒绝 failed 记录，页面有「提交失败」标签）。
- **`injectedIntoPrompt` 是派生值**，`turnStartContextSchema.superRefine` 要求它严格等于 `deliveryState === "submitted"`，并要求 `submittedAt` 非空当且仅当 `submitted`、`failureCode` 非空当且仅当 `failed`。**页面因此不能把 `prepared` 说成「已注入」。**
- **提交收据**：`turnContextSubmissionReceiptSchema = { runId, contentHash, submittedAt }`；`confirmTurnContext(receipt, ctx)` 校验 `record.contentHash === receipt.contentHash`、run 仍活跃、`deliveryState !== "failed"`，并用 `turnContextConfirmedSubmissionSchema` 再交叉校验 `record.submittedAt === receipt.submittedAt`，重复提交同一 `submittedAt` 幂等，不同 `submittedAt` 拒绝。
- **prompt 边界**：`prepareTurnContext` 只接受 `deliveryState === "prepared"` 且 run 活跃，返回 `{ runId, contentHash, serializedText }` 交给 runner 前置一次；预置输入里没有别的字段，runner 不能借它改投递状态。
- **读结果**：`turnContextReadResultSchema` 是判别联合 `{ kind: "captured", record }` / `{ kind: "not_captured", projectId, runId }`——「没捕获」是明确事实，不是空对象。

## turn_context 表

迁移 `drizzle/0028_p6b_turn_context.sql`（**引用**）。

| 列                | 类型    | 约束                                                 |
| ----------------- | ------- | ---------------------------------------------------- |
| `run_id`          | text    | 主键；FK → `agent_run.id`                            |
| `project_id`      | text    | FK → `project.id`；索引 `turn_context_project_idx`   |
| `instance_id`     | text    | FK → `agent_instance.id`                             |
| `serialized_text` | text    | `turn_context_text_budget`：1..8192 字节             |
| `content_hash`    | text    | `turn_context_hash_check`：64 位小写 hex（`sha256`） |
| `basis_revision`  | text    | 捕获时的 Info Hub revision                           |
| `captured_at`     | integer | 捕获时刻                                             |
| `record`          | text    | `turn_context_record_check`：`json_valid`            |
| `delivery_state`  | text    | `turn_context_delivery_check`：三态互斥              |
| `submitted_at`    | integer | 仅 `submitted` 可非空，且 ≥ `captured_at`            |
| `failure_code`    | text    | 仅 `failed` 可非空                                   |

四个触发器（**不可变性靠数据库兑现，不靠领域层自觉**）：

| 触发器                             | 时机                                                                                                                   | 作用                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `turn_context_identity_insert`     | BEFORE INSERT                                                                                                          | 要求 `agent_run` 的 `project_id`/`instance_id` 与行内一致，否则 `turn_context_identity_mismatch`                         |
| `turn_context_immutable`           | BEFORE UPDATE OF `run_id, project_id, instance_id, serialized_text, content_hash, basis_revision, captured_at, record` | 直接 `RAISE(ABORT, 'turn_context_immutable')`                                                                            |
| `turn_context_delivery_transition` | BEFORE UPDATE OF `delivery_state, submitted_at, failure_code`                                                          | `prepared` 之外不得再变（`turn_context_delivery_final`）；`prepared → submitted/failed` 仍受 `delivery_check` 与领域校验 |
| `turn_context_no_delete`           | BEFORE DELETE                                                                                                          | `turn_context_immutable`：快照不删，随 run 的历史留着                                                                    |

`turn_context_delivery_check` 的三条分支：

```sql
(prepared and submitted_at is null and failure_code is null)
or (submitted and submitted_at >= captured_at and failure_code is null)
or (failed and submitted_at is null and failure_code is not null)
```

## Agent 工具 sprout_info_hub_get

证据提交 `4d9545c`：重跑 `bash scripts/verify/bf-p6b-agent-tool.sh`。工具面与拒绝面的实测在 `docs/p6b/summary.md#功能线证据`。

`src/extension/info-hub-tools.ts` + `src/contracts/info-hub-query.ts#infoHubToolInputSchemas` + `src/server/remote-agent-gateway.ts`（**引用**）。

**允许面**

- 参数就是 `infoHubQuerySchema`（`infoHubToolInputSchemas.sprout_info_hub_get`）：`view` + `section` + 分页参数，四视角全部可用，包括 `machine`。
- 身份只有一处来源：`remoteAgentRequestSchema` 里注入 `projectId: client.projectId`（来自 live process grant），网关再用 `actorContext.projectId` 覆写、`projectContext.agent` 带 `agentProfileId/instanceId/runId`。**模型不能用参数冒充 Project 或别的分身。**
- 结果是 `getInfoHub` 的同一个判别联合视图（与页面同源），页面与工具不会各看到一套事实。
- 描述里写明：status 与 held lease 是**事实**，不是执行授权；分页用 `nextCursor`，`info_hub_cursor_stale` 就从第一页重来。

**拒绝面**

- **Chat/Task 正文**：不在任何视角里，工具读不到消息正文、Task 记录正文（Chat/Task 的正文访问是另一条授权路径）。
- **轮初快照**：`turn_snapshot.read` 是 `agent: "never"`，所以没有读快照的工具；`turn_snapshot.capture` 与 `hint.deliver` 同为 `never`。
- **写入**：这套工具没有 mutate 动作，`basic.read` 只读；租约、移除、Task 变更各有自己的工具与授权。
- **跨 Project**：外域 `chatId`/`agentProfileId`/`machineId` 一律 `not_found`，不区分「不存在」与「不属于你」（`Agent status 只汇总当前 Project` 由此兑现）。
- **入参校验**：`schema.safeParse` 失败返回 `validation_failed` + `requestId: "info-hub-tool-validation"`，不落库、不请求网关。

## 本章没有冻结的东西

- **Human 侧的提示合并/去重收据**：没有契约，也没有 producer/consumer，见 [已知限制](summary.md#human-侧提示合并与去重收据不交付)。
- **游标 5 分钟 TTL**：写在 `domain/info-hub.ts` 里，没进 `INFO_HUB_LIMITS`（改它不影响页面，但会改变分页寿命）。
- **Hub 的 revision 计算方式**：`refreshInfoHub` 用它判 `changed`/`unchanged`，具体内容是实现细节，不是契约（页面只把它当不透明字符串）。
- **`machine` 视角的字段集扩展**：`machineInfoViewSchema` 直接复用 Machine 摘要；Machine 详情仍是 P4b 的读视图，P6b 没有合并两者。
