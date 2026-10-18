# P2 身份与持久对话数据层

本数据层供 Project 配置、Agent 管理、DM 与 Info Hub 调用。领域服务同步返回契约对象，不读取 HTTP，不调用 Pi。所有新增时间列使用 SQLite unixepoch 整数，领域服务返回 ISO 字符串。

任务书的“六张表”与其逐项清单有计数差异。实现与验收覆盖清单中的全部 7 张新增表。

## 表、列与约束

SQL 位于 `drizzle/0001_stiff_wallflower.sql`，由 `pnpm db:generate` 生成。`drizzle/meta/0001_snapshot.json` 与 `_journal.json` 一起提交。原迁移 `0000_pale_famine.sql` 保留。

| 表                    | 列                                                                                              | 主键与约束                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_profile`       | `id`, `name`, `persona`, `harness`, `model`, `effort`, `created_by`, `created_at`, `updated_at` | PK `id`。`created_by` 引用 `user.id`。`persona` 默认空字符串，`harness` 默认 `pi`。                                                                              |
| `project_profile`     | `project_id`, `git_remote`, `default_branch`, `work_directory`, `updated_at`                    | PK `project_id` 引用 `project.id`。`default_branch` 默认 `main`。                                                                                                |
| `project_member`      | `project_id`, `agent_profile_id`, `added_by`, `added_at`                                        | PK `project_id, agent_profile_id`。分别引用 `project.id`, `agent_profile.id`, `user.id`。                                                                        |
| `conversation`        | `id`, `project_id`, `kind`, `title`, `archived_at`, `created_by`, `created_at`, `updated_at`    | PK `id`。Project 与创建者外键。`conversation_kind_check` 仅允许 `dm`。                                                                                           |
| `conversation_member` | `conversation_id`, `member_kind`, `member_id`, `added_at`                                       | PK `conversation_id, member_kind, member_id`。Conversation 外键。`conversation_member_kind_check` 仅允许 `human`, `agent`。                                      |
| `agent_instance`      | `id`, `agent_profile_id`, `conversation_id`, `project_id`, `created_at`, `updated_at`           | PK `id`。三个对象外键。唯一索引 `agent_instance_profile_conversation_unique` 覆盖 `agent_profile_id, conversation_id`。                                          |
| `message`             | `id`, `conversation_id`, `sender_kind`, `sender_id`, `body`, `created_at`                       | PK `id`。Conversation 外键。`message_sender_kind_check` 仅允许 `human`, `agent`。索引 `message_conversation_created_at_idx` 覆盖 `conversation_id, created_at`。 |

`model`, `effort`, `git_remote`, `work_directory`, `title`, `archived_at` 可为 SQL NULL，契约返回值省略对应属性。其他列均非空。新增时间列除可空的 `archived_at` 外都默认 `unixepoch()`。外键采用 NO ACTION，不级联删除历史。共享连接在 `src/db/connection.ts` 启用 `PRAGMA foreign_keys = ON`。

ID 新增 `agp`, `pmb`, `cnv`, `ins`, `msg`。`pmb` 已登记但本次成员表使用复合主键，不生成成员 ID。`conversation_member.member_id` 的 agent 值为 profile ID，human 值为用户 ID。`message.sender_id` 使用相同语义，agent 消息不使用 instance ID。多态成员 ID 不设跨表外键，由领域写入口检查实际成员。

## 服务入口

`ctx` 的类型是 `ProjectContext = { userId: string; requestId: string }`，从 `src/domain/access.ts` 导出。输入类型与返回类型从 `src/contracts/index.ts` 导出。以下函数均同步执行。

所有写入口最后还有可选参数 `hooks?: IdentityWriteHooks`。该类型从 `src/domain/identity-write.ts` 导出，形状为 `{ afterWrite?: () => void }`。Hook 在业务写入之后、诊断 INSERT 之前执行，异常使完整事务回滚。普通调用省略该参数。

### Project 授权与配置

```ts
// src/domain/access.ts
assertProjectAccess(ctx: ProjectContext, projectId: string): Project

// src/domain/project-config.ts
getProjectProfile(projectId: string, ctx: ProjectContext): ProjectProfile
updateProjectProfile(projectId: string, input: UpdateProjectProfileInput, ctx: ProjectContext, hooks?: IdentityWriteHooks): ProjectProfile
```

授权仅允许 Project 创建者。不存在和越权都抛出 `ProjectAccessError`，`code` 为 `not_found`，消息均为 `对象不存在`。通过 conversation 或 instance ID 查询时同样返回这份错误，不通过错误消息区分存在性。带 projectId 的查询先调用授权入口。Conversation、成员、消息与 instance 的关联查询过滤授权后的 projectId。

Agent profile 是全局对象，按 `createdBy` 授权。本人可以在多个自己的 Project 中复用同一个 profile。其他用户的 profile 详情、更新与添加为 Project 成员都返回 `AgentError` 的 `not_found`。

无 `project_profile` 行时，返回 `{ projectId, defaultBranch: "main", updatedAt: project.updatedAt }`，不写入默认行。更新采用局部 patch，省略字段保留原值。`gitRemote` 和 `workDirectory` 传 `null` 清空，返回对象省略对应字段。

`gitRemote` 接受 Zod 合法 URL，包括 `https://` 和 `ssh://` URL。`git@example.com:repo.git` 这种 SCP 写法不是 URL，会拒绝。`defaultBranch` trim 后非空且最多 200 字。工作目录 trim 后长度为 1 到 500，必须是相对路径。拒绝 `/` 开头、反斜杠、冒号、NUL、`~` 开头和任意 `..` 路径段。`.` 可表示仓库根目录。该字段目前只保存配置，不访问宿主文件系统，也不检查符号链接。

### Agent profile 与 Project 成员

```ts
// src/domain/agent.ts
createAgentProfile(input: CreateAgentProfileInput, ctx: ProjectContext, hooks?: IdentityWriteHooks): AgentProfile
listAgentProfiles(ctx: ProjectContext): AgentProfile[]
getAgentProfile(id: string, ctx: ProjectContext): AgentProfile
updateAgentProfile(id: string, input: UpdateAgentProfileInput, ctx: ProjectContext, hooks?: IdentityWriteHooks): AgentProfile
addProjectMember(projectId: string, agentProfileId: string, ctx: ProjectContext, hooks?: IdentityWriteHooks): ProjectMember
removeProjectMember(projectId: string, agentProfileId: string, ctx: ProjectContext, hooks?: IdentityWriteHooks): void
listProjectMembers(projectId: string, ctx: ProjectContext): ProjectMember[]
```

创建输入为 `name`, `persona`, `harness`, `model`, `effort`。`name` trim 后长度为 1 到 80，`persona` 最多 2000 字且默认空字符串，`harness` 仅允许 `pi` 且默认 `pi`。`model` 与 `effort` 可省略，提供时 trim 后长度为 1 到 200。Profile 更新采用局部 patch，`model` 和 `effort` 传 `null` 清空。Profile 更新不修改 instance ID 或历史消息。

重复添加同一成员抛出 `AgentError` 的 `conflict`，不新增成员或诊断行。删除不存在成员返回 `not_found`。移除 Project 成员保留既有 conversation、对话成员与 instance。当前成员才能调用创建 DM 入口，移除后无法重开，重新加入后返回原 DM。已建立 DM 的详情和消息仍可按 Project 所有权读取和保存。

### Conversation、分身与消息

```ts
// src/domain/conversation.ts
createDirectConversation(projectId: string, agentProfileId: string, ctx: ProjectContext, hooks?: IdentityWriteHooks): DirectConversation
listConversations(projectId: string, ctx: ProjectContext): Conversation[]
getConversation(conversationId: string, ctx: ProjectContext): Conversation
listConversationMembers(conversationId: string, ctx: ProjectContext): ConversationMember[]
listInstancesForConversation(conversationId: string, ctx: ProjectContext): AgentInstance[]
getInstance(instanceId: string, ctx: ProjectContext): AgentInstance
listMessages(conversationId: string, ctx: ProjectContext): Message[]
sendMessage(conversationId: string, input: SendMessageInput, ctx: ProjectContext, hooks?: IdentityWriteHooks): Message

type DirectConversation = { conversation: Conversation; instance: AgentInstance }
type SendMessageInput = { senderKind: "human" | "agent"; senderId: string; body: string }
```

创建 DM 使用 IMMEDIATE 事务。事务先确认 Project 所有权、profile 所有权与 Project 成员关系，再按 Project 与 profile 查找既有 DM。已有 DM 直接返回原 conversation 与 instance，不重复写 `conversation.created`。新 DM 在同一事务创建 conversation、human 与 agent 两条成员行、instance 和诊断。不同 Project 中的相同 profile 有不同 DM 和 instance。

消息输入的 `body` trim 后长度为 1 到 8000。领域服务验证 sender 是该对话成员，human sender 必须等于 `ctx.userId`，agent sender 必须有该对话的实际 instance。非法 sender 返回 `ConversationError` 的 `not_found`。普通页面发送入口应从已认证会话构造 human sender，不能信任浏览器传入的身份。agent 消息接口只保存调用方提供的文本，不生成回复或运行 Pi。

消息排序固定为 `created_at ASC, rowid ASC`，同秒消息保留写入顺序。Conversation 列表按 `updated_at DESC, rowid DESC`。保存消息同时更新 conversation 的 `updated_at`。

边界先查询会话，再使用 `createAgentProfileInput`, `updateAgentProfileInput`, `addProjectMemberInput`, `updateProjectProfileInput`, `createDirectConversationInput`, `conversationIdInput` 或 `sendMessageInput` 解析，之后调用领域服务。字段级错误复用 `fieldErrorsFrom`。`AgentResult<T>` 和 `ConversationResult<T>` 沿用 `AppResult` 加可选 `fieldErrors`，错误转换仍使用 `toAppError(error, requestId)`。这些边界映射其调用图可达的全部领域错误类（`AgentError`、`ConversationError`、`ProjectAccessError`），业务拒绝按原码透出且不写 error 诊断，可达集合由 `tests/error-mapping.test.ts` 与 `scripts/verify/m-error-mapping.sh` 回归。服务端专有模块在 server function 内动态导入，不能从页面顶层静态导入领域模块。

## 诊断与事务

所有写入口通过同一个 SQLite 事务写业务行和 `diagnostic_event`。诊断 INSERT 失败直接抛错并回滚，不调用会吞掉失败的 `recordDiagnostic`。事件包括 `agent_profile.created`, `agent_profile.updated`, `project_profile.updated`, `project_member.added`, `project_member.removed`, `conversation.created`, `message.sent`。

诊断使用 `ctx.requestId`。Project 业务事件填实际 `projectId`。`conversation.created` 填实际 conversation 与 instance ID。`message.sent` 填实际 conversation ID，agent sender 还填写对应 instance ID。全局 profile 事件不捏造 Project 关联。`runId` 和 `executionId` 均不填写。诊断不存储消息正文、人设、远端地址或模型配置。

## 验证记录

所有记录均来自当前 worktree 的真实命令。可能超过 60 秒的外层命令在后台运行，退出码写入 `/tmp/p2-a-*.exit`，日志写入对应 `.log`。g 脚本的每条构建或测试命令有 300 秒上限，生产就绪等待上限 60 秒，关闭上限 15 秒。

| 命令                                                     | 退出码 | 输出摘要与证据                                                                                                                                                                                       |
| -------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                         | 0      | 锁文件未修改，安装现有依赖。`/tmp/p2-a-install.log`。                                                                                                                                                |
| `pnpm db:generate`                                       | 0      | 14 张应用表，生成 `drizzle/0001_stiff_wallflower.sql`。不含迁移记录表。                                                                                                                              |
| `pnpm test -- tests/identity-data.test.ts` 首跑          | 1      | 测试种子的认证列名使用了 camelCase，真实 SQLite 拒绝 `emailVerified`。已改为现有 snake_case 列名。`/tmp/p2-a-test-first.log`。                                                                       |
| `pnpm test -- tests/identity-data.test.ts` 修正后        | 0      | 此命令形式实际运行全量测试，9 个文件、46 个测试通过。`/tmp/p2-a-test-second.log`。                                                                                                                   |
| `pnpm check` 首跑                                        | 1      | 两处查询结果解构缺少显式类型。已补齐行类型。`/tmp/p2-a-check-first.log`。                                                                                                                            |
| `pnpm fmt`                                               | 0      | 格式化通过，生成的迁移 meta 未手改。                                                                                                                                                                 |
| `bash scripts/verify/g-identity-data.sh`                 | 0      | 全部 PASS。`/tmp/p2-a-g-first.log` 与 `.verify/g-identity-data/evidence.json`。                                                                                                                      |
| g 内 `pnpm db:migrate`，删库后第一次与第二次             | 0, 0   | 两次成功，迁移记录数保持 2。第二次 no-op。`.verify/g-identity-data/migrate-first.log`, `migrate-second.log`。                                                                                        |
| g 内 SQLite schema 查询                                  | 0      | 7 张新增表、两组复合主键、instance 唯一索引、message 时间索引与三个具名 CHECK 通过。                                                                                                                 |
| g 内 `pnpm exec vp test run tests/identity-data.test.ts` | 0      | 1 个文件、8 组领域行为断言通过。`.verify/g-identity-data/identity-test.log`。                                                                                                                        |
| g 内 `pnpm build`                                        | 0      | 真实 `.output/server/index.mjs` 构建成功。`.verify/g-identity-data/build.log`。                                                                                                                      |
| g 内 `pnpm start`，启动与重启                            | 0, 0   | 两次真实进程 `/api/health` 均为 200，`database.migrationApplied=true`，bootId 不同，SIGTERM 均退出 0。`.verify/g-identity-data/server-first.log`, `server-second.log`。                              |
| g 内 `pnpm check`                                        | 0      | 格式、lint、类型全部通过，无警告。`.verify/g-identity-data/check.log`。                                                                                                                              |
| g 内 `pnpm test`                                         | 0      | 9 个文件、46 个测试通过。`.verify/g-identity-data/test.log`。                                                                                                                                        |
| `bash scripts/verify.sh` 首跑                            | 1      | 9 个脚本中 2 个失败。c-data-auth 的旧 schema 精确断言失败，g 的格式门禁遇到运行期间新增的未格式化文档。已格式化文档。其他 P1 脚本通过，包括 e-project 的真实 Chromium。`/tmp/p2-a-verify-full.log`。 |
| `bash scripts/verify.sh` 第二次                          | 1      | 9 个脚本中 3 个失败。a-base 与 b-tooling 前置检查仍拒绝文档格式，c-data-auth 拒绝新增 schema。随后串行 `pnpm fmt && pnpm check` 退出 0，本轮末尾 g 全 PASS。`/tmp/p2-a-verify-full-second.log`。     |
| `bash scripts/verify.sh` 最终复跑                        | 1      | `Verification scripts=9 failed=1`。只有 c-data-auth 的旧 schema 精确断言失败，其他 8 个脚本包括 g 全 PASS。日志 `/tmp/p2-a-verify-final.log`，失败明细 `.verify/c-data-auth/schema.log`。            |

迁移及约束、独立数据库的领域行为、真实生产启动与健康检查、文档与接口清单均已验证。`pnpm check` 与 `pnpm test` 已验证通过。全量验收已运行，但全绿条件未满足，阻塞是范围外的旧 schema 断言，不能标记为全部 ACCEPTANCE 通过。

8 组行为测试覆盖真实迁移和约束、成员重复及移除、DM 幂等和跨 Project 身份、profile 更新与第二个进程读取持久数据、两个用户的全部 Project 领域读写隔离、消息时间并列排序及伪造 sender、所有写入口的 hook 和真实诊断 INSERT 失败回滚，以及配置缺省与 patch 清空。第二个进程重用同一 SQLite 文件，不复用原进程的模块或连接缓存。

P1 的 `scripts/verify/c-data-auth.sh` 精确断言旧的表清单、索引清单与迁移记录数为 1。P2 新增 schema 后这些旧断言不再成立。该脚本不在本 unit 写入范围，未修改。需要 coordinator 授权负责该脚本的 unit 更新兼容断言，同时保留对 P1 表和索引的检查。

## 与原 Sprout 的关系

已读取原 Sprout `5b48a53b3` 的 `src/agent/model.ts` 和 `src/conversation/model.ts`。采用全局 Agent 身份、Project 内持久对话，以及 profile 与 conversation 唯一确定分身的方向。Project 内 DM 通过关系查询复用身份，不使用 canonical pair 的哈希。

Mio 使用就地更新的 profile、当前 Project 成员集合与持久 conversation_member。未引入 append-only 配置版本、成员历史、privacy 脱敏层或原 Sprout 的四种 conversation scope。P2 的 kind 只有 `dm`。

## 未验证项与后续工作

本 unit 未实现真实 Pi 会话、run、执行快照、宿主仓库、Machine、租约、Task、Group 或 Public Channel。多进程 SQLite 并发与写锁竞争未做验收。IMMEDIATE 事务只说明当前写入使用的锁模式，不作为并发能力证明。

本 unit 未增加页面、路由或 server function。P2 的真实 Chromium DM 流程、完整生产 HTTP 上的两个 Project 隔离和生产重启后的 DM 页面持久化，需要 b、c、d、e unit 验证。当前已有第二个领域子进程的数据持久化证据，以及两次真实生产健康检查证据。

后续 b、c、d 只调用上述领域服务，不自行写 SQL。需要修改契约或 schema 时交回数据 unit，经 coordinator 协调。P3 接入真实运行时再定义配置快照与 Pi 会话映射。
