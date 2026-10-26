# P4b 分身持租与远端操作

P4b 已交付 Project × Machine 租约、以分身为 holder 的跨 run 持有、服务端授权代次核验、真实 macOS Worker 的 shell、文件与进程操作，以及 Chat、Machine 页面和 inspector 的同源事实呈现。首轮独立技术验收在 `b5c34db` 判定 PASS，第二轮技术复验在 `243fd53` 判定 PASS，三个安全返工点均有修复前后对照。coordinator 在带 Git 历史的独立 checkout 复跑 check、typecheck、260 条测试、应用和 Worker 构建及 30 个验收脚本，记录 `failed=0`（该轮基线为含验证去重改动的 `d003b54`）。两轮之后同章又合入四批能力：Human 强制收回 `c42bae1`、Chat 标题 `5c8dfa4`（merge `147193b`）、页面信息架构返工 `5ade997`（merge `e28a149`）与租约收据修复 `5869bf3`/`dd3fa80`/`8ffa7e6`，见下文「体验后变更与安全返工」及两个「体验后」小节。刷新后的文档基线是 `8ffa7e6`：该提交上 `pnpm test` 为 287 条、38 个文件（本单元实跑），`bash scripts/verify.sh` 为 30 个脚本 `failed=0`（coordinator 在该 SHA 上复跑，见 store 的 `decisions.tsv`），`scripts/verify/l-docs.sh` 与 `scripts/verify/l-docs-probes.sh` 均退出 0。第三轮独立技术验收因行为已变（强制收回、标题、收据语义）而重新派发，写入本文件时仍在进行中，尚未有结论。

Human 已于 `c6653f4` 亲自体验并确认通过；该版本与交付基线的可见界面一致。验证拓扑为同一台 macOS 上的真实服务、SQLite、Chromium、新账号与 Worker，跨机网络和真机软键盘未验证。同一分身持有多台 Machine 的组合有数据库、投影与演示证据，没有两台物理 Machine 的联合实测。Worker 永久失踪后的 fencing 已由 Human 裁决为 B 并实现：Human 可用独立的强制收回命令越过等待，但页面与文档均不得因此声称旧操作已排空；gate `p4b-fence-liveness` 已闭合，代价见「已知限制与未闭合项」。

本文件沿用 [P4a 结论](../p4a/summary.md) 的章节证据结构。P4a 的票据生命周期三组、root 派生路径模型、allow-http 逐 origin 授权、五秒自动刷新及断联不显示 shell 能力均沿用，回归入口是 `s-machine-contracts.sh`、`t-machine-worker.sh`、`u-machine-ui.sh`。P4c 及以后未启动。

## 交付范围

租约互斥单位是 Project × Machine。不同 Projects 可以同时持有同一物理 Machine 的独立租约，Sprout 查询与操作授权不泄露另一 Project 的租约或执行。holder 是 Agent 分身，run 结束、空闲和连接离线均不等于释放。申请、释放、交接、收回不自动终止进程或删除文件。

远端工具必须显式指定 Machine。宿主的 Pi 工具和 `sprout_status` 保留原行为。Worker 以运行用户权限执行操作，工作目录不构成安全边界，Sprout 不增加 OS 层项目隔离。P4b 提供单次执行状态与有界结果，没有交付 P4c 的日志游标、续读、取消或长命令恢复产品，也没有启动 P4d 的移除流程。租约与进程生命周期彼此独立：run 结束、释放、交接、强制收回都不终止进程、不删除文件，分身空闲也不等于占用失效。

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

七表由新增迁移 [0009_hard_chameleon.sql](../../drizzle/0009_hard_chameleon.sql) 建立，未修改已合并迁移。强制收回没有新增列或迁移：它复用 `lease_mutation` 的 Human / reclaim 收据，`forcedReclaim` 由该收据投影，详见「体验后变更与安全返工」的 F-13。Chat 标题另用一处只加约束的迁移 [0010_chat_title_check.sql](../../drizzle/0010_chat_title_check.sql)，见「体验后新增能力：Chat 标题」。复跑使用新的隔离 `DATABASE_URL`，不得删除共享业务数据，规则见 [迁移约定](../p1/conventions.md#数据库约束与迁移)。

## 功能交付证据

以下五项对应功能计划 P4b 的五个 checkbox，均已具备实现、脚本断言与反证。报告路径以 `/Users/snake/workspace/sprout-mio/orchestrate/sprout-mio-p4b/` 为根；这是编排 store，不随仓库文档提交。原始私有库、凭据和操作输出不属于可复制证据。

### 1. 申请、释放与互斥

勾选依据：交付提交 `9001f8e`（租约契约与 `machine_lease` 约束）、`dc61189`（租约事务与释放 fence）、`c771250`（生产 Fn 接入）；`reports/contracts-implementation.md`、`reports/worker-implementation.md` 和 `reports/integration-implementation.md` 记录七表约束、租约事务与生产接入。`v-lease-contracts.sh` 的 N1、N2 绕过服务直接写 SQLite，拒绝同 key 第二份租约及非法授权组合，同时允许不同 Projects 共存。第二轮 `reports/acceptance-2/acc2-lease-shape.json` 记录重复申请 `lease_conflict`，直接 INSERT 被 `UNIQUE constraint failed: machine_lease.project_id, machine_lease.machine_id` 拒绝。

释放反证由 w 的 N6 与 z 的页面路径提供：在途未 drained 时先返回 pending，期间新操作被 `lease_fencing` 拒绝；只有真实 fence ack 后代次从 1 到 2。不能把请求受理当作释放完成。重跑 `bash scripts/verify/v-lease-contracts.sh`、`bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/z-lease-integration.sh`。

强制收回（`c42bae1`，Human 裁决的 gate B）是申请与释放语义的另一条出口，不是常规释放的替代。它是独立 schema `forceReclaimLeaseInputSchema`（`action: "force_reclaim"` + `confirm: true`），**不在** Agent 可用的 `LeaseMutationInput` 里；Agent wire schema、extension 注册表与 Agent HTTP 分发都没有强制入口，四组真实 grant 尝试均得 `validation_failed`。Human 侧用真实登录会话，未登录、跨用户、跨 Project、代次不符分别得到 `unauthorized`、`not_found`、`not_found`、`lease_stale_generation`。反证：强制后旧代次（generation 1）写哨兵得 `lease_stale_generation` 且哨兵不存在；被强制覆盖的执行在真实 SQLite 里是 `state=unknown、failure_reason=worker_lost、drained_at=NULL`，不写成 succeeded；普通 release 与 handoff 在 fencing 期间仍返回 `lease_fencing`，代次不变。重跑 `bash scripts/verify/v-lease-contracts.sh`、`bash scripts/verify/w-worker-remote.sh`。

### 2. 分身 holder、跨 run 与多机持有

勾选依据：交付提交 `dc61189`（租约跨 run 保留与 grant 撤权）、`e8ec38c`（holder 投影）、`c771250`（真实 Chat 路径接入）；`reports/worker-implementation.md`、`reports/ui-implementation.md` 和 `reports/integration-implementation.md`。第二轮 shape 探针中，同一 instance 对两条 Machine 身份各持一行，`instancesHeldByThisActor=2`。run 进入终态后仍为 `held`，generation=1 且 holder 相同。w 的 grantRevocation 记录 `leaseRetained=true`、generation=5；z 的 `run-ended-still-held.png` 由真实 Chat 路径验证 run 结束不释放。

反证：旧 run 的 grant 不能继续操作，返回 `remote_run_inactive` 或 `remote_grant_invalid`，而租约仍保留；另一分身不能据原 holder 空闲自行取得租约。多机组合没有两台物理 Machine 的联合实测，不据此宣称跨机通过。重跑 `bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 3. shell、文件、进程操作与授权

勾选依据：交付提交 `dc61189`（远端执行与准入核对）、`46d9d17`（远端工具注册与私有 grant）、`f11ec13`（编码后报告预算）；`reports/worker-implementation.md`、`reports/tools-implementation.md`、`reports/report-budget-implementation.md`。w 使用发行 Worker、真实 HTTP 与文件系统执行 shell，副作用计数为 1，重复提交、断线重连后仍为 1。x 的真实 runner 和 Worker 测试覆盖文件读写、进程列表与信号，z 在生产 Machine 页面核对真实 shell 与进程结果。

反证：w 的 N5、N6、N7、N12 及 z 的非 holder、旧代次请求均验证错误码和哨兵不存在，拒绝请求不入队。w 的在途执行最终为 `rejected` 而非 `succeeded`，同时 OS 进程仍存在、文件保留。准入时核对当前参与权和代次，不承诺持续监视或取消已经开始的 OS 副作用；单独撤销 run grant 的限制见安全边界。重跑 `bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/x-remote-tools.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 4. 宿主工具保留、远端目标明确

勾选依据：交付提交 `46d9d17`（远端工具注册、必填 Machine 与私有身份注入）、`1651dcd`（HTTP handler 请求上下文）、`b5c34db`（能力快照断言）；`reports/tools-implementation.md`、`reports/build-fix-implementation.md`、`reports/fixture-sync-implementation.md`。x 真实加载 `pi/sprout-extension.ts`，确认远端注册工具的必填 Machine 与私有身份注入。全量 a 的真实 Pi 调用仍返回原 `sprout_status` 结构，`src/extension/main.ts` 保留注册。

反证：x 的 N12 缺 Machine 被 `validation_failed` 拒绝，伪造 Project 身份被拒；w 对缺 Machine 的真实 HTTP 请求同样拒绝，目标文件不存在。宿主工具没有默认转向远端。重跑 `bash scripts/verify/a-base.sh`、`bash scripts/verify/x-remote-tools.sh`、`bash scripts/verify/w-worker-remote.sh`。

### 5. 跨 Project 独立与不可见

勾选依据：交付提交 `9001f8e`（Project × Machine 唯一键与授权约束）、`39dca15`（预算改为 Project × Machine）、`c771250`（真实 Fn 查询边界）；`reports/contracts-implementation.md`、`reports/quota-scope-implementation.md`、`reports/integration-implementation.md`。v 的 N2 与第二轮 shape 探针证明同一 Machine 有两条不同 Project 的 held 租约，双方 list 只见本 Project。F-3 修复后预算键也为 Project × Machine，A 满 64 条不再消耗 B 的槽位，两个 Project 各自第 65 条仍被拒绝。

反证：w 的 N7 对改成 B 的 projectId、只绑定 B 的 Machine 返回 `not_found`，私有哨兵不存在。z 的真实未登录、跨用户与浏览器跨 Project 读取反证均通过，quota-scope 测试另核对 B 读 A 的 executionId 为 `not_found`，过期清理不修改另一 Project。重跑 `bash scripts/verify/v-lease-contracts.sh`、`bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/z-lease-integration.sh`，以及 `pnpm exec vp test run tests/quota-scope.test.ts`。真实配额链路入口为 `node --import tsx tests/fixtures/quota-scope-live.ts`。

## UI 交付证据

以下三项对应 UI-P4b 的三个 checkbox。`reports/ui-implementation.md` 记录共享呈现与演示，`reports/integration-implementation.md` 记录真实查询接入，`reports/fencing-facts-implementation.md` 记录 fencing 返工与三页面实测。技术勾选不代表 Human 体验确认。

### 1. 租约、holder、申请释放与多机概要

交付提交 `e8ec38c`（租约面板、holder 分组与演示场景）、`064d517`（fencing 事实呈现）、`c771250`（真实 Machine 页面接入）。

y 的 18 组检查覆盖浅暗主题和 390、901、1199、1200、1440px，断言 holder 分组、同分身多机、申请 pending、成功和失败、明确收据以及释放后代次。反证包括另一个 Project 的租约不可见，fencing 普通 reclaim 被拒后仍保留 holder，不显示成功或空闲。

页面信息架构在 `5ade997`（merge `e28a149`）按 A 方案重排，见「体验后 UI 返工」：租约管理只在 Machine 详情的租约区块，Project settings 只留「本 Project 绑定了哪些 Machine + 租约摘要 + 深链跳转」，不再有租约表单；Machine 详情原有 8 个配置区一个没删，只是归入「设置」分组。fencing 卡片正文本体只剩一句摘要，完整事实（等待时长、pending 动作、代次、未知执行）放在问号按钮背后的 Dialog 里。

z 在真实服务、Worker、新账号及 Chromium 上执行 Chat 请求，读取生产 Machine 租约卡，点击释放并核对真实进程和文件保留。第二轮 `reports/acceptance-2/machine-held-light.png`、`machine-detail-lease.png` 与 `fencing-real-row-after-reclaim.png` 支持真实页面结论。多机组合仍以投影和演示覆盖。重跑 `bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 2. 远端目标与真实结果

交付提交 `e8ec38c`（远端执行面板与宿主/目标区分）、`c771250`（生产执行事实接入）。

y 断言宿主与指定 Machine 目标分开显示，操作结果及 unknown、截断不会冒充完整成功。z 的 `real remote shell and process result visible on production Machine page` 在真实页面检查执行列表与结果，再用 file_read 读取私有哨兵，仅在测试进程内断言内容。

反证：z 从 Chat 提交非 holder 与旧代次命令，核对真实 grant HTTP 拒绝、目标文件不存在且没有入队记录。w 的 missing Machine 反证防止隐式目标。第二轮对应 `machine-result-light.png`、`machine-detail-executions.png`、`mutation-failure-stale-generation.png`。结果截图只适用于不含敏感内容的验收数据，不复制真实业务输出。`5ade997` 之后卡片不再渲染命令正文、cwd、文件绝对路径与远端输出正文，人类可见的只剩操作类型、目标、状态、失败原因、结果元信息与时间；这是有意取舍，一期没有审计产品，也没有「展开原文」。重跑 `bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

### 3. Chat、Machine 与 inspector 一致，run 结束保留占用

交付提交 `e8ec38c`（Chat header、inspector 与 Machine 详情共用持租投影）、`064d517`（fencing 三页面事实）、`c771250`（三处生产接入）。

y 断言三处共用持租投影，run completed 仍显示 held，并区分 run 与租约。z 真实 Chat header、inspector 与 Machine 详情读取同一 holder，run 结束后仍 held，支持 URL 刷新、后退与前进，并覆盖浅暗主题及 390、900、1200px。

反证：z 以未登录、第二账号调用租约与执行 Fn，分别得到 `unauthorized`、`not_found`；浏览器改 Project 读取被拒。第二轮 `chat-inspector-light.png`、`chat-inspector-leases.png`、`run-ended-still-held.png`、`cross-user-denied.png` 对应这条路径。fencing 返工另有三页面 × 两主题 × 五宽度的 30 组真实页面检查，不把 pending 写成成功。重跑 `bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

## 体验后 UI 返工（A 方案信息架构）

Human 亲身体验真实页面后给出九条反馈，其中七条落在页面信息架构与呈现（本节 1–7 条），另有一条是 Chat 无法辨认（由后续 `5c8dfa4` 的 Chat 标题单元承担，见下一节）。实现链为 `7e2249a` → `371e7dc` → `fdc38db` → `f4da042` → `cbb4a53` → `79c7c50` → `5ade997`，合并提交 `e28a149`；`fencing-facts` 的卡片形态在 `064d517` 已定，本轮只改成「一句话摘要 + 问号 Dialog」。逐条结果：

1. Machine root 与 Project 绑定的观察信息只保留「当前可达」，不再重复派生路径或以同一行拖观察时间、连接代次与 revision。
2. 远端操作卡片里的**命令正文整体移除**，也没有「展开原文」按钮：shell 命令、`cwd`、文件绝对路径、maxBytes 都不上界面。这是一期有意的取舍——一期没有审计产品，命令正文与远端输出都可能含密钥；代价是 Human 无法在界面上回看当时跑了什么。保留并可读的是操作类型、目标、状态、失败原因、结果元信息、授权代次与时间。
3. 删除「分身与它持有的 Machine」聚合框，改为 holder 行上一句「持有 N 台」。
4. 租约入口从文字链改成 `Button variant="secondary"`「租约详情」，点击滚动到本页租约区块并交出真实焦点。
5. **A 方案落地**：Machine 详情页的租约区块只包含租约本身，原有八个配置区（连接与配对、Shell 能力、Machine root 工作目录、Project 绑定、安装与维护等）**一个没删**，只是归入 `role="group" aria-label="设置"` 的设置分组；Project settings 只保留「本 Project 绑定了哪些 Machine + 租约摘要 + 深链跳转」，不再渲染租约表单。区块顺序与归属由 `p4b-lease-scenes.mjs` 的 DOM 顺序断言背住。
6. 表单按钮与下拉框底边对齐（1200px 下断言差值 ≤ 8 且不重叠）；在单台 Machine 的详情页不再重选目标，目标由页面上下文唯一确定，跨机器场景仍要求人选。这是「人站在哪台机器上」的表单细化，与 standing order 7 约束的「工具调用层必须显式指定 Machine」不冲突：`sprout_remote_*` 的 input schema 与 `docs/core-scope.md` 未改，服务端仍按显式 `machineId` 校验授权。
7. Chat 下拉框不再出现裸 `cnv_` id，复用既有 `chatAgentName`；当时只是显示层兜底，标题的持久化后来由 `5c8dfa4` 单独补齐。

fencing 呈现改为「一句话摘要 `FENCING_SUMMARY` + 问号按钮背后的 Dialog 承载完整事实」（等待时长与 since、无法保证等待会结束、重连不等于已确认、旧进程可能继续产生副作用、pending 动作与代次、未知执行条数与 id、最多 100 条的读取上限）。实现沿用 `machine-install-instructions.tsx` 已有的 `CircleHelp + DialogTrigger + DialogContent` 模式，没有新造组件或硬编码色值。强制收回入口在 `c42bae1` 后补入同一张卡片，但没有削弱原有守护：fencing 期间仍不给可用的申请、释放或交接动作。

反证与回归：`z-lease-integration.sh` 断言命令正文不落界面、深链入口存在、交接与收回的目标固定；`y-lease-ui.sh` 与 `p4b-lease-scenes.mjs` 覆盖浅暗主题 × 390 / 901 / 1199 / 1200 / 1440px。本轮没有改 `src/contracts`、`src/domain`、`src/server`、迁移或任何 verify 脚本的断言方向（只新增真实页面断言）。重跑 `bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/z-lease-integration.sh`。

## 体验后新增能力：Chat 标题

`5c8dfa4`（merge `147193b`）为每个 Chat 提供人类可读的标题与显式改名。按 [统一术语](../core-scope.md#统一术语chat对话)，Chat 涵盖 DM、Group 与 Public Channel；当前 `chat.kind` 的契约只有 `dm` 一种，因此本轮实测覆盖的是 DM 形态。它是独立能力，不是租约或远端操作的一部分。

- 数据形状：标题仍是 `chat.title`（可空文本列），语义固定为人工命名的显示覆盖；`null` 表示未命名，不用空字符串表达第二种空值。新增迁移 [0010_chat_title_check.sql](../../drizzle/0010_chat_title_check.sql) 只加 `CHECK("title" is null or length(trim("title")) between 1 and 80)`，未改动已合并迁移的结构。
- 写入路径：真实存在的 `updateChatTitle` / `clearChatTitle`（领域）与 `updateChatTitleFn` / `clearChatTitleFn`（服务端）；服务端先 `requireSession` 再校验契约，空白与超长得 `validation_failed` + `fieldErrors.title`。
- 显示口径：`src/components/chat/chat-display.ts` 的 `chatDisplayName` 为 `title?.trim() || agentName.trim() || "Agent"`（`CHAT_AGENT_FALLBACK = "Agent"`），`chatSubtitleLabel` 在有标题时给对话对象名、未命名时给 `DM`；裸 `cnv_` id 不作为可见文案。
- 反证：`i-chat.sh` 用真实 HTTP 验证未登录改名被拒、第二账号跨用户改名被拒且库里标题未变；`p4b-chat-title-flow.mjs` 在真实浏览器里验证改名与恢复默认，`tests/chat-title-display.test.ts` 固定展示口径。

**没有做的**：本能力不做自动生成标题，也不做会话摘要。创建 DM 时不写 `title`，首条消息不会触发任何模型调用，没有「待生成」状态、没有摘要与成本/超时路径；改名与恢复默认只能由 Human 显式发起。重跑 `bash scripts/verify/i-chat.sh`、`pnpm exec vp test run tests/chat-title-display.test.ts tests/chat.test.ts`。

## 安全边界与反证

| 边界                        | 直接反证与证据                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 授权代次失效                | w 在真实代次 3→4 后提交旧代次，得到 `lease_stale_generation`；`targetExistsBeforeReplay=false`、`targetExistsAfterReplay=false`。受控代理扣住真实帧并重放给同一 Worker，dispatcher 拒绝旧帧，哨兵仍不存在。见 `reports/acceptance-2/w-worker-remote-evidence.json` 与 `acc2-w-worker.log`。 |
| 撤权时尚未启动的操作        | w 的 N6 在 fence 关闸后拒绝 pending delivery，目标文件不存在。真实 release 先 pending，drain 后 generation 1→2，`inFlightState=rejected`，`processAliveAfterBump=true`、`filePreserved=true`。见同一 w evidence 的 N6。                                                                     |
| 跨 Project 借租约或 Machine | A 的 grant 改 Project 或操作 B-only Machine 得 `not_found`，`crossProjectSentinelExists=false`；B 的执行记录不可被 A 读取。见 w 的 N7、N12 及 z 的真实 HTTP/Fn 检查。                                                                                                                       |
| 未登录、跨用户              | z 对 `getLeaseFn`、`listProjectExecutionsFn`、`getExecutionFn`、`reclaimLeaseFn` 经真实 HTTP 分别验证 `unauthorized`、`not_found`。Agent HTTP 无凭据得 401 `remote_grant_invalid`，任何 Origin 得 403 `forbidden`。                                                                         |
| 非 holder                   | z 的 `browser Chat request -> real non-holder grant HTTP rejection and absent sentinel` 得 `lease_not_holder`，明确 `!existsSync(marker)`，该 requestId 不在执行列表。旧代次负例使用相同三重检查。见 `scripts/verify/z-lease-integration.sh` 的 `negativeCommand`。                         |

本节反证的交付提交为 `dc61189`（服务端准入与 fence）、`064d517`（fencing 事实呈现），重跑 `bash scripts/verify/w-worker-remote.sh`、`bash scripts/verify/z-lease-integration.sh`。

授权在服务端 Fn 和 `/api/remote/agent` 边界核对，UI 与 extension 不承担最终授权判断。新领域错误已登记到 `src/server/functions/domain-errors.ts`。结果报告同时核对 execution、Project、Machine、代次、session、seq 与 fingerprint；合法 Worker 仍属于可信执行端，Sprout 不能证明其报告的 OS 事实为真。

撤权必须区分租约 fence 与 run grant。租约 fence 关闭新调度并排空旧结果等待，drained 不是“所有 OS 进程退出”。已经启动的 shell、文件系统调用可能继续产生副作用。安全探测 F-4 还证明：单独撤销 run grant 会拒绝后续 HTTP 请求，但不会对已派发操作下发 fence，该操作可能继续并报告成功。第二轮 PASS 没有消除这项语义限制，不能据本章声称所有撤权路径都会中止在途副作用。有关产品语义仍交 coordinator 与 Human 处理，本单元不改授权行为。

## 体验后变更与安全返工

Human 体验确认已记录于「Human 体验确认」小节（版本 `c6653f4`，与交付基线的可见 UI 一致）。以下是实现与技术验收期间的返工记录。

F-1，`f11ec13`：原 Worker 按输入原始字节截断，非法 UTF-8 再编码或 JSON 转义后超出 wire 上限；多结果整批超预算及拒收还可能使 Worker 退出，进而永久 fencing。修复位于 Worker 生产和发送侧：按编码后字节截断，结果与 fence ack 共用完整 exchange 预算，过大或非法报告降级为明确失败并保留截断事实，明确拒收后 drain 重报，损坏 2xx 响应用原身份重试。服务端契约上限没有放宽。第二轮 12a 与 coordinator 对照记录：OLD stdout 196608 bytes、truncated=false、wire 非法，NEW 65535 bytes、truncated=true、wire 合法；整批 1578604→530012 bytes。见 `reports/report-budget-implementation.md`、`reports/acceptance-2/acc2-f1-{old,new}.json`、`/tmp/coord-f1-{old,new}.log`。

F-3，`39dca15`（回归测试 `ba2f30b`）：原服务端以 Machine 为键统计 64 条未终态执行，A 的队列会拒绝 B 的合法请求。修复在服务端预算查询加入 Project 条件，因为预算的所有者是服务端，UI 或 Worker 无法恢复被拒请求。第二轮 12b 与 coordinator 双向复现 OLD B=`too_many_requests`，NEW B=`admitted`、`queued`，`nonTerminalByProject=[64,1]`；每对上限仍为 64。`src/server/lease.ts` 的 drain 守卫未改。见 `reports/quota-scope-implementation.md`、`reports/acceptance-2/acc2-f3-{old,new}.json`、`/tmp/coord-f3-{old,new}.log`。

F-12，`064d517`：原“回收中”呈现掩盖无限等待，pending 表单还可能显示绿色“释放已确认”。修复在共享呈现侧如实显示“等待 Worker 确认”、等待起点与时长、原 holder、可验证的 pending 动作与代次，以及最多 100 条已加载执行中的不确定记录；不承诺有限时间完成。真实普通 reclaim 返回 `lease_fencing`，页面保留错误码与 requestId，不伪造成功或代次提升。第二轮 12c 比较旧页面与当前真实 fencing 页面，unknown=1、进程文件仍在，重启 Worker 和普通 reclaim 均未强制推进。见 `reports/fencing-facts-implementation.md`、`reports/acceptance-2/fencing-real-page-{light,dark}-1440.png`、`fencing-real-row-after-reclaim.png`。UI 只能呈现事实，不能替服务端伪造 drain 或代次提升。该轮的“没有强制推进路径”结论在 `c42bae1` 后已更新，见 F-13。

F-13，`c42bae1`（gate `p4b-fence-liveness` 选 B 并实现）：Human 明确裁决允许强制收回，实现要点是可核对的而非叙事式：独立 schema `forceReclaimLeaseInputSchema`（`action: "force_reclaim"` + `confirm: true`）刻意不进入 Agent 的 `LeaseMutationInput`；内部幂等键为 `force-reclaim:<被覆盖的 mutationId>`，与公开的 `req_*` 命名空间分开；`forcedReclaim` 从 `lease_mutation` 的 Human / reclaim 收据投影，**没有新增数据库列、没有新迁移**；`completeLeaseMutation` 与 `expireExecutions` 函数体一字未动（与 `3b118e5` 的抽取字节比较相同），常规 release / handoff 在 fencing 期间仍返回 `lease_fencing`。反证：强制路径下未 drained 的执行写 `state=unknown、failure_reason=worker_lost`，`drainedAt` 保持 NULL 表示未知，**不伪造 drain**；旧代次写哨兵得 `lease_stale_generation` 且哨兵不存在；旧 shell 的 PID 与文件在强制前后均存活、未被删除；新 holder 可以在旧副作用尚未落地时取得租约，这一点是 B 方案显式接受的例外（`newHolderAcquiredBeforeLateSideEffect` 与 `lateSideEffectObservedAfterForce` 均为 true）。真实入口是 `tests/fixtures/lease-force-contracts.ts` 与 `tests/fixtures/lease-force-live.ts`，分别由 v 与 w 驱动。重跑 `bash scripts/verify/v-lease-contracts.sh`、`bash scripts/verify/w-worker-remote.sh`。

F-14，`5869bf3`（收据核对）、`dd3fa80`（状态隔离与注入时钟）、`8ffa7e6`（远端错误码保持应用错误码的严格别名）：UI 租约操作未收到收据时，原来返回 `conflict` 并回报发消息的 Fn id；现在改为 `lease_result_unconfirmed` 并回报动作自身的 `requestId`，等待预算 180 秒、退避 500ms 到 2s，到期后重读 lease 与 receipt，若 mutation 已 completed 则返回成功而非报未知。这条缺陷的反证方式是并发：全量并发跑它必现，单独跑三次不现，才被确认为产品缺陷而不是链路慢；此前把同一现象当成“真实链路时长波动”是错误定性。`8ffa7e6` 另外拒绝了一处门禁作弊：`REMOTE_ERROR_CODES` 不得为了保住旧计数而把 `lease_result_unconfirmed` 过滤掉，它仍是 `APP_ERROR_CODES` 的纯别名。回归在 `tests/project-lease-actions.test.ts` 与 `tests/lease-contracts.test.ts`，真实路径由 z 覆盖。重跑 `bash scripts/verify/z-lease-integration.sh`、`pnpm exec vp test run tests/project-lease-actions.test.ts tests/lease-contracts.test.ts`。

F-15，`eb48f58`、`c6653f4`、`38d35c8`：Human 在真实预览上提出的四项反馈落地，并修掉一处由此暴露的门禁空洞。

- 返回导航（`eb48f58`）：租约页返回按钮原本读 `window.history.state.idx`，而 TanStack History 从不写这个键，判断恒为假，所以所有出口都落到硬编码的 Project settings。现在改用 `useCanGoBack()` 加 `router.history.back()`，跟随真实来源；直接打开才用 fallback。
- 滚动（`eb48f58`）：`scrollRestoration: true` 恢复的是 window，而本应用滚动容器是页面内层 div，上一页的偏移量被写到新路由上，从 Project settings 底部进入会直接停在底部。该配置已关闭，租约页进入时自行回到顶部。代价是「返回时恢复来源页滚动位置」也随之消失，这一行为由 Human 确认保持现状。
- Chat 选择器位置（`c6653f4`）：选择器原本独占顶部一张卡片，而它服务的交接与收回在两张卡片之下，选 Chat 要先滚走再滚回。现在选择器渲染在申请/释放表单内、目标 Machine 之上，交接卡片只保留一行已选 Chat 的确认；Project settings 保留完整布局，因为它跨 Machine 操作。同一次改动把「请先选择 Chat」提示改为 warning 语义色。
- 门禁空洞（`38d35c8`）：独立租约路由 `6c4f94d` 把全部租约事实移到 `/machines/$id/lease`，但 `tests/fixtures/lease-force-live.ts` 仍导航到 `/machines/$id` 并等 `lease-fencing-facts`，导致 `w-worker-remote.sh` 在 main 上稳定超时——第三轮验收基线 `8ffa7e6` 早于该路由拆分，所以当时没有暴露。同一夹具还有一处竞速：shell 固定 `sleep 25` 才写副作用，而 UI 侧要在 30 秒窗口内跑完多轮 reload、截图与强制收回。现改为由测试在强制收回完成、新持有者拿到租约之后写放行文件，副作用不再依赖墙钟对齐。

验证：`pnpm check`、`pnpm typecheck`、`pnpm test`（332 条 / 45 文件）全部通过；`bash scripts/verify/y-lease-ui.sh` 18 checks / 0 failed，`bash scripts/verify/z-lease-integration.sh` 13 PASS / exit 0，`bash scripts/verify.sh` 37 个脚本 `failed=0`。预览侧用真实账号与 Playwright 真点击复验：从 `/machines` 列表进详情再进租约后返回落在详情页（0/200/800/2500ms 四个停留时长一致），从 settings 底部 `scrollTop=3447` 进入租约为 `scrollTop=0`，返回落在 settings；390px 无横向溢出；页面上 Chat 选择器数量恒为 1。

## 技术验收证据

| 层次                      | 版本、实际结果与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实现与集成                | contracts `9001f8e`、migrate-callers `b4e204f`、worker `dc61189`、tools `46d9d17`（merge `b9ba470`）、build-fix `1651dcd`、UI `e8ec38c`（merge `1ffb40a`）、integration `c771250`、fixture-sync `b5c34db`、verify-fullgreen `6428b5c`，均为当前基线祖先。对应全部 `reports/*-implementation.md`。                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 首轮独立技术验收          | `b5c34db`，`reports/p4b-acceptance/acceptance.md`：11 项 PASS，含真实 Pi、Worker、服务、SQLite、Chromium。发现旧占位断言和构建产物顺序问题，后由 `6428b5c` 修复并全量复跑。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 第二轮技术复验            | `243fd53`，`reports/acceptance-2.md`：1–12 PASS，12a、12b、12c 均有修复前后对照，`reports/acceptance-2/` 保存 34 份证据。这是技术复验记录；模型独立性的调度限制另见 store 的 `decisions.tsv`，不据此增列 Human 确认。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **本轮（`8ffa7e6`）补充** | 同章后续两批能力（`c42bae1` 强制收回、`5c8dfa4` 标题、`5ade997` 页面返工、`5869bf3`/`dd3fa80`/`8ffa7e6` 收据修复）均已合入 main 并有各自单元的实现报告与反证：`reports/fence-force-implementation.md`、`reports/chat-title-implementation.md`、`reports/ui-refine-implementation.md`、`reports/zfix-implementation.md`、`reports/receipt-implementation.md`。`c42bae1` 上 `pnpm test` 为 261 条；`8ffa7e6` 上为 287 条 / 38 个文件（实测日志 `/tmp/p4b-test-now.log`）。`vp check` 在未跟踪的 `brief.md` 存在时因该文件格式退出 1，移出后为 `314 files formatted` + `260 files lint/type clean`、退出 0。                                                                                                                                       |
| 第三轮独立技术验收        | `8ffa7e6`，因行为已变（强制收回、Chat 标题、收据语义）而重新派发：PASS。此后合入独立租约路由 `6c4f94d` 与 F-15 四项改动（`38d35c8`、`eb48f58`、`c40716f`、`c6653f4`、`a872aad`）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 第四轮独立技术验收        | `a872aad`，`reports/acceptance-4.md`：**FAIL**。前六项必验、九项单独回归与 8 条反向注入全部通过；唯一失败项是全量门禁 `Verification scripts=37 failed=2`，入口为 `scripts/verify/b-tooling.sh` 与 `scripts/verify/drain-http.sh`，根因未定位即如实判 FAIL，不把未定位的失败写成既存竞态。                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 第五轮独立技术验收        | `809c384`，`reports/acceptance-5.md`：**PASS**。有效完整门禁 `Verification scripts=37 failed=0`、退出码 0、runner 801.291 秒；两个独立 clone 全量单测均 45 文件 / 332 条通过；六条反向注入全部真红。两处修复被独立判为「修掉真实缺陷、断言强度不变」：counter 断言在完全去掉写盘后仍 `0 != 1` 失败（`catch` 只吞等待超时，不吞最终 `expect`），`drain-http` 仅放宽非 timeout 场景的外部观测窗口，产品 `drain.wait(8000)` 与全部语义断言未动，伪报 stopped 的变体在首个场景即被抓住。本轮另把 F-15 的滚动、Chat 选择器唯一性与 warning 语义色补进 `z-lease-integration.sh`。重跑：`bash scripts/verify/z-lease-integration.sh`、`bash scripts/verify/drain-http.sh`、`pnpm exec vp test run tests/worker-report-budget.test.ts`、`pnpm verify`。 |

第二轮全量验证里的 `l-docs`、`l-docs-probes` 两条失败来自 `git archive` 副本没有 `.git`，无法解析历史提交。相同 SHA 在带历史工作树里 `L_EXIT=0`、`LP_EXIT=0`，coordinator 的 30 脚本验证也为零失败，证据 `reports/acceptance-2/acc2-ldocs-git.log`。这两条是环境性假失败，不是产品缺陷。

本刷新单元（文档）在本工作树（base `8ffa7e6`）上实际执行的检查，仅供查阅，不替代任何一轮技术验收：

| 检查                                   | 本次结果                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash scripts/verify/l-docs.sh`        | 退出 0，输出 `PASS l-docs all checks passed`；日志 `/tmp/p4b-l-docs-final.log`。                                                                            |
| `bash scripts/verify/l-docs-probes.sh` | 退出 0，`17 probes passed`；日志 `/tmp/p4b-l-docs-probes-final.log`。                                                                                       |
| `pnpm exec vp check`                   | `brief.md` 在场时退出 1（只报该文件）；将该未跟踪文件暂时移出后退出 0，`314 files formatted`、`260 files` 无 lint/type 错误。日志 `/tmp/p4b-vp-final.log`。 |
| `pnpm test`                            | 退出 0，38 个文件、287 条全过，runner 18.65 秒；日志 `/tmp/p4b-test-now.log`。                                                                              |

## 已知限制与未闭合项

- `p4b-fence-liveness` 已由 Human 裁决为 B 并在 `c42bae1` 实现。代价必须与能力一起说：Human 强制收回后，新 holder 可以在旧副作用仍在落地时取得租约；旧进程不会被终止、文件不会被删除，被中断的执行只记为 `unknown`，`drainedAt` 保持 NULL。强制收回不等于已排空，也不是「所有撤权路径都会中止在途副作用」的依据。
- 同 UID 进程可被有效 holder 通过合法 shell 或 `process_signal KILL` 终止，Worker 自身也在其权限范围内。F-2 仍可导致永久 fencing。工作目录不是沙箱，物理 Machine 上的文件、进程、端口和资源竞争由 Project organization 负责。
- 外部 SIGKILL、宿主断电、永久失联或原会话丢失后，新 Worker 不能代替旧 delivery 证明 drained，不能恢复原会话；重新 open 或 staleAfter 到期都不等于旧操作已排空。
- 永久阻塞的系统调用不能提前声明 drained。持续拒收最小合法报告、身份冲突或网络持续不可达也没有有限时间完成保证。租约 fence 与单独 grant 撤销的在途限制见安全边界，F-4 未被本轮返工消除。
- 预算按 Project × Machine 独立，不承诺同一物理 Worker 的队列公平性。配额专用真实夹具为验证 B 的最终执行把轮询暂缩至 50ms；原节奏下已观察到 B 获准后因队列等待触发 deadline。常规真实主路径另由 w、z 覆盖。
- grant 15 分钟过期且不续期，慢模型可能导致合法 holder 的旧 grant 失效，租约仍 held。认证 Worker 可谎报自己收到的执行结果，结果协议不是对宿主的可信计算证明。
- 安全探测观察到命令与有界结果落入 SQLite，文件权限受运行环境 umask 与目录权限影响，样本库为 644；Pi 转录也可能保存工具参数和结果。本章不承诺本地多用户隔离。票据、secret、cookie、私有库和远程输出正文不得复制到报告、日志与截图。
- fencing 页面只统计最多 100 条已加载执行，`ExecutionView` 没有 `drainedAt`，零条未知结果不能证明历史全部排空；强制收回后这一条更关键，它只把已知未排空的执行记为未知，不声称已经清点完毕。900px、1200px 布局和浅暗主题有 Chromium 验证，真机软键盘及跨机网络未验证。
- **文档门禁已闭合**：`9737b42` 把 `l-docs.sh` 里「P4b 功能五项与 UI 三项必须未勾选」的旧约束改成与 P4a 同级的证据门禁（`checkP4bLine` 形状对齐 `checkP4aLine`），`f8c1b99` 又将其收紧为 per-section 校验：不接受文档级 commit 兜底，每个被引用小节必须自带可解析 commit 与真实存在的重跑命令，探针由 15 条增至 17 条。当前 `bash scripts/verify/l-docs.sh` 与 `bash scripts/verify/l-docs-probes.sh` 均退出 0（日志 `/tmp/p4b-l-docs-final.log`、`/tmp/p4b-l-docs-probes-final.log`），P4b 五项与 UI 三项按证据勾选且各自可核。另记一条环境事实：本刷新工作树里有一个未跟踪的 `brief.md`（调度文件，不属于仓库内容），它会让完整 `vp check` 在格式步骤退 1；将该文件移出后的干净工作树为退出 0。

## 重跑清单

在带完整 Git 历史、独占写入的隔离 checkout 中使用 `pnpm verify` 跑完整验证。该命令包括全量测试，不再另外追加 `pnpm test`。完整验证会清理自己的验证产物，不在活跃 Worker checkout 运行。当前基线 `c6653f4` 的实测结果：`pnpm test` 332 条 / 45 个文件全过，`bash scripts/verify.sh` 37 个脚本 `failed=0`，`l-docs` 与探针均退出 0。完整验证与全量测试在同一基线复跑，不再另外追加重跑。

| 入口                                                                                                                                                                                                             | 对应范围                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bash scripts/verify/v-lease-contracts.sh`                                                                                                                                                                       | 七表、隔离迁移、SQL 反证与 wire schema。                                                               |
| `bash scripts/verify/w-worker-remote.sh`                                                                                                                                                                         | 真实 macOS Worker、HTTP 授权、旧帧、撤权在途、哨兵与输出预算。                                         |
| `bash scripts/verify/x-remote-tools.sh`                                                                                                                                                                          | 真实 Pi extension 注册、宿主保留、显式 Machine、私有 grant 注入。                                      |
| `bash scripts/verify/y-lease-ui.sh`                                                                                                                                                                              | 共享演示、浅暗与五宽度、Project 隔离、pending 收据和 fencing 文案。                                    |
| `bash scripts/verify/z-lease-integration.sh`                                                                                                                                                                     | Chat 到真实 Worker 的生产接入、三处一致、权限反证与进程文件保留。                                      |
| `bash scripts/verify/a-base.sh`                                                                                                                                                                                  | 真实 Pi `sprout_status` 原行为。                                                                       |
| `bash scripts/verify/s-machine-contracts.sh`、`bash scripts/verify/t-machine-worker.sh`、`bash scripts/verify/u-machine-ui.sh`                                                                                   | P4a 契约、连接、票据、root、origin、刷新及能力回归；u 使用独立空闲 `BASE_URL` 避免既存 3120 端口冲突。 |
| `pnpm exec vp test run tests/worker-report-budget.test.ts tests/quota-scope.test.ts tests/lease-view.test.ts tests/project-lease-actions.test.ts tests/lease-contracts.test.ts tests/chat-title-display.test.ts` | 三项安全返工、租约收据与 Chat 标题的定向回归。                                                         |
| `node --import tsx tests/fixtures/quota-scope-live.ts`                                                                                                                                                           | 隔离 SQLite、真实服务与 Worker 的双 Project 预算及私有哨兵。                                           |
| `node --import tsx tests/fixtures/lease-force-contracts.ts`、`node --import tsx tests/fixtures/lease-force-live.ts`                                                                                              | Human 强制收回的契约反证与真实服务 / 真实 Worker 路径（已由 v、w 驱动）。                              |
| `bash scripts/verify/i-chat.sh`                                                                                                                                                                                  | Chat 标题的未登录、跨用户改名反证与真实浏览器改名流程。                                                |
| `bash scripts/verify/f-docs.sh`、`bash scripts/verify/l-docs.sh`、`bash scripts/verify/l-docs-probes.sh`、`pnpm exec vp check`                                                                                   | 文档链接、计划证据门禁与格式检查；l-docs 与探针在 `8ffa7e6` 上均退出 0。                               |

脚本产物默认写各自 `.verify/` 子目录，复跑后读取当次结果，不将启动命令返回当成执行成功。独立端口、隔离库与 state-dir 由对应夹具管理，localhost 请求绕过代理，禁止触碰 Human 正在使用的 :3000。

## Human 体验确认

- 确认记录：Human 亲自体验确认通过，版本 `c6653f4`

Human 于 2026-10-26 在真实运行的 P4b 预览环境上亲自体验，明确确认所用版本 `c6653f4`。该版本与交付基线 `809c384` 之间的差异只有文档、验收脚本与测试（`git diff --name-only c6653f4..809c384 -- src/` 为空），可见界面与交互一致，因此确认覆盖交付形状。

本轮体验反馈两条已落地并复验：

1. **Chat 选择器位置**：选择器原本独占顶部一张卡片，而它服务的交接与收回动作在两张卡片之下，选 Chat 要先滚走再滚回。现渲染在申请/释放表单内、目标 Machine 之上，交接卡片只保留一行已选 Chat 的确认；Project settings 保留完整布局，因为它跨 Machine 操作。页面上 `lease-chat-select` 数量恒为 1。
2. **等待前置条件的提示色**：`lease-handoff-chat-required` 从 muted 改为 warning 语义色，与其它前置等待态一致，使用 `theme.css` 既有 token，不新增硬编码色值。

两项均已写入仓库回归断言（`809c384` 的 `scripts/verify/z-lease-integration.sh`），并由第五轮独立技术验收逐条做红态反证确认能抓回归。

以下检查点仍属建议范围，未被本次确认覆盖为已逐项核对；跨机网络与真机软键盘未验证。

Human 的建议检查点：

1. **Project 内 Chat 页面**：请求分身使用指定 Machine，核对宿主与远端目标、holder 和真实结果；run 结束后仍显示持有，下一轮同分身接续，再显式释放。Chat 列表应显示标题或分身名，不出现裸 `cnv_` id；Human 可以显式改名与恢复默认。
2. **Machine 详情页（明确 Project 上下文）**：核对租约、代次、holder、申请释放收据与操作结果。租约管理只在这一页，Project settings 只给摘要与深链。遇到 fencing，卡片只一句话，完整事实在问号按钮里；Human 强制收回需勾选风险确认，强制后应能看到旧副作用可能仍在落地。
3. **Chat inspector 的 Machine 租约区**：与 Chat header、Machine 详情比对同一 holder、run 与租约，切换 Project 不出现另一 Project 工作信息，浅暗主题和窄屏下仍可读。

体验后由 coordinator 记录明确确认版本及反馈。`p4b-fence-liveness` 的产品裁决已单独记录（Human 选 B，实现于 `c42bae1`），不能用体验确认替代该 gate 的决定。
