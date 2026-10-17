# Sprout Mio 开发执行计划

按本文推进已确认的一期协作闭环。产品范围见 [core-scope.md](core-scope.md)，技术选择与原因见 [architecture-direction.md](architecture-direction.md)。

P0 已用最小实验验证技术栈与高风险协议并收敛基础契约，结论见 [p0/summary.md](p0/summary.md)。P1 已建立可运行的工程骨架与 Project 样例，结论见 [p1/summary.md](p1/summary.md)。P2 及以后尚未开始，复选框只在实际证据存在后勾选。本计划定义工程顺序，不给产品增加固定开发 workflow。

## 按阶段推进并保留证据

1. 从 P0 开始，先处理会影响后续实现的技术不确定性。
2. 将当前阶段拆成能独立验证的小任务。每个任务记录依赖、数据形状、允许修改的模块、验收行为和证据位置。
3. 对非平凡的代码边界先比较设计，再实施。将源码复用判断与旧代码参考 commit 写入任务记录。
4. 完成一个任务后运行针对性测试和真实操作验证，再开始依赖它的任务。模拟器可用于故障注入，但不能替代真实 Pi、Worker 或浏览器验收。
5. 在本文件记录完成项对应的 commit、测试输出和运行证据。UI 变更保留截图或操作录像；协议与恢复变更保留可重跑的实验及结构化记录。
6. 基础架构更改同步更新架构说明。影响产品行为或分期的更改同步更新对应决策文档，不能藏在实现里。

不按预设日历承诺完成时间。每个阶段通过出口条件后，再细化下一阶段的任务与工作量。具体测试命令在 P1 固定，此前不把不存在的 npm script 写成已可执行。

## 按依赖安排开发

| 阶段 | 交付 | 依赖 | 状态 |
| --- | --- | --- | --- |
| P0 | 验证技术栈与高风险协议，收敛基础契约 | 无 | 已完成（结论见 [p0/summary.md](p0/summary.md)） |
| P1 | 建立工程骨架与标准功能样例 | P0 | 已完成（结论见 [p1/summary.md](p1/summary.md)） |
| P2 | 建立 Project、profile、Conversation 和分身 | P1 | 已完成（结论见 [p2/summary.md](p2/summary.md)） |
| P3 | 跑通真实 Pi 对话与宿主仓库分析 | P2 | 待开始 |
| P4 | 跑通 macOS Machine 与租约执行闭环 | P2；整体验收依赖 P3 | 待开始 |
| P5 | 完成 Group、Public Channel 与 Tasks | P3 | 待开始 |
| P6 | 完成小脑接续、Info Hub 与成员治理 | P4、P5 | 待开始 |
| P7 | 完成手机、PWA、恢复与一期整体验收 | P6 | 待开始 |
| R1 | 验证项目及软件 MCP 接入 | P4 的协议与授权稳定后 | 独立研究任务，分期待确认 |
| P8 | 实施二期能力 | P7 | 后续细化 |

默认按 P0 至 P7 顺序推进。P4 与 P5 在共同契约稳定后可以由不同实现者并行。Info Hub、响应式 UI 和错误呈现随对象逐步接入，P6 与 P7 负责补齐和整体验收，不是首次开始这些工作。

## P0 验证关键选择并确定基础契约

目标是避免在框架打包、Pi 接入和恢复协议尚未成立时，铺开大量页面与 CRUD。

- [x] 固定候选 Node、Pi 与六项技术栈版本，记录安装和生产构建结果。证据 [p0/stack-versions.md](p0/stack-versions.md)，重跑 `experiments/stack-app/scripts/verify.sh`。
- [x] 验证 Start SPA 深链刷新、Better Auth session、Drizzle 事务与 migration，以及 shadcn 的 Base UI 组件。证据 [p0/spa-auth-db.md](p0/spa-auth-db.md)，32 项检查全过，重跑 `experiments/spa-auth-db/verify.sh`。
- [x] 验证常驻 Effect runtime 的初始化、HMR、长连接、退出顺序及生产启动。用证据决定是否拆后台进程。证据 [p0/runtime-host.md](p0/runtime-host.md)，结论是共进程成立并附两个前提。dev 模式信号关闭与 WebSocket 未验证。
- [x] 用真实 Pi 验证配置和认证继承、会话恢复、运行中投递与停止。确定 CLI 或 SDK 接入方式及需要显式加载的扩展。证据 [p0/pi-integration.md](p0/pi-integration.md)，结论是 SDK 优先并跑在宿主管理的子进程里。SDK 内置 codemode、tool_search 与 MCP 的加载未验证。
- [x] 用最小 Worker 实验检查重复提交、响应丢失、授权代次切换和旧请求拒绝。先使用受控命令，不把原型当作生产实现。证据 [p0/worker-lease.md](p0/worker-lease.md)，4 个 probe 全过，原型不是生产实现。
- [x] 明确宿主断线、宿主重启、Worker 重启、Machine 重启四种情况下的执行与结果恢复承诺。证据 [p0/recovery-promises.md](p0/recovery-promises.md)，12 格矩阵全过。故障在同机用真实进程 kill 与重连模拟，真实跨机未验证。
- [x] 固定身份、事务和授权契约。至少覆盖分身唯一性、Project × Machine 租约互斥、run 串行、执行 ID 和唤醒去重。证据 [p0/contracts.md](p0/contracts.md)，25 项检查全过。
- [x] 保存实验脚本、版本与结论。将未证实项明确标为未验证，更新架构说明的对应选择。证据 [p0/summary.md](p0/summary.md) 与全部 `docs/p0/` 结论文档，架构更新见 [architecture-direction.md](architecture-direction.md)。

出口条件是有可重复的最小实验，能够解释每项选择及失败行为。原型没有提供的能力不得标记为支持。P0 不实现完整任务系统或完整 MCP gateway。

## P1 建立可重复的工程骨架

- [x] 建立 Start 应用、Worker 入口、Pi extension 和必要共享契约。先在模块内组织领域，不预建大量空 package。证据 [skeleton.md 的验证命令与证据](p1/skeleton.md#验证命令与证据)，重跑 `bash scripts/verify/a-base.sh`。Worker 连接与 Pi 会话仍分别未实现，属于 P4 与 P3。
- [x] 固定 Vite+ 检查、测试、构建入口与 CI。验证全新安装可以生产构建并启动。证据 [tooling.md 的干净安装与生产启动](p1/tooling.md#干净安装与生产启动) 与 [CI 工作流](p1/tooling.md#ci-工作流)，重跑 `bash scripts/verify/b-tooling.sh`。干净指工作目录，冷 pnpm store 未验证。
- [x] 建立数据库迁移、配置解析、Human 登录与最小初始化流程。证据 [data-auth.md 的验证证据](p1/data-auth.md#验证证据)，重跑 `bash scripts/verify/c-data-auth.sh`。生产入口的配置拒绝由 d 验证。
- [x] 实现 runtime 的启动、恢复、ready 和关闭入口。将配置、HTTP 请求与后台生命周期分开。证据 [runtime.md 的验证命令与证据](p1/runtime.md#验证命令与证据)，重跑 `bash scripts/verify/d-runtime.sh`。恢复只覆盖 runtime boot，dev 信号优雅关闭未验证。
- [x] 实现最小 Project 创建与查询样例，覆盖页面、server function、业务服务、事务和错误显示。证据 [feature-sample.md 的真实命令与输出摘要](p1/feature-sample.md#真实命令与输出摘要) 与 [事务与错误路径证据](p1/feature-sample.md#事务与错误路径证据)，重跑 `bash scripts/verify/e-project.sh`。
- [x] 为后续 Agent 提供一个实际可运行的功能模板和验收样例。固定命名、目录、错误与输入校验规则。证据 [conventions.md 的新增功能的步骤](p1/conventions.md#新增功能的步骤)，重跑 `bash scripts/verify.sh`，实际样例见 [feature-sample.md](p1/feature-sample.md#真实命令与输出摘要)。
- [x] 建立基础诊断记录，关联 request、Project、分身、run 和 execution 等实际存在的 ID。证据 [runtime.md 的验证命令与证据](p1/runtime.md#验证命令与证据)、[Project 的真实命令与输出摘要](p1/feature-sample.md#真实命令与输出摘要) 与 [Project 的事务与错误路径证据](p1/feature-sample.md#事务与错误路径证据)，重跑 `bash scripts/verify/d-runtime.sh` 与 `bash scripts/verify/e-project.sh`。当前真实关联为 requestId 与 projectId；尚无真实分身、run、execution，其关联留空且未验证。

出口条件是用户可以登录、创建并重新打开 Project；开发者可以从干净环境运行检查、构建与最小真实操作。后续阶段以这个功能样例为模板。

## P2 建立身份、成员与持久对话

- [x] 完成 Project 配置、Agent profile 和 Project Agent 成员关系。证据 [project-agents.md 的验证记录](p2/project-agents.md#验证记录)，重跑 `bash scripts/verify/h-project-agents.sh`。
- [x] 建立 Conversation 与分身持久身份，强制 profile × Conversation 唯一。证据 [分身身份与唯一性](p2/conversation-dm.md#分身身份与唯一性的实现位置) 与 [SQLite 唯一约束反证](p2/acceptance.md#p2-六项对应关系)，重跑 `bash scripts/verify/i-conversation.sh` 与 `bash scripts/verify/k-acceptance.sh`。
- [x] 建立 DM 和持久消息，配置与人设修改保留原有身份和历史。证据 [重启持久性验收](p2/conversation-dm.md#重启持久性验收) 与 [出口条件与字面量](p2/acceptance.md#出口条件与字面量)，重跑 `bash scripts/verify/i-conversation.sh` 与 `bash scripts/verify/k-acceptance.sh`。
- [x] 建立各详情页的稳定 URL，刷新及前进后退保持目标和 Project 上下文。证据 [七个页面的导航矩阵](p2/acceptance.md#七个页面的导航矩阵)，重跑 `bash scripts/verify/k-acceptance.sh`。
- [x] 建立 Project 授权入口，Agent 查询、错误和快照均不得暴露其他 Project 的 Sprout 数据。证据 [授权入口](p2/identity-data.md#project-授权与配置) 与 [隔离反证及正常对照](p2/acceptance.md#隔离反证与正常对照)，重跑 `bash scripts/verify/g-identity-data.sh` 与 `bash scripts/verify/k-acceptance.sh`。P2 只验收已有查询与错误载荷，尚无运行时快照，其隔离未验证。
- [x] 提供当前已有对象的 Info Hub 查询和基础页面呈现。后续对象接入同一模块。证据 [Info Hub 验证记录](p2/info-hub.md#验证记录) 与 [未实现状态](p2/acceptance.md#未实现状态截图与限制)，重跑 `bash scripts/verify/j-info-hub.sh` 与 `bash scripts/verify/k-acceptance.sh`。run 与 Machine 视角显式标注未实现。

出口条件是重启后同一对话仍对应同一分身，消息与配置保留；两个 Project 的上下文与查询边界可验证。此阶段不将模拟回复当作真实 Pi 接入完成。

## P3 跑通真实 Pi 对话和仓库入口

- [ ] 将持久分身映射到 Pi session，记录每轮配置快照和 run 状态。
- [ ] 保留宿主 Pi 工具、配置与认证，加载 Sprout extension。
- [ ] 实现同分身串行、新消息进入当前轮、停止及明确的错误结果。
- [ ] 实现宿主仓库入口，支持复用已有副本与按需获取数据，不仅支持手动绑定目录。
- [ ] 记录分析依据的来源、commit 或 ref 与获取时点。处理并发更新、Git 认证失败和磁盘占用策略。
- [ ] 将 Agent status、活动 runs 和错误接入 Info Hub，提供轮初必要上下文。
- [ ] 验证 profile 更新仅影响下一轮，宿主重启后不虚构旧 run 已成功完成。

出口条件是 Human 不创建 Task、不申请 Machine 租约，也能在 DM 分析已推送的仓库内容。后续轮次保持身份和会话历史，当前轮可接收新消息。

## P4 跑通 macOS Machine 与租约执行

按下列单元依次交付，每个单元有自己的真实 Worker 验证。

### P4a 建立 Worker 连接和 Project 绑定

- [ ] 实现 macOS Worker 安装与启动、主动认证连接、重连和连接代次。
- [ ] 将 Machine 加入 Project，提供说明、连接状态与工作目录绑定。
- [ ] 探测并报告 shell 路径、类型、版本及执行能力。
- [ ] 验证旧连接不能覆盖新连接的事实，断线不显示为空闲或已释放。

### P4b 实现分身持有与远端操作

- [ ] 实现申请与释放，数据库约束保证 Project × Machine 内互斥。
- [ ] 以分身为 holder，验证 run 结束后租约保留，一个分身可以持有多台 Machine。
- [ ] 实现 shell、文件与进程操作，每次执行核验当前参与权和授权代次。
- [ ] 保留宿主工具的原有行为，远端工具明确指定 Machine。
- [ ] 验证不同 Projects 在同一物理 Machine 的租约独立，不暴露其他 Project 的工作信息。

### P4c 实现长命令与不确定结果

- [ ] 实现稳定请求 ID、执行 ID、日志游标、状态、退出结果和显式取消。
- [ ] 验证响应丢失后的重复提交不会重复启动已确认的同一命令。
- [ ] 验证 run 结束及宿主连接中断不终止命令，当前持有者重连后能继续查询。
- [ ] 按 P0 确定的恢复范围验证宿主、Worker 和 Machine 重启。无法确认时展示未知，不重跑未知命令。
- [ ] 固定日志和结果保留规则。日志达到限制时明确告知，不静默丢弃后声称完整。

### P4d 实现交接、收回与 Machine 移除

- [ ] 实现向指定分身原子交接，占用不经过释放空窗。
- [ ] 验证旧请求、重复交接、响应丢失和离线重连，交接后旧 holder 不再有操作权。
- [ ] 实现 Human 强制收回与带租约移除 Machine 的警告确认。无法确认撤权时保留待处理占用。
- [ ] 验证新 holder 可以查询和管理原有执行，租约动作不自动清理进程或文件。
- [ ] 向受影响的活动 runs 投递资源撤销通知，不一律停止 run。
- [ ] 将 Machine、租约和执行相关事实接入已有页面与 Info Hub。

出口条件是 Human 可以看到 Agent 使用真实 macOS Machine 完成一次执行、跨 run 接续、交接和收回。并发与故障场景必须有可重跑证据。

## P5 完成多人协作与 Task 记录

- [ ] 实现 Group 成员与 owner，Public Channel 成员随 Project 自动同步。
- [ ] 实现 Group 消息、多 Agent 唤醒和成员回报，保持同分身串行。
- [ ] 实现 Project 所有、Conversation 承接的 Task 四态，不增加执行或环境状态机。
- [ ] 实现可选立即开始，DM 唤醒唯一分身，Group 唤醒负责人。
- [ ] 实现 checklist、施工记录、末条施工记录中的完成结果、人类纠正与重开。
- [ ] 验证分配不等于启动，run 结束不代表 Task 完成，Task 完成不代表释放租约。
- [ ] 将成员、owner、Tasks 与活动 runs 的关联接入 Info Hub。

出口条件是 Human 能在 Group 分配一个 Task，由 owner 组织成员回报并完成记录，也能在 DM 完成相同 Task 生命周期。

## P6 完成自动接续、Info Hub 与成员治理

- [ ] 用中文协作样本验证聊天唤醒判定，确定 Jev 的采用方式和失败回退。
- [ ] 对有 assigned Task 的 Conversation 周期检查小脑；没有 assigned Task 时停止检查。
- [ ] 实现持久唤醒去重、运行中合并、重启恢复与失败退避。人类暂停和停止优先，自动检查不能立即重新启动已暂停的工作。
- [ ] 完成 Info Hub 的 Project、Conversation、Agent 与 Machine 全部一期视角。
- [ ] 完成轮初快照、运行中合并的简短变更提示与 Agent 主动查询。普通变化不单独唤醒空闲分身。
- [ ] 验证基本信息可见性不授予聊天正文访问或对象操作权，Agent status 仅汇总当前 Project。
- [ ] 实现 Agent 正常移除的前置检查，阻止仍有活动 runs、租约、owner 职责或 DM assigned Tasks 的移除。
- [ ] 实现正常移除后的 Group 退出与 DM 归档，以及重新加入后的 Public Channel 和 DM 恢复。旧消息与待处理唤醒不能恢复已撤销的参与权。

出口条件是协作可自动接续，同时人类控制可靠；Info Hub 展示与源对象一致的事实，不自行改变生命周期。

## P7 验收完整一期与客户端体验

- [ ] 完成 Projects、Agents、Machines、Management 导航与桌面、手机响应式操作。
- [ ] 验证所有目标详情的深链、刷新、前进后退与登录后的目标恢复。
- [ ] 完成可安装在线 PWA。明确断线、旧数据、处理中、成功、失败与未知状态，不默认离线排队执行操作。
- [ ] 在浏览器中跑完 core-scope 的七步开发闭环，使用真实 Pi 与 macOS Worker。
- [ ] 验证宿主仓库分析与 Machine 现场分析分别说明来源。
- [ ] 覆盖并发租约、失联、重复请求、停止、重连、成员变化及授权失效，不用正常路径代替故障验收。
- [ ] 验证数据库迁移、备份恢复、服务升级重启及基础日志诊断。
- [ ] 检查必要的响应时间、日志读取与事件积压。需要量化门槛时先记录方法和基线，不把模型响应时间混入本地服务开销。
- [ ] 对照下方范围表确认一期无遗漏，记录已知限制和二期入口。

出口条件是一期产品要求有对应的真实行为证据，UI 不将尚未支持或无法确认的能力显示为成功。

## R1 独立验证项目与软件 MCP

本任务保留上一轮讨论的 MCP 接入方向。当前不把项目 MCP、Unity MCP、Blender MCP 自动升级为一期验收前置，也不将接入它们等同于引入其他 harness。

- [ ] 在 P4 的身份与授权契约稳定后，验证官方 MCP SDK 连接 Machine 上的 stdio 和本机 HTTP server。
- [ ] 用 Sprout extension 注册受范围约束的宿主 MCP 入口，复用已锁定 Pi 版本的原生客户端。
- [ ] 验证两个 Unity 项目同时打开时始终操作指定实例，断线或目标消失不改投其他 Editor。
- [ ] 验证 Blender 连接目标实例，并将图片与 structuredContent 完整送达 Pi。
- [ ] 验证 resources、工具目录变化、session 重建、超时未知与旧租约请求拒绝。
- [ ] 区分 Worker 管理的 server 进程与已运行的软件服务，不把断开 Pi session 等同于关闭软件或撤销所有长期工作。
- [ ] 根据证据记录采用 SDK、proxy 或薄 bridge 的具体组合，并明确纳入哪个交付阶段。纳入一期时同步修改 core-scope 与验收表。

## P8 在一期完成后展开二期

- [ ] 补齐 Windows Worker，验证真实 Windows 上的 shell、路径、编码、进程树、用户 session 与长命令恢复。
- [ ] 实现 Group 租约挂靠、领取与超时提醒，保持占用和操作权分别表达。
- [ ] 实现有限的申请遇阻自动协调、owner 升级和 Human 接续，不自动抢占。
- [ ] 实现 Agent 强制移除与自动善后，确认撤权后再释放占用。

二期每项开始前重新拆分设计与验证任务。Linux 验收、其他 harness、图形桌面工具与成本统计不因上述工作自动纳入二期。

## 用范围表检查一期覆盖

| core-scope 能力 | 首次实现 | 最终验收 |
| --- | --- | --- |
| 框架约束、Human 登录与 SPA 路由 | P0、P1 | P7 |
| Project 配置、成员和信息边界 | P2 | P6、P7 |
| 持久分身、profile 下一轮生效、Pi 继承 | P2、P3 | P7 |
| 宿主仓库按需访问、来源和版本 | P3 | P7 |
| DM、Group、Public Channel、运行中消息 | P2、P3、P5 | P6、P7 |
| macOS Worker、shell、文件、进程 | P4 | P7 |
| 长命令、日志结果、去重与恢复查询 | P4 | P7 |
| 跨 run 持租、直接交接、强制收回 | P4 | P7 |
| Machine 移除及资源撤销通知 | P4 | P7 |
| Task 四态、checklist、施工记录与重开 | P5 | P7 |
| 小脑周期、自动接续、人类控制 | P6 | P7 |
| Info Hub 多视角、快照和变更提示 | P2 起逐步接入 | P6、P7 |
| Agent 移除前置检查、DM 归档和重新加入 | P6 | P7 |
| 手机、在线 PWA、断线与旧数据 | 各阶段随页面接入 | P7 |

## 分派任务并管理完成记录

把页面和常规业务实现交给沿用 P1 模板的 Agent。将协议、恢复、授权竞态和跨平台进程设计安排给能够处理这些问题的实现者，并提供独立验证。

并行任务明确模块边界。数据库 schema 与公共契约由一个任务维护，依赖方等待其稳定版本。写代码的并行 Agent 使用独立 worktree；调查与评审只读，不在同一 checkout 并发修改文件。

每次任务交接至少包含以下内容。

- 当前阶段、目标行为、依赖版本与允许修改的模块。
- 已确定的数据形状、授权边界及禁止改变的产品规则。
- 需要参考的旧源码及实际采用的部分。
- 可执行的验收步骤、完成证据和未验证项。

当前完成记录如下。

| 记录 | 已完成内容 | 验证范围 |
| --- | --- | --- |
| 计划基线 | 技术栈方向、源码与官方资料调查、P0 至 P8 和 R1 顺序 | 文档范围及链接检查，不是功能或技术兼容性验收 |
| P0 | 7 个实验 unit 与结论文档：版本与构建、Start SPA 与 Better Auth 与 Drizzle 与 shadcn、常驻 runtime 共进程、真实 Pi 接入、Worker 协议语义、四种故障恢复承诺、身份事务授权契约。实验提交范围 `21063f6..b1ba085`，本记录随 P0 收尾提交写入 | 本机安装、构建与运行验证（macOS arm64，Node v26.11.1，真实 SQLite 文件）；真实 Pi 1.3.0 验证；本地协议实验（真实进程 kill 与重连、真实并发 SQLite 连接）。未覆盖：真实跨机与网络分区、真实 macOS Worker 端到端，留到 P4 |
| P1 | 工程骨架、Worker 与 Pi extension 入口、检查测试构建与 CI、SQLite 迁移与 Human 登录、runtime 生命周期与基础诊断、Project 创建查询与功能模板。a～e 的实现与合入范围 `7e4f039..c3af8ad`，本记录随 P1 收尾提交写入。逐项证据见 [p1/summary.md](p1/summary.md) | macOS arm64、Node v26.11.1、pnpm 10.33.0 下的干净工作目录安装、生产构建与真实进程启动、真实 SQLite 迁移与事务、真实 Pi 状态工具、真实 Chromium 登录和 Project 创建与重新打开；GitHub Actions ubuntu x64 的检查测试构建迁移与生产 smoke。收尾验证文档证据与链接、`pnpm check`。未覆盖：冷 pnpm store、dev 信号优雅关闭、多进程与恢复中途崩溃、完整 Pi 会话业务；真实跨机与真实 macOS Worker 端到端仍属 P4。完整边界见 summary |
| P2 | 已完成 Project 配置、全局 Agent profile 与成员、持久 DM 与分身、消息、创建者授权、稳定 URL 和 Info Hub 两个已有对象视角。实现基线 `28d4fb2`，a～e 的实现与合入范围 `28d4fb2..d8f4e2b`。PR #10 head `cfa5d4d` merge `6836b06`，PR #11 head `fdad1ca` merge `53c9cb7`，PR #12 head `bf7ffa4` merge `2b814eb`，PR #13 head `dc11b8a` merge `da4aebb`，PR #14 head `872e62d` merge `d8f4e2b`。逐项证据见 [p2/summary.md](p2/summary.md) | macOS arm64、Node v26.11.1、pnpm 10.33.0，真实 SQLite、真实 Chromium 七个 URL 的直接进入、刷新、前进后退，真实生产进程 SIGTERM 与重启后身份、消息、三项配置及人设字面量相等，两用户隔离覆盖六页与 17 个 RPC 且 B 正常对照可用。main `d8f4e2b` 的 [CI run 39062616946](https://github.com/tinysnake/sprout-mio/actions/runs/39062616946) completed、success，覆盖检查测试构建迁移与生产 smoke，不含 Chromium。收尾复跑 `bash scripts/verify/l-docs.sh`、`bash scripts/verify.sh` 与 `pnpm check`。真实 Pi、run、宿主仓库、Machine、租约、Task、Group、Public Channel、自动接续、手机、PWA 与并发等未验证项见 summary |

当前下一任务是 P3，跑通真实 Pi 对话与宿主仓库分析。P2 未验证项见 [p2/summary.md](p2/summary.md#未验证项汇总)。P0 未验证的真实跨机与真实 macOS Worker 端到端仍留到 P4。
