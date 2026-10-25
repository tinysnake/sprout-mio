# R1 MCP 验证结论

R1 七条技术验证均为 PASS：7 PASS、0 FAIL、0 INCONCLUSIVE。统一入口 `bash scripts/verify/z3-mcp-acceptance.sh` 返回 0，逐条 JSON 与实际输出保存在 [evidence/](evidence/)。这些结论适用于 Human 授权替换后的无界面 server，不表示已验证 Unity/Blender 插件。

**R1 的 MCP 接入在 P4c 之后纳入一期。** 触发条件是 P4c 身份与授权契约稳定、R1 独立验收通过并完成 Human 确认。本轮记录技术证据和纳入建议，不修改一期能力表、一期验收表，不勾选 `docs/development-plan.md` 的四步 checklist。

## 七条证据

| 条款                                  | 结论 | 实际断言与证据                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1：stdio 与 streamableHttp            | PASS | x2 经 Worker runtime/dispatcher 与原生 Pi 客户端取得真实 server-everything 的 20 个工具；y2 经编译后的真实 Worker CLI 连接 HTTP 服务，执行初始化、JSON tools/list、SSE tools/call、GET 与 DELETE。官方 SDK 1.32.1 另作参考客户端，分别连通 stdio/HTTP 并取得 4/1 个工具。[clause-1.json](evidence/clause-1.json)                                                                                                                                |
| 2：Pi 工具面、allowlist 与显式登记    | PASS | 真实 Pi AgentSession 的活动工具面包含 5 个获准 `mcp__<server>__*` 工具；允许的 read 可执行，未获准的 notify 不注册。隔离宿主 `mcp.json` 中预置的 host_sentinel 不进 catalog、不进工具面，也未启动。[clause-2.json](evidence/clause-2.json)                                                                                                                                                                                                      |
| 3：指定实例、不同 root 隔离与不改投   | PASS | 两个独立 stdio server 同时连接，各自读取并写入自己的 root，跨 root 读写被拒绝。终止 A 后调用被拒绝，存活 B 可继续读取；session 数为 3 → 3，全部 session/process 绑定不变，B 上没有出现错误投递的文件。第三个 session 属于 server-everything。[clause-3.json](evidence/clause-3.json)                                                                                                                                                            |
| 4：图片与 structuredContent 送达 Pi   | PASS | server-everything 经 Worker、SQLite 帧中继、Sprout transport 和真实 Pi 工具定义执行，图片仍为 `image/png` 的 `image` 块，base64 长度 5380 且与原生客户端结果逐字节相同；另一个真实工具的 structuredContent 与原生结果深度相等。[clause-4.json](evidence/clause-4.json)                                                                                                                                                                          |
| 5：资源、目录变化、重建、超时与旧代次 | PASS | 列出并读取资源、订阅并收到 1 次更新后退订；x3 的真实 list_changed 后新工具进入 Pi 活动工具面并可调用（`callReturned` 与 `callTextMatchesServer` 由那次真实调用返回值算出，不是字面量），显式 refresh 后仍可用，受阻工具面有可见失败诊断；关闭后对同一 process 重开 session；server 已收到不返回响应的请求，Pi 仍报告 `unknown`；释放租约后的旧代次 exchange 返回 `lease_stale_generation` 且不插入新帧。[clause-5.json](evidence/clause-5.json) |
| 6：生命周期与已有服务登记             | PASS | 真实 Pi AgentSession dispose 并关闭 MCP attachment 后 server 存活，同一 process 可重连；释放租约并收敛到 free 后两个剩余 server 仍存活。y2 的 owner_managed、autostart=false 服务不 spawn、可从 catalog 选择并调用，DELETE 和 Worker 退出后仍运行；configured_service 随 Worker 退出终止。[clause-6.json](evidence/clause-6.json)                                                                                                               |
| 7：采用组合与纳入阶段                 | PASS | [design.md](design.md) 记录薄 bridge + 帧中继 + Pi 原生客户端、官方 SDK 作为参考的理由，以及不开新 Sprout 长连接的理由；范围文档将 MCP 列为明确后续能力，写明 P4c 后纳入一期的触发条件。[clause-7.json](evidence/clause-7.json)                                                                                                                                                                                                                 |

## 重跑与证据来源

运行 `bash scripts/verify/z3-mcp-acceptance.sh`。脚本为每次执行创建独立 `.verify/z3-mcp-acceptance-*` 目录，输出 `PASS/FAIL/INCONCLUSIVE R1-<n> <evidence-path>`，任一条非 PASS 则退出 1。缺失或未完成的前置执行记为 INCONCLUSIVE；已完成探针的断言不成立记为 FAIL。

刷新本目录的证据快照时，跑完上面这条后把新目录里的 `clause-*.json`、`evidence.json`、`c-evidence.json`、`run.log` 复制进 `docs/r1/evidence/`，再跑 `pnpm exec vp check --fix`（脚本产出的 JSON 不由格式化器生成，`pnpm check` 会要求它先被格式化）。不复制新快照就会让条款 7 的 `scriptSha256` 检查变红。

脚本直接编排 A 的 `y2-mcp-http-worker.sh` 与 B 的 `x2-mcp-extension.sh`、`x3-mcp-extension-surface.sh`，不另写它们的探针。新增组合探针仅补齐不同 root 的实例隔离、Pi 工具面与中继组合、资源和生命周期证据。固定 300 秒的执行上限使未完成调用有明确退出结论。

- [evidence.json](evidence/evidence.json)：七条索引、生成时间、被验 source commit、脚本 SHA-256 及每个实际执行的退出码和 runner 耗时。条款 7 校验这份快照的 `scriptSha256` 等于当前 z3 脚本、`sourceCommit` 是当前 HEAD 的祖先或等于它；脚本或代码变了却没重跑并重存快照，条款 7 变红。
- [c-evidence.json](evidence/c-evidence.json)：新增组合探针的逐项断言。
- [run.log](evidence/run.log)：最后一次运行的七行原始状态输出。JSON 中的 `.verify/` 路径为当次本机采集位置；本目录中同名文件为可随仓库查看的快照。

每条证据保留其实际执行信息。证据只含布尔值、数量、工具名、状态和错误码，不包含工具输出正文、图片内容、secret 或 cookie。runner 耗时是各子进程从启动到退出的实测时间，不等于后台启动命令的返回时间。

## 已知限制与待确认事项

- Human 在 `2026-10-25T03:44Z` 授权更换验证载体，见编排工作区 `orchestrate/sprout-mio-r1/decisions.tsv` 第 4 行。第 3 条实际采用两个自有最小 server，第 4 条采用 server-everything；Unity Editor/Blender 的发现机制、插件和软件特有行为没有验证，不计入本轮 PASS 范围。七条计划原文完整保留。
- 新组合探针使用真实生产 relay service、Worker runtime/dispatcher、SQLite、独立进程与真实 Pi 工具定义，主体和租约由隔离 fixture 创建；service 调用直接进入生产入口。受认证 HTTP 边界由复用的 x2/y2 单独实测。目录新增到模型工具面的证据来自 x3 的真实 stdio/Pi 路径，未把它描述为一条新的远端 HTTP 场景。
- “可被模型调用”通过真实 Pi 活动工具面与 Pi 持有的工具定义执行验证，没有发起付费模型推理。目录变化证据覆盖新工具加入与 refresh 保持，未扩大为所有插件热更新行为的保证。
- owner_managed 登记适用于 streamableHttp 服务；不支持接管任意已运行进程的 stdio。官方 SDK 的两种传输对照用于参考，产品客户端仍为锁定的 Pi 1.4.0。
- 条款 7 只校验可以机器判定的东西：`docs/r1/summary.md` 与 `docs/r1/design.md` 存在、design 的关键组合词（薄 bridge、帧中继、Pi 原生客户端、SDK、长连接）出现、范围文档写了 MCP 接入与 P4c，以及 `docs/r1/evidence/evidence.json` 的 `scriptSha256` 等于**当前** z3 脚本的 SHA-256、`sourceCommit` 是当前 HEAD 的祖先或等于它。**文档内容是否与代码相符不由本门禁保证**：把 `owner_managed` 那句改成与代码相反的断言后条款 7 仍然 PASS（实测），语义一致性由独立验收者逐条核对。改过 z3 脚本后必须重跑并把新的 `clause-*.json`、`evidence.json`、`c-evidence.json`、`run.log` 复制进 `docs/r1/evidence/`，否则条款 7 变红。
- 每条条款有一份独立于条款 body 的必需字段清单（`scripts/verify/z3-mcp-acceptance.sh` 里的 `REQUIRED`）。条款的 `assertions` 必须包含这些键，每个键必须有一次真实的证据取值路径，且断言值必须等于那次取到的证据值；`clause-<n>.json` 记录该条款的 `projections` 作为取值来源。把条款 body 整条清空（`()=>({})`）或改为手写字面量都会让该条款 FAIL，而不是静默 PASS。
- 技术 PASS 不代替 Human 体验确认，也不自动改变一期验收范围。阶段纳入和四步 checklist 仍由编排者/Human 决定；本轮无需先改一期能力表或一期验收表。
