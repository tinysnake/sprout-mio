# P6c 契约：成员治理、移除与重新加入

本文记录 I-P6c 在 `integration/p6c` 上冻结的共享契约，供后续章节（P7、R1）与前端接线引用。基线代码头 `092d220`（P6c 的最后一个代码与门禁提交；其后的提交只改文档）。

标注约定：**实测**＝本轮亲自执行并核对过输出；**引用**＝读源码、schema 或既有报告得出，未重复执行；**未验证**＝已知但未在本轮取证的推断。

**无新迁移。** P6c 只读既有表（`agent_instance`、`agent_run`、`agent_run_input`、`machine_lease`、`lease_authorization`、`lease_mutation`、`chat`、`chat_member`、`chat_effective_member`、`task`、`project_member`），`drizzle/` 最后一个迁移仍是 P6b 的 `0028_p6b_turn_context.sql`。不新增持久 blocker 表、成员 tombstone、租约状态或 Human inbox，也不改 Task 四态与 `message.senderKind`。**引用**

## 阻塞检查的契约形状

`src/contracts/project-member-removal.ts` 是本单元唯一新增的共享契约文件，只依赖 Zod 与共享 ID 规则，不导入 DB、React 或 runtime。**引用**

| schema                                   | 形状                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectMemberRemovalBlockerKindSchema`  | `"active_runs" \| "leases" \| "owner_duties" \| "dm_assigned_tasks"`，这个枚举的声明顺序就是对外分组顺序                                                                      |
| `projectMemberRemovalChatRefSchema`      | `{ chatId, chatKind: dm \| group \| public_channel, title: string \| null }`                                                                                                  |
| `projectMemberRemovalRunRefSchema`       | `{ runId, instanceId, status: queued \| running, chat }`                                                                                                                      |
| `projectMemberRemovalLeaseRefSchema`     | `{ key: { projectId, machineId }, machineName, generation, state: held \| fencing, holderInstanceId, pendingMutationId: string \| null, relation: holder \| handoff_target }` |
| `projectMemberRemovalOwnerRefSchema`     | `{ chat }`，其中 `chatKind` 收窄为 `group \| public_channel`，DM 不能出现在这一组                                                                                             |
| `projectMemberRemovalTaskRefSchema`      | `{ taskId, title, status: "assigned", chat }`，其中 `chatKind` 收窄为 `dm`                                                                                                    |
| `projectMemberRemovalBlockerSchema`      | 按 `kind` 的 discriminated union；**每一支的 `items` 都是 `nonempty()` 数组**——有分组就必须有内容，空分组不是合法的阻塞                                                       |
| `projectMemberRemovalBlockersSchema`     | `{ projectId, agentProfileId, blockers }`，`blockers` 非空，另加 `superRefine` 约束（见下）                                                                                   |
| `projectMemberRemovalBlockedErrorSchema` | `{ code: "project_member_removal_blocked", message, requestId, details: projectMemberRemovalBlockersSchema }`                                                                 |

`projectMemberRemovalBlockersSchema` 的 `superRefine` 冻结三条约束：分组必须唯一、必须按枚举声明顺序严格递增（`active_runs` → `leases` → `owner_duties` → `dm_assigned_tasks`，逆序或重复都判非法）；`leases` 分组里每一行的 `key.projectId` 必须等于 `details.projectId`，跨 Project 的租约 key 不合法。**引用**

**排序与不截断**：分组内一律按对象 ID 升序，重复 join 先用 ID 去重再排序。活动 runs 按 `runId`；租约按 `key.machineId`（Project 已固定）；owner 职责按 `chatId`；DM assigned Tasks 按 `chatId` 再按 `taskId`。比较用固定 code-point 顺序（实现是 JavaScript 字符串 `<`，在本仓库的 ID 字符集 `前缀_小写十六进制` 下与 code-point 相同），不用 `localeCompare`、翻译后的标题、`rowid` 或创建时间决定对外顺序；查询不加 `LIMIT`，不因为「只显示五项」漏掉阻塞——页面可以折叠或分页，但不能让 collector 少返回一条。**引用**

- 证据提交 `092d220`：重跑 `bash scripts/verify/p6c-member-removal.sh`。

## 错误码与边界映射

`project_member_removal_blocked` 是封闭集合 `APP_ERROR_CODES`（`src/contracts/result.ts`）里的成员，`ProjectMemberRemovalBlockedError` 是 `AppError` 联合里唯一强制携带 `details` 的分支。**引用**

- `AppError` 写成 `ProjectMemberRemovalBlockedError | { code: Exclude<AppErrorCode, "project_member_removal_blocked">, message, requestId }`：这个错误码只能走富形状，不能退化成只有 `code/message/requestId` 的普通错误。
- `appErrorSchema` 是 `discriminatedUnion("code", …)`，该分支用 `projectMemberRemovalBlockedErrorSchema.strict()`：线上载荷多一个未登记字段就解码失败。`tests/contracts.test.ts` 直接打 `appErrorSchema.safeParse` 来钉这条严格性——`toAppError` 只按字段白名单取值，看不出 `.strict()`。
- `toAppError()` 同样是白名单取字段：只有 `code === "project_member_removal_blocked"` 时才把 `details` 放进候选对象。所以缺 `details`、`details` 形状不对（空分组、乱序、categories 之外的值）都会落到 `internal`，不会把半成品载荷当业务错误发出去。
- 领域侧 `ProjectMemberRemovalBlockedError` 在构造函数里就 `projectMemberRemovalBlockersSchema.parse(details)`：投影不合法当场抛 `ZodError`，不会留一个「形状错误但已发出」的错误对象。
- `toDomainAppError()`（`src/server/functions/domain-errors.ts`）把领域错误实例映射成 `AppError`；命中这个码时用 `projectMemberRemovalBlockedErrorSchema.safeParse` 重新校验，失败返回 `undefined`（交给上层落 `internal`），成功则原样返回带 `details` 的载荷。
- RPC 边界（`src/server/functions/agent.ts` 的 `failure()`）对映射结果再 `projectMemberRemovalBlockedErrorSchema.parse(mapped)`，因此 `removeProjectMemberFn` 的失败响应里 `requestId` 与外层一致、`details` 与领域投影逐字段一致。

消息文案属于契约的一部分：默认「该 Agent 仍有未结责任，请先处理全部阻塞」；当且仅当 `leases` 分组里存在 `state === "fencing"` 的行时追加「；fencing 租约请等待确认或前往租约页处理」。待确认交接仍算 `fencing`，不提示「已经释放」。**引用**

## 四类事实的判据

collector 是 `collectProjectMemberRemovalBlockers(projectId, agentProfileId)`（`src/domain/agent.ts`）：一次读齐四类，全部限当前 Project，同一个事务快照内完成；在事务外调用时自己开一个 deferred 事务。它只收集事实，不写任何行。**引用**

| kind                | 判据                                                                                                                                                                                                                                                                                                                                   | 明确的排除项                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `active_runs`       | 取 `agent_instance`（`project_id = P` 且 `agent_profile_id = A`）的全部 instance ID，再查 `agent_run` 里 `instance_id ∈ 这些`、`status ∈ {queued, running}`、`agent_run.project_id = P`、且 `chat.project_id = P` 的行                                                                                                                 | `completed`/`failed`/`aborted`/`interrupted` 都不算活动；pending 输入不算活动 run；不把「有 dispatch 记录」当活动                       |
| `leases`            | `machine_lease.project_id = P` 且 `state ∈ {held, fencing}`；再逐行判定 `holderInstanceId ∈ A 的 instance`（`relation = holder`），或 `state = fencing` 且存在同 key 的 `pending` `lease_mutation` 满足 `action = handoff`、`expectedGeneration = lease.generation`、`targetInstanceId ∈ A 的 instance`（`relation = handoff_target`） | `free` 不阻塞；没有 lease 行也不阻塞；`lease_authorization` 里旧的 `revoked` generation 不算占用；`holderInstanceId` 为 `null` 的行跳过 |
| `owner_duties`      | `chat` 里 `project_id = P`、`owner_kind = "agent"`、`owner_id = A`、`kind ∈ {group, public_channel}`                                                                                                                                                                                                                                   | 不以「有没有 Task」「有没有 instance」「是否 archived」过滤；DM 的 owner 是 Human 的 DB 不变量，不进这一组                              |
| `dm_assigned_tasks` | `chat(kind = "dm", project_id = P)` join `chat_member(member_kind = "agent", member_id = A)`，再 join `task(project_id = P, status = "assigned")`                                                                                                                                                                                      | `proposed`/`finished`/`canceled` 不阻塞；Group 与 Public Channel 的 Task 不算 DM 阻塞；不以「点过立即开始」或「有施工记录」为条件       |

四类互不吞并：任何一类命中都返回完整列表，不会因为先命中 `active_runs` 就跳过租约或 Task 的读取。被拒时既有四类同时存在，也按固定顺序分段返回。

- 证据提交 `092d220`：重跑 `bash scripts/verify/p6c-member-removal.sh`。

## `relation` 与 `pendingMutationId`

`relation` 回答「这次是因为它是持有者，还是因为它是待交接目标」：

- `holder`：`machine_lease.holder_instance_id` 属于该 Agent 在当前 Project 的 instance。只要还是 holder 就算责任，`held` 与 `fencing` 都算——fencing 只是「正在排空或等待确认」，不是已释放。
- `handoff_target`：租约正在 `fencing`，且对应一条 `pending` 的 `handoff` 变更把该 Agent 的 instance 指定为目标。它同样是真实责任：交接一旦落地，租约就换成这个 Agent 持有，所以提前移除会留下一个指向不存在成员的目标。同一个 Agent 既是 holder 又是目标时，`relation` 取 `holder`。
- `pendingMutationId`：只在 `fencing` 且匹配到 pending 变更时给出该变更 ID；`held` 或没有匹配变更时为 `null`。它只用于展示与定位，不参与「是否阻塞」的判定。

判定只用 `machine_lease.state` 与 `lease_mutation.state = "pending"`，不用 `lease_authorization.state`（`active`/`draining`/`revoked`/`free` 是历史授权事实，不能直接当租约状态）。**引用**

## Public Channel 换 owner 的边界

`setChatOwner`（`src/domain/chat.ts`）冻结三条判定，顺序在上限与成员校验之前：**引用**

1. DM 一律 `forbidden`「DM 不支持变更所有者」——DM 没有换 owner 入口，也没有对应按钮。
2. Public Channel 的新 owner 必须是 `human`，否则 `forbidden`；而 Human owner 又必须是 `project.created_by`，所以**频道的负责人只能是本 Project 创建者那个 Human**，其他 Human 与任何 Agent 都当不上。
3. Agent owner 必须是该对话的当前有效成员（读 `chat_effective_member`，且 `project_id` 匹配），否则 `not_found`。普通 Group 因此仍可换给 Agent；Project 移除后的 Agent 不在有效成员视图里，不能再被指定。

能力事实上，P6c 把「成员与 owner 治理只对普通 Group 生效」拆开：`canChangeMembers` 仍只看 `group`，`canChangeOwner` 变成 `kind !== "dm" && decide("owner_change", …)`，即频道重新出现一个合法的 owner 变更入口，而频道的成员仍由 Project 派生、不能独立增删。页面文案随之区分「可变更」与「当前身份不能变更负责人」。**引用**

- 证据提交 `092d220`：重跑 `bash scripts/verify/bf-p6c-lifecycle.sh`（第 6 条 `invariant.6.channel-owner`）；页面层回归 `bash scripts/verify/as-p5a-chat-ui.sh`。

## 移除与撤销的分工

- **`revokeRemoteToolGrant(runId)` 只废凭据，不删成员。** 它关掉内存里的 admission（把该 run 的 live 条目从 registry 删掉），再把 `remote_tool_grant.revokedAt` 写成 `max(now, issuedAt)`；`project_member`、`chat`、`machine_lease` 一行都不动，成员行也没有「已撤销」标记。它由 pi-host 在 run 收尾时调用，属于运行期凭据生命周期，不是成员治理。**引用**
- **`removeProjectMember(projectId, agentProfileId, ctx)` 是成员治理入口。** 整个流程在一个 `IMMEDIATE` 事务里：先 `assertProjectAccess` + `getAgentProfile`（所有者维度），再读 `project_member` 行——
  - 行不存在就**幂等空操作**：不重复清理、不写诊断、不推进治理版本、不再归档 DM。两个进程同时移除时只有一个产生副作用。
  - 行存在才进入写入：`writeIdentity` 里依次 `revokeProjectAgentEnrollment`（先跑阻塞检查；命中就抛结构化错误，此时**零写入**）、归档该 Agent 的 DM、删除 `project_member` 行。
- `revokeProjectAgentEnrollment` 是「Project 参与权撤销」的名称，与 `revokeRemoteToolGrant`（远端凭据）是两件事，不要混用：前者删普通 Group 的 `chat_member` 行（并只对真正被删到的群推进 `governance_revision`）、把该 Agent 全部 instance 的 `pending` 输入改成 `cancelled` / `membership_revoked`，后者只让一次运行的远端凭据失效。**引用**
- 被拒的那次请求不改任何持久事实：`p6c-member-removal` 的每条反例都在调用前后做全库快照比对（`assert.deepEqual(snapshot(), before)`）。**实测**（该门禁在 `092d220` 上自检通过，退出码 0；本轮未复跑，见 [P6c 章节结论](summary.md#集成线与技术验收证据)）。

## 重新加入的恢复边界

`addProjectMember` 在同一个事务里先插入 `project_member`，再对该 Agent 的既有 DM 取消归档。冻结的恢复范围：

- **恢复**：Public Channel 的参与权（派生自 Project 成员，自动回来）、既有 DM（取消归档，可以继续聊天）。
- **不恢复**：普通 Group 的成员身份。Group 的 `chat_member` 行在移除时被物理删除，重新加入不会补回——需要 Human 或群 owner 重新添加。
- 旧消息与待处理唤醒**不恢复**已撤销的参与权：被取消的输入保持 `cancelled`，迟到的旧消息与旧 run 的 grant 不再产生投递；重新加入只对**新输入**生效。**引用**（`revoke.stale-message-and-old-run-grant.zero-delivery`、`rejoin.only-channel-and-existing-dm.new-input-only` 两条断言）

- 证据提交 `092d220`：重跑 `bash scripts/verify/p6c-participation-revocation.sh`。

## 契约之外

- 阻塞检查的**执行顺序**（四类一次读完还是逐类早退）是实现细节；契约只要求结果形状、顺序与不截断。
- `project_member_removal_blocked` 的分级文案措辞可以调整，但「不提示已释放」与「fencing 要等待确认」是行为约束。
- 移除不自动 `stop`/`release`/重新分配：P6c 只报告阻塞、给处理入口，处理动作仍由 Human 在对应页面发起。
- 页面侧的折叠、排序展示与短 ID 兜底不属于共享契约；`ChatRef.title` 为 `null` 时由 UI 用 chat kind 与短 ID 显示。
