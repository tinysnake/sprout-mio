# 功能开发专项计划

> **当前编排从[开发总计划](development-plan.md)开始。** 一期功能执行记录已归档。Project webhook 单元已实现并完成专项技术验证，后续单元见以下清单。

一期 P0–P7 与 R1 的交付状态、遗留与未验证项由[总计划](development-plan.md#一期交付状态)维护。P3 原第 2 条仍按历史部分交付保留未勾；后续 MCP 与 skills 增量有各自提交，不改写原验收。

[一期功能计划快照](archive/phase-one/development-plan-functional.md)保留逐章清单、完成记录、提交与验收入口。快照中的阶段概览与“当前下一任务”是历史文字，当前状态以总计划为准。原阶段文档保持原位，见[一期归档索引](archive/phase-one/README.md)。

## 首版功能单元

推进顺序与验收边界见[总计划](development-plan.md#首版推进顺序)。常规默认值按两份决策草案落实，不逐项等待 Human 确认。

- [x] 补 webhook 所需的最小契约，覆盖 Project 规则、消息动作、系统来源、权限、触发与运行关联及去重。已核对现有调度和续跑生命周期；cron 重叠判定在下一单元实现。
- [x] 跑通 webhook 到 DM / Group 的消息动作，包含认证、基本去重、目标失效、规则停用及触发记录。已通过专项 domain / HTTP / 迁移测试与生产服务浏览器链路，见[Webhook 契约](webhook-core.md)。
- [ ] 将 cron 接到同一提交路径，覆盖时区、下一时点、重叠跳过、试运行及离线不补做。
- [ ] 跑通 Sprout 原生助理的受限工具、观察、watch、提案确认、委派与通知。未确认或权限失效时不执行，重复确认只提交一次。
- [ ] 接飞书 DM adapter，覆盖身份核验、绑定切换、接收去重、两端确认、消息统一投递和解绑。

每个实现单元补可重复的行为验证及必要反例，按[验证约定](verification.md)选择范围。真实付费模型、飞书凭据或外网连接未实际验证时明确记录，不以 fixture 代替相应结论。

## 旧章节链接

以下锚点保留供旧链接访问，均转到一期归档中的原章节。

- <a id="按阶段推进并保留证据"></a>[按阶段推进并保留证据](archive/phase-one/development-plan-functional.md#按阶段推进并保留证据)
- <a id="按依赖安排开发"></a>[按依赖安排开发](archive/phase-one/development-plan-functional.md#按依赖安排开发)
- <a id="p0-验证关键选择并确定基础契约"></a>[P0 验证关键选择并确定基础契约](archive/phase-one/development-plan-functional.md#p0-验证关键选择并确定基础契约)
- <a id="p1-建立可重复的工程骨架"></a>[P1 建立可重复的工程骨架](archive/phase-one/development-plan-functional.md#p1-建立可重复的工程骨架)
- <a id="p2-建立身份成员与持久对话"></a>[P2 建立身份、成员与持久对话](archive/phase-one/development-plan-functional.md#p2-建立身份成员与持久对话)
- <a id="p3-跑通真实-pi-对话和仓库入口"></a>[P3 跑通真实 Pi 对话和仓库入口](archive/phase-one/development-plan-functional.md#p3-跑通真实-pi-对话和仓库入口)
- <a id="p4-跑通-macos-machine-与租约执行"></a>[P4 跑通 macOS Machine 与租约执行](archive/phase-one/development-plan-functional.md#p4-跑通-macos-machine-与租约执行)
- <a id="p4a-建立-worker-连接和-project-绑定"></a>[P4a 建立 Worker 连接和 Project 绑定](archive/phase-one/development-plan-functional.md#p4a-建立-worker-连接和-project-绑定)
- <a id="p4b-实现分身持有与远端操作"></a>[P4b 实现分身持有与远端操作](archive/phase-one/development-plan-functional.md#p4b-实现分身持有与远端操作)
- <a id="p4c-实现长命令与不确定结果"></a>[P4c 实现长命令与不确定结果](archive/phase-one/development-plan-functional.md#p4c-实现长命令与不确定结果)
- <a id="p4d-实现交接收回与-machine-移除"></a>[P4d 实现交接、收回与 Machine 移除](archive/phase-one/development-plan-functional.md#p4d-实现交接收回与-machine-移除)
- <a id="p5-完成多人协作与-task-记录"></a>[P5 完成多人协作与 Task 记录](archive/phase-one/development-plan-functional.md#p5-完成多人协作与-task-记录)
- <a id="p5a-完成多人-chat"></a>[P5a 完成多人 Chat](archive/phase-one/development-plan-functional.md#p5a-完成多人-chat)
- <a id="p5b-完成-task-协作"></a>[P5b 完成 Task 协作](archive/phase-one/development-plan-functional.md#p5b-完成-task-协作)
- <a id="p6a-完成对话接续与人类控制"></a>[P6a 完成对话接续与人类控制](archive/phase-one/development-plan-functional.md#p6a-完成对话接续与人类控制)
- <a id="p6b-完成-info-hub-全部一期视角"></a>[P6b 完成 Info Hub 全部一期视角](archive/phase-one/development-plan-functional.md#p6b-完成-info-hub-全部一期视角)
- <a id="p6c-完成成员治理与重新加入"></a>[P6c 完成成员治理与重新加入](archive/phase-one/development-plan-functional.md#p6c-完成成员治理与重新加入)
- <a id="p7-验收完整一期与客户端体验"></a>[P7 验收完整一期与客户端体验](archive/phase-one/development-plan-functional.md#p7-验收完整一期与客户端体验)
- <a id="r1-独立验证项目与软件-mcp"></a>[R1 独立验证项目与软件 MCP](archive/phase-one/development-plan-functional.md#r1-独立验证项目与软件-mcp)
- <a id="验证载体变更"></a>[验证载体变更](archive/phase-one/development-plan-functional.md#验证载体变更)
- <a id="当前证据"></a>[当前证据](archive/phase-one/development-plan-functional.md#当前证据)
- <a id="p8-在一期完成后展开二期"></a>[P8 在一期完成后展开二期](archive/phase-one/development-plan-functional.md#p8-在一期完成后展开二期)
- <a id="用范围表检查一期覆盖"></a>[用范围表检查一期覆盖](archive/phase-one/development-plan-functional.md#用范围表检查一期覆盖)
- <a id="分派任务并管理完成记录"></a>[分派任务并管理完成记录](archive/phase-one/development-plan-functional.md#分派任务并管理完成记录)
