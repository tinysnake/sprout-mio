# P3 Info Hub run 视角与轮初上下文

本 unit 把 P2 标为「未实现」的 run 视角变成真实数据：Project → Agents 视角与 Conversation → 自身与成员视角都给出该范围内的宿主启用状态、活动 run、最近 run 与失败错误，以及每轮分析的仓库依据。新增「轮初必要上下文」查询并在对话页呈现。全部事实来自领域查询（`listAgentRuns`/`listAgentRunInputs`/`getRunRepoBasis`/`getProjectRepoState`），不在页面层重拼状态；本 unit 只读已有表，未新增 schema。

## 契约变化

`src/contracts/info-hub.ts`：

- `unavailableFeatureSchema` 保留，继续表达 Machine 等未实现视角。
- 新增 `agentRunsViewSchema`（run 视角，`available: true`）、`infoHubRunSummarySchema`、`infoHubRunRepoSchema`、`turnWorkspaceSchema`、`turnStartContextSchema`。
- `RUNS_UNAVAILABLE_REASON` 常量删除（run 视角已实现，无调用方）；`MACHINES_UNAVAILABLE_REASON` 不变。

`ProjectInfoHub.agents.runs` 与 `ConversationInfoView.runs` 从 `unavailableFeatureSchema` 换成 `agentRunsViewSchema`：

| 字段                     | 含义                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `available`              | 恒为 `true`（判别字段，与未实现标记同构）                                                                                       |
| `hostEnabled`            | `SPROUT_PI_ENABLED` 的解析实值                                                                                                  |
| `active[]`               | 该范围内 queued/running 的 run 摘要；conversation 视角至多一条                                                                  |
| `recent[]`               | 该范围内最近 5 个终态 run，新的在前                                                                                             |
| `active[]/recent[]` 摘要 | `runId`、`status`、`queuedAt`、`startedAt?`、`settledAt?`、`requestId`、`pendingInputs`、`errorCode?`、`errorMessage?`、`repo?` |

`pendingInputs` 是该 run 的 `agent_run_input` 中 `disposition = 'pending'` 的行数（含终态 run 上从未投递的输入），与数据库实值一致，pending 输入绝不显示为已投递。`repo` 来自该 run 的 `repo_provenance`（`getRunRepoBasis`）：`source`、`sourceKind`、`ref`、`commit`（git rev-parse 完整 SHA）、`fresh`、`recordedAt`、`fetchedAt?`。failed 的准备不会留下 provenance，因此该字段缺省而不是编造。

## 轮初必要上下文

新查询 `getTurnStartContext(conversationId, ctx)`（`src/domain/info-hub.ts`），边界 `getTurnStartContextFn`（`src/server/functions/info-hub.ts`），经 conversation 自带的 projectId 授权，越权与不存在抛 `ProjectAccessError`（`not_found`）。

| 字段                                          | 含义                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `projectId`, `conversationId`                 | 聚合归属                                                                                                   |
| `instanceId`, `agentProfileId`, `profileName` | 分身与 profile 标识；缺少分身记录时为 null（不编造）                                                       |
| `hostEnabled`                                 | 宿主 Pi 是否启用                                                                                           |
| `workspace`                                   | 本轮工作副本，见下；Project 未配置仓库且无 provenance 时为 null                                            |
| `activeRun`                                   | `{ runId, status, pendingInputs }`；无活跃 run 时为 null                                                   |
| `previousRun`                                 | 最近一个终态 run 的 `{ runId, status, requestId, settledAt?, errorCode?, errorMessage? }`；无历史时为 null |
| `injectedIntoPrompt`                          | 恒为 `z.literal(false)`，注入决定写进类型                                                                  |

`workspace.basis` 判别依据来源：活动 run 存在且有 provenance 时为 `run_provenance`（含该轮 `fresh` 与 `recordedAt`）；否则取 `repo_checkout` 的最近就绪行，basis 为 `project_checkout`（该轮尚未运行，没有 fresh 事实，`fresh` 省略，`recordedAt` 取 `resolvedAt`）。两处 `commit` 都是 git rev-parse 实值，不由宿主拼接。

### 注入决定：不注入模型 prompt

`injectedIntoPrompt` 固定为 false。理由：

1. runner 的每轮配置真值在 `open`/`ready` 快照（`configSnapshot`，含 `cwd` 与 `repo`）里，宿主准备仓库、选择 session、恢复历史都发生在 prompt 之前；把同一事实再拼成文本送进 prompt 会制造第二份真值，快照与 prompt 可能分叉。
2. 注入会改变模型可见输入，属于 a/b 已定事件语义之外的 runner 行为变化，必须配真实模型断言（如复述本轮 commit）才能声称生效；本 unit 的价值在查询与呈现，注入对它没有增益。
3. 当前消费者是 Human 页面与后续 P6（Agent 主动查询、自动接续的上下文来源）。届时若决定注入，需改 `turnStartContextSchema`（该字段不是 literal false）并在 live 脚本加真实模型断言。

## 页面

- `src/components/info-hub/run-facts.tsx`：`RunFactsBlock`（宿主启用状态、活动 run 与未投递输入、最近 run 状态与时间、失败 run 的 `errorCode：errorMessage` 与 requestId、仓库依据行）与 `TurnStartContextBlock`（工作副本、活动 run、上一次 run、注入声明）。
- `project-agents-panel.tsx` 用 `RunFactsBlock` 替换原 runs 的不可用通知（testId `info-hub-project-runs`）；Machine 的 `UnavailableNotice`（`info-hub-machines-notice`）保留。
- `conversation-info-panel.tsx` 用 `RunFactsBlock`（testId `info-conversation-runs`）与 `TurnStartContextBlock` 替换原 runs 的不可用通知；路由 loader 增取 `getTurnStartContextFn`，失败显示 `info-hub-turn-context-error`。
- pending 输入只以「N 条输入未投递」出现；没有任何文案使用「无活动 run」「0 个活动 run」这类会被读成空成功的措辞。

## 未实现项（保持显式不可用）

| 视角                          | 状态                                           | reason 指向 |
| ----------------------------- | ---------------------------------------------- | ----------- |
| Machine 连接状态与租约        | `machines: { available: false, reason }`       | P4          |
| Task / Group / Public Channel | 未接入本契约，P6 前不出现                      | P5/P6       |
| 自动接续、运行期变更提示      | 未实现（P6）                                   | P6          |
| Agent 主动查询 Info Hub       | 未实现；轮初上下文目前只供 Human 页面与后续 P6 | P6          |

## 验证记录

所有命令在本 worktree 真实运行；长命令后台执行并写 `/tmp/p3-d-*.log`。验收只用独立 `.verify` 数据库。

| 命令                                                | 退出码 | 结论与产物                                                                                               |
| --------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsc --noEmit`                            | 0      | 无错误                                                                                                   |
| `pnpm exec vp test run tests/info-hub-runs.test.ts` | 0      | 轮初上下文字段、注入声明、跨用户零泄漏、recent 与 DB 一致。`/tmp/p3-d-test-qunit.log`                    |
| `pnpm test`                                         | 0      | `/tmp/p3-d-test-all.log`                                                                                 |
| `pnpm check`                                        | 0      | `/tmp/p3-d-check.log`                                                                                    |
| `bash scripts/verify/q-info-hub-runs.sh`            | 0      | hermetic：`.verify/q-info-hub-runs/evidence.json`、`/tmp/p3-d-q.log`、截图 `docs/p3/evidence/p3-d-*.png` |
| `bash scripts/verify.sh`                            | 0      | 20 个脚本 failed=0。`/tmp/p3-d-verify.log`                                                               |
| `bash scripts/verify-live/pi-dm-turn.sh`            | 0      | 真实模型三轮复述。`.verify/live-pi-dm-turn/evidence.json`、`/tmp/p3-d-live.log`                          |

q 脚本断言清单：真实构建与生产启动、三个 server function id、领域测试先过、真实 git 秘远端的完成 run 视图 commit 等于 `git rev-parse` 实值且 `fresh=true`、SLOW run 持有期间活动视图与 `pendingInputs` 等于 DB 的 pending 行数（steer 被协议桩拒绝后输入保持 pending）、轮初上下文在运行中为 `run_provenance` basis、释放后为 `project_checkout` basis、failed run 的 `errorCode/errorMessage/requestId` 进入两个视角且不编造 repo、`machines.available=false` 且 reason 指向 P4、`injectedIntoPrompt=false`、真实 Chromium 渲染 run 事实与轮初上下文且无 console 错误、第二用户对全部三个 boundary 均 `not_found` 且响应体不含 A 的 projectId/conversationId/instanceId/run id/commit/错误原文/远端路径、SIGTERM 退出 0。

`tests/info-hub-runs.test.ts` 经 boundary 直接驱动：未登录 `unauthorized`；越权 `not_found` 且不泄漏 profile 名、id、对话与分身标识；无 run 时 `activeRun.pendingInputs=2`、`previousRun=null`、未配置仓库时 `workspace=null`；`transitionAgentRun` 置 failed 后 `previousRun` 的错误与 requestId 等于 `agent_run` 行实值；插入就绪 checkout 行后 `workspace.basis=project_checkout` 且 commit 透传；`injectedIntoPrompt` 恒 false。

## SO17 断言更新

| 文件与位置                                                                       | 原文                                                                                   | 新文                                                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/browser/k-acceptance-flow.mjs`（`unavailable()`，project 分支）         | `sameText(page, "info-hub-runs-notice-badge", "未实现")` + reason 匹配 `/P3/`          | `sameText(page, "info-hub-project-runs-host-status", "宿主未启用")` + `info-hub-project-runs-active` 存在；Machine 断言不变      |
| `scripts/browser/k-acceptance-flow.mjs`（`unavailable()`，conversation 分支）    | `sameText(page, "info-conversation-runs-notice-badge", "未实现")` + reason 匹配 `/P3/` | `sameText(page, "info-conversation-runs-host-status", "宿主未启用")` + `info-turn-prompt-injection` 匹配 `/注入模型 prompt：否/` |
| `scripts/browser/j-info-hub-flow.mjs`（`unavailable_notices_render_explicitly`） | 双 badge「未实现」+ runs reason 匹配 `/P3/`                                            | 仅 machines badge「未实现」+ reason `/P4/`；runs 断言宿主状态与真实活动 run 文案（`排队中`/`运行中` 且含「未投递」）                                              |
| `scripts/browser/j-info-hub-flow.mjs`（`conversation_info_panel_matches_page`）  | `runsReason` 匹配 `/P3/`                                                               | `runsHostStatus` 匹配 `/宿主(已\|未)启用/` 且 `turnInjection` 匹配 `/注入模型 prompt：否/`                                       |
| `tests/info-hub.test.ts`（「显式不可用」测试）                                   | `runs.available === false` + reason 含 P3（两视角）                                    | `runs.available === true`、`active` 长度 1 且 `pendingInputs=2`、`recent` 为空、machines 断言不变                                |
| `scripts/verify/o-turn-semantics.sh`（running + pending 的 UI 断言）               | `assert(!bodyText.includes('已完成'), 'pending input must never be displayed as processed')`（整页文本包含） | 保留意图、改精确：`info-conversation-runs-active-status` 必须是「排队中」或「运行中」，且 `info-turn-active-run` 含「条输入未投递」；被 Info Hub recent 中真实的历史已完成 run 打破 |

被打破的原因相同：本 unit 把 run 视角从 `unavailableFeatureSchema` 换成真实数据视图。j 流程与 o 脚本的更新是 SO17 对既有验证脚本的同等适用（两者都由 `scripts/verify.sh` 收集，不更新即门禁失败），且都只改被本 unit 打破的断言、不删断言意图。

## 重跑

```sh
pnpm exec vp test run tests/info-hub-runs.test.ts tests/info-hub.test.ts
bash scripts/verify/q-info-hub-runs.sh
bash scripts/verify.sh
bash scripts/verify-live/pi-dm-turn.sh
```

## 未验证项

- 轮初上下文不注入模型 prompt（本 unit 的显式决定），因此「模型能看到该上下文」未验证也不被声称；注入属于后续决定，需改类型并加真实模型断言。
- 聚合仍按 run 逐个调用 `listAgentRunInputs`/`getRunRepoBasis`，run 很多时的性能未验证（沿用 P2 的无分页无缓存局限）。
- 活动 run 期间页面对 Info Hub 数据不轮询（loader 取数一次）；运行状态面板（p3-b）的 1.2 秒轮询只覆盖 `RunStatusPanel`，Info Hub 面板在下次导航或刷新前保持旧值，是否需要轮询属 P6 运行期提示范围。
- 同一 Project 多个 DM 同时有活动 run 时 project 视角 `active` 为多条，UI 呈现只在单 run 场景实测（q 脚本）。
- `docs/p2/info-hub.md`、`docs/p2/acceptance.md` 中「run 视角未实现」的表述需要收尾 unit 更新（本 unit 按 scope 不改 P2 文档）。
