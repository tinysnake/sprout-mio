# 开发总计划

> **当前工作入口。** 一期已交付，历史计划已归档。后续阶段尚待设计；目前没有新功能的执行排期或已批准任务。

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

webhook、cron、个人助理、Feishu 与语音 channel 正在进行产品决策整理。已有讨论共识和建议分别记录在两份草案中。

- [自动化决策草案](automation-decisions.md)记录 webhook、cron、工作提交与结果投递的边界。
- [个人助理与 channel 决策草案](personal-assistant-decisions.md)记录助理、会话、入口、观察、委派和通知的关系。

草案明确区分已确认方向、建议与待定项。身份绑定、访问范围及首期确认模式是下一轮优先讨论事项。完整交付范围、业务契约、依赖、验收标准和实现排期尚未冻结，不分配新的 P 阶段编号。历史 P8 外部通信扩展条目继续作为待设计材料保留。

现有产品边界继续以 [核心范围](core-scope.md)、[术语表](glossary.md)及对应领域决策为准。新范围与关键行为确认后，再补共享业务契约、功能入口及验收场景，更新本入口、功能与 UI 任务、依赖和验收要求。

## 一期历史入口

- [一期归档索引](archive/phase-one/README.md)：原总计划、功能与 UI 执行记录，以及阶段证据入口。
- [功能计划入口](development-plan-functional.md)与 [UI 计划入口](development-plan-ui.md)：当前状态及旧章节跳转。
- 验证与证据复用遵循[验证约定](verification.md)。本次只执行文档与门禁探针检查，历史技术验收与 Human 确认保持来源区分。

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
