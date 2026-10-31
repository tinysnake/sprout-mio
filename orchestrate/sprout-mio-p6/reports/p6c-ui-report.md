# P6c UI 交付报告

分支：`p6c/ui`。基线：`integration/p6c` 的 `cbfc24e5e54e09554b2ab6f1cc8316ba87f1f5a6`。验证日期：2026-10-31。

页面与新浏览器门禁已交付。最终新门禁连续两次 exit 0，各 16 条浏览器断言。验收仍有一项未满足：既有 `as-p5a-chat-ui.sh` exit 1，唯一失败断言要求公共频道没有任何治理按钮，与本次必须交付的频道负责人入口冲突。未修改、删除或放宽任何既有断言，不能把本报告理解为全部旧门禁通过或可以合并。

## 交付清单

- `src/components/project/project-members.tsx`、`src/components/project/member-removal-blockers.tsx`：移除错误从服务端 `project_member_removal_blocked.details` 直接读取，按服务端顺序显示全部四类阻塞；页面不额外查询、推断或截断阻塞。每条显示对象事实、链接和可执行下一步。
  - active_runs：run ID、queued/running、instance ID、Chat 链接，提示先在对应 Chat 停掉运行。
  - leases：Machine 名称及 ID、generation、state、holderInstanceId、pendingMutationId、`relation=holder/handoff_target`，链接到带 Project 上下文的 Machine 租约页；handoff_target 提示先处理待决交接。
  - owner_duties：Group/Public Channel 的标题、kind、ID、Chat 链接，提示先变更负责人。
  - dm_assigned_tasks：Task 标题、ID、assigned 状态、Task 与 DM 链接，提示改派、完成或取消。
- `src/components/chat/chat-governance.ts`、`src/components/chat/chat-details.tsx`：Public Channel 按服务端 `canChangeOwner` 显示「变更负责人」，候选只取 `projectCreatedBy` 对应的 Human 成员。Group 保留全部既有成员候选；DM 继续不渲染 owner 治理段。成功后通过既有刷新显示服务端负责人事实，没有本地伪造 run 或租约状态。
- Group 退出、DM 归档、重新加入恢复沿用既有领域与页面状态、文案。新浏览器流程验证这些事实；未新增状态文案。
- `scripts/verify/p6c-member-governance-ui.sh` 与 `tests/fixtures/p6c-member-governance.ts`：真实注册会话、生产 HTTP 服务、真实 SQLite、Playwright 浏览器、独立数据库与截图。日志逐项输出可读断言，没有阶段叙述注释。
- `scripts/verify/lib/suite-plan.mjs` 与 `targets-plan.mjs`：登记新 gate 的 server 准备、browser 配额及 CI browser 分组，避免新增脚本破坏 gate 库存校验。
- 未改领域、契约、迁移及任何既有门禁期望；未改路由，`src/routeTree.gen.ts` 未变化，无需重生成。

组件提交：`e1c82f6 feat(p6c): show removal blockers and channel owner controls`。

门禁提交：`59c9cdb test(p6c): verify member governance in the browser`。

## 验证命令与实际结果

下表均已实际执行。脚本耗时由外层 Node runner 在子进程启动与退出之间计时，包含脚本自己的 prepare、服务启动、浏览器执行与清理，不是 nohup 启动时间或工具等待时间。每个脚本设置 300 秒总超时；没有触发超时或跳过脚本。表中最后两次新门禁为连续调用，期间无代码改动。

| 实际命令                                                           | 结果                                                                  |   脚本耗时 | 断言 / checks                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------: | ---------------------------------------------- |
| `pnpm typecheck`                                                   | exit 0，主程序、worker、extension 三个 tsc 均通过                     | 未单独计时 | —                                              |
| `pnpm exec vp lint <改动文件>`                                     | exit 0                                                                | 未单独计时 | —                                              |
| `pnpm exec vp fmt --check <改动文件>`                              | exit 0，7 个支持的代码文件格式通过；shell 文件不在 formatter 支持范围 | 未单独计时 | —                                              |
| `bash -n scripts/verify/p6c-member-governance-ui.sh`               | exit 0                                                                | 未单独计时 | shell 语法检查                                 |
| `bash scripts/verify/p6c-member-governance-ui.sh`，最终连续第 1 次 | exit 0                                                                |     7.615s | 16 条浏览器断言，加生产产物、服务、SQLite 检查 |
| 同一命令，最终连续第 2 次                                          | exit 0                                                                |     7.377s | 同上，16 条浏览器断言                          |
| `bash scripts/verify/p6c-member-removal.sh`                        | exit 0                                                                |     0.866s | 63 assertions                                  |
| `bash scripts/verify/p6c-participation-revocation.sh`              | exit 0；脚本另有一条基线 BLOCKED，见下文                              |     0.445s | 48 assertions                                  |
| `bash scripts/verify/i5-project-removal.sh`                        | exit 0                                                                |     0.419s | 9 checks                                       |
| `bash scripts/verify/as-p5a-chat-ui.sh`                            | exit 1                                                                |    12.192s | 29/30 浏览器 checks 通过                       |
| `bash scripts/verify/as-p5b-task-pages.sh`                         | exit 0                                                                |    14.195s | 19 checks                                      |

lint 与 fmt 的完整文件参数相同：

`src/components/chat/chat-details.tsx src/components/chat/chat-governance.ts src/components/project/project-members.tsx src/components/project/member-removal-blockers.tsx tests/fixtures/p6c-member-governance.ts scripts/verify/lib/suite-plan.mjs scripts/verify/lib/targets-plan.mjs scripts/verify/p6c-member-governance-ui.sh`。

新增登记的库存验证实际命令：

`node --input-type=module -e 'import { validateGateTargets } from "./scripts/verify/lib/targets-plan.mjs"; const result = validateGateTargets(process.cwd()); console.log("PASS gate target inventory", result.ci.length, "CI", result.local.length, "local");'`

结果 exit 0，输出 `PASS gate target inventory 64 CI 21 local`。

依赖安装实际执行 `pnpm install --frozen-lockfile`，exit 0，pnpm 报告 2.3s；未修改 lockfile。早期自检曾因 owner 段内冗余 DM 比较触发 TS2367，已修正并复验 typecheck/lint。早期首次浏览器试跑有 8 条通过后因 fixture 误以为 Info Hub 显示注册姓名而等待超时；页面实际显示既有 `Human` 名称。fixture 改为核对页面从 Agent 变为 Human，并直接核对数据库中的 Human 创建者 ID；后续试跑通过，最终两次通过见表。没有以修改产品行为来迎合这个 fixture 假设。

## 浏览器覆盖与证据

| 风险 / 契约                                          | 浏览器断言                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 遗漏、重排或隐藏某类服务端阻塞                       | blockers_order；blocker_active_runs；blocker_leases（明确含 handoff_target）；blocker_owner_duties；blocker_dm_assigned_tasks |
| 用户没有处理阻塞的入口或下一步                       | blocker_object_links；四类 blocker 断言同时检查下一步文案                                                                     |
| 频道候选越权、保存成功却仍展示旧负责人、误改运行事实 | channel_owner_candidate；channel_owner_updated（页面变化 + 实际 owner ID + run/lease 行保持原值）                             |
| DM 错误出现 owner 入口或 Group 治理退化              | dm_no_owner_entry；group_owner_behavior；group_member_removal                                                                 |
| 阻塞解除后仍无法移除、既有退出/恢复事实不呈现        | project_member_removed；removed_dm_archived；rejoined_dm_restored                                                             |
| 390px 横向溢出或详情不可用                           | member_blockers_mobile；chat_mobile                                                                                           |

fixture 通过真实页面执行注册、owner 变更、Group 成员移除、Project 成员移除与重新加入。领域函数准备 Project/Agent/Chat/Task/Machine；直接写入隔离数据库仅用于构造历史频道 Agent owner、活动运行、fencing handoff 等可控阻塞，以及显式解除 run/lease fixture。它没有 mock 服务端 details、没有跳过真实 server function，也不把 fixture 清理当成真实 Worker 完成交接的验证。

最终日志与计时索引：

- `/tmp/p6c-ui-final-suite.log`、`/tmp/p6c-ui-final-results.json`。
- 两次新门禁日志：`/tmp/final-p6c-ui-final-run1.log`、`/tmp/final-p6c-ui-final-run2.log`。
- 五个回归日志：`/tmp/final-p6c-member-removal.log`、`/tmp/final-p6c-participation-revocation.log`、`/tmp/final-i5-project-removal.log`、`/tmp/final-as-p5a-chat-ui.log`、`/tmp/final-as-p5b-task-pages.log`。
- 最新浏览器证据根目录：`/Users/snake/.herdr/worktrees/sprout-mio/p6c-ui/.verify/p6c-member-governance-ui/evidence/`，含 `results.json`（count=16）、`blockers-390.png`、`channel-owner.png`、`chat-390.png`。两次新门禁共享 gate 证据路径，截图为最终第 2 次，两个 stdout 日志独立保留。

## 未交付、已知限制与既有缺陷

1. **未满足「所有既有门禁仍 exit 0」**。`scripts/browser/as-p5a-chat-ui.mjs` 的 `channel_membership_readonly_copy` 把成员只读文案与 `[data-governance-action]` 数量必须为 0 合在一起。实际只读文案仍然正确，唯一新增治理按钮是本任务要求的 owner_change；最终日志显示「治理按钮 1」，其余 29 项通过。此旧断言的“所有治理都不存在”前提已过时；建议协调者在单独获准后把它收窄为成员治理按钮不存在，同时保留 owner 行为的独立验证。本分支没有改该断言。
2. `p6c-participation-revocation.sh` 虽然 exit 0 且 48 断言通过，仍输出基线已有的 `BLOCKED revoke.async-wake.stale-candidate: P6a scheduler materialization entry is absent from this baseline; integration must run the barrier scenario`。这条异步唤醒 barrier 场景没有执行成功，不列为覆盖；本任务不补领域调度入口。
3. 观察到公共频道详情的既有标题 fallback 会把空标题说明为「未命名，显示为 Helper Agent」，而消息头仍正确显示公共频道标题；来源是 owner 段通用 `agentName` fallback。已有 Human 成员名称在 Info Hub 中显示通用 `Human`。这些不是本次变更引入，未扩大本任务范围修复。
4. 未启动 Human review，截图为代理技术验证，不代表 Human 体验确认。未运行全量 `pnpm verify`；本报告仅证明表中实际范围。没有额外新增与实现镜像的单元测试；新增覆盖位于真实 UI/HTTP/SQLite 边界。
5. 报告同时写入指定主工作区 `/Users/snake/workspace/sprout-mio/orchestrate/sprout-mio-p6/reports/p6c-ui-report.md` 和本分支同路径副本。提交按组件、门禁、报告分块；未 push、未合并。
