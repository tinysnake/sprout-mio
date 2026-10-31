# P6b 生产接线报告（p6b-wiring）

状态：**接线完成并通过验收门禁**。轮询真的挂在两个真实页面上，轮初块按明确 runId 读持久化快照，
Agent 视角有生产入口，Machine 摘要与 MachineDetail 已拆开，三条已知回归修到绿，全仓 typecheck 归零。
一个遗留阻塞在 `scripts/verify/lib/*.mjs`（属协调者）：官方 runner 的 sandbox 允许列表不含本门禁。

分支：`p6b/wiring`，base `integration/p6b` @ `ed37485`。

## 1. 接线点清单

### 1.1 轮询真的挂上页面（一个页面一个 owner）

| 位置 | 改了什么 |
| --- | --- |
| `src/components/info-hub/info-hub-live.tsx`（新） | `InfoHubLiveProvider` 是页面唯一的 `useInfoHubPolling` 调用者；`InfoHubPollingStatus` 输出 `info-hub-polling-state`（`data-state` / `data-as-of`）；`unwrapRefreshResult` 把 server function 的 `{ok,...}` 边界解成 controller 要的视图判别联合，失败收成一次失败刷新（controller 负责 3→6→12→24→30s 退避）。transport 由路由注入，组件不自选链路。 |
| `src/routes/_authed/projects.$projectId.chats.tsx` | 页面级 provider：选中 Chat 时 scope = `{view:"chat", chatId, section:"runs"}`，列表页 scope = `{view:"project", section:"chats"}`；`refresh` = `refreshInfoHubFn`（真实 server function）。轮询结果经 `ChatListLive` / 详情路由的 `mergeChatRuns` 合并，只有这两处消费，不会各起一份。 |
| `src/routes/_authed/projects.$projectId.chats.$chatId.tsx` | 中栏 `ChatPane` 消费同一 provider 的活动 run 切片（`mergeChatRuns`），不新建 refresher。轮初块改按 runId 读（见 1.2）。 |
| `src/routes/_authed/projects.$projectId.settings.tsx` | 页面级 provider：scope = `{view:"project", section:"machines"}`（这一页唯一会自己变的 Hub 事实是租约占用），`InfoHubPollingStatus` 常显；`mergeProjectMachines` 只替换 machines 与它们的租约，未出现在刷新结果里的租约行继续沿用 loader。 |
| `src/components/info-hub/merge-info-hub.ts`（新） | 三个纯函数 `mergeChatRuns` / `mergeProjectChats` / `mergeProjectMachines`：都校验 scope（view+section+projectId/chatId）后才替换对应那一节，其它事实继续来自 loader。不做「拼一个看起来更完整的新视图」。 |

`INFO_HUB_POLLING` 的每个取值都有真实页面证据，不是只有 controller 单测：

- `intervalMs` / `jitterRatio`：稳态间隔实测 2753–3213ms（3s ±10%）。
- `maxInFlight` 单请求在途：controller 的 `inFlight` 守卫原样使用，未改；实测 9.6s 窗口内只有 3 次请求（一份 owner 的节奏，若每组件一份会是 6–8 次）。
- `pauseWhenHidden`：CDP 改 `visibilityState=hidden` 后 5103ms 零请求。
- `refreshImmediatelyOnVisible` + `fullRefreshOnResume`：恢复可见 2ms 后立即 1 次请求，且请求体不带 `knownRevision`（全量）。
- 退避到 30s 封顶、offline 暂停、`requestTimeoutMs`：controller 逻辑未改，仍由 `tests/p6b-polling.test.ts`（fake clock）覆盖；本单元未新增真实页面退避证据（见遗留问题）。
- scope 卸载清理（`abortOnScopeChange`）：provider 换 scope 就换 refresher（`useInfoHubPolling` 以 `JSON.stringify(input)` 为 key），旧 effect 清理会 `inFlight.abort()`；页面侧再用 scope 字符串把上一 scope 的视图作废，A 的慢响应不会渲染成 B 的事实。
- 合并/去重的 `hintMergeWindowMs` / `hintMinimumIntervalMs`：那是 run 内 Agent 提示通道（`InfoHubHintChannel`），不属于 Human 页面，见 §5。

TanStack RPC 的 AbortSignal 签名已核对：`@tanstack/start-client-core@1.170.37` 的
`FetcherBaseOptions` 有 `signal?: AbortSignal`，所以 `refreshInfoHubFn({ data, signal })` 是文档支持的用法，
不是假设。

### 1.2 轮初上下文按明确 runId 读

| 位置 | 改了什么 |
| --- | --- |
| `src/routes/_authed/projects.$projectId.chats.$chatId.tsx` | loader 先取这条 Chat 自己的 run 列表，选「第一个排队/运行中的 run，否则最近一条」，再用这个明确 `runId` 调 `readTurnContextFn`。没有可读 run 时传 `null`（连 runId 都没有），不再把 `not_captured` 编成 `turn_context_unavailable` 错误，也不再查「Chat 的第一个分身」。 |
| `src/components/chat/chat-loader.ts` | `turnStart: InfoHubResult<TurnStartContext>` → `turnContext: InfoHubResult<TurnContextReadResult> \| null`，语义写进类型注释：`null` = 没有 run，`not_captured` = 这个 run 还没被宿主捕获，两者都不是错误。 |
| `src/components/info-hub/chat-activity.tsx`（新） | 活动区唯一入口：`RunFactsBlock` 常显（宿主状态/活动 run/最近 run 聚合），轮初块只在 `kind === "captured"` 时拿到 `record`，`not_captured`/`null` 走空态；RPC 真失败才显示 `info-hub-turn-context-error`。 |
| `src/components/chat/chat-details.tsx`、`src/components/info-hub/chat-inspector.tsx` | 去掉 `!turnStart.ok ? 错误 : (run 事实 + 快照)` 的嵌套：旧写法在「没有快照」时把 run 事实一起藏掉（这就是 `j-info-hub` 两条红的根因）。现在 run 事实与轮初块各自独立。 |
| `src/components/info-hub/run-facts.tsx` | 抽出 `TurnPromptInjectionFact`：`injectedIntoPrompt` 是契约里已有的、由 submitted 收据推出的布尔（`turnStartContextSchema` 的 refine 要求 `injectedIntoPrompt === (deliveryState === "submitted")`），用它渲染，不再用 `deliveryState + submittedAt` 手写判断。 |

轮初块状态矩阵（真实页面 + 组件门禁都覆盖）：

| 快照 | deliveryState | 块内容 | `info-turn-prompt-injection` |
| --- | --- | --- | --- |
| 无（`null` / `not_captured`） | — | `info-turn-context-empty`「还没有本轮上下文快照。」 | 「注入模型 prompt：否 · 本次上下文尚无提交收据。」 |
| captured | prepared | 全量事实，「已准备，待提交」 | 「注入模型 prompt：否 · 本次上下文尚无提交收据。」 |
| captured | submitted | 全量事实 + `submittedAt` | 「已注入；…收据只确认提交，不表示模型已理解。」 |
| captured | failed | 全量事实 + 失败原因 | 「注入模型 prompt：否 · 本次上下文尚无提交收据。」 |

### 1.3 Agent 视角有生产入口

| 位置 | 改了什么 |
| --- | --- |
| `src/domain/info-hub.ts` | 新增 `getAgentInfo(projectId, agentProfileId, ctx)`：用同一批投影组装 `agentInfoViewSchema`（`hub.agents.agents` + `projectRuns` + `runsView` + `agent_instance` × 租约摘要），最后过契约解析。分身清单来自 `agent_instance` 本身，**不是**由「持有租约的分身」倒推。 |
| `src/contracts/info-hub-query.ts` | 新增 `agentInfoHubInputSchema`（`projectId` + `agentProfileId`）。只有对象参数，不分节——原因见下面「缺的查询」。 |
| `src/server/functions/info-hub.ts` | 新增 `getAgentInfoHubBoundary` / `getAgentInfoHubFn`（沿用同一 `infoHubBoundary` 的会话、权限、错误映射）。 |
| `src/components/info-hub/project-agents-panel.tsx` | Project settings 的 Agent 成员行新增「查看 Agent 视角」入口（`info-agent-view-toggle`），点开才查询，渲染 `AgentInfoPanel`（status / 活动 run / 分身与租约三事实分离）。查询函数由路由注入，组件不选 transport，dev fixture 场景因此不需要假 transport。 |
| `src/routes/_authed/projects.$projectId.settings.tsx` | 注入 `loadAgentView={(agentProfileId) => getAgentInfoHubFn({ data: { projectId, agentProfileId } })}`。 |

**缺的查询与需要的形状（透明记录）**：冻结的 `infoHubQuerySchema` 里 `{view:"agent", section:"runs"}`
只返回**活动** run，`AgentInfoView.runs` 需要 `{available, hostEnabled, active, recent}`。也就是说按节拼不出
「这个 Agent 最近 5 条历史 run」。分身的缺口不存在：`{view:"agent", section:"instances"}` 已经是从
`agent_instance` 读的完整清单。两个可选的后续形状（都需要协调者改冻结契约，本单元没有改）：

1. `{view:"agent", section:"runs"}` 改为返回 `AgentRunsView`（含 `hostEnabled` 与 settled recent），
2. 或加第 5 个 section `"overview"` 直接返回 `agentInfoViewSchema`。

本单元采用的第三条路是不动冻结的 query 联合，新增一个只做组装的投影 + server function：事实来源与
其它四视角完全相同，没有新增 SQL 事实、没有绕过 `assertProjectAccess`。

### 1.4 Machine summary 与 MachineDetail 拆开

`InfoHubMachineSummary`（Project/Agent/Chat 视角里的摘要：`machineId`、连接、租约）不再当
`MachineDetail`（`machine`、`enrollmentStatus`、`capability`、`bindings`）用。四处调用方改为读同一份
`listMachinesFn` 的详情：

| 调用方 | 之前 | 现在 |
| --- | --- | --- |
| `projects.$projectId.chats.tsx` → `ChatMachineFacts` | `infoHub.data.machines` | loader 新增 `listMachinesFn`，`machines: machines.data` |
| `projects.$projectId.settings.tsx` → `MembershipSections` | `infoHub.data.machines` | `machines.data`（关系/绑定/工作目录真的是详情事实） |
| `projects.$projectId.settings.tsx` → `RemoteExecutionList` | `infoHub.data.machines` | `machines.data` |
| `projects.$projectId.tasks.$taskId.tsx` → `LeaseOverview` | `infoHub.data.machines` | loader 新增 `listMachinesFn`，`machines.data` |

行为不变的部分：租约操作入口、`LeaseOverview` 的摘要与空态、`holderNames` 仍取 Project 视图的租约；
`InfoHubMachineSummary` 继续只喂 Info Hub 自己的机器面板（`ProjectMachinesPanel` 本来就要求详情，
它没有接线的调用方，保持原样）。顺带修好了 `as-p5b-task-pages` 的超时：`LeaseOverview` 用摘要投影时
`machines.find(m => m.machine.id === …)` 会读到 `undefined.machine` 抛错，把 Task 详情页整块渲染打断，
完成结果条随之消失；换成详情后完成结果条恢复常显。

## 2. 轮初块之外的回归修复

1. `j-info-hub` `hub_agents_panel_lists_only_member_with_dm_link`：根因不是 DM 链接消失，而是 P6b 把
   `personaSummary` 换成了 `jobTitle`（旧契约 `projectAgentEntrySchema` 只有 `personaSummary`）。
   现在契约同时带 `personaSummary`（≤600 字，投影取 `agent_profile.persona`）与 `jobTitle`，面板两行都渲染
   （`info-agent-persona-summary` / `info-agent-job-title`），DM 链接与 `data-chat-id` 原样保留。
   `tests/p6b-contracts.test.ts` 新增一条「人设与职位是两个并列的列表事实」。
2. `j-info-hub` `chat_info_panel_matches_page`：`run 视角宿主 undefined` 与 `turnInjection undefined` 同一个根因——
   「没有快照」时把 run 事实一起藏掉（见 §1.2 的重构）。
3. `as-p5b-task-pages`：见 §1.4。
4. `q-info-hub-runs` 的旧断言（真实语义变化，明确改写，没有放宽）：
   - 旧：`assert.match(textContent, /注入模型 prompt：否/)`
   - 新：`assert.match(injection, /本次上下文尚无提交收据/)` **且** `assert.doesNotMatch(injection, /已注入/)`
   - 为什么变：P6a/P6b 把「永远声明不注入模型 prompt」换成了「按 runId 的持久化提交收据」。prepared 快照没有
     收据，所以既不能说已注入，也必须明确说「尚无提交收据」。submitted 收据展示提交事实由
     `tests/fixtures/p6b-turn-context.ts`（`confirmTurnContext` 后 `injectedIntoPrompt === true`）与
     `bf-p6b-pages` 的 `${width}_submitted_has_receipt`（三个视口）证明。
5. `j-info-hub` 与 `k-acceptance` 仍在断言的 `/注入模型 prompt：否/` 没有放宽：prepared/无快照的文案保留了这个
   事实，只是追加了「· 本次上下文尚无提交收据」。既有的「不注入」事实与新收据事实同时在场。

## 3. 门禁

### 3.1 新增的三组门禁断言（`scripts/verify/bf-p6b-pages.sh`）

脚本现在是两段：原有 fixture/组件门禁（`tests/fixtures/p6b-pages.ts`，27 组，跑完仍打印
`P6b pages: 27 assertion groups passed`），加上新增的真实生产页面门禁
`scripts/verify/p6b-wiring-pages.mjs`（10 组）。新门禁自己构建生产包（`prepare.mjs server`）、起真实服务器、
私有 SQLite、真实 Chromium，用 `server function id` 过滤请求，只数 `refreshInfoHubFn`。

**实测证据（最近一次运行）**：

| 组 | 数字 |
| --- | --- |
| `chat_page_polls_within_3s` | 进 Chat 页后 **26ms** 发出第一次 refresh 请求；页面上只有 1 个 `info-hub-polling-state`（一个 owner） |
| `polling_interval_respects_3s_with_revision` | 稳态间隔 **2985ms**；请求体 `k:["projectId","query","knownRevision"]`（第二次起增量） |
| `hidden_5100ms_zero_refresh_requests` | CDP 置 hidden 后 **5103ms 零请求** |
| `visible_resume_single_full_refresh` | 恢复可见 **2ms** 后一次请求，请求体不含 `knownRevision`（全量） |
| `one_polling_stream_per_page` | 9.6s 窗口 **3 次**请求，间隔 **2717ms / 3159ms**（一份 owner 的 3s 节奏；多次运行的间隔都在 2.7–3.3s 抖动区间内） |
| `turn_block_prepared_has_no_injection_claim` | 文案 = `注入模型 prompt：否 · 本次上下文尚无提交收据。`；无「已注入」；`info-turn-context-empty` 在场；`info-chat-runs-host-status` 与 `info-chat-runs-active` 同时在面板上（新事实不挤掉旧事实）；全页无「合并 N 条」字样 |
| `settings_page_single_owner_polls` | 首次 2817ms，偏移 2817 / 5717 / 8459，间隔 **2900 / 2742ms**，全部带 `knownRevision` |
| `no_console_errors` | 0 |
| `real_server_ready` / `real_chat_page_reached` | 端口 3300（运行时挑空闲），真实登录/建 Project/建 Agent/加入/起 DM |

关于 gate (b) 的 submitted 半边：真实服务器页面没有 SDK 提交收据的来源（本门禁不启动 pi host），
所以「submitted 收据存在时展示事实」由组件层（`bf-p6b-pages` 的 `submitted_has_receipt`，三视口真实渲染）
与契约层（`tests/fixtures/p6b-turn-context.ts`）证明，真实页面这一侧只证明 prepared/无快照时没有「已注入」。
这一点写在门禁输出的 `submittedCase` 字段里，不是隐含假设。

### 3.2 退出码

直接 `bash scripts/verify/<gate>.sh`（本机 env）：

| 门禁 | 退出码 | 断言/证据 |
| --- | --- | --- |
| `bf-p6b-pages` | 0 | 27 组 fixture + 10 组真实页面 = 37（最终一轮：`27 assertion groups` + `10 assertion groups in a real page`） |
| `as-p5b-task-pages` | 0 | 19 checks |
| `p6a-pages` | 0 | 143 groups |
| `i6-chat-info` | 0 | 4 checks |
| `j-info-hub` | 0 | 7 gate 断言 + browser 9/9（修前 7/9） |
| `q-info-hub-runs` | 0 | 12 PASS（含真实 Chromium 渲染一轮，含改写后的注入断言） |
| `as-p5a-chat-ui` | 0 | 30 browser assertions + build/server/sqlite |
| `p6a-routing` | 0 | 305 assertions |
| `p6a-integration` | 0 | 13 assertions |
| 额外：`k-acceptance` | 0（在官方 runner env 下） | runner 37.8s |
| 额外：`bf-p6b-info` / `bf-p6b-turn-context` / `bf-p6b-agent-tool` | 0 / 0 / 0 | 29 / 42 / 24 assertions |

官方 runner（`node scripts/verify/runner.mjs --only …`，注入 `SPROUT_PI_ENABLED=false`）：13 个里 **10 PASS 3 FAIL**，
3 个失败都不是断言失败，而是登记问题：

```
FAIL bf-p6b-pages     109ms exit=1   verification sandbox: Usage: sandbox.mjs --gate <supported gate> -- <gateScriptPath>
FAIL p6a-pages        103ms exit=1   同上
FAIL as-p5b-task-pages 99ms exit=1   同上
```

`scripts/verify/lib/suite-plan.mjs` 给这三个门禁写了 `sandbox: true`，而
`scripts/verify/lib/sandbox.mjs` 的 `gates` 允许列表只有 `a-base, b-tooling, c-data-auth, d-runtime,
ad-execution-log-ui, y-lease-ui, t-machine-worker`。这不是本单元的产物（`bf-p6b-pages` 的登记和
`as-p5b`/`p6a-pages` 的 `sandbox: true` 都在 `integration/p6b` 之前就在），按 brief 的边界
「不改 `scripts/verify/lib/*.mjs`（协调者改）」留给你。两种一行修法：把这三个 id 加进 `sandbox.mjs` 的 `gates`，
或把 `suite-plan` 里这三处 `sandbox: true` 改成共享只读模式。裸跑三个门禁都是绿的（上表）。

## 4. Human 提示收据：P6b 不交付

结论：**不交付 Human 提示收据，也不在契约上补「本页提示合并/去重」事实**。理由：

1. 现有唯一的 hint 通道是 `infoHubHintSchema` + `InfoHubHintChannel`（`src/domain/info-hub-hint.ts`）：
   run-local、宿主 → **运行中的 Agent run** 的临时转向输入，`deliver` 的接收者是模型 prompt 边界
   （`src/server/pi-host/run.ts`），merge/dedupe（`hintMergeWindowMs`、`hintMinimumIntervalMs`、`seen`）只为
   模型侧的单次投递服务。对 Human 页面它本来就是 `never`：没有 producer，也没有 consumer。
2. Human 页面的更新机制是轮询当前事实：`refreshInfoHub` 按 revision 回答 `changed`（完整有界视图）或
   `unchanged`。它不产生「提示」，也就没有「合并了几条」这件事。
3. `changes.length` 是 **Agent 提示里的 change 条数**，不是合并次数，也不是本页刷新次数。把它显示成
   「合并 N 条」是编数：既没有合并窗口参与（那个窗口在 run 里），也没有去重参与。
4. 要真的交付一个 Human 收据，需要把 run-local 的临时转向持久化（新表 + 生命周期 + 过期语义），
   这是 P6b 冻结范围之外的 schema 工作；而不持久化的版本只能在浏览器内存里编一个数字，正好违反
   「不许把 `changes.length` 当合并次数展示」。
5. 页面已有的诚实替代事实是传输层的：`info-hub-polling-state`（`已是最新 / 刷新中 / 页面隐藏，已暂停 /
   离线，已暂停 / 刷新失败，退避重试中` + `as-of` 事实时间）。它说的是「这份视图什么时候刷新过」，
   不是「提示合并了几条」。`bf-p6b-pages` 还加了一条否定断言：整页不得出现「合并 N 条」。

## 5. 顺序、typecheck/lint/fmt

- `pnpm typecheck`：**0 错误**（`tsc --noEmit` + worker + extension 三份）。
  修前 9 处全部归零：`tests/run-facts-summary.test.ts` 5 处（fixture 补 run 身份 `chatId`/`instanceId`/`agentProfileId`）、
  `projects.$projectId.settings.tsx` 2 处 + `projects.$projectId.chats.tsx` 1 处 + `projects.$projectId.tasks.$taskId.tsx` 1 处
  （Machine 摘要当详情用，见 §1.4）。domain 侧 11 处与 `remote-client.ts` 1 处在 `integration/p6b` 上已由 domain 单元修好，本次没有再动。
- `pnpm exec vp lint`：退出 0。改动文件 0 warning；仓库里仍有 3 处既有 warning
  （`src/worker/executions.ts`、`src/server/automation-scheduler.ts`、`src/domain/mcp/exchange.ts`）与
  `scripts/verify/ah-groups.test.mjs` 的既有 warning，不是本单元引入。
- `pnpm exec vp fmt --check`：改动文件全部通过；仓库里余下 1 个既有未格式化文件
  `src/domain/wake-providers/jev.ts`（`integration/p6b` 上就未格式化，本单元没有碰它，改它超出边界）。
- `pnpm test:ci`（`scripts/verify/lib/test-targets.mjs` 的 CI 全集展开）：**83 files / 717 tests 全绿**。
  期间修掉三条 `integration/p6b` 上的既有红：
  1. `tests/tooling.test.ts`「参与判断的时间只能注入」：`src/domain/info-hub-hint.ts` 的
     `tick(now = Date.now())` 与 `src/domain/info-hub.ts` 游标签发/校验里的 `Date.now()` 改成注入的
     `tick(at: number)` 与 `signCursor(payload, now = Date.now)` / `parseCursor(cursor, now = Date.now)`。
  2. `tests/error-mapping.test.ts` 两条 orphan-profile 探针（`infoHub × AgentError → not_found`）返回 `ok`：
     `getProjectInfoHub` 的 `project_member ⋈ agent_profile` 是 inner join，成员指向已删 profile 时会静默少一行。
     现在先数 `project_member` 行数，与 join 结果不一致就抛 `InfoHubError("not_found")`（坏引用不冒充正常事实）。

## 6. 遗留问题

1. **sandbox 允许列表**（阻塞官方 runner，属协调者）：见 §3.2。裸跑全绿。
2. **真实页面没有 submitted 收据证据**：见 §3.1 末。要补就得在门禁里起 pi host 或直接写
   `turn_context` 表造收据，前者超出本单元的运行预算，后者会绕过唯一的收据来源（`confirmTurnContext`）。
3. **退避与 401/not_found 的真实页面证据**：controller 的退避、10s 超时、offline 暂停仍只有 fake clock 单测。
   页面侧对失败只做「保留最后成功事实 + 状态行」，401 清会话范围、not_found 清对象视图没有接
   （`unwrapRefreshResult` 把任何 `!ok` 都当成一次失败刷新）。这是 P6c 级的路由职责，本单元没有改契约。
4. **Chats 页 1200ms 全 route invalidate 与 settings 的 5s invalidate 仍在**：它们服务消息流、执行状态与
   关系事实（各自职责），本单元没有合并。副作用是这些页面在活动 run 存在时会有额外 loader 请求；
   门禁选择无活动 run 的 Chat 来隔离「一份 owner」的请求计数。彻底收敛需要拆 loader（把 Info Hub 事实从
   消息/执行刷新里分出去），超出本单元。
5. **`ProjectMachinesPanel`（P6b 的机器面板组件）仍没有生产调用方**：真实页面用的是
   `MembershipSections` + `LeaseOverview`（j-info-hub 断言的 `info-hub-project-machines` 就来自那里）。
   把两者合成一个面板会动 P4b 的关系/移出入口，本单元没有做。
6. **settings 的轮询 scope 只覆盖 Machines**：Agent status 与 Task 计数仍靠 loader 刷新。一轮只刷一个节是
   设计 §6 的选择（「当前已展开/正在使用的视角」），如果要同时刷 agents，需要两个 scope 的 provider
   （两个 owner）或一个批量节，属契约变更。
