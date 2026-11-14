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
