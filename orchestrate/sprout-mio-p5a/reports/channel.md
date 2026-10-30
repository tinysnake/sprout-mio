# I-P5a Public Channel（Project 范围公共对话）—— 交付报告

分支 `p5a/channel`，基线 `p5a/groups` 头 `bc6856b`。工作目录
`/Users/snake/.herdr/worktrees/sprout-mio/p5a-channel`。不推送、不合 main、不开 PR。

本单元只做「频道取得/创建 + 成员读取改读视图 + DTO/契约 + 项目创建接线 + 门禁」。
`sendMessage` 的多 Agent 扇出、`agent-run`、`pi-host`、`drizzle/**`、`components/**`、`routes/**` 未改；
**没有新增迁移**：`kind` 枚举、`chat_public_channel_project_unique`、`0022` 回填、`chat_effective_member`
视图与 `chat_member_no_channel_insert` 触发器都是 groups 单元之前就冻结的形状，本单元只按它接线。

---

## 1. 实现清单

| 文件:行 | 内容 |
| --- | --- |
| `src/domain/channel.ts:34` | `ensureProjectChannel(projectId)`：先读、读不到就插、插入被并发者抢先时再读，返回频道 id。`title` 留空，`owner_kind='human'`，`owner_id` 与 `created_by` 同取 `project.created_by`，`wake_policy` 用 §4.1 冻结值 `owner_led`，`governance_revision=0`。幂等只靠 `chat_public_channel_project_unique`（`ON CONFLICT DO NOTHING` + 回读），不建后台任务、不在读路径补写。 |
| `src/domain/channel.ts:80` | `readChatEffectiveMembers(chatId, projectId)`：**唯一**有效成员读入口，直接读 `chat_effective_member`（裁定 d7）。视图无 rowid，排序取 `added_at` → 人类优先 → `member_id`，保证同一秒加入的成员次序稳定（DM 的 `[human, agent]` 次序不变）。 |
| `src/domain/channel.ts:106` | `assertChannelMemberChangeAllowed(target)`：频道成员不可直接调整的领域拒绝入口，抛 `channel_membership_managed`，文案由 `CHANNEL_MEMBERSHIP_MANAGED_MESSAGE`（`:12`）唯一持有，明确指向「跟随 Project 成员自动同步」。 |
| `src/domain/chat.ts:96` | `assertGovernableGroup` 改为调用上面的拒绝入口：`addGroupMember` / `removeGroupMember` / `setChatOwner` 三个命令在写库前统一经过它。 |
| `src/domain/chat.ts:381` | `listChatMembers` 改读视图（不再读 `chat_member`）。项目级移除后 Agent 立即从成员列表消失，历史消息/instance/run 不受影响。 |
| `src/domain/chat.ts:417` | `sendMessage` 的发送者资格也从视图判定（`:428`）。频道的参与权只存在于视图里，读成员表会让频道永远发不出消息；同一改动也把「项目移除后仍可发言」收紧。扇出逻辑（`appendHumanRunInput` 等）未动。 |
| `src/contracts/chat.ts:124` | `PUBLIC_CHANNEL_DISPLAY_TITLE = "公共频道（Project 范围）"`（d8：频道没有 title 字段，文案是唯一来源，p5a-ui 直接消费）。`:126-136` 在 `chatSchema` 上写明频道 DTO 的 `title` 缺席、`createdBy=project.created_by`、`owner=human/project.created_by`、`wakePolicy` 与频道唤醒语义。 |
| `src/domain/project.ts:68` | `createProject` 同一事务里建频道（项目行 → hook → 频道 → `project.created` 诊断）。 |
| `src/domain/bootstrap.ts:74` | 注册时播种的默认 Project 走同一条路径（同样在注册事务内）。 |
| `scripts/verify/i3-public-channel.sh` | 新门禁：真实 SQLite + 真实域入口，跑 `tests/fixtures/public-channel.ts`。 |
| `tests/fixtures/public-channel.ts:138,186,248,311,355,397` | 六条场景的实现与断言。 |

`ChatError` 仍定义在 `domain/chat.ts`，`channel.ts` 反向 import 它 —— 与既有
`chat-capabilities.ts ↔ chat.ts` 的引用形状一致（两者都只在函数体内使用该类，模块求值期不取值），
所以没有为它新开文件。

## 2. 频道 wake 语义：选择与理由

**选择**：频道的 `wake_policy` 保留 §4.1 冻结值 `owner_led`（`0022` 回填的既有频道也是它），
DTO 不做投影改写；频道里的有效唤醒 = **只唤醒被点名的 Agent**，一条消息绝不广播给全体成员。

理由（按冻结规则链逐条推）：

1. `routeWakeCandidates` 的点名规则是优先级 1，对所有 kind 一致；频道成员集是「全部 Project Agent」，
   若按成员广播，一条人类消息会拉起 N 条串行 run —— 枚举里也没有「全员」这个值
   （`mention_only` / `owner_led` / `contextual` 三个值都没这个语义）。
2. `owner_led` 的「所有者优先」规则要求 `owner_kind='agent'`；频道 owner 恒为人类
   （`project.created_by`），这条规则在频道里永远不产生候选。`contextual` 在 P5a 回退成
   `owner_led`，同上。
3. 结论：在现有规则链下，`owner_led` 与 `mention_only` 对频道产生**完全相同**的路由结果，
   所以保留 DB 里的冻结值不改变行为，也不需要第二份真值。

因此「人把消息发进公共频道」这个动作本身不会拉起任何 Agent；只有点名（或被 Task 周期唤醒，
P6）才会。写进 `ensureProjectChannel` 的注释与 `chatSchema` 的注释里。

**需要主控裁决**：如果本单元意图是「人类消息即使在频道里点名也不扇出（频道对人是只读广播）」，
那不是改 `wake_policy` 字面值能得到的，需要在 `p5a-fanout` 的 `routeWakeCandidates` 上按 kind 分支。
本单元没有跨这条边界，见 §7(a)。

## 3. 六条门禁场景证据

`bash scripts/verify/i3-public-channel.sh`（真实 SQLite 文件 + 真实领域入口，不 mock）：

```
PASS channel.created-unique {"channelId":"cnv_9a1e…","kind":"public_channel","owner":{"kind":"human","id":"usr_channel_creator_a"},"displayTitle":"公共频道（Project 范围）","chatMemberRows":0}
PASS channel.members-follow-project {"members":3,"sources":["project_member","project_member"],"chatMemberRows":0}
PASS channel.member-removed-history-kept {"members":2,"messages":1,"runRetained":true,"participation":"not_found"}
PASS channel.membership-managed {"add":"channel_membership_managed","remove":"channel_membership_managed","message":"公共频道成员跟随 Project 成员自动同步，不可在频道内单独调整","trigger":"public_channel_members_derived","revision":0}
PASS channel.cross-project-isolation {"channelA":"cnv_d3c3…","channelB":"cnv_4da4…","crossRead":"not_found"}
PASS channel.send-parity-with-dm {"memberDm":"ok","memberChannel":"ok","nonMemberDm":"not_found","nonMemberChannel":"not_found"}
PASS i3-public-channel 6 checks
```

逐条对应的断言：

1. **新建 Project 后频道存在且唯一**：`createProject` 后 `kind='public_channel'` 恰 1 条；
   `ensureProjectChannel` 重复调用返回同一 id；绕过域层直插第二条被
   `UNIQUE constraint failed`（`chat_public_channel_project_unique`）拒绝；且频道没有任何
   `chat_member` 行。DTO 逐字段断言：`kind/title(undefined)/owner(human)/createdBy/wakePolicy/governanceRevision`。
2. **项目加成员 → 频道成员同读可见**：`addProjectMember` 后 `listChatMembers` 立即含两名 Agent；
   视图 `source` 全是 `project_member`；`chat_member` 仍 0 行（派生事实没有第二份存储）。
3. **项目级移除 → 频道成员同步消失、历史仍可读**：`removeProjectMember` 后成员集只剩
   `[agent:agentB, human:creatorA]`；移除前 Agent 发出的消息仍在 `listMessages`；`agent_instance`
   行物理保留；`listAgentRuns` 仍返回该 run；`ensureInstance` 与再发言都 `not_found`。
4. **直接增删被拒且错误码正确**：`addGroupMember` / `removeGroupMember` 都返回
   `channel_membership_managed`，消息等于 `CHANNEL_MEMBERSHIP_MANAGED_MESSAGE` 且含 `Project`；
   `governance_revision` 与成员集零变动；直插 `chat_member` 被触发器
   `public_channel_members_derived` 拒绝。
5. **两个 Project 的频道互不可见**：A 读 B 的频道 = `getChat`/`listChatMembers`/`listChats` 全
   `not_found`；B 的频道成员只有 B 的创建者，看不到 A 的 Agent；B 的会话列表只有自己的频道。
6. **频道发言权限与 DM 一致**：当前成员 Agent 在 DM 与频道都 `ok`；同一个非成员 Agent 在两处
   都是同一个 `not_found`；人类在频道里可发言。（两条路径都要求先有 instance：DM 创建时就有了，
   频道靠 `ensureInstance` 建 —— 资格判定同一个视图。）

## 4. 既有门禁与用例的适配（没有放宽断言）

频道随 Project 饥渴创建，会改变「一个 Project 的对话条数」这一事实，以下断言按新事实收紧或换判据：

| 文件 | 改动与理由 |
| --- | --- |
| `tests/fixtures/group-chat.ts` | 原来手插一条频道行（现在会撞唯一索引），改为 `ensureProjectChannel(projectRow.id)` 并断言恰 1 条；"被拒的建群不留 chat 行" 收紧为 `kind='group'` 行数为 0（Project 自带频道不算）。 |
| `tests/chat.test.ts:171` | 「失败建 DM 不留 chat 行」显式限定 `kind='dm'`，断言更强（频道不算噪声）。 |
| `tests/identity-data.test.ts` | DM 幂等场景的 `count('chat')` 换成分 kind 计数（`dm=1`、`public_channel=2`，两个 Project 各一）；`listChats(...)` 比较改为 `kind==='dm'` 过滤。 |
| `scripts/verify/c-data-auth.sh` | 注册后 `chat` 计数拆成 `dm=0`、`public_channel=2`（每个默认 Project 一个），regression 意图（注册不建 DM）不变。 |
| `scripts/verify/k2-cross-family-isolation.sh` | A 的会话列表断言改为「DM 恰 1 条 + 频道恰 1 条」；B Project 的 `chat` 计数同样分 kind。 |
| `scripts/browser/i-chat-flow.mjs` | 列表断言从「只有 1 条 DM」改为「恰 2 条，且最新更新的 DM 在首位」；三个检查点同步。 |
| `scripts/browser/k-acceptance-flow.mjs` | 同上；另外 `chat-item` 定位器在两条列表时触发 strict mode，补 `.first()`。 |
| `scripts/browser/ui-layout-flow.mjs` | 零 Project 夹具删除 Project 前先删它的频道行（否则 `chat.project_id` 外键挡住 teardown），并把「自建 Project 后空列表」改为先删掉新 Project 的频道行再 reload —— 空列表布局这条检查本身保留。 |
| `scripts/browser/p4b-chat-title-flow.mjs` | 未改：它的两处 `chat-item` 断言是「按标题/按 id 搜索后恰 1 条」，频道不匹配搜索词，仍然 1 条。 |

`scripts/browser/ui-scenarios.mjs` 是历史证据脚本（只被 `docs/ui/evidence` 引用，不接任何门禁），
断言的是一个 2 条对话的固定夹具，未改，也未运行。

## 5. 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm exec tsc --noEmit` | 通过（无输出） |
| `pnpm exec vp check` | `All 442 files are correctly formatted`；`Found 0 errors and 2 warnings in 372 files` —— 2 个 warning 是 base 上既有的（`src/domain/mcp/exchange.ts:283`、`src/worker/executions.ts:412`），在 `p5a-groups` 同命令下同样是 0 error / 2 warning |
| `pnpm exec vp test run` | `Test Files 64 passed (64)` / `Tests 477 passed (477)` |
| `bash scripts/verify/i-chat.sh` | 14 PASS，0 FAIL（含 p4b 标题流程） |
| `bash scripts/verify/o-turn-semantics.sh` | 17 PASS，0 FAIL |
| `bash scripts/verify/i2-group-chat.sh` | `PASS i2-group-chat 13 checks` |
| `bash scripts/verify/c-data-auth.sh` | `PASS c-data-auth all checks passed`（26 PASS） |
| `bash scripts/verify/k2-cross-family-isolation.sh` | `k2 runner checks=45 failed=0` |
| `bash scripts/verify/j-info-hub.sh` | 7 PASS（含真实 Chromium 流程），0 FAIL |
| `bash scripts/verify/i3-public-channel.sh` | `PASS i3-public-channel 6 checks` |
| `SPROUT_PI_ENABLED=false bash scripts/verify/k-acceptance.sh`（我改了它的断言） | `acceptance runner checks=8 failed=0` |
| `bash scripts/verify/r-ui-layout.sh`（我改了它的夹具） | `PASS UI layout, navigation and production dev boundary` |

两次需要说明的执行事实：

- 第一次 `c-data-auth` 失败在首个 signup（`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`），原因是
  `.verify/c-data-auth` 里留着上一轮跑该门禁的数据库与 cookie jar；`rm -rf .verify/c-data-auth`
  后重跑全绿。与代码无关。
- 全量 `vp test run` 有一次出现 `execution-accept-fixes-2` 与 `verify-preparation` 两例失败
  （都是起真实子进程/计时的用例），单跑这两个文件 13 passed，随后全量重跑 477 passed。
  按「先看原任务是否仍在运行/是否是资源竞争」的规则判为并发下的偶发，不是本次改动引入。

## 6. 未验证项

- **页面呈现**：本单元没有碰 `src/components/**`、`src/routes/**`。频道现在会出现在会话列表里，
  但在 p5a-ui 之前它按 DM 的兜底渲染成 `Agent / DM`，且「空对话列表」状态在真实数据里不再可达。
  我把浏览器门禁改成「DM + 频道两条」，并为空列表布局检查保留了删频道行的夹具构造；真正的
  分组渲染、`PUBLIC_CHANNEL_DISPLAY_TITLE`、成员只读入口都属 p5a-ui。
- **频道里的真实多 Agent 对话**（人发消息后按点名唤醒、串行 run、回报消息归属）需要 fanout +
  真实 Worker，归 `p5a-fanout` / 集成线。本单元只证明领域层的参与权与发言资格。
- **`getChatInfo` 的频道视角**（`kind='public_channel'`、成员与 Project 成员相等、`instances` 为空）
  没有单独建用例，归 `p5a-info`；它经由 `listChatMembers` 已经自动改读视图。
- `scripts/browser/ui-scenarios.mjs` 未运行（历史脚本，不接门禁）。

## 7. 需要主控裁决的分歧

**(a) 频道 wake 语义的字面含义。** 我实现的是「频道只唤醒被点名的 Agent，owner（人类）不产生候选，
绝不广播」，并保留 DB 的冻结值 `owner_led`（理由见 §2）。若计划里的原意是「人类消息在频道里
即使点名也不扇出」，那需要 `p5a-fanout` 在 `routeWakeCandidates` 上加 kind 分支，请指定由谁做。

**(b) `sendMessage` 的发送者判据换成了视图（超出「只改 listChatMembers」几个字）。** 不改这里，
门禁第 5 条（Agent 在频道发言）无法成立，且 §8.4「移除后不得继续发言」也没有落点。副作用是一处
不对称：视图的 DM 分支不检查 `project_member`，所以 Agent 被移出 Project 后仍能在旧 DM 里发言，
直到 §4.4 的 DM 归档落地。要不要在本阶段补 DM 归档，或在 fanout 里加 DM 的 Project 参与权检查，
需要裁决。

**(c) §4.4 的项目级移除处置仍未实现。** `removeProjectMember`（`src/domain/agent.ts:134`）只删
`project_member` 行：不检查「该 Agent 是 Owner / 有活跃 run」，不物理删除普通 Group 的
`chat_member` 行，也不把它的 `pending` 输入标成 `cancelled/membership_revoked`。视图已经收回了
参与权（越权发言与 instance 获取都 `not_found`），所以不是安全漏洞，但设计 §4.4 的三步只完成了
参与权那一半。本单元边界只要求「频道成员同步消失、历史可读」，所以没有越界实现；建议指定
`p5a-groups-fix` 或 `p5a-fanout` 补上。

**(d) `ensureProjectChannel` 的返回类型。** 返回频道 id（`string`）而不是 Chat DTO：DTO 映射器
`toChat` 是 `chat.ts` 的私有函数，为它导出或复制一份都不划算，调用方拿到 id 后用
`getChat(id, ctx)` 取 DTO（门禁就是这么做的）。如果编排要求返回完整 DTO，请明说，我再加一个
共享映射模块。

**(e) 空列表状态。** 频道饥渴创建后，「Project 没有任何对话」在真实数据里不可达；
`r-ui-layout` 的空列表检查现在靠删频道行构造。若 p5a-ui 决定把「只有频道」当成新的空态，
那条检查应随 UI 单元一起改写，而不是继续删行。
