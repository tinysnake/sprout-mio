# Info Hub

用户在当前项目或 Chat 内查看成员、会话身份、消息数、Run 和租约事实，并从可用链接继续操作。契约见 [Info Hub](../p2/info-hub.md)、[Info Hub Runs](../p3/info-hub-runs.md)及 [Info Hub 决策](../info-hub-decisions.md)。

## Sub-features

- `project-members` 项目面板只列当前项目成员，提供可用的 DM 入口。
- `chat-facts` Chat 面板的 Chat、AgentInstance 和消息事实与当前页面一致。
- `run-facts` 项目与 Chat 的运行事实跟随实际 Run 状态。
- `lease-facts` 租约事实与管理入口对应当前项目和 Machine。
- `context-navigation` 切换项目或 Chat、直接打开深链和刷新后仍显示正确上下文。
- `hub-isolation` 其他用户不能借面板或事实查询读取本人的数据。

## How to get to it (user POV)

- 进入项目设置 `/projects/$projectId/settings`，展开 Project Info Hub。
- 打开 Chat `/projects/$projectId/chats/$chatId`，通过信息入口打开面板；现有浏览器 helper 使用 `?info=1` 深链。
- 从项目成员事实中的 DM 链接打开 Chat，再检查 Chat 信息。
- 从租约事实中的管理链接进入 [Machine / Lease](machines-leases.md)。

## Driving it with Playwright and verify scripts

前置条件是项目、两个 Agent Profile、其中一个加入项目，以及该成员已有 DM 和两条消息。租约与 Run 分支还需对应记录；没有记录时只覆盖空态，不能声称覆盖占用或运行态。

| 操作                 | 稳定定位或现有 helper                                                                                                                            | 可观察结果                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 展开项目面板         | [ui-navigation.mjs](../../scripts/browser/ui-navigation.mjs) 的 `openProjectInfoHub(page)`；`project-info-hub-toggle`、`info-hub-project-agents` | 已加入成员出现，未加入 Profile 不出现               |
| 打开成员 DM 链接     | 按成员名称定位其行，再沿 driver 的 DM 链接操作                                                                                                   | 打开目标 Chat，标识与该成员事实一致                 |
| 打开 Chat 信息       | helper `chatInspectorPath(chatPath)`；`info-hub-chat`、`info-chat-instance-id`、`info-message-count`                                             | Instance 与页面一致，消息数与实际消息吻合           |
| 查看 Run、租约并刷新 | 先制造对应运行或租约事实，再读取面板                                                                                                             | 状态与实际记录一致，切换上下文后没有串项目或串 Chat |
| 换用户访问事实       | 用第二用户会话执行相同查询                                                                                                                       | 请求被拒绝，响应不泄露原用户事实                    |

按改动选择入口。

- `bash scripts/verify/j-info-hub.sh` 覆盖 API、浏览器、租约事实与跨用户边界。默认端口 3144，可用 `SPROUT_VERIFY_INFO_HUB_PORT` 调整；会 production build。
- 已有专用实例时，使用 `BASE_URL=http://localhost:3144 INFO_HUB_STATE_FILE=/tmp/sprout-feature-map-info-hub.json node scripts/browser/j-info-hub-flow.mjs`。只运行 driver 时不包含外层脚本的 API 隔离断言。
- Run 事实变化使用 [q-info-hub-runs.sh](../../scripts/verify/q-info-hub-runs.sh)。Lease 变化同时进入 [Machine 与 Lease](machines-leases.md)，按风险补真实链路。

操作来源是 [j-info-hub-flow.mjs](../../scripts/browser/j-info-hub-flow.mjs)。J 脚本默认证据在 `.verify/j-info-hub/evidence.json`、同目录日志及 `evidence/p2-j-*.png`。保留成员包含与排除结果、消息数、上下文 URL 和越权拒绝结果；单张最终截图不能证明切换过程。

## Gotchas

- Project Info Hub 默认可能折叠，先通过用户入口展开。不能把未展开误判成数据缺失。
- `?info=1` 与普通 Chat URL 都是需要维护的入口。仅打开其中一个不能证明入口交互未受影响。
- 页面展示的租约事实与租约管理动作分别验证，详见 [Machine 与 Lease](machines-leases.md)。
- J 脚本重建固定验收数据，并共享 `.output`。不能与 H、I 的 build 同时在一个 checkout 运行。
