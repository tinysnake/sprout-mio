# Sprout 核心范围与分期

Sprout Mio 是 Sprout 的简化重制版，大量代码和设计可以直接参考原项目。Sprout 的 GitHub 仓库是 [tinysnake/sprout](https://github.com/tinysnake/sprout)。

本文汇总已确认的产品决定，并结合原 Sprout 源码和未完成 issues 给出实现取舍建议。本文不是实现完成记录，也不自动修改原仓库、roadmap 或 issue 状态。

技术栈与运行边界见 [基础架构方向](architecture-direction.md)。开发编排必须从 [开发总计划](development-plan.md)进入，功能阶段、依赖与功能验收条件见 [功能开发专项计划](development-plan-functional.md)。这些文档不改变本文的产品分期。

## 分期约定

- **一期（第一版）**：实现并验证核心协作闭环，是当前开发和验收范围。
- **二期**：明确要做的能力；本轮从第一版后移，不作为一期前置。
- **未来方向**：保留想法和建设意图，何时做尚不确定，不自动承诺在二期实现。

分期只改变交付顺序，不取消产品设想。相关决策文档中的二期或未来条款，不能作为一期验收要求。

| 本轮分期事项 | 一期 | 二期 |
| --- | --- | --- |
| 租约交接与资源协调 | 申请、跨 run 持有、释放、直接原子交接、人类强制收回；遇到占用由 Agent owner 或 Human 通过对话协调 | Group / Group + Agent 挂靠与领取、挂靠超时提醒、申请遇阻自动协调、挂靠超时后的 owner 协调与 Human 升级 |
| Agent 成员移除 | 有活动 runs、持有租约、承担 owner 职责或其 DM 尚有 assigned Tasks 时，先手动停止、释放或交接、变更 owner、重新分配任务，再移除 | 强制移除及自动善后：中止 runs、撤权、默认责任接续、DM 任务退回与租约释放 |
| Worker 操作系统 | 支持并验收 macOS Worker | 补齐 Windows Worker，最终支持 macOS 与 Windows |

Info Hub 的多视角聚合、快照与变更提示，以及宿主侧仓库入口保持一期范围，不采用进一步裁剪。

## 一期目标

人类在 Project 内与有稳定人设的 Agent 分身沟通。分身可以在宿主侧访问项目仓库，直接回答日常仓库问题；需要 Machine 现场时，通过 Pi extension 取得远端 Machine 的租约并操作。Conversation 承接 Task，Group owner 组织开发，Task 保存目标、归属、checklist 与施工记录，完成结果就是最后一条施工记录。Info Hub 为人类和 Agents 聚合基本信息及其关联。人类可以随时干预运行或收回租约。

## Human 界面与客户端方向

- 参考原 Sprout 的生产 Web，按照 Mio 已确认的需求重构，不能直接照抄旧界面与业务规则。支持桌面和手机，采用 single page app（SPA）；当前客户端形态构思到 PWA。
- 一级导航为 Projects、Agents、Machines、Management，不设置 Feed。当前可能需要二级功能导航的只有 Projects 和 Management；Projects 页面变化较大，其余页面基本结构保留，省去不适用的信息并调整必要行为。
- 各功能、对象详情和需要直接进入的操作界面提供 link；给定 URL 即可定位到指定 Project、该项目内的 DM 或其他目标，不依赖此前选择项目。刷新和浏览器前进、后退保持目标与上下文。
- Info Hub 是信息聚合与访问功能模块，为 Human 界面和 Agents 提供信息；任何页面或组件需要展示相关信息时，都可以按需从 Info Hub 获取。展示位置包括 Project 页面、Conversation 侧边栏、Task 详情、Agent 简单信息与详细信息等，不作为独立一级页面，也不以这些展示位置限定模块职责。
- PWA 作为可安装的在线协作客户端，明确展示断线、旧数据与操作结果，重连后同步事实，不默认离线排队执行操作；系统推送另行评估。UX 细节在实际使用中逐步完善。

详细决定见 [Web UI 与 PWA](web-ui-decisions.md)。

## 统一术语：Conversation（对话）

Conversation 是 Project 内持久的沟通与协作单元，统一涵盖 DM、Group 和 Public Channel。“聊天窗口”是 Conversation 的界面呈现。

- **DM**：只有一位 Agent 的直接对话，可以承接 Task；由唯一 Agent 分身负责推进，选择“立即开始”时唤醒它。机器信息展示该分身持有的 Machines 和租约状态。
- **Group**：有成员和 owner 的协作对话，可以承接 Task；一期通过指定分身直接交接租约，二期支持租约挂靠与领取。
- **Public Channel**：成员始终等于当前 Project 的 Agent 成员集合的特殊 Group。成员跟随 Project，不能单独调整；其余规则与 Group 相同，包括由人类指定和变更 owner、Task 推进及对应阶段的租约能力。
- **Agent 分身**：由 Agent profile × Conversation 唯一确定，是持续的工作个体。Info Hub 分别展示 Agent status 和按 Conversation 关联的活动 agent-runs；没有活动 run 的对话不显示运行条目。
- **Agent run**：分身的一轮执行。同一分身可经历多次 run，身份和租约可以跨 run 保留。结束前软性要求判断租约应保留、直接交接还是释放；不强制调用租约工具才能结束，也不因 run 结束自动释放。二期增加挂靠选项。

## Project 隔离、成员与 Machine 归属

- Project 是 Sprout 管理的 Agent 信息、上下文与操作授权的硬边界。Sprout 只向 Agent 提供当前 Project 的对话、Tasks、运行、租约及协调信息。Agent status 只汇总当前 Project 内的 runs。
- Machine 加入 Project 后才供其分身查看和申请；同一物理 Machine 可以加入多个 Projects。
- 租约互斥单位为 Project × Machine。一期同一 Project 内一台 Machine 只能由一个分身持有；二期挂靠期间也保持占用。不同 Projects 可以同时在同一物理 Machine 上持有独立租约。
- 申请、直接交接、释放和收回均限于当前 Project；二期挂靠、领取和自动协调也遵守此边界。其他 Project 的租约不影响本项目申请或占用显示，也不暴露其工作信息。
- 跨 Project 使用同一物理 Machine 的取舍由 Human 负责。文件、进程、端口和资源竞争由 Project organization 负责，Sprout 不做跨 Project 占用仲裁。
- 硬隔离限定在 Sprout 层。有效租约允许分身以 worker 用户权限操作整台 Machine；工作目录不是访问边界，Sprout 不增加操作系统层面的项目隔离。
- 一期从 Project 移除 Agent 前，须手动处理其活动 runs、持有租约、owner 职责及 DM 中的 assigned Tasks。仍有关联工作时阻止移除，不提供一键强制移除和自动善后。
- 正常移除后，Agent 退出 Public Channel 和普通 Group，其 DM 归档、不可继续聊天；旧 run、待处理唤醒和消息不能恢复已撤销的参与权。移除不影响其他 Projects。重新加入时自动进入 Public Channel、恢复既有 DM，不自动加回原普通 Group。
- Machine 无本项目租约时可直接移出。有租约时，人类经警告确认后可强制撤销本项目租约和操作权；受影响的活动 runs 收到资源撤销通知，自行决定如何继续，不一律中止。无法确认撤权时保留待处理占用，不能显示成功或空闲。文件、进程和其他 Projects 的关系保持独立生命周期。

## 六个核心：一期职责

| 环节 | 一期职责 | 一期不承担的职责 |
| --- | --- | --- |
| Machines | Worker 稳定连接；macOS 平台验收；shell、文件、进程操作；长命令持续执行、日志与结果查询、重连接续及请求去重；Project × Machine 内分身独占、跨 run 持有、直接原子交接；人类强制收回 | 挂靠与领取、系统自动资源协调、Windows Worker（二期）；Machine 上安装 harness、自动能力匹配、租约动作自动清理进程、图形桌面工具 |
| Project profiles | Agent 信息与上下文隔离；Agent 与 Machine 成员名单；受前置清理约束的 Agent 移除；一个主工作目录、最多一个仓库；宿主侧仓库访问；每台 Machine 的目录绑定；Git 配置与约定 | Agent 强制移除与自动善后（二期）；项目级 Agent 权限等级、多仓库配置体系、集中 Git 凭据、专门 Git 操作界面 |
| Agent profiles | 人设与默认执行配置；profile × Conversation 的持续分身；配置下一轮更新；Pi 配置与模型认证继承；简单的运行、待机与出错状态 | 多 harness 同时接入、原有工具自动转向远端、跨分身共享租约、成本统计 |
| 沟通渠道 | Project 内 DM、Group、Public Channel；小脑/JEV 可选判定；多 Agent 唤醒；群内分工回报；自动接续；运行中接收消息 | 系统自动租约协调（二期）；固定轮数限制、项目外共享对话、Agent 自行变更 Group 治理 |
| Tasks | Project 所有、Conversation 承接；Group owner 或 DM 唯一分身推进；四态；可选立即开始；有 assigned Task 时定期唤醒小脑；checklist、施工记录及末条记录中的完成结果；人类纠正与重开 | 移除成员时自动转移责任或退回任务（二期）；固定 workflow、完整执行状态机、强制 completion claim 和验收阶段 |
| Info Hub | 统一信息聚合与访问模块，供各界面及 Agents 按需获取 Project 内基本信息及关联；Project、Conversation、Agent、Machine 多视角；Human 自动刷新；Agent 轮初快照、运行中简短变更提示与主动查询 | 挂靠、自动资源协调及强制移除善后信息（二期）；自动工作摘要、独立发布公告或笔记 |

详细规则见 [Machines](machines-decisions.md)、[Project profiles](project-profiles-decisions.md)、[Agent profiles](agent-profiles-decisions.md)、[沟通渠道](communication-decisions.md)、[Tasks](tasks-decisions.md)、[Info Hub](info-hub-decisions.md)。

## 必须维持的边界

- Profile 是人设与默认配置；分身是具体工作个体，同一 profile 在同一 Conversation 中最多一个分身，跨对话独立。
- Owner 通过群聊和 Task checklist 安排分工，成员在同一对话回报；一期不增加独立委派单，消息沿用上下文唤醒机制。
- 一份租约只赋予当前持有分身操作权。直接交接原子变更持有者，全程保持 Project × Machine 占用；没有明确接手者时原分身继续持有。二期挂靠保留占用但交出操作权，领取后才授予新持有者权限。一个分身可持有多台 Machine。
- 租约与进程生命周期独立。Agent 在释放前适当清理；租约动作不自动终止进程或删除文件。
- 长命令独立于 agent run 和宿主连接持续执行；提供稳定执行标识、日志、状态及退出结果。重连或交接后当前有权分身可继续查询与管理；超时重试避免重复启动，不能确认的状态明确表示未知。
- 原有 Pi 工具操作宿主，Sprout 远端工具核验当前 Project、Machine 成员关系和持有租约。默认每个 Project × Machine 独立 checkout，目录不构成操作系统隔离。
- Task 状态、run 状态、Machine 占用分别表达不同事实；Task 完成或 run 结束不代表释放。分身空闲不等于占用无效，申请者不能自行撤销他人租约。
- Task 保持 proposed、assigned、finished、canceled 四态。有 assigned Task 的 Conversation 定期唤醒小脑，结合任务、对话和运行情况判断是否唤醒负责人；没有 assigned Task 时停止检查。不增加执行状态或启动标志，不强制填写结构化等待记录。分配不等于启动，run 结束不等于 Task 完成；人类暂停与停止控制优先。
- Info Hub 关联已有事实；基本信息在 Project 内可见，不自动开放聊天正文，也不授予对象操作权。二期能力未实现前不展示为已支持或已成功处置。

## 日常仓库分析与机器现场排查

- Project 提供宿主侧仓库入口，供三类 Conversation 直接分析分支、历史、源码及维护需要，无需 Machine 租约或先创建 Task。
- 可复用已有副本或按需获取数据，不要求默认完整 clone。数据获取、更新、并发访问、宿主 Git 认证及磁盘占用管理留待技术设计；本轮不将入口缩减为仅支持手动绑定目录。
- 宿主分析默认依据已推送内容，回答说明来源、版本或查询时点，不自动包含各 Machine 的未推送分支、未提交改动、依赖或运行现场。
- 比较 Machine X 与 Y 的启动差异等现场问题，仍申请对应租约。DM 可以直接申请；长程、协作任务中的只读确认也正常遵守租约规则，不增加免租约远端通道。

## 一期开发闭环

1. 人类准备 profiles、Git 与工作约定，连接 macOS Machine，并加入 Project。
2. 添加 Agents，建立 Group 并选择 owner；Public Channel 成员跟随 Project。
3. 分配 Task，可选“立即开始”；owner 通过群聊和 checklist 分工，成员回报，小脑周期检查提供接续。
4. 分身自行选择机器并申请租约，根据配置复用目录或 clone；使用 Machine 本地 Git 认证。机器忙时返回占用，由 owner、持有者或 Human 通过对话协调，不启动专门的系统自动资源协调流程。
5. 通过远端工具执行；长命令可持续并恢复查询，新消息进入当前轮，同一分身串行。
6. 需要交接时直接将租约原子转给指定、有本项目参与权的分身。尚无接手者则继续持有；文件和进程保持原状，新持有者接续管理。
7. Owner 完成 Task，末条施工记录保存结果；租约另行释放，清理由 Agent 负责。Human 可纠正或重开 Task、停止运行、强制收回租约。

此闭环不增加固定开发 workflow。

## 二期：明确要做

- **租约挂靠与领取**：支持 Group 或 Group + Agent；只对 Group / Public Channel 挂靠，不支持 DM。期间保持占用，原持有者交出操作权，由符合条件的分身领取。
- **资源自动协调**：申请遇阻时在项目内有限尝试、合并重复请求，持有者释放、交接或说明保留原因；失败或状态不确定时交 Human，不自动抢占。
- **挂靠超时处理**：提醒 Human；通知或唤醒 owner 协调，无法处理时升级给 Human。超时不自动释放。
- **Agent 强制移除及自动善后**：中止本项目 runs、撤权，owner 默认转 Human、Tasks 留在原对话，DM 未完成 Tasks 退回 proposed；确认旧操作权撤销后释放租约，无法确认时保留待处理占用。历史、施工记录、文件和进程不随之删除，其他 Projects 不受影响。
- **Windows Worker**：一期支持 macOS，二期补齐 Windows，并验证 Windows 路径、shell、进程和长命令能力。

## 未来方向：保留想法，时间未定

- Agent owner 申请修改 Group 成员、owner 或解散，由人类在聊天中批准；Public Channel 不单独调整成员。
- 按 run 和 Conversation 记录、查询模型用量与费用估算。
- 图形桌面操作工具。
- 其他 harness 及 MCP tools 接入。

这些方向不承诺在二期交付。是否增加固定开发 workflow 仍未决定；Linux 的验收范围也未确定，不因 Unix 实现复用而自动成为一期或二期目标。

## 原源码复用与 issues 定位

优先复用 Worker 连接、认证、重连与平台适配经验，以及持久消息、运行、租约、重复请求和恢复机制；具体 API、schema 和模块以分期后的边界为准。

- Worker 提供远端操作，不在 Machine 部署 harness；Pi 沿用宿主现有工具、配置与认证，再加载 Sprout extension。
- Lease holder 改为持续分身，不沿用 run 结束自动释放。一期直接交接，二期扩展挂靠及自动协调。
- Task 不承载环境 begin/end、pause、blocked、recovery 或强制验收状态机。
- Agent 回复可以进入上下文唤醒；Git clone、pull、commit、push 仍交 Agent 的 shell 工作流程。

| Issues | 分期后的建议 |
| --- | --- |
| #260–#264：Tasks | 按 Project → Conversation、四态、checklist 与施工记录重写；成员强制移除自动善后二期做 |
| #265：Lease escrow | 一期持续分身持有与直接交接；挂靠、领取、申请遇阻自动协调及超时处理二期做 |
| #266：Working group glance | Info Hub 多视角与必要上下文仍属一期；二期再接入挂靠、自动协调与自动善后信息 |
| #226、#272：OAR 与多 engine | 一期仅 Pi；其他 harness 属时间未定的未来方向，OAR 复用是技术选择 |
| #274、#277、#280、#281：工具路径与策略 | 在本地与远端工具并存的边界下重判，不先完成旧隔离路线 |
| #282：Windows OAR 验收 | macOS Worker 一期验收，Windows Worker 二期验收；Windows harness/OAR 执行不属于这两期 Worker 目标 |
| #256：host-run sandbox | 不作为一期前置，未承诺二期 |
| #254、#279、#284：测试、端口与模型成本 | 保留按需测试、冲突处理及真实模型调用经验；成本统计属未来方向，不要求先修完旧套件 |
| #275：开发控制循环 | 开发流程改进，不作为产品闭环前置 |

这些是定位建议，不修改旧 issues 的状态。

## 仍需确定的信息

- Jev 中文协作样本效果、阈值与失败处理，以及 Task 周期小脑与普通聊天判定器的关系，见 [Jev 接入建议](jev-wake-routing.md)。
- Worker 请求与分身身份绑定、授权撤销及重连同步；长命令标识、请求去重、日志与结果保留，以及 Worker / Machine 重启恢复范围。
- 宿主 Pi 接入、仓库数据准备、持久会话、当前轮消息投递，以及 Task、checklist 和施工记录的具体形式。
- 小脑检查周期、重复唤醒、持续失败与人类控制；Info Hub 快照和相关变更提示的合并与投递。
- 一期直接交接的授权切换与不确定结果处理；二期挂靠超时、协调尝试与自动善后细节在对应阶段设计。

技术设计服务当前分期；只把影响产品行为的分歧带回讨论，常规实现选择由开发过程解决。
