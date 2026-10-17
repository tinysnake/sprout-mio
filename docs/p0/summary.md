# P0 结论一览

P0 的目标是验证技术栈与高风险协议，收敛基础契约。本页汇总 7 个实验 unit 的结论、证据位置、未验证项，以及已经落实到 [architecture-direction.md](../architecture-direction.md) 的架构更新点。

「已验证」指该结论有可重跑脚本和真实产物。各 unit 的完整未验证清单在对应结论文档的「未验证项」一节，本页只列影响架构与后续阶段的项。

## 结论总表

| 主题 | 结论 | 证据位置 |
| --- | --- | --- |
| 技术栈版本与构建 | 版本组合固定，干净安装、类型检查、生产构建、dev 服务、迁移与 lint 通过 | [stack-versions.md](stack-versions.md)，`experiments/stack-app/scripts/verify.sh` |
| Start SPA 与登录与数据库 | SPA 深链刷新、Better Auth session、Drizzle migration 与事务与唯一约束、shadcn + Base UI 渲染全部通过 | [spa-auth-db.md](spa-auth-db.md)，`experiments/spa-auth-db/verify.sh`，32/32 |
| 常驻运行时共进程 | 共进程成立，不拆后台进程，但需要两个前提 | [runtime-host.md](runtime-host.md)，`experiments/runtime-host/scripts/verify.sh` |
| 真实 Pi 接入 | SDK 优先并跑在宿主管理的子进程里，RPC 作为备选 | [pi-integration.md](pi-integration.md)，`experiments/pi-probe/verify.sh` |
| Worker 协议语义 | 幂等、响应丢失恢复、双向代次门禁、旧请求拒绝成立 | [worker-lease.md](worker-lease.md)，`experiments/worker-probe/scripts/verify.sh` |
| 四种故障恢复承诺 | 12 格矩阵给出每格的恢复、未知与不重跑行为 | [recovery-promises.md](recovery-promises.md)，`experiments/recovery-probe/scripts/verify.sh` |
| 身份与事务与授权契约 | 分身唯一、租约互斥、run 串行、执行 ID、唤醒去重由数据库约束与应用协议共同保证 | [contracts.md](contracts.md)，`experiments/contract-checks/scripts/verify.sh`，25/25 |

## 逐项结论

### 1. 技术栈版本与生产构建

环境是 macOS arm64，Node v26.11.1，pnpm 10.33.0。组合为 TanStack Start 1.169.2、React Router 1.170.44、Vite+ 1.3.0、Drizzle ORM 0.45.4、drizzle-kit 0.31.11、better-sqlite3 12.11.1、Better Auth 1.7.10、shadcn 4.22.0、Base UI 1.9.0、Tailwind 4.3.3、Effect 4.0.5、React 19.3.1、TypeScript 6.0.3。

最大未知是 Vite+ 驱动 TanStack Start 的构建，结果是成立。做法是用 catalog 把 `vite` 指向 `@voidzero-dev/vite-plus-core`，并用 overrides 与 peer 规则满足 Start 的 `vite >= 8.0.0` 声明。

未验证项：冷 pnpm store 的安装耗时与成功率、Effect 的长期运行能力（Scope、fiber、Queue、重试、取消）、`vp test` 与 `vp pack`、生产进程直接启动（由 spa-auth-db 的 `.output/server/index.mjs` 启动覆盖）、`vp check` 的格式化门禁（Oxfmt 在 scaffold 自带与生成文件上报 24 处格式差异，未跑 `--fix`）。

### 2. Start SPA、Better Auth、Drizzle 与 shadcn

SPA 深链刷新由真实 Chromium 导航到 `/second` 验证，HTTP 层返回 shell，内容由客户端渲染。Better Auth 的 email-password 注册、登录、session cookie、登出在 HTTP 与浏览器两侧验证。Drizzle 的从零迁移重放、显式事务回滚、唯一约束冲突验证通过，回滚项带正对照。shadcn + Base UI 组件真实挂载并通过 `getComputedStyle` 读到 Tailwind 主题值。

影响契约的发现：SPA 运行期必须再设 `createStart(() => ({ defaultSsr: false }))`，否则生产 node server 仍做完整 SSR；生产启动不读 `.env.local`，需要显式加载；Better Auth 的 POST 需要 Origin 或 Referer，否则返回 403；被拒 server function 返回 HTTP 200 并把错误放在载荷里，授权判定不能读状态码；Drizzle 包装错误时 sqlite 错误码在 `error.cause.code`；shadcn CLI 对 TanStack Start 会猜错样式文件路径。

未验证项：静态托管下 `_shell.html` 的 rewrite 与 API allow-list、多进程或多宿主并发写 SQLite、`defaultSsr: false` 下 loader 服务端执行被跳过的逐条验证、生产包体与首屏。

### 3. 常驻 Effect runtime 共进程

结论是共进程成立，证据不支持把后台拆成独立进程。必须有 `globalThis` 单例防护，模块级变量在 HMR 重新求值时会被重建并产生第二份后台工作。信号驱动的关闭必须挂在进程入口的主线程上，dev 模式下 SSR 运行在 Nitro 的 worker thread 里，模块内注册的 `process.on('SIGTERM')` 收不到进程信号。

已验证初始化、HMR 双份对照、SSE 长连接、生产构建与启动、生产 SIGTERM 下的 Scope 关闭顺序。

未验证项：dev 模式信号驱动的优雅关闭、WebSocket、依赖或插件变化导致的 worker 重启。

### 4. 真实 Pi 接入

结论是主路径用 SDK，把 Pi 跑在宿主的一个独立子进程里，RPC 作为零接线备选。SDK 的 steer、follow_up、abort、会话持久化与恢复全部验证通过，和 RPC 能力等价。

SDK 接入有两个前提。必须显式构造指向 `~/.pi/agent` 的 `ModelRuntime`，并显式指定 `model`。裸 `createAgentSession()` 在本机解析到 `openai-codex/gpt-6.1-sol` 而不是配置默认的 `magpie/group/auto-deepseek-v4-1-flash`，真实调用失败但不抛异常，只写 `stopReason: "error"`，调用方必须检查 `stopReason`。

未验证项：SDK 加载内置 codemode、tool_search 与 MCP extension、SDK 注册自定义 provider（magpie）、RPC 的 extension 对话框子协议与背压、多分身并发的资源占用。

### 5. Worker 最小协议

原型用 loopback TCP 上的 NDJSON 检查四条协议语义，全部通过。重复提交返回同一执行 ID 且副作用只有一行；同一 requestId 换命令被 `duplicate-mismatch` 拒绝；响应丢失后按 requestId 恢复同一执行且命令只跑一次；授权代次切换后旧代次帧被 `stale-generation` 拒绝，高水位跨重启不回退；旧代次的 query 与 cancel 被拒且命令继续运行，当前代次可以查询与取消。

影响契约的发现：requestId、correlationId、executionId 是三个不同的东西；代次门禁必须在宿主与 Worker 两个方向都做；恢复权威在 Worker 的持久执行账本；幂等键必须绑定命令指纹；代次推进与代次通知分开建模。

未验证项：真实身份认证与密钥证明、TLS 与跨机传输、多 Worker 隔离、真实宿主进程重启（由 recovery-promises 用真实 kill 覆盖）、Worker 执行中途 SIGKILL、日志游标与流式输出、执行超时与 SIGKILL 升级、`future-generation` 分支。

### 6. 四种故障恢复承诺

矩阵覆盖宿主断线、宿主重启、Worker 重启、Machine 重启四种故障乘以进行中短命令、进行中长命令、已完成未取结果三种状态，12 格全部通过。三条跨格不变量是 unknown 是一等状态，同 requestId 重提交返回同一执行且副作用行数不变，已完成且结果落盘的命令连 Machine 重启都能查回。

恢复权威分三层，宿主意图 journal 决定重启后还知道要查什么，Worker 执行 journal 决定命令是否已经跑过，Runner 的 claim 与 result 文件决定在途命令的终态是否可恢复。PID 存活只证明进程还在跑，不证明结果可恢复。

未验证项：真实跨机与网络分区、真实断电与文件系统掉电、cgroup 或 launchd 的真实 Worker 监督、多宿主多租约并发、结果文件的部分写与 fsync、日志容量上限。

### 7. 身份、事务与授权契约

19 项契约有可重跑证据。分身由 `(profile_id, conversation_id)` 部分唯一索引保证唯一，租约由 `(project_id, machine_id) WHERE state='active'` 保证互斥，run 由 `(instance_id) WHERE status='active'` 保证同分身串行，执行由 `(machine_id, request_id)` 保证幂等并绑定命令指纹，唤醒由 `(target_instance_id, dedup_key)` 保证去重。

影响契约的发现：部分唯一索引是表达活跃互斥加历史保留的正确结构；零租约空窗不是数据库约束能防的，直接交接必须是单事务里的释放加获取；run 的状态与结束时间用 CHECK 绑成等价关系；唤醒合并必须显式保留 `processed_at`，一个去重键终身只对应一行；`PRAGMA foreign_keys = ON` 是每连接必需项；WAL 与 DELETE 都不影响唯一约束语义。

未验证项：多进程并发写同一 SQLite 文件、WAL 的 checkpoint 与写饥饿、run 状态迁移方向、租约 holder 的授权校验、唤醒执行前的参与权与暂停控制复查、租约 TTL 与撤销的异步确认。

## 已落实的架构说明更新

结论文档明确提出的更新点在本单元逐条落实到 [architecture-direction.md](../architecture-direction.md)，只改实验证实或证伪的陈述。

1. Start SPA 行补上运行期约束，只配 `spa.enabled` 不够，还需要 `createStart(() => ({ defaultSsr: false }))`；生产启动需要显式加载环境变量，静态托管需要把未知路径 rewrite 到 shell。
2. 常规功能路径补上错误契约，server function 的授权失败不体现在 HTTP 状态码上，边界转换必须落到响应载荷。
3. Vite+ 职责补注，只验证了开发、构建与 lint，`vp test` 与格式化门禁未通过验证。
4. 共进程行从待定改为成立，并写入两个前提，`globalThis` 单例与信号挂主线程。
5. SQLite driver 从不锁定收敛为 `better-sqlite3` 同步驱动，迁移用 `drizzle-kit generate/migrate`，并写明约束错误在 Drizzle 里的读取位置。
6. Pi 接入记录为 SDK 优先并跑在子进程里，写入显式 `ModelRuntime` 与显式 `model` 两个前提，`pi-host.ts` 需按 Pi 1.3.0 重新对齐。
7. MCP 行从「是否加载内置 MCP extension 必须单独检查」改为 SDK 默认不加载、接入时显式注册，并标注内置 extension 的 SDK 加载本身未验证。
8. Worker 命令协议补上关联 ID，并写明两个方向的代次门禁。
9. 恢复一节写明三层恢复权威与 `unknown` 是一等返回态，Worker 侧执行记录由执行端持久化。
10. 租约一节写明活跃性由 `state` 加部分唯一索引表达、释放行保留为审计历史、直接交接是单事务协议。
11. 远端执行一节写明幂等键是 `(Machine, request ID)` 且绑定命令指纹，稳定执行 ID 是独立主键。
12. 唤醒一节写明去重键按目标分身作用域且一个去重键终身只对应一行。
13. 数据库连接一节写明 `PRAGMA foreign_keys = ON` 是每连接必需项。

## P0 未覆盖的验收范围

- 真实跨机、跨网络分区、真实断电与磁盘损坏。四种故障都在同一台机器上用进程 kill 与连接关闭模拟。
- 真实 macOS Worker 端到端。Worker 安装、主动认证连接、断线重连、真实租约执行闭环留到 P4 验收。
- Windows Worker、Linux 验收。
- 静态托管形态与 CDN rewrite。
- 多宿主与多租约并发。
