# P4c 章节结论：长命令与不确定结果

P4c 把远端的「一次操作」升级成可反复查询的「一次执行」：执行有稳定 ID 与请求 ID，日志是带游标的追加流，结果只在宿主亲眼看到退出（或超时、取消）后才落终态，取消是独立建模的事实而不是状态改写。集成线把宿主侧读取与取消接到 Web 与工具面，并用真实 macOS Worker 长命令、真实服务、真实 SQLite 与真实 Chromium 验证了跨 run、断连与重启后的查询和取消。

## 交付范围

- 契约与数据形状：`docs/p4c/contracts.md`，对应提交 `fa5a40c`。执行、日志帧、取消三张表各自建模，取消不与执行状态混写。
- 宿主与 Worker：执行恢复归约、日志帧入账与确认、取消下发与归约（`ca63613`）；下发窗口只约束准入、游标绑定执行、日志前缀保留裁剪、waitMs 快照不冒充终态（`3538145`、`f807af8`、`1e85d93`、`d268969`，merge `356233d`）。
- 工具面：`sprout_remote_execution_cancel` 与 `sprout_remote_execution_log`（`95b7bd3`）。
- 执行详情与日志 UI：`src/components/machine/presentation.ts`、`execution-log.tsx`、`execution-cancel.tsx`、`remote-execution-panel.tsx`（`7f8a9d0`）。
- 集成接入：服务端读取与取消 Fn、人类取消的 actor 模型（`818a134`，merge `30e1c5c`）；Web 三处消费方接线（`134e443`，merge `2068d29`）；真实长命令端到端场景（`1d26a24`，merge `416630c`）。

## 数据形状

| 形状     | 建模                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------- |
| 执行     | `remote_execution` 行，状态机 `pending → dispatched → running →` 终态，终态只在收到 durable result 时落   |
| 请求 ID  | 每次提交一个 `req_`，重试复用同一 ID，幂等键为「同请求 ID 与同操作摘要」                                  |
| 日志     | `execution_log_frame` 追加帧，`produced/acknowledged/available_from` 三个水位决定完整性                   |
| 日志读取 | `{ executionId, cursor: { executionId, nextSequence }, limitBytes }`，游标自带执行归属                    |
| 保留     | `EXECUTION_LOG_RETAIN_BYTES = 1048576` 与 `EXECUTION_LOG_RETAIN_FRAMES = 512` 先到者，只裁前缀            |
| 取消     | `execution_cancellation` 独立行，`actor_kind` 为 `agent` 或 `human`，幂等键 `cancel:<kind>:<actor>:<req>` |
| 运行时长 | 工具面只有 `waitMs`（观察窗口），没有运行上限；寿命由真实退出、显式取消或宿主重启决定                     |

## 功能交付证据

### 1. 稳定请求 ID、执行 ID、日志游标、状态、退出结果和显式取消

契约冻结了提交、读取、日志与取消四个形状，执行视图、日志读视图与取消视图都在 `src/contracts/remote.ts` 有 schema 与不变量校验；服务端 `readExecutionLog`、`cancelExecution`、`enqueueCancellation` 与 Worker 侧采集、取消下发、恢复归约由 `ca63613` 实现，取消的人类入口在 `818a134` 里与分身入口共用同一张表。

- 实现提交 `fa5a40c`、`ca63613`、`818a134`。
- 反证：终态拒绝取消（`cancellation_already_terminal`）、旧授权代次与非 holder 拒绝、跨 Project 与跨用户一律 `not_found`。
- 重跑：`bash scripts/verify/aa-execution-log-contracts.sh`、`bash scripts/verify/af-execution-cancel-authority.sh`。

### 2. 响应丢失后的重复提交不重复启动已确认的同一命令

同一请求 ID 与同一操作摘要的第二次提交返回同一条执行，不再派生工作；并发入口用唯一索引挡在写入处，重复提交读到既有行而不是新建。

- 实现提交 `ca63613`。
- 反证：真实长命令下 `pgrep` 计数保持 1，`dispatchSeq` 不前进。
- 重跑：`bash scripts/verify/ah-execution-live-e2e.sh`。

### 3. run 结束与宿主连接中断不终止命令，持有者重连后继续查询

断联只关闭准入与本次投递，已经开始执行的子进程不接收信号；终态报告留在 Worker 的 durable 上行里，重连后补送。日志读取权威在宿主侧，所以 Worker 离线时当前持有者仍能读到已确认前缀并看到运行状态。

- 实现提交 `416630c`、`f807af8`。
- 反证：断连后进程仍存活、重连后同一 `executionId` 续读到退出结果；断连期间的日志不留空洞假象。
- 重跑：`bash scripts/verify/ah-execution-live-e2e.sh`、`bash scripts/verify/ac-execution-recovery-log.sh`。

### 4. 按 P0 恢复范围验证宿主、Worker 和 Machine 重启，未知结果不重跑

宿主重启按 durable 事实归约：执行仍在则继续，进程不在而结果未到则落 `unknown`；Worker 重启让进行中的执行落 `unknown/worker_lost`，原命令继续运行也不重跑；Machine 上的租约与执行读取关系保持。任何 `unknown` 都不提供隐式重跑。

- 实现提交 `ca63613`、`356233d`。
- 反证：三类重启前后同一执行的可查询性、`state='unknown'` 与 `failureReason` 的对应、页面与工具面均无重跑动作。
- 重跑：`bash scripts/verify/ac-execution-recovery-log.sh`、`bash scripts/verify/ah-execution-live-e2e.sh`。

### 5. 固定日志和结果保留规则，达到限制时明确告知

日志按字节与帧数双阈值裁前缀，裁剪推进 `available_from` 并把状态置为 `truncated`，读取侧返回 `meta.truncated` 与 `availableFromSequence`；游标落在已裁剪区时报 `execution_log_gap`，跨执行复用游标报 `execution_log_cursor_stale`，都不静默补成「完整」。

- 实现提交 `f807af8`、`d268969`。
- 反证：裁剪后 `logState='truncated'`、缺口与陈旧游标都是显式错误码而不是空日志。
- 重跑：`bash scripts/verify/ah-execution-live-e2e.sh`、`bash scripts/verify/ae-remote-tools-cancel-log.sh`。

## UI 交付证据

### 6. 执行详情、运行状态、日志读取、退出结果和取消反馈的设计及演示

执行卡片并列展示下发窗口与运行上限两条事实，日志查看器按游标续读并区分 `none/partial/full/gap/truncated`，取消控件有六态且送达前不显示已停止。演示场景 `src/dev/scenes/machine/executions.tsx` 用 fixture 日志复现这些状态。

- 实现提交 `7f8a9d0`。
- 重跑：`bash scripts/verify/ad-execution-log-ui.sh`。

### 7. 日志续读、保留限制、断线、重连与结果未知的呈现，明确信息是否完整

`isIncompleteLogState` 决定「不完整」提示；连接状态来自真实列表读取与浏览器在线状态，不硬编码；断线时读取位点不前进，重连后从本地游标继续；`unknown` 与 `timed_out` 显示不可重跑的说明。

- 实现提交 `134e443`。
- 重跑：`bash scripts/verify/ag-execution-wiring-ui.sh`、`bash scripts/verify/ad-execution-log-ui.sh`。

### 8. 保留稳定 execution 定位，页面恢复后可继续查看既有执行

执行列表按执行主键定位，刷新页面后重新从服务端取同一批执行与取消事实，合并规则按推进程度取新，不会把本地 `requested` 快照覆盖服务端的 `delivered`；取消后不改写执行终态，`unknown` 上没有任何隐式重跑入口。

- 实现提交 `134e443`。
- 反证：刷新后同一 `executionId` 仍可展开、取消事实存活、另一用户读同一执行得到 `not_found`。
- 重跑：`bash scripts/verify/ag-execution-wiring-ui.sh`。

## 验证拓扑

真机 macOS、真实服务进程、独立 SQLite 文件、真实 Chromium 与新建账号，Worker 用真实安装产物；同一台机器内完成，跨机网络与真机软键盘未验证。集成单元在独立 worktree 内各自重跑静态检查、单元测试与所属门禁，coordinator 在合入前于同一 worktree 复跑全部门禁。

## 技术验收证据

独立技术验收由未参与实现的模型家族执行，被验对象为集成线收口提交，逐条从计划原文重推导并给出 PASS/FAIL/UNVERIFIED，报告见 `orchestrate/sprout-mio-p4c/reports/acceptance.md`。

- 验收提交 `356233d`。
- 重跑：`bash scripts/verify/ah-execution-live-e2e.sh`。

## Human 体验确认

Human 尚未亲自体验 P4c 交付形状，本章确认结论待 Human 给出。
