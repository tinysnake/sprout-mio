# Sprout feature map

这份地图按用户操作组织验证入口。先从受影响的功能进入，再选择能证明本次改动的路径。验证范围、升级条件与证据复用遵循[验证约定](../verification.md)。产品契约与完成状态仍分别由领域文档和[开发计划](../development-plan.md)维护。

## 功能索引

| 用户要做什么 | 功能地图 | 涉及的入口 |
| --- | --- | --- |
| 登录后创建项目、配置项目、管理 Agent 和项目成员 | [Project 与 Agent](project-agents.md) | `/login`、`/projects`、`/agents`、项目设置与成员页 |
| 发起 DM、发送消息、查看运行状态与恢复历史 | [Chat 与 Run](chat-runs.md) | 项目对话列表、新建 Chat、Info Hub 的 DM 链接、Chat 深链 |
| 在当前上下文查看成员、Chat、Run 和租约事实 | [Info Hub](info-hub.md) | 项目和 Chat 的信息面板 |
| 接入 Machine、查看健康状态、管理项目租约 | [Machine 与 Lease](machines-leases.md) | `/machines`、Machine 详情与租约页、Info Hub |
| 发起远程命令、取消执行、查看执行日志与恢复结果 | [远程执行与日志](remote-execution.md) | Agent 远程工具、Run 的执行记录 |
| 配置 MCP server，通过原生 extension 使用远程工具 | [MCP](mcp.md) | Machine 配置、Pi extension 的工具发现与调用 |

## 选择路径

1. 检查实际 diff，选出受影响的功能和子功能。单纯修改地图说明时，执行文档检查。
2. 读取对应页的前置条件与 Gotchas。按风险选择领域测试、浏览器路径或真实链路脚本；每页列出的命令是可选入口集合，不是需要全部执行的清单。
3. 核对共用依赖。身份与权限变化要覆盖相关访问边界；Chat、Run、Info Hub、Lease 和远程执行之间的契约变化要沿调用链增加验证。
4. 按页面列出的可观察结果收集证据。缺少种子数据、凭据或工具时记录阻塞原因，不删断言，也不改用开发场景冒充真实链路。

导航、布局和共享组件变化另查[前端设计基线](../frontend-design.md)与[前端开发约定](../frontend-conventions.md)。相关浏览器入口在 [r-ui-layout.sh](../../scripts/verify/r-ui-layout.sh)，按受影响布局覆盖 900px / 1200px 边界及 Info Hub 的打开方式。

## 运行成本与隔离

- `h-project-agents.sh`、`i-chat.sh`、`j-info-hub.sh` 各自执行 production build、启动服务和 Chromium。它们属于领域验收，也有构建成本。对已经启动且状态合适的专用验收实例，可按各页说明直接运行浏览器 driver；这不等价于执行完整领域脚本。
- 上述三个脚本分别使用固定的 `.verify/h-project-agents`、`.verify/i-chat`、`.verify/j-info-hub` 数据目录，并重建其中的验收数据库。它们还共享 checkout 的 `.output`。不要在同一 checkout 并行运行，也不要并行运行同一脚本的两个实例。只改端口不能解决这些冲突。
- Machine、Lease、执行日志和 MCP 脚本的隔离方式各不相同，执行前读取脚本。开发场景、协议 stub、真实 worker、真实模型各自证明不同事实，报告写明实际使用的模式。
- 沿用脚本的清理逻辑，只关闭本次启动的进程。截图、JSON 和日志保留为证据；下一轮覆盖固定目录之前，归档需要留存的产物。

## 证据与维护

每次执行记录受验 commit、对应 diff、功能及子功能、实际命令、运行模式、退出码、产物路径与未覆盖项。地图描述现有路径与证明标准；地图里列出命令不代表这次已执行通过。

新增功能、入口、权限分支或状态时，同轮更新对应功能页。重命名 selector、调整启动参数或移动脚本时，同轮更新驱动说明与链接。功能页使用以下四节，保持下一位 agent 可从用户入口独立复现。

- `Sub-features` 列出需要分别验证的用户行为。
- `How to get to it (user POV)` 写明入口及深链。
- `Driving it with …` 写明前置条件、操作、可观察结果、命令和证据。
- `Gotchas` 记录缺失前置数据、隔离限制和证据边界。
