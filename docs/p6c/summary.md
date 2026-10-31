# P6c 章节结论：成员治理、移除与重新加入

P6c 交付「Human 在页面上看清一个 Agent 还背着哪几类未结责任、逐项处理后在正常移除后真实失去参与权，并在重新加入时按当前授权只恢复该恢复的部分」这一条链路。判据、返回形状、错误映射与边界见 [P6c 契约](contracts.md)。

技术交付基线：**`092d220`**（`integration/p6c` 当前头，也是本轮取证的门禁受验提交）。

| 项       | 值                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------- |
| 交付线   | 功能、UI、集成三线                                                                                       |
| 新增契约 | `src/contracts/project-member-removal.ts`                                                                |
| 新错误码 | `project_member_removal_blocked`（进 `APP_ERROR_CODES` 闭集，唯一强制携带 `details` 的 `AppError` 分支） |
| 迁移     | 无；沿用 P6b 的 `0028` 及更早                                                                            |
| 门禁     | 3 条 P6c 门禁 + 1 条 P6c 页面门禁 + 4 条回归                                                             |

## 交付了什么

1. **四类前置阻塞，一次读齐，形状固定。** `collectProjectMemberRemovalBlockers` 按 `active_runs` → `leases` → `owner_duties` → `dm_assigned_tasks` 的顺序返回非空分组，每组内按 ID 升序、去重、不截断；每类都限当前 Project。判据与排除项见 [P6c 契约](contracts.md#四类事实的判据)。
2. **结构化拒绝，不是笼统 conflict。** 移除被拒时返回 `project_member_removal_blocked` 与 `details`（`projectMemberRemovalBlockersSchema`），并且**零写入**：全库快照逐表不变、不写 `project_member.removed` 诊断、不推进 `governance_revision`。
3. **待交接目标也是真实责任。** `leases` 分组区分 `relation = holder | handoff_target`；fencing 且存在指向该 Agent 的 pending handoff 时同样阻止移除，`pendingMutationId` 指给页面定位；交接完成或撤销后这一责任消失。
4. **移除后的授权立即生效。** 普通 Group 的 `chat_member` 行物理删除并对真正被删到的群推进治理版本；Public Channel 参与权随 Project 成员派生而消失；DM 归档；pending 输入改成 `cancelled` / `membership_revoked`；历史消息仍可读但以该 Agent 身份发言一律被拒。
5. **重新加入只恢复 Public Channel 与既有 DM。** `addProjectMember` 在同一事务里插回 `project_member` 并取消 DM 归档；普通 Group 成员身份不自动恢复；旧消息、被取消的输入与旧 run 的 grant 不恢复任何参与权。
6. **Public Channel 换 owner 的合法入口。** 只有本 Project 创建者那个 Human 能成为新 owner（Human owner 必须是 `project.created_by`），DM 恒不可换，普通 Group 仍可换给有效成员的 Agent。
7. **页面。** 成员页按固定四组渲染阻塞原因、标题与关联入口（Chat、Machine 租约页、Task 详情），窄屏可读；频道详情出现负责人变更入口，DM 没有该入口。
8. **移除与撤销分家。** `revokeRemoteToolGrant` 只让一次运行的远端凭据失效，不删成员；`removeProjectMember` 幂等（重复或并发移除只产生一次副作用），被拒时零写入。见 [P6c 契约](contracts.md#移除与撤销的分工)。

明确不在 P6c：强制移除、自动 `stop`/`release`/重新分配、成员 tombstone、Human inbox、新迁移号、P7 的手机与 PWA 整体验收。

## 怎么验的

| 门禁                           | 覆盖什么                                                                                                                                                                                                                             | 重跑                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p6c-member-removal`           | 四类阻塞各自成立且互不吞并、逐项解除、被拒零写入快照、`handoff_target` 责任与完成后不再阻塞、跨 Project 同 profile 对照组、两进程并发只产生一次移除副作用与幂等                                                                      | `bash scripts/verify/p6c-member-removal.sh`                                                                                                                      |
| `p6c-participation-revocation` | 撤权后 pending 输入与 admitted 结果的处置、迟到消息与旧 run grant 零投递、待交接目标先解除再移除、重新加入只对新输入生效、异步唤醒的陈旧候选                                                                                         | `bash scripts/verify/p6c-participation-revocation.sh`                                                                                                            |
| `bf-p6c-lifecycle`             | 真实 SQLite 文件 + 真实生产函数（含真实 remote grant 的空转 runner 与 fork 子进程）跑八条生命周期不变量：阻塞形状、逐项解除、handoff 责任、移除/重加事实、撤销 vs 移除与 grant 范围、频道换 owner 边界、并发、SIGKILL 中断后重启收敛 | `bash scripts/verify/bf-p6c-lifecycle.sh`                                                                                                                        |
| `p6c-member-governance-ui`     | 生产构建 + 真实 server + 真实 SQLite，16 条浏览器断言（分组顺序、四类各一条、对象链接、窄屏、频道 owner 候选与更新、DM 无入口、Group owner 行为、Group 移出成员、项目级移除、DM 归档与重加恢复、聊天窄屏）                           | `bash scripts/verify/p6c-member-governance-ui.sh`                                                                                                                |
| 回归                           | `i5-project-removal`（被拒错误码从 `conflict` 改成结构化阻塞，d10 拒绝优先仍成立）、`i7-chat-scope`（移除后旧 run 身份在群/频道一律 `not_found`）、`as-p5a-chat-ui`（频道成员动作 0 个、负责人动作恰好 1 个）、全量 `pnpm test`      | `bash scripts/verify/i5-project-removal.sh`、`bash scripts/verify/i7-chat-scope.sh`、`bash scripts/verify/as-p5a-chat-ui.sh`、`bash scripts/verify/b-tooling.sh` |

上面的门禁执行记录来自集成线与两轮独立验收报告（编排目录，不进本仓库）；本轮是**文档收尾**，只亲自跑了文档门禁与 `pnpm check`，实际退出码与失败原文见 [本轮执行记录](#本轮执行记录)。

## 功能线证据

功能线交付的是「四类阻塞 + 逐项解除 + 移除/重加后的事实 + 撤销与移除分家」这一组行为，全部由领域函数与真实 SQLite 断言，不走 mock 领域层。

- **四类阻塞的形状**：`p6c-member-removal` 逐类种出 `active_runs`（`queued`/`running` 都算，终态不算）、`leases`（`held` 与 `fencing` 都算，`free` 不算）、`owner_duties`（普通 Group 与 Public Channel 的 Agent owner，含 archived 群与无活跃 run 的遗留频道 owner）、`dm_assigned_tasks`（DM + Agent 成员 + `assigned`）后各断言一次：命中即 `project_member_removal_blocked`、`details.blockers` 的 kind 序列只有那一类、调用前后全库快照逐表相等。
- **逐项解除**：四类同时存在 → 每次只处理一类，剩下的类别与条目数量按预期递减；全部解除后 collector 返回空数组、移除成功。
- **`handoff_target`**：种出 fencing + pending handoff 指向该 Agent 后移除被拒且 `relation = handoff_target`、`pendingMutationId` 指给页面；把交接完成掉，同一 Agent 立刻可以移除，且历史 handoff 不再阻塞。
- **移除与重加后的事实**：`bf-p6c-lifecycle` 第 4 条断言普通 Group 成员行消失、DM 归档、`chat_effective_member` 不再含它；重新加入后 DM 取消归档、Public Channel 参与权回来、Group 成员身份**不**自动回来。
- **撤销与移除的分家**：`p6c-participation-revocation` 证明被取消的 pending 输入、迟到消息、旧 run 的 grant 都不再产生投递，重新加入只对新输入生效；`bf-p6c-lifecycle` 第 5 条用真实 grant 证明撤销后凭据失效但成员行不受影响。

证据提交 `092d220`：重跑 `bash scripts/verify/p6c-member-removal.sh`、`bash scripts/verify/p6c-participation-revocation.sh`。

## UI 线证据

页面只做两件事：把阻塞原因摆清楚并给出去处，把移除/重加后的状态如实显示。

- 成员页的四组阻塞按契约顺序渲染，每组标题、对象标题/短 ID、关联链接（Chat、Machine 租约页、Task 详情）都在；`member_blockers_mobile` 与 `chat_mobile` 两条断言在窄屏下核对可读与可点。
- 频道详情出现负责人变更入口（`channel_owner_candidate` / `channel_owner_updated`），DM 没有该入口（`dm_no_owner_entry`）；普通 Group 的成员与 owner 治理行为不变（`group_owner_behavior`、`group_member_removal`）。
- 移除后成员行消失且 DM 显示为归档（`project_member_removed`、`removed_dm_archived`），重新加入后 DM 恢复可用（`rejoined_dm_restored`）。
- 阻塞文案区分「先停运行 / 先释放租约 / 先变更负责人 / 先改派或完成任务」，`handoff_target` 单独提示处理待决交接而不是「已经释放」。

页面形状由接线单元按 P6c 契约实现并自检，本仓库**没有** P6c 设计的 Human 确定记录（I-P6c 第 2 条按规则勾的是「UI 线交付就绪、编排者已核对范围与自检证据」，不等于 Human 选定了原型）；Human 真实体验确认仍未进行。

证据提交 `092d220`：重跑 `bash scripts/verify/p6c-member-governance-ui.sh`；聊天页回归 `bash scripts/verify/as-p5a-chat-ui.sh`。

## 集成线与技术验收证据

集成门禁 `bf-p6c-lifecycle` 是 P6c 的唯一集成证据：真实 SQLite 文件、真实生产函数（`collectProjectMemberRemovalBlockers`、`removeProjectMember`、`revokeProjectAgentEnrollment`、`setChatOwner`、`abortAgentRun`、`mutateTask`、`toDomainAppError`），加上真实 remote grant（用空转 runner 换真实 grant）与 fork 出来的子进程，跑八条不变量：阻塞形状与零写入、逐项解除、handoff 责任、移除/重加事实、撤销 vs 移除与 grant 范围、频道换 owner 边界、并发一次性、SIGKILL 中断后重启收敛。每次运行留下 `base-commit`、`source-sha256.txt` 与 `exit-code` 到 `.verify/p6c-lifecycle`。

需要说明比对口径：集成门禁比对四个分组的 kind 序列、每组的条数、以及每个条目**被选的 5 个标量字段**与诊断事件条数——不是「逐字段相等」。整行逐字段相等只在跨 Project 对照组里用（`crossProjectRows()` 快照）。

**独立技术验收**：第二轮报告的总评是「可以合入 main」，受验提交 `c78fe8a`（与 `092d220` 之间的差异只有一处注释订正与一条 `.strict()` 解码断言，见下节）。第一轮的三条 P1/P2 全部关闭，各自用改坏实验证明能红；本轮无阻断项。验收报告在编排目录（不进本仓库），本章不因此视为 Human 体验确认。

证据提交 `092d220`：重跑 `bash scripts/verify/bf-p6c-lifecycle.sh`。

## 第二轮独立技术验收结论与残余

第二轮验收在 `c78fe8a` 上判定「可以合入 main」，并留下以下非阻断结论。它们属于「已知且已解释」，不是待修缺陷：

1. **负载敏感的既有测试偶发红。** `tests/verify-runner.test.ts` 有一条信号测试在满载时（主机 load 约 13 / 10 核）偶发 `kill EPERM`：`signalProcessGroup` 的 `process.kill(-pid, SIGTERM)` 抛错，`ps` 兜底没通过后重抛，退出码 1 而不是 143。随后单文件 3/3 绿、全量 2/2 绿、`b-tooling` 2/2 绿。这是负载敏感，不是 P6c 引入的失败；重跑 `pnpm test tests/verify-runner.test.ts`。建议（留给协调者）把 `ps` 超时或非 0 视为「无存活进程组」，或把 `EPERM` 降级为日志。
2. **跨 Project 隔离是冗余层。** `active_runs`、`leases`、`dm_assigned_tasks` 三类各有 2–3 层 Project 过滤（instance 归属、`agent_run`/`machine_lease`/`task.projectId`、`chat.projectId`）。只删任意一条，门禁仍是绿的；删掉某一类的整组过滤才会红。所以「每一处过滤都被单条断言钉住」不成立——被钉住的是**整类隔离**。见 [已知限制与未证明项](#已知限制与未证明项)。
3. **`as-p5a-chat-ui` 的出处注释写错了，已在 `092d220` 订正。** 真正钉住「只有 Project 创建者能换 owner」的是 `bf-p6c-lifecycle` 的 `invariant.6.channel-owner`（删掉 `setChatOwner` 的创建者断言后该门禁红、`chat-governance` 单测仍绿），不是 `tests/chat-governance.test.ts`。同一个提交给阻塞类错误分支的 `.strict()` 线上解码补了断言（测的是 `appErrorSchema.safeParse`，因为 `toAppError` 只按字段白名单取值，看不出严格性）。
4. **P3-2 与 P3-5 只是措辞问题。** 集成报告里的「逐字段相等」严于门禁实际做的 5 字段投影，已在 [集成线与技术验收证据](#集成线与技术验收证据) 写清；「格式门禁本来就红」在受验头上已过期（`pnpm exec vp fmt --check` 在 `9c286a3` 与 P6b 的修正之后就已是 exit 0）。

## 已知限制与未证明项

这些限制都有确定的后果与重跑入口。它们不阻断合入，但读者不能把「门禁绿」当成下面这些已被证明。

### 1. HTTP 认证边界没在集成门禁里跑

- **边界**：`bf-p6c-lifecycle` 把阻塞事实断言到「领域错误 + `toDomainAppError()` 映射出的 `project_member_removal_blocked` payload」，没有走 `removeProjectMemberBoundary` 的 `requireSession(headers)`（要真实 better-auth 会话 cookie）。
- **后果**：阻塞载荷在 HTTP 层的形状与认证拒绝只由 `tests/project-agents.test.ts`（匿名、跨用户、重复移除）与页面门禁覆盖；「领域正确但 HTTP 边界漏了登录校验」这类缺陷，本门禁单独看不出来。
- **重跑**：`bash scripts/verify/p6c-member-governance-ui.sh`（HTTP 与页面）、`pnpm test tests/project-agents.test.ts`（headers 级拒绝）。

### 2. 「移除后 DM 不可继续聊天」只证到守卫的输入不存在

- **边界**：DM 的 `chat_effective_member` 分支按 d14 不因 Project 移除消失（成员行保留），而 `sendMessage` 在 d19 守卫之前还有一步活跃 run 校验。移除后不可能存在活跃 run，所以要命中 d19 的分支就得先违反阻塞规则、或直写一条不可能状态的 run 行。门禁因此停在「守卫的输入不存在」：`project_member` 行消失 + DM 已归档 + Human 发言在写入前得到 `conflict`。
- **后果**：Agent 侧的 DM 发言拒绝没有在 P6c 里被直接命中；它由 `i5-project-removal`（旧身份在三个对话里一律 `not_found`）与 `i7-chat-scope`（旧 run 身份跨 Project/跨对话被拒）间接覆盖。
- **重跑**：`bash scripts/verify/p6c-participation-revocation.sh`、`bash scripts/verify/i5-project-removal.sh`、`bash scripts/verify/i7-chat-scope.sh`。

### 3. 真实排空中的 handoff 未跑

- **边界**：fencing + pending handoff 是 fixture 直写的中间态。生产中它出现在交接目标排空执行期间（`handoffLease` 没有待排空执行时会当场完成、落成 holder 责任），而本机门禁没有真实 Worker 执行可排空。
- **后果**：被证明的是「这个中间态作为责任被正确报告、被正确解除」，不是「真实排空完成后交接落地」的时序。真实时序属 `z-lease-integration` / `ap-p4d-handoff-worker` 那一类需要真实 Worker 的门禁。
- **重跑**：`bash scripts/verify/p6c-member-removal.sh`（中间态责任）、`bash scripts/verify/z-lease-integration.sh`（真实排空）。

### 4. 机器侧释放租约是直写

- **边界**：解除 `leases` 阻塞时用直写把 `machine_lease.state` 改成 `free`，因为 `releaseLease` 要求持有者那次 run 仍是 `running`，而该场景按产品顺序先停 run。
- **后果**：「先停 run 再释放」这条真实路径没有被这一条断言走过；它由 `v-lease-contracts` 与 `i5` 系列覆盖。同理，`lease_authorization` 的 held/fencing 行也是直写。
- **重跑**：`bash scripts/verify/p6c-member-removal.sh`、`bash scripts/verify/v-lease-contracts.sh`。

### 5. 跨进程并发只覆盖「同一 Agent 的移除」

- **边界**：两个进程同时移除同一 Agent，证明「只产生一次副作用、失败方零写入、不留半移除状态」。没有制造「检查通过后另一进程插入新 run / 新租约 / 新 owner / 新 Task」的竞态时序；设计依赖的是 `sqlite.transaction(...).immediate()` 的串行化与各写端自检，那是代码依据，不是时序证据。
- **后果**：「阻塞检查与写入之间没有可见窗口」在并发写端下未被实跑证明。另外 `pending` 交接的匹配条件是 `expectedGeneration === 当前 generation`，如果出现不一致的异常状态，collector 可能漏掉它（需要违反「同一机器只允许一条 pending」的写入纪律才能构造，验收者未构造出来）。
- **重跑**：`bash scripts/verify/p6c-member-removal.sh`、`bash scripts/verify/bf-p6c-lifecycle.sh`。

### 6. `revokeProjectAgentEnrollment` 的「已通过检查」前提没被单独证伪

- **边界**：这个内部 helper 现在遇到阻塞会抛结构化错误（而不是静默清理）；P6c 只通过移除路径间接覆盖它。
- **后果**：绕过 `removeProjectMember` 直接调用它时，如果将来有人改成「先清理再检查」，移除路径的断言仍会绿。第二轮验收者用一次性探针补证过（有阻塞时抛错且全库零变化；无阻塞时删 Group 成员行但不动 `project_member`），但探针没有进仓库，所以没有可重跑的证据。
- **重跑**：`bash scripts/verify/p6c-participation-revocation.sh`（间接覆盖）。

### 7. 直写表的清单与理由

`bf-p6c-lifecycle` 与 `p6c-member-removal` 里直接写表的地方只有下面几处，各自都写在代码注释里：

| 直写对象                                                   | 理由                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `agent_run` 的运行行（running/queued）                     | 真实 run 由 pi-host 拉起，集成门禁不跑推理；要用活动运行制造阻塞，只能直接种这一行                                  |
| `machine_lease` + `lease_authorization` 的 held/fencing 行 | 没有真实 Worker 进程能跑出「机器侧已持有」或「正在排空」的租约；真实 release/handoff 属上面第 3、4 条覆盖的门禁     |
| `chat.owner_kind/owner_id` 的频道 Agent-owner 行           | 产品入口不允许产生它（频道 owner 只能是创建者那个 Human）；它是历史遗留数据形态，只能直写才能证明「遗留行仍是责任」 |
| grant 的两个时间列（`issuedAt` / `expiresAt`）             | 用真实 grant 证明「过期即拒」需要把时钟推到过期之后；凭据本身、哈希与调用路径都是真实的                             |

**后果**：这四类直写换来了「中间态与遗留态作为责任被正确处理」的覆盖，代价是「真实产生这些行的路径」不在本门禁里。除此之外，成员行、群成员行、Task、DM 归档、治理版本、诊断事件全部走生产函数。**重跑**：`bash scripts/verify/bf-p6c-lifecycle.sh`。

### 8. 其他未跑或未覆盖的项

- 第二轮验收只跑了与该章直接相关的门禁；`v-lease-contracts`、`i3-public-channel`、`i4-agent-fanout`、`ap-p4d-handoff-worker`、`z-lease-integration` 本章没有实跑（结论引用自既有交付）。真实 Worker 的 release/handoff/排空时序依旧缺真实证据。
- 页面断言只在**本机 Chromium** 跑通；没有做 390px 之外的视口、其他浏览器或真实网络延迟的复核。
- `dm_assigned_tasks` 的「跨 Project DM」与「同一 Agent 多个 DM」没有构造；collector 按 `chat.projectId` 与 `task.projectId` 双过滤，但门禁只覆盖单 Project 单 DM。

## 计划状态与本轮门禁冲突

本轮按证据把 I-P6c 前三条、`P6c` 三条（本节原列两条，第三条按 I-P6c 的「证据」行补齐）与 `UI-P6c` 两条勾选，I-P6c 第 4 条（Human 体验确认）保持待办。`scripts/verify/l-docs.sh` 目前仍把 `I-P6c`、`UI-P6c`、`P6c` 钉成「必须留空」，因此本轮执行 `bash scripts/verify/l-docs.sh` **exit 1**。没有为了让门禁变绿而改 `scripts/verify/**`：按 P6a/P6b 的处置，由协调者在文档交付之后改这条门禁的期望值。

失败原文（本轮实跑，`bash scripts/verify/l-docs.sh`，exit 1；f-docs 子步骤本身通过，上面五行 PASS 即其输出。三条打印成 `- [x]` 的行原文末尾有一个空格，已被格式化门禁去掉）：

```text
FAIL I-P6c checkbox must remain unchecked: 功能线交付就绪，编排者已核对本单元范围、版本、验证证据与已知限制。证据 [P6c 功能线证据](p6c/summary.md#功能线证据)，基线 `092d220`，重跑 `bash scripts/verify/p6c-member-removal.sh`、`bash scripts/verify/p6c-participation-revocation.sh`；契约见 [P6c 契约](p6c/contracts.md#阻塞检查的契约形状)。
FAIL I-P6c checkbox must remain unchecked: UI 线交付就绪，编排者已核对 Human 确定的设计、演示代码与自检证据。证据 [P6c UI 线证据](p6c/summary.md#ui-线证据)，基线 `092d220`，重跑 `bash scripts/verify/p6c-member-governance-ui.sh`；页面形状由实现单元按 P6c 契约自检，本仓库没有 P6c 设计的 Human 确定记录（见该节同一条限制）。
FAIL I-P6c checkbox must remain unchecked: 集成线完成接入与自检，独立技术验收通过，编排者已核对结论与可运行版本。证据 [P6c 集成线与技术验收证据](p6c/summary.md#集成线与技术验收证据)，基线 `092d220`，重跑 `bash scripts/verify/bf-p6c-lifecycle.sh`；第二轮独立验收在 `c78fe8a` 判「可以合入 main」（验收报告在编排目录，不进本仓库）。
FAIL UI-P6c checkbox must remain unchecked: 完成 Agent 移除前置检查、阻塞原因与关联处理入口，以及正常移除后的 Group 退出、DM 归档和重新加入的恢复呈现。证据 [P6c UI 线证据](p6c/summary.md#ui-线证据)，基线 `092d220`，重跑 `bash scripts/verify/p6c-member-governance-ui.sh`；阻塞分组与对象链接形状见 [P6c 契约](p6c/contracts.md#阻塞检查的契约形状)。
FAIL UI-P6c checkbox must remain unchecked: 核对普通信息可见性与聊天正文访问、对象操作权限的区别，完成全章演示和交付材料。证据 [P6c 集成线与技术验收证据](p6c/summary.md#集成线与技术验收证据)与[P6c 契约](p6c/contracts.md#public-channel-换-owner-的边界)：频道只有 Project 创建者那个 Human 能成为新 owner、DM 无入口、移除后该 Agent 的对话读写按当前授权被拒；重跑 `bash scripts/verify/bf-p6c-lifecycle.sh`。
FAIL P6c checkbox must remain unchecked: - [x]
FAIL P6c checkbox must remain unchecked: - [x]
FAIL P6c checkbox must remain unchecked: - [x]
FAIL l-docs 8 checks failed
```

上面的 8 条失败全部是「预期仍留空」的期望值，不是格式、链接或证据解析错误：`l-docs` 的 f-docs 子步骤全绿，说明新增小节、锚点、被引小节里的提交与重跑命令都解析通过。

## Human 体验确认

- 状态：**待确认**。
- 确认记录：无。
- 待办：启动真实页面评审，由 Human 亲自走「四类阻塞 → 逐项处理 → 移除 → 重新加入」，明确回复确认并记录版本；确认前 I-P6c 第 4 条不勾、本章不算完整收口。

## 本轮执行记录

- 交付：`docs/p6c/contracts.md`（新增）、`docs/p6c/summary.md`（新增）。
- 计划状态：`docs/development-plan.md`（I-P6c 四条、状态行）、`docs/development-plan-functional.md`（`P6c` 三行与依赖表状态）、`docs/development-plan-ui.md`（`UI-P6c` 两行与依赖表状态）按证据勾选；未取证的一条保持未勾。
- 计划文档的 `P6c` 小节原本只有两条 checkbox，本轮按 I-P6c 的「证据」行（阻塞/处理/移除/重加的权限和参与矩阵、撤权反证）补齐第三条并勾选；这是把已有章节要求写全，不新增产品范围。
- 门禁：只跑了 `bash scripts/verify/l-docs.sh`（exit 1，8 条「必须留空」期望值冲突，原文见上一节）、`bash scripts/verify/f-docs.sh`（exit 0）与 `pnpm check`（exit 0，本仓 599 个文件格式正确、lint 0 error / 12 warning）；没有改 `scripts/verify/**`，没有改产品代码、测试、契约或迁移。
- 未亲自执行：`p6c-member-removal`、`p6c-participation-revocation`、`bf-p6c-lifecycle`、`p6c-member-governance-ui`、四条回归与全量 `pnpm test`。本文对这些门禁的结论标注为「引用」，来源是集成线报告与两轮独立验收报告（编排目录，不进本仓库）。
