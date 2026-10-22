# P2 Info Hub 查询模块与基础呈现

本 unit 建立 Info Hub 只读查询模块：同一 Project 内的 Project → Agents 视角与 Chat → 自身与成员视角由 `src/domain/info-hub.ts` 统一聚合，Project hub 与对话页按需取用。未实现的视角（Agent 运行状态与活动 run、Machine 与租约）以显式不可用标记呈现，不显示为空列表、0 值或成功。这是 P2 当时的状态；P3-d 已将 run 视角改为真实数据，Machine 仍属 P4，当前字段与页面见 [P3 run 视角](../p3/info-hub-runs.md#契约变化)。边界只调用 p2-a 的领域服务，不写 SQL，不改 schema；组件只消费视图对象，不自行查询。

## 模块入口与边界

契约 `src/contracts/info-hub.ts`（coordinator 一次性授权的新增文件，仅在 `src/contracts/index.ts` 加一行 export），全部从 `src/contracts/index.ts` 导出。

领域入口 `src/domain/info-hub.ts`，同步执行、只读、不写诊断：

```ts
getProjectInfoHub(projectId: string, ctx: ProjectContext): ProjectInfoHub
getChatInfo(chatId: string, ctx: ProjectContext): ChatInfoView
```

- `getProjectInfoHub` 先 `assertProjectAccess`，再组合 `listProjectMembers`、`getAgentProfile`、`listChats` 与 `listInstancesForChat`，不复制它们的过滤规则。
- `getChatInfo` 经 chat 自带的 projectId 授权（`getChat` → `assertProjectAccess`），再组合 `listChatMembers`、`listInstancesForChat`、`listMessages`。
- 越权与不存在都抛 `ProjectAccessError`（`not_found`，消息均为「对象不存在」），不泄漏其他 Project 的对象是否存在。

边界 `src/server/functions/info-hub.ts`，按「会话 → zod → 领域调用」顺序，失败以 HTTP 200 加 `AppResult` 载荷返回：

| server function       | 输入            | 领域调用            |
| --------------------- | --------------- | ------------------- |
| `getProjectInfoHubFn` | `{ projectId }` | `getProjectInfoHub` |
| `getChatInfoFn`       | `{ chatId }`    | `getChatInfo`       |

未登录返回 `unauthorized`；五个边界共用 [domain-errors.ts](../../src/server/functions/domain-errors.ts) 的一张领域错误映射表，`ProjectError`、`AgentError`、`ProjectAccessError`、`ChatError` 四类一律按原码透出。本边界调用图可达的类是 `ProjectAccessError`（`assertProjectAccess` 与 `getChat` 对不存在或越权行的拒绝，不存在的 chatId 走这条路径）与 `AgentError`（成员 profile 查询）；zod 校验失败返回 `validation_failed` 并带 `fieldErrors`；其余未知错误映射为脱敏 `internal` 并写 `info_hub.request_failed` error 诊断，data 只含 `{ code: "internal" }`。回归入口为 `tests/error-mapping.test.ts` 与 `scripts/verify/m-error-mapping.sh`。服务端专有模块只在 server function 内 `await import(...)`。

## 视图字段

`ProjectInfoHub`：

| 字段              | 含义                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`       | 聚合所属 Project                                                                                                                                            |
| `agents.agents[]` | 每个成员的 `{ agentProfileId, name, personaSummary, instanceId?, chatId? }`；后两个字段是该成员在本 Project 已建立的 DM 与分身，未发起 DM 时省略而不是 null |
| `agents.runs`     | P2 当时为 `{ available: false, reason }`，reason 指向 P3 的 agent-run 记录；P3-d 已改为 `available: true` 的真实 run 数据，Machine 仍属 P4                  |
| `machines`        | `{ available: false, reason }`，reason 指向 P4 的 Machine 与租约                                                                                            |

`personaSummary` 是 profile 人设 trim 后的前 120 字，超出部分以省略号截断，空人设返回空字符串（组件显示「（无人设）」）。

`ChatInfoView`：

| 字段                          | 含义                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `chatId`, `projectId`, `kind` | 归属与类型；P2 的 kind 只有 `"dm"`                                                                                       |
| `archived`                    | 是否已归档（`archivedAt` 存在与否），P2 恒为 false                                                                       |
| `members[]`                   | `{ memberKind, memberId, displayName }`；human 的 displayName 为 `"Human"`，agent 的为 profile 名                        |
| `instance`                    | `{ instanceId, agentProfileId, profileName }`，DM 缺少分身记录时为 `null`                                                |
| `messages`                    | `{ count, latestAt? }`；latestAt 取最后一条消息的 createdAt，无消息时省略                                                |
| `runs`                        | P2 当时为 `{ available: false, reason }`，reason 指向 P3；P3-d 已改为 `available: true` 的真实 run 数据，Machine 仍属 P4 |

## 显式不可用标记的设计理由

`docs/info-hub-decisions.md` 规定 Agent status 与按 Chat 的活动 run 列表是两项独立信息，且 P2 没有 run、没有 Machine 与租约。空数组或 0 值会被读成「无活动 run」「无 Machine」这一类成功空值，因此不可用状态用判别字段 `available: false` 加必填 `reason` 表达（`unavailableFeatureSchema`，`reason` 用 `z.string().min(1)` 禁止空字符串），导出常量 `RUNS_UNAVAILABLE_REASON` 与 `MACHINES_UNAVAILABLE_REASON` 固定文案。组件层用 `UnavailableNotice` 渲染「未实现」徽标与原因，P3/P4 接入时把该字段扩展为「不可用 | 可用视图」的联合，不需要迁移已有调用方。

以上为 P2 当时的设计。P3-d 已用真实 run 视图替换 run 的不可用字段，并删除 `RUNS_UNAVAILABLE_REASON`；Machine 仍属 P4，继续使用 `MACHINES_UNAVAILABLE_REASON` 与显式不可用通知。当前实现见 [P3 契约变化](../p3/info-hub-runs.md#契约变化)。下节与验证记录中的旧 run 通知、`runs.available === false` 是 P2 历史，相关脚本与测试已由 P3-d 按 [SO17 逐项更新](../p3/info-hub-runs.md#so17-断言更新)。

## 组件与页面接入

`src/components/info-hub/`：

- `project-agents-panel.tsx`：`ProjectAgentsPanel` 渲染成员、profile 名称、人设摘要与已有 DM 的链接（`info-agent-dm-link`），并渲染 run 事实块。
- `chat-info-panel.tsx`：`ChatInfoPanel` 渲染类型、归档状态、成员、分身身份、消息统计，并渲染 run 事实块。
- `unavailable-notice.tsx`：`UnavailableNotice` 渲染显式不可用状态（`-badge` 为「未实现」，`-reason` 为原因文案）。

页面接入（不新增路由、不新增一级导航，`src/routeTree.gen.ts` 未改）：

- Project settings `src/routes/_authed/projects.$projectId.settings.tsx`：loader 与 `getProjectFn` 并取 `getProjectInfoHubFn`；Project 事实与配置之后在折叠区渲染 `ProjectAgentsPanel` 与 `info-hub-machines-notice`，失败显示 `info-hub-error`。折叠区内渲染意味着测试需先用真实点击展开（`project-info-hub-toggle`）。
- 对话页 `src/routes/_authed/projects.$projectId.chats.$chatId.tsx`：loader 在 chat 的 projectId 与 URL 一致后并取 `getChatInfoFn`，在 inspector 里渲染 `ChatInfoPanel`，失败显示 `info-hub-chat-error`。inspector 由 `?info=1` 或页面开关恢复，测试先打开它再断言面板。
- 两页的 Info Hub 信息都只来自这两个入口；深链、刷新、前进后退行为沿用 p2-b、p2-c 的验收并由 j 的浏览器流程复验。

## 验证记录

所有命令在本 worktree 真实运行，可能超 60 秒的命令后台运行并写 `/tmp/p2-d-*.log`。

| 命令                                           | 退出码 | 输出摘要                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`               | 0      | 锁文件未修改，安装现有依赖。`/tmp/p2-d-install.log`                                                                                                                                                                                                                        |
| `pnpm exec tsc --noEmit`                       | 0      | `TypeScript: No errors found`                                                                                                                                                                                                                                              |
| `pnpm fmt`                                     | 0      | 只格式化本 unit 新增与修改的文件                                                                                                                                                                                                                                           |
| `pnpm check`                                   | 0      | 116 文件格式通过，94 文件无 lint 与类型警告。`/tmp/p2-d-check.log`                                                                                                                                                                                                         |
| `pnpm exec vp test run tests/info-hub.test.ts` | 0      | 1 个文件、6 个测试通过。`/tmp/p2-d-test-first.log`                                                                                                                                                                                                                         |
| `pnpm test`                                    | 0      | 12 个文件、65 个测试通过。`/tmp/p2-d-test-all.log`                                                                                                                                                                                                                         |
| `bash scripts/verify/j-info-hub.sh`            | 0      | 7 条 PASS：真实构建、生产启动、2 个 server function id、curl 未登录双 boundary 均 `unauthorized`、真实 Chromium 流程 9/9、第二用户对 A 的 projectId 与 chatId 均 `not_found` 且 `leaked: []`、SIGTERM 退出 0。`/tmp/p2-d-j-verify.log`、`.verify/j-info-hub/evidence.json` |
| j 内浏览器流程                                 | 0      | 9/9 PASS：面板只列已加入成员、DM 链接跳转、双未实现通知含 P3/P4 文案且页面不出现「0 个活动 run」「无 Machine」、对话页 info 面板 instance 与页面一致、成员 human+agent、消息计数 2、深链刷新值不变、无 console 错误。`.verify/j-info-hub/browser.log`                      |
| j 内隔离反证                                   | 0      | 第二用户（独立 cookie）对 A 的 projectId 与 chatId 调两个新 boundary 均 `not_found`，响应体不含 A 的 profile 名称、chat id、instance id（`leaked: []`）。`.verify/j-info-hub/info-hub-cross-hub.body`、`info-hub-cross-chat.body`                                          |

行为测试 `tests/info-hub.test.ts` 用子进程（`tsx` 加独立 `DATABASE_URL`）直接调 boundary，覆盖：未登录两个 boundary 均 `unauthorized`；用户 B 对 A 的 projectId 与 chatId 均 `not_found` 且响应体不含 A 的 profile 名称、chat id、instance id；已加入成员带 chatId 与 instanceId、未加入的 profile 不出现在 agents；chat 视角成员含 human 与 agent、instance 与 DM 的分身一致、消息数 2、最后消息时间等于第二条消息时间；两条视图的 `runs.available === false`、`machines.available === false`，reason 分别含 P3 / P4 且非空。这是 P2 当时的断言；P3-d 已将 run 视角改为真实数据并更新断言，Machine 仍属 P4，当前验证见 [P3 验证记录](../p3/info-hub-runs.md#验证记录)。

## 截图

真实 Chromium 截图位于 `docs/p1/evidence/`，文件名前缀 `p2-j-`：`p2-j-info-hub-project-agents`、`p2-j-chat-info`、`p2-j-info-hub-deep-reload`。

## 未验证项

- P2 当时 P3 的 run 视角与 Agent status、P4 的 Machine 与租约视角未实现，只以显式不可用标记呈现；`available: false` 到联合类型的扩展发生在 P3/P4。P3-d 已将 run 视角改为真实数据，Machine 仍属 P4。
- 变更提示与快照（Agent 每轮开始时的自动快照、运行期变更通知）不在本 unit，未实现。
- 聚合按「成员数 × 对话数」逐个调用领域函数，无分页与缓存；成员或对话很多时的性能未验证。
- `archived` 目前恒为 false（P2 没有归档入口），归档后的视图行为未验证。
- 重启后的持久性由 i-chat 验收覆盖；j 的验收在单次生产进程内完成，未重复重启断言。
- Agent（而非 Human）经 Info Hub 主动查询的入口属于 P3 接入真实 run 之后，本 unit 只提供 Human 页面消费的查询模块。
