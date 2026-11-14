# Crew 功能开发计划

把 Group 改为由一位 Crew lead 对 Human 负责的 Crew。委派有独立子对话、持久结果事件与受控资源授权。Human 在主对话里看结论，在需要时打开工作细节。
本文件是待执行计划。当前产品起点为 `2008185bcdbfac40c1754da125ad424addfc4778`，本轮只做源码调查、一次丢弃式行为探针和文档检查，未实施产品变更。

## How to read this

One box is one unit of work and names the evidence. Check a box only when its evidence exists. 证据记录受验 commit、环境、命令、退出码、观察结果和产物路径。技术通过、Human 体验确认和已合并分别记账。

执行采用 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/poteto-mode/playbooks/autopilot-stack.md`。各 PR 先进入 Crew 集成栈，由 operator 审阅并决定落地。计划不授权合并、部署、删除共享库或改动 prod。CR1 和 CR4 在 merge-ready 停下等待页面评审。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

产品契约按下列边界实施。详细定义在 CR1 写入 `docs/crew-core.md`，不把本计划当第二份永久契约。

- 已确认的方向。Crew 取代 Group，每个可运行的 Crew 有一位 Crew lead。Lead 是 Crew 内的角色，复用普通 Agent profile，不新增 `purpose`。
- 已确认的交互。Human 主对话只由 lead 接手。一次 delegation 对应一张折叠卡片和一个子对话，能返回原主对话位置。worker 的过程和完整结果留在子对话，lead 汇总需要 Human 阅读的内容，包括审查异议。
- 已确认的信息呈现。Human 与 lead 的基本信息、基础沟通使用 chat message。报告正文超过 200 字必须生成 HTML artifact，消息只保留简短结论与打开入口，不把长报告直接贴入消息。阈值按可见正文的 Unicode 字符计数，恰好 200 字仍可用消息。工具调用、执行状态、资源事件及其他非 assistant 信息进入所属 run 的 run-activity；subagent 的输入、消息、工具过程、结果与报告都进入对应 sub chat。主 Crew 不镜像 subagent 内容，只展示 lead 的必要汇总及 run-activity 中的委派入口。该规则同样约束 D0 所有方案。
- 已确认的会话体验。Human 默认在同一 Crew 中持续与 lead 交谈，不要求为每项工作手动创建 thread/session。聊天记录、工作责任和模型 session 分开；后台压缩、恢复或重建模型 session 不清除未完成委派、资源归属与最新要求。worker 默认每次 delegation 独立执行上下文，追问与修正接回同一次委派。独立话题可作为后续可选能力，首版不引入自动话题分类或强制分线程。
- 已确认的运行方式。dispatch 成功后 lead 可以结束本轮，Human 可以继续交谈。完成、失败和需要决策的阻塞通过持久事件接回 lead。不用 @mention、LLM 唤醒判定或周期询问来传递这些结果。Lead 已运行时优先投递到当前 run，不为同一事件另起重复 run。
- 已确认的资源方向。租约归 Crew，worker 获得可撤销执行授权。Lead 统一提出资源需求、分配和释放，也可主动撤销本 Crew 的 worker 授权，交给其他 worker 或自己，不要求原 worker 同意。runtime 执行授权、排队、收尾与恢复；正常完成由 runtime 负责归还，不依赖 Agent 自觉调用。原执行未确认停止或隔离前不能重新发可写授权，离线时显示接管待确认。保留 Project/Machine 独占边界，lead 不得强夺其他 Crew/DM 的租约，Human 保留最终收回权。
- 已确认的 Project 变化。删除 public channel，创建 Project 时创建普通 Crew，首位加入 Project 的 Agent 成为该 Crew 的 lead。新建 Project 与 bootstrap 必须使用同一初始化逻辑。
- 首版默认值。无 Agent 的 Project 先有无 lead 的 Crew，显示待指定 lead 并禁止启动；首个 Agent 加入与 lead 指定在同一事务中完成。bootstrap 继续创建现有默认 Amenda，并把它作为该 Project 首位 Agent 原子加入默认 Crew、指定 lead；不额外创建助理或第二个 lead。后续 Project Agent 不自动加入 Crew，加入 Crew 是单独的授权动作。默认 Crew 初始化后按普通 Crew 管理，其他新建 Crew 由 Human 显式指定 lead。
- 首版默认值。Human 管成员及 lead；lead 只向当前 Crew 内获授权的其他 Agent 委派。一个 delegation 只选一位 worker，worker 不能再次委派。子对话首版供 Human 查看与停止，补充工作要求由主对话交给 lead 转发。DM 保留现有用途。
- 首版默认值。delegation 和 Task 分开建模。Task 是业务责任和验收对象，delegation 是一次受托执行，可选择关联一个 Task。worker 完成本次委派不自动完成 Task，也不等于 lead 或 Human 验收通过。
- 首版默认值。Crew 主对话移除 contextual/owner fallback 和 task-periodic 的自动聊天接续，保留 Human 输入、明确任务启动和委派事件。自动化、助理提案、Task 启动统一投给 lead，正文里的 worker mention 不绕过 lead 启动 worker。现有 webhook/cron/飞书的外部 channel 功能继续存在，删除对象仅是 Sprout 的 `public_channel` 聊天类型。

## Program checklist

### Arm the program

- [ ] 向 operator 交付本计划并停下，收到明确 go 后开始实施。登记集成分支 `integration/crew`，从当时已验证的 `main` 建立，不把本次调查 commit 当作未来不变的基线。
- [ ] 从 trunk 读取仓库约定并记录 SHA。运行 `git show origin/main:docs/project-conventions.md`、`git show origin/main:docs/verification.md` 和 `git show origin/main:AGENTS.md`，每个阶段重新核对。
- [ ] 读取本机 role map 和技能原文。执行 playbook、swarm、opening-a-pr、shipping、how、unit-testing-best-practice、comment-sicko 及实际 browser/control skill 不在 Sprout trunk，记录各自真实路径和版本，不运行不存在的 `git show origin/main:pstack/...`。本计划使用的技能入口列在 Appendix D。
- [ ] 将 `/loop 1h` 的审计意图映射到宿主支持的后台审计能力，仅在 go 后启用。宿主无 loop 时登记一个有完成通知的审计任务；不为等待子代理创建轮询、sleep 或额外 LLM run。stand-down 后关闭审计并让所有写者停止写入。
- [ ] 审计 tick 使用以下原文并记录结果。只在状态变化时发送 status message。`Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none.` 其中 trunk 对仓库文档取 `origin/main`，宿主技能按上项版本读取。
- [x] 执行 D0 页面选择。用同一批 Crew、委派状态和措辞制作 2 到 3 个 HTML 方案，比较持续主对话、委派卡片、子对话进入并返回原位置、lead 管理以及资源等待/接管的层级。各方案都展示 worker 忘记归还、lead 请求接管、离线待确认与交接完成，不能把强制接管画成立即空闲。通过 GUI artifact 工具呈现，记录 Human 选定方案的路径和结论，再开始涉及形状的 UI 代码。此项可与只读研究并行，不能用本计划代替选择。
- [x] Human 选定方案 B，右侧巡检栏，并要求右栏可以隐藏。理由是多个工作结果和需要 Human 处理的事项会在聊天里被刷走，右栏让它们保持可见。方案与三个方向的原型见 `.lavish/crew-d0-directions.html`，A 内联活动和 C 工作台视图未选用。
- [x] 把隐藏行为写成确定契约。宽屏默认显示右栏；Human 可随时隐藏，隐藏状态只记为本机界面偏好，不停止委派、不改变资源授权，也不改写服务端工作状态。隐藏后顶栏保留带未处理数量的恢复入口，不自动弹出；窄屏不提供常驻右栏。此项进入 CR4 的实现与验收，不新增独立阶段。
- [ ] 集成 owner 登记共享契约与数据库的唯一写者，读取最新迁移 journal 后分配 CR1、CR2、CR3 的新编号，不复用已合并编号。数据库验证在独立临时库进行，共享实例的重建另按仓库规则处理。

### Spawn owners

- [ ] 每个 PR 设一位生命周期 owner，写者用独立 worktree。当前宿主使用 `delegate_task` 时显式传 `isolation: 'worktree'`。模型只取执行时 `~/.pstack/models.md` 对应角色，记录 provider、model、thinking，不照抄已经下线的模型。
- [ ] 按依赖启动。CR1 先行，CR2 基于 CR1，CR3 基于 CR2，CR4 基于 CR3。D0 可在 CR1 后端研究期间进行；CR4 的无写入设计研究可提前，不能并行改共享契约。顺序是为了不让四个 owner 同时重写 chat、run 和 lease 的边界。
- [ ] Schema 和迁移始终只有集成 owner 写入，CR2、CR3 的 owner 提交契约需求后由其生成。UI owner 不改 `src/db/**` 或 `drizzle/**`。执行器与 Pi extension 的字段变动同轮更新全部调用方。
- [ ] CR1 的 Crew 管理行为和 CR4 的委派界面都经过 operator 页面审阅后才可落地。CR2、CR3 通过受控接口和 runner 验证，不增加待选页面形状。

### PR mechanics, for every PR

- [ ] 解析一次 forge。优先已配置的内建 PR 工具；Origin 能解析当前仓库时用 `origin pr`，否则用 `gh` 并记录。PR 打开为 ready，栈子项以父分支为 base，首项以 `integration/crew` 为 base。
- [ ] 每次面向 PR 的 push 前跑仓库 lint、typecheck 与该单元专项，保留 hooks。检查 diff 后按 comment-sicko skill 做报告式注释审计；修复实质问题，不加说明实现本身的噪音注释。
- [ ] owner 跟进 CI、Bugbot、安全审阅和独立审阅，按执行 playbook 逐项处置。代码就绪后保持已测 merge base，只有明确的冲突、上游导致的 CI 问题或已知并发变更才重建基线。
- [ ] 每个单元边界按仓库约定同步 main 到集成分支。生成物重新生成，不手工合并。各单元的受验 SHA 与 patch-id 写入 trail。

### Verdict and merge, for every PR

- [ ] 每个 code-ready head 跑一次完整 swarm，包含 gates、下列十条 live lane、一个 perf lane 和至少两条独立审计。第一条审计检查权限及恢复，第二条检查产品契约、漏删路径及证据可信度。
- [ ] 十条 live lane 是该阶段验收计划，并非本轮已经执行。默认并发上限为 2，每条 lane 使用独立 checkout、数据库和 runner workspace。相同构建按验证约定复用；真实付费模型调用先核对验证预算，不为每条重复启动付费会话。
- [ ] 审计者只以可观察事实给 verdict。标为 trunk regression 的原有缺陷单独记录；新增缺陷阻断。小修和不改行为的 rebase 只跑受影响 verifier，行为变更才重新展开完整 swarm。
- [ ] CR1、CR4 的页面证据在 chat 提交，达到 merge-ready 后等待 operator。CR2、CR3 无单独页面 gate，但整个栈仍由 operator 决定落地。任何新 head 按 shipping 的 patch-id 规则核对证据有效性。
- [ ] 阶段结束由集成 owner 同步 main、解决冲突，按验证约定跑一次完整 `pnpm verify` 并记录 exact SHA。通过最终 Human review 后交 operator，不自动部署 prod。

### Boot recipe, for every live lane

- [ ] 每条 lane 在由宿主创建的独立 worktree 中检出目标 SHA，运行 `bash scripts/dev/worktree-setup.sh`。该脚本建立独立 `data/`；确认没有连到 prod 或共享数据库。trunk lane 检出程序启动时冻结的 trunk SHA。
- [ ] 依 `docs/verification.md` 的当前 run 构建准备启动构建产物、真实 Worker 与可控回环 runner，按新增 `scripts/verify/crew-*.sh` 的 ready 条件等待。命令失败先查原进程，不重复启动；后台命令保存日志、PID 与退出码，结束时回收本 lane 进程。
- [ ] UI lane 通过当前 GUI browser/preview 操作真实页面；领域 lane 通过 HTTP/server function 和真实 worker wire 注入场景，禁止直接改数据库模拟成功。数据库只读诊断允许观察 delegation、event、run input、lease、grant、execution 的关联。
- [ ] 脚本在各 PR 新增或修订，纳入 verify runner。本文中的新增脚本名代表待交付项，不是今天可以运行的命令。首个 lane 前补全端口、fixture、ready URL 和 cleanup 参数并写进该脚本，缺少可复现 boot recipe 不可宣称 code-ready。
- [ ] 截图存到 `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png`。后端 lane 用 artifact 呈现只读诊断快照后截图，同时保留原始 JSON、日志和退出码；截图只便于审阅，不能替代请求与 worker 收据。敏感 grant 不进入截图。
- [ ] Perf 在同一机器与同配置 runner 上交错运行 trunk/head 各 5 次，先记录 trunk 原值和场景差异。通用 HTTP 指标取中位数和 p95，fixture 固定模型输出、事件数和数据库大小，不把工具等待或后台启动返回时间算作 runner 执行时间。

## 建立 Crew 与 Project 初始化契约 (CR1)

**Depends on.** None. D0 选择是管理界面实施的前置条件。

**Files.**

- [ ] 修改 `src/contracts/chat.ts`、`src/contracts/chat-capabilities.ts`、`src/contracts/ids.ts`、`src/db/schema.ts` 和新增编号的 `drizzle/**`。
- [ ] 修改 `src/domain/chat.ts`、`src/domain/project.ts`、`src/domain/bootstrap.ts`、`src/domain/task-capabilities.ts`、`src/contracts/project-member-removal.ts`，删除 `src/domain/channel.ts` 的 Project public channel 实现。
- [ ] 同轮更新 `src/domain/assistant.ts`、`src/domain/info-hub.ts`、`src/domain/automation-target.ts`、server functions 与现有 chat UI 的类型及 Crew 管理入口。外部 channel 文件按用途保留，不能按文件名批量删除。
- [ ] 新建 `docs/crew-core.md` 和 `scripts/verify/crew-domain.sh`。修订 `docs/core-scope.md`、`docs/glossary.md`、`docs/communication-decisions.md`、`docs/project-profiles-decisions.md`、`docs/tasks-decisions.md`、`docs/development-plan.md` 及对应 feature-map。重命名 Group 专项并更新验证注册，不留旧命令别名。

**Build.**

- [ ] 把 `chat.kind` 直接收敛为 DM 与 Crew 等目标类型，删除 `group`、`public_channel` 的运行分支、索引、CHECK 和 effective member view 分支。Crew 成员来自显式成员关系，不继承 Project 后续所有成员。既有迁移文件不改，只新增目标迁移，在空库验证最终 schema，不写旧数据救援、双读或 legacy chat 类型。
- [ ] 用 Crew 级字段记录 nullable lead profile、单一 `crew_epoch` 及 `crew_control.mode`。只有未设置过 lead 的初始化 Crew 可以为空；运行、委派和自动化必须先有有效 lead。Project 创建事务写 Crew，bootstrap 和首位 Project Agent 加入共用初始化函数，禁止两个并发加入各自选出 lead。`crew_epoch` 只在 lead 改任、移除 lead 和显式停止 Crew 时单调递增；普通 run 开始/结束不改变它。delegation、delivery 和资源 grant 引用这一版本，不再另建含义重叠的角色版本。
- [ ] Human 改任 lead 时事务校验 Project/Crew 成员。Lead 有未结束委派或资源授权时返回可理解的 blocker，先停止或收尾再改任。移除 lead、worker、Machine、Crew、Project 都使用同一活动责任检查。创建后删除 lead 不重新触发首位 Agent 初始化。
- [ ] Crew Human 消息和现有任务启动都路由给 lead。移除 Crew 的 contextual/owner_fallback 和周期空唤醒，worker mention 仅作为文本和成员定位。同步调整自动化、助理、Info Hub 和 Task 责任解析，让 public channel 消失后仍有确定目标。
- [ ] 现有 UI 只实施 D0 选定的 Crew 名称、成员和 lead 管理部分。CR1 从 Crew 顶栏入口打开成员与 lead 管理覆盖层，CR4 增加右栏后在栏标题旁提供同一入口，复用同一组件，不复制表单。委派卡片与右栏留 CR4。旧数据不在本轮自动迁移，任何共享实例重建由执行阶段另行按仓库约定安排。

**You see.**

- [ ] 空 Project 有一个待指定 lead 的普通 Crew，添加首个 Agent 后立即可对话。后续 Agent 不自动出现在 Crew 中。
- [ ] Human 不需要 mention，只有 lead 的 run 启动；未指定 lead 有明确阻塞说明。Project 导航、目标选择和工具目录里没有 public channel。
- [ ] Task、自动化和助理的原有 DM 路径仍可操作，Crew 路径能找到同一位 lead，外部飞书 channel 未被误删。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 在现有 `tests/chat-governance.test.ts`、`tests/chat-capabilities.test.ts`、`tests/message-wake.test.ts` 及 Project/bootstrap 测试补事务、权限、默认成员和 lead-only 路由反例。先用旧实现跑有意义的失败，再验证新实现通过。
- [ ] 覆盖并发首位 Agent 加入、lead 活动责任阻止移除、无 lead 任务/自动化失败、DM 不变与空库迁移。运行 `pnpm test` 的受影响文件和 `bash scripts/verify/crew-domain.sh`，随后 `pnpm check`、`pnpm typecheck`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `magpie/auto/deepseek-v4.1-flash` at the PR head, per the boot recipe. 执行前核对 role map，变更需记账。

- [ ] Lane 1. Regression lane against trunk. 两侧创建 Project、加入首个 Agent 并发送 Human 消息，trunk 无 Crew 如实记录。Save `cr1-project.png`. Pass when head 只创建一份 Crew、一个 lead run，DM 行为与 trunk 一致。
- [ ] Lane 2. 无 Agent 创建 Project。Save `cr1-leadless.png`. Pass when Crew 可见、无 run、界面说明先指定 lead。
- [ ] Lane 3. 两个请求同时添加首位 Agent。Save `cr1-first-agent-race.png`. Pass when最终只有一个 lead，成员关系与请求事务结果一致。
- [ ] Lane 4. 添加第二个 Project Agent。Save `cr1-members.png`. Pass when该 Agent 不自动获得 Crew 读取或执行权限，显式加入后可见。
- [ ] Lane 5. 对两位 worker 发送 mentions。Save `cr1-mentions.png`. Pass when只有 lead 启动，worker run 数为零。
- [ ] Lane 6. 空闲 Crew 改任 lead 再发消息。Save `cr1-change-lead.png`. Pass when仅新 lead 接手，旧 lead 不被 fallback 唤醒。
- [ ] Lane 7. 移除有活动 Task 责任的 lead。Save `cr1-removal.png`. Pass when事务拒绝并列明 blocker，成员和 lead 未部分改变。
- [ ] Lane 8. 通过助理与 webhook/cron 向 Crew 发送工作。Save `cr1-targets.png`. Pass when目标解析到 lead，失效目标有失败记录且不替换 Agent。
- [ ] Lane 9. 在 Crew 建立并启动 Task，另在 DM 做同样操作。Save `cr1-task.png`. Pass when责任分别归 lead 和 DM Agent，worker 类型限制仍成立。
- [ ] Lane 10. 空库启动、刷新导航和目标选择器，检查飞书 DM adapter。Save `cr1-surface.png`. Pass when没有 public channel 入口或运行枚举，外部 channel 配置与原 DM 可用。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 两侧测 100 个 Project 的创建 HTTP 延迟及 100 次消息从持久化到 run queued 的延迟、创建 run 数和 wake judge 调用数。新路径另测首个成员加入到 lead 可用。
- [ ] Probe. `scripts/verify/crew-domain.sh` 新增对 trunk/head 都能运行的固定 fixture 子命令，交错各 5 轮。trunk 按原聊天类型运行，记录场景差异，不要求其接受新枚举。
- [ ] Baseline. 实施前记录 trunk 的中位数、p95、run 数和 judge 数到 `orchestrate/crew/perf/cr1-baseline.json`，未测不能填推算值。
- [ ] Rule. 同形 DM p95 超过 trunk 的 1.20 倍且绝对增加超过 50ms 则失败。Crew 每次 Human 输入最多启动一个 lead run、零 judge 调用；固定本地 fixture 的首位成员加入到 lead 可用 p95 超过 1s 则失败。新 Crew 与旧 channel 创建不做无效比率对比。

**Review gate.** The operator reviews before merge.

- [ ] 复制 lane 2、4、6 的 screenshots 到 `orchestrate/crew/media/cr1-review-*.png`，按 D0 方案核对 lead 与成员层级。
- [ ] 录制 30 到 60 秒 video，保存 `orchestrate/crew/media/cr1-review.mp4`，展示创建、首个 Agent、改任和无 lead 阻塞。
- [ ] 在 chat 向 operator 提交截图和视频，记录选择及体验反馈，停在 merge-ready。

**Merge.**

- [ ] root 对 exact head SHA 给 clean verdict，Bugbot triage 完成。
- [ ] 同步集成分支并核对 patch-id 和证据，operator 将 CR1 落入集成栈，记录 SHA；不直接进入 main。

## 持久化委派并把结果接回 lead (CR2)

**Depends on.** CR1。

**Files.**

- [ ] 修改 `src/contracts/chat.ts`、`src/contracts/chat-capabilities.ts`、`src/contracts/ids.ts`，新建 `src/contracts/delegation.ts`、`src/domain/delegation.ts`、`src/domain/delegation-delivery.ts`、`src/server/functions/delegation.ts`，由集成 owner 更新 `src/db/schema.ts` 和新增迁移，包括 child CHECK 与 effective member view。
- [ ] 修改 `src/domain/agent-run.ts`、`src/domain/chat.ts`、chat server functions、`src/server/continuation-scheduler.ts`、worker gateway、Pi host 和 `src/worker/**` 的上下文输入边界；接入 Human `stop_crew` / `resume_crew`、新增 worker 可调用的受限委派工具并更新工具目录与提示。
- [ ] 新建 `tests/delegation.test.ts`、`tests/delegation-delivery.test.ts`、回环 runner fixture、`scripts/verify/crew-delegation.sh`。更新 `docs/crew-core.md`、feature-map 与验证注册。

**Build.**

- [ ] 建立 `delegation`、持久 event 与 delivery 记录。delegation 固定 parent Crew、派发 lead profile 与 `crew_epoch`、worker、子对话、请求摘要、任务可选引用、结果与终止原因。新增 `chat.kind='delegation'` 和 `parent_crew_chat_id`，后者复合外键约束同 Project 的 parent chat，domain 校验 parent 必为 Crew。`delegation.child_chat_id` 唯一，子对话不能脱离委派创建。子对话使用专属 CHECK，不套用 DM 的 Human owner/唯一性约束，也不是嵌套 Crew，不参与 Crew 唤醒或 Project 默认列表。
- [ ] 子对话的执行 Agent 固定为该 delegation 的 worker，只有该 worker 的 instance 在这里运行。当前 Crew lead 可经委派工具读写工作指令；有权读取 parent Crew 的 Human 可查看和停止，不复制 Human 成员行。其他 worker 无权读取 sibling 子对话。effective member view 和 server 权限派生当前 lead、已授权 worker 与 parent Human 的访问，成员移除后立即失效。原 dispatch lead 仅为审计事实，不自动保留后续读取权。
- [ ] 提供 `delegate_work`、`send_delegation_input`、`cancel_delegation`、`report_delegation` 的目标契约。只允许当前 lead 派发给已授权成员；worker 只能报告自己的委派。`clientRequestId` 在 Crew 和动作范围唯一。接纳事务一次性创建 delegation、子对话、初始 run input、主对话卡片定位事件，提交后才返回 accepted 与 IDs。
- [ ] 事务前或事务内权限、成员、输入错误同步返回，零残留子对话。接纳后 runner 无法启动则转为持久 failed 事件，不把它伪装成接纳失败。委派请求没有 Machine 需求时可独立执行；有需求时只记录等待资源，不授予现有原始租约工具，CR3 接入授权后再运行远端写操作。
- [ ] 区分 queued、running、blocked、completed、failed、canceling、canceled。run 完成不自动等于 delegation 完成，必须有结构化报告或可确定的终止失败。等待资源不等于 blocked 报告给 lead，只有新的可行动阻塞、结果或失败生成需接续事件。
- [ ] 为报告定义持久 HTML artifact 与引用契约，复用或补齐当前 artifact 能力，不只依赖 prompt 建议。超过 200 字的报告必须提供已成功保存、可按所属对话权限读取的 HTML 引用，消息正文只留简短结论与入口；生成失败应明确报错和重试，不能伪造可用链接或把长报告退回聊天。worker 的报告留在 sub chat，lead 可引用结果并生成自己的面向 Human 报告，不自动发布 worker 原文。
- [ ] 状态迁移与 event/outbox 写入同一事务，事件唯一键使用 delegation、结果 revision、事件种类。投递重试允许发生，逻辑结果只消费一次。Sprout 新增语义是先尝试附加到当前 lead run 的持久 run input，运行中使用宿主 steer 边界，不能另起 competing run；lead 已结束则创建下一轮。当前 worker 若不支持即时注入，输入保持持久 pending，当前轮安全结算后进入下一轮。此项参考 T3 的 generation/ack 机制，但不是直接复制其 parent-run cohort 行为。
- [ ] 复用现有 run 分配、输入持久化与调度信号，新增确定性的 delegation delivery，不伪造 `wake_evaluation` 或调用 judge。绑定、注入、ack、终止竞争、重启恢复都有明确状态。已注入但无法确认消费的记录进入 attention，不能宣称端到端 exactly-once 或盲目重放副作用。
- [ ] 事件注入只走一条分配路径。lead 的 `agent_run_input.message_id` 不允许为空，直接把 delegation 结果写成 message 会把它带进 Crew 主时间线；因此 delivery 使用 synthetic prompt 入口（复现 `src/server/message-skills.ts:167-176` 的机制并在其 kind 枚举新增 delegation），不新建 Crew message。`src/server/pi-host/run.ts:92-98,232-304,403-419` 的输入选择与 admit 必须认识该 kind。已存在的活跃 lead run 用 `activeRunFor` 复用，结尾由 `carryPendingInputsToNextRound` 带到下一轮，不能再并行开一条 lead run。
- [ ] delivery 落库时快照 `lead_profile_id` 与 `crew_epoch`，admit 前重读当前 lead 并比对，改任后旧投递转 stale 而不是投给旧 instance。worker run 被 `recoverAgentRuns` 标为 interrupted 时必须生成 failed/interrupted delegation event，否则 lead 永远等不到结果；子对话的 Task 不能按 Crew 责任承接，`validateTaskStartInput` 的 `chatId` 校验保持子对话隔离。

- [ ] Lead 本轮结束不取消 child，Human 新消息照常进 lead。新增 Human `stop_crew` 能力，事务将 mode 改为 stopping、递增 `crew_epoch`、停止接纳新委派并处置旧 epoch 的 pending/bound delivery，再请求取消 child 和收尾资源。已注入但未确认的 delivery 留 attention，不能回放。已完成结果和后续迟到终态留作审计与卡片事实，但不再唤醒停止的 Crew。收尾完成才改为 stopped；显式恢复后才能接新工作，普通旧 callback 不得恢复 Crew。
- [ ] 改任 lead 必须先停止并完成活动委派、资源和未决投递的收尾；CR1 的 blocker 始终生效，不提供边执行边热换 lead。单个 delegation 的取消先处置其待投递再停止 worker，完成与取消使用终态 CAS，停止确认前保留 canceling；已完成结果保留，重试显式创建新 attempt，旧结果不能覆盖新 attempt。旧 epoch 投递拒绝但保留可查询收据，不静默丢弃。
- [ ] 普通进度仅写子对话及卡片状态，不生成 lead run。多个同时到达的结果批量附在同一轮，保留独立 event IDs 和审查结论。不将历史 worker 全文复制进 lead context，只送摘要、结果引用与异议。首版单结果摘要上限为 8 KiB UTF-8，每次批量上限为 32 KiB；截断时保留结论、异议与完整结果引用，其余结果留 pending 进入下一批，不能静默丢弃。

**You see.**

- [ ] lead 调用 dispatch 后能结束本轮，worker 仍继续；Human 再发一条消息不被等待锁住。
- [ ] worker 完成后无需 mention，lead 能在当前轮或下一轮读取结果。重复通知不新增卡片或重复 run，普通进度不会唤醒 lead。
- [ ] 同步拒绝与接纳后的失败有不同返回和审计记录，取消、失败、attention 都能查询到真实原因。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 在 `tests/delegation.test.ts` 覆盖接纳原子性、idempotency 冲突、权限、成员、终态 CAS、Task 不被自动完成以及结果 revision。
- [ ] 在 `tests/delegation-delivery.test.ts` 覆盖 active/idle lead、结算竞争、重复事件、断线重试、注入后无 ack、lead epoch 失效、明确停止与普通父 run 结束的区别。另覆盖 lead 模型 session 重建后，Crew 最新要求、未完成委派与资源引用仍可恢复，Human 不必另建 thread；不把模型完整历史无限复制作为恢复。对会丢失或重复投递的旧行为保留 red-to-green 收据。
- [ ] 用真实 worker wire 的回环 fixture 跑 `bash scripts/verify/crew-delegation.sh`，随后受影响测试、`pnpm check` 和 `pnpm typecheck`。时间行为使用可控时钟或完成条件，不用固定 sleep 猜结果。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `magpie/auto/deepseek-v4.1-flash` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 两侧执行 Human 请求并让负责 Agent 结束本轮，head 额外委派一个无 Machine worker。Save `cr2-dispatch.png`. Pass when head 父 run 已终止而 child 正常完成，trunk 原有 DM 回复不退化。
- [ ] Lane 2. 同一请求重复 dispatch 五次并夹入一次参数冲突。Save `cr2-idempotency.png`. Pass when只有一个 child、一张卡片事件，冲突返回确定错误。
- [ ] Lane 3. 派发给非成员、其他 Project Agent 和自身。Save `cr2-deny.png`. Pass when同步拒绝，delegation、子对话和 run 均无残留。
- [ ] Lane 4. lead 空闲时让 worker 完成。Save `cr2-idle-lead.png`. Pass when只启动一个 lead run 并读取一个结果摘要，不用 judge。
- [ ] Lane 5. lead 正运行且 Human 同时发消息时让 worker 完成。Save `cr2-active-lead.png`. Pass when结果和 Human 输入均被持久接纳，无第二个并发 lead run。
- [ ] Lane 6. 在 lead 结算边界提交 child 完成。Save `cr2-settlement-race.png`. Pass when结果在当前或下一轮被确认一次，没有留在已结束 run 的未消费输入。
- [ ] Lane 7. 事件写入后、投递前重启服务并重复发送完成通知。Save `cr2-restart.png`. Pass when恢复后存在一个结果和一次逻辑消费，委派历史连续。
- [ ] Lane 8. 注入 runner context 后丢弃 ack。Save `cr2-unknown-ack.png`. Pass when系统显示 attention 并保留诊断，不自行重复执行外部副作用。
- [ ] Lane 9. 完成与单委派取消同时发生，随后旧 attempt 迟到；另一次显式停止 Crew 并在收尾前申请改任 lead。Save `cr2-cancel-race.png`. Pass when只有一个终态，迟到结果不改新 attempt，canceling 不先冒充 canceled，Crew 停止后无结果回调启动 run，改任须等收尾完成且旧 epoch 结果仍可查。
- [ ] Lane 10. 两位 worker 各发十条进度，再分别提交相反审查结论。Save `cr2-batch-results.png`. Pass when进度未启动 lead run，两个结果及异议都进入 lead context，Task 尚未自动完成。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 两侧测 Human 消息到负责 Agent run queued 的延迟。Head 另测 100 个 delegation 的接纳事务、terminal event 到 input bound 的时延、run 数与 judge 数，区分 runner 实际启动/模型生成时间。
- [ ] Probe. 在 `scripts/verify/crew-delegation.sh` 提供固定 100 次输入和 100 个确定结果的 fixture，两侧交错运行各 5 次；trunk 仅执行其支持的父对话路径并明确记载无 child callback。
- [ ] Baseline. 先将 trunk 原值写 `orchestrate/crew/perf/cr2-baseline.json`，另记录 head 新增工作的绝对值，不给不存在的 trunk delegate 填零耗时。
- [ ] Rule. 同形 Human 输入 p95 超过 trunk 的 1.20 倍且增加超过 50ms 则失败。固定本地 fixture 下接纳 p95 大于 250ms、结果提交到持久输入绑定 p95 大于 1s、100 个事件中丢失任一个或产生重复逻辑消费、任何 judge 调用都失败。模型回复时长只报告，不算数据库投递延迟。

**Review gate.** None. CR2 is not review-gated.

**Merge.**

- [ ] root 在 exact head SHA 审核 outbox 原子性、输入消费与取消竞争，clean verdict 和 Bugbot triage 齐备。
- [ ] 核对同步后的 patch-id，operator 将 CR2 按依赖落入集成栈。保留无 Machine 的可独立验证路径，不能提前宣称租约问题已解决。

## 由 Crew 统一分配与回收执行资源 (CR3)

**Depends on.** CR2。

**Files.**

- [ ] 修改 `src/contracts/lease.ts` 及对应远端执行契约、`src/server/lease.ts`、`src/server/remote-agent-gateway.ts`、`src/server/worker-gateway.ts` 与 `src/domain/lease-wait.ts`。
- [ ] 新建 `src/domain/crew-resource.ts` 和资源授权调度边界，由集成 owner 修改 `src/db/schema.ts`、新增迁移。修改 worker/Pi extension 工具暴露与鉴权，不保留绕过 grant 的 Crew worker 原始 acquire/release 路径。
- [ ] 修订 `tests/lease-contracts.test.ts`、`tests/p8b-lease-wait.test.ts`、`tests/remote-tools.test.ts` 和 lease integration fixtures，新增 `scripts/verify/crew-resource.sh`。更新 `docs/machines-decisions.md`、`docs/crew-core.md` 和 feature-map。

**Build.**

- [ ] 将租约 owner 明确建模为 DM instance 或 Crew coordinator。`machine_lease` 增加 `owner_kind` 与 `holder_crew_chat_id`，保留 DM 的 `holder_instance_id`，用互斥 CHECK 保证 free 时无 owner、held/fencing 时只选一种；Crew 外键按 Project 约束到 parent chat 并在 domain 校验 kind。Crew coordinator 按 Crew 与 `crew_epoch` 持久存在，不以 lead 某一次 run 的存活为所有权边界。lead 的工具只提交意图，runtime 保存租约与授权事实。
- [ ] 区分租约 owner 与执行 holder。`lease_authorization.holder_instance_id` 继续指实际执行 Agent，已有 remote execution 与 run 的复合身份外键不能改成 Crew ID。授权补充 Crew owner 快照，新增 `crew_resource_grant` 关联该授权的 Project/Machine/generation/holder 复合键，唯一约束每代授权的 grant。grant 的 subject 是 delegation 或 lead_run，绑定实际 run/instance、attempt、Machine、目录、操作范围与 `crew_epoch`；这不是已有 remote access grant 的别名。owner、authorization、grant 和执行引用的迁移、CHECK、FK、索引由同一写者生成并在空库及完整执行链路核对。
- [ ] 保留现有 Project/Machine 的一份 live lease 和一个写执行权边界。当前独占语义下每个 Machine 同时最多一个可写 grant，不借此引入同机多 workspace 并行写。Crew 换 worker 时撤销旧执行授权、递增 generation 并签发新授权，owner 仍可为同一个 Crew。DM 保留既有 handoff/escrow/claim 语义；Crew worker 禁止直接 escrow/handoff，转交只走 coordinator 队列。Human force reclaim 处理两种 owner 并统一提升 generation，不保留旧 owner 兼容分支。
- [ ] 运行有 Machine 需求的 child 前，原子预留已有租约或进入持久资源队列。相同 Machine 冲突由 runtime 串行，空闲后分配并唤起相应 worker；等待本身不反复发给 lead。其他 Crew/DM 占用有真实 blocker 时向 lead 发一次去重事件，不让双方 Agent 聊天协调释放。
- [ ] 每次远端写命令重新验证身份、成员、grant、generation、目录和 attempt。防止 worker 利用原始 lease tool、持有的旧 grant、错误子对话或其他执行 ID 绕过授权。目录校验沿用机器侧可执行边界，不仅字符串前缀比较。
- [ ] 增加 lead 的 Crew 内撤权与接管工具。验证 caller 是当前 lead 且 owner 属于本 Crew，不要求旧 worker 配合；持久化接管请求并去重，冻结旧写入、提升 generation、对账并收尾远端 executions，确认后才签发目标授权。目标可以是另一个 worker 或 lead 自己，收尾不改变整个 delegation 的终态，受影响 worker 收到明确的资源撤销事件。接管期间 lead 可结束 run，结果/阻塞经持久事件通知，不轮询。禁止用此工具抢其他 Crew/DM；Human 收回仍为独立权限。
- [ ] 结束委派时先停止接纳新写入，查询/终止或等待已知远端 executions，并确认机器侧事实，然后撤销 grant 和释放或转交资源。父 lead run 结束不回收正在用的资源；child run 结束也不在有活进程时假定安全释放。
- [ ] 断线、服务重启、grant 过期或释放失败进入 recovering/attention。通过持久 execution IDs 对账。未确认停止前不把 Machine 发给下一位写者；Human force reclaim 保留现有确认和 fencing，不能用超时自动偷锁。
- [ ] 补一条无 pending mutation 的 held 租约恢复路径。现有 `forceReclaimLease` 只在 `fencing` 且有匹配收据时可执行（`src/server/lease.ts:963-971`），lead 进程崩溃后可能留下无人能收回的 `held`。CR3 让 coordinator 能基于持久 owner 和 `crew_epoch` 发起对账，仍要求机器侧执行事实确认后才提升 generation，不引入超时自动释放。
- [ ] 机器侧已接纳的旧执行与后续命令分开处理。提升 generation 阻止旧命令，不宣称它自动杀死旧进程。无法证明隔离时明确阻塞该 Machine 并展示恢复途径。
- [ ] lead 自己需要远端执行时也申请同一资源预算，不能同时把唯一写授权交给 worker。不同 Machine 的 worker 可以并行，首版不实现 DAG 调度、跨 Crew 协商或资源预测。

**You see.**

- [ ] 两个 worker 申请同一 Machine 时自动排队，前一个真实收尾后后一个执行；lead 不再发送催促释放租约的对话。
- [ ] worker 完成但远端进程仍活着时显示收尾/恢复，不显示资源已空闲。旧授权和跨委派执行被确定拒绝。
- [ ] lead 本轮结束、服务重启或断线后仍能查到资源归属和执行状态，已有 Human 强制收回能力可用。worker 忘记归还时 lead 能发起接管，不需 worker 同意；离线时显示待确认，交接完成后指定 worker 或 lead 才获得新授权。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 用现有 lease contract 测试加入 coordinator owner、grant fencing、错误目录/attempt/epoch、唯一可写授权和 DM 回归的有意义反例。
- [ ] 用真实 gateway 与远端执行 fixture 验证取消有活进程、断线对账、释放失败、force reclaim、队列顺序和两 Machine 并行，不以 mock 的释放成功替代机器事实。
- [ ] 运行 `bash scripts/verify/crew-resource.sh`、现有 lease/remote tools 受影响专项、`pnpm check` 和 `pnpm typecheck`。保持 worker 工具与 server 权限边界一致。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `magpie/auto/deepseek-v4.1-flash` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 两侧依次执行同一 Machine 上两个远端写任务，head 走两个 delegation。Save `cr3-serialize.png`. Pass when head 两任务自动顺序完成、没有重叠写区间，trunk 的单 Agent fencing 仍通过。
- [ ] Lane 2. 两 worker 同时申请一台 Machine。Save `cr3-queue.png`. Pass when只一份可写 grant，另一个是持久等待且无催租聊天。
- [ ] Lane 3. 两 worker 申请不同 Machine。Save `cr3-parallel.png`. Pass when两执行确有重叠时段，各自 grant 与目录独立。
- [ ] Lane 4. 在另一个 delegation 和目录重用有效 grant。Save `cr3-scope.png`. Pass when gateway 拒绝且机器侧没有新增写操作。
- [ ] Lane 5. generation 变化后旧 worker 发下一条命令。Save `cr3-fencing.png`. Pass when旧命令拒绝，新 owner 正常，旧进程是否存活单独记录。
- [ ] Lane 6. worker 报告完成但保留一个长进程。Save `cr3-live-process.png`. Pass when资源不提前转交，确认进程收尾后下一位才执行。
- [ ] Lane 7. 资源持有期间 lead 正常结束本轮，Human 再发消息。Save `cr3-parent-exit.png`. Pass when grant 连续有效、Human 可对话且没有自动释放抢占。
- [ ] Lane 8. 远端失联并重启服务，随后恢复连接。Save `cr3-reconcile.png`. Pass when恢复前 Machine 阻塞，恢复后按执行事实完成对账，排队任务只启动一次。
- [ ] Lane 9. worker 不配合归还，lead 接管给自己，再转给另一个 worker；另测收尾失败与 Human force reclaim。Save `cr3-release-failure.png`. Pass when不要求旧 worker 同意、旧授权失效、每次确认收尾前无新写授权，重启不丢接管请求，恢复后仅目标获权。
- [ ] Lane 10. DM 占用资源时 Crew 排队，另尝试移除活动 Machine/worker/lead。Save `cr3-cross-owner.png`. Pass when lead 对其他 Crew/DM 的接管请求被拒绝，既有独占边界和删除 blocker 生效，队列无丢失或自动偷锁。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 两侧测 100 次合法远端工具授权的 gateway 时延和同一固定短命令的总时长。Head 另测队列从确认空闲到下一 worker queued 的延迟、重叠写次数和恢复期间新增写数。
- [ ] Probe. `scripts/verify/crew-resource.sh` 使用同一 loopback Machine 与固定短命令，trunk/head 交错各 5 次。显式区分 Agent token 等待、机器命令时长和调度时长。
- [ ] Baseline. 先记录 trunk 授权与执行原值到 `orchestrate/crew/perf/cr3-baseline.json`，队列与 grant 是新增工作，单独记录绝对值。
- [ ] Rule. 同形单 Agent 授权 p95 超过 trunk 的 1.20 倍且增加超过 20ms 则失败。本地固定 fixture 空闲确认到下一 worker queued 的 p95 超过 1s、任何重叠写、旧 generation 命令被接纳、recovering 时新增写操作均失败。真实断线时长不计入空闲调度预算。

**Review gate.** None. CR3 is not review-gated.

**Merge.**

- [ ] root 对 exact head SHA 审核权限绕过、远端活进程及恢复路径，clean verdict 和 Bugbot triage 齐备。
- [ ] operator 按依赖落入集成栈，记录 grants 与机器实际执行的对应收据，不把 SQL 状态探针当成远端完成证据。

## 展示委派卡片与可返回的子对话 (CR4)

**Depends on.** CR3，且 D0 方案已由 Human 选定。

**Files.**

- [ ] 修改 `src/components/chat/**`、`src/routes/**`、chat session/display/query 契约和对应 server functions。新增 delegation 卡片和子对话复用组件，按选定方案归属共享状态。
- [ ] 新建 `scripts/verify/crew-ui.sh` 和委派 UI/导航测试，更新 `docs/web-ui-decisions.md`、`docs/frontend-design.md` 中受影响规则、`docs/feature-map/**` 与最终功能证据。
- [ ] 更新 `docs/development-plan.md` 和本计划执行 trail，分别记录实现、技术通过、Human review 和合并状态，不追改历史验收为当前通过。

**Build.**

- [ ] 按 D0 选定的 B 方案实现右侧巡检栏与委派卡片。宽屏右栏按状态分组，依次显示进行中、需要 Human、已完成；每项一次 delegation 一张卡片，显示 worker、工作摘要、状态与必要 blocker，报告卡片提供 HTML 入口。卡片状态取持久 delegation/event，不从聊天文本猜测，不额外生成系统 chat message。主时间线不流入 worker token、逐条进度或完整报告。
- [ ] 实现右栏的显示与隐藏。宽屏默认显示，Human 可隐藏与恢复；偏好只存本机界面状态，不写服务端、不停止委派、不改变资源授权。隐藏后顶栏入口显示未处理数量，不自动弹出右栏。窄屏不渲染常驻右栏，改为整页工作列表与子对话。lead 与成员管理入口放在栏标题旁，复用 CR1 的同一覆盖层。
- [ ] 按已确认的信息边界拆分 chat message、HTML artifact、run-activity 和 sub chat。主对话消息只承载 Human/lead 基础沟通与必要汇总；lead 的工具调用、资源排队/接管和状态变更归 run-activity，worker 全部内容归对应 sub chat。报告超过 200 字显示持久 HTML 入口，短结论不重复完整报告；artifact 沿用所属对话的访问权限，刷新后仍可打开。
- [ ] 打开卡片进入真实子对话，显示工作输入、过程、结果、审查异议与资源状态。复用既有消息呈现和权限边界，不把子对话当新可自由组队的 Crew。
- [ ] 保存主对话 ID、卡片/消息定位、滚动锚点和返回来源，桌面、手机与浏览器 back 都能回到原位置。深链无返回历史时提供确定的 Crew 链接；刷新后仍能从服务端重建状态。
- [ ] Human 可停止 delegation，lead 通过工具续发输入或重试。明确展示 canceling、failed、attention、waiting_resource 和 completed 的区别，重试创建新 attempt，旧子对话和结果仍可追溯。资源内部 token/generation 不进入普通产品流程。
- [ ] 未加入 Crew 的用户、移除成员和跨 Project 深链都由 server 拒绝。取消权限、读取权限和 lead-only 工具权限使用同一契约，不只隐藏按钮。
- [ ] 联调 Human 主对话、两个 worker、一次审查异议、共享 Machine 排队、lead 结束后恢复、Task 验收和自动化输入。Lead 最终向 Human 说明结果与需要决定的问题，不强制每个进度都总结一遍。
- [ ] 按选定方案检查显示与 token 预算。Lead context 只带结果摘要和引用；卡片随服务端推送更新，不以浏览器或 Agent 定时 polling 作为正确性前提。允许现有连接恢复同步，不能靠不断新建 lead run 刷状态。

**You see.**

- [ ] Human 主对话只需要跟 lead 沟通，委派入口位于所属 run-activity。想看过程时能打开子对话，再回到原主对话位置。超过 200 字的报告打开 HTML 阅读，不在消息里展开长文。
- [ ] 两位 worker 在后台工作时 Human 能继续发消息；普通进度不刷屏，完成或阻塞由 lead 接手。审查不同意见不会被 completed 状态吞掉。
- [ ] 手机、刷新、断线恢复和深链下显示相同的真实委派状态；未获授权的人看不到子对话。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 给导航状态与消息卡片模型添加少量高价值测试，覆盖返回锚点、刷新/深链 fallback、retry attempt、取消中和无权限。右栏隐藏与恢复只改本机偏好，不触发 run、委派或资源写入；隐藏期间到达的 blocker 只累计到恢复入口的未处理数量。覆盖报告正文 200/201 字边界、HTML 保存失败与权限、非 assistant 活动不转成消息、subagent 内容不镜像到主 Crew。不测试组件私有函数或逐项复制文案。
- [ ] 用真实页面与生产 server/worker fixture 跑 `bash scripts/verify/crew-ui.sh`，再运行受影响前端专项、`pnpm check`、`pnpm typecheck`。用 D0 与现有共享组件核对实际形状。
- [ ] 集成末尾由集成 owner 按仓库验证约定执行完整 `pnpm verify`，记录当前 SHA、实际执行/通过/失败/跳过、模型预算和总耗时。没有 prod 部署或真实付费模型覆盖的地方明确列未验证。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `magpie/auto/deepseek-v4.1-flash` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 两侧发 Human 请求、读最终回复并往上滚，head 额外打开委派再返回，再隐藏并恢复右栏。Save `cr4-main-chat.png`. Pass when主对话阅读与输入未退化，消息区只显示 Human/lead 沟通，非 assistant 活动在 run-activity，返回原锚点，右栏隐藏后主对话占满宽度且恢复入口带未处理数量。
- [ ] Lane 2. 两位 worker 各产生十条进度。Save `cr4-noise.png`. Pass when全部过程只在各自子对话，主对话没有多余消息或新增 lead runs。
- [ ] Lane 3. 桌面打开完成卡片，分别查看 200 字与 201 字报告并返回，刷新 HTML 深链。Save `cr4-desktop-return.png`. Pass when 201 字报告生成且打开真实 HTML、200 字允许消息、正文不重复倾倒主对话，权限与引用可用并恢复原位置。
- [ ] Lane 4. 手机视口用同一数据操作、键盘输入、浏览器 back，并确认没有常驻右栏。Save `cr4-mobile-return.png`. Pass when关键动作可见、无横向溢出、输入草稿和返回锚点保留，工作列表以整页进入而不是挤压主对话。
- [ ] Lane 5. 直接打开子对话深链并刷新。Save `cr4-deeplink.png`. Pass when身份校验后重建同一状态，缺少历史时可返回明确的 Crew。
- [ ] Lane 6. lead 运行时 Human 发新问题，worker 同时完成。Save `cr4-concurrent.png`. Pass when问题与结果都被处理，没有重复 lead 回复或阻塞输入框。
- [ ] Lane 7. worker 失败后重试，再收到旧 attempt 迟到结果。Save `cr4-retry.png`. Pass when新旧 attempt 可区分，旧结果不覆盖新卡片状态。
- [ ] Lane 8. 停止有远端活进程的 worker，然后恢复服务连接。Save `cr4-cancel-recovery.png`. Pass when先显示收尾/恢复，机器确认后才显示停止或释放，不出现假空闲。
- [ ] Lane 9. 未授权账号、跨 Project 深链、被移除成员各访问同一卡片。Save `cr4-access.png`. Pass when服务端拒绝且不泄漏正文、工具结果和工作目录。
- [ ] Lane 10. 由 webhook/助理发起工作，两个 worker 给相反审查意见，lead 汇总并留 Task 待验收。Save `cr4-full-flow.png`. Pass when主对话有明确结果与异议，Task 未自动验收，public channel 不再出现，外部飞书 DM 可继续接收 lead 通知。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 两侧测 500 条普通消息的进入聊天与发送后可见时延。Head 另测同一历史中 100 张委派卡片的首屏、打开子对话、返回锚点和终态事件到卡片更新的时延，记录主对话新增消息数与 lead 输入摘要长度。
- [ ] Probe. `scripts/verify/crew-ui.sh` 固定桌面和手机视口、fixture 数据量、网络与 runner 输出；trunk/head 交错各 5 次。保存浏览器 performance 记录与服务端事件时间戳，截图不用于量时。
- [ ] Baseline. 先写 `orchestrate/crew/perf/cr4-baseline.json` 的 trunk 普通聊天原值；head 卡片新增工作分列，不把 trunk 没有的功能解释成零延迟。
- [ ] Rule. 同形普通聊天 p95 超过 trunk 的 1.20 倍且增加超过 100ms 则失败。固定本地 fixture 卡片首屏 p95 超过 2s、打开/返回超过 1s、终态事件到卡片更新超过 1s、返回丢锚点、出现 worker 逐条进度主消息均失败。worker 全文不能进入 lead context，摘要上限在 CR2 契约中固定并按截断提示验收。

**Review gate.** The operator reviews before merge.

- [ ] 将 lane 1、3、4、8、10 的 screenshots 复制到 `orchestrate/crew/media/cr4-review-*.png`，附选定 D0 artifact 和受验 SHA。
- [ ] 录制 30 到 60 秒 video 到 `orchestrate/crew/media/cr4-review.mp4`，完整展示派发、继续与 lead 交谈、子对话、返回、完成接续。
- [ ] 在 chat 向 operator 提交截图与视频，启动仓库 Human review，按反馈修订并记录真实体验结论。停在 merge-ready 等待落地决定。

**Merge.**

- [ ] root 对 exact head SHA 审核权限、页面状态与最终证据，clean verdict、Bugbot triage、完整集成验证及 Human review 齐备。
- [ ] operator 按 CR1、CR2、CR3、CR4 顺序落栈。集成 owner 按仓库规则把验收后的阶段交给 main；部署和共享库处置不包含在此批准中。

## Close the program

- [ ] 每个勾选项都有实际证据；未执行的保持空白，不以安排或后台启动代替完成。
- [ ] 更新开发计划与 feature-map，记录最终主分支 commit、遗留限制、Human 体验结论。保留本计划为执行历史，永久契约集中在领域文档。
- [ ] 关闭审计与本次启动的进程，确认各 owner 无剩余写入。按仓库规则在分支落地或明确放弃且无未提交更改后清理 worktree。
- [ ] 交付最终报告，分开说明功能实现、专项/全量技术验证、Human review、合并与部署状态。本次规划交付只填写规划与检查结果。

## Appendix A. Prototype evidence

本轮证据分三层，不能相互替代。

| 问题                                                           | 已观察证据                                                                                                                                                        | 结论与限制                                                                                                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 当前 Sprout 是否已有跨聊天 child completion                    | `src/domain/agent-run.ts` 的 settle 路径、`src/domain/continuation-delivery.ts:629` 与 `:810`、`src/domain/message-wake.ts:314`                                   | 完成只结算本 chat，agent 消息不进入 contextual judge，不能用现有群聊唤醒推断出跨聊天结果投递                                                                                                           |
| 持久事件去重、结算后重绑定与 grant generation 能否表达目标状态 | 丢弃式脚本 `/tmp/sprout-crew-plan.sdKw2D/probe.py`，输出 `/tmp/sprout-crew-plan.sdKw2D/output.txt`                                                                | 五次插入得到一个 event；active lead 只有一个 run/一份 delivery；pending 输入可重绑定下一 run；generation 8 在 9 撤销后不可授权。只是内存 SQLite 模型，没有证明实际 runner、并发 gateway 或远端进程恢复 |
| 注入后 ack 丢失能否直接声称 exactly-once                       | 同一探针及当前 `settleContinuationRun` 的 `delivery_unknown`                                                                                                      | 探针仅展示不确定态，计划选择 attention 和人工可恢复处置，不保证外部副作用 exactly-once                                                                                                                 |
| T3 委派、结果和卡片的实现位置                                  | T3 `8656cdb3a93883e06fd2786f1cb921571a04da11` 的 `Orchestrator.ts`、`orchestrationV2.ts`、`V2LifecycleRow.tsx` 与 completion delivery 测试，固定引用见 Appendix D | 已核对源码而非只读工具说明。可参考请求去重、父子关联、完成批次、generation 和回执；T3 的 parent 链接不证明返回原滚动锚点，Machine 租约也不是其 outbox effect lease                                     |

T3 的 `delegatedCompletion` cohort 关联 parent run。Sprout 改为 Crew 级持久 delegation，保留 dispatch run 作溯源，结果投给当前有效 lead。T3 在 provider 支持时 steer active turn，否则排队；Sprout 同样必须核对实际 worker 的活动输入边界，不能声称任意 provider 都可立即注入。T3 每个 sibling 仍有独立 task，合并的是唤醒消息，Sprout 同样按 delegation 分卡、按可用 lead run 合并投递。

CR2 直接对照 T3 completion delivery 的测试场景，移植适用的状态机与案例，保留 Sprout 现有 ID 生成、AppResult、数据库事务及 worker 契约。CR4 参考 task card 到 child thread 的路径，原位置返回需自行实现验收。若复制源码或实质代码片段，保留 T3 MIT 的版权与许可声明，并登记来源文件及固定 SHA；不为移植引入第二套 Effect/provider runtime。

探针所在工作分支为 `t3/group-vs-main-agent-delegation`，产品源代码快照为 `2008185bcdbfac40c1754da125ad424addfc4778`。脚本位于 scratch，不是产品实现，也不是集成测试。没有新产品 commit 或原型页面截图，不能填写一个不存在的 prototype SHA。

还未证明的项目包括实际 worker ack 与进程崩溃窗口、Machine 断线恢复、取消与完成并发、浏览器位置恢复和真实模型下的协作质量。它们分别落在 CR2、CR3、CR4 的验收中，不在开工前声称通过。D0 已由 Human 选定 B，并增加了右栏可隐藏的要求；该选择只确定页面形状，真实页面评审仍在执行期进行。

## Appendix B. Alternatives rejected

| 选择                                                        | 不采用的原因                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 继续优化 Group 的 mention 和 LLM 唤醒 prompt                | 没有改变结果传递对聊天文字的依赖，也没有建立 delegation 与资源的持久关系                                                            |
| lead 持续运行并循环查询 worker                              | 消耗 token，阻塞交谈，服务重启后仍需另做恢复                                                                                        |
| 完成时只向主对话发送一条 @lead 消息                         | 暴露内部噪音，丢失提及或重复文本仍会影响路由，取消与结果没有独立状态                                                                |
| 从 T3 复制全部 thread/worktree、模型路由和 provider runtime | Sprout 已有 Project 成员、Machine、Worker 与 Task，整套移植会建立第二个执行系统；采用其持久关联与结果收据的机制，按 Sprout 边界实现 |
| 每位 worker 固定一张长期卡片                                | 多次任务与 attempt 无法清晰对应；每次 delegation 一张卡片更容易取消、审计和返回                                                     |
| 给 Crew lead 新建 profile purpose                           | lead 是同一 Agent 在某个 Crew 的职责；新 purpose 会把聊天角色扩散到 Task 与个人助理身份限制                                         |
| delegation 直接复用 Task 完成状态                           | 执行结束与业务验收不同，报告完成不能替 lead/Human 验收                                                                              |
| run 结束就自动释放 lease                                    | 远端进程可独立存活，SQL 释放不能证明机器安全，可能让两个写者同时工作                                                                |
| 保留 public channel 的 legacy 分支或做旧库双读              | 与仓库极早期无兼容约定冲突；新迁移形成目标结构，旧共享实例另按数据库规则处置                                                        |
| 首版做多层 agent 树、DAG、自动选队长和多机优化              | 当前问题是一次委派的接续、噪音与授权，先验证一个 lead 和一层 worker 的闭环                                                          |

## Appendix C. Risks

| 风险                                                                                 | 负责 PR       | 要观察的证据                                                                                    |
| ------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------- |
| 旧 Group/public channel 分支散布在 assistant、Info Hub、Task、自动化、UI 与迁移 view | CR1           | 全调用方收敛、空库最终 schema、外部 channel 回归，不能凭搜索零命中判断业务已正确                |
| 移除 lead/member 后未结束工作仍拥有权限                                              | CR1、CR2、CR3 | 活动责任阻止移除；停止与撤销后旧 epoch、attempt 和 grant 拒绝                                   |
| 活跃 lead 结算与事件到达竞争，丢结果或起两轮                                         | CR2           | 真实 worker wire 的边界注入、唯一消费键、pending 重新绑定与 attention 收据                      |
| 人类明确停止被 callback 重新启动                                                     | CR2           | Crew 控制版本独立于普通父 run 结束，停止后不派新轮，未处理结果仍可查                            |
| 改 lease owner 破坏 DM、escrow、force reclaim                                        | CR3           | 现有 lease 专项保持，机器事实和 owner/generation 一致，不能只测 Crew happy path                 |
| 断线或远端进程活着时过早释放                                                         | CR3           | 恢复前禁止新增写授权，execution 对账后才能转交                                                  |
| 卡片看起来简洁但主上下文仍注入 worker 全文                                           | CR2、CR4      | context fixture 与输入长度，摘要保留异议、链接完整结果                                          |
| 大量计划验收消耗不必要模型费用                                                       | 全部          | 固定回环 runner 验证协议，真实模型协作只做获准预算内代表性链路，分别报告而不相互冒充            |
| 右栏变成第二聊天或窄屏挤压主对话                                                     | CR4           | 右栏只放委派、资源与待处理项，不镜像消息；窄屏整页化；隐藏偏好不写服务端；lane 1 与 lane 4 验证 |
| Prod 旧数据与早期无兼容策略的处置尚未安排                                            | 交付阶段      | 本轮未动 prod，执行阶段先明确独立验收库与共享库重建方案，未批准不部署或删除                     |

## Appendix D. Links and reading list

- 仓库入口。[项目开发约定](../project-conventions.md)、[开发计划](../development-plan.md)、[开发约定](../p1/conventions.md)、[验证约定](../verification.md)、[Feature map](../feature-map/README.md)。
- CR1。[核心范围](../core-scope.md)、[术语表](../glossary.md)、[通信](../communication-decisions.md)、[Project](../project-profiles-decisions.md)、[Tasks](../tasks-decisions.md)、[个人助理契约](../assistant-core.md)、[Webhook 契约](../webhook-core.md)、[Cron 契约](../cron-core.md)。执行前读 `how/SKILL.md` 核对所有入口。
- CR2、CR3。[Machines](../machines-decisions.md) 以及 run、continuation、remote execution 的实现与专项。执行前读 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/interrogate/SKILL.md` 对恢复和权限提出反例，再按 `how/SKILL.md` 核对源码，不把本轮未验证项视作既定事实。
- D0、CR4。[前端设计](../frontend-design.md)、[前端约定](../frontend-conventions.md)、[Web UI](../web-ui-decisions.md)、[Human review](../human-review.md)。页面方案用当前 GUI artifact 工具；真实应用评审使用环境自带 browser/preview 与仓库 human-review skill。
- 执行技能根目录为 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/`，使用 `poteto-mode/playbooks/autopilot-stack.md`、`poteto-mode/playbooks/opening-a-pr.md`、`poteto-mode/playbooks/shipping.md`、`swarm/SKILL.md`、`how/SKILL.md`、`show-me-your-work/SKILL.md`、`technical-writing/SKILL.md`、`unslop/SKILL.md`、`comment-sicko/SKILL.md`。模型根配置为 `/Users/snake/.pstack/models.md`。实际控制工具遵守宿主和工作区指令。
- 测试决策读 `/Users/snake/.agents/skills/unit-testing-best-practice/SKILL.md`，优先真实边界与高价值失败路径，不为可逆文档改动造产品测试。
- 本轮决策和探针收据见 [Crew planning decision trail](crew-development-trail.md)。计划结构检查命令为 `node /Users/snake/workspace/pi-stuff/pi-pstack/skills/poteto-mode/scripts/check-plan.mjs docs/plans/crew-development-plan.md`。
- T3 固定源码快照为 `8656cdb3a93883e06fd2786f1cb921571a04da11`，来自 `https://github.com/pingdotgg/t3code`，许可为 MIT。临时 clone 只读，未反编译安装包。直接参考下列实现和测试。
  - [委派接纳与 commandId 去重](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/apps/server/src/orchestration-v2/Orchestrator.ts#L9178)，[独立 child lineage](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/packages/provider-core/src/server/subagentProjection.ts#L52)。
  - [完成投递状态与 cohort](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/packages/contracts/src/orchestrationV2.ts#L652)，[结果批次的计划与去重](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/apps/server/src/orchestration-v2/Orchestrator.ts#L13840)，[接受回执](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/apps/server/src/orchestration-v2/Orchestrator.ts#L2003)。
  - [完成投递的重启、重复、取消测试](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts#L330)，[停止传播测试](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/apps/server/src/orchestration-v2/ThreadStop.test.ts#L134)。
  - [卡片进入子线程](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/apps/web/src/components/chat/V2LifecycleRow.tsx#L396)，[子线程 parent 链接](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/apps/web/src/components/ChatView.tsx#L906)。
  - [Effect outbox 的 owner fencing](https://github.com/pingdotgg/t3code/blob/8656cdb3a93883e06fd2786f1cb921571a04da11/apps/server/src/orchestration-v2/EffectOutbox.ts#L613)，此处只保护后台 effect 的领取与回执，不能照搬成 Machine 的进程隔离保证。
- 补充参考。[DeepSeek Superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 assignment 与克制主对话输出，[Firstmate](https://github.com/kunchenguid/firstmate) 的单一对接者与持久 crew。二者不作为 Sprout lease 正确性的证明。
