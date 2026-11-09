# 飞书 DM adapter 推进记录

状态：2026-11-10 F0 风险探针已通过，F1 身份/入站候选通过 CI，独立功能审查与集成待完成。上一轮 Human UI 评审在 `ed92e92` 收尾；本文件不表示飞书实现或平台联调已完成。具体边界见[实施契约](feishu-adapter-contract.md)。

## 工作流

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
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
- 首期优先评估长连接及新版卡片回调。调查报告确认公开文档支持二者。父线程另行核对 npm 官方 registry 的 `@larksuiteoapi/node-sdk@1.76.0` 发布包，并用真实 SDK 与 loopback WebSocket 完成断线探针。两次握手的回调顺序为 `ready → reconnecting → reconnected`，最终状态 `connected`。`onReconnected` 回调内的状态快照仍为 `reconnecting`，应用不能直接照抄该快照。这仍不表示真实飞书平台联调已通过。
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

已在实施契约确定首版稳定身份键、绑定与换路事务、消息来源和输出范围、epoch 与 uncertain 的处置。绑定页入口及信息层级仍待 Human 从已展示的两案中选择。真实平台行为须在联调时另行确认。

### 当前设计进展

界面对比保存在 `.verify/feishu-ui/options.html`，已通过 728px 与 390px HTML preview 并在当前线程展示。方案 A 集中放在 Management，方案 B 从助理 DM 进入。Human 尚未选型，页面实现未开始。原型中的飞书账号、助理和目标 DM 已分开标注，连接不可用也与绑定确认超时分开表达。

两份架构候选均已完成并由父线程完整复核。A 位于 `/Users/snake/.t3/worktrees/sprout-mio/t3-d120f55d/.verify/feishu-design`，B 位于 `/Users/snake/.t3/worktrees/sprout-mio/t3-fd5399e1/.verify/feishu-design`。独立交叉审查 `/tmp/sprout-feishu-cross-judge.md` 推荐 A，设计评分为 27 对 17。采用 A 的原子接纳、不可变路由与 epoch，嫁接 B 的小型 transport 端口，不复制任一候选的整套接口。父线程核查记录位于 `.verify/feishu-design/parent-review-notes.md`。

架构必须闭合的两项问题已进入实施契约和 F0/F1 验证门槛。第一，receipt 与原生消息在同一 immediate transaction 内提交，并实测嵌套回滚。第二，以 epoch 边沿和平台创建时间拒绝离线旧输入，出站只捕获新提交，不通过水位扫描补发历史。另以真实 loopback HTTP 验证同步 begin 与解绑竞态；外部投影未知形状默认拒绝。上述门槛未执行前，不记为运行验证通过。

F0 与 F1 已由一个隔离后端写者顺序完成，实现 commit 为 `6db49802b02c6f3a47bfa5fc220d953e36d8d743`，当前由父线程接管候选 checkout。F1 只实现身份与文本接纳，F2 的投递和卡片表未预建。父线程负责补测、门禁清单、审查和集成，UI 选择不阻塞该单元。新绑定页仍须等待 Human 选型。

### F0/F1 候选验证

F0 真实临时 SQLite 和 loopback HTTP 探针通过。F1 包含 identity slot、challenge、不可变 route、connection epoch、入站 receipt，直接复用原生 Human 消息与 run/input。0046 migration 新增五表，不修改原生历史；0047 为 route 补充不可变的生效时间，并使已有 route 从迁移边界起接纳新消息。迁移测试覆盖原生数据和 FK 保持、已有 route 初始化、旧 tuple 保持。

父线程独立复核发现 epoch 早于路由生效时，未见过的旧消息可能进入新绑定或新 DM。两个定向用例实际复现 accepted，再加入 pre_route_message 检查后通过。该结果与 worker 移除外层事务的 atomicity RED 分开记录。证据分别为 `/tmp/sprout-feishu-route-red.log`、`/tmp/sprout-feishu-route-migration-green.log` 与 `/tmp/sprout-feishu-atomicity-red.log`。

候选实际通过 21 项 F1/F0/迁移测试、typecheck、check、diff check。CI 经修正启动器参数后实际执行，133 文件、1192 项通过，runner 96.57 秒，工作流记录 97.9 秒，证据 `/tmp/sprout-feishu-f1-parent-ci.result.json`。首次错误参数的调用未执行任何 CI 测试，不计失败测试或通过证据。三项新测试已加入 CI inventory 及 assistant-core 门禁。

注释审计无删除建议。独立功能审查正在进行，尚未将候选集成或迁移现有 LAN 评审库；真实平台与 F2/F3 仍未验证。F2 必须证明 armed attempt 在 begin 前已持久提交，避免网络请求逃逸后失去恢复记录；当前 F0 证明同步请求与 writer 边界，不替代该崩溃恢复验证。
