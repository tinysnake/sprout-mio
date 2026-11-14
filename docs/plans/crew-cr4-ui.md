# Crew CR4 右栏设计（D0 方向 B）

Human 已选方向 B：Crew 主对话右侧的委派栏，能看到委派结果与需要介入的事项，可隐藏。隐藏是本地 UI 状态，不写服务端，不自动展开；窄屏不长期占栏。

## 信息架构

- 只在 `session.kind === "crew"` 的主对话显示；DM、delegation 子对话不显示。
- 三段，按优先级：`需要你`（blocked/failed/attention）、`进行中`（queued/running）、`已完成`（最近若干条）。空段不占标题。
- 每张卡：worker 展示名、委派标题或目标首行、状态徽标、耗时、最近更新时间；有结果时给一句摘要。整卡可点，打开委派子对话（复用现有 chat 路由）。
- 子对话顶部已有父对话/来源链接时应直接返回父对话；返回锚点记录用户在父对话中打开卡片时的消息位置，返回后不强制滚到底。
- 栏顶有折叠按钮与 `进行中 n` 计数；折叠状态按 Project 记在 localStorage，默认展开（宽屏），`< 1024px` 默认折叠且不覆盖用户的显式选择。
- 不新增全局页面、不改左侧会话列表排序；委派子对话仍出现在会话列表中。

## 数据

- 新增 `listCrewDelegationsFn({ projectId, crewChatId })`，返回 `{ active, needsYou, completed, counts }`，字段只取卡片需要的：`delegationId, childChatId, workerProfileName, title, status, updatedAt, elapsedMs, summary, attentionReason`。
- 查询按 crew + epoch 限定，排除已取消/已删除；`completed` 上限 20 条，不一次拉全部结果 HTML。
- 刷新：Crew 有活跃 run 时随现有 live tick 拉一次（与 run facts 同周期，不单独轮询）；run 变化或委派状态变化时 `requestRouteReload`。不做 WebSocket 新通道。
- 结果正文只在打开子对话时加载；栏内只显示摘要，避免大 HTML 进主对话。

## 交互与可访问性

- 卡片是链接/按钮语义，Enter/Space 可打开；状态不只靠颜色，带文字徽标。
- 折叠按钮有 `aria-expanded` 与可读名称；栏用 `<aside aria-label="委派">`。
- 打开子对话不标记已读、不清除 `需要你`；需要 Human 的项在子对话处理后随下一次数据刷新消失。
- 没有委派时不显示空栏，只有折叠按钮也不显示。

## 验收

- 单测/组件测试：分段与计数、空段隐藏、DM delegation 不渲染、折叠持久化、窄屏默认。
- 浏览器 gate `scripts/browser/crew-rail.mjs`：创建 Crew 与两次委派（一个进行中、一个完成），断言卡片、计数、点击进入子对话、返回父对话、折叠后刷新仍折叠；testid `crew-rail`、`crew-rail-toggle`、`crew-card`、`crew-card-open`、`crew-card-status`。
- Human review：真实页面截图（宽/窄、展开/折叠、需要你/完成）与 30–60 秒录屏，覆盖点击卡片进入子对话并返回；评审通过前不视为完成。
