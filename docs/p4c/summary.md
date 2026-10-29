# P4c 章节结论：长命令与不确定结果

P4c 把远端的「一次操作」升级成可反复查询的「一次执行」：执行有稳定 ID 与请求 ID，日志是带游标的追加流，结果只在宿主亲眼看到退出（或超时、取消）后才落终态，取消是独立建模的事实而不是状态改写。集成线把宿主侧读取与取消接到 Web 与工具面，并用真实 macOS Worker 长命令、真实服务、真实 SQLite 与真实 Chromium 验证了跨 run、断连与重启后的查询和取消。

## 交付范围

- 契约与数据形状：`docs/p4c/contracts.md`，对应提交 `fa5a40c`。执行、日志帧、取消三张表各自建模，取消不与执行状态混写。
- 宿主与 Worker：执行恢复归约、日志帧入账与确认、取消下发与归约（`ca63613`）；下发窗口只约束准入、游标绑定执行、日志前缀保留裁剪、waitMs 快照不冒充终态（`3538145`、`f807af8`、`1e85d93`、`d268969`，merge `356233d`）。
- 工具面：`sprout_remote_execution_cancel` 与 `sprout_remote_execution_log`（`95b7bd3`）。
- 执行详情与日志 UI：`src/components/machine/presentation.ts`、`execution-log.tsx`、`execution-cancel.tsx`、`remote-execution-panel.tsx`（`7f8a9d0`）。
- 集成接入：服务端读取与取消 Fn、人类取消的 actor 模型（`818a134`，merge `30e1c5c`）；Web 三处消费方接线（`134e443`，merge `2068d29`）；真实长命令端到端场景（`1d26a24`，merge `416630c`）。
- 集成后按独立验收返工：非 holder 读取围栏、分身取消的代次比较与确认窗口（`bf31cc3`）；runner 第三层恢复权威与 12 格恢复矩阵（`16f17aa`、`de506de`）；取消幂等重放的通道核对、runner 独立托管命令组（`748ec9d`、`effdcd8`，merge `0253ca0`）；日志完整性只由 Worker 的封口事实支撑（`e00e991`，merge `d028aa1`）。
- Human 评审后的两项修正：远端操作区改为按机器的计数摘要，只有长时间占用租约的执行才给取消入口（`4d7c915`、`981882d`）；取消终止归因为 `failed` + `cancelled`，与真正的撤权分开（`5528dee`、`42a5c13`、`5b31dba`，迁移 `0019`）。
- 迁移入口：`pnpm db:migrate` 走 `src/db/migrate.ts`，在连接级关闭外键后再跑 `drizzle-kit` 的迁移并校验 `foreign_key_check`；有数据的老库升级由 `tests/migration-rebuild.test.ts` 守着（`e2de94a`）。
- 数据一致性：机器缺少入网凭据行时列表按「待配对」呈现，重新登记抛 `MachineError`，不再崩成 `internal`（`a19112e`）。

## 数据形状

| 形状     | 建模                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| 执行     | `remote_execution` 行，状态机 `pending → dispatched → running →` 终态，终态只在收到 durable result 时落    |
| 请求 ID  | 每次提交一个 `req_`，重试复用同一 ID，幂等键为「同请求 ID 与同操作摘要」                                   |
| 日志     | `execution_log_frame` 追加帧，`produced/acknowledged/available_from` 三个水位加 `log_sealed` 决定完整性    |
| 日志读取 | `{ executionId, cursor: { executionId, nextSequence }, limitBytes }`，游标自带执行归属                     |
| 保留     | `EXECUTION_LOG_RETAIN_BYTES = 1048576` 与 `EXECUTION_LOG_RETAIN_FRAMES = 512` 先到者，只裁前缀             |
| 取消     | `execution_cancellation` 独立行，`actor_kind` 为 `agent` 或 `human`，幂等键 `cancel:<kind>:<actor>:<req>`  |
| 取消归因 | 执行仍落终态 `failed`，`failure_reason='cancelled'` 表示按请求终止；`authorization_revoked` 只表示真的撤权 |
| 恢复     | 三层权威：宿主意图行、Worker `claim.json`、runner 的 `result.json`；没有 durable result 就不确认退出       |
| 运行时长 | 工具面只有 `waitMs`（观察窗口），没有运行上限；寿命由真实退出、显式取消或宿主重启决定                      |

## 功能交付证据

### 1. 稳定请求 ID、执行 ID、日志游标、状态、退出结果和显式取消

契约冻结了提交、读取、日志与取消四个形状，执行视图、日志读视图与取消视图都在 `src/contracts/remote.ts` 有 schema 与不变量校验；服务端 `readExecutionLog`、`cancelExecution`、`enqueueCancellation` 与 Worker 侧采集、取消下发、恢复归约由 `ca63613` 实现，取消的人类入口在 `818a134` 里与分身入口共用同一张表。

- 实现提交 `fa5a40c`、`ca63613`、`818a134`、`bf31cc3`、`748ec9d`、`5528dee`、`42a5c13`。
- 反证：终态拒绝取消（`cancellation_already_terminal`）、旧授权代次与非 holder 拒绝（`lease_stale_generation`、`lease_not_holder`）、跨 Project 与跨用户一律 `not_found`、复用同一 requestId 但声明错代次仍被拒且不落行。
- 重跑：`bash scripts/verify/aa-execution-log-contracts.sh`、`bash scripts/verify/af-execution-cancel-authority.sh`、`bash scripts/verify/ai-execution-accept-fixes.sh`、`bash scripts/verify/ak-execution-accept-fixes-2.sh`。

### 2. 响应丢失后的重复提交不重复启动已确认的同一命令

同一请求 ID 与同一操作摘要的第二次提交返回同一条执行，不再派生工作；并发入口用唯一索引挡在写入处，重复提交读到既有行而不是新建。

- 实现提交 `ca63613`。
- 反证：真实长命令下 `pgrep` 计数保持 1，`dispatchSeq` 不前进。
- 重跑：`bash scripts/verify/ah-execution-live-e2e.sh`。

### 3. run 结束与宿主连接中断不终止命令，持有者重连后继续查询

断联只关闭准入与本次投递，已经开始执行的子进程不接收信号；终态报告留在 Worker 的 durable 上行里，重连后补送。日志读取权威在宿主侧，所以 Worker 离线时当前持有者仍能读到已确认前缀并看到运行状态。

- 实现提交 `416630c`、`f807af8`、`3538145`。
- 反证：断连后进程仍存活、重连后同一 `executionId` 续读到退出结果；命令跨过下发窗口后仍继续记录与取消；断连期间的日志不留空洞假象。
- 重跑：`bash scripts/verify/ah-execution-live-e2e.sh`、`bash scripts/verify/ac-execution-recovery-log.sh`。

### 4. 按 P0 恢复范围验证宿主、Worker 和 Machine 重启，未知结果不重跑

恢复有三层权威：宿主侧的意图行、Worker 的 `claim.json`、runner 落盘的 `result.json`。只有第三层真的写下退出事实，执行才进 `exited_observed`；runner 也一起消失时才落 `unknown` 并带原因，同时说明原命令继续运行也不重跑。宿主不再因为连接丢失就把进行中的执行改写成 `unknown`，而是在新连接代次的宽限内等真实报告。

- 实现提交 `16f17aa`、`de506de`。
- 反证：P0 承诺的 12 格（本机断连/重启、Worker 重启、Machine 重启各短长两档）逐格断言状态与页面一致，`unknown` 一定带 `recovery_reason`，页面与工具面都没有重跑动作；命令杀掉自己的 runner 才得到 `exit_not_observed`。
- 重跑：`bash scripts/verify/aj-recovery-matrix.sh`、`bash scripts/verify/al-execution-exit-custody.sh`、`bash scripts/verify/ah-execution-live-e2e.sh`。

### 5. 固定日志和结果保留规则，达到限制时明确告知

日志按字节与帧数双阈值裁前缀，裁剪推进 `available_from` 并把状态置为 `truncated`；游标落在已裁剪区报 `execution_log_gap`，跨执行复用游标报 `execution_log_cursor_stale`。完整性只认 Worker 的封口事实：`log_state='full'` 需要 Worker 声明该执行不再产帧、且已确认前缀覆盖全部已产出位点；终态结果 ACK 不等于日志交代完毕，未送达的帧留在 outbox 继续补送。

- 实现提交 `f807af8`、`d268969`、`e00e991`。
- 反证：快速大输出后冻结 Worker 时宿主只有连续前缀也不得宣称完整，恢复补送后按预算变 `truncated`；伪造封口但位点高于已确认前缀仍是 `partial`。
- 重跑：`bash scripts/verify/am-execution-log-honesty.sh`、`bash scripts/verify/ak-execution-accept-fixes-2.sh`、`bash scripts/verify/ae-remote-tools-cancel-log.sh`。

## UI 交付证据

### 6. 执行详情、运行状态、日志读取、退出结果和取消反馈的设计及演示

Human 评审后远端操作区改成按机器汇总的计数视图：默认每台机器一行，给出请求总数与各状态计数、分段条与图例，零值状态不出现；只有仍占用机器且跑得过久的执行才进入「需要处理」并给出取消入口；执行卡片、日志查看器、退出结果与取消六态收进「调试详情」抽屉。日志查看器按游标续读并区分 `none/partial/full/gap/truncated`，取消控件送达前不显示已停止。演示场景 `src/dev/scenes/machine/executions.tsx` 与 `src/dev/scenes/machine/lease-fixtures.ts` 用 fixture 复现这些状态，含长占用与租约已释放两条事实。

- 实现提交 `7f8a9d0`、`4d7c915`、`981882d`、`89e209f`、`5b31dba`。
- 反证：默认层没有执行卡片；租约已释放的执行不给取消按钮，因为那时取消发不到 Worker；`ad` 的「不提供隐式重跑」断言收窄为只认重跑原命令的措辞，不把「重试取消」当成重跑。
- 重跑：`bash scripts/verify/ad-execution-log-ui.sh`。

### 7. 日志续读、保留限制、断线、重连与结果未知的呈现，明确信息是否完整

`isIncompleteLogState` 决定「不完整」提示；连接状态来自真实列表读取与浏览器在线状态，不硬编码；断线时读取位点不前进，重连后从本地游标继续；`unknown` 与 `timed_out` 显示不可重跑的说明。

- 实现提交 `134e443`、`e00e991`、`4d7c915`。
- 反证：Worker 还有未确认产出时页面显示「日志不完整」，封口且全部确认后才显示「日志完整」；断开网络后读取位点不前进。
- 重跑：`bash scripts/verify/ag-execution-wiring-ui.sh`、`bash scripts/verify/ad-execution-log-ui.sh`、`bash scripts/verify/am-execution-log-honesty.sh`。

### 8. 保留稳定 execution 定位，页面恢复后可继续查看既有执行

执行列表按执行主键定位，刷新页面后重新从服务端取同一批执行与取消事实，合并规则按推进程度取新，不会把本地 `requested` 快照覆盖服务端的 `delivered`；取消后不改写执行终态，`unknown` 上没有任何隐式重跑入口。

- 实现提交 `134e443`、`4d7c915`。
- 反证：刷新后同一 `executionId` 仍可展开、取消事实存活、另一用户读同一执行得到 `not_found`。
- 重跑：`bash scripts/verify/ag-execution-wiring-ui.sh`。

## 验证拓扑

真机 macOS、真实服务进程、独立 SQLite 文件、真实 Chromium 与新建账号，Worker 用真实安装产物；同一台机器内完成，跨机网络与真机软键盘未验证。集成单元在独立 worktree 内各自重跑静态检查、单元测试与所属门禁，coordinator 在合入前于同一 worktree 复跑全部门禁。

## 技术验收证据

独立技术验收由未参与实现的模型家族（`magpie/codex/gpt-6.1-sol`）执行，被验对象为集成线与返工后的收口提交，逐条从计划原文重推导并给出 PASS/FAIL/UNVERIFIED。五轮记录依次是 `orchestrate/sprout-mio-p4c/reports/acceptance.md`、`acceptance-2.md`、`acceptance-3.md`、`acceptance-4.md`、`acceptance-5.md`；前四轮的 FAIL 项（非 holder 读取、分身取消代次、取消确认窗口、P0 6 格退化、取消幂等重放、日志提前宣称完整）都已返工并被下一轮独立复验。

第五轮在 `d028aa1` 判定 **PASS**（限技术验收范围）：功能 P4c 五项、UI-P4c 三项与 I-P4c 三项技术就绪判据全通过；隔离 checkout 内完整 `pnpm verify` 退出 0、50 个脚本 0 失败（runner 1381.049 秒），P4c 的 `aa`–`am` 十三个门禁独立复跑全 0；自编真实请求与真实 Chromium 探针退出 0（140.499 秒），增强恢复矩阵 12 格全通过（189.440 秒）；前四轮九项问题逐项复验 PASS；Human 项保持 UNVERIFIED。证据目录 `/tmp/p4c-acceptance5-evidence-20261028T083545Z/`。第四轮唯一阻塞是 P4a 范围的 `y-mcp-worker.sh` 首个 MCP 请求 20 秒超时，coordinator 在隔离 checkout 复跑该脚本 5 次、第五轮验收者复跑整轮完整验证，均 0 失败，记为偶发。

- 验收提交 `d028aa1`。
- 重跑：`bash scripts/verify/aj-recovery-matrix.sh`、`bash scripts/verify/am-execution-log-honesty.sh`、`bash scripts/verify/ah-execution-live-e2e.sh`、`bash scripts/verify/af-execution-cancel-authority.sh`。

## 已知限制

- 第五轮验收记下的两条日志读取可用性限制已修复（`9e2e91b`）：续读按钮改由服务端 `hasMore`（是否仍存着更大的帧）驱动，产水位高于已落库帧时不再给出转不动的按钮；不带游标的读取从 `availableFromSequence` 起，裁剪过的执行第一次点「读取日志」就能读到，显式早于可读起点的游标仍报 `execution_log_gap`。真实边界断言见 `tests/fixtures/execution-recovery.ts`，门禁 `ac`、`ae`、`ah` 与 UI 门禁 `ad` 复跑通过。
- 未验证：跨机网络与网络分区、真机软键盘与触控、物理断电与文件系统掉电（以 runner 与命令进程组消失模拟 Machine 重启）、长时间容量与多 Machine 极限负载、像素级视觉评审。
- Worker 运行时长默认无上限，只有 `waitMs` 观察窗口；寿命由真实退出、显式取消或宿主重启决定。
- 表重建类迁移在事务内无法自行关闭外键，依赖调用方以连接级 `PRAGMA foreign_keys = OFF` 进入；`pnpm db:migrate` 已改为这个入口，直接用 `drizzle-kit migrate` 升级有数据的老库会失败。

## Human 体验确认

Human 于 2026-10-28 按 human-review 流程亲自操作真实页面，并明确回复评审通过。评审对象是远程执行所在的机器页面与本机真实 Worker 上的取消链路。

- 确认记录：Human 亲自体验确认通过，版本 `981882d`
- 复验记录：Human 于 2026-10-29 在同一预览里复验取消归因、迁移入口与缺凭据机器的呈现，回复验收通过，版本 `a19112e`
- 评审后的形状修正已并入 main：计数摘要与取消入口门槛（`4d7c915`、`981882d`）、取消归因（`786f9e9`、`a2dbd02`）、日志续读与裁剪后读取（`9e2e91b`）
- 体验环境：独立 SQLite 评审库、独立 dev server（`PORT=3100`）、真实 macOS Worker、真实 Chromium 页面，会话由 `scripts/human-review` 启动
- Human 认可的形状：默认只显示每台机器的请求总数与各状态计数，只有挂起且占用机器的执行才出现取消入口，执行详情与日志收在调试入口之后
- Human 在评审中提出的两项要求已实现：远端操作区改为按机器的计数摘要（`4d7c915`），只有长时间占用租约的执行才提供取消入口（`981882d`）
- 评审暴露的问题：取消成功送达后执行被报成「结果未知」且原因写作「授权已被撤回」，属终止原因归因缺陷，已由 `786f9e9`（迁移 `0019`、`failure_reason='cancelled'`）与 `a2dbd02`（卡片说明不再说「执行失败」）修复，并在同一评审库上实测：取消后摘要是「已取消 1」，卡片写「执行已按取消请求终止。」
- 复验暴露的问题：机器缺少入网凭据行时整页崩溃成 `internal`，已由 `a19112e` 修复为「待配对」呈现，并由 `tests/machine-credential-gap.test.ts` 与真实页面复验；评审时看到的租约页 `not_found` 是我用 sqlite3 命令行删数据留下悬空 `project_member` 造成的种子错误，产品路径在连接级外键下无法产生，不改行为，记录在编排记录的 decisions
