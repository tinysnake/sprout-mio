# P2 Project 配置与 Agent 成员页面

本 unit 让 Human 在界面上完成 Project 配置（Git remote、默认分支、工作目录）、Agent profile 的创建与人设编辑，以及 Project 的 Agent 成员添加与移除。边界只调用 `docs/p2/identity-data.md` 登记的 p2-a 领域服务，不写 SQL，不改 schema。

## 路由清单与 URL 形状

| URL                             | 文件                                                  | 作用                                                           |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `/agents`                       | `src/routes/_authed/agents.index.tsx`                 | 全局 Agent profile 列表（仅当前用户创建的）与新建入口          |
| `/agents/$agentProfileId`       | `src/routes/_authed/agents.$agentProfileId.tsx`       | profile 详情与编辑表单                                         |
| `/projects/$projectId`          | `src/routes/_authed/projects.$projectId.tsx`          | Project hub：Project 基本信息与子页导航，同时渲染 `<Outlet />` |
| `/projects/$projectId/settings` | `src/routes/_authed/projects.$projectId.settings.tsx` | Git remote、默认分支、工作目录                                 |
| `/projects/$projectId/agents`   | `src/routes/_authed/projects.$projectId.agents.tsx`   | Project 的 Agent 成员列表与添加/移除                           |

`agents.tsx` 是渲染 `<Outlet />` 的公共外壳，与 P1 的 `projects.tsx` 同构。`projects.$projectId.tsx` 直接作为 hub，没有 `$projectId.index.tsx`，三条 Project 子页 URL 与两条 Agent URL 都能直接刷新。Project 上下文完全由 URL 推导，每个 `$projectId` 子页的 loader 各自调用授权查询（settings 走 `getProjectProfileFn`，agents 走 `listProjectMembersFn`，都经 `assertProjectAccess`），不属于当前用户的 projectId 显示 not_found 错误块而不是空白页。`_authed.tsx` 的导航在 Project 之外新增 Agents 链接，未新增 Machines 与 Management。

## 边界函数清单

`src/server/functions/agent.ts`，全部按「会话 → zod → 领域调用」顺序，失败以 HTTP 200 加 `AppResult` 载荷返回：

| server function         | 输入                                             | 领域调用              |
| ----------------------- | ------------------------------------------------ | --------------------- |
| `createAgentProfileFn`  | `createAgentProfileInput`                        | `createAgentProfile`  |
| `listAgentProfilesFn`   | 无                                               | `listAgentProfiles`   |
| `getAgentProfileFn`     | `{ agentProfileId }`                             | `getAgentProfile`     |
| `updateAgentProfileFn`  | `{ agentProfileId, ...updateAgentProfileInput }` | `updateAgentProfile`  |
| `addProjectMemberFn`    | `addProjectMemberInput`                          | `addProjectMember`    |
| `removeProjectMemberFn` | `addProjectMemberInput`                          | `removeProjectMember` |
| `listProjectMembersFn`  | `{ projectId }`                                  | `listProjectMembers`  |

`src/server/functions/project-config.ts`：

| server function          | 输入                                          | 领域调用               |
| ------------------------ | --------------------------------------------- | ---------------------- |
| `getProjectProfileFn`    | `{ projectId }`                               | `getProjectProfile`    |
| `updateProjectProfileFn` | `{ projectId, ...updateProjectProfileInput }` | `updateProjectProfile` |

未登录返回 `unauthorized`；两个边界各自映射其调用图可达的全部领域错误类：agent 边界映射 `AgentError` 的 `not_found` 与 `conflict`、`ProjectAccessError` 的 `not_found`；project-config 边界只映射 `ProjectAccessError`（其调用图不含 `AgentError` 与 `ProjectError`）；zod 校验失败返回 `validation_failed` 并带 `fieldErrors`（复用 `fieldErrorsFrom`）；其余未知错误映射为脱敏 `internal` 并写 `agent.request_failed` 或 `project_config.request_failed` error 诊断，data 只含 `{ code: "internal" }`。可达集合由 `tests/error-mapping.test.ts` 与 `scripts/verify/m-error-mapping.sh` 回归。服务端专有模块（`../session`、`../../domain/*`、`../diagnostics`）只在 server function 内 `await import(...)`。

## 页面行为

- Agent 人设修改走 `updateAgentProfileFn`，页面固定显示「修改后由下一轮运行生效；profile 的 ID 与历史对话不变。」（`agent-edit-note`），不暗示重建分身。
- 添加成员的下拉只列出 `listAgentProfiles` 返回的当前用户 profile，且过滤掉已在成员集合里的 profile；移除按钮弹出 `window.confirm` 二次确认，不静默删除。
- 表单字段错误显示在对应输入旁（`field-error-*`），顶层错误沿用 `ResultError` 显示 code、message 与 requestId。
- 所有写操作成功后调用 `router.invalidate()` 刷新 loader，不改本地 state 冒充成功。无 `project_profile` 行时 settings 表单展示领域服务给出的默认值（分支 `main`）。

## 验证记录

所有命令在本 worktree 真实运行，可能超 60 秒的命令后台运行并写 `/tmp/p2-b-*.log`。

| 命令                                                 | 退出码 | 输出摘要                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                     | 0      | 锁文件未修改，安装现有依赖。`/tmp/p2-b-install.log`                                                                                                                                                                                                  |
| `pnpm exec tsr generate`                             | 0      | 重生成 `src/routeTree.gen.ts`，新增 6 条路由，未手改                                                                                                                                                                                                 |
| `pnpm exec tsc --noEmit`                             | 0      | `TypeScript: No errors found`                                                                                                                                                                                                                        |
| `pnpm check`                                         | 0      | 格式、lint、类型全部通过，无警告。`/tmp/p2-b-check-test.log`                                                                                                                                                                                         |
| `pnpm test`                                          | 0      | 10 个文件、53 个测试通过（含 `tests/project-agents.test.ts` 的 7 组）。`/tmp/p2-b-check-test.log`                                                                                                                                                    |
| `pnpm exec vp test run tests/project-agents.test.ts` | 0      | 1 个文件、7 组边界断言通过。`/tmp/p2-b-test-first.log`                                                                                                                                                                                               |
| `bash scripts/verify/h-project-agents.sh`            | 0      | 10 条 PASS：真实 `pnpm build`、生产启动、9 个 server function id、curl 创建 profile、校验失败载荷、未登录与无 Origin 未登录均 `unauthorized`、真实 Chromium 流程、SIGTERM 退出 0。`/tmp/p2-b-h-verify.log`，`.verify/h-project-agents/evidence.json` |
| h 内浏览器流程                                       | 0      | 12/12 PASS：注册建项目、hub、配置保存与刷新持久、建 profile、改人设后 id 与 URL 不变、成员加入/刷新/移除往返、两条深链、前进后退保持目标、两处 not_found、无 console 错误。`.verify/h-project-agents/browser.log`                                    |
| `bash scripts/verify.sh` 首跑                        | 1      | 10 个脚本中 9 个 PASS，仅 g-identity-data 失败：本 doc 在脚本运行期间写入且未格式化，g 的 `pnpm check` 格式门禁拒绝。`/tmp/p2-b-verify-full.log`                                                                                                     |
| `pnpm fmt`                                           | 0      | 格式化本 doc 后 98 文件全部通过                                                                                                                                                                                                                      |
| `bash scripts/verify/g-identity-data.sh` 单独复跑    | 0      | 全部 PASS。`/tmp/p2-b-verify-rerun.log`                                                                                                                                                                                                              |
| `bash scripts/verify.sh` 最终复跑                    | 0      | `Verification scripts=10 failed=0`，10 个脚本全部 PASS。`/tmp/p2-b-verify-rerun.log`                                                                                                                                                                 |

行为测试 `tests/project-agents.test.ts` 用子进程（`tsx` 加独立 `DATABASE_URL`）直接调用 boundary 函数，覆盖：9 个新 boundary 未登录均返回 `unauthorized`；用户 B 对用户 A 的 projectId 调配置与成员 boundary（查询、更新、列出、添加、移除）均返回 `not_found`；空名称创建与绝对路径工作目录返回 `validation_failed` 且 `fieldErrors` 含字段名；用户 B 拿 A 的 profileId 查询详情返回 `not_found`；重复添加成员返回 `conflict`，移除一次后再移除返回 `not_found`；人设修改后重新读取是新值且 id 不变。

## 截图

真实 Chromium 截图位于 `docs/p1/evidence/`，文件名前缀 `p2-h-`：`p2-h-project-hub`、`p2-h-project-settings`、`p2-h-project-settings-reload`、`p2-h-agents-list`、`p2-h-agent-detail`、`p2-h-project-members`、`p2-h-project-members-empty`、`p2-h-deep-settings`、`p2-h-deep-agent`、`p2-h-settings-not-found`、`p2-h-agent-not-found`。

## 未验证项

- 多用户并发编辑同一 profile 或同一 Project 配置的竞争行为未验收；本 unit 的写入都经过 p2-a 的 IMMEDIATE 事务，但没有并发测试。
- 真实 Pi 会话、run、分身实例页面属于 P3 及以后，本 unit 未实现；「下一轮运行生效」当前只表示配置持久化，尚无运行时消费方。
- Group、Public Channel、Task、Machine、Info Hub 聚合不在本 unit 范围。
- member 列表按 `addedAt` 排序展示，未做分页；成员数量很大时的界面表现未验证。
