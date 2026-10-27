# MCP

Machine 运维者显式登记 MCP server，Agent 在 Pi 工具面发现并调用远程工具。worker CLI 是配置入口，实际调用经过 extension、服务端 relay 和 Machine worker。配置与生命周期来源见 [worker CLI](../../src/worker/main.ts)、[worker MCP](../../src/worker/mcp.ts)及 [extension 接入](../../src/extension/mcp-extension.ts)。

## Sub-features

- `mcp-registration` 从显式配置加载登记，按登记的传输与进程身份连接。
- `mcp-transports` stdio 与 HTTP 的启动、连接、断开及服务生命周期。
- `mcp-catalog` 发现工具与目录更新，工具名和目标 server 一致。
- `mcp-model-surface` 工具实际进入模型可调用列表。
- `mcp-content` 调用结果中的文本、图片和结构化内容保持语义。
- `mcp-isolation` server、session 和授权边界不串用，错误保留可追踪原因。

## How to get to it (user POV)

- 先完成 [Machine 接入](machines-leases.md)，准备该 Machine 的显式 MCP registration 文件。
- 在 Machine 上以 `sprout-worker run --state-dir <directory> --mcp-config <explicit-registration-file>` 启动 worker。参数对应已安装的 worker CLI；仓库构建入口见 [package.json](../../package.json)。
- 在具备对应执行上下文的 Agent session 中查看工具发现结果，让 Agent 调用指定 MCP 工具，检查返回内容与远端副作用。
- 工具不可见时，通过 extension 的 `sprout_status` 诊断工具面错误，再核对当前 session 的 tools allowlist。

## Driving it with integration scripts

前置条件是已登记 Machine、可用 worker / extension 构建产物，以及配置对应的 stdio 命令或 HTTP server。模型工具面验证需要实际 Pi session；仅直接调用 relay 无法证明模型看得见工具。

| 改动或要证明的行为          | 验证入口                                                          | 证据边界                                                                                                 |
| --------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| MCP 数据与协议契约          | [v-mcp-contracts.sh](../../scripts/verify/v-mcp-contracts.sh)     | 领域契约、合法及非法输入                                                                                 |
| 原生 extension 与远程 relay | `bash scripts/verify/x2-mcp-extension.sh`                         | 真实 extension 接入与响应，证据在 `.verify/x2-mcp-extension-*`                                           |
| 模型工具面及内容类型        | `bash scripts/verify/x3-mcp-extension-surface.sh`                 | 验证工具实际进入模型面，检查图片、文本和 structured content；证据在 `.verify/x3-mcp-extension-surface-*` |
| stdio worker                | `bash scripts/verify/y-mcp-worker.sh`                             | 领域定向测试与本机 MCP fixture 的实际 worker 行为                                                        |
| HTTP worker                 | `bash scripts/verify/y2-mcp-http-worker.sh`                       | 实际 HTTP 传输、worker 与服务生命周期；该脚本包含 worker build                                           |
| 端到端 relay 集成           | `bash scripts/verify/z2-mcp-integration.sh`                       | extension / server / worker 链路；独立临时目录和端口，关闭 Pi 模型运行                                   |
| MCP 交付候选的独立验收      | [z3-mcp-acceptance.sh](../../scripts/verify/z3-mcp-acceptance.sh) | 较广的源码、契约和运行证据校验，按交付节点选择                                                           |

每次执行记录实际 registration、传输类型、工具名、调用参数、返回内容、目标副作用和退出结果。配置及证据中的私密字段按现有脚本处理。具体运行及断言来源见 [mcp-extension-live.ts](../../tests/fixtures/mcp-extension-live.ts) 与 [mcp-extension-surface.ts](../../tests/fixtures/mcp-extension-surface.ts)。

## Gotchas

- worker 只读取显式配置，不能假定它会扫描宿主的 MCP 配置。配置入口是 worker CLI，当前地图不提供虚构的 Machine 页面配置按钮。
- 注册表里存在工具不等于模型可以调用。tools allowlist 可能保留 registry 却不把工具声明给模型，必须核对实际工具面。
- relay session 关闭与 MCP service 停止是不同生命周期。owner-managed HTTP 服务的连接和 worker 管理服务的退出行为分别验证。
- `z2-mcp-integration.sh` 设置 `SPROUT_PI_ENABLED=false`。链路集成通过不能报告真实模型工具调用通过。
- 图片可显示与 structured content 保留需要各自的断言，不能只检查文本摘要。
