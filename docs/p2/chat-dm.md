# P2 Chat DM 与持久分身

本 unit 让 Human 在界面上与 Project 内的 Agent 成员建立 DM 并持续对话。Chat、分身（agent_instance）与消息全部持久；边界只调用 p2-a 的领域服务，不写 SQL，不改 schema。页面不提供任何伪造或模拟 agent 回复的入口，P2 未接入真实 Pi。

## 路由与 URL 形状

| URL                                  | 文件                                                       | 作用                                       |
| ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------ |
| `/projects/$projectId/chats`         | `src/routes/_authed/projects.$projectId.chats.index.tsx`   | Project 的 DM 列表与从 Agent 成员发起新 DM |
| `/projects/$projectId/chats/$chatId` | `src/routes/_authed/projects.$projectId.chats.$chatId.tsx` | 对话页：分身身份、成员、消息列表、发送框   |

两条 URL 都是 Project hub（`projects.$projectId.tsx`）的子路由，hub 子导航新增「对话」链接（`tab-chats`），不新增一级导航。`pnpm exec tsr generate` 把两个路由文件直接挂在 hub 之下，无需 `chats.tsx` 外壳文件，生成物 `src/routeTree.gen.ts` 未手改。Project 上下文完全由 URL 推导：对话页 loader 会校验 `chat.projectId` 等于 URL 中的 `projectId`，不一致时按 `not_found` 呈现。

## 边界函数清单

`src/server/functions/chat.ts`，全部按「会话 → zod → 领域调用」顺序，失败以 HTTP 200 加 `AppResult` 载荷返回：

| server function          | 输入                    | 领域调用               |
| ------------------------ | ----------------------- | ---------------------- |
| `createDirectChatFn`     | `createDirectChatInput` | `createDirectChat`     |
| `listChatsFn`            | `{ projectId }`         | `listChats`            |
| `getChatFn`              | `chatIdInput`           | `getChat`              |
| `listChatMembersFn`      | `chatIdInput`           | `listChatMembers`      |
| `listInstancesForChatFn` | `chatIdInput`           | `listInstancesForChat` |
| `listMessagesFn`         | `chatIdInput`           | `listMessages`         |
| `sendMessageFn`          | `{ chatId, body }`      | `sendMessage`          |

`sendMessageFn` 只接受 `chatId` 与 `body`，human sender 从认证会话构造，不信任浏览器传入的身份。未登录返回 `unauthorized`；`ChatError` 与 `ProjectAccessError` 的 `not_found` 按原码透出；边界同时映射 `AgentError`（`not_found` / `conflict`），`createDirectChat` 因引用他人或不存在的 profileId 而拒绝时返回 `not_found`，属于合法业务拒绝，不再记为 `internal` error 诊断。这三类是该边界调用图可达的全部领域错误类；五个边界共用 [domain-errors.ts](../../src/server/functions/domain-errors.ts) 的一张领域错误映射表，回归入口为 `tests/error-mapping.test.ts` 与 `scripts/verify/m-error-mapping.sh`；zod 校验失败返回 `validation_failed` 并带 `fieldErrors`（空 body 的字段错误为 `body`）；其余未知错误映射为脱敏 `internal` 并写 `chat.request_failed` error 诊断。服务端专有模块只在 server function 内 `await import(...)`。

## 分身身份与唯一性的实现位置

- 唯一性由数据库约束保证：`agent_instance` 的 `agent_instance_profile_chat_unique` 覆盖 `(agent_profile_id, chat_id)`（p2-a 建立，`drizzle/0001_stiff_wallflower.sql`）。
- 幂等入口在 `src/domain/chat.ts` 的 `createDirectChat`：IMMEDIATE 事务内先查既有 `(project, creator, profile)` DM，命中直接返回原 chat 与 instance，不重复写 `chat.created`。
- 页面层复用该幂等语义：列表页对同一成员再次点击「发起对话」只是导航到返回的既有 chat id，不产生重复行（`browser.log` 的 `repeat_start_opens_same_chat`）。
- 修改 profile 人设走 `updateAgentProfileFn`，不触碰 instance 行与历史消息；对话页展示的 instance id 在人设编辑前后一致（`browser.log` 的 `persona_edit_keeps_instance_and_history`、`tests/chat.test.ts` 的分身断言）。

## 页面行为

- 列表页「发起新对话」只列出 `listProjectMembersFn` 返回的当前 Project Agent 成员；已有对话区按 chat 展示并链接到对话页。
- 对话页显示 chat id、分身 instance id、profile 名称与人设全文、成员清单；消息按领域服务给定的时间与 rowid 升序渲染，human 与 agent 用可见标签（`Human` / `Agent`）与 `data-sender-kind` 区分。
- 发送框只发送当前登录者的 human 消息，成功后 `router.invalidate()` 重新取数，不在本地插入消息冒充成功。
- 不存在伪造 agent 回复的入口或状态；页面固定说明「P2 未接入真实 Pi 运行」（`chat-runtime-note`），不出现任何模拟回复或「正在回复」状态。
- 越权或不存在的 chat URL 显示 `not_found` 与 requestId（`chat-error`），不白屏。

## 验证记录

所有命令在本 worktree 真实运行，可能超 60 秒的命令后台运行并写 `/tmp/p2-c-*.log`。

| 命令                                       | 退出码 | 输出摘要                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`           | 0      | 锁文件未修改，安装现有依赖。`/tmp/p2-c-install.log`                                                                                                                                                                                                                                       |
| `pnpm exec tsr generate`                   | 0      | 新增 2 条路由并直接挂到 hub 之下，`src/routeTree.gen.ts` 为生成物                                                                                                                                                                                                                         |
| `pnpm exec tsc --noEmit`                   | 0      | 首跑 1 处多余 prop 传递错误，移除后 `TypeScript: No errors found`                                                                                                                                                                                                                         |
| `pnpm check`                               | 0      | 107 个文件格式通过，86 个文件无 lint 与类型警告。`/tmp/p2-c-check-first.log`                                                                                                                                                                                                              |
| `pnpm exec vp test run tests/chat.test.ts` | 0      | 1 个文件、6 个测试通过。`/tmp/p2-c-test-first.log`                                                                                                                                                                                                                                        |
| `pnpm test`                                | 0      | 11 个文件、59 个测试通过。`/tmp/p2-c-test-all.log`                                                                                                                                                                                                                                        |
| `bash scripts/verify/i-chat.sh`            | 0      | 10 条 PASS：真实构建、生产启动、7 个 server function id、curl 未登录与无 Origin 未登录均 `unauthorized`、真实 Chromium 流程 9/9、SIGTERM 退出 0、重启后健康检查（bootId 更换）、第二次会话 4/4、重启后进程 SIGTERM 退出 0。`.verify/i-chat/evidence.json`、`/tmp/p2-c-i-verify-first.log` |
| `bash scripts/verify.sh`                   | 0      | `Verification scripts=11 failed=0`，11 个脚本全部 PASS（含新增的 i-chat）。`/tmp/p2-c-verify-full-first.log`                                                                                                                                                                              |

行为测试 `tests/chat.test.ts` 用子进程（`tsx` 加独立 `DATABASE_URL`）直接调 boundary 与领域函数，覆盖：同一 (project, profile) 重复发起 DM 返回同一 chat 与 instance 且 `agent_instance` 只有一行；7 个新 boundary 未登录均 `unauthorized`；用户 B 对 A 的 project 与 chat 在列表、详情、成员、实例、发消息上均 `not_found`；空 body 返回 `validation_failed` 且 `fieldErrors` 含 `body`；agent 先发消息后顺序稳定，human 第二条后仍按时间与 rowid 升序；修改人设后 instance id 不变且消息保留。

## 重启持久性验收

P2 出口条件「重启后同一对话仍对应同一分身，消息与配置保留」由 `bash scripts/verify/i-chat.sh` 真实验证：Chromium 首次会话结束后脚本 SIGTERM 停掉生产进程（退出 0），对同一个 SQLite 文件重新启动 `pnpm start`，健康检查返回新 bootId（`boot_3be07db5-…` → `boot_1adbc97a-…`），再用第二次 Chromium 会话（恢复首次会话的 storage state）断言：

- `restart_chat_renders_same_instance`：chat id 与 instance id 与重启前一致（`cnv_f48efc55-…` / `ins_c20d9430-…`），人设为编辑后的新值。
- `restart_messages_retained_in_order`：两条 human 消息按原顺序保留。
- `restart_list_shows_single_chat`：列表仍只有同一条 chat。
- `no_console_errors_restarted_session`：无 console 错误。

证据：`.verify/i-chat/browser-restart.log`、`.verify/i-chat/state.json`、`.verify/i-chat/server-second.log`。

## 截图

真实 Chromium 截图位于 `docs/p1/evidence/`，文件名前缀 `p2-i-`：`p2-i-chat-started`、`p2-i-chat-messages`、`p2-i-chat-after-persona-edit`、`p2-i-chats-list`、`p2-i-chat-not-found`、`p2-i-chat-after-restart`。

## 给 p2-d 的接口说明

Info Hub 需要的查询入口全部在 `src/server/functions/chat.ts` 与 p2-b 的边界之上，不需要新 SQL：

- Project 上下文取法：登录后从 URL 或 `listProjectsFn` 取 `projectId`，所有查询带 `projectId` 并经 p2-a 的 `assertProjectAccess`；越权等价于 `not_found`。
- 对话清单：`listChatsFn({ projectId })`；单个对话：`getChatFn({ chatId })`（chat 自带 `projectId`）。
- 分身：`listInstancesForChatFn({ chatId })` 返回 `AgentInstance[]`（含 `agentProfileId`、`chatId` 与时间戳）；profile 名称与人设经 `getAgentProfileFn` 补充。
- 消息：`listMessagesFn({ chatId })`，顺序为 `created_at ASC, rowid ASC`。
- 成员：`listChatMembersFn({ chatId })` 返回 human/agent 成员行。

## 未验证项

- 真实 Pi 会话、run、agent 自动回复与分身运行状态属于 P3，本 unit 未实现；`agent` sender 的消息接口只保存调用方提供的文本，仅供领域测试与后续运行时写入。
- Group 与 Public Channel（P5）、Info Hub 聚合（p2-d）不在本 unit 范围；chat 的 kind 仍只有 `dm`。
- 归档（`archived_at`）与消息分页未实现；成员与消息数量很大时的界面表现未验证。
- 多用户并发写同一对话的竞争行为未验收；写入经过 p2-a 的 IMMEDIATE 事务，但没有并发测试。
