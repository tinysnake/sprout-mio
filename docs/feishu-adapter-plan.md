# 飞书 DM adapter 推进记录

状态：2026-11-10 F0、F1、F2a、F2b、F3、F4 已集成；F5 单实例租约与 F6 真实平台实况已落地，真实凭证下的绑定、入站、出站与卡片动作在评审实例上跑通。Human 已验收绑定页三项体验修正（确认码跨刷新保留、显示账号昵称、换绑需再走一次飞书确认）。仍未验证飞书移动端与多设备体验，以及真实租户的 `contact:user.base:readonly` 授权。具体边界见[实施契约](feishu-adapter-contract.md)。

## 工作流

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

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

注释审计无删除建议。独立功能审查 `/tmp/sprout-feishu-f1-review.md` 未发现当前 F0/F1 范围内成立的 P1/P2。审查确认 route activation 覆盖延迟旧输入，原生表没有被迁移改变。现有 LAN 评审库尚未应用这些 migration，真实平台与 F2/F3 仍未验证。

F2 分为两个依赖单元。F2a 实现可被后续 adapter 复用的投递端口、持久 outbox/attempt、受控投影和 action grant，复用原生提案及 watch 确认。F2b 依赖 F2a，接入真实 SDK、单一 runtime owner/generation、受信解析、配置和 Web 管理边界。只有 F2a 写共享 schema 与契约，F2b 在前者稳定后开始。

### F2a 投递与授权（已集成）

F2a 实现 commit 为 `5c67e66`，父线程在 `8d241ee` 补登 CI inventory，审查修正为 `ce2781e`，三者已 fast-forward 到根工作区。0048 仅新增四张 channel 表，既有表、行和 FK 不变。

捕获点位于原生消息提交事务内：`sendMessage` 与 `deliverAssistantEvents` 在写消息后调用 `captureFeishuMessage`，后者要求当前处于事务中，只按当时有效的 route 与 epoch 建行，不扫描历史、不补发离线输出。投影只接受已持久化的助理文本、严格形状的助理事件事实和 watch 摘要；未知或损坏事实、raw watch 内容、Web 的 `assistantEventSummary` 兜底都返回不可投递。周期性事件只用持久化的模型摘要正文。

发送顺序为：异步 prepare → 独立 immediate 事务提交 armed attempt → 短同步事务复查 route、epoch、权限与投影，并调用无 await 的 `begin()` → 事务外等待回执。begin 返回 Promise 会被视为契约违反。begin 抛错或提交失败一律记为 uncertain；超时、ack 丢失、进程重启后的 armed attempt 同样 uncertain，不自动重发。只有可证明未接纳的失败在 10 分钟、3 次、同一 uuid 内重试。

飞书 UUID 只保证一小时内至多成功发送一条，因此不能把同一 uuid 当作跨崩溃 exactly-once。迟到的 accepted 回执记在原 frozen route 上，不改投新目标。

卡片确认复用原生 `confirmAssistantProposal`/`revokeAssistantProposal` 与 watch 意图确认，Web 与卡片竞争同一原生记录，重复确认只产生一个 work message；grant 只存 token 摘要，消费、原生副作用和 receipt 在同一个 immediate 事务内，并在消费时复查当前权限。

独立审查 `/tmp/sprout-feishu-f2a-review.md` 发现的 P1 是卡片授权错误地要求发送时 epoch 仍开放：真实重连或进程重启后，用户点击已送达卡片会全部失败。父线程将边界拆成 `assertCurrent`（出站，要求 epoch 当前）与 `assertActionCurrent`（卡片，只要求当前 route 与身份），并补了“重连后卡片仍恰好确认一次”的用例；移除旧用例时发现原 `epoch` 拒绝用例实际因 fixture 展开导致 `scope` 为 undefined 而抛错，属于通过原因错误，现由新用例取代。另一个 P3 修正为只有 `ready` 状态的投递会在运行异常结束时改写为不完整，已 armed 或已发出的记录保持原正文。

实际验证：定向 3 文件、30 项测试；assistant-core 22 文件、155 项；全量 CI 136 文件、1222 项通过（`/tmp/sprout-feishu-f2a-parent-ci3.result.json`）；typecheck、check、fmt、diff check 通过。真实飞书平台、运行时装配和 UI 均未验证。

F2 必须证明 armed attempt 在 begin 前已持久提交，避免网络请求逃逸后失去恢复记录；当前 F0 证明同步请求与 writer 边界，不替代该崩溃恢复验证。旧 lifecycle 的 ready/reconnected 也能关闭较新实例的 epoch，因此实际装配必须只保留单一 owner，并使已停止或已替换 generation 的 callback 不得 reopen、close 或接纳输入。该项在没有 SDK 装配路径的 F1 中未被视为已暴露漏洞，F2b 必须提供实际反证测试。
### F2b 传输装配（已集成）

F2b 实现 commit 为 `6808f49`，父线程补 CI inventory 与配置契约用例 `8f36be9`、`4f1d4b2`，审查修正为 `62f8664`，已 fast-forward 到根工作区。唯一新增依赖是 `@larksuiteoapi/node-sdk@1.76.0`；当时的渠道开关默认关闭，关闭时运行时不创建、不注册定时器、不建 socket；F4 后改由 Project 级 `channel_config.enabled` 决定。

装配在 `src/server/runtime.ts` 由配置驱动：启用时创建 runtime、注册唤醒、在 shutdown 与启动失败路径里 stop。`src/server/feishu/owner.ts` 按 appId 维持单一 owner，generation 每次 start 递增，所有 WS callback 与 handler 派发前先过 `live()` 围栏，因此被替换或已停止的 client 既不能开户 epoch，也不能关闭当前 epoch 或接纳输入。入站 `src/server/feishu/ingress.ts` 默认拒绝：非 p2p、非 text、非 user 发送、时间戳不是 13 位毫秒、正文超 20000 字符一律丢弃，ACK `{}` 只表示已收到，不表示已接纳。出站 `src/server/feishu/emission.ts` 用 `node:http(s)` 同步发起，tenant token 本地缓存并对并发换取去重，`classifyFeishuResponse` 只把 HTTP 200 且 code 0 视为 accepted，其余 code、超时、响应丢失一律 uncertain。投递循环是 unref 定时器，空闲 1 秒，每轮最多 20 条，失败退避 30 秒起指数封顶。

绑定码改为 8 位 Crockford 字符（`0123456789ABCDEFGHJKMNPQRSTVWXYZ`，40 bit，展示为 `XXXX-XXXX`），仍只存摘要，接受小写、空格和短横线；长度或字符不合法的输入在任何数据库读取前就返回 `invalid_challenge`，普通聊天文本因此不会被误当成绑定尝试。原始 43 字符 base64url 在飞书 DM 里无法手输，属于体验缺陷而非安全收益。

独立审查 `/tmp/sprout-feishu-f2b-review.md` 的结论是可集成，但必须以修正后的 commit 为合入点：被审提交 `dfcd283` 自身的 `tests/contracts.test.ts` 就是红的，原因是当时新增飞书环境配置后旧断言未同步，说明被审者自报的验证与交付物不一致。父线程据此修正了两处真实缺陷。其一，`prepare` 失败（换取 token 失败等）从未发起平台请求，原实现直接终结为 `failed/prepare_failed`，会静默丢掉一条助理回复；现在改为保留 `ready`、按 30 秒退避重排、把失败计入 attempts，累计三次或超过截止时间才终结。其二，飞书 appId 的形状校验原先只认十六进制，而外部证据提示真实 appId 可能更宽；校验放宽到 16 位字母数字，真实格式以 SDK 为准，形状存疑不该让宿主进程起不来。飞书 origin 同时收紧为飞书/Lark 官方域名或回环 http，因为它承载 app secret。

审查其余 P3 的处理：启动装配在 owner 生成前就失败时，现在会拆掉装配到一半的 loop 与 wake，让下一次 `start()` 能真正重来，而非带着半个运行时；旧 generation 的 `onReconnecting`/`onReconnected` 补了“不得关闭当前 epoch”的反证测试；旧 generation 收到卡片点击时返回失效 toast，不再沉默。保留未改的两项各有理由：`sender.tenant_key` 缺失时退化为只比较事件 `tenant_key`，因为强制要求可能拒绝真实事件；server boundary 仍以 3 个用例覆盖“剥离伪造身份、无 session 失败关闭、未认证不改 slot”为主干，成员级权限已有域层用例覆盖。

实际验证：定向 8 文件、104 项测试；`pnpm typecheck`、`check`、`fmt`、`diff` 通过；全量 CI 141 文件、1272 项通过（`/tmp/sprout-feishu-f2b-parent-ci4.result.json`）。SDK 运行证据是既有回环探针（`/tmp/sprout-feishu-sdk-parent-probe.log`）。真实飞书平台、真实 appId 形态、卡片回调响应形状仍未验证，属于 F3 门槛。

F3 之前必须解决的两项：绑定入口的 UI 形态需要人选定（管理页选项 A 与助理 DM 头部选项 B，两者业务状态一致），以及真实凭证下的端到端验证。两项目前都有结论：入口选了管理页，真实性由 F6 的实况证据覆盖。运行时约束由 F5 的数据库租约解决，不再依赖“只跑一个实例”的运维约定；owner 在启动失败后仍需显式 `start()` 重试，没有自愈定时器。

### F3 绑定界面（已集成）

F3 实现为 `d0029f0`，父线程门禁修正为 `f602517`，已 fast-forward 到根工作区。绑定入口落在 Project 设置页新增的「飞书」标签（`src/routes/_authed/projects.$projectId.settings.tsx` 的 `validateSearch` 接受 `tab=feishu`），面板在 `src/components/project/feishu-binding-panel.tsx`，文案集中在 `src/components/project/feishu-binding-copy.ts`。

选管理页而不是助理 DM 头部，是因为 Human 尚未在两份 artifact 里选定形态，而此前交付的推荐项就是管理页，两者业务状态与调用完全相同，只差挂载点。这项决定由执行者在 Human 离线期间按 “做到飞书接入完成” 的授权先落实，改回 DM 头部只需换挂载点，不必改状态机或边界函数。

面板只覆盖 Human 自己的绑定。目标列表来自新增的 `listFeishuTargetsFn`，`buildFeishuTargetsView` 在 `ctx.agent` 上直接抛 `forbidden`，因此助理身份与 worker 身份都拿不到候选。候选只列本 Project 内该 Human 拥有的助理私聊（`kind === 'dm'`、未归档），助理名来自会话的 assistant source，取不到就跳过该行。绑定的全部写入仍走 F1/F2 的边界函数，面板不新增权限路径。

状态机有五个分支：已绑定、未绑定、等待飞书确认、已过期、未配置。绑定视图对发起它的 Human 直接给出 `challenge.code` 与 `expiresAtMs`，所以刷新、换标签页或换设备都能继续看码并输入；确认码在十分钟后过期、成功确认即消费，过期或消费后视图不再返回它。换绑与解绑都要 Human 二次确认，解绑只是解除绑定，会话与历史保留。

门禁在集成时拦下一处违规：`tests/tooling.test.ts` 禁止 `src/` 内直接调用 `Date.now()`，面板有 4 处。改为 `FeishuBindingPanel` 接受 `clock` prop（默认 `Date.now`），30 秒刷新一次倒计时，与既有 `src/components/continuation/wake-diagnostic.tsx` 的写法一致。

父线程审查修掉一个会影响判断的缺陷：过期分支原本用 `selectedChatId || targets[0]?.chatId` 兜底，等于替 Human 默认选中第一个目标，而界面上并没有显示这次默认选择；现在只认 Human 显式选中的目标，并且本地挑战过期时也显示重新选择目标的控件，否则按钮会永久禁用。

实际验证：`npx tsc --noEmit`、`npx vp check`（0 error，17 条既有 warning）、fmt、diff check 通过；全量 CI 143 文件、1280 项通过（`/tmp/feishu-f3-ci/run2.log`）。功能走查在隔离实例（`/tmp/feishu-f3-ui/app.sqlite`，端口 3311，假 appId 与假 secret）用真实浏览器完成：未绑定只列出 Jovi 的助理私聊且排除 worker 身份、发起绑定得到 4-4 分组码、刷新后不给码、重新发起生成新码、未在飞书确认时点击“我已在飞书确认”得到 conflict 提示、播种 slot 后显示已绑定与连接状态、换绑不出现与当前目标重复的选项、解绑确认后回到未绑定。1440 与 390 两档均无横向溢出，截图在 `.verify/feishu-ui/`（该目录已 gitignore）。

真实评审实例（LAN `http://10.0.0.13:3300`，Project `prj_ad9fd1a5`）在合入后先报 `internal`，原因是该库只应用到 `0045`，缺 `0046`、`0047`、`0048` 三份迁移，飞书五张表不存在。补跑 `pnpm db:migrate`（迁移前备份到 `.verify/human-review/run.JtVeWy/backups/app-before-feishu-migrate.sqlite`）后，页面正确渲染「未配置」，标签间跳转保持 `tab` 参数。当时的环境变量配置说明已在 F4 删除；渠道配置现存于 Project 级 `channel_config`，本单元不提供配置表单。

已由 Human 答复的三点现在都已落地：换绑必须再走一次飞书确认（确认那一刻才关旧路由并建立新绑定）、待确认的确认码跨刷新保留（`feishu_challenge` 加明文 `code` 列）、绑定页显示已绑定账号的飞书昵称（`feishu_identity_slot.nickname`，确认后异步补写）。仍未验证：确认码过期分支的实际渲染（要等 10 分钟，逻辑由文案测试与注入时钟覆盖），以及真实租户是否授予 `contact:user.base:readonly` —— 昵称成功路径只有注入假 transport 的测试证据，读不到时界面回退为脱敏 open_id。

### F5 单实例租约（已集成）

租约表 `feishu_connection_lease`（迁移 `drizzle/0050_feishu_connection_lease.sql`）按 `app_id` 一行，持有者用一条语句同时承担抢占与续约：

```sql
INSERT INTO feishu_connection_lease(app_id, holder, expires_at_ms) VALUES(?, ?, ?)
ON CONFLICT(app_id) DO UPDATE SET holder = excluded.holder, expires_at_ms = excluded.expires_at_ms
WHERE feishu_connection_lease.holder = excluded.holder OR feishu_connection_lease.expires_at_ms <= ?
```

SQLite 保证单条语句原子，所以两个进程不会同时成功。启动时抢不到就不建长连接，快照报 `failed` + `error: lease_held`，并且不留下 `started`，对方退出后显式 `start()` 仍能接回。租约默认 20 秒，每 5 秒续约；续约返回 false（行已被别人接管）就记 `feishu.lease_lost` 诊断事件，拆掉连接与投递循环，快照报 `lease_lost`。正常退出释放。跨机器共享同一个 app 不在支持范围，两台机器的 SQLite 不共享。

覆盖在 `tests/feishu-lease.test.ts`：活着时挡住第二个实例、持有者停续约后允许接管、同持有者重复抢占幂等、运行时层报 `lease_held` 且释放后能起、两次 `close` 各计一次。

### F6 真实平台实况（已跑通）

2026-11-10 在评审实例（Project `prj_ad9fd1a5`，appId `cli_aa13ca76bdf89cc4`）用真实应用完成：Human 私聊发送确认码完成绑定，本地卡片推送至飞书并取得真实 `platform_message_id`，在飞书卡片上点「拒绝」经回调写入 `channel_action_receipt`（`{"kind":"watch","rejected":true}`），助理对话收到拒绝回执。

同一轮修掉一个真实平台边界缺陷：飞书把用户没有的 id 写成空串或 `null`（例如 `sender.sender_id.user_id`），而 schema 用 `z.string().min(1).optional()`，空串判败会丢掉整条消息。现改为 `z.preprocess` 把空串与 `null` 折成 `undefined` 再 `.optional()`，并把解析结果改成带原因的接纳判定，丢弃时记 `unsupported_message:<reason>`。顺带一个与 zod 4 有关的坑：`z.unknown().transform(fn)` 的输出会被推断为 nonoptional，字段缺失时报 `expected: "nonoptional"`，可选字段必须走 `z.preprocess`。

### 已否决：第三方模拟器代跑平台（2026-11-10）

考虑过用 Apify 之类的外部运行环境扮演飞书：Actor 能发任意 HTTP 请求，Standby 模式还能对外提供 HTTPS server 接收 webhook，所以它可以向我们推送自造事件、回应出站调用。否决原因是它补不上真实缺口：`tenant_access_token` 与 app 凭证是否可用、真实事件信封的加密字段与签名头、`event_id` 去重语义、卡片回调的真实 payload、频控错误码、challenge 的一秒时限，都只在真实平台上成立。现有 in-process fake 已覆盖重复投递、解绑后停止接纳、epoch 栅栏、卡片过期与 uncertain 不重发，换成公网 Actor 不增加断言能力，只是把假事件挪到了更远的地方。

真人决定不再补这一层测试，也不做真实 payload 的录制开关。真实平台证据只来自 F6 那一轮实况，以及后续真正使用中暴露的问题。
