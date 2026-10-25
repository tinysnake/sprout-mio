# P4b 分身持租与远端操作

P4b 已交付 Project × Machine 租约、以分身为 holder 的跨 run 持有、服务端授权代次核验、真实 macOS Worker 的 shell、文件与进程操作，以及 Chat、Machine 页面和 inspector 的同源事实呈现。首轮独立技术验收在 `b5c34db` 判定 PASS，第二轮技术复验在 `243fd53` 判定 PASS，三个安全返工点均有修复前后对照。coordinator 在带 Git 历史的独立 checkout 复跑 check、typecheck、260 条测试、应用和 Worker 构建及 30 个验收脚本，记录 `failed=0`。本次文档基线为含验证去重改动的 `d003b54`。

章节仍待 Human 明确体验确认，不能据技术 PASS 宣告章节完成。验证拓扑为同一台 macOS 上的真实服务、SQLite、Chromium、新账号与 Worker，跨机网络和真机软键盘未验证。同一分身持有多台 Machine 的组合有数据库、投影与演示证据，没有两台物理 Machine 的联合实测。Worker 永久失踪后的 fencing 没有强制推进路径，gate `p4b-fence-liveness` 仍 open。

本文件沿用 [P4a 结论](../p4a/summary.md) 的章节证据结构。P4a 的票据生命周期三组、root 派生路径模型、allow-http 逐 origin 授权、五秒自动刷新及断联不显示 shell 能力均沿用，回归入口是 `s-machine-contracts.sh`、`t-machine-worker.sh`、`u-machine-ui.sh`。P4c 及以后未启动。

## 交付范围

租约互斥单位是 Project × Machine。不同 Projects 可以同时持有同一物理 Machine 的独立租约，Sprout 查询与操作授权不泄露另一 Project 的租约或执行。holder 是 Agent 分身，run 结束、空闲和连接离线均不等于释放。申请、释放、交接、收回不自动终止进程或删除文件。

远端工具必须显式指定 Machine。宿主的 Pi 工具和 `sprout_status` 保留原行为。Worker 以运行用户权限执行操作，工作目录不构成安全边界，Sprout 不增加 OS 层项目隔离。P4b 提供单次执行状态与有界结果，没有交付 P4c 的日志游标、续读、取消或长命令恢复产品，也没有启动 P4d 的移除流程。

## 数据形状

[契约说明](contracts.md) 分开定义租约、授权代次、远端操作与结果，不向 `machine_connection` 或 `directory_observation` 混入执行状态。

| 表                      | 职责                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `machine_lease`         | 以 Project × Machine 为唯一键，保存当前 holder、代次、占用状态与 pending mutation。 |
| `lease_authorization`   | 保存各授权代次及其生效、撤销历史，供派发与结果身份核验。                            |
| `lease_mutation`        | 保存申请、释放、交接、收回的幂等请求与 pending、completed 收据。                    |
| `worker_exchange_frame` | 保存 Worker 会话内按序交换帧及语义指纹，支持同帧重试并拒绝异载荷重放。              |
| `remote_execution`      | 保存归属 Project、Machine、holder、授权代次的操作、派发身份、deadline 与执行状态。  |
| `execution_result`      | 保存 execution 对应的有界终态结果与截断事实，区别于执行请求。                       |
| `remote_tool_grant`     | 保存绑定 user、Project、Chat、instance、run 的短期私有 grant 的 hash 与撤销状态。   |

七表由新增迁移 [0009_hard_chameleon.sql](../../drizzle/0009_hard_chameleon.sql) 建立，未修改已合并迁移。复跑使用新的隔离 `DATABASE_URL`，不得删除共享业务数据，规则见 [迁移约定](../p1/conventions.md#数据库约束与迁移)。

## 功能交付证据

以下五项对应功能计划 P4b 的五个 checkbox，均已具备实现、脚本断言与反证。报告路径以 `/Users/snake/workspace/sprout-mio/orchestrate/sprout-mio-p4b/` 为根；这是编排 store，不随仓库文档提交。原始私有库、凭据和操作输出不属于可复制证据。

### 1. 申请、释放与互斥

勾选依据：`reports/contracts-implementation.md`、`reports/worker-implementation.md` 和 `reports/integration-implementation.md` 记录七表约束、租约事务与生产接入。`v-lease-contracts.sh` 的 N1、N2 绕过服务直接写 SQLite，拒绝同 key 第二份租约及非法授权组合，同时允许不同 Projects 共存。第二轮 `reports/acceptance-2/acc2-lease-shape.json` 记录重复申请 `lease_conflict`，直接 INSERT 被 `UNIQUE constraint failed: machine_lease.project_id, machine_lease.machine_id` 拒绝。

释放反证由 w 的 N6 与 z 的页面路径提供：在途未 drained 时先返回 pending，期间新操作被 `lease_fencing` 拒绝；只有真实 fence ack 后代次从 1 到 2。不能把请求受理当作释放完成。重跑 `bash scripts/verify/v-lease-contracts.sh`、`bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 2. 分身 holder、跨 run 与多机持有

勾选依据：`reports/worker-implementation.md`、`reports/ui-implementation.md` 和 `reports/integration-implementation.md`。第二轮 shape 探针中，同一 instance 对两条 Machine 身份各持一行，`instancesHeldByThisActor=2`。run 进入终态后仍为 `held`，generation=1 且 holder 相同。w 的 grantRevocation 记录 `leaseRetained=true`、generation=5；z 的 `run-ended-still-held.png` 由真实 Chat 路径验证 run 结束不释放。

反证：旧 run 的 grant 不能继续操作，返回 `remote_run_inactive` 或 `remote_grant_invalid`，而租约仍保留；另一分身不能据原 holder 空闲自行取得租约。多机组合没有两台物理 Machine 的联合实测，不据此宣称跨机通过。重跑 `bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 3. shell、文件、进程操作与授权

勾选依据：`reports/worker-implementation.md`、`reports/tools-implementation.md`、`reports/report-budget-implementation.md`。w 使用发行 Worker、真实 HTTP 与文件系统执行 shell，副作用计数为 1，重复提交、断线重连后仍为 1。x 的真实 runner 和 Worker 测试覆盖文件读写、进程列表与信号，z 在生产 Machine 页面核对真实 shell 与进程结果。

反证：w 的 N5、N6、N7、N12 及 z 的非 holder、旧代次请求均验证错误码和哨兵不存在，拒绝请求不入队。w 的在途执行最终为 `rejected` 而非 `succeeded`，同时 OS 进程仍存在、文件保留。准入时核对当前参与权和代次，不承诺持续监视或取消已经开始的 OS 副作用；单独撤销 run grant 的限制见安全边界。重跑 `bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/x-remote-tools.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 4. 宿主工具保留、远端目标明确

勾选依据：`reports/tools-implementation.md`、`reports/build-fix-implementation.md`、`reports/fixture-sync-implementation.md`。x 真实加载 `pi/sprout-extension.ts`，确认远端注册工具的必填 Machine 与私有身份注入。全量 a 的真实 Pi 调用仍返回原 `sprout_status` 结构，`src/extension/main.ts` 保留注册。

反证：x 的 N12 缺 Machine 被 `validation_failed` 拒绝，伪造 Project 身份被拒；w 对缺 Machine 的真实 HTTP 请求同样拒绝，目标文件不存在。宿主工具没有默认转向远端。重跑 `bash scripts/verify/a-base.sh`、`bash scripts/verify/x-remote-tools.sh`、`bash scripts/verify/w-worker-remote.sh`。

### 5. 跨 Project 独立与不可见

勾选依据：`reports/contracts-implementation.md`、`reports/quota-scope-implementation.md`、`reports/integration-implementation.md`。v 的 N2 与第二轮 shape 探针证明同一 Machine 有两条不同 Project 的 held 租约，双方 list 只见本 Project。F-3 修复后预算键也为 Project × Machine，A 满 64 条不再消耗 B 的槽位，两个 Project 各自第 65 条仍被拒绝。

反证：w 的 N7 对改成 B 的 projectId、只绑定 B 的 Machine 返回 `not_found`，私有哨兵不存在。z 的真实未登录、跨用户与浏览器跨 Project 读取反证均通过，quota-scope 测试另核对 B 读 A 的 executionId 为 `not_found`，过期清理不修改另一 Project。重跑 `bash scripts/verify/v-lease-contracts.sh`、`bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/z-lease-integration.sh`，以及 `pnpm exec vp test run tests/quota-scope.test.ts`。真实配额链路入口为 `node --import tsx tests/fixtures/quota-scope-live.ts`。

## UI 交付证据

以下三项对应 UI-P4b 的三个 checkbox。`reports/ui-implementation.md` 记录共享呈现与演示，`reports/integration-implementation.md` 记录真实查询接入，`reports/fencing-facts-implementation.md` 记录 fencing 返工与三页面实测。技术勾选不代表 Human 体验确认。

### 1. 租约、holder、申请释放与多机概要

y 的 18 组检查覆盖浅暗主题和 390、901、1199、1200、1440px，断言 holder 分组、同分身多机、申请 pending、成功和失败、明确收据以及释放后代次。反证包括另一个 Project 的租约不可见，fencing 普通 reclaim 被拒后仍保留 holder，不显示成功或空闲。

z 在真实服务、Worker、新账号及 Chromium 上执行 Chat 请求，读取生产 Machine 租约卡，点击释放并核对真实进程和文件保留。第二轮 `reports/acceptance-2/machine-held-light.png`、`machine-detail-lease.png` 与 `fencing-real-row-after-reclaim.png` 支持真实页面结论。多机组合仍以投影和演示覆盖。重跑 `bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 2. 远端目标与真实结果

y 断言宿主与指定 Machine 目标分开显示，操作结果及 unknown、截断不会冒充完整成功。z 的 `real remote shell and process result visible on production Machine page` 在真实页面检查执行列表与结果，再用 file_read 读取私有哨兵，仅在测试进程内断言内容。

反证：z 从 Chat 提交非 holder 与旧代次命令，核对真实 grant HTTP 拒绝、目标文件不存在且没有入队记录。w 的 missing Machine 反证防止隐式目标。第二轮对应 `machine-result-light.png`、`machine-detail-executions.png`、`mutation-failure-stale-generation.png`。结果截图只适用于不含敏感内容的验收数据，不复制真实业务输出。重跑 `bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 3. Chat、Machine 与 inspector 一致，run 结束保留占用

y 断言三处共用持租投影，run completed 仍显示 held，并区分 run 与租约。z 真实 Chat header、inspector 与 Machine 详情读取同一 holder，run 结束后仍 held，支持 URL 刷新、后退与前进，并覆盖浅暗主题及 390、900、1200px。

反证：z 以未登录、第二账号调用租约与执行 Fn，分别得到 `unauthorized`、`not_found`；浏览器改 Project 读取被拒。第二轮 `chat-inspector-light.png`、`chat-inspector-leases.png`、`run-ended-still-held.png`、`cross-user-denied.png` 对应这条路径。fencing 返工另有三页面 × 两主题 × 五宽度的 30 组真实页面检查，不把 pending 写成成功。重跑 `bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

## 安全边界与反证

| 边界                        | 直接反证与证据                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 授权代次失效                | w 在真实代次 3→4 后提交旧代次，得到 `lease_stale_generation`；`targetExistsBeforeReplay=false`、`targetExistsAfterReplay=false`。受控代理扣住真实帧并重放给同一 Worker，dispatcher 拒绝旧帧，哨兵仍不存在。见 `reports/acceptance-2/w-worker-remote-evidence.json` 与 `acc2-w-worker.log`。 |
| 撤权时尚未启动的操作        | w 的 N6 在 fence 关闸后拒绝 pending delivery，目标文件不存在。真实 release 先 pending，drain 后 generation 1→2，`inFlightState=rejected`，`processAliveAfterBump=true`、`filePreserved=true`。见同一 w evidence 的 N6。                                                                     |
| 跨 Project 借租约或 Machine | A 的 grant 改 Project 或操作 B-only Machine 得 `not_found`，`crossProjectSentinelExists=false`；B 的执行记录不可被 A 读取。见 w 的 N7、N12 及 z 的真实 HTTP/Fn 检查。                                                                                                                       |
| 未登录、跨用户              | z 对 `getLeaseFn`、`listProjectExecutionsFn`、`getExecutionFn`、`reclaimLeaseFn` 经真实 HTTP 分别验证 `unauthorized`、`not_found`。Agent HTTP 无凭据得 401 `remote_grant_invalid`，任何 Origin 得 403 `forbidden`。                                                                         |
| 非 holder                   | z 的 `browser Chat request -> real non-holder grant HTTP rejection and absent sentinel` 得 `lease_not_holder`，明确 `!existsSync(marker)`，该 requestId 不在执行列表。旧代次负例使用相同三重检查。见 `scripts/verify/z-lease-integration.sh` 的 `negativeCommand`。                         |

授权在服务端 Fn 和 `/api/remote/agent` 边界核对，UI 与 extension 不承担最终授权判断。新领域错误已登记到 `src/server/functions/domain-errors.ts`。结果报告同时核对 execution、Project、Machine、代次、session、seq 与 fingerprint；合法 Worker 仍属于可信执行端，Sprout 不能证明其报告的 OS 事实为真。

撤权必须区分租约 fence 与 run grant。租约 fence 关闭新调度并排空旧结果等待，drained 不是“所有 OS 进程退出”。已经启动的 shell、文件系统调用可能继续产生副作用。安全探测 F-4 还证明：单独撤销 run grant 会拒绝后续 HTTP 请求，但不会对已派发操作下发 fence，该操作可能继续并报告成功。第二轮 PASS 没有消除这项语义限制，不能据本章声称所有撤权路径都会中止在途副作用。有关产品语义仍交 coordinator 与 Human 处理，本单元不改授权行为。

## 体验后变更与安全返工

本章尚无 Human 体验确认记录。以下是实现与技术验收期间的返工，不冒称 Human 已确认。

F-1，`f11ec13`：原 Worker 按输入原始字节截断，非法 UTF-8 再编码或 JSON 转义后超出 wire 上限；多结果整批超预算及拒收还可能使 Worker 退出，进而永久 fencing。修复位于 Worker 生产和发送侧：按编码后字节截断，结果与 fence ack 共用完整 exchange 预算，过大或非法报告降级为明确失败并保留截断事实，明确拒收后 drain 重报，损坏 2xx 响应用原身份重试。服务端契约上限没有放宽。第二轮 12a 与 coordinator 对照记录：OLD stdout 196608 bytes、truncated=false、wire 非法，NEW 65535 bytes、truncated=true、wire 合法；整批 1578604→530012 bytes。见 `reports/report-budget-implementation.md`、`reports/acceptance-2/acc2-f1-{old,new}.json`、`/tmp/coord-f1-{old,new}.log`。

F-3，`39dca15`（回归测试 `ba2f30b`）：原服务端以 Machine 为键统计 64 条未终态执行，A 的队列会拒绝 B 的合法请求。修复在服务端预算查询加入 Project 条件，因为预算的所有者是服务端，UI 或 Worker 无法恢复被拒请求。第二轮 12b 与 coordinator 双向复现 OLD B=`too_many_requests`，NEW B=`admitted`、`queued`，`nonTerminalByProject=[64,1]`；每对上限仍为 64。`src/server/lease.ts` 的 drain 守卫未改。见 `reports/quota-scope-implementation.md`、`reports/acceptance-2/acc2-f3-{old,new}.json`、`/tmp/coord-f3-{old,new}.log`。

F-12，`064d517`：原“回收中”呈现掩盖无限等待，pending 表单还可能显示绿色“释放已确认”。修复在共享呈现侧如实显示“等待 Worker 确认”、等待起点与时长、原 holder、可验证的 pending 动作与代次，以及最多 100 条已加载执行中的不确定记录；不承诺有限时间完成。真实普通 reclaim 返回 `lease_fencing`，页面保留错误码与 requestId，不伪造强制入口。第二轮 12c 比较旧页面与当前真实 fencing 页面，unknown=1、进程文件仍在，重启 Worker 和普通 reclaim 均未强制推进。见 `reports/fencing-facts-implementation.md`、`reports/acceptance-2/fencing-real-page-{light,dark}-1440.png`、`fencing-real-row-after-reclaim.png`。UI 只能呈现事实，不能替服务端伪造 drain 或代次提升。

## 技术验收证据

| 层次                 | 版本、实际结果与证据                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实现与集成           | contracts `9001f8e`、migrate-callers `b4e204f`、worker `dc61189`、tools `46d9d17`（merge `b9ba470`）、build-fix `1651dcd`、UI `e8ec38c`（merge `1ffb40a`）、integration `c771250`、fixture-sync `b5c34db`、verify-fullgreen `6428b5c`，均为当前基线祖先。对应全部 `reports/*-implementation.md`。 |
| 首轮独立技术验收     | `b5c34db`，`reports/p4b-acceptance/acceptance.md`：11 项 PASS，含真实 Pi、Worker、服务、SQLite、Chromium。发现旧占位断言和构建产物顺序问题，后由 `6428b5c` 修复并全量复跑。                                                                                                                       |
| 第二轮技术复验       | `243fd53`，`reports/acceptance-2.md`：1–12 PASS，12a、12b、12c 均有修复前后对照，`reports/acceptance-2/` 保存 34 份证据。这是技术复验记录；模型独立性的调度限制另见 store 的 `decisions.tsv`，不据此增列 Human 确认。                                                                             |
| coordinator 本机复跑 | `/tmp/p4b-verify2` 带 Git 历史 checkout：check、typecheck、260 条测试、应用和 Worker build 通过，30 个脚本 `failed=0`；见 `local-verification.tsv`、`decisions.tsv` 和 `/tmp/p4b-m9-{check,test,fullverify}.log`。F-1、F-3 对照另由 coordinator 亲跑，结果与复验数字一致。                        |

第二轮全量验证里的 `l-docs`、`l-docs-probes` 两条失败来自 `git archive` 副本没有 `.git`，无法解析历史提交。相同 SHA 在带历史工作树里 `L_EXIT=0`、`LP_EXIT=0`，coordinator 的 30 脚本验证也为零失败，证据 `reports/acceptance-2/acc2-ldocs-git.log`。这两条是环境性假失败，不是产品缺陷，也不是下面本次勾选触发的门禁冲突。

本次文档收尾实际执行的检查单独记录，不替代上述运行版本的技术验收：

| 检查                                                                                                                                                              | 本次结果                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bash scripts/verify/f-docs.sh`                                                                                                                                   | 退出 0，内部链接与锚点检查通过。                                                            |
| `bash scripts/verify/l-docs.sh`                                                                                                                                   | 退出 1，仅有 P4b 功能五项、UI 三项的旧“必须未勾选”约束共 8 条失败。                         |
| `pnpm exec vp check`                                                                                                                                              | 退出 1，新 summary 格式已修正，仅剩启动时即存在、超出本单元可写范围的 `brief.md` 格式问题。 |
| `pnpm exec vp check --no-error-on-unmatched-pattern docs/p4b/summary.md docs/development-plan-functional.md docs/development-plan-ui.md docs/development-plan.md` | 退出 0；文档路径没有可 lint 的源码，允许空匹配，不把这项冒称为源码 lint。                   |
| `pnpm exec vp check --no-fmt`                                                                                                                                     | 退出 0，跳过上述既存格式阻塞后，实际源码 lint 检查通过。                                    |

日志为 `/tmp/p4b-closeout-f-docs.log`、`/tmp/p4b-closeout-l-docs.log`、`/tmp/p4b-closeout-vp-check.log`、`/tmp/p4b-closeout-vp-docs-final.log`、`/tmp/p4b-closeout-vp-no-fmt.log`。本次没有运行全量测试、构建、服务或浏览器。

## 已知限制与未闭合项

- `p4b-fence-liveness` 保持 open。Worker 已失联后卡在 fencing 的租约目前没有强制推进路径，只能等待原会话真实关闸确认。这是刻意保留的安全选择，尚待 Human 裁决，不是遗漏实现，也不能显示已释放或空闲。
- 同 UID 进程可被有效 holder 通过合法 shell 或 `process_signal KILL` 终止，Worker 自身也在其权限范围内。F-2 仍可导致永久 fencing。工作目录不是沙箱，物理 Machine 上的文件、进程、端口和资源竞争由 Project organization 负责。
- 外部 SIGKILL、宿主断电、永久失联或原会话丢失后，新 Worker 不能代替旧 delivery 证明 drained，不能恢复原会话；重新 open 或 staleAfter 到期都不等于旧操作已排空。
- 永久阻塞的系统调用不能提前声明 drained。持续拒收最小合法报告、身份冲突或网络持续不可达也没有有限时间完成保证。租约 fence 与单独 grant 撤销的在途限制见安全边界，F-4 未被本轮返工消除。
- 预算按 Project × Machine 独立，不承诺同一物理 Worker 的队列公平性。配额专用真实夹具为验证 B 的最终执行把轮询暂缩至 50ms；原节奏下已观察到 B 获准后因队列等待触发 deadline。常规真实主路径另由 w、z 覆盖。
- grant 15 分钟过期且不续期，慢模型可能导致合法 holder 的旧 grant 失效，租约仍 held。认证 Worker 可谎报自己收到的执行结果，结果协议不是对宿主的可信计算证明。
- 安全探测观察到命令与有界结果落入 SQLite，文件权限受运行环境 umask 与目录权限影响，样本库为 644；Pi 转录也可能保存工具参数和结果。本章不承诺本地多用户隔离。票据、secret、cookie、私有库和远程输出正文不得复制到报告、日志与截图。
- fencing 页面只统计最多 100 条已加载执行，`ExecutionView` 没有 `drainedAt`，零条未知结果不能证明历史全部排空。900px、1200px 布局和浅暗主题有 Chromium 验证，真机软键盘及跨机网络未验证。
- **文档门禁未闭合**：基线 `d003b54` 的 `scripts/verify/l-docs.sh:244–246`、`:276–279` 硬性要求 P4b 功能五项和 UI 三项未勾选，`l-docs-probes.sh:93–95` 依赖该旧规则。本次据证据勾选实际触发 8 条失败。脚本不在本单元可写范围，未修改，也不为通过门禁撤销真实进度。该冲突阻塞本次文档的全绿检查，需 coordinator 分派门禁更新后复跑，不能沿用先前的全量通过声称本提交全绿。启动时已有的 `brief.md` 格式问题另使完整 `vp check` 退出 1；本单元未修改该文件。

## 重跑清单

在带完整 Git 历史、独占写入的隔离 checkout 中使用 `pnpm verify` 跑完整验证。该命令包括全量测试，不再另外追加 `pnpm test`。完整验证会清理自己的验证产物，不在活跃 Worker checkout 运行。当前文档门禁冲突解决前预计 l-docs 不通过。本单元没有启动服务、浏览器或完整 verify。

| 入口                                                                                                                           | 对应范围                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `bash scripts/verify/v-lease-contracts.sh`                                                                                     | 七表、隔离迁移、SQL 反证与 wire schema。                                                               |
| `bash scripts/verify/w-worker-remote.sh`                                                                                       | 真实 macOS Worker、HTTP 授权、旧帧、撤权在途、哨兵与输出预算。                                         |
| `bash scripts/verify/x-remote-tools.sh`                                                                                        | 真实 Pi extension 注册、宿主保留、显式 Machine、私有 grant 注入。                                      |
| `bash scripts/verify/y-lease-ui.sh`                                                                                            | 共享演示、浅暗与五宽度、Project 隔离、pending 收据和 fencing 文案。                                    |
| `bash scripts/verify/z-lease-integration.sh`                                                                                   | Chat 到真实 Worker 的生产接入、三处一致、权限反证与进程文件保留。                                      |
| `bash scripts/verify/a-base.sh`                                                                                                | 真实 Pi `sprout_status` 原行为。                                                                       |
| `bash scripts/verify/s-machine-contracts.sh`、`bash scripts/verify/t-machine-worker.sh`、`bash scripts/verify/u-machine-ui.sh` | P4a 契约、连接、票据、root、origin、刷新及能力回归；u 使用独立空闲 `BASE_URL` 避免既存 3120 端口冲突。 |
| `pnpm exec vp test run tests/worker-report-budget.test.ts tests/quota-scope.test.ts tests/lease-view.test.ts`                  | 三项安全返工的定向回归。                                                                               |
| `node --import tsx tests/fixtures/quota-scope-live.ts`                                                                         | 隔离 SQLite、真实服务与 Worker 的双 Project 预算及私有哨兵。                                           |
| `bash scripts/verify/f-docs.sh`、`bash scripts/verify/l-docs.sh`、`pnpm exec vp check`                                         | 本次文档链接、计划与格式检查；l-docs 的旧勾选约束见未闭合项。                                          |

脚本产物默认写各自 `.verify/` 子目录，复跑后读取当次结果，不将启动命令返回当成执行成功。独立端口、隔离库与 state-dir 由对应夹具管理，localhost 请求绕过代理，禁止触碰 Human 正在使用的 :3000。

## Human 体验确认

待 Human 明确确认。当前没有 P4b 的确认版本，不勾选总计划 Human 条目。技术 PASS、截图或沉默都不算确认。

Human 的建议检查点：

1. **Project 内 Chat 页面**：请求分身使用指定 Machine，核对宿主与远端目标、holder 和真实结果；run 结束后仍显示持有，下一轮同分身接续，再显式释放。
2. **Machine 详情页（明确 Project 上下文）**：核对租约、代次、holder、申请释放收据与操作结果。遇到 fencing，核对等待对象、时长、pending 动作和未知执行；普通收回报错后仍等待，没有成功或空闲假象。
3. **Chat inspector 的 Machine 租约区**：与 Chat header、Machine 详情比对同一 holder、run 与租约，切换 Project 不出现另一 Project 工作信息，浅暗主题和窄屏下仍可读。

体验后由 coordinator 记录明确确认版本及反馈。`p4b-fence-liveness` 的产品裁决单独记录，不能用体验确认替代该 gate 的决定。
