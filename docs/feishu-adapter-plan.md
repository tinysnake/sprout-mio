# 飞书 DM adapter 推进记录

状态：2026-11-09 进入设计。上一轮 Human UI 评审在 `ed92e92` 收尾；本文件不表示飞书实现或平台联调已完成。

## 工作流

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame.
- [ ] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [ ] Phase D: Keep the audit trail.
- [ ] Phase E: Verify and hand back.

架构步骤：Ground → Sketch → Agree → Implement → Scrap。Ground 已有原项目、当前领域入口和官方公开文档调查；Sketch 比较完整模块结构，避免同一结构的局部变体。Agree 无额外后端审批点；新页面按项目约定先提供可比较方案，再由 Human 选择。Scrap 仅在设计无法容纳实际约束时触发。

## 完成判据与范围

首期只有一个飞书自建应用 adapter，外部仅私聊。已验证身份的飞书输入进入明确绑定的普通助理 DM，同一历史与上下文保持；飞书与 Sprout 的同一提案确认只创建一个 work input；解绑或失权后停收停发，已接纳工作继续；投递重试不重跑工作；新绑定或重连不回放历史。模块化应允许下一 adapter 接入，不预建通用工作流、外部群聊或语音。

四个实施单元：身份与绑定；入站去重和原生操作；出站投递；界面与平台联调。身份、来源与投递共享契约及 schema 先由同一写者完成，稳定后才拆开写入者。每单元必须给出可重复行为验证及权限 / 重试 / 失效反例。真实飞书凭据与平台联调没有执行时分别标为 NOT VERIFIED，不用 fixture 替代。

## 已确定约束

- 每个 Human 首期最多绑定一个飞书账号；一个平台身份也不能占用多个 Human。应用凭据、平台连接、身份绑定和 DM 路由分别表达。
- Web 登录后发起，平台稳定身份确认后生效；切换显式指向 Project 和助理 DM，冲突不得静默覆盖。
- 同一 DM 的助理输出发给该 DM 当前可发送的全部已绑定 channel，输入来源不决定回复去向；同一 Human 的不同 DM 不混合。
- 平台认证不能替代 Human 当前权限。入站、具体确认和出站均查当前权限与绑定代次。
- 首期优先评估长连接及新版卡片回调。调查报告确认公开文档支持二者；是否具备可观测 reconnect 生命周期仍需结合 SDK 实际 public surface 核实。
- 平台 message_id 是入站去重依据；发送 UUID 的平台去重仅保证一小时，不能宣称跨任意崩溃永久 exactly-once。

## Ground 的因果链

`src/domain/chat.ts` 的 `sendMessage(chatId, input, ctx, hooks)` 在 immediate transaction 中检查真实 Human / Agent 成员，写消息并接入 wake / run input；事务后发 schedule signal。外部身份必须先映射成受信 Human context，不能绕过或冒充 Agent 来源。

`src/domain/assistant.ts` 的 `confirmAssistantProposal` 在 immediate transaction 中重新检查 source / target，已 submitted 返回同一个 messageId；首次确认写 assistant_work、分配 continuation run 和 pending input。飞书需要调用同一领域入口，不能另建一次执行记录。

`deliverAssistantEvents` 在权限、关注和总结 readiness 通过后写普通 assistant_event message。模型摘要与不可变事实分开保存。外部投递应消费可见内容投影，不把原始 facts、工具日志或 LLM context 直接当通知发送。

`src/server/functions/assistant.ts` 的 Web action 先 requireSession，再构造 ProjectContext。飞书 adapter 应在受信服务边界从已核验绑定构造 context，不调用需要浏览器 cookie 的 server function，也不接受外部 payload 自报 Human ID。

原项目 `/Users/snake/workspace/sprout` 在调查的 `5b48a53b3` 未发现可复用的飞书绑定 / 收发模块。Worker channel 和 instruction 注入不能当成业务 channel adapter 复用。

## 验证与吞吐 checkpoint

先验证风险最高的身份与 epoch / outbox 形状，再开始 schema 和领域实现。新能力的 harness 应能分别证明重复入站、两端竞态确认、解绑与在途请求、失权、send ack 丢失、进程重启、旧 epoch 的行为。SDK fixture 证明调用与边界，真实平台联调另记。

设计阶段各候选只写自己的报告 / sketch，禁止改实现或访问评审库。父线程拥有综合契约、计划、最终验证与集成。UI artifact 独立于业务实现，所有方案使用同一批数据和状态。设计收敛后再次检查单元粒度、写者和验证成本，避免一项修改重复启动整个服务或整套门禁。

## 证据与未决项

调查报告 `/tmp/sprout-feishu-discovery.md` 包含实际源码路径和官方 URL。原生闭环已完成技术验证和本轮 Human UI 评审，不能据此把飞书联调记为完成。

待设计收口：具体稳定身份键与约束；平台证明和换绑的事务边界；消息来源与输出范围；重连 epoch 与持久投递的相互作用；一小时平台去重窗口外的 uncertain 处置；绑定页的入口与信息层级。
