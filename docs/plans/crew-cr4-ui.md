# Crew CR4 右栏设计（D0 方向 B）

Human 已选方向 B：Crew 主对话右侧的委派栏，能看到委派结果与需要介入的事项，可隐藏。隐藏是本地 UI 状态，不写服务端，不自动展开；窄屏不长期占栏。

## 信息架构

- 只在 `session.kind === "crew"` 的主对话显示；DM、delegation 子对话不显示。
- 两段：`进行中的委派`（queued/running）与`非进行中的委派`（blocked/failed/completed/canceling/canceled）。空段不占标题。
- 每张卡：worker 展示名、委派标题或目标首行、状态徽标、耗时、最近更新时间；有结果时给一句摘要。整卡可点，打开委派子对话（复用现有 chat 路由）。
- 状态色：queued/blocked/canceling 警告色，running/completed 成功色，failed 错误色，canceled 弱化色；running 带脉冲点，状态不只靠颜色区分。blocked/失败/投递异常显示`需要你`，错误和需介入用错误色或警告色。
- 非进行中的委派默认最多显示 3 张，且随进行中数量让位：可见数 = `min(3, max(0, 3 - 进行中数量))`；其余收进`历史委派 n`折叠区。
- 子对话顶部已有父对话/来源链接时应直接返回父对话；返回锚点记录用户在父对话中打开卡片时的消息位置，返回后不强制滚到底。
- 栏顶有折叠按钮、`进行中 n` 与`需处理 n` 计数；折叠状态按 Project 记在 localStorage，默认展开（宽屏），`< 1024px` 默认折叠且不覆盖用户的显式选择。
- 不新增全局页面、不改左侧会话列表排序；委派子对话只出现在会话详情右栏，不进入左侧 Chat 列表。

## 数据

- 新增 `listCrewDelegationsFn({ projectId, crewChatId })`，返回 `{ active, inactive, counts: { active, inactive, needsYou } }`，字段只取卡片需要的：`delegationId, childChatId, workerProfileName, title, status, updatedAt, elapsedMs, summary, attentionReason`。
- 查询按 crew + epoch 限定，排除归档子对话；已取消进入 inactive，不再截断 completed。
- 刷新：Crew 有活跃 run 时随现有 live tick 拉一次（与 run facts 同周期，不单独轮询）；run 变化或委派状态变化时 `requestRouteReload`。不做 WebSocket 新通道。
- 结果正文只在打开子对话时加载；栏内只显示摘要，避免大 HTML 进主对话。

## 交互与可访问性

- 卡片是链接/按钮语义，Enter/Space 可打开；状态不只靠颜色，带文字徽标。
- 折叠按钮有 `aria-expanded` 与可读名称；栏用 `<aside aria-label="委派">`。
- 打开子对话不标记已读、不清除 `需要你`；需要 Human 的项在子对话处理后随下一次数据刷新消失。
- 没有委派时不显示空栏，只有折叠按钮也不显示。

## 验收

- 单测/组件测试：分段与计数、状态色与 running 脉冲、可见非进行中公式、历史折叠、子对话不进 Chat 列表、空段隐藏、DM delegation 不渲染、折叠持久化、窄屏默认。
- 浏览器 gate `scripts/browser/crew-rail.mjs`：创建 Crew 与 7 次委派（1 进行中、6 非进行中），断言可见 3 张、历史 4 张可展开、状态色/脉冲、左侧列表无 delegation、点击进入子对话、返回父对话、折叠后刷新仍折叠；testid `crew-rail`、`crew-rail-toggle`、`crew-card`、`crew-card-open`、`crew-card-status`、`crew-history-toggle`、`crew-card-pulse`。
- Human review：真实页面截图（宽/窄、展开/折叠、需要你/完成）与 30–60 秒录屏，覆盖点击卡片进入子对话并返回；评审通过前不视为完成。
