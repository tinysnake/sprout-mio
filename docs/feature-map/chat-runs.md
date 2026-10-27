# Chat 与 Run

用户从项目成员发起 DM，在固定 Chat 中发送消息，查看运行状态并在刷新或重启后继续访问历史。契约见 [Chat DM](../p2/chat-dm.md)、[Pi session](../p3/pi-session.md)、[Turn semantics](../p3/turn-semantics.md)及 [Repo entry](../p3/repo-entry.md)。

## Sub-features

- `dm-entry` 首次发起 DM，重复入口回到同一 Chat 与 AgentInstance。
- `message-history` 消息顺序、刷新及服务重启后的持久性。
- `chat-title` 修改标题并保持 Chat 身份与历史。
- `persona-next-turn` 修改 Profile 后，后续运行使用新人设。
- `run-lifecycle` 查看 running、完成、失败和中止的结果，运行中发送消息的处理遵循 Turn 契约。
- `repo-entry` 需要仓库的运行使用正确工作目录，失败时显示可追踪错误。
- `chat-access` 深链、缺失资源和跨用户访问边界。

## How to get to it (user POV)

- 打开项目 Chats `/projects/$projectId/chats`，在空白对话区域的成员列表发起 DM；或点击列表栏的新建 Chat，弹窗中选择项目成员。
- 从 Project Info Hub 的成员 DM 链接打开会话；直接打开 `/projects/$projectId/chats/$chatId` 也应到达同一 Chat。
- 同一成员的重复发起入口应回到原 Chat。
- 在 Chat 中发送消息、查看运行状态。需要查看身份和 Run 明细时打开 [Info Hub](info-hub.md)。

## Driving it with Playwright and verify scripts

前置条件是测试用户、项目和项目内 Agent 成员。实际模型运行另需 Pi 配置、模型凭据及可用执行环境；仓库操作还需有效项目配置与 Machine / Lease。缺少这些条件只能证明消息或协议路径。

1. 在 Chats 索引页的成员列表中，用带目标 `data-agent-profile-id` 的 `dm-start` 进入 Chat。另测 `new-chat` → `new-chat-dialog` → 对应成员的 `dm-start`。记录 URL、Chat 与 AgentInstance 标识。
2. 用 `message-input` 输入两条不同消息并点击 `message-send`。刷新后检查两条消息均保留且顺序正确。
3. 修改 Profile 人设，再从同一成员重复发起 DM。检查 Chat URL、Instance 与既有消息保持一致。
4. 直接打开 Chat 深链，检查同一历史；用不存在的 Chat 与另一用户会话检查失败和隔离结果。
5. 若涉及运行行为，实际发送一次触发运行的消息，观察状态变化和最终结果。对失败、中止、运行中追加输入及 Repo 错误，按对应脚本覆盖具体分支。

按改动选择入口。

| 要证明的行为                | 入口与证据边界                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 消息、DM 身份、持久性及标题 | `bash scripts/verify/i-chat.sh`。默认端口 3143，可用 `SPROUT_VERIFY_CHAT_PORT` 调整；包含 production build、浏览器、重启后复查及标题流程                                                   |
| 在已有专用实例驱动消息路径  | `BASE_URL=http://localhost:3143 CHAT_STATE_FILE=/tmp/sprout-feature-map-chat.json node scripts/browser/i-chat-flow.mjs`。保存状态文件后，重启同一实例，再用相同变量加 `CHAT_VERIFY=1` 复查 |
| Pi session 协议集成         | `bash scripts/verify/n-pi-session.sh`。该入口明确使用 `--protocol-stub`，不能据此声称真实模型响应通过                                                                                      |
| Turn 与 Repo 行为           | [o-turn-semantics.sh](../../scripts/verify/o-turn-semantics.sh)、[p-repo-entry.sh](../../scripts/verify/p-repo-entry.sh)，按改动读取并执行对应模式                                         |
| 真实模型 DM                 | 按 [pi-dm-turn.sh](../../scripts/verify-live/pi-dm-turn.sh) 的 live 模式准备凭据与环境，记录实际模型、动作及返回消息                                                                       |

浏览器步骤见 [i-chat-flow.mjs](../../scripts/browser/i-chat-flow.mjs)，标题路径见 [p4b-chat-title-flow.mjs](../../scripts/browser/p4b-chat-title-flow.mjs)。I 脚本默认证据在 `.verify/i-chat/evidence.json`、同目录日志与 `evidence/p2-i-*.png`；标题截图默认在 `.verify/i-chat-title/evidence/`。保留重启前后的消息、标识与状态变化证据。

## Gotchas

- 消息成功持久化不代表模型已运行。协议 stub、真实模型和远程执行分别记录。
- 人设保存、Chat 身份不变与下一轮实际使用新人设是三个断言，按改动分别证明。
- 重启验证必须使用原数据库与状态文件。重新注册后进入空 Chat 无法证明历史持久性。
- I 浏览器 driver 主要从 Chats 索引页的内嵌成员列表发起 DM。新建 Chat 弹窗与 Info Hub 链接是额外入口，入口变化时补实际操作验证。
- 直接运行浏览器 driver 不包含服务端越权检查与服务重启管理。I 脚本的固定目录和共享构建产物限制见[地图首页](README.md#运行成本与隔离)。
