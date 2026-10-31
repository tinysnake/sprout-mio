# P7 契约：客户端体验、恢复与诊断

本章不改动 P1–P6 的领域契约（Task、租约、自动接续、Info Hub、成员治理的返回形状与错误码都在原处）。它新增的是**浏览器侧与运维侧**的边界：哪些目标允许在登录后恢复、哪些读可以离线、动作结果怎么分三态、判定器不可用时页面说什么、Management 读什么、备份恢复的边界、Pi 资源的继承边界。判据与证据见 [P7 章节结论](summary.md)。

## 登录后目标恢复

`src/lib/return-target.ts` 的 `safeReturnTarget(value: unknown): string` 是唯一入口，返回同源应用内路径，其余一律退回 `/`。

拒绝清单（每条都是白名单之外的默认拒绝，不是黑名单）：

- 非字符串、不以 `/` 开头、以 `//` 开头。
- 任何 `charCodeAt <= 32` 的字符与反斜杠（按码元扫描，不做 trim 或解码）。
- 解析后 origin 不是占位源 `https://sprout.invalid`（即跨源绝对 URL）。
- `pathname` 去掉尾斜杠后等于 `/login`，或以 `/api/` 开头。

通过时返回 `pathname + search + hash`。`src/routes/login.tsx` 的 `validateSearch` 只在结果不是 `/` 时写 `next`，`src/routes/_authed.tsx` 的根路径不带 `next`；这两条保证 `/login` 保持裸路径，旧门禁（`c-data-auth`）等的是 `/login` 本身而不是带查询串的地址。

## 只读离线

离线只覆盖**读**。产品不排队任何离线写，断线时执行类按钮不可用，恢复后由人类重新发起。

- 白名单是显式的：`src/lib/offline-read-functions.ts` 的 `OFFLINE_READ_FUNCTIONS` 列出经审计的只读操作（`getProjectFn`、`getChatSessionFn`、`getProjectInfoHubFn`、`listProjectLeasesFn`、`readExecutionLogFn` 等 28 个）。不从动词前缀推断，新增读操作必须显式加进来。
- 构建期把这些函数 id 写进 `pwa-reads.json`（`vite.config.ts` 的 `pwaAssets()`，缺 `getChatSessionFn` 直接构建失败）。
- `public/sw.js` **只接管**白名单内的调用：白名单在 `activate` 阶段装进内存（`readManifest = await readFunctions()`），fetch 监听里同步判断，其余请求（包括所有写入与未登记的 server fn）直接放行，service worker 不接管。这样页面发出的写入仍是真实网络请求，浏览器侧的抓取、中止与错误注入都能看到它。
- 缓存键是「URL + 请求体」的 SHA-256（`readKey()`），所以同一函数不同参数的读互不覆盖。命中缓存时返回的响应带 `x-sprout-offline: 1`，页面据此把事实标成「未确认」而不是最新。
- 401/403 的读响应会清空整个读缓存（`caches.delete(READS)`），身份变更由页面在登录/登出成功后调用 `src/lib/pwa.ts` 的 `clearOfflineReads()` 显式触发。
- 应用壳缓存（`SHELL`）只在导航请求上生效，`/api/` 与 `/_serverFn/` 不走壳缓存。

## 动作结果三态

`src/components/ui/action-outcome.tsx` 的 `ActionOutcome = "processing" | "success" | "failure" | "unknown" | null`，`ActionOutcomeNotice` 渲染 `动作 · 状态 [· 细节]`：`failure` 用 `role="alert"`，其余用 `role="status"`。

- `unknown` 是独立状态，不是 `failure` 的别名：请求发出但结果未确认（超时、断线、连接中断）时显示「未知」，页面不补成成功，也不补成失败。
- 状态与细节来自服务端结果或网络事实，组件不推断。

## 自动接续在真实页面上的接线

P6a 交付的 `ChatAutomationData`（`src/server/functions/chat-automation.ts` 的 `getChatAutomationFn` / `controlChatAutomationFn`）此前没有页面调用点，真实 Chat 页永远渲染占位。P7 把它接进真实页面：

- Chat 详情 loader 把 `getChatAutomationFn({ data: { projectId, chatId } })` 并进 `Promise.all`，结果放进 `ChatDetailLoaderData.ok` 的 `automation` 字段（`src/components/chat/chat-loader.ts`）。
- `src/routes/_authed/projects.$projectId.chats.tsx` 在 `selected.automation.ok` 时把 `{ view, denials }` 传给面板，并用 `controlChatAutomationFn` 实现 `onAutomationCommand`；失败按 `{ code, reason, requestId }` 回，成功 `router.invalidate()`。
- 面板不再打印内部错误码。`src/components/automation/automation-card.tsx` 的 `failureText()` 把 `provider_timeout`、`provider_unavailable`、`provider_auth_failed`、`provider_invalid_response`、`provider_low_certainty`、`context_budget_exceeded`、`context_stale`、`delivery_unavailable`、`delivery_unknown`、`run_repeated_failure`、`internal_failure` 映射成人话，兜底「检查未能完成」；码保留在 `data-error-code` 上供门禁断言，不进人类视野。
- 命令失败的提示只显示 `reason`，不再拼 `(conflict) · req_…`；`data-error-code` 承载码。

## 判定器可用性

判定器的模型、阈值版本与凭据是部署配置，浏览器只选 provider。所以页面必须先知道「这台部署能不能用某个判定器」：

- `src/server/wake-config.ts` 的 `wakeProviderAvailabilityFromEnv(): WakeProviderAvailability[]` 按 env 算出每个 provider 的 `configured` / `available` / `unavailableReason`，取值 `missing_model`（模型或阈值版本缺失）、`missing_credentials`（JEV 有模型无 `JEV_API_KEY`）、`provider_unavailable`（部分配置存在但不完整）。
- `getProjectBoundary` 与 `updateProjectWakePolicyBoundary` 都返回 `wakeProviderAvailability`；写边界的失败文案是「这台部署没有配置判定模型与阈值版本，判定器未启用。」/「这台部署没有 JEV 凭据，判定器未启用。」，不再是 `wake_provider_unavailable` 内部码。
- `src/components/automation/wake-provider-select.tsx` 三态：没有配置项时只显示「这台部署没有提供判定器配置，暂不能更改。」（`wake-provider-unwired`）；全部不可用时逐条列人话原因（`wake-provider-unavailable`），不渲染 select 与保存；有可用项才渲染下拉与保存。当前配置行只说「当前：<判定器> · <模型>」或「当前使用部署默认判定器；保存一次即可固定下来。」。
- 保存带 `expectedConfigRevision`，并发修改按既有 CAS 语义失败。

## Management 一期

`src/routes/_authed/management.tsx` 有两个卡片，数据都来自既有持久事实：

- **服务与数据**：`/api/diagnostics?summary=1` 返回 `queryManagementSummary(actorId)` 的 `{ asOf, migration, pendingResourceNotices, pendingContinuations, mcpFrames }`。`migration` 取 `__drizzle_migrations` 最后一行（`id`、`hash`、`journalTimestamp`），队列计数一律按 Project 归属过滤（`project.created_by = actorId`）。备份与恢复的入口在 `scripts/p7/storage/`，页面只写命令与位置，不代跑。
- **账号与外观**：当前身份、主题（沿用 `src/lib/theme.ts` 的既有主题存储）、登出（`authenticate({ action: "logout" })`，成功后 `clearOfflineReads()` 再跳登录页）。

不含用量统计、不显示跨 Project 的全局计数、不提供数据库写入或迁移执行入口。

## 备份与恢复

- 备份用 `node --import tsx scripts/p7/storage/snapshot.ts backup --database <主库> --out <绝对新路径>`，实现是 SQLite 的 `VACUUM INTO`。它在读事务里写出新库，包含 WAL 中已提交但未 checkpoint 的事务；直接 `cp` 主库会漏掉这些事务（`tests/storage-snapshot.test.ts` 是这条的反证）。目标路径必须不存在，脚本不覆盖。
- 输出 JSON 含大小、`sha256`、`integrity_check`、`foreign_key_check`、迁移数与各表行数。
- 恢复用 `restore --backup <快照> --database <绝对新路径>`：先完整校验，复制到同目录临时文件并 `fsync` 后原子改名，拒绝已有目标。之后用 `DATABASE_URL` 指向恢复库启动生产服务，由既有 `migrateDatabase` 再校验迁移与外键，并把上次未关闭的 `queued`/`running` run 恢复为 `interrupted`。
- 数据库单文件不等于执行现场：Worker 的 journal/结果文件、Git checkout、模型 session 文件都在库外，不在备份范围。

## Pi 资源继承边界

- 默认**不继承**宿主 `agentDir` 下的 extensions、themes、context files，也不继承 skills 与 prompt templates：`scripts/pi-host-runner.mjs` 只有在 `inheritHostResources === true` 时才把 `<宿主 agentDir>/skills`、`<宿主 agentDir>/prompts` 作为 `additionalSkillPaths` / `additionalPromptTemplatePaths` 接进去，其余类别恒关。
- 开关是 `SPROUT_PI_INHERIT_HOST_RESOURCES`（`src/server/pi-host/run.ts` 解析）。关闭时工具面与 P3 完全一致（30 个工具：`bash`/`edit`/`read`/`write` + 26 个 Sprout 工具，没有 codemode、tool_search 或 `mcp__*`）。
- 打开后**真正生效的只有 skills**：产品路径用 `session.prompt(..., { expandPromptTemplates: false })`，prompt templates 只被装载进命令面板，不进模型路径。
- ready 快照里的 `registeredTools` 与 `resources`（`skillPaths`/`skills`/`themes`/`contextFiles`/`systemPromptChars`）是可选字段，只为让证据可核对，不改变运行语义。

## sprout_status 的事实

`sprout_status` 在真实 Pi 会话里可达，返回真实运行事实：`worker.pid`（本会话 runner 子进程）、`worker.loader`、`piSession.id`（对 session 文件头）、`toolCount`、宿主目录状态。P1 边界声明里的 `worker: "unimplemented"` / `piSession: "unimplemented"` 已按实际能力替换，`scripts/verify/a-base.sh` 改为逐事实对账。

## 跨章页面裁定（P5b/P6a/P6b 的修订）

P7 的 Human 评审推翻了三条此前的页面决定，改动落在对应组件上，判据在本章门禁里：

1. **服务端拒绝的动作不渲染。** `src/components/tasks/task-detail.tsx` 的 `TaskActionControl` 在 `detail.capabilities.allowedActions` 不含该动作时返回 `null`，`src/components/automation/automation-card.tsx` 的 `actionButton` 在 `denial(action)` 存在时返回 `null`。被拒动作不再显示为置灰按钮，也不再逐字打印 `denial.reason` / `denial.code`。服务端仍返回完整 denial，能力判断没有放宽。
2. **Task 的目标与要求、清单文字都在原地编辑。** 元数据区右上角是铅笔按钮（`data-testid="task-metadata-edit"`，与标题同一行），点开在原位置换成表单；清单行最左是铅笔（`task-checklist-edit-<id>`），移除是 `x`（`task-checklist-remove-<id>`），两者都就地换成「确认」「取消」，不弹窗、不在下方另起一行。
3. **轮询状态行只在有事说时出现。** `src/components/info-hub/info-hub-live.tsx` 的 `InfoHubPollingStatus` 在 `current`/`refreshing`/`hidden` 时返回 `null`，异常态只说一句人话；内部 state 与 `asOf` 只进 `data-state`/`data-as-of`。`not_found`/`unauthorized`/`forbidden` 的提示与页面自己的错误态并列渲染，不替换整页内容。
