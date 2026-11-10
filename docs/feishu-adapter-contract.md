# 飞书 DM adapter 实施契约

状态：2026-11-10 F0、F1、F2a 投递/授权、F2b 真实 SDK 装配与 F3 绑定界面均已集成，各自通过全量 CI 与独立审查修正；真实平台联调未开始。本文约束首个飞书 adapter，不表示真实平台联调通过。产品边界沿用[个人助理与 channel 决策](personal-assistant-decisions.md)，实施状态见[推进记录](feishu-adapter-plan.md)。

## 架构选择

采用候选 A 的身份、不可变路由、连接 epoch 与原子接纳结构。吸收候选 B 的小型 transport 端口及静态装配方式。首期只装配飞书，不建立动态 registry、通用工作流或另一套聊天 executor。

候选 A 位于 `t3-d120f55d/.verify/feishu-design`，B 位于 `t3-fd5399e1/.verify/feishu-design`。独立交叉审查在 `/tmp/sprout-feishu-cross-judge.md` 给出六项评分 A 27、B 17。父线程复核的决定性依据是本仓库使用 better-sqlite3，现有 `sendMessage` 的 requestId 不提供幂等；B 的两跳提交及重连不变的扫描水位不能满足原子接纳和不补发离线历史。评分是设计判断，不是运行测量。

设计红旗检查后的收敛如下。

- SDK 类型、平台鉴权与 token 获取留在飞书 adapter，领域只接受已核验平台身份和标准输入。
- 绑定模块独占身份、challenge、路由与 epoch 的状态变更。调用者不能用一串 validate / load / save 步骤自行拼接授权。
- 投递模块独占 outbox 和发送状态，transport 不读取业务数据库，不重复判定业务权限。
- 接入复用原生消息、watch 与提案入口，避免两套操作路径。候选的完整类型草图不直接复制为生产接口。

## 身份与接续关系

平台应用配置、长连接、Human 身份关联和目标 DM 分别建模。每个 Project 配置自己的飞书自建应用，凭据由 Project 级渠道配置持有（见「渠道配置存储」），不进入卡片值、普通日志或 Agent 可读的输出。

平台身份使用经 adapter 核验的应用、tenant 与 open_id 组合，不以昵称、邮箱或外部传入的 Sprout userId 识别 Human。open_id 的应用作用域必须保留。飞书身份按 Human 与 Project 各存一条，因为 open_id 随应用变化。同一 Project 内一个 Human 只有一个有效身份，一个平台身份也只能关联一个 Human。

已登录 Human 从 Web 发起有期限的一次性 challenge，显式选择有权访问的 Project 与普通助理 DM。challenge 是 8 位字符的可手输码，熵来自密码学随机源（40 bit），仅保存摘要；长度或字符集不合法的输入在任何数据库读取前就被拒绝，普通聊天文本因此不会被当作绑定尝试，输入接受大小写、空格与短横线变体；飞书私聊中由稳定身份完成确认。默认有效期十分钟，重发产生新 challenge 并使旧 challenge 失效。冲突返回可理解的错误，不覆盖另一 Human 或已有平台身份。账号换绑必须先解绑。

目标只能是该 Human 可使用、Agent purpose 为 assistant 的普通 DM。路由保存明确的 Project 和 Chat，不以最近使用会话自动选路。每个 Human 在每个 Project 各有一条活动路由。切换目标创建新路由，旧路由终结；代次变化使旧 challenge、旧接纳资格和未发出的投递失效。解绑不删除消息、提案或已接纳工作，也不隐式停止工作 Agent。

## 连接 epoch 与离线边界

每次进程启动或连接中断关闭原 epoch。首次 ready 和 reconnected 回调分别打开新 epoch；不能仅依赖回调中的连接状态快照。真实 SDK loopback 探针已证明 `onReconnected` 内快照仍可能是 reconnecting。

普通入站消息必须同时满足当前 epoch、当前路由代次、身份和 Human 权限。平台可信的消息创建时间不得早于当前 epoch 或当前路由生效时间；本机从未见过的旧消息也不能靠重连进入新会话。平台时间的解析、精度和本机时钟偏差需在 adapter 验证中明确记录，未知时间格式拒绝接纳，不假定消息 ID 自带新鲜度证明。

新绑定或重连不扫描聊天历史来补发。出站候选只在新的原生消息提交时捕获，当时无有效连接或路由则不创建待补发记录。已捕获但未交付 transport 的旧 epoch 候选在重连后抑制。已经开始的请求允许完成记录，但不得改送新身份或新目标。

已送达卡片的授权与出站投递不同。卡片发出后仍可能被点击，因此只要求当前 route、revision、Human 与 app 身份，不要求发送时的 epoch 仍然开放；重连不能让已发出的卡片失效。解绑、换路或失去权限必须让旧卡片立即失效，重复点击只复用同一原生确认结果。

同一个 app 在任一时刻只允许一个进程收事件，由 `feishu_connection_lease` 按 `app_id` 保证。抢占与续约共用一条 `ON CONFLICT(app_id) DO UPDATE ... WHERE holder = excluded.holder OR expires_at_ms <= ?` 语句，靠 SQLite 的单语句原子性避免两个进程同时成功。抢不到就不建立长连接，连接快照报 `failed` 且 `error` 为 `lease_held`，并保持可被再次 `start()` 的未启动状态；续约发现行已被别的持有者接管时报 `lease_lost` 并立即拆掉连接与投递循环。租约默认 20 秒，每 5 秒续约，正常退出释放。跨机器共享同一个 app 不在支持范围，因为两台机器的数据库不共享。

## 入站与原生操作

平台 message_id 在应用作用域内去重。receipt 与原生 `sendMessage` 写入处在同一个 immediate transaction 内，成功结果引用同一 messageId。外层回滚必须同时撤销 receipt、消息及相关 run/input；不能将 requestId 视作去重键，也不能先提交接纳再异步 drain 一次原生发送。

文本输入以绑定 Human 的身份进入选定助理 DM，保留外部来源关联，不伪装成 Agent、程序通知或模型 system role。不接受飞书输入任意指定 Human、Project、Chat 或工作 Agent。

卡片确认使用不可猜测、持久化且绑定 route、Human、具体 proposal 或 watch intent 的 grant。回调不能靠自报 proposalId 直接授权。业务动作与回调 receipt 原子提交，调用原生 `confirmAssistantProposal`、watch 确认或拒绝入口。Web 与飞书重复或竞态确认同一工作，只能返回同一个工作提交。内容、目标或绑定变化后，旧 grant 不能继续授权。

## 输出投影与发送

同一 DM 的助理回复及主动通知发给该 DM 当前可发送的所有绑定入口，与输入来自哪里无关。首期只投递已持久化的助理文本、助理事件的用户可见摘要，以及明确的确认卡片。Human 输入、内部 facts、工具日志、LLM context 和流式 token 不镜像。无完整最终回复时必须说明不完整。

外部投影默认拒绝未知事件形状。当前 Web 的 `assistantEventSummary` 末尾仍可能从 fact.body 生成预览，不能直接将该兜底作为外发许可。发送阶段还要复查 source、target 的当前访问权、route 代次和 epoch，不能仅信捕获时的快照。

transport 准备凭据和平台 payload 可以异步进行。最终发送前先持久化 armed attempt，再在短同步 writer 临界区重查资格，并调用无 await 的 `begin()` 创建请求；等待网络响应在事务外进行。armed 必须先于 begin 单独提交，避免交付请求后事务回滚或崩溃造成 attempt 消失。恢复时无法排除已交付的 armed attempt 也标记 uncertain。这里的 begin 表示本机已把请求交给 transport，不表示平台已接受。必须用真实 loopback HTTP 和 writer 竞态探针证明这一边界，不能只用返回 Promise 的假函数代替。禁止持锁等待网络。

准备阶段（换取 token、组装 payload）失败没有向平台发起任何请求，属于可证明未接纳，必须计入 attempt 并退避重试，不能直接丢弃回复；重试耗尽或超过截止时间才终结。

成功保存平台 message_id。明确未被平台接纳的失败可以受限重试；连接、身份、路由和权限仍需复查。ack 丢失、进程在交付后崩溃或平台是否接纳无法判断时标记 uncertain，停止自动重发。飞书 UUID 仅保证一小时去重，不能据此重发任意年代的请求或宣称跨崩溃 exactly-once。投递重试始终不重跑工作。

## 渠道配置存储

渠道的应用配置属于 Project，不属于部署，也没有环境变量入口。每个 Project 配自己的飞书自建应用，不同 Project 可以用不同应用并发在线。一个应用只能属于一个 Project，保存时校验跨 Project 的 appId 不得重复，否则入站消息无法判断归属。绑定身份与活动路由按 Human 与 Project 各一条。

通用表 `channel_config` 以 `(project_id, kind)` 为主键，一个 Project 的一种渠道一行：

- `enabled` 决定该 Project 的这个渠道在运行时是否启动。
- `settings` 存非机密字段的 JSON，形状由 `kind` 决定。
- `secrets` 存机密字段的 JSON。它按可回读明文保存，与 webhook secret 同类，不声明静态加密。
- `revision`、`updated_at_ms`、`updated_by_human_id` 支撑乐观并发：写入时 revision 不匹配返回冲突，不覆盖另一 Human 的保存。

渠道类型注册表是唯一知道字段形状的地方。它声明标签、`settings` 与 `secrets` 的 schema、必填组合，以及由配置派生出的 transport 配置。表本身只存 JSON，不为单个渠道加列，新增渠道不改表结构，也不为飞书单开一张配置表。飞书的 `settings` 目前含 `origin` 与 `appId`；origin 只接受飞书 / Lark 官方域名与回环 http，appId 校验 `^cli_[0-9A-Za-z]{16}$`。

读取分两种出口。页面与普通查询只拿非机密字段和 `hasAppSecret`，`secrets` 不出现在任何 DTO 里；用户要换密钥就重新提交一次，不提供回读。运行时在启动装配时为每个已启用且字段完整的配置建一个 runtime，保存成功后在同一进程内只停掉该 Project 的旧 runtime 再按新配置重建，不重启进程，也不影响其他 Project。同一 Project 的并发保存串行执行，避免两个连接同时使用一个 appId。

配置不完整视为未配置。`enabled` 为真但缺必填字段的保存被拒绝，因此不存在「已启用但起不来」的持久状态。语义相同的环境变量一并删除，不保留双读。

入站消息由处理它的 runtime 归属到该 Project，admission 还要核对路由的 `project_id` 与 runtime 的 Project 一致，不一致按未知路由拒绝。

## 单元与验证门槛

| 单元 | 可审查结果 | 必须实际验证 |
| --- | --- | --- |
| F0 风险探针 | 可重复事务与 HTTP harness，先于依赖它的实现 | 嵌套 rollback、receipt 与 native 原子性、同步 begin 与解绑先后、网络等待不持锁；不通过则修订契约 |
| F1 身份与入站 | 最小 schema、绑定/换路/epoch、文本接纳领域入口 | 唯一身份冲突、challenge 重放/过期、旧 epoch 与旧消息、解绑及失权、重复输入只有一个 message/run input、迁移保留原生数据 |
| F2a 投递与授权 | 可复用投递端口、持久 outbox/attempt、受控投影、action grant | 捕获与源消息同事务、默认拒绝投影、armed 先于 begin、ack 丢失与崩溃 uncertain、Web/卡片同一原生确认 |
| F2b 平台装配 | 飞书 WS 入站、同步 begin 出站、单 owner 生命周期、运行时与服务器边界 | 旧 generation 不能改 epoch、ACK 不等于接纳、准备失败不产生请求、断线不回放 |
| F3 UI 与平台评审 | Human 选定的绑定入口、配置说明与可操作预览 | 桌面/手机流程、异常与撤销、原数据保留；真实平台收发另列证据 |
| F4 渠道配置 | Project 级 `channel_config`、渠道注册表、Human-only 保存入口、按 Project 重载运行时、身份与路由按 Project 分条 | 必填与格式拒绝、跨 Project appId 重复拒绝、revision 冲突、secrets 不出现在 view、保存后该 Project 旧 runtime 停止且新配置生效而其他 Project 不受影响、升级保留已绑定数据、环境变量入口已删除 |

F0 与 F1 可由同一个隔离写者先后完成，风险探针失败时不得继续堆积 schema。共享契约及迁移保持一个写者。F1 不暴露未经平台核验的公共 HTTP 入口，不改现有评审库，不等 UI 选型，也不预建 F2 的空表。首次接纳复用原生领域，运行时装配在 F2 完成。

## 当前证据与限制

已执行真实 SDK 1.76.0 与 loopback WebSocket 的 ready / reconnecting / reconnected 探针。候选 A 的发布包静态检查及 standalone types 编译、两模型架构对比、独立交叉审查均已完成。F0 的真实 SQLite/loopback HTTP 探针也已执行通过，包括外层事务撤销原生消息与 receipt、同步 begin、响应未完成时另一 writer 可解绑。F1 父线程发现并修复 pre-route 延迟输入，绑定和切换两项用例先失败后通过。候选 CI 为 133 文件、1192 项测试通过；独立功能审查未发现 F0/F1 范围内成立的 P1/P2。旧 lifecycle 的 ready/reconnected 所有权由 F2 runtime generation 约束，尚未验证实际 SDK 装配。

F2a 与 F2b 的实际验证：F2a 定向 3 文件 30 项、assistant-core 22 文件 155 项、全量 CI 136 文件 1222 项通过；F2b 定向 8 文件 104 项、全量 CI 141 文件 1272 项通过。F2b 的 TLS/WS 装配只有回环证据，没有真实平台会话。

真实飞书凭据、平台身份确认、卡片回调、权限配置及实际设备体验均为 NOT VERIFIED。界面两方案已在当前线程展示，Human 尚未选型。未选型前不实施新的绑定页面。
