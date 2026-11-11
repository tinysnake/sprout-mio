# Human 体验反馈修订记录

本记录对应 2026-11-09 的 Human 反馈。范围只包含 webhook、定时规则和原生助理反馈。飞书、语音与其他后续能力不在本轮开发范围。修订已完成实现、专项技术验证及独立审查发现的修正，Human 体验确认待继续评审。

## 授权与执行方式

Human 授权在休息期间持续推进，可以判断的产品选择自主决定并记录；可逆的小决定不等待 Human。后端与前端分别使用独立 worktree，后端单独维护共享契约和数据库，父代理负责集成、实际复验和更新原预览。技术通过不代替 Human 体验确认。

## 实现与自主决定

| 反馈或决定 | 实现及边界 |
| --- | --- |
| Project settings 分为基础信息、Webhooks、定时任务 | 基础信息为默认入口，URL 明确保存 `tab=general/webhooks/cron`；原有基础设置保留。 |
| 自动化列表与独立编辑页 | 列表显示启停、目标和定时信息；新建及编辑使用独立 URL，支持深链和返回。沿用项目列表与 Button 样式。 |
| 指令框、按钮与共享 UI | Webhook 和 cron 共用编辑器及动作选择、Trial、历史；内容区限制宽度，手机表单不横向溢出；导航使用真实链接，提交按钮保留稳定名称及 loading 状态。 |
| 时区和 cron 帮助 | 下拉包含 UTC、固定偏移及常见 IANA 地区；已有非预设时区保留。固定偏移使用 `Etc/GMT` 的反向符号，地区时区保留 DST 语义。表达式旁提供帮助。 |
| Public Channel 目标 | Group 指定 Agent 与 owner 动作接受 Public Channel，继续检查当前有效成员、owner 和工作 Agent 身份。 |
| DM 不要求预建 Chat | 规则直接选择 Project 中的工作 Agent；保存不创建 DM，首次有效真实触发时创建或复用该 Human 的规范 DM。外部 payload 不能改目标。助理提案也可只传 Agent，由提案入口解析并固定有效 DM，Human 确认后才提交工作。 |
| Secret 可再次查看且默认遮蔽 | 新 secret 的恢复值保存在私有 SQLite，Human 管理 API 检查 session 与 Project 权限后返回；外部入口仍用 SHA-256 digest 校验。浏览器不持久保存 secret，重新加载默认遮蔽。此实现依赖数据库及备份的访问权限，不声称静态加密。 |
| 旧 secret 与轮换 | 旧数据库只保存哈希，无法恢复原值；页面提供轮换，旧 secret 随即失效，不伪造可恢复值。 |
| 两种自动化的触发历史 | 编辑页展示最近记录、跳过或取消原因、原触发 Chat/run；配置改变不改写旧记录关联。 |
| 每条 watch 独立周期 | 移除助理 DM 全局周期编辑器；工具可传 `intervalSeconds`，默认 300 秒，范围 60–86400 秒。Agent 可按 Human 需求设置或调整已有关注周期，不能借此扩大目标或绕过首次关注确认。 |
| 关注周期合并与迁移 | 同 DM/run 有多条有效 watch 时采用最短周期；仅提案关注使用 300 秒。旧 DM 周期复制到其已有 watch，保留历史关注授权；修改周期会重算相应未结束 run 的下一汇报时间。 |
| `sprout_assistant_observe` 报错 | 原 remote client 将助理响应落入执行/租约解析分支，导致 `invalid_response`。新增严格助理响应契约并在对应分支解析，未把错误归因于显示的 worker 0.1.0 版本号。 |
| Amenda 传话闭环 | 实际安装 Pi 1.5.0 运行观察、按 Agent 提案、Human 幂等确认、工作 Agent 回复及 watch 意图确认；模型使用回环 fixture，未调用付费提供方。 |

## 已执行的技术验证

父代理在集成 checkout 实际执行了 `pnpm typecheck`、`pnpm check`、build、专项浏览器与门禁。Webhooks、cron 和助理使用 production app、真实 Pi runner 与回环模型，记录 `paid-model-calls=0`。桌面和手机截图已经实际查看。当前结果与限制如下。

- 首轮完整 `pnpm verify` 为 107 项中 93 通过、14 失败，未宣称全部通过。
- 修正新导航 URL、真实链接语义与保存中按钮名称后，11 项定向复验中 10 项通过；余下租约集成仍等待旧 settings URL，修正后单独复验通过。原有认证、错误映射、Machine 与租约检查也已复验通过。
- 审查修正后的最终 `pnpm test:ci` 为 128 个文件、1148 个测试通过；runner 94.33 秒。`pnpm check` 为 0 errors、17 条既有 warnings，文档链接与 diff 检查通过。
- 旧基线复跑 10 项，6 通过；4 项 SDK、远程工具和部署演练失败与本轮无关，仍保留记录。SDK 故障还会使全量 `pnpm test` 的 skills catalog 用例失败；CI 范围另行记录。
- Webhook 浏览器证据位于 `.verify/webhook-1794160395927`，cron 位于 `.verify/cron-1794160308441`，助理位于 `.verify/assistant-1794160371151`。这些是集成 worktree 的技术证据，不能代替 Human 批准。

验证过程中曾错误预期助理提案的目标 Chat 为空；实际契约会解析有效规范 DM。该次失败属于测试假设错误，已修正，未据此修改业务模型。延迟保存用例检查编辑锁和不同规则的持久配置，不只检查界面文字。

## 独立审查与修正

独立技术审查确认一项 P2。助理成功响应原先只校验宽泛 schema，可能接受与本次请求不同的 observe 分支、超过请求 limit 的记录或目标、正文不匹配的提案。客户端现在同时校验请求的查询分支、数量上限和 run id，并比较提案的 Project、目标类型、显式 Chat、Agent 与正文。按 Agent 提案仍允许服务端补上有效规范 DM。明确指定的 watch 周期也必须匹配返回值。

真实 HTTP 回归先证明错误响应会被接受，修正后通过；有效的 Agent-only 提案继续通过。修正后重新构建、运行 CI 及完整助理浏览器门禁，实际 Pi 的观察、提案、Human 确认、Amenda 回复和 watch 周期闭环均通过，`paid-model-calls=0`。记录位于 `/tmp/sprout-feedback-protocol-{red2,green,browser,ci}.log`。Comment audit 对新写或改写内容没有发现，未新增 suppression。

## Human 体验状态

本轮实现已集成到当前分支，集成 commit 为 `1569166`。原评审数据库已备份并迁移，`http://127.0.0.1:3300` 已更新为修订版并实际打开检查；旧的 4 条消息、3 个 Chat、2 个 Agent 及 2 条自动化规则的原内容均保留，外键检查通过。迁移与数据保留收据在 `.verify/human-review/run.JtVeWy/feedback-update.json`。技术验证不自动勾选 Human 体验验收。飞书、语音和其他 backlog 没有推进。

## 第二轮页面与表达反馈

Human 反馈了重复分隔线、列表按钮贴边、cron 帮助位置、提案随消息滚走及助理通知难读的问题。本轮采用 Experience First，将待确认操作和简短进展放到容易找到的位置。

- 自动化列表保留 tabs 下的一条分隔线，工具栏与规则列表间隔 16px。
- cron 帮助使用表达式输入框右侧的圆圈问号图标，点击展开语法说明，保留可访问名称与移动端边界。
- 助理面板位于消息滚动容器之外、输入框上方。待确认提案优先展开；已提交或失效记录默认收起。面板独立限制高度，避免历史记录挤走消息与输入框。
- 提案展示执行者、目标名称及工作摘录，完整指令可以展开查看。摘录不重写已固定的实际操作，确认、幂等与权限边界沿用原实现。
- 程序通知新增显示摘要，按已记录的事件区分待确认、已确认、拒绝、撤销、处理中、已回复和需要介入。显示名称与耗时，周期通知保留当前动作与动作耗时。完整原始事实留在详情和助理上下文中，历史事件的状态不会随提案当前状态变化。
- 助理后续回合的系统指令与提案工具说明要求先说结论、使用名称、避免罗列内部 ID 或复述日志。既有模型聊天正文作为原记录保留。程序通知摘要直接由事实生成，不额外调用模型。

第二轮实际执行 `assistant-core` 门禁，14 个文件、83 个测试通过；`pnpm typecheck`、`pnpm check` 与 build 通过，check 保留 17 条既有 warnings。助理、Webhook、cron 的完整浏览器门禁均通过；最后补充排队状态快照后，再次执行完整助理浏览器门禁通过，使用真实 Pi runner 与回环模型，付费模型调用为 0。本轮没有重跑全部 CI 或完整 `pnpm verify`。

桌面与 390px 手机截图已实际查看，验证待确认提案停留在输入框上方，滚动消息不会带走提案。原评审预览 `http://127.0.0.1:3300` 已通过热更新显示本轮修改，保留原数据。浏览器证据位于 `.verify/assistant-1794192092228`、`.verify/webhook-1794192117101`、`.verify/cron-1794192126864`，最终助理复验记录为 `/tmp/sprout-four-feedback-final-assistant.result.json`。排队通知保留采样时的状态与等待时长，不会因工作后来开始而改写旧通知。Human 体验确认仍待反馈。

## 第三轮页面、频道汇总与停止关注反馈

本轮由两个独立 worktree 分别实现 UI 和领域行为，父代理集成后实际复验。以下行为取代前两轮相应显示与 watch 通知节奏。

- Cron 帮助移至表达式输入框之后，使用现有 Popover，支持点击外部和 Escape 关闭。
- 输入框上方只显示仍需确认的工作提案或关注请求。已提交、过期、已处理的记录不占位；没有待确认内容时整个容器不渲染。关注管理移到标题栏菜单。
- Public Channel 使用固定公开频道名称，不再回退为参与 Agent 的名字。
- 每条 watch 按自己的时间窗口汇总 Chat 消息和工作活动，无内容不发通知。只被 watch 覆盖的 run 不再逐个即时报告结束；提案委派工作的即时结果仍保留。摘要由程序事实生成，不唤醒助理模型，也不推断业务成功。
- watch cursor 持久保存窗口和消息位置；迁移保留 consent，从当前边界开始，不重放历史。来源消息与 run 各最多记录 50 个标识，正文摘录最多 4 条消息和 3 条 run 活动，超限注明截断。
- 确认与取消消费对应 intent。刷新不会恢复旧确认，新请求可以重新申请。`sprout_assistant_watch` 的 `active: false` 经真实 Pi 工具链直接停止当前 DM 的关注，重复停止幂等，不取消工作。

Model the Domain 原则促使本轮将周期汇总建模为独立 watch window cursor，而不继续在逐 run 通知上叠加条件。独立技术审查发现候选 run 先截取 50 条再检查变化会漏掉第 51 条活动；新增回归先失败再通过，现按页扫描变化后计入限额。扫描内存按页有界，读取量随候选 run 数量增加。Comment audit 的 7 处冗余注释已删除。

父代理实际执行完整 `pnpm verify`，107 项中 102 项通过、5 项失败。4 项是已确认的 SDK、remote tools 和 deploy 基线问题；新增的助理浏览器失败来自仍期待 watch 即时完成通知的旧断言。修正后专项复验 `assistant-core,assistant-browser,cron-browser,webhook-browser` 全部通过，耗时 91.51 秒。最终 CI 独立重跑通过，130 个文件、1162 个测试，runner 94.22 秒。首次 CI 在与依赖准备并发时未能加载 `oxc-parser`，没有执行测试；不计为测试失败或通过。

`pnpm typecheck`、`pnpm check` 通过，check 保留 17 条既有 warnings。真实 Pi 的观察、Agent-only 提案、Human 确认、Amenda 回复、watch 确认及工具直接停止均通过，付费模型调用为 0。Browser 通过注入 watch 截止时间验证新汇总进入活跃助理的 steer context；59/60/120 秒与重启窗口由 core 注入时钟验证，未声称浏览器真实等待了 60 秒。

专项报告在集成 worktree 的 `.verify/runs/2026-11-09T08-30-14-273Z-62826-0/report.json`；浏览器证据在 `.verify/assistant-1794213068762`、`.verify/cron-1794213023930`、`.verify/webhook-1794213096277`。最终 CI 记录为 `/tmp/sprout-round3-ci-final.result.json`。

本轮修订已集成为 `ffa2d61`。原 `http://127.0.0.1:3300` 预览已使用原数据库重启并完成 migration 0047；迁移前备份为 `.verify/human-review/run.JtVeWy/app.pre-round3-ffa2d61.sqlite`。59 条消息、3 个 Chat、2 个 Agent、2 条自动化规则、4 条历史关注以及 Project 行均逐行比对保持一致，外键检查通过。收据位于 `.verify/human-review/run.JtVeWy/round3-update.json`。

原预览 DOM 复核确认无待确认内容时不渲染面板，Cron 帮助按钮在输入框之后，点击外部和 Escape 均关闭。实时 `preview_snapshot` 两次超时，因此未取得本次原预览截图；已实际查看通过门禁生成的桌面和 390px 手机截图。自用检查 tab 已关闭，原预览服务保留。Human 体验确认仍待反馈。

## 第四轮反馈修订

本轮处理语义总结、有效关注列表和拒绝关注请求。两个独立 worktree 分别实现 UI 和领域行为，父代理集成、修复独立审查发现并实际复验。以下约定取代第三轮“不调用助理模型生成摘要”的行为。

- 有内容的 watch 窗口通过独立 Pi 模型调用归纳发生的事情、变化与待 Human 决策事项。沿用助理的模型与 effort，没有 session history、extensions 或 tools。原始窗口不可变保留在事件事实中，摘要单独持久化。模型失败明确提示失败；旧版通知明确标记旧记录，不自动补算或重发。
- 总结 job 持久保存尝试、lease、fencing token 与结果，全局并发最多 2，子进程超时 90 秒、lease 120 秒、最多尝试 3 次。claim、生成结束与投递均重新核对有效关注和当前权限。投递前筛选已就绪事件，避免 100 条未完成总结挡住其他 DM 的 decision 或已完成摘要。
- 标题栏始终显示“正在关注”的数量，手机也保留文字。完整列表显示目标名、私聊 / 群组 / 公共频道类型、Project、周期和取消操作；空列表显示“暂无关注”。长列表有独立滚动区域。
- 待确认关注同时提供确认和拒绝。拒绝以 Human、助理 DM、准确 intent event 为范围持久保存，重复调用幂等，不会误停现有关注。失败保留重试，成功立即收起，刷新不复活；新的明确请求仍能确认。

Model the Domain 原则促使原始窗口和异步模型结果分开建模。Boundary Discipline 原则促使权限在 claim、finish、delivery 三处重查。独立审查指出全局投递队列被未就绪总结阻塞，跨 DM 回归完成 RED→GREEN。Comment audit 的两行新增冗余注释已删除。

父代理首次专项验证暴露共享测试遗留任务以及旧浏览器 fixture 未配置独立总结响应。已修复隔离和模型 fixture。手机即时测宽连续失败后按 Attack the Premise 原则记录 DOM 探针，确认 viewport 切换时控件短暂零宽，随后恢复为 92.14px；改为等待控件可见，不修改真实样式。Reject fixture 的请求释放等待 handler 完成后再 unroute，消除重复处理同一 route。

最终实际 CI 通过，130 个文件、1170 个测试，runner 93.26 秒。assistant-core 与 p7-pi-inheritance 专项均通过；完整 assistant-browser 门禁通过，包含真实已安装 Pi、独立总结进入活跃助理 context、工具直接停止、Reject 刷新不复活、Group / Public Channel 元信息、新请求再次确认，以及独立 Pi 总结测试 3/3。付费模型调用为 0。Typecheck、check、build、文档检查和 diff check 通过，check 保留既有 warnings。

最终浏览器证据位于集成 worktree 的 `.verify/assistant-1794230462872`，父代理实际查看桌面和 390px 手机截图。CI 记录为 `/tmp/sprout-round4-ci-final.result.json`，浏览器记录为 `/tmp/sprout-round4-browser-green.result.json`，队列回归为 `/tmp/sprout-round4-queue-red.log` 与 `/tmp/sprout-round4-queue-green.log`。Loopback 固定输出证明模型配置、隔离、摘要持久化及投递链路，不证明真实付费模型对闲聊、注入文本和复杂任务的语义质量。未重跑完整 107 项验证，不将四项已知 SDK / remote / deploy 基线问题标为修复。

第四轮实现已集成为 `4d12c9b`，原 `http://127.0.0.1:3300` 服务使用原数据库完成 migration 0048 后恢复。迁移前备份为 `.verify/human-review/run.JtVeWy/app.pre-round4-6b2aedb.sqlite`；85 条消息、3 个 Chat、2 个 Agent、2 条规则、5 条历史关注、26 条事件及 Project 行按原列比对全部一致，外键检查通过。收据为 `.verify/human-review/run.JtVeWy/round4-update.json`。

原页面 DOM 复核显示“正在关注 0”，打开后为“暂无关注”，无待确认面板和桌面横向溢出。原库没有有效关注，更新过程未调用付费模型。实时 snapshot 一次超时；resize 设置未实际改变 live viewport，因此不声称本次原预览已做手机视觉检查。父代理已查看门禁中的桌面与 390px 手机截图，手机功能与布局由实际 browser fixture 验证。自用 tab 已关闭，原预览服务保留。四个子任务均已收尾。Human 体验确认仍待反馈。

## 固定时区偏移与当前默认项

按 Human 最后反馈移除常用地区目录。新建默认“当前时区”，浏览器挂载后显示本地 UTC 偏移，保存时重新读取并冻结为分钟精度 `±HH:MM`。列表提供 -12:00 至 +14:00、每 15 分钟一个的固定偏移。已保存 IANA / Etc / UTC 原值保持不变，只显示单个“已保存”项，直到用户明确选择替换。此处按 Model the Domain 原则共享偏移解析与格式化，避免调度和界面各自解释偏移。

实现 commit 为 `c3d95d9`。父代理实际复跑 cron-core（14 个文件、148 个测试）及 cron-browser 均通过，runner 总计 43.834 秒，收据 `/tmp/sprout-cron-zone-parent.result.json`；另复跑 typecheck、check、build 通过。浏览器覆盖当前默认、半小时 / 45 分钟偏移、保存时跨 DST、不同浏览器时区 reload / 编辑保留、旧值保留和明确替换。付费调用为 0，未重跑全套 CI。

已通过 Vite HMR 更新原局域网预览，无数据库 migration。父代理在 `http://10.0.0.13:3300` 的真实新建页读取 DOM，确认默认值为 `current`、文案“当前时区（UTC+08:00）”，与该浏览器 480 分钟偏移一致，选项无地区目录。检查未保存规则或改写原数据，自用 tab 已关闭，子任务已收尾。Human 体验确认仍待反馈。

## 最后分隔线修复与评审收尾

2026-11-09 Human 表示其他部分无问题，要求基础信息重复分隔线修复后由执行者截图确认并进入下一环节。根因是 SettingsTabs 的底边与 ProjectBasicInfoForm 的 SettingsSection 顶边叠加。复用现有 `divided={false}` 去掉表单顶边，保留 tab 底边，不增加样式特例。

父代理先在原局域网服务重现 1px 表单顶边，再用真实 Chromium 复验桌面 1280×900 与手机 390×844。两者均为 section 顶边 0px、tab 底边 1px、无横向溢出，已实际读取并查看两张截图。证据为 `.verify/human-review/run.JtVeWy/general-border-desktop.png`、`general-border-mobile.png` 和 `general-border-check.json`。首次脚本使用不存在的 test id 导致等待超时，改用真实 `project-edit-name` 后成功；未将超时计为验证通过。typecheck、check 和 diff check 通过。本次是可逆的一行展示修复，未新增测试或重复整套门禁。原数据没有写入，Chromium 自用实例已关闭。

Human 的有条件确认已满足截图条件，本轮 webhook、cron、原生助理与设置 UI 评审收尾。按照开发总计划进入飞书 DM adapter 的原项目实现与官方接入契约调查。后续新页面仍遵循现有设计确认流程，PWA / 语音及已记录的技术未验证项继续保留。

## Chat 关联 Task 条带与发送提示反馈

2026-11-11 Human 在真实 Chat 页指出两处：标题栏上方并列两条「已完成」Task，与 Info Hub 的「Task 摘要」重复；发送成功后残留 `发送消息 · 成功`。Human 决定直接删除条带（在 Info Hub 看即可），发送提示也不需要（发送框本身已能看出发送结果）。

条带来源是 Chat index 路由按 `liveInfo.data.tasks.items` 渲染的全量关联（`getChatInfo` 不按状态过滤），它在 `?info=1` 的 Info Hub inspector 里已有一处。按“同一事实只出现一次”删除该块，任务关联只在 Info Hub 保留一处，vector 化与跳转不变。

动作结果的那串文字整个删掉，不保留任何状态。Human 在第二轮确认：“那一串文字不管什么是成功还是失败还是未知，都删掉”。因此 Chat 页不再渲染 `ActionOutcomeNotice`：进行中由触发控件自己表达（发送按钮 `aria-label="发送中"`、停止按钮「停止中…」且禁用），成功由页面事实表达（消息入列、草稿清空、run 状态刷新），服务端拒绝由 composer 的错误行表达（`message-error` / `run-stop-error`）。`src/components/ui/action-outcome.tsx` 已无调用方，一并删除；P7 契约的「动作结果三态」改为「动作结果不出独立提示条」，`unknown` “不补成成功也不补成失败”的语义保留，但改用可核对的现场表达：草稿仍在输入框、列表里没有这条消息。

代价如实记录：请求中途抛出（结果可能已落库）与断线早退现在都是沉默的，唯一线索是草稿没有被清空；服务端正常返回的拒绝仍有错误行。

真实页面门禁随契约更新：`scripts/browser/p7-client-states.mjs` 的 send 与 stop 分支都断言 `send-outcome` / `stop-outcome` 节点数为 0、进行中只体现在按钮文案与禁用、成功看草稿清空、服务端拒绝看 composer 错误行、结果未确认时无错误行且草稿保留，离线块改为断言调用数为 0 与草稿保留；`scripts/browser/p7-client-pwa.mjs` 的离线发送不再等提示条，改为断言不出现 `send-outcome` 且草稿仍在（写请求由后续 `writes === 0` 断言覆盖）；`scripts/verify/as-p5b-task-pages.sh` 改用 `aria-label="关联 Task"` 计数 0 断言条带来源已消除，inspector 侧继续断言 `task-associations` 存在。

同日 Human 又指出输入区左下角的 `开发一组 · 已完成` 小字。它不属于动作结果（与刚删除的提示条作用不同），是常驻的输入区状态行，但把页头徽标已有的 run 状态和 placeholder 已有的 Agent 名又并排重复了一次。改为只保留输入区独有的语义：进行中显示「追加到当前轮」，`已停止` 显示「已停止，可开始新一轮」，其余状态不再渲染；输入按钮靠 `ml-auto` 保持右对齐。run 状态读取失败另有消息区的 `run-state-load-error` 与新消息上的「分身运行状态」表达，输入区不做兜底。

`src/components/chat/message-composer.tsx` 的这处改动随之纳入：门禁里没有引用被删除的三个字符串，p7-client-states 里输入区仍可见运行中的「追加到当前轮」，因此门禁无需改写。

父代理实际复跑：typecheck、check 通过（16 条既有 warning 不变），p7-client-states 与 p7-client-pwa 全通过，as-p5b 21 项 checks 通过。RED 复现方式为临时撤下路由改动重跑门禁，报 `Chat 正文上方不再重复 Task 关联条带 1 !== 0` 后恢复。父代理实际读图 `.verify/as-p5b-task-pages/evidence/chat-task-associations.png`，确认 Chat 顶部只剩标题与运行状态、inspector 内仍有 Task 摘要，且输入区左下角不再有 `Task UI Agent · 宿主未启用` 那行小字、发送按钮仍在右侧。改动位于 worktree 分支 `t3/fix-chat-completed-tasks-summary`，未重跑完整 CI，未改动数据库与原型服务。Human 体验确认仍待反馈。

## Chat 页信息去重（16 条审查 → GPT 评审 → 整改）

2026-11-11 Human 在同一轮里要求：「你在检查一遍这个chat界面有哪些信息是重复的多余的都指出来」。审查基准是`docs/frontend-design.md` 的「同一事实只出现一次」，证据为代码与门禁实拍。共列出 16 条（按左栏、中栏页头、消息区、右栏分组），其中标为重的是：同一 Chat 在「待处理」与「最近对话」各列一次、run 状态在中栏页头/消息区/右栏各表达一次、消息区「未关联 run · 不推断归属」逐条占位、右栏内嵌整块 Info Hub 的 Chat 事实与成员（Instance ID 与消息数、成员名单、分身租约各与右栏自己的段重复）、右栏活动段把 run 数了三遍。

Human 随后定了流程：先把建议交给 GPT 子代理看它认不认可，认可就按它修；修完用网页截图做前后对比，交回同一个 GPT 子代理按五条评分机制（同一事实只出现一处；信息出现在与它有关的地方；重要程度有区分；密度张弛有度、说明文字藏进问号或默认折叠；排版舒服、分区与 item 区分明显）打分，8/10 以上过关，没过关索取下一步整改意见。评审用本机 pstack 角色映射里的 GPT 模型 `magpie/auto/gpt-6.1-sol`（原定 `openai-codex/gpt-6.1-sol` 因本机到 `chatgpt.com` 只能经代理、T3 侧只直连而启动失败，已改用同网关可达的 `magpie/auto/gpt-6.1-sol`）。评审结论：认可主要方向，但不能按字符串重复整块删除；逐条给出同意 / 部分同意 / 不同意，并补两个漏项（`message-composer.tsx` 的「Project 的信息与分析依据，会随 Chat 一起保留。」、`chat-details.tsx` 的「未设置职位」占行）。评审明确不同意的一条是「复制 Chat ID 有两处」——DM 与非 DM 分支互斥，两个按钮从不同时出现，核对代码后采纳。

本轮实际改动：

- 左栏 `chat-list.tsx`：「待处理」不再作为第二个列表，改为同一列表上的筛选 chip（`filter-pending`），删掉列表总数 `chat-count`；筛选为空时文案为「当前没有待处理的对话。」
- 中栏 `chat-thread.tsx`：删页头 run 徽标与 DM 副标题里的职位后缀。页头徽标与消息区的「分身运行状态」在宿主未启用时会互相矛盾（一个「运行中」、一个「宿主未启用」），run 状态收敛到消息区与右栏两处。
- 消息区 `message-list.tsx`：删逐条 persona；`message-kind` 只在自动化来源时保留（Human/Agent 的名字已说明身份）；无 run 归属时不再渲染「未关联 run · 不推断归属」占位，归属逻辑本身不动。
- 输入区 `message-composer.tsx`：删末尾常驻保留说明。
- 右栏 `chat-details.tsx`：拆掉内嵌的 `ChatFactsBlock` 整块；把其中独有且页面上没有的事实迁进成员段的 `<dl>`（归档状态只在已归档时出现、最后消息时间）；删活动段的「活动 Agent」行与状态分布 chip（与 summary、run 明细重复）；改为只渲染活动 run 明细本身；「未设置职位」不再占行。

有意不做的两处，如实记录：一是评审列的「把 pending、恢复草稿、阻塞原因搬到输入区」。`pending-input-count` 的文案与 `run-stop` 的现场被 `o-turn-semantics` 当作契约断言，搬迁属于体验调整而不是去重，本轮保持 run 状态面板为唯一现场，未动 `run-status.tsx`（评审复核时指出严格说仍有两处：右栏活动 run 区在 `run-facts.tsx` 里也会显示同一 pending 计数，且这几张截图都没有 pending 输入，未作为已出现的画面问题计分）。二是评审列的「迁移成员健康事实」——面板里每位成员的 Agent status 与活动段的 Agent 列表在活动成员上是同一事实，随面板一起删除；评审复核认为这条理由不够准确：改前的面板里还有「评审 Agent — 待机中」这类未参与活动 run 的成员状态，改后确实少了一处入口，不恢复整块事实面板，但若产品需要在 Chat 里看到全部成员健康，应在成员行按需展示或走 profile 入口。

连带影响与门禁更新：应用里 Info Hub 的 Chat 视角原本就是会话详情里内嵌的 `ChatFactsBlock`（`info-hub/chat-inspector.tsx` 只在 dev 场景使用），所以面板删除后会话详情成为唯一来源，多处门禁按新契约改写：`scripts/browser/j-info-hub-flow.mjs` 的 `chat_info_panel_matches_page` 改名为 `chat_facts_render_on_chat_page` 并改为断言会话详情自己的 `inspector-*` 事实（同时新增「页面不再出现 `info-hub-chat`」这一条）；`scripts/browser/k-acceptance-flow.mjs` 的 Instance 与消息数断言改指 `inspector-instance-id` / `inspector-message-count`，成员种类改由 `inspector-member-list` 的 `chat-member-select` 判定；`scripts/browser/as-p5a-chat-ui.mjs` 的「未设置职位」断言改为接受空职位不占行；`docs/feature-map/info-hub.md` 与 `docs/p3/info-hub-runs.md` 同步。`docs/frontend-design.md` 里「不擅自删掉三处 run 状态」的规则改为记明这次的明确决定与保留的两处。

改后评分（同一 GPT 模型逐张读 14 张前后对照截图并只读核对组件）：五条机制依次 8.0 / 8.5 / 8.0 / 7.5 / 8.5，均分 **8.1**，达到 8/10 的关口。它确认本轮消除了最影响阅读的重复（同一 Chat 不再列两遍、消息正文不再被 persona 与身份标签和归属空占位打断、右栏不再整块复述 Chat 事实），同时点出五条残留项，均标为可选优化而非未达标：一是右栏诊断（历史空态、上下文快照空态、提交收据、租约空态、实现说明）仍默认平铺，层级不足；二是群聊 Owner 在成员徽标、Owner 段摘要与展开内容里重复，「标题」一行纯复述中栏页头；三是「消息数」「最后消息时间」被归进「成员」段（应属会话元数据），且 ISO 字符串在窄右栏里断行、与消息区的本地时间不易对照；四是 Chats 首页仍有「从左侧选择一条对话继续上下文，或从右上角新建 DM / 群组」这类教学文案，且方位描述与实际不符；五是 pending 输入在中栏与右栏活动区仍有条件性重复。以上均记录为本轮之后的可选优化，未在本轮实施。

父代理实际复跑（均前台完成）：`pnpm typecheck`；`pnpm test` 1463 项全过（首次这套出现一次 flaky 失败，立即重跑通过，未定位到具体用例）；`pnpm check` 0 errors / 16 条既有 warning / 775 文件；`f-docs`；`as-p5a-chat-ui` 31 项；`as-p5b-task-pages` 21 项；`i-chat`；`i2-group-chat` 13 项；`i3-public-channel`；`i6-chat-info` 4 项；`i7-chat-scope` 17 项；`j-info-hub`；`k-acceptance` runner 12 项 0 失败；`o-turn-semantics`；`q-info-hub-runs`；`bf-p6b-pages` 13 组；`r-ui-layout`；`p8b-timeout`；`p7-client-states` 8/8。前后对照截图由 `.verify/review-dedupe/capture.ts` 生成，同数据同视口，存在 `.verify/review-dedupe/before/` 与 `after/`（各 7 张：DM、DM 右栏底部、DM 消息区底部、群聊、群聊右栏底部、手机 390、Chat 列表）。未重跑完整 CI，未改动数据库与原型服务。Human 体验确认仍待反馈。

### 第三轮：四张截图反馈（同日稍晚）

Human 看完改后页面又提了四处（附三张红框截图）：一是「活动」段仍然密集，其中「注入模型 prompt：否 · 本次上下文尚无提交收据。」与 Machine / Worker 右侧的「与 Project settings 同一租约事实」都可以隐藏；二是 Owner 段折叠摘要下的治理说明「可将频道负责人变更为 Project 的 Human 创建者；成员跟随 Project 自动同步。」应该放在变更负责人的地方；三是公共频道的「公共频道成员跟随项目自动同步，不可独立修改。到 Project Members 调整成员。」可以收进问号按钮，「消息数」没有必要（保留「最后消息时间」）。

对应改动：

- `chat-activity.tsx`：轮初上下文与注入收据收进默认折叠的「本轮上下文与注入诊断」（`chat-turn-context-diagnostics`），摘要只在真有提交收据时显示「已注入」。注入事实本身不变，仍然只有一处来源。
- `chat-details.tsx`：活动段的「Machine / Worker」行只在读取失败或未接入时渲染，与 Project settings 同源的正常情形不再复述；治理说明在有可改入口时移入 `OwnerDialog`（面板上只在没有入口的只读场景保留）；公共频道规则改为一行结论加问号按钮（`channel-members-help`），展开才显示完整规则与 `Project Members` 链接；删「消息数」行；「最后消息时间」改用与消息区一致的聊天时间标签（`chatTimeLabel`），机器可读真值留在 `<time datetime>` 上，避免 ISO 字符串在窄栏断成两行。
- `as-p5a-chat-ui.mjs`：治理提示断言改为「面板上没有第二处 + 打开变更负责人对话框后在其中读到」，并把两处事实行断言从「消息数」改为「最后消息时间」。
- `j-info-hub-flow.mjs` / `k-acceptance-flow.mjs`：消息数的事实断言改为直接数渲染出的 `message-item`；最后消息时间改为比对 `<time datetime>` 并与渲染出的最后一条消息对照。
- `p6b-wiring-pages.mjs` / `q-info-hub-runs.sh`：读折叠块里的内容前先展开（幂等），P6a/P6b 的注入与轮初上下文契约断言不变。
- `docs/feature-map/info-hub.md`：Chat 信息一行的测试 id 与说明同步。

父代理实际复跑：`pnpm typecheck`；`pnpm test` 1463 项全过；`pnpm check` 0 errors / 16 条既有 warning / 775 文件；`as-p5a-chat-ui` 31 项；`i-chat`；`j-info-hub`；`k-acceptance` runner 12 项 0 失败；`bf-p6b-pages` 27 + 13 组；`q-info-hub-runs`。前后对照截图扩到 10 张（新增 Change Owner 对话框、公共频道成员段、公共频道规则展开），父代理逐张读图确认四处反馈都已落地：公共频道默认只显示「公共频道成员跟随项目自动同步（?）」，展开后是完整规则与 Project Members 链接；变更负责人对话框里有治理说明而面板 Owner 段没有；DM 右栏只剩「最后消息时间 11/11 11:07」与折叠的「本轮上下文与注入诊断」，没有「消息数」与「与 Project settings 同一租约事实」。未重跑完整 CI，未改动数据库与原型服务。Human 体验确认仍待反馈。

### 第四轮：第三轮评分 7.3 之后的整改

第三轮交付的 10 张对照截图交同一 GPT 模型按五条机制复评，得 **7.3/10**（未过 8.0 关口）：机制 1「信息只出现一处」6.0（DM 的分身 Instance ID 同时在成员元数据与活动 run 明细；群聊 Owner 同时在成员徽标、Owner 段摘要与展开内容），机制 2「信息在相关位置」7.0（最后消息时间仍挂在成员段，运行状态与运行事实仍主要靠右栏），机制 3「重要程度有区分」7.4（右栏状态、ID、治理版本与空态都是相近的 10–11px 灰字），机制 4「密度张弛」8.3，机制 5「排版分区」7.8（窄栏长 ID 与 ISO 时间折行；注意这一轮截图早于时间标签改动，所以它看到的时间仍是 ISO）。

本轮对应改动：

- `info-hub/run-facts.tsx`：`RunFactsBlock` 增加 `scope`（`chat` 视角不再逐行复述 `Chat <id> · 分身 <id>`，那是当前这一条对话自己的身份），活动 run 的状态改为带色点的状态色文本（与 Chat 页运行面板同一套 `text-status-*`）作为该段的视觉锚点，run id 行降为次级等宽小字。
- `chat-details.tsx`：「分身 Instance ID」「归档状态」「最后消息时间」从「成员」段移出，独立成「会话」段（`chat-details-conversation`）；时间单元格 `whitespace-nowrap`，值用 `chatTimeLabel`（`11/11 19:29`），机器可读真值留在 `<time datetime>`；Owner 段的「Owner」一行删除，`chat-owner-name`（保留「（Human）/（Agent）」后缀）移到该段折叠摘要右侧，群聊 Owner 由此只在成员徽标与段摘要出现。
- `machine/lease-panel.tsx`：`LeaseOverview` 增加 `hideEmpty`，窄栏调用方（会话详情）在没有租约时整块不渲染，不再输出「本 Project 还没有租约记录。」这类没有可行动信息的空态。
- `projects.$projectId.chats.index.tsx`：删掉 Chats 首页的类型科普副标题，空态提示压到一句「从左侧列表选择，或用下面的入口新建。」

仍然冻结、本轮有意不改的三处（都有门禁把文案或结构当作契约）：`run-facts.tsx` 的「还没有历史 run。」与「当前没有排队中或运行中的 run。」（`tests/run-facts-summary.test.ts`、`tests/fixtures/p6b-pages.ts` 四种视角），pending 输入在中栏与右栏的共同出现（`o-turn-semantics` 断言 `pending-input-count` 文案并现场点停止），Owner 段的「治理版本」「唤醒策略」（`as-p5a-chat-ui.mjs` 计数断言）。要动这三处需要同时改契约，不属于本轮去重范围。

父代理实际复跑（均前台）：`pnpm typecheck`；`pnpm test` 166 文件 1463 项全过；`pnpm check --fix` 后再 `pnpm check` 0 errors / 16 条既有 warning / 775 文件；`as-p5a-chat-ui` 31 项（含「会话」段新增后的事实行与移动端宽度断言）；`j-info-hub`；`k-acceptance` runner 12 项 0 失败；`bf-p6b-pages` 27 + 13 组；`q-info-hub-runs`；`i-chat`。改后对照截图重拍为 10 张（与 before 同数据同视口），父代理读图确认：「会话」段在 DM 右栏显示 `ins_8b682c47` 与 `11/11 19:29`、「活动」段是「活动 run 宿主未启用」+ 等宽 run id + 带色点的「运行中」、租约空态与「与 Project settings 同一租约事实」都不再出现，Chats 首页只剩标题、空态一句提示与发起入口。未重跑完整 CI，未改动数据库与原型服务。Human 体验确认仍待反馈。
