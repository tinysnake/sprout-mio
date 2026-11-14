# Crew planning decision trail

本轮目标是制定功能开发计划。产品代码、数据库、生产实例均不在本轮修改范围。

## Playbook checklist

- [x] When the change is one or two files with an obvious approach, skip the plan. Say so and stop. 本项不触发。Crew 横跨对话、执行、资源与界面。
- [ ] Settle open questions by prototype before you write. Run `playbooks/prototype.md` for each. Keep the branch, the SHA, and the screenshots for Appendix A. Ask the operator only about a product or preference call that no run can settle. Give options (the **never-block-on-the-human** principle skill). 本轮只完成临时 SQLite 行为探针，不能把真实 worker、远端恢复或未制作的 UI 原型记为已验证；限制与后续验收已写入 Appendix A 和 D0。
- [x] Explore in subagents with the `poteto-agent` worker role and an explicit model per the Subagents section (the **guard-the-context-window** principle skill). Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section. Each returns file pointers, conventions, test commands, and entry points. No inlined dumps.
- [x] Copy the skeleton below into the plan file and fill every placeholder. Unless the operator names a path, write the file under the repo's `docs/plans/`. Keep every heading and every sub-block in the order shown. One section per PR. One PR is one change with its own evidence (the **sequence-verifiable-units** principle skill). Name the execution playbook in **How to read this**. Pick `playbooks/autopilot-full.md` when the run may merge. Pick `playbooks/autopilot-stack.md` when the operator lands the PRs. A standing program takes `playbooks/orchestrate.md`.
- [x] Write under `/technical-writing` in full, then `/unslop`. The body is one Diátaxis mode, how-to. Appendices hold explanation and reference. Each heading states the task or the finding. No long dashes. No mid-sentence colons.
- [x] Run `node pstack/skills/poteto-mode/scripts/check-plan.mjs <plan.md>` and fix every line it prints (the **encode-lessons-in-structure** principle skill).
- [x] Hand back. Post the plan path and the script's output, then stop. Execution starts on the operator's explicit go, under the execution playbook the plan names.

## Exploration checklist

- [x] Frame. 产物是带源码证据、依赖顺序、验收与 UI 选择节点的计划。
- [x] Fan out. 两个只读 how explorer 分别调查 Sprout 现状和 T3 源码。
- [x] Aggregate. 主线程复核关键契约和结论。
- [x] Report. 写入计划并检查结构。

## Throughput checkpoint

瓶颈是跨领域契约不一致，尤其是投递恢复、租约持有者与执行授权的关系。两路只读调查并行，主线程负责当前产品文档、验收规则和计划。共享契约与迁移未来只设一个写者。只读调查不运行生产写入，不启动全量验收。

## Source snapshots

- Sprout 工作区起点 `2008185bcdbfac40c1754da125ad424addfc4778`。
- T3 源码来源 `https://github.com/pingdotgg/t3code`，固定快照 `8656cdb3a93883e06fd2786f1cb921571a04da11`。只读临时 clone，不读取安装包或进行反编译。固定文件与行号链接见计划 Appendix D。

## Decision log

- 本轮止于计划。页面方案选择与真实页面验收分别安排到执行阶段，避免把未制作的原型记为已验证。
- Human 随后确认持续 Crew 对话与 Crew 内租约接管方向，已修订计划。Human 无需为每项工作手动建 session；后台模型 session 可恢复/重建，工作状态不随之丢失。lead 可以不经 worker 同意收回本 Crew 授权，交给自己或其他 worker；系统先收尾旧执行再交接，离线不宣称立即可用，禁止强夺其他 Crew/DM。下一交付为 D0 的 2–3 个交互方案，尚未开始页面制作或产品实现。
- how explorer 与 how explainer 使用角色表 `magpie/auto/deepseek-v4.1-flash`，thinking low。两路只读调查后由一个 explainer 综合，未分派产品代码写入。
- 复核采用子对话独立 kind、显式停止与普通 run 结束分离、单一 `crew_epoch`、先收尾后改任，以及 Machine owner / execution holder 分离。拒绝把默认 lead 改成首个普通 Crew 成员，保留 Human 已确认的首位 Project Agent 规则。bootstrap 默认 Amenda 成为该 Project 默认 Crew lead。
- T3 的 parent-run cohort 与 Sprout 的 Crew 持久归属不同。活动输入注入是 Sprout 要新增并实测的能力，不能当成 T3 已解决。EffectOutbox 的 effect owner 不代替 Machine grant 和远端 fencing。

- Human 进一步指定信息分层。基础沟通为 chat message；报告超过 200 字生成持久 HTML，聊天只给短结论和入口；其余非 assistant 信息归 run-activity；subagent 的输入、过程和结果全部归 sub chat。D0 的变化范围只比较布局与交互，不再比较是否把这些内容流入主消息。计划同步调整报告契约、委派入口位置、200/201 字边界和防内容镜像验收。

## Principles applied

- `model-the-domain` 把 Crew、lead、delegation、delivery 和执行授权分别建模，delegation 不冒充 Task，租约 owner 不冒充执行 worker。
- `subtract-before-you-add` 删除 public channel、群组判醒和 mention 交接路径，不保留并行旧机制。
- `sequence-verifiable-units` 将 CR1–CR4 顺序拆开，CR2 先以无 Machine 路径证明委派投递，再接资源和 UI。
- `guard-the-context-window` 两个 explorer 分别读 Sprout 与 T3，由一个 explainer 综合；未来结果只进 lead 的有界摘要及完整结果引用。
- `encode-lessons-in-structure` 把竞态、未知回执、取消、旧 generation 与返回原位置写入具体验收，并运行计划结构检查。

## Verification receipt

- SQLite 临时行为探针实际运行并退出 0，只证明事件唯一键、绑定竞争模型和失效 generation 的建模选择，不证明真实 worker 或远端链路。
- `check-plan.mjs` 实际通过，输出 `4 PR sections, 0 problems`。这检查计划结构，不代表任何产品验收通过。
- `bash scripts/verify/l-docs.sh` 实际通过。未运行产品全量验收，也未跑 T3 测试、live lanes 或性能 baseline；这些是计划中的执行阶段任务。
- 本轮仅新增计划和本记录。未提交、合并或部署产品改动。

## D0 interaction directions

- 完成三份同数据、同信息分层的交互方案，差异只在层级与导航：A 内联活动（活动折叠在 lead 回复下，子对话整页进入并回到原卡片），B 右侧巡检栏（工作按状态常驻右栏，子对话在栏内打开），C 工作台视图（对话/工作分视图，委派进入看板）。三份都包含持续主对话、委派入口、子对话与返回、Crew 成员与 lead 管理、worker 忘还资源、lead 请求接管、离线待确认和交接完成。
- 方案文件 `.lavish/crew-d0-directions.html`，使用 Sprout `src/theme.css` 的语义变量、暖色中性底、`#f54e00` 强调色和 Geist 字体，浅色与深色都可读。原型只连本地静态数据。
- 实际用 headless Chromium 在 1280 宽与 390 宽检查三个方向、子对话、报告弹层、成员管理、接管状态，以及 B 的右栏隐藏与恢复入口，控制台无错误，窄屏无横向溢出，composer 固定在底部。B 隐藏后主对话占满宽度，恢复入口显示「1 待处理」。`html_preview` 在本机因浏览器下载失败不可用，改用本地缓存的 Playwright Chromium 检查，未改产品代码。
- Human 选定 B，右侧巡检栏，并要求右栏可以隐藏。理由是多个工作结果和需要 Human 处理的事项会在聊天里被刷走，右栏保持可见。未选用 A 与 C。
- 隐藏行为定为界面偏好，仅本机生效，不停止委派、不改变资源授权、不写服务端状态。宽屏默认显示，隐藏后顶栏保留带未处理数量的恢复入口，不自动弹出；窄屏不渲染常驻右栏。计划 CR4 已按 B 与隐藏契约改写，lane 1 和 lane 4 增加对应检查。
- 本次选择只确定页面形状，真实页面验收仍在执行期。未写产品代码。

## 2026-11-14 CR3 资源租约侦察

- 只读侦察确认现有独占边界。`machine_lease` 以 `(project_id, machine_id)` 唯一，非 free 必须有 `holder_instance_id`；`lease_authorization` 每代唯一，`lease_one_live_authorization` 保证同一 Machine 只有一份 live 授权；`remote_execution` 绑定 holder、authorization generation、run 和 chat。
- 所有远端调用经 `assertRemoteScope`、`assertExecutionContinuity`、`assertExecutionWrite` 校验 run/instance/chat 与 generation，Crew owner 不能直接复用这套 chat 级身份，必须先建模 owner 与 holder 的分离。
- 力收回缺口。`forceReclaimLease` 只在 `fencing` 且有匹配 pending receipt 时可用，lead 进程崩溃后可能留下无人能收回的 `held`。计划 CR3 增加基于持久 owner 和 `crew_epoch` 的对账入口，仍要求机器侧执行事实确认，不做超时自动释放。
- 释放边界不变。run 或 instance 结束都不会自动释放，远端进程可能仍活着。Crew 只能在确认收尾后撤销 grant 或转交，未确认时显示待确认并阻塞下一个写者。

## 2026-11-14 CR2 委派契约侦察

- 可复用的确定性原语有三类。`activeRunFor`（`src/domain/agent-run.ts:236-288`）已保证同一 instance 至多一个活跃 run；`attachMessageToRun`（`:318-332`）依赖 `runIdOfMessage` 做到一消息一 input；`appendSystemOwnerRunInput`（`:381-396`）和 `appendTaskStartRunInput`（`:335-369`）是已有的直接唤醒通道，不经 judge。
- 不可复用的是 judge 耦合链。`chat_message_wake`、`wake_evaluation`、`createContinuationDelivery`、`evaluateClaim`、`bindPendingDeliveries`、`settleContinuationRun` 都以 Evaluation 的 fingerprint 和 control epoch 为前提，伪造它们会把委派事件混进 judge 的重试与 attention 统计。
- 子对话不能靠消息可见性绕开。`agent_run_input.message_id` 非空并引用 message，给 lead 一条 input 就会在 lead 的 Crew 里留下 message。计划改为 synthetic prompt 入口，并让 `src/server/pi-host/run.ts` 的输入选择与 admit 认识新的 delegation kind。
- 三个失败模式写进计划约束。delivery 自建分配再写 `agent_run_input` 会产生两条开 run 路径；worker run 恢复成 interrupted 而不发 delegation event 会让 lead 永远等不到结果；delivery 不快照并重验 `lead_profile_id` 与 `crew_epoch` 会在改任后把结果投给旧 lead。
- 子对话中的 Task 仍按子对话责任校验，不能被 Crew 的 lead 责任自动承接。

## 2026-11-14 CR1 首轮验证与评审

- 完整 `scripts/verify.sh` 跑完 543 秒，115 个 gate 中 50 失败、65 通过。失败分三类。
- 真回归。九个 gate 仍在调用已删除的 `createGroupChatFn` 或 `createGroupChat`。`tests/fixtures/chat-info.ts` 期望被唤醒的是 lead 却得到 undefined。`p6c-member-removal`、`chat-scope`、`i5-project-removal` 仍按旧 Group owner 责任断言。`as-p5a-chat-ui` 和 `y-lease-ui` 还在找 Public Channel。`r-ui-layout` 的 expected 还是 public_channel。`p6c-participation-revocation` 触发“Crew 还没有 lead”。
- 环境与负载。`BETTER_AUTH_SECRET` 未设置、pi-magpie 未配置、pinned fixture models、`UNIQUE user.email`、满载下浏览器 gate 超时。这些不是 CR1 语义错误。
- 格式与契约。`vp check` 41 个文件格式问题，已修到 0 error。`c-data-auth` 说 drizzle 与 git 记录不一致。
- 代码评审另给五个 P1。首位 Project Agent 不成为 lead；自动化 `group_agent` 绕过 lead；改任 lead 不查活动 run 与租约；移出 worker 漏掉租约责任；空 lead 的 Crew 可被重新初始化并绕过改任权限。另有 `crew_control.mode` 没有停止入口与准入检查。
- 已提交 CR1 检查点 `fe02ff9`，仍未合 main。修复分三个 worktree 进行，域修复、文档改写、验证层分别由不同 worker 负责，主线程只做集成。

## 2026-11-14 CR1 第二轮完整验证

- 第二轮 `scripts/verify.sh` 跑了 738 秒，118 个 gate 中 29 失败。退役的 i2、i3、i4 被 runner 当成普通 gate 执行，算进失败，已改为不发现、不执行。
- 已修并单独验证通过：`c-data-auth`（旧的 public_channel 计数）、`p6a-wiring` 与 `deploy-continuation-off`（缺 BETTER_AUTH_SECRET）、`p7-client-navigation` 与 `p7-client-pwa`（seed 仍在查公共频道）。`assistant-browser` 单独重跑通过，属满载假红。
- 剩余失败按原因分三组处理。p6a 的 routing、delivery、integration 仍是旧 Group 语义或 gateway 冲突。成员治理与浏览器组是 lead 移除被 blocker 正确阻止，但 gate 仍按旧 Group 期待移除成功。p7、p6b、k2、z3 是 fixture 旧场景、重复 seed 或验收断言。
- 三个 worktree worker 并行修这三组，主线程继续跑剩余 gate 分类。环境类失败（pi-magpie、pinned model、真实外部服务）不伪装成通过，单独记为环境前置。

## 2026-11-14 CR1 第三轮门禁收敛

- 三组 gate 修复并行完成并集成。p6a 组把快照从旧 Group 场景重生成到 crew owner_led，delivery 断言改为 lead 收件而 Human 仍是 owner，gateway 冲突根因是 fixture 静态导入在环境变量之前加载 config。成员治理组把 lead 移除改成先验证 blocker 可见，再移除普通成员。p7/p6b/k2/z3 组把 Crew 消息改为只唤醒 lead，p6b 重复 seed 改为动态导入，K2 的 public_channel 计数改为 Crew 集合，Z3 改为核验归档 sourceCommit 对应的脚本 SHA。
- `bf-p6a-lifecycle` 的远程冲突是误判。真实根因仍是 `tests/fixtures/p6a-lifecycle.ts` 顶层静态导入 `./crew-chat`，ESM 提升后在设置 `BETTER_AUTH_SECRET` 前加载 auth config。改为环境变量之后的动态导入即可，177 条断言通过。
- `z-lease-integration` 的第一处失败是 gate 与产品决策冲突。`b86c4f9` 已确定没有 held 租约时不渲染强制收回，gate 却在 free 状态等待该控件。改为断言 free 时不存在，随后门禁进入真实 Pi 租约工具，并暴露 model fixture 计划参数与注册工具 schema 漂移，另派 worker 处理。
- 集成后 `pnpm typecheck`、`pnpm test`（185 文件 / 1801 测试）、`pnpm exec vp check` 通过。p6a、p7、p6b、k2、z3、k-acceptance、h-project-agents、p6c-member-governance-ui 单 gate 复跑通过。
- 仍未证明为通过的环境类前置：`ah-execution-live-e2e` 三条 fixture 在满载下 143 超时；`x-remote-tools`、`ae-remote-tools-cancel-log`、`aj-recovery-matrix` 依赖未安装的 pi-magpie。它们不作为 CR1 语义证据，也不伪装成通过。

## 2026-11-14 CR1 第四轮完整验证

- 完整 `scripts/verify.sh` 跑 638 秒，115 个 gate 中 4 失败。其中 `bb-task-live` 在主线 `2008185` 的独立 worktree 上同样失败，确认是既有问题，不是 CR1 回归；`rm2-attachments` 的 lane 10 单独复跑通过，属满载下的 draft 丢失假红；`x-remote-tools` 与 `ae-remote-tools-cancel-log` 都因本机未安装 pi-magpie package，属于环境前置缺失。
- 本轮修掉两处真实门禁漂移。`tests/fixtures/execution-live-e2e.ts` 与 `tests/fixtures/execution-recovery-matrix.ts` 仍传 `waitMs`，而工具面自 `cde2a04` 起只接受 `blockMs`。改名后 `ah-execution-live-e2e` 与 `aj-recovery-matrix`（12 cells）都通过。
- `z-lease-integration` 的 fixture 同样在用已移除的 `waitMs`，并新增 `blockMs: 0` 让 Chat 先消费真实提交结果，再暂停 Worker 验证强制收回；该 gate 14 项断言通过。
- 本轮集成后 `pnpm typecheck`、`pnpm test`、`vp check` 保持通过。CR1 没有待修的产品回归，剩余红都是主线既有、环境前置或满载假红，已在交付说明中分列。

## 2026-11-14 CR2 委派落地

- 委派不新建 synthetic prompt 表。结果 prompt 写在 worker 子对话里，用 `delegation_prompt_for_chat_id` 别名指向 Crew；lead 的 run 通过该别名消费，Crew 主时间线没有 worker 消息。这样既满足 `agent_run_input.message_id` 非空约束，也不把结果伪装成 lead 自己发送的消息。
- 子对话的成员从父 Crew 派生。当前 lead、该委派的 worker、能读父 Crew 的 Human 可读；sibling worker 不可读，成员移除后立即失效。委派行快照 dispatch 时的 lead 与 `crew_epoch`，投递前重读当前值，不匹配转 attention。
- 事件与投递分表。`delegation_event` 以 `(delegation_id, revision, kind)` 唯一；`delegation_delivery` 记录 pending|bound|injected|acknowledged|stale|attention。完成、失败、取消使用终态 CAS，迟到结果不能覆盖新 attempt。
- 每个 scheduler 轮次先 `reconcileDelegations` 再 `deliverPendingDelegations`。worker run 变成 failed/interrupted/aborted 而委派仍 running 时，系统补发失败事件，不依赖 worker 主动报告；没有这条兜底，宿主崩溃会让 lead 永远等不到结果。
- 同一 lead、同一 epoch 的 pending 结果按 32 KiB 合并成一条 prompt，避免多个委派同时完成时开多个 lead run；ack 按 runId + messageId 统一标记。
- 停止 Crew 会取消未结委派，但没有 stopping 中间态。当前 `setCrewMode` 由 Project 创建者调用；`crew_epoch` 只在 lead 变化时推进，停止不推进，与计划中的完整 stop 流程仍有差距。
- 交付边界。lead 工具是 `sprout_delegation_start/input/cancel/list`，worker 工具是 `sprout_delegation_complete/block`，remote 面是 `crew_mutate`。没有资源 grant，Machine 任务仍走原有 lease；CR2 不宣称租约问题已解决。
- 验证现状。`tests/delegation-core.test.ts` 8 个用例通过，覆盖幂等 dispatch、Crew 时间线干净、lead 输入、完成投递与 ack、lead 变更 attention、worker 死亡补发、取消、blocked 事件；`pnpm typecheck` 与 `vp check` 通过。CR2 尚未跑完整 `scripts/verify.sh`，计划里的独立 `delegation-delivery.ts`、证据 lane 和性能预算未按原样实现，不能勾选这些条目。

## 2026-11-14 CR2 完整验证

- CR2 检查点 `fdf88a1` 后跑完整 `scripts/verify.sh`。116 个 gate，7 失败。
- 环境前置 2 个。`x-remote-tools` 与 `ae-remote-tools-cancel-log` 需要未安装的 pi-magpie package，和 CR1 时相同。
- 主线既有 1 个。`bb-task-live` 在主线 `2008185` 的独立 worktree 上仍失败，不是 CR2 回归。
- 满载假红 4 个。`cron-core`、`as-p5b-task-pages`、`assistant-browser`、`u-machine-ui` 单独复跑全部通过；`u-machine-ui` 在三个并行 gate 竞争时仍会 `Timeout production health`，串行后通过。没有发现 CR2 语义回归。
- `crew-delegation` 新 gate 通过，覆盖 dispatch 幂等、Crew 时间线不出现 worker 消息、完成投递与 ack、lead 变更 attention、worker 中断补发、取消与 blocked 事件。

## CR3 第一阶段：Crew 授予租约

- 新增 `lease_grant` 与迁移 0062。`lease_mutation` 增加 `grant`、`revoke_grant`，授权原因同步扩展。
- lead 的 `sprout_lease_grant` 把当前持有的 Machine 授予同 Crew 正在运行的 worker；`sprout_lease_revoke_grant` 由原授予者或当前 lead 撤销。两者都复用 fencing，旧执行未排空时保持 pending。
- 实际执行 holder 仍是 worker 实例，`lease_authorization.holder_instance_id` 不改成 Crew。worker 在委派子对话内不能调用任何租约 mutation。
- 新增 `tests/lease-grant.test.ts` 覆盖 acquire、授予、worker 写授权、lead 失去写权、request 重放、撤销、授权回到 lead。
- 未完成：Crew owner 建模、持久资源队列、自动分配、Crew coordinator 恢复、live Machine 验收、性能基线。

## 2026-11-15 CR3 资源协调器审查修复

- 独立只读审查发现 4 个 P1 与 1 个 P2：Crew lead 可绕过协调器直接 acquire/grant/handoff；历史 released 请求使 `crewResourcesReady` 永远为假并打断替代 run；有效 Crew grant 下 Human 取消被执行范围校验拒绝；Human force reclaim 后 active 请求继续占槽；`leaseWaitTarget` 把 held 的 Crew 租约当空闲。
- 修复：Crew lead 与 delegation worker 的旧 lease mutation 在服务层被拒，网络入口对 Crew/delegation 会话的旧 mutation 一律 forbidden；Human/MachineContext 不参与 Crew 执行范围校验；`crewResourcesReady` 忽略 released/revoked 历史，历史全部 released 时返回 false；reconcile 对已外部收回/替换的 lease 结清请求，未确认排空转 attention；新增 `held_by_crew` 等待原因。
- 夹具调整：旧 p8a/p8b Crew 场景使用独立 dummy lead，p8a 的 Crew handoff 目标改为预期 forbidden。
- 验证：`pnpm typecheck` 通过；`pnpm test` 188 文件 / 1837 测试通过；`crew-delegation` 14 项、`z-lease-integration` 全部断言、`p8b-timeout-integration` 34 项通过。
- 仍存缺口：非 lead 的 Crew 成员通过内部服务直调仍可使用旧 mutation；网络入口已封死，后续在 CR4 前移除旧入口或迁移剩余夹具。

### 2026-11-15 复审两处遗漏

- `leaseWaitTarget` 读取了不存在的 `ownerCrewChatId`，而 `LeaseView` 暴露的是 `holderCrewChatId`，真实 Crew 租约仍被当作空闲。已统一字段，并把等待测试的输入类型绑定到 `LeaseView`/`LeaseWaitView`，避免契约漂移。
- Human 正常 reclaim 后，原 run 在 reconcile 前结束时 `freezeCrewResources` 已把请求转为 `attention/owner_conflict`，原结清分支只处理 `active`，请求永久占槽。reconcile 现在对 `owner_conflict`/`drain_unconfirmed` 在确认 lease 已不属于当前 Crew、且没有未排空执行时转 `released`，有未排空执行则保留 attention。
- 新增覆盖「reclaim → abort 原 run → reconcile → 下一请求获得分配」的测试。
- 验证：`pnpm typecheck`、`pnpm test`（188 文件 / 1838 测试）、`crew-delegation`、`z-lease-integration`、`p8b-timeout-integration` 通过。

## 2026-11-15 CR4 委派右栏实现

- 按 D0 方向 B 在既有会话详情右栏顶部加入可折叠的 Crew 委派区域；宽屏详情栏常驻，窄屏沿用现有详情入口。DM 与 delegation 子对话不渲染。
- 新增轻量查询 `listCrewDelegationRail` 与 `listCrewDelegationsFn`：按 Project/Crew/epoch 读取，排除 cancelled 与归档子对话，completed 最多 20 条，counts 保留实际总数，不读取结果 HTML。
- 卡片分「需要你 / 进行中 / 已完成」，空段隐藏，无委派整栏隐藏；点击进入委派子对话，父对话链接返回并恢复打开卡片时的消息锚点。
- 折叠偏好按 Project 存 localStorage；宽屏默认展开，窄屏默认折叠，显式选择优先；刷新复用现有 chat live tick，不新增轮询通道。
- Commit `8835e1c`，22 个文件；未改 schema/迁移。
- 实现 worker 自报 typecheck、190 文件/1844 测试、浏览器 gate 5 组断言通过。主线程独立复跑 typecheck 与全量测试通过，并在隔离数据库、真实 dev server 上复跑 `crew-rail.mjs` 5 组断言通过。
- 待完成：独立代码复审、Human review（宽/窄、展开/折叠、需要你/完成、进入子对话并返回）与 30–60 秒评审录屏。自动 gate 的 12.72 秒录屏不算 Human review。

### 2026-11-15 CR4 复审修复

- 返回父对话的锚点恢复改为有界分页：恢复期间只往前读、不按当前视口淘汰，且同一游标无进展最多重试 2 轮；拿到目标后按保存的 offset 还原，找不到则在 20 页内回退保存的 `scrollTop`，不会持续空转。
- `loadOlderForRestore` 保留 `aboveShift`，避免恢复途中“钉住底部”把刚读到的旧页挤掉；恢复结束后重新交回正常淘汰。
- 右栏折叠把用户显式选择保存在内存 ref，storage 读写抛错或窗口 resize 时不再覆盖显式选择；只有从未选择过才使用宽度默认。
- 浏览器 gate 父对话改为 120 条消息，覆盖目标不在首屏；新增 storage 失败后 resize 仍保留显式选择。active 委派夹具改为直接落库运行中记录，避免本机缺少 provider 时 lead run 失败改变段落归属。
- 恢复收尾主动测量目标所在页并 `reportAnchor`，不依赖 scroll 事件；否则窗口 anchor 仍停在最新页，下一次 live/loader 更新会裁掉刚恢复的页。
- 验收父对话改为 200 条（4 页），读满后把锚点放在最旧页（距最新页 3 页，超出窗口 2 页保留半径）并断言不在最新 50 条；恢复后写入一条 live 消息，等下一轮 live tick 完成 settle，断言目标页仍保留。移除 `reportAnchor` 时该断言失败，确认 gate 能抓住原缺陷。
- storage 故障另加“首次读取抛错”路径：应用挂载前注入 SecurityError，断言按宽度取默认、显式折叠后 resize 仍保留。
- 验证：`pnpm typecheck` 通过；`pnpm test` 190 文件 / 1844 测试通过；隔离数据库与真实 dev server 上 `crew-rail.mjs` 7 组断言全部通过。
