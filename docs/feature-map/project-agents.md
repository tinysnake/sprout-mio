# Project 与 Agent

用户登录后创建 Project，保存项目配置，维护 Agent Profile 并把 Agent 加入项目。领域规则见 [Project Profiles](../project-profiles-decisions.md)、[Agent Profiles](../agent-profiles-decisions.md)及 [P2 Project / Agent 契约](../p2/project-agents.md)。

## Sub-features

- `identity-session` 注册、登录与会话隔离。
- `project-create` 创建后进入项目，并能从项目选择器再次打开。
- `project-config` 保存 Git remote、默认分支和工作目录，刷新后保持。
- `agent-profile` 新建与编辑人设，保持同一 Profile 标识。
- `project-members` 添加和移除成员，刷新后关系保持一致。
- `ownership-boundary` 其他用户不能读取或修改本人的项目和 Profile。

## How to get to it (user POV)

- 从 `/login` 注册或登录，经 `/projects` 分发到当前项目 Chats；打开项目选择器，使用创建项目入口。
- 从项目进入设置 `/projects/$projectId/settings` 或成员页 `/projects/$projectId/members`。
- 从全局 Agents 导航进入 `/agents`，新建 Profile 后打开 `/agents/$agentProfileId`。
- 从项目成员页选择已有 Profile，添加后可继续[发起 DM](chat-runs.md)。

## Driving it with Playwright and verify scripts

前置条件是专用验收实例、可注册的测试用户和唯一的项目及 Agent 名称。身份越权检查需要第二位测试用户。下列领域脚本自行建立验收数据库与用户。

| 操作               | 稳定定位                                                                                                                                       | 可观察结果                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 创建项目并重新打开 | `project-selector`、`new-project-trigger`、`project-name-input`、`project-submit`                                                              | 当前 URL 指向新项目 Chats，项目选择器可再次打开同一项目                   |
| 修改配置后刷新     | `tab-settings`、`config-git-remote`、`config-default-branch`、`config-work-directory`、`config-save`                                           | 三个字段保持保存值，URL 仍指向同一项目设置                                |
| 创建并编辑 Profile | `nav-agents`、`new-agent-trigger`、`agent-name-input`、`agent-persona-input`、`agent-submit`；详情用 `agent-edit-persona` 和 `agent-edit-save` | 列表出现新 Agent；编辑并刷新后人设更新，`agent-detail-id` 与详情 URL 不变 |
| 添加并移除成员     | `add-member-trigger`、`add-member-select`、`add-member-submit`，成员行按名称定位                                                               | 添加后成员存在；移除并刷新后该成员消失                                    |
| 换用户访问同一资源 | 使用第二用户会话访问原 URL，并检查对应 API                                                                                                     | 页面和服务端都拒绝越权，响应不泄露原用户数据                              |

按改动选择入口。

- `bash scripts/verify/h-project-agents.sh` 覆盖 Project / Agent 的领域 API 与真实 Chromium 路径。默认端口 3142，可用 `SPROUT_VERIFY_PROJECT_AGENTS_PORT` 调整。
- `bash scripts/verify/g-identity-data.sh` 用于身份、用户数据与隔离变化。认证基础变化再查 [c-data-auth.sh](../../scripts/verify/c-data-auth.sh) 和 [c-auth-rate-limit.sh](../../scripts/verify/c-auth-rate-limit.sh)。
- 已有专用实例时，可用 `BASE_URL=http://localhost:3142 node scripts/browser/h-project-agents-flow.mjs` 驱动同一 UI 路径。先确认实例、账号与数据隔离；driver 不负责 production build 或服务端越权断言。

操作来源是 [h-project-agents-flow.mjs](../../scripts/browser/h-project-agents-flow.mjs)。领域脚本证据在 `.verify/h-project-agents/evidence.json` 及同目录日志，默认截图在 `.verify/h-project-agents/evidence/p2-h-*.png`。保存操作前后、刷新后的值和跨用户拒绝结果。

## Gotchas

- 注册会播种默认 Agent。不能把成员列表当作空列表，也不能按第一行选择本次新建的 Agent。
- 人设修改对下一轮运行生效。Profile 保存成功不能证明正在运行的 Agent 已切换人设，运行行为另走 [Chat 与 Run](chat-runs.md)。
- `SPROUT_SKIP_BROWSER=1` 会跳过 H 脚本的浏览器路径。使用该模式时不能报告页面已验证。
- H 脚本会 build 并重建自己的验收数据库。固定目录与共享构建产物的限制见[地图首页](README.md#运行成本与隔离)。
