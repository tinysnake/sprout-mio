# P7 章节结论：客户端体验、恢复与诊断

P7 交付「一个人在一台 Mac 上，用浏览器与手机把一期的主要路径走完，并且看得见状态、看不见内部术语」这一层：登录后回到原来的目标、详情深链与刷新、断线与旧数据反馈、只读离线、Management 的服务与数据事实、备份恢复与响应基线、Pi 资源继承的明确边界，以及在真实页面上跑通的自动接续控制。判据、返回形状与边界见 [P7 契约](contracts.md)。

技术交付基线：**`e338ffa`**（`integration/p7` 上三条回归修复之后的提交；本章门禁在这条提交上取证）。

| 项       | 值                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 交付线   | 功能、UI、集成三线                                                                                                                                                                |
| 新增契约 | `src/lib/return-target.ts`、`src/lib/offline-read-functions.ts`、`src/lib/connectivity.ts`、`src/lib/pwa.ts`、`src/server/wake-config.ts`、`src/components/ui/action-outcome.tsx` |
| 迁移     | 无新增；`0028_p6b_turn_context` 仍是最新（`drizzle/meta/0028_snapshot.json` 的 `prevId` 与重建表已校正）                                                                          |
| 门禁     | 10 条 P7 门禁（其中 `p7-loop-multiround`、`p7-pi-inheritance` 为 LOCAL） + `bf-p6b-pages` 内的真实页面接线断言 + 回归                                                             |

## 交付了什么

1. **登录后回到原目标。** `safeReturnTarget` 只放行同源应用内路径，`/login` 保持裸路径；`src/routes/_authed.tsx` 根路径不带 `next`，`src/routes/login.tsx` 结果不是 `/` 才写 `next`。深链、刷新、前进后退在 `p7-client-navigation` 里逐条走。
2. **只读离线。** `public/sw.js` 只接管 `OFFLINE_READ_FUNCTIONS` 白名单里的调用，其余请求（含全部写入）直接放行；缓存键是「URL + 请求体」的 SHA-256；命中缓存带 `x-sprout-offline: 1`，页面据此把事实标成未确认。产品不排队离线写。
3. **动作结果三态。** `ActionOutcome = processing | success | failure | unknown`，`unknown` 是独立状态，超时或断线不补成成功也不补成失败。
4. **自动接续真的在 Chat 页上。** Chat 详情 loader 取 `getChatAutomationFn`，页面把 `{ view, denials }` 交给面板，命令走 `controlChatAutomationFn`；面板把 11 个内部错误码映射成人话，码只留在 `data-error-code` 上。
5. **判定器不可用说现状。** `wakeProviderAvailabilityFromEnv()` 按部署配置算出每个 provider 的 `configured`/`available`/`unavailableReason`；页面三态渲染（无配置、全不可用、可用），保存带 `expectedConfigRevision`。
6. **Management 一期。** 「服务与数据」读 `/api/diagnostics?summary=1` 的 `queryManagementSummary`（迁移版本、资源事件与续行积压、MCP 帧水位），「账号与外观」给身份、主题与登出；不含用量统计与数据库写入。
7. **备份、恢复与基线。** `scripts/p7/storage/snapshot.ts` 用 `VACUUM INTO` 做一致备份（含 WAL 已提交事务），`restore` 校验后原子改名并拒绝已有目标；`p7-service-baseline` 量 5 个本地端点 p50/p95、日志 512 帧分页、outbox 4 MiB/1 MiB 水位。
8. **Pi 资源继承有明确边界。** 默认不继承宿主 extensions/themes/context files/skills/prompt templates；`SPROUT_PI_INHERIT_HOST_RESOURCES` 打开后只多两个宿主根，且真正生效的只有 skills（产品路径 `expandPromptTemplates: false`）。
9. **`sprout_status` 可达且说真话。** 真实 Pi 会话里可调用，报真实 `worker.pid`、`worker.loader`、`piSession.id`、`toolCount`；P1 的 `"unimplemented"` 假事实已替换为逐事实对账。
10. **三条跨章页面裁定。** 被服务端拒绝的动作不渲染（不置灰、不打印 reason/code）、Task 目标与要求与清单文字都在原地编辑、Info Hub 轮询状态行只在异常时出现一句人话。

明确不在 P7：真机（iOS/Android 物理设备）证据、跨机恢复、真实磁盘满与断电、付费模型路由（MANUAL `p6a-live-routing`）、多人并发治理、Worker 失联后的租约自动回收、离线写队列、用量统计。

## 怎么验的

| 门禁                         | 覆盖什么                                                                                                                                                                            | 重跑                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `p7-client-navigation`       | 登录后回到原目标（含深链带 search/hash）、`safeReturnTarget` 的拒绝清单逐条、前进后退与刷新、详情 URL 直达、`/login` 保持裸路径                                                     | `bash scripts/verify/p7-client-navigation.sh`  |
| `p7-client-pwa`              | 生产构建下的 manifest 与 service worker 注册、应用壳离线可用、白名单读命中缓存带 `x-sprout-offline`、写入不被 service worker 接管、主题色随主题                                     | `bash scripts/verify/p7-client-pwa.sh`         |
| `p7-client-states`           | 三态动作结果（成功/失败/未知）在真实页面上的呈现、断线与恢复、旧数据标注、窄屏布局                                                                                                  | `bash scripts/verify/p7-client-states.sh`      |
| `p7-loop-multiround`         | 真实 macOS Worker + 真实 Pi SDK：同一条 run 上五轮人类介入、停止后不再接受轮次、上下文与 Task 归属保持、超长与空消息在 HTTP 边界被拒（LOCAL）                                       | `bash scripts/verify/p7-loop-multiround.sh`    |
| `p7-loop-collaboration`      | 群聊扇出恰好一次、租约冲突、交接链（pending → fence → revoked → 旧持有者失权）、DM 跨对话越界一律 `not_found`                                                                       | `bash scripts/verify/p7-loop-collaboration.sh` |
| `p7-loop-runtime`            | 空闲 → 自动新 run → 人类插入让位、投递一次且幂等、暂停后不再检查                                                                                                                    | `bash scripts/verify/p7-loop-runtime.sh`       |
| `p7-loop-restart`            | 真实 SIGKILL 崩溃 + 重启：在途 run 一律 `interrupted`，第二次重启不重复推进                                                                                                         | `bash scripts/verify/p7-loop-restart.sh`       |
| `p7-storage-recovery`        | 空库→0028、0025 历史库升级、重跑幂等、备份期间并发写入的分组原子性、`cp` 主库反证、全新目录恢复启动、旧 run/execution 非成功、诊断关联链                                            | `bash scripts/verify/p7-storage-recovery.sh`   |
| `p7-service-baseline`        | 5 个本地端点 p50/p95、日志 512 帧 × 1 KiB 分页完整性与延迟、outbox 4 MiB 高水位与 1 MiB 低水位回落                                                                                  | `bash scripts/verify/p7-service-baseline.sh`   |
| `p7-pi-inheritance`          | 默认工具面 30 个逐条、宿主目录 10 个文件哈希前后一致、开关打开只多两个宿主根且系统提示 148→821 字符、`sprout_status` 在工具面上（LOCAL）                                            | `bash scripts/verify/p7-pi-inheritance.sh`     |
| `bf-p6b-pages`（含接线断言） | 真实页面接线：Chat 页出现 `automation-card` 且没有 `automation-unavailable`、轮询正常态不渲染状态行、not_found 走页面自己的错误态                                                   | `bash scripts/verify/bf-p6b-pages.sh`          |
| 回归                         | `i-chat`（not_found 深链）、`aq-p4d-pages`（读失败保留旧事实并标未确认）、`ag-execution-wiring-ui`（读日志失败可见）、`as-p5b-task-pages`、`p6a-pages`、`k-acceptance`、`b-tooling` | 各自 `bash scripts/verify/<id>.sh`             |

门禁总数 98（CI 73 + LOCAL 24 + MANUAL 1），与 [验证约定](../verification.md) 的记录一致。

## 功能线证据

- **登录后目标恢复**：`p7-client-navigation` 逐条喂 `safeReturnTarget`（`//evil`、`/\evil`、含控制字符、`https://evil.invalid`、`/login`、`/api/x`）都退回 `/`，合法深链保留 `search` 与 `hash`；浏览器里从任务详情深链登录后回到同一地址。
- **只读离线**：`p7-client-pwa` 装 service worker 后断网，应用壳仍渲染，白名单读返回缓存并带 `x-sprout-offline: 1`；写请求在断网时不被 service worker 接管（浏览器直接失败），页面显示「未知」而不是成功。
- **自动接续接线**：`bf-p6b-pages` 的 `automation_panel_wired_on_real_chat` 断言真实 Chat 页 `automation-card` 出现且 `automation-unavailable` 为 0；`p6a-pages` 125 组断言三态渲染与失败文案。
- **判定器可用性**：`tests/p6a-contracts.test.ts` 覆盖无配置、缺凭据、可用三种输入下的 `wakeProviderAvailabilityFromEnv()` 结果；`p6a-pages` 断言 `wake-provider-unwired` 与 `wake-provider-unavailable` 两种形态与保存按钮数量。
- **闭环**：`p7-loop-*` 四条在真实 SQLite 与真实 Worker 上跑多轮、扇出、交接、崩溃重启；`p7-loop-multiround` 的 `paid-model-calls=0`（模型由 `model-fixture` 在回环上代答）。

证据提交 `e338ffa`：重跑 `bash scripts/verify/p7-client-navigation.sh`、`bash scripts/verify/p7-client-pwa.sh`、`bash scripts/verify/p7-client-states.sh`、`bash scripts/verify/p7-loop-multiround.sh`、`bash scripts/verify/bf-p6b-pages.sh`。

## UI 线证据

页面由 P7 的接线单元实现，并按 Human 在真实页面上给出的两轮反馈修正：

- **导航与入口**：`app-shell.tsx` 打开 Projects、Agents、Machines、Management 四个入口，Management 不再是禁用项；主题切换与窄屏折叠在 `p7-client-navigation` 与 `p7-client-states` 里核对。
- **深链与返回**：详情页 URL 直达、刷新后仍在原处、窄屏列表→详情→返回逐条走通。
- **PWA**：`manifest.webmanifest` 可安装，独立窗口打开后应用壳可用，主题色随浅暗主题变化（`THEME_COLOR`）。
- **Human 反馈的落地**：Task 详情把「目标与要求」的铅笔放到标题同一行（中心线差 < 8px，`metadata_edit_shares_the_heading_row`）、清单行的铅笔与 `x` 就地换成「确认/取消」、被拒动作完全不渲染、Info Hub 轮询正常态不渲染状态行、判定器不可用说现状、自动接续面板显示真实判定。
- **Management**：服务与数据、账号与外观两张卡片，Human 评审时表示「先这么着，后续再优化」，本轮不再调整布局。

页面形状由 Human 在真实页面上逐条确认过（两轮反馈共 15 条），但**没有真机证据**，见下节。

证据提交 `e338ffa`：重跑 `bash scripts/verify/p7-client-states.sh`、`bash scripts/verify/as-p5b-task-pages.sh`、`bash scripts/verify/p6a-pages.sh`。

## 集成线与技术验收证据

- **上一轮独立验收**（受验 `53d23e9`）判「需修复后再验」，指出 3 条 P7 引入的回归（`i-chat`、`aq-p4d-pages`、`ag-execution-wiring-ui`）、3 处改坏没被抓到、3 条 main 上就红的旧门禁。三条回归的根因与修法：

| 回归                                       | 根因                                                                                   | 修法                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `i-chat` 的 `missing_chat_shows_not_found` | `info-hub-live.tsx` 对 `not_found` 用提示替换整页 children，页面自己的错误态渲染不出来 | 提示与 children 并列，`not_found` 交给页面错误态（`fc9b8a5`）                        |
| `aq-p4d-pages` 的「刷新失败标未确认」      | `sw.js` 把非 GET 一律 `respondWith` 再 `fetch`，浏览器侧的中止打不到真实请求           | 白名单在 `activate` 装进内存，只接管白名单调用，其余放行（`6227b17`）                |
| `ag-execution-wiring-ui` 的读日志失败      | 同上（`readExecutionLogFn` 在白名单里）                                                | 该门禁上下文 `serviceWorkers: "block"`，PWA 行为由 `p7-client-pwa` 证明（`e338ffa`） |

- **补上的门禁**：`info_hub_polling_line_stays_quiet`（去掉 `QUIET_STATES` 判断立即红）、`metadata_edit_shares_the_heading_row`（用 `boundingBox` 量中心线）、`non_owner_agent_denials_are_real_capabilities`（改成断言 `task-action-*` 数量为 0 且整页无 denial code）、`automation_panel_wired_on_real_chat`（真实 Chat 页不得出现 `automation-unavailable`）。
- **drizzle 快照**：`0028_snapshot.json` 的 `prevId` 曾指向 0026 且 `chat_automation_control` 是 0027 重建前旧版，导致 `drizzle-kit` collision 与 `c-data-auth` 长期红。修法是只改快照（`prevId` + 表内容），不改 `_journal.json` 的 `when`（改晚会让已应用过 0028 的库重放它，撞 `table turn_context already exists`）。验证：`pnpm exec drizzle-kit generate` 输出 `No schema changes, nothing to migrate`，`c-data-auth` exit 0。
- **增量验收**：`p7-acceptance2`（受验 `integration/p7` 当前头）复核三条回归是否真修好、三处改坏是否已被门禁守住、三条旧红门禁的现状。结论见编排目录的验收报告（不进本仓库）。

证据提交 `e338ffa`：重跑 `bash scripts/verify/i-chat.sh`、`bash scripts/verify/aq-p4d-pages.sh`、`bash scripts/verify/ag-execution-wiring-ui.sh`、`bash scripts/verify/c-data-auth.sh`。

## 已知限制与未证明项

1. **没有真机证据。** 手机相关结论全部来自 Chromium 视口模拟（宽 390×844），没有 iOS Safari 或 Android Chrome 的物理设备、软键盘、真实滚动惯性。I-P7 第 4 条与 UI-P7 第 4 条因此保持未勾选。
2. **跨机与现场恢复未验证。** 只在本机全新目录恢复并启动；没有第二台机器、不同文件系统、网络挂载，也没有 ENOSPC、`fsync` 失败、VACUUM 过程中断电。Worker 的 journal/结果文件、Git checkout、模型 session 文件都在库外，不在备份范围。
3. **性能基线是单机单请求。** 5 个端点、并发 1、keep-alive、单机 M4；没有并发吞吐、冷缓存、跨网络、鉴权失败、写请求。数字写进 `.verify/p7-service-baseline.json`，不设产品 SLA。
4. **付费模型路由未验。** `p7-loop-multiround` 只跑 `model-fixture`（`paid-model-calls=0`）；真实 provider 表现属 MANUAL `p6a-live-routing`。
5. **Pi 继承只测了合成宿主目录。** 真实 `~/.pi/agent` 里的技能可能有非法 frontmatter、重名、超大正文；prompt templates 在产品路径上实际不可用（`expandPromptTemplates: false`）；只在 macOS + Pi 1.4.0 上验证。
6. **并发上限只有可测口径。** 产品没有「同时运行 Agent 数」的封顶，只声明并实测每 instance 在途 run = 1、消息 8000 字、扇出 = 点名 Agent 数；「超过 N 个明确拒绝」不存在，这是缺口不是通过。
7. **重启语义是「都不继续」。** `queued` 与 `running` 一律 `interrupted`；Worker 失联后的租约自动回收与冻结契约冲突，未实现也未改契约。
8. **离线只有读。** 没有离线写队列，断线时的执行动作不可用；缓存命中的读标为未确认，不代表服务端现状。
9. **诊断过滤入口有限。** `/api/diagnostics` 只支持 `requestId`/`projectId`，没有 Chat/run/execution 的 HTTP 过滤入口。
10. **三条 main 上就红的旧门禁**（`x-remote-tools`、`ae-remote-tools-cancel-log`、`z-lease-integration`）不是 P7 引入，状态与归属以增量验收报告为准。

## human-体验确认

Human 在真实页面上做了两轮评审，共 15 条反馈，逐条落地并回写，最后以「评审完毕，可继续」结束评审：

- 第一轮 8 条：内部元数据行不显示、判定器不可用说人话、Task 详情头部间距、目标与要求就地编辑、被拒动作不渲染、清单能否被 Agent 操作（答：可以）、清单编辑图标位置、Management 先不优化。
- 第二轮 7 条：清单编辑与移除的按钮位置与就地确认、编辑按钮与「目标与要求」同行、自动接续面板在真实页面上显示真实判定、任务页其余细节。

确认范围限于上述页面与交互。**仍未确认的部分**：真机（软键盘、滚动、输入区）、PWA 安装后的独立窗口在真实设备上的表现、以及 P5b/P6a/P6b/P6c 各章此前的 Human 体验确认记录（本章未代填）。所以本章只勾选第 1 条（功能线）。第 2 条（UI 线交付就绪）因为 UI-P7 第 4 条（真实手机）未勾而保持未勾，第 3 条等增量独立验收出结论，第 4 条（Human 确认）等真机与前述各章记录齐备。

本章**不写** `确认记录：Human 亲自体验确认通过` 这一行：Human 的评审结束信号针对的是页面与交互，不含真机，也尚未补齐 P5b/P6a/P6b/P6c 各章的人类确认记录。补齐之后由 Human 明确确认，再按格式补记版本。
