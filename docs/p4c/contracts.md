# I-P4c 共享契约与数据库

本单元交付 I-P4c 的共享 wire / 领域契约与新增迁移 `0013`，不实现 Worker 执行、宿主日志持久化逻辑、Pi 工具或 UI。实现输入是冻结的 `orchestrate/sprout-mio-p4c/reports/design-judge.md`（下称「冻结设计」）。租约单位仍是 Project × Machine；Worker 以运行用户权限执行，工作目录不是安全边界。

本单元只交付 schema 与约束层的反证。恢复归约、日志写入、取消入队与读取的业务实现属于 p4c-execution，Worker 侧采集与预算分配属于 p4c-worker，工具面属于 p4c-tools，界面属于 p4c-ui。

## 迁移

`drizzle/0013_long_command_execution.sql`，`_journal.json` 的 `idx=13`、`when=1793037759301`，大于 `0012_active_mcp_sessions` 的 `1792949613746`。只新增迁移，不改已合并迁移。

迁移做三件事。`remote_execution` 重建表以把 `deadline_at` 改名为 `dispatch_deadline_at` 并新增 7 列。新建 `execution_log_frame`。新建 `execution_cancellation`。裁剪不新建第三张表。

表重建保留 `remote_execution_check_1` 至 `check_19`、两个唯一索引与三个既有外键，旧 `deadline_at` 的值原样写入 `dispatch_deadline_at`，新列按默认值回填（`log_state='none'`，其余 NULL）。不写向后兼容分支，不保留 `deadline_at`。

## 表 1 remote_execution 扩列

| 列                         | 类型                                                                           | 约束与语义                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `dispatch_deadline_at`     | integer timestamp_ms，非空                                                     | 只约束下发窗口。到期未下发写 `timed_out`。不再是运行寿命。                                                                           |
| `runtime_deadline_at`      | integer timestamp_ms，可空                                                     | 下发时由 `max_runtime_ms` 推导的绝对运行上限。未到点且 runner 仍在产出时不得写终态。                                                 |
| `max_runtime_ms`           | integer，可空                                                                  | 仅 shell 有值，来自工具入参。NULL 表示沿用短操作语义。                                                                               |
| `runner_token`             | text，可空                                                                     | 32 位小写 hex。宿主在 command 下发时生成并随 `remoteCommandSchema` 交出；runner 写进 claim 与 result。新会话报告恢复事实必须带该值。 |
| `log_state`                | text enum `none` / `partial` / `full` / `gap` / `truncated`，非空，默认 `none` | 日志完整性与执行结果正交。                                                                                                           |
| `produced_through_seq`     | integer，可空                                                                  | 已产出（宿主已落盘）的最大 sequence。                                                                                                |
| `acknowledged_through_seq` | integer，可空                                                                  | 连续前缀已确认的最大 sequence。                                                                                                      |
| `available_from_seq`       | integer，可空                                                                  | 可读起点。裁剪只推进这一个事实。                                                                                                     |

新增 CHECK（原名保持，NULL-safe，引用可空列处都显式处理 NULL）：

| 名称                        | 语义                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `remote_execution_check_7`  | `dispatch_deadline_at > created_at`                                                           |
| `remote_execution_check_8`  | `failure_reason IS NULL OR failure_reason IN (...)`，NULL-safe 修复                           |
| `remote_execution_check_19` | 非终态只看 `terminal_at IS NULL`，不再由墙钟推导                                              |
| `remote_execution_check_20` | `runner_token IS NULL OR (length=32 AND NOT GLOB '*[^0-9a-f]*')`                              |
| `remote_execution_check_21` | `log_state IN ('none','partial','full','gap','truncated')`                                    |
| `remote_execution_check_22` | `max_runtime_ms` 与 `runtime_deadline_at` 同生同灭，且 `runtime_deadline_at >= dispatched_at` |
| `remote_execution_check_23` | 三个位点非负；`ack` 不能多出 `produced`；`available_from_seq <= produced_through_seq + 1`     |
| `remote_execution_check_24` | `log_state='none' OR produced_through_seq IS NOT NULL`                                        |
| `remote_execution_check_25` | `log_state!='full' OR acknowledged_through_seq IS NOT NULL`                                   |

现状事实：迁移前的 `check_8` 在 `failure_reason` 为 NULL 时放行，属漏检；本轮改为显式 `IS NULL OR`，未改变任何合法行的可写性。

## 表 2 execution_log_frame

追加流。一行一个有序帧，或一行只表达 gap。

| 列                                                                           | 约束                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `execution_id`、`sequence`                                                   | 复合主键。`sequence` 1..9007199254740991，跨 stdout 与 stderr 共享一个单调序。 |
| `project_id`、`machine_id`、`authorization_generation`、`holder_instance_id` | 复合外键指向 `remote_execution` 的同名五列，形状与 `execution_result` 一致。   |
| `stream`                                                                     | `stdout` 或 `stderr`。                                                         |
| `byte_start`、`byte_end`                                                     | 原始 UTF-8 字节位点，`byte_end >= byte_start`。                                |
| `payload_bytes`                                                              | blob，`length <= 16384`（`EXECUTION_LOG_FRAME_MAX_BYTES`）。                   |
| `checksum`                                                                   | 64 位小写 hex。                                                                |
| `gap_from_seq`、`gap_to_seq`                                                 | 只有 gap 行非空，且 `gap_to_seq >= gap_from_seq`。                             |
| `durable_at`                                                                 | timestamp_ms，宿主落盘时间。                                                   |

`execution_log_frame_check_7` 强制 payload 行与 gap 行二选一。裁剪事实落在 `remote_execution.available_from_seq` 与 `log_state`，加上本表的 gap 行。

## 表 3 execution_cancellation

取消是独立于执行与租约的事实。`delivered` 只证明意图送达，不证明进程已停。

| 列                                                                           | 约束                                                                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                         | 主键，前缀 `cnl`（`ID_PREFIXES.cancellation`）。                                                                                  |
| `execution_id`                                                               | 外键指向 `remote_execution.id`。                                                                                                  |
| `request_id`                                                                 | 幂等键。内部命名空间 `cancel:<actor>:<req_...>`，CHECK `substr(request_id,1,7)='cancel:'`。与公开 `req_` 在同一 holder 下不相撞。 |
| `project_id`、`machine_id`、`authorization_generation`、`holder_instance_id` | 复合外键指向 `lease_authorization`，形状同 `remote_execution`。                                                                   |
| `actor_instance_id`                                                          | 发起者分身，外键指向 `agent_instance(id, project_id)`。                                                                           |
| `state`                                                                      | `requested` / `delivered` / `exited_observed` / `already_exited` / `failed` / `unknown`。                                         |
| `signal_outcome`                                                             | `none` / `term_delivered` / `kill_delivered`。只记录 OS 是否接受信号调用。                                                        |
| `requested_at`、`delivered_at`、`exited_at`                                  | 时间字段，`delivered_at >= requested_at`、`exited_at >= delivered_at`。                                                           |
| `failure_reason`                                                             | `signal_failed` / `delivery_unconfirmed`。                                                                                        |

`execution_cancellation_check_7` 是状态与时间字段的一致性矩阵，逐条对应冻结状态机。

```text
requested        -> 无 delivered_at，无 exited_at，无 failure_reason，signal_outcome='none'
delivered        -> 有 delivered_at，无 exited_at，无 failure_reason
exited_observed  -> 有 delivered_at 与 exited_at，无 failure_reason
already_exited   -> 同上；命令先自然退出，不重写原结果
failed           -> 有 delivered_at，无 exited_at，有 failure_reason
unknown          -> 无 exited_at，有 failure_reason（允许同时有 delivered_at）
```

租约 acquire、release、handoff、reclaim 与断联都不写入本表。`exited_observed` 只由 runner 落盘的 durable result 触发。

## Zod 形状（`src/contracts/remote.ts`）

方向按冻结设计 B4：日志帧、恢复事实上行；`logAcks`、`cancellations` 下行。

| 导出                              | 方向       | 形状                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `executionLogFrameSchema`         | 上行       | `{executionId, projectId, machineId, authorizationGeneration, holderInstanceId, dispatchSession, dispatchSeq, sequence, stream, byteStart, byteEnd, checksum, bytes?, gapTo?}`，`bytes` 与 `gapTo` 二选一，`byteEnd >= byteStart`，`gapTo >= sequence` |
| `executionRecoverySchema`         | 上行       | `{executionId, projectId, machineId, authorizationGeneration, holderInstanceId, runnerToken, observedState: running\|exited\|unknown, exitCode, signal, observedExitedAt, producedThroughSequence, claimEvidenceAt}`                                   |
| `executionCancelSchema`           | 下行       | `{cancelId, executionId, projectId, machineId, authorizationGeneration, runnerToken, policy: term_then_kill\|kill, termWaitMs <= 10000}`                                                                                                               |
| `executionCancelInputSchema`      | agent call | `leaseKeySchema.extend({executionId, requestId, authorizationGeneration, policy, termWaitMs})`                                                                                                                                                         |
| `executionLogReadInputSchema`     | agent call | `leaseKeySchema.extend({executionId, cursor: {nextSequence}\|null, limitBytes <= 65536})`                                                                                                                                                              |
| `executionLogReadViewSchema`      | 返回       | `{executionId, frames[], nextCursor, availableFromSequence, acknowledgedThroughSequence, producedThroughSequence, gapRanges[], logState, workerOnline}`                                                                                                |
| `executionCancellationViewSchema` | 返回       | `{cancelId, executionId, state, requestedAt, deliveredAt, exitedAt, signalOutcome, failureReason}`                                                                                                                                                     |
| `executionViewSchema`             | 返回       | 见下                                                                                                                                                                                                                                                   |

`remoteExchangeInputSchema` 增加 `logFrames`（≤8，可选，缺省即无帧）与 `recoveries`（≤8，可选）。`remoteExchangeOutputSchema` 增加 `logAcks`（≤8，可选）与 `cancellations`（≤4，可选）。两者都用可选而非默认值：`src/contracts/worker.ts` 用 `.extend()` 叠加 MCP 字段，`z.strictObject(...).extend` 无法在已有默认值之上继续推导可选性。

`remoteAgentRequestSchema` 新增两个分支：

```ts
{ type: 'execution_cancel', input: executionCancelInputSchema }
{ type: 'execution_log_read', input: executionLogReadInputSchema }
```

`src/contracts/worker.ts` 的 `workerExchangeInput` 新增校验：日志帧必须属于本 exchange 的 `session` 与 `seq`，且同一 `executionId+sequence` 在一批内唯一；恢复事实的 `machineId` 必须等于本会话 Machine。上行总预算仍是 1 MiB，日志帧与恢复事实一起计入。

### ExecutionView 扩展

`src/contracts/remote.ts` 的 `executionViewSchema` 新增 `dispatchDeadlineAt`（替换 `deadlineAt`）、`runtimeDeadlineAt`、`maxRuntimeMs`、`dispatchConnectionGeneration`、`dispatchSeq`、`dispatchedAt`、`drainedAt`、`payloadHash`、`logState`、`producedThroughSequence`、`acknowledgedThroughSequence`、`availableFromSequence`。视图层新增的不变量：

- `dispatchDeadlineAt > createdAt`。
- `runtimeDeadlineAt` 与 `maxRuntimeMs` 同生同灭；两者都存在时必须有 `dispatchedAt` 且 `runtimeDeadlineAt >= dispatchedAt`。
- `acknowledgedThroughSequence <= producedThroughSequence`；`availableFromSequence <= producedThroughSequence + 1`。
- `logState='none'` 时 `producedThroughSequence` 必须为 null；其余状态必须有产出位点。
- `logState='full'` 必须有 `acknowledgedThroughSequence`。

## 状态机与不变量

执行状态保留 9 值。新增两条不变量：`unknown` 与 `timed_out` 只有在带 `runnerToken` 的恢复事实或带证据的归约下才能改为已知终态；`succeeded` 与 `failed` 不因后续报告改变。schema 层能表达的单向性是：带 token 的条件更新能把 `unknown` 归约为 `succeeded` 或 `failed`；不带 token 时同一 UPDATE 命中 0 行。这两条都由 `tests/fixtures/execution-log-contracts.ts` 用真实 SQL 反证。

`log_state` 与执行状态正交。`succeeded` 配 `truncated` 合法，`unknown` 配 `partial` 合法，`full` 缺 `acknowledged_through_seq` 非法。这由 `remote_execution_check_24`/`check_25` 与视图 superRefine 双处约束。

`timed_out` 的两种语义在 schema 层可区分：`runtime_deadline_at` 为 null 的行只能因 `dispatch_deadline_at` 到期写 `timed_out`；有 `runtime_deadline_at` 的行才有运行上限到期路径。域实现必须按冻结设计分别记录 `failure_reason='deadline'` 的来源，本单元只保证两列不可互相冒充（`check_22`）。

## 游标 API

`readExecutionLog(input, ctx)` 的返回形状即 `executionLogReadViewSchema`：

```ts
{
  executionId: string;
  frames: { sequence, stream, byteStart, byteEnd, text: string | null, checksum }[];
  nextCursor: { nextSequence: number };
  availableFromSequence: number | null;
  acknowledgedThroughSequence: number | null;
  producedThroughSequence: number | null;
  gapRanges: { fromSequence, toSequence }[];
  logState: 'none' | 'partial' | 'full' | 'gap' | 'truncated';
  workerOnline: boolean;
}
```

`text` 为 `null` 表示该行是 gap 行，不是空输出。重复读同一 `nextSequence` 必须返回相同行。游标早于 `availableFromSequence` 返回 `execution_log_gap`，不静默从新起点称完整。`frames` 为空数组只表示该范围内无帧，与 `logState` 一起区分「没有输出」与「未收到」。正文按原始 UTF-8 bytes 计限额，游标不以字符数推进。

## 预算语义（B7）

`remoteExchangeBytes` 仍把 `mode`、`session`、`seq`、`configuration` 与整个 `remote` 一起算入 1 MiB，语义不变。日志帧加入后契约固定三点。

1. 上行总预算 1 MiB，日志帧、恢复事实、终端报告、fence ACK、MCP 共用同一份额（`src/contracts/worker.ts` 的 `workerExchangeInput` 与 `workerExchangeResponseSchema` 都做总量校验）。
2. 优先级由 p4c-worker 的分配器实现，顺序是 fence 与终端报告优先，日志帧按 execution 轮转使用剩余预算。日志不得饿死 fence，终端结果不得被反复降级。
3. 单帧上限 16384 bytes，单 exchange 上限 8 帧，单次读取上限 65536 bytes。三者已写进 schema 或 CHECK。达限时写 `truncated` 与 gap 行，不静默丢弃。

未测量的容量数值不在本单元写死。待测项与测量方法：

| 待定项                    | 测量方法                                                                          |
| ------------------------- | --------------------------------------------------------------------------------- |
| 单 execution 日志总量上限 | p4c-worker 在隔离库中持续产出直到预算耗尽，记录 `produced_through_seq` 与落盘字节 |
| 单 Machine 日志总量上限   | 同一 Worker 并发多个 execution，测宿主库增长与裁剪触发点                          |
| 宿主总量上限              | 长跑至磁盘阈值，记录 `available_from_seq` 推进与 `truncated` 出现时刻             |
| 单 exchange 实际可带帧数  | 终端报告满载时测 fence 与终端报告仍通过、帧被降级的边界                           |

## 错误码

`src/contracts/result.ts` 的 `APP_ERROR_CODES` 新增 6 个，`src/server/functions/domain-errors.ts` 登记固定文案（不透出路径、命令正文或 token）：

| code                                | 文案                                       |
| ----------------------------------- | ------------------------------------------ |
| `execution_log_gap`                 | 日志区段已被裁剪，请从新的可读起点重新读取 |
| `execution_log_cursor_stale`        | 日志游标已过期，请重新读取                 |
| `execution_log_unavailable`         | 日志尚不可用                               |
| `cancellation_not_found`            | 取消请求不存在                             |
| `cancellation_already_terminal`     | 该取消请求已有终态                         |
| `cancellation_delivery_unconfirmed` | 取消尚未送达，命令可能仍在运行             |

未在枚举登记的 code 仍退回 `conflict`；本单元只保证新增 6 个已登记，不改这条兜底行为。

## 破坏性升级的调用方修复

契约改名与扩列后，以下调用方在同一分支内改到能编译并保持既有语义，未改业务逻辑。

- `src/server/remote.ts`：`executionView` 输出新字段；`applyRemoteExchange` 的输出初值补 `logAcks: []` 与 `cancellations: []`；command 构造改用 `dispatchDeadlineAt` 并补 `runtimeDeadlineAt`、`maxRuntimeMs`、`runnerToken`；入队写 `dispatchDeadlineAt`。
- `src/server/lease.ts`：`expireExecutions` 改读 `row.dispatchDeadlineAt`。本单元不改它的归约逻辑（冻结设计第 3 条属 p4c-execution）。
- `src/worker/remote.ts`：`command.deadlineAt` 全部改读 `command.dispatchDeadlineAt`，仍按短操作语义执行；未实现运行上限、日志采集或取消。
- `src/components/machine/remote-execution-panel.tsx`：截止时间读 `execution.dispatchDeadlineAt`，文案不变。
- `src/dev/scenes/machine/lease-fixtures.ts`：演示 fixture 补新字段。
- 既有测试与 fixture：`deadlineAt` 批量改名，`ExecutionView` 字面量补新字段。

## 下游可直接使用的导出

```text
EXECUTION_LOG_STATES, EXECUTION_LOG_STREAMS, CANCELLATION_STATES,
CANCELLATION_SIGNAL_OUTCOMES, CANCELLATION_FAILURE_REASONS,
EXECUTION_LOG_FRAME_MAX_BYTES, EXECUTION_LOG_FRAMES_PER_EXCHANGE,
EXECUTION_LOG_READ_LIMIT_MAX_BYTES, CANCELLATION_INTENT_NAMESPACE
executionLogFrameSchema, executionRecoverySchema, executionCancelSchema,
executionCancelInputSchema, executionLogReadInputSchema,
executionLogReadViewSchema, executionCancellationViewSchema, executionViewSchema
ExecutionLogFrame, ExecutionRecovery, ExecutionCancel, ExecutionCancelInput,
ExecutionLogReadInput, ExecutionLogReadView, ExecutionCancellationView,
ExecutionLogState, CancellationState
ID_PREFIXES.cancellation ('cnl')
EXECUTION_ERROR_MESSAGES  （src/server/functions/domain-errors.ts）
```

## 验证

| 命令                                                | 结果                           |
| --------------------------------------------------- | ------------------------------ |
| `pnpm check`                                        | 见 contracts-implementation.md |
| `pnpm typecheck`                                    | 见 contracts-implementation.md |
| `pnpm test`                                         | 见 contracts-implementation.md |
| `bash scripts/verify/aa-execution-log-contracts.sh` | 见 contracts-implementation.md |
| P4b 六个门禁脚本                                    | 见 contracts-implementation.md |

## 未测量与待验证

- 容量数值（单 execution / 单 Machine / 宿主总量）全部待定，见「预算语义」表。
- 恢复归约的业务实现、日志写入、取消入队与读取、Worker 侧采集与预算分配均未实现，只交付 schema 与约束反证。
- 跨机网络、真机软键盘、真实 macOS Worker 长命令运行均未在本单元验证。
- 本单元未运行 Chromium、真实服务或新账号。
