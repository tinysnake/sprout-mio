# R1 MCP 组合与交付阶段

R1 采用薄 bridge + 帧中继 + Pi 原生客户端。Machine 上的 Worker 负责进程与传输，Sprout 保存会话身份和有序帧，Pi extension 把已有客户端接到这条通道上。MCP 接入在 P4c 之后纳入一期；触发条件是 P4c 的身份与授权契约稳定、R1 独立验收通过并完成 Human 确认。本轮保留一期能力表、一期验收表和开发计划四步 checklist。

## 组合与边界

- Worker 使用 stdio 或 streamableHttp 连接显式登记的目标。`configured_service` 由 Worker 启动并管理进程；`owner_managed` 连接已运行的 HTTP 服务，`pid=null`，不 spawn。
- 帧中继沿用受认证的 Worker exchange 通道，以 Project、Machine、授权代次、registration revision、process identity 和 Worker incarnation 约束每个 session。帧有序号、确认游标、有效期和大小上限。
- extension 的 `SproutRelayTransport` 实现 Pi 原生传输接口，复用 Pi 1.4.0 的 `McpClient` 完成初始化、工具与资源调用、通知和反向请求。薄 bridge 只处理宿主工具注册、允许名单、内容适配和 Sprout 身份绑定。
- `toolAllowlist` 在注册与执行时限制精确工具名；Pi runner 的 `mcp__*` 使获准工具进入模型工具面。Sprout catalog 只读取显式登记，不扫描宿主 `mcp.json`。

## 为什么官方 SDK 不作为产品路径

官方 SDK 可用作协议参考和验证载体，但不作为第二套宿主客户端。Pi 已提供锁定版本的原生 MCP 客户端及工具、内容转换能力；引入另一套 SDK 客户端会重复初始化、通知、取消和 session 管理，也增加与 Pi 语义对齐的维护成本。Worker 不依赖 Pi 安装，用 Node 内置 stdio、HTTP 与 SSE 完成传输，中继不承担 MCP 业务解释。

R1 第一条保留官方 SDK 的原文。z3 使用本机锁定的官方 SDK 1.32.1 分别连接真实 stdio 和本机 HTTP server，执行初始化与 tools/list；这项参考客户端对照独立于产品中继。Worker 与 Pi 的实际产品路径另行实测，不由 SDK 对照或编译结果推定。

## 为什么不开新长连接

MCP 帧复用已有 Worker 通道与宿主 remote-agent 接口，不再建立独立的 Sprout WebSocket 或 SSE 会话。宿主 exchange 使用最多 2000 ms 的有界 hold，收到新帧时唤醒，发送方有新帧时可中止空等并立即发送。这样认证、租约围栏、排空和连接恢复均由既有边界承担。

Worker 与目标 HTTP MCP server 之间仍按协议使用 GET SSE 和 `Mcp-Session-Id`；“不开新长连接”指不新增 Sprout 内部平行通道。关闭 MCP attachment 发送 DELETE，但不会关闭 owner 管理的服务进程。

## 会话与生命周期

session 绑定固定 process identity，目标消失就失败，不按名称重找其他实例。关闭 session 只 detach；释放租约撤销操作权并收敛会话，不等于终止服务。`configured_service` 在 Worker 停止时终止；`owner_managed` 在 Worker 停止后继续运行。SQLite 部分唯一索引只约束活动 session，因此关闭后可对同一 process 重开，同时禁止两个活动 session 抢占同一目标。

超时只说明结果未知。工具调用即使已到达 server，宿主没有完整响应时仍返回 `unknown`，不推断“未执行”。工具目录变化由 Pi 原生通知驱动刷新；若注册成功却未进入模型工具面，refresh 必须显式失败并保留诊断。

## 验证组织

`z3-mcp-acceptance.sh` 是重跑入口，复用 `y2`、`x2`、`x3` 的真实验证。新增的两个最小 server 为独立进程，各自限制文件根目录，验证双实例读写、资源订阅、超时和不改投；server-everything 经相同帧通道到真实 Pi 工具定义，验证图片与 structuredContent。执行记录和每条证据只保存布尔值、数量、工具名及错误码。

按 Build the Lever，脚本承担可重跑的证据采集；按 Prove It Works，判定来自真实进程、SQLite、Worker、HTTP 及 Pi 工具面；按 Sequence Work into Verifiable Units，分别运行传输、工具面和组合探针再汇总。技术结论与载体限制写在同一条证据旁，遵循 technical-writing 的读者任务顺序。完整结论见 [summary.md](summary.md)。
