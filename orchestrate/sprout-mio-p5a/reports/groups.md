# I-P5a Group、成员与 owner 治理 —— 交付报告

分支 `p5a/groups`，基线 `integration/p5a` 的 `82a8c2f`（contracts 单元已合入），实现提交 **`30824f8`**，本报告与其后的文档提交在同一条分支上。
工作目录 `/Users/snake/.herdr/worktrees/sprout-mio/p5a-groups`。不推送、不合 main、不开 PR。

本单元只做「Group 的建群 / 加成员 / 移出成员 / 换 owner 四类治理命令 + 契约收紧 + ensureInstance + 服务端接线 + 门禁」。
`sendMessage` 的扇出、Public Channel 的成员同步、页面组件与路由均未触碰（分别归 `p5a-fanout`、`p5a-channel`、`p5a-ui`）。

---

## 1. 实现清单（file:line）

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| owner 档能力判定（唯一入口） | `src/domain/chat-capabilities.ts:39` `ChatOwnerFacts`、`:54` `assertChatCapability` | 判定吃「对话所有者 + `project.created_by`」这一份事实，调用方不再自己比 owner；Agent 在治理动作上仍是 `never` |
| 治理事实一次查齐 | `src/domain/chat.ts:76` `ownerFacts` | 领域层统一取 `project.created_by` 交给能力判定 |
| 只有 Group 可治理 | `src/domain/chat.ts:94` `assertGovernableGroup` | `public_channel` → `channel_membership_managed`；`dm` → `forbidden` |
| 乐观并发写点 | `src/domain/chat.ts:104` `applyGovernance` | `UPDATE … WHERE id=? AND project_id=? AND governance_revision=?`，0 行即 `conflict`，版本 +1 |
| 成员前置校验 | `src/domain/chat.ts:126` `requireProjectAgent`、`:139` `requireUser` | Agent 必须属本 Project；Human 必须真实存在 |
| 活跃 run / pending 输入 | `src/domain/chat.ts:145` `instanceIdsOf`、`:155` `activeRunOf`、`:174` `cancelPendingRunInputs` | d10 的两条处置 |
| `ensureInstance` 单一入口 | `src/domain/chat.ts:497` | 参与权只读 `chat_effective_member`；`onConflictDoNothing` 依托 `agent_instance_profile_chat_unique` |
| 建群 | `src/domain/chat.ts:546` `createGroupChat` | 事务 + `writeIdentity`，初始 `governance_revision = 0`，成员行一次写入 |
| 加成员 | `src/domain/chat.ts:605` `addGroupMember` | 幂等重复不推进版本；版本过期仍 `conflict` |
| 移出成员 | `src/domain/chat.ts:654` `removeGroupMember` | 活跃 run 拒绝优先；无活跃 run 时取消 pending 输入再删行 |
| 换 owner | `src/domain/chat.ts:715` `setChatOwner` | CAS + 合法性（Agent 必须是当前有效成员；Human 必须是 `project.created_by`） |
| 成员条目契约 | `src/contracts/chat.ts:53` `chatMemberInput` | `kind` 判别联合：Agent 走既有 `agentProfileIdSchema`（`agp_` 模式），Human 只收非空认证标识 |
| 治理所有者契约 | `src/contracts/chat.ts:60` `chatOwnerInput` | Agent owner 额外要求 `agp_` 模式；读路径的 `chatOwnerSchema` 未改 |
| 建群入参收紧 | `src/contracts/chat.ts:71` `createGroupChatInput` | `agentProfileIds: string[]` → `members: {kind,id}[]`；去重、至少一名人类、Agent owner 必须是成员 |
| 治理命令入参 | `src/contracts/chat.ts:102/109/116` | `addGroupMemberInput` / `removeGroupMemberInput` / `setChatOwnerInput`，都带 `expectedRevision` |
| 服务端边界 | `src/server/functions/chat.ts:267/282/302/322` | `createGroupChatBoundary` / `addGroupMemberBoundary` / `removeGroupMemberBoundary` / `setChatOwnerBoundary`，行动者由会话构造（`humanActor`，`:262`） |
| serverFn | `src/server/functions/chat.ts:342/348/354/360` | `createGroupChatFn` / `addGroupMemberFn` / `removeGroupMemberFn` / `setChatOwnerFn` |
| d12 迁移修正 | `drizzle/0021_p5a_multichat_schema.sql:82-91` | 只留 `chat_member_no_channel_insert`，删除不可达的 `chat_member_no_channel_delete` 并写明原因 |
| 门禁 | `scripts/verify/i2-group-chat.sh` + `tests/fixtures/group-chat.ts`（13 项断言组） | 真实 SQLite + 真实领域命令，不 mock 领域层 |
| 能力判定用例 | `tests/chat-capabilities.test.ts:38` `Facts`、`:99` d6 用例、`:108` 所有者与创建者不同人 | 原「Agent owner 时没有任何 Human 通过」的断言按 d6 改写为「只有创建者通过，其他人类仍被拒」 |
| 触发器回归 | `tests/migration-rebuild.test.ts:416` | 断言频道 delete 触发器不存在（d12 从「不可测死代码」变成可测事实） |

---

## 2. 六条裁决的落点

| 裁决 | 落在哪 | 具体行为 |
| --- | --- | --- |
| **d6** owner 档 = 人类 owner，或 `owner_kind='agent'` 时由 `project.created_by` 兜底 | `src/domain/chat-capabilities.ts:54-81`；事实来源 `src/domain/chat.ts:76` | `ownerFacts()` 一次查齐所有者与项目创建者并交给判定函数，调用方不再各自判 owner。人类 owner：`ownerId === actor.userId`；Agent owner：`projectCreatedBy === actor.userId`，其他人类一律 `forbidden`。Agent 行动者在进入 owner 档之前就被 `never` 拦掉，兜底只开放给「人类、且是项目创建者」。门禁用 Agent owner 的群验证创建者能加成员、能换 owner，另一个 Human 仍是 `not_found`（Project 隔离先于能力判定） |
| **d7** 不新增 historical 状态，参与权一律由 `chat_effective_member` 判定 | `src/domain/chat.ts:497` `ensureInstance`；`src/domain/chat.ts:715` `setChatOwner` 的 Agent 合法性检查；门禁 `d10.pending-input-cancelled` 的 `instanceRetained:true` + `participation:"not_found"` | 移出成员时**不删** `agent_instance` 行（历史消息与 run 还要引用），但 `ensureInstance` 与「能否被指定为 owner」都只读视图：移出后同一入口返回 `not_found`。Group 里 Agent 成员的行被物理删除（详见第 6 节的分歧项），项目级移除沿用视图派生 |
| **d8** Public Channel 成员是派生事实，不能独立调整 | `src/domain/chat.ts:94` `assertGovernableGroup`；门禁 `d12.channel-insert-trigger-only` | 对频道调 `addGroupMember` / `removeGroupMember` 返回既有错误码 `channel_membership_managed`（`src/contracts/result.ts` 已由 contracts 单元登记，本单元**未新增任何错误码**）。频道的成员同步本身不做（`p5a-channel`） |
| **d10** 有活跃 run 时移除被拒、pending 输入取消，两者同时可发生时以拒绝为准 | `src/domain/chat.ts:654-712`（`activeRunOf` + `cancelPendingRunInputs`） | 拒绝在前：先算活跃 run，命中就抛 `conflict`，**此时不执行任何取消**（门禁断言被拒那一次 `disposition` 仍是 `pending`、run 仍是 `queued`、成员行仍在）。只有没有活跃 run 时才把该 Agent 在本对话里的 `pending` 输入改成 `cancelled` / `cancelled_at` / `cancel_reason='membership_revoked'`，然后再删成员行、推进版本 |
| **d11** cancelled 只作用于未下发的 pending，delivered 不转 cancelled | `src/domain/chat.ts:174-193` | 取消条件写死 `eq(agentRunInput.disposition, "pending")`；`delivered_at` 保持非空语义，运行中的停止仍走 P4c 的执行取消路径。门禁断言 `cancelled_at` 有值且 `delivered_at` 为 null |
| **d12** `chat_member` 只保留 insert 触发器，删掉不可测的 delete 触发器 | `drizzle/0021_p5a_multichat_schema.sql:82-91`；`tests/migration-rebuild.test.ts:416-422` | 迁移里删除 `chat_member_no_channel_delete` 并把理由写成注释（insert 已挡住向频道写成员行、`chat_kind_immutable` 钉死 kind ⇒ 不存在可删的频道成员行）。门禁 `d12.channel-insert-trigger-only` 断言 `chat_member` 的触发器集合恰好是 `chat_member_no_channel_insert` + `chat_member_identity_immutable`，并实测直接 `INSERT` 触发 `public_channel_members_derived` |

---

## 3. 门禁输出（本机真实结果）

全部在 `30824f8` 的树上执行。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | PASS（exit 0） | 无输出即无错误 |
| `pnpm exec vp check` | PASS（0 errors，2 warnings） | 2 条 warning 都在 `src/domain/mcp/exchange.ts:283`（既有 `no-redundant-type-constituents`），不在本单元文件 |
| `pnpm exec vp test run` | PASS | `Test Files 64 passed (64)`，`Tests 477 passed (477)`，`Duration 23.09s` |
| `bash scripts/verify/i-chat.sh` | PASS | DM 创建/幂等/标题/跨账号隔离全 PASS，含真实生产构建与 Chromium（`browser.log`、`browser-title.log`）、SIGTERM 重启后同一对话同一分身 |
| `bash scripts/verify/o-turn-semantics.sh` | PASS | 轮次投递与停止语义未变 |
| `bash scripts/verify/c-data-auth.sh` | PASS | 首次运行时因本单元尚未提交的 `drizzle/0021` 改动触发了 `drizzle/ 在 db:generate 之前就与 git 记录不一致`（该门禁要求迁移产物先入库再判断漂移）。提交后重跑：`db:generate` 报 `No schema changes, nothing to migrate`，`drizzle/` 前后都干净，`c-data-auth all checks passed` |
| `bash scripts/verify/k2-cross-family-isolation.sh` | PASS | 跨租户隔离未回退 |
| `bash scripts/verify/j-info-hub.sh` | PASS | Info Hub 现有视角未受治理命令影响 |
| `bash scripts/verify/i2-group-chat.sh`（本单元新增） | PASS，13 个断言组 | 见下 |

`i2-group-chat.sh` 的真实输出（节选，全部 `PASS`）：

```
PASS contract.members-tightened {"duplicate":"members","noHuman":"members","ownerNotMember":"initialOwner","badAgentId":"members","legacyShape":"rejected"}
PASS governance.agent-create-forbidden {"code":"forbidden","chatRows":0}
PASS group.created {"kind":"group","owner":{"kind":"agent","id":"agp_…"},"revision":0,"members":2}
PASS governance.agent-denied {"add":"forbidden","owner":"forbidden","remove":"forbidden","revision":0}
PASS d6.project-creator-fallback {"revision":1,"stranger":"not_found"}
PASS member.add-idempotent {"revision":1,"rows":1}
PASS governance.stale-revision {"ownerAfter":{"kind":"agent","id":"agp_…"},"revision":1}
PASS owner.change {"agentOwnerRevision":2,"humanOwnerRevision":3,"removeOwner":"conflict","foreignHumanOwner":"forbidden"}
PASS instance.ensure {"instanceId":"ins_…","outsider":"not_found"}
PASS d10.active-run-blocks-removal {"code":"conflict","disposition":"pending","runStatus":"queued"}
PASS d10.pending-input-cancelled {"disposition":"cancelled","reason":"membership_revoked","revision":4,"instanceRetained":true,"participation":"not_found"}
PASS d12.channel-insert-trigger-only {"add":"channel_membership_managed","remove":"channel_membership_managed","dm":"forbidden","triggers":["chat_member_identity_immutable","chat_member_no_channel_insert"]}
PASS isolation.group {"strangerRead":"not_found"}
PASS i2-group-chat 13 checks
```

门禁跑法与其它 fixture 门禁一致：`mktemp` 私有 SQLite + `node --import tsx tests/fixtures/group-chat.ts`，用真实 `migrateDatabase()`、真实领域命令（`createProject` / `createAgentProfile` / `addProjectMember` / `createGroupChat` / `addGroupMember` / `removeGroupMember` / `setChatOwner` / `ensureInstance` / `sendMessage`）。只有两处直接写表，都是本单元范围外的前置事实：`agent_run` + `agent_run_input`（归 fanout 的扇出产物）与一条 `public_channel` 的 `chat` 行（归 channel 的自动创建）。

---

## 4. 与冻结设计的偏差（每条都给理由）

1. **`drizzle/0021` 就地修改（d12）**。设计 §4.2 同时列了 insert 与 delete 两个触发器，`decisions.tsv` 的 d12 要求删掉 delete 那个，但 brief 又写明「本单元不需要新迁移，若你认为必须有新迁移，先在报告里停手并提出」。两条要求只能二选一：这里选择就地改 `0021`（不新增迁移号、不动 `drizzle/meta/*` 快照，`db:generate` 前后都报 no schema changes 且 `drizzle/` 干净）。见第 6 节需要主控裁决的第 1 条。
2. **`assertChatCapability` 第三参从 `{ownerKind, ownerId}` 扩成 `{ownerKind, ownerId, projectCreatedBy}`**（设计 §3.2 只写了前两个）。d6 的兜底需要 `project.created_by`，把它放进同一份「归属事实」而不是加第四个可选参数，是为了让调用方无法漏传、也无法各自判 owner。
3. **三类治理写入都带 `expectedRevision`**。设计 §4.3 只要求换 owner 做 CAS。这里让加成员 / 移出成员同样带版本：`governance_revision` 的语义是「治理事实的版本」，允许无版本写入就等于允许静默覆盖别人刚做完的治理。代价是重复加成员要用**当前**版本才幂等成功（用过期版本仍 `conflict`），门禁把这两种情形分别断言。
4. **`createGroupChatInput` 的成员形状从 `agentProfileIds: string[]` 改为 `members: {kind,id}[]`**。brief 要求「至少一个人类成员」，旧形状连人类成员都表达不了；这属于 brief 点名的过宽契约，不是设计形状变更。
5. **DM 上的治理命令返回 `forbidden` 而不是 `channel_membership_managed`**。DM 的成员集由创建时固定（`chat_dm_owner_check` + 固定两个成员），既不是「派生事实」也不可治理，用 `forbidden` 更贴近「这个对话没有可调整的成员集」。
6. **新增一条设计没写的拒绝：当前所有者不能被直接移出**（`conflict`，`src/domain/chat.ts:672`）。所有者身份由 `chat.owner_*` 独立表达，允许删掉成员行会让「所有者不是成员」成为常态，也让 d6 的兜底判断多一种要解释的状态。

---

## 5. 发现但没做的缺口

1. **`group_dissolve`、`wake_policy_change` 两个能力项没有对应命令**。`CHAT_ACTIONS` 冻结表里有，但本单元交付清单只要求建群/加成员/移出成员/换 owner。解散还需要 `agent_run_input.cancel_reason='group_dissolved'` 的处置（schema 已支持），归后续单元。
2. **`listChatMembers` 读的是 `chat_member` 而不是 `chat_effective_member`**（`src/domain/chat.ts:375`）。因此项目级移除 Agent 之后，Group 的成员接口仍会列出这个 Agent（参与权视图已经不再包含它）。本单元没改这条读路径：它同时服务 UI 和 Info Hub，改动会与 `p5a-ui` / `p5a-info` 的读取契约交叉。建议由 `p5a-channel` 或 `p5a-info` 统一改成读视图。
3. **建群不会隐式把创建者加入成员**。契约要求显式给出成员（含至少一名人类），所以 UI 必须自己把当前用户放进 `members`。若主控希望「创建者自动入群」，那是契约层的决定，未擅自加。
4. **没有「不能移出最后一名人类成员」的规则**。移走最后一个人之后群组的人类通路只剩 d6 兜底（`project.created_by`），治理不会冻结，所以没加这条限制；是否要把「至少一名人类成员」从创建约束升格为不变量，需要裁决。
5. **已经迁移到 0021/0022 的既有本地库仍留着旧的 delete 触发器**。in-place 修改只对新建库生效（drizzle 迁移器按 `created_at` 顺序推进，不会重跑已应用的迁移）。所有门禁与集成线都用一次性库，`db:generate` 与 `drizzle/` 干净；但 `data/sprout.sqlite` 这类长期开发库需要一个 `DROP TRIGGER IF EXISTS chat_member_no_channel_delete` 才彻底对齐。见第 6 节第 1 条。
6. **`ensureInstance` 没有写 `agent_instance.created` 诊断**。它会被 fanout 在 `sendMessage` 的事务里按候选逐个调用，写诊断会变成每次唤醒都刷一条事件；需要「谁第一次拿到 instance」的证据时，run 的 `agent_run.queued` 诊断已经覆盖。若评审要求，可以只在实际插入时补一条。
7. **`src/domain/agent-run.ts:appendHumanRunInput` 仍只对 DM 生效**（`current.kind !== "dm"` 直接返回），所以 Human 往 Group 发消息还不会产生任何 run/输入。这是 `p5a-fanout` 的范围，本单元按边界没动。

---

## 6. 需要主控裁决的分歧

1. **d12 的删除方式**：本单元就地改了已合入 `integration/p5a` 的 `drizzle/0021`（不加迁移号、快照不动），代价是「已迁移库保留孤儿触发器」。备选是新增 `0024_p5a_drop_channel_delete_trigger.sql` 做 `DROP TRIGGER IF EXISTS`（`0023` 归 `p5a-fanout`），对既有库也彻底。若主控要求迁移文件不可变，这个单元需要重做成新增迁移；请裁决，我按裁决改。
2. **公共频道成员删除的物理底线**：d12 删掉 delete 触发器之后，若有外部直写库存量频道成员行，数据库层没有拦截。我认为这符合 d12「不留不可达保护」的取舍（insert 触发器 + `chat_kind_immutable` 已经封死产生路径），但这一条是「用可达性换防线」的取舍，值得主控确认。
3. **Group 成员移除是否物理删 `chat_member` 行**：d7 说「Agent 移出后 instance 与 chat_member 行保留」。我把这条读成「项目级移除沿用视图派生、不清理成员行」，而 Group 上的显式移除必须删行——否则视图没有任何字段能表达「还在项目里但已被移出这个群」，d10 的移除语义也无从落地。若主控把 d7 读成「Group 移除也保留行」，那需要给视图引入新的判据，属于契约变更。
4. **治理写入是否统一要求 `expectedRevision`**（第 4 节第 3 条）。若只要 owner change 带版本，加成员 / 移出成员的入参可以去掉该字段；但那样 `governance_revision` 只覆盖一部分治理事实。

---

## 7. 未验证项

- 真实多 Agent 对话下的成员变更与在途 run（需要 fanout + 真实 Worker），本单元只在私有 SQLite 里证明领域层处置。
- Public Channel 成员与 Project 成员的同读一致性（`p5a-channel` 的反证 2）。
- 页面入口：本单元只提供服务端 serverFn，未接 UI（`src/components/**`、`src/routes/**` 未改，`vp check` 的组件边界测试仍全绿）。
