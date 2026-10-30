# I-P5a 项目级移除（阻断 / 在途 / 清理）—— 交付报告

单元：`p5a-removal`（裁定 d20）。分支 `p5a/removal`，基线 `integration/p5a` 头 `6cfea2c`。

设计 §4.4 的三步此前只完成了「参与权」那一半（`chat_effective_member` 视图已收回发言与 instance
资格）。本单元补齐另外两步，并把三步放进同一个事务。

## 1. 实现清单

| 位置 | 改动 |
| --- | --- |
| `src/domain/agent.ts:135-176` | `removeProjectMember` 改为单个 `.immediate()` 事务：访问权、profile 存在性、成员行读取与后面的写是同一个原子单位。命中幂等分支（成员行不存在）直接返回，不写诊断事件；否则在 `writeIdentity` 里先 `revokeProjectAgentEnrollment` 再删 `project_member` 行。 |
| `src/domain/chat.ts:763-816` | 新增 `revokeProjectAgentEnrollment(projectId, agentProfileId)`：owner 阻断 → 活跃 run 阻断 → 取消 pending 输入 → 删普通群 `chat_member` 行。D10/D11/D14 的处置语义只在这一个函数里实现。 |
| `src/domain/chat.ts:160-170` | 新增 `projectInstanceIdsOf`：跨对话算齐该 Agent 在本 Project 的 instance 集合。 |
| `src/domain/chat.ts:172-190` | `activeRunOf` 去掉 `chatId` 参数，只吃 instance 集合（instance 本身按 (对话, Agent) 唯一，原参数是冗余过滤）。 |
| `src/domain/chat.ts:191-212` | `cancelPendingRunInputs` 同上；取消语义（只动 `pending`、`membership_revoked`、写 `cancelledAt`）没有变化。 |
| `src/domain/chat.ts:716,727` | `removeGroupMember` 的两处调用点跟着改签名，行为不变（i2 门禁复跑绿）。 |
| `scripts/verify/i5-project-removal.sh` | 新门禁，`Risk → Test` 注释按 verify 约定写。 |
| `tests/fixtures/project-removal.ts` | 真实 SQLite + 真实域入口的 8 条断言组。 |
| `tests/project-agents.test.ts:181-187` | 契约改写：第二次移除从 `not_found` 改为 `ok`（见 §6(b)）。 |

契约与迁移：**零改动**。`membership_revoked` 早已在 `src/contracts/agent-run.ts:18` 的
`RunInputCancelReason` 与 `drizzle/0021_p5a_multichat_schema.sql` 的 `agent_run_input_cancel_reason_check`
里，不需要新枚举、不需要迁移。错误码沿用既有两个：`conflict`（owner / 活跃 run 阻断）与
`not_found`（越权、profile 不存在），没有新造所有权语义。

没有触碰：`drizzle/**`、`src/contracts/**`、`src/server/functions/chat.ts`（p5a-info 的读模型）、
`src/server/membership.ts`、`notices.ts`、`src/components/**`、`src/routes/**`、
`routeWakeCandidates`、扇出规则、能力表。

## 2. 活跃 run 策略：拒绝，而不是「先 fence 再移除」

两种做法都摆上来：

- **有活跃 run 就拒绝**：整次移除回 `conflict`，run 仍 `queued`/`running`，pending 输入原样，
  成员行与 `project_member` 行都不动，也不写 `project_member.removed` 诊断事件。
- **先 fence 再移除**：把该 Agent 的活跃 run 标成 `aborted`/`interrupted`、输入转 `cancelled`，
  然后照常删成员。看起来「一步到位」，但它是**一次被拒绝之外的第二种处置**。

选**拒绝**，三条理由：

1. d10 的字面与 rationale 都直接点名这条：「有活跃 run 时移除被拒、pending 输入取消；两种处置
   同时可发生时以拒绝为准，取消只在无活跃 run 时执行」，理由是「先取消再拒绝会让一次被拒的
   请求仍产生副作用」。fence 正好撞在这条上——它让一次最终被拒的治理请求留下中止 run 的痕迹。
2. 同一个系统里「移出」不能有两套语义。`removeGroupMember` 已经是「有活跃 run 就 `conflict`」
   （`src/domain/chat.ts:716-717`）；项目级移除改成 fence 会让群移除与项目移除对同一个状态给出
   相反结果，人无法从错误码判断自己该等还是该重试。
3. fence 需要一条本阶段不存在的语义。`cancel_reason` 的冻结枚举只有
   `membership_revoked` / `human_stop` / `group_dissolved`，没有「因项目移除而中止在途 run」的
   值；run 的终态转换（`agent-run.ts` 的 `NEXT`）也是执行侧权威。硬造这两条＝新迁移 + 新的
   取消语义，brief 明确要求停手。而 d11 已经把 `membership_revoked` 限定为「只作用于 pending
   未下发的输入」，所以清理步骤只碰 pending 不是妥协，是它本来就有边界。

**代价**（接受并记录）：人要移出一个正在跑的 Agent，必须先等 run 结束或手动停它。这与群成员移除
完全一致，不是本单元新引入的摩擦。可观测断言见下一条，两次被拒的移除都验了「输入仍 pending、
run 仍 queued、成员行仍在、诊断事件不增」。

## 3. 门禁场景证据（`bash scripts/verify/i5-project-removal.sh`，8 checks 全 PASS）

| brief 场景 | 断言（真实 SQLite 行 / 真实域入口） | 标签与输出 |
| --- | --- | --- |
| 1. owner Agent 被拒且项目成员仍在 | `removeProjectMember` → `conflict`；`project_member` 行仍在；群 owner 仍是它；owner 群的 `chat_member` 行仍在；`project_member.removed` 事件数不变 | `PASS owner.blocked {"code":"conflict","projectMember":"retained","groupOwner":"agp_…","chatMemberRows":1}` |
| 2. 有活跃 run 时按选定策略收敛 | 队首 run `queued` → 移除 `conflict`；run 仍 `queued`；输入仍 `pending`；`project_member` 与普通群成员行都在；诊断事件不增 | `PASS active-run.blocked {"code":"conflict","runStatus":"queued","disposition":"pending","chatMemberRows":1}` |
| 3. 无在途时移除成功、群行消失、DM 行保留、pending 输入转 cancelled/membership_revoked | 普通群 `chat_member` 行 2→0（按 `chat.kind='group'` 与 `chat_id` 各核一遍）；DM 行仍 1；pending→`cancelled` + `membership_revoked` + `cancelledAt`；同一 Agent 的 `delivered` 输入保持 `delivered` 且 `cancel_reason=null`（d11）；诊断事件 +1 | `PASS cleanup.applied {"code":"ok","groupMemberRows":0,"dmMemberRow":1,"pendingInput":{"disposition":"cancelled","reason":"membership_revoked"},"deliveredInput":{"disposition":"delivered","reason":null}}` |
| 3b.（补充）从未建过 instance 的成员 | 只在普通群里有成员行、没有任何 instance 的 Agent 也能被移除，行照样删 | `PASS cleanup.without-instance {"groupMemberRows":0,"instanceRows":0}` |
| 4. 重复移除幂等 | 第二次 → `ok`；`project_member`/`chat_member`/`agent_run`/`agent_run_input`/`diagnostic_event` 五张表快照逐字节不变；拼错的 profile id 仍 `not_found` | `PASS idempotent.repeat {"code":"ok","rowsUnchanged":true,"unknownProfile":"not_found"}` |
| 5. 历史可读、以它身份发言被拒 | 群 / DM / 频道三处历史消息仍读到；`getChat`、`getInstance`、`listAgentRuns`、`listAgentRunInputs`（含取消事实）可读；`ensureInstance` → `not_found`；三个对话里以它身份 `sendMessage` 全部 `not_found`，消息表里它的消息仍是 3 条（被拒的发言不落行） | `PASS history.readable.speech.denied {"messages":3,"runs":2,"cancelledInput":"readable","denied":["not_found","not_found","not_found"]}` |
| 6. 频道成员同步消失（端到端） | 频道成员集合精确等于「Project 创建者 + 当前 `project_member`」；移除前它在集合里、移除后不在；频道里的 instance 行物理保留；频道 `chat_member` 行始终为 0 | `PASS channel.membership.synced {"before":5,"after":3,"human":"human:usr_removal_creator"}` |
| 7.（补充）越权面 | 非创建者对同一 Project 调移除 → `not_found`，且成员行不动 | `PASS isolation.stranger {"code":"not_found"}` |

## 4. 验证（区分执行与通过）

全部在本 worktree 执行，绑定当前 diff（除 `git status` 里列出的 5 个文件外无改动）。

| 命令 | 结果 |
| --- | --- |
| `pnpm exec tsc --noEmit` | 通过，0 error |
| `pnpm exec vp check` | 通过，0 error / 2 warning。两条 warning 都在本次未触碰的文件里（`src/worker/executions.ts:412` `unicorn(no-useless-spread)`、`src/domain/mcp/exchange.ts:283` `typescript(no-redundant-type-constituents)`），是既有 warning，不是本单元引入 |
| `pnpm exec vp test run` | 通过：64 test files / 479 tests（含上面 §6(b) 改过的断言） |
| `bash scripts/verify/{i-chat,o-turn-semantics,i2-group-chat,i3-public-channel,i4-agent-fanout,i5-project-removal,c-data-auth,k2-cross-family-isolation,j-info-hub,d-runtime}.sh` | 10/10 exit=0。明细：`i-chat` 全 PASS；`o-turn-semantics` 全 PASS；`i2-group-chat` 13 checks；`i3-public-channel` 6 checks；`i4-agent-fanout` 含 `d19.dm-agent-membership` 与 `host.multi-run-pickup` 全 PASS；`i5-project-removal` 8 checks；`c-data-auth all checks passed`；`k2 runner checks=45 failed=0`；`j-info-hub` 全 PASS；`d-runtime all checks passed` |

既有门禁没有放宽任何断言；唯一改动的断言是 §6(b) 的契约改写，`i2` 里「活跃 run 时移除被拒」
那条与 `i4` 里 d19 那条都是原样复跑，没有动。

复跑说明：`vp test run` 在最后一次 `chat.ts` 修正（去掉无 instance 时的提前返回）之后又跑了一遍，
以当前 diff 为准；`tsc` / `vp check` / 10 条门禁都是修正之后跑的。

## 5. 未验证项

- **真实 Worker 时序**：本单元选「拒绝」，因此不存在「移除后还有在途 run」的态，没有构造真实
  host 拾起与移除并发的竞态（拒绝路径只依赖一次事务内的读，`agent_run` 的 `queued` 行已经是
  执行侧的权威）。P4c 的执行取消路径未触碰。
- **UI 提示**：members 页面在两个阻断分支上拿到的是 `conflict` + 具体文案，没有在浏览器里看真实
  toast（`src/routes/**` 属 ui 单元）。见 §6(c)。
- **`getChatInfo` 的频道视角**：属 `p5a-info`，本单元没跑它的读模型用例。
- **`listHolderExecutions`**（brief 提到的读路径之一）：它是 machine/lease 维度的执行查询，不读
  Project 成员或 chat 成员，项目移除不影响它的可见性，所以没有写断言——不是遗漏，是与本单元无
  交集。真正与移除相关的读路径（`getChat` / `listMessages` / `listAgentRuns` /
  `listAgentRunInputs` / `getInstance`）都验了。

## 6. 需要主控裁决的分歧

**(a) 项目级移除不推进 `governance_revision`。** 它会物理删掉普通群的 `chat_member` 行，但没推进
该群的 `governanceRevision`：d15 的 CAS 只覆盖三个显式治理命令，而调用方（项目成员页）手里没有
群版本号，也没有「顺手把 N 个群都 +1」的合法入口。后果是一个已经打开的群页面带着旧 revision
继续做加/移成员不会 `conflict`（它的成员集已经被项目移除改过）。可选解：移除时对受影响的群做一次
无 CAS 的 `governanceRevision + 1`，代价是别人的正常治理操作会偶发 `conflict`，且版本推进不再
只由显式命令驱动。我选了「不推进」（副作用最小、不新增治理入口），如果编排要求版本覆盖全部治理
事实，请指定，改动量小（`revokeProjectAgentEnrollment` 里多一条 UPDATE）。

**(b) 重复移除从 `not_found` 改成 `ok` 是一处契约改写，我改了既有断言。** brief 第 2 条要求「对
已经不在项目的 Agent 重复调用不报错」，与 `tests/project-agents.test.ts:185` 原来的
`removeSecond → not_found` 直接冲突。我按 brief 改语义并同步改断言（不是放宽：把
`{ok:false,not_found}` 换成 `{ok:true,ok}`）。为了不把「拼错的 id」也吞掉，`removeProjectMember`
仍然先 `getAgentProfile`，所以 `tests/error-mapping.test.ts` 的
`agent-remove-member-missing`（真正不存在的 profile）保持 `not_found`，两条用例的区分度还在。
如果编排希望保留「重复移除报错」，那是反过来改 brief，需要同时改 d20 的记录。

**(c) owner / 活跃 run 阻断的错误类与码。** 两个阻断抛的是 `ChatError("conflict", …)`
（与 `removeGroupMember` 同一码、同一文案风格），`src/server/functions/domain-errors.ts` 按
`code` 映射，所以对外仍是 `conflict`，没有新增错误码。owner 文案带群名：
`该 Agent 仍是群组「X」的所有者，请先变更所有者`；活跃 run 文案：
`该 Agent 仍有活跃运行，不能移出 Project`。需要 ui 单元确认这两句在 members 页面的 toast 里
不会被当成「并发冲突，请刷新重试」的通用文案——如果是，文案映射应由 ui 单元统一处理，我这边
不加旁路错误码。

## 7. 集成注意

- **新增一处 import 环**：`src/domain/agent.ts` 现在 import `./chat`，而 `chat.ts` 早就 import
  `./agent` 的 `getAgentProfile`。仓库里已有同类环（`chat.ts ↔ channel.ts`、
  `chat.ts ↔ chat-capabilities.ts`），两处都只在函数体里取值，不在模块初始化期读，因此运行期
  安全；`tsc`、479 条用例与 10 条门禁都是绿的。若编排不接受新增环，另一个选择是把
  `revokeProjectAgentEnrollment` 里的查询在 `agent.ts` 重写一遍——那正是 d19 反对的「同一个判据
  留在两个地方」，我不建议。
- **与 `p5a-info` 的接触面：零**。`src/contracts/**` 与 `src/server/functions/chat.ts` 未改，
  合并时不需要协调。
- 提交在 `p5a/removal` 上，未推送、未合 `main`、未开 PR。
