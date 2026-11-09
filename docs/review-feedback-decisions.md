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

专项报告在集成 worktree 的 `.verify/runs/2026-11-09T08-30-14-273Z-62826-0/report.json`；浏览器证据在 `.verify/assistant-1794213068762`、`.verify/cron-1794213023930`、`.verify/webhook-1794213096277`。最终 CI 记录为 `/tmp/sprout-round3-ci-final.result.json`。原预览迁移和页面复核结果在集成后补记，Human 体验确认仍待反馈。
