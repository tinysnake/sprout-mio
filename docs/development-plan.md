# 开发总计划

> **当前工作入口。** 一期已交付，历史计划已归档。Project webhook、cron 与原生个人助理单元已有实现和专项技术验证。2026-11-09 的 Human 真实体验反馈已完成设置页、自动化目标与 secret、逐 watch 周期及助理观察工具修订，并通过专项技术复验和独立审查发现的修正；2026-11-09 Human 确认其余体验通过，并授权基础信息重复分隔线修复后由执行者截图复核再进入下一环节；桌面和手机截图条件已满足，本轮评审收尾。反馈范围与自主决定见[修订记录](review-feedback-decisions.md)。飞书 DM adapter 已按 F0/F1/F2a/F2b/F3 顺序实现并集成：绑定与连接 epoch、入站接纳、持久 outbox 投递、卡片授权、真实 SDK 装配与 Project 设置页的绑定界面都在全量 CI 内通过，真实凭证下的绑定、入站、出站与卡片动作已在评审实例跑通，绑定入口按管理页形态落地并经 Human 验收。仍未验证飞书移动端与多设备体验，以及真实租户的通讯录昵称权限；语音和其他后续功能仍不在范围内。

## 一期交付状态

本次归档依据合入基线 `1cfa15f` 的实现、Git 历史和现有验收记录。用户确认一期已实现；逐章技术验收与 Human 确认仍以各章原始证据为准，本次没有重新验收产品或补记 Human 确认。

| 范围 | 有证据的交付状态 | 证据入口 |
| --- | --- | --- |
| P0–P2：技术预研、骨架、身份与 Project、Agent、Chat | 已完成各阶段记录的验收并合入；P0 的跨机与网络故障边界仍保留 | [P0](p0/summary.md)、[P1](p1/summary.md)、[P2](p2/summary.md) |
| P3：真实 Pi 对话、持久 session 与仓库入口 | 已交付；原清单第 2 条按当时工具面记录为部分交付，保持未勾 | [P3 结论及未验证项](p3/summary.md) |
| P4a–P4d：Machine、租约、远端操作、断连恢复、交接与移除 | 技术交付完成；各章均有带版本的 Human 确认 | [P4a](p4a/summary.md)、[P4b](p4b/summary.md)、[P4c](p4c/summary.md)、[P4d](p4d/summary.md) |
| P5a–P5b：多人 Chat 与 Task 生命周期 | 技术交付完成；各章均有带版本的 Human 确认 | [P5a](p5a/summary.md)、[P5b](p5b/summary.md) |
| P6a–P6c：对话接续、人类控制、Info Hub 与成员治理 | 技术交付完成；Human 确认版本 `fef2612` | [P6a](p6a/summary.md)、[P6b](p6b/summary.md)、[P6c](p6c/summary.md) |
| P7：客户端布局、路由、恢复、诊断与基础打包 | 技术交付完成；Human 已确认除 PWA 装机外的一期客户端体验 | [P7 结论与 Human 确认](p7/summary.md) |
| R1：MCP 多 client、stream、取消、drain 与租约错误传播 | 第七轮独立技术验收通过；Human 已同意纳入一期，因无界面，Human 体验确认不适用 | [R1 结论与范围](r1/summary.md) |

P3 之后又合入了宿主 skills 默认继承（`7416b1b`）及正文内联技能标记与候选插入（`1cfa15f`）。当前实现入口是 `src/server/pi-host/skills.ts` 和 `src/server/message-skills.ts`。这些增量不追改 P3 当时的验收，也没有在本次归档中重新验证。产品范围继续由 [核心范围](core-scope.md)维护。

## 遗留与未验证项

- **待 Human 确认：PWA 装机。** 安装、独立窗口与离线体验延后到部署及 HTTPS 就绪后评审；[UI-P7 第 3 条](archive/phase-one/development-plan-ui.md#ui-p7-完成客户端与一期体验验收)保持未勾。P7 既有确认不涵盖这一项。
- **历史部分交付：P3 第 2 条。** 归档保留“六勾一未勾”和当时的工具面限制。后续 MCP、skills 增量分别按其提交与证据理解，不能据此把原清单自动勾满，见 [P3 决定](p3/summary.md#第-2-条部分交付的理由与决定)。
- **技术边界仍有效。** 跨真实物理机器与网络故障、超大输出与极端进程清理、公网仓库认证及规模边界、R1 的 fixture 与真实模型区别，按 [P0](p0/summary.md)、[P3 未验证项](p3/summary.md#未验证项汇总)、[R1 限制](r1/summary.md#已知限制与待确认事项)保留。各章 summary 的限制没有因归档而关闭。
- **P7 验证有明确范围。** 多轮闭环门禁使用 `model-fixture`，记录为 `paid-model-calls=0`，付费模型路由仍未验证。手机主要路径有 Human 亲自体验确认，但未保留设备截图；跨机恢复、真实磁盘满与断电仍未证明。部署、HTTPS 和 PWA 装机继续延后，见 [P7](p7/summary.md)。

一期交付归档不表示全部历史未验证项已消除。P4–P7 已有的带版本确认保留原记录；当前明确延后的 Human 体验项是 PWA 装机。

## 后续阶段尚待设计

webhook、cron 与原生个人助理已有契约、实现和专项技术验证；Feishu DM adapter（身份、入站、投递、SDK 装配、绑定界面）已实现并集成，真实凭证下的绑定、入站、出站与卡片动作已在评审实例跑通，移动端与多设备体验仍未验证，见[飞书推进记录](feishu-adapter-plan.md#f6-真实平台实况已跑通)。Hindsight 记忆已实现并完成真实链路验证，未验证项见[记忆真实链路](memory-e2e.md)。语音保留共用边界，具体实现留到后续。常规选择按[早期版本的决策方式](project-conventions.md#早期版本的决策方式)由执行者直接落实，不以逐项询问 Human 为开工前提。

- [自动化决策草案](automation-decisions.md)记录 webhook、cron、工作提交与结果投递的边界。
- [个人助理与 channel 决策草案](personal-assistant-decisions.md)记录助理、会话、入口、观察、委派和通知的关系。
- [Hindsight 记忆接入计划](memory-plan.md)记录 Project 级配置、宿主级组件安装、bank 解析、关闭时的四道门与 MEM-0 到 MEM-6 单元。

草案明确区分 Human 已确认方向、执行者选择的首版默认、建议与待定项。目前已确认的首期决定如下。

- Webhook 与 cron 规则归属 Project，触发动作可配置。首期主要向所属 Project 的 DM 或 Group 发送系统来源消息，支持唤醒 DM Agent、Group 中 @ 的 Agent 或当前 Agent owner；内置系统动作留到后续。
- 自动化消息目标失效，或选择 owner 接手但当前 owner 为 Human 时，本次触发不执行并记录原因，不自动换 Agent；后续触发仍按原规则检查目标。
- 同一 cron 规则的上一次工作尚未结束时，跳过本次触发并记录原因，不排队、不并行启动该规则的另一份工作，被跳过的时点不补跑。
- 停用规则只阻止新触发，不撤回已提交的消息，不停止已启动的工作。
- 每个 Human 最多绑定一个飞书账号，采用已确认的绑定、解绑和换绑流程。
- 助理默认查询 Human 当前有权访问的全部 Projects。
- 采用询问模式，支持 Sprout 和飞书内直接确认。具体提案确认一次后提交执行，跨入口重复确认只提交一次，目标或操作变化后重新确认。
- 主动通知只覆盖助理委派的工作，以及 Human 明确要求关注的工作。
- 通知包含工作完成、需处理的失败或中断、待 Human 决定，以及 run-activity 定期汇报。
- 每条 watch 默认每 5 分钟汇总所关注 Chat 的消息与工作活动，周期通过 watch 工具参数设置或更新。窗口无内容时不发空通知，watch 不再逐个即时转发 run 结束事件；助理委派工作的即时结果通知保留。助理可通过工具直接停止关注，旧确认被消费后不重新出现。关注窗口通过独立、无工具的助理模型调用生成语义摘要，保留原始事实；标题栏列出全部有效关注，待确认请求支持持久拒绝。本轮实现与验证状态见修订记录。
- Pi extension 暴露 watch 入口，服务端保存关注关系并负责权限检查与定时触发；DM 或 Group 的持续关注独立于单次 run 及 Pi 进程。
- 助理回复与主动通知统一向当前可发送的所有已绑定 channel 分发，来源不决定回复去向，各端分别记录投递结果。
- Sprout 内提供原生助理对话入口，复用归属 Project 的普通 Agent Chat，不依赖外部 channel。助理的跨 Project 查询按 Human 当前权限受控开放，不改变 Chat 的归属。
- 助理使用独立 Agent profile，模型和 effort 针对即时交流需求单独定制；具体默认值尚未冻结。
- 初版 channel 只接私聊 DM，不接外部群聊；助理仍可在 Human 当前权限内查询、watch 和委派 Sprout 内部 Group。
- Channel 接入时选择一个 Project 下的助理 DM，同一 DM 的入口共用历史与上下文，输出向该 DM 当前可发送的所有已绑定 channel 分发。

常规选择采用[自动化默认行为](automation-decisions.md#首版默认行为)和[助理入口默认值](personal-assistant-decisions.md#首版入口默认值)。自动化每条规则先执行一个消息动作，支持手动试运行，记录在 Project 内查看；绑定由 Human 明确选择 Project 和助理 DM，重连不自动补发历史，不引入全局唯一助理约束。外部群聊、语音实现、保守和激进模式、复杂恢复及通用工作流留到后续。

身份与能力配置、系统消息来源、触发与运行关联、Group 工作结束判定及确认去重先补共享契约。能调查确定的问题由执行者核实，只有方向不明确或返工成本较高的选择才交 Human。当前不分配新的 P 阶段编号。历史 P8 外部通信扩展条目继续作为待设计材料保留。

## 首版推进顺序

当前先完成下表各单元需要的最小共享契约，再按顺序实现与验证。表中逐项记录实现与验证状态；未注明完成的单元仍待实现，技术验证不代表 Human 体验确认。

| 单元 | 依赖与范围 | 单元结束时必须证明 |
| --- | --- | --- |
| Project 内 webhook 消息动作 | 先确定规则、系统来源、目标路由与触发记录契约，再贯通配置、认证、基本去重、DM / Group 唤醒及记录查看 | 有效事件只提交一次；未授权事件不提交；Agent 能识别系统来源；DM、显式 @ 与 owner 路由正确，现有人类消息不回归。已完成 domain/schema、HTTP ingress、Project 设置 UI 和生产服务浏览器链路验证。实际 Pi runner 使用零付费模型 fixture；Human UI 体验已确认，最后分隔线修复按授权由执行者截图复核。契约与证据入口见 [Webhook](webhook-core.md) |
| Cron 接入相同消息动作 | 复用上一单元的规则与提交路径，增加时区、下一时点、重叠跳过和离线不补做 | 已实现并完成 schema / domain / runtime / UI 专项技术验证：实际墙钟定时触发经生产服务与真实 Pi runner 的回环模型 fixture；同规则重叠跳过、停用不撤回、重启不补跑由边界测试覆盖。Human UI 体验已确认，固定偏移与当前默认项已完成复验，见 [Cron 契约](cron-core.md) |
| Sprout 原生个人助理 | 复用现有 Agent profile 与 Project DM，补受限工具、跨 Project 观察、watch、提案确认、受控委派及通知 | 已实现并完成专项技术验证：当前 Human 权限、目的隔离、单次确认、持久 watch、合并通知和实际下一轮 Pi context；生产 fixture 包含初始与运行中 steer 输入，零付费调用。Human UI 体验已确认，最后基础信息分隔线修复按授权由执行者截图复核；广泛技术验证的既有限制仍保留。见[契约](assistant-core.md)与[功能证据](feature-map/assistant.md)。 |
| 飞书 DM adapter | 依赖原生助理闭环，接身份核验、DM 绑定、接收去重、两端确认及统一投递 | 外部输入与 Sprout 共用同一 DM 历史；解绑立即停收停发；多端不重复执行；投递失败不重跑工作 | 已实现并完成专项技术验证：真实自建应用在评审实例上完成私聊发码绑定、真实卡片推送与卡片「拒绝」回调，入站消息进入该 Human 的助理 DM 历史；共享历史、解绑停收停发、多端不重跑、投递失败不重跑由领域与边界测试覆盖。Human 已验收绑定页三项体验修正（确认码跨刷新保留、显示账号昵称、换绑需飞书确认）。未验证：飞书移动端与多设备体验、真实租户的 `contact:user.base:readonly` 授权。见[推进记录](feishu-adapter-plan.md)与[契约](feishu-adapter-contract.md) |
| Hindsight 记忆 | 依赖 Project 设置与 Pi runner。先钉 bank 解析与组件安装契约，再贯通开关、状态、工具面与设置页 | 关闭时扩展、工具、提示词与技能都不进 Pi；开启后新 session 能检索到上次写入；安装失败显式可见且不挡 run。计划见[记忆计划](memory-plan.md)。已实现并完成真实链路验证：真实 Hindsight 与 6 次付费模型调用跑通写入、新 session 检索、关闭隔离与安装失败降级；关闭态官方 npm skill 泄漏已修复。未验证：测试连接、清空、compaction、浏览器页面。证据见[真实链路](memory-e2e.md) |
| Agent run 注意力阶梯（Part L） | 先收敛契约、七列迁移及 running 策略快照，再实现事务投递、独立 scheduler、取消收口与 UI；Part W 在下列单元实现阻塞等待工具 | 已实现 30 分钟注意力、60 分钟统一人类提醒，不按年龄或静默杀 run；其他 Agent owner 首次直投 input，人类/self 首次无消息。专项 21 测试、typecheck 与全量 1612 测试已通过，真实子进程取消实测约 3.5 秒收口且后续 run 启动；完整验证执行 115 个 gate，111 通过，失败的 4 个里 2 个是既有环境依赖项（z-lease-integration 的 free/held 控件预期、z3-mcp-acceptance 的 R1 归档 script SHA 校验），另 2 个浏览器 gate 单独复跑即通过。Human 页面体验、真实模型长运行尚未确认。见 [Turn 语义](p3/turn-semantics.md)与 [Chat 与 Run](feature-map/chat-runs.md) |
| 阻塞等待工具（Part W） | 依赖 Part L；共享时长契约、纯 execution 轮询循环、宿主 sleep、runner 接线与具名活动标签 | 已实现本地 sleep（最多 10 分钟）和 execution wait（默认 10 分钟，最多 15 分钟）；等待到点携带最后视图，表示仍在跑，不重试副作用。技术验证覆盖假时钟边界、取消、错误透传与真实 Pi runner 注册；类型检查 0 错误，全量 181 文件 1646 测试通过，147 个 gate 里 140 通过。失败的 7 个：2 个是既有环境依赖项（z-lease-integration、z3-mcp-acceptance），3 个在负载 8.24 下假红、单独复跑通过（p7-storage-recovery、as-p5b-task-pages、assistant-browser），2 个是新增 sleep 后过期的工具面夹具断言（ae-remote-tools-cancel-log、p7-pi-inheritance），修正夹具后在最终 commit 上复跑通过。真实长时间模型调用与 Human 页面体验未验证。见[远端执行](feature-map/remote-execution.md) |

每个单元带上最小可用页面与实际验收，不先集中构建一套未来才使用的基础框架。新页面形状按[页面设计约定](project-conventions.md#页面设计与实现的分工)处理。功能细化见[功能计划](development-plan-functional.md#首版功能单元)，界面细化见[UI 计划](development-plan-ui.md#首版界面单元)。

当前并发瓶颈是共享消息、运行关联和权限契约。先由同一写者收敛契约及 schema，不并行修改这些文件；契约稳定后再拆 adapter 或页面任务。每个单元通过对应验证后再扩大范围，验证与 Human 体验确认按[验证约定](verification.md)分别记录。

现有产品边界继续以 [核心范围](core-scope.md)、[术语表](glossary.md)及对应领域决策为准。实施中出现范围变化时同步契约、功能入口和验收场景，保持本入口与专项计划一致。

## 一期历史入口

- [一期归档索引](archive/phase-one/README.md)：原总计划、功能与 UI 执行记录，以及阶段证据入口。
- [功能计划入口](development-plan-functional.md)与 [UI 计划入口](development-plan-ui.md)：当前状态及旧章节跳转。
- 验证与证据复用遵循[验证约定](verification.md)。归档检查与各实现单元的技术验证、Human 确认保持来源区分。

## 旧章节链接

以下锚点保留供旧链接访问，均转到一期归档中的原章节。

- <a id="先追赶-p1p2-与-p3"></a>[先追赶 P1/P2 与 P3](archive/phase-one/development-plan.md#先追赶-p1p2-与-p3)
- <a id="按章节组织开发与集成"></a>[按章节组织开发与集成](archive/phase-one/development-plan.md#按章节组织开发与集成)
- <a id="明确三条线的责任与交付标准"></a>[明确三条线的责任与交付标准](archive/phase-one/development-plan.md#明确三条线的责任与交付标准)
- <a id="技术验收与独立验证"></a>[技术验收与独立验证](archive/phase-one/development-plan.md#技术验收与独立验证)
- <a id="人类体验确认与-afk-期间推进"></a>[人类体验确认与 AFK 期间推进](archive/phase-one/development-plan.md#人类体验确认与-afk-期间推进)
- <a id="按章节交付与验收"></a>[按章节交付与验收](archive/phase-one/development-plan.md#按章节交付与验收)
- <a id="由集成编排者维护四步-checklist"></a>[由集成编排者维护四步 checklist](archive/phase-one/development-plan.md#由集成编排者维护四步-checklist)
- <a id="i-p1p2-集成基础页面与持久对话"></a>[I-P1/P2 集成基础页面与持久对话](archive/phase-one/development-plan.md#i-p1p2-集成基础页面与持久对话)
- <a id="i-p3-集成真实对话与宿主仓库入口"></a>[I-P3 集成真实对话与宿主仓库入口](archive/phase-one/development-plan.md#i-p3-集成真实对话与宿主仓库入口)
- <a id="i-p4a-集成-worker-连接与-project-绑定"></a>[I-P4a 集成 Worker 连接与 Project 绑定](archive/phase-one/development-plan.md#i-p4a-集成-worker-连接与-project-绑定)
- <a id="i-p4b-集成分身持租与远端操作"></a>[I-P4b 集成分身持租与远端操作](archive/phase-one/development-plan.md#i-p4b-集成分身持租与远端操作)
- <a id="i-p4c-集成长命令日志与恢复查询"></a>[I-P4c 集成长命令日志与恢复查询](archive/phase-one/development-plan.md#i-p4c-集成长命令日志与恢复查询)
- <a id="i-p4d-集成交接收回与-machine-移除"></a>[I-P4d 集成交接收回与 Machine 移除](archive/phase-one/development-plan.md#i-p4d-集成交接收回与-machine-移除)
- <a id="i-p5a-集成多人-chat"></a>[I-P5a 集成多人 Chat](archive/phase-one/development-plan.md#i-p5a-集成多人-chat)
- <a id="i-p5b-集成-task-总览与生命周期"></a>[I-P5b 集成 Task 总览与生命周期](archive/phase-one/development-plan.md#i-p5b-集成-task-总览与生命周期)
- <a id="i-p6a-集成对话接续与人类控制"></a>[I-P6a 集成对话接续与人类控制](archive/phase-one/development-plan.md#i-p6a-集成对话接续与人类控制)
- <a id="i-p6b-集成-info-hub-全部一期视角"></a>[I-P6b 集成 Info Hub 全部一期视角](archive/phase-one/development-plan.md#i-p6b-集成-info-hub-全部一期视角)
- <a id="i-p6c-集成成员治理与重新加入"></a>[I-P6c 集成成员治理与重新加入](archive/phase-one/development-plan.md#i-p6c-集成成员治理与重新加入)
- <a id="i-p7-验收完整一期与客户端体验"></a>[I-P7 验收完整一期与客户端体验](archive/phase-one/development-plan.md#i-p7-验收完整一期与客户端体验)
