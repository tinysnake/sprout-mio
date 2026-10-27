# R1 MCP 验证结论

R1 七条当前行为复核均为 PASS，但 R1 整体技术验收未通过。z3 返回 0 且七条全 PASS，逐条 JSON 与运行输出保存在 [evidence/](evidence/)。第五轮证明 z3 仍可被证据生产端变异绕过，且发现真实 Worker drain response 契约冲突，因此 z3 结果不能单独作为技术验收结论。这些行为复核适用于 Human 授权替换后的无界面 server，不表示已验证 Unity 或 Blender 插件。

**R1 当前仍是独立验证任务，尚未纳入一期。** 原纳入建议要求 P4c 身份与授权契约稳定、R1 独立验收通过并完成 Human 确认。第五轮发现门禁抵抗性不足且 drain exchange 被响应契约拒绝，因此技术验收未通过。

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

刷新本目录的证据快照时，跑完上面这条后把新目录里的 `clause-*.json`、`evidence.json`、`c-evidence.json`、`run.log` 按原字节复制进 `docs/r1/evidence/`。该目录已从格式化检查中排除，不运行格式化修复；字节一致性属于证据的一部分。不复制新快照就会让条款 7 的 `scriptSha256` 检查变红。

脚本直接编排 A 的 `y2-mcp-http-worker.sh` 与 B 的 `x2-mcp-extension.sh`、`x3-mcp-extension-surface.sh`，不另写它们的探针。新增组合探针仅补齐不同 root 的实例隔离、Pi 工具面与中继组合、资源和生命周期证据。固定 300 秒的执行上限使未完成调用有明确退出结论。

- [evidence.json](evidence/evidence.json)：七条索引、生成时间、被验 source commit、脚本 SHA-256 及每个实际执行的退出码和 runner 耗时。条款 7 校验这份快照的 `scriptSha256` 等于当前 z3 脚本、`sourceCommit` 是当前 HEAD 的祖先或等于它；脚本或代码变了却没重跑并重存快照，条款 7 变红。
- [c-evidence.json](evidence/c-evidence.json)：新增组合探针的逐项断言。
- [run.log](evidence/run.log)：最后一次运行的七行原始状态输出。JSON 中的 `.verify/` 路径为当次本机采集位置；本目录中同名文件为可随仓库查看的快照。

每条证据保留其实际执行信息。证据只含布尔值、数量、工具名、状态和错误码，不包含工具输出正文、图片内容、secret 或 cookie。runner 耗时是各子进程从启动到退出的实测时间，不等于后台启动命令的返回时间。

逐项突变复跑用 `python3 docs/r1/gate-round2-mutations.py`。从干净提交开始，日志保存在 `.verify/d2-mutations-*`，每项结束后恢复原字节并检查工作树为空。

## 已知限制与待确认事项

- Human 在 `2026-10-25T03:44Z` 授权更换验证载体，见编排工作区 `orchestrate/sprout-mio-r1/decisions.tsv` 第 4 行。第 3 条实际采用两个自有最小 server，第 4 条采用 server-everything；Unity Editor/Blender 的发现机制、插件和软件特有行为没有验证，不计入本轮 PASS 范围。七条计划原文完整保留。
- 新组合探针使用真实生产 relay service、Worker runtime/dispatcher、SQLite、独立进程与真实 Pi 工具定义，主体和租约由隔离 fixture 创建；service 调用直接进入生产入口。受认证 HTTP 边界由复用的 x2/y2 单独实测。目录新增到模型工具面的证据来自 x3 的真实 stdio/Pi 路径，未把它描述为一条新的远端 HTTP 场景。
- “可被模型调用”通过真实 Pi 活动工具面与 Pi 持有的工具定义执行验证，没有发起付费模型推理。目录变化证据覆盖新工具加入与 refresh 保持，未扩大为所有插件热更新行为的保证。
- owner_managed 登记适用于 streamableHttp 服务；不支持接管任意已运行进程的 stdio。官方 SDK 的两种传输对照用于参考，产品客户端仍为锁定的 Pi 1.4.0。
- 条款 7 只校验可以机器判定的东西：`docs/r1/summary.md` 与 `docs/r1/design.md` 存在、design 的关键组合词（薄 bridge、帧中继、Pi 原生客户端、SDK、长连接）出现、范围文档写了 MCP 接入与 P4c，以及 `docs/r1/evidence/evidence.json` 的 `scriptSha256` 等于**当前** z3 脚本的 SHA-256、`sourceCommit` 是当前 HEAD 的祖先或等于它。**文档内容是否与代码相符不由本门禁保证**：把 `owner_managed` 那句改成与代码相反的断言后条款 7 仍然 PASS（实测），语义一致性由独立验收者逐条核对。改过 z3 脚本后必须重跑并把新的 `clause-*.json`、`evidence.json`、`c-evidence.json`、`run.log` 复制进 `docs/r1/evidence/`，否则条款 7 变红。
- 每条条款的必需字段表 `REQUIRED` 固定 `{path, expect}`。遍历循环先从这些固定路径读取证据并核对精确值或命名谓词，再运行条款 body。返回的 `assertions` 必须齐全、等于已核实的值，且 body 的取值路径必须与固定路径一致；`clause-<n>.json` 同时记录 `verified` 和 `projections`。清空 body、写死正确字面量或给 `evidenceAt` 起别名读取无关路径都会 FAIL。
- **上面这一条只约束条款 body，不约束证据生产端。** 门禁读到的是探针自己写进 evidence 的布尔值，它核的是「这个值等于 harness 写的期望值」，**不是「探针真的算过这个值」**。第四轮实测：把 x3 的 `structuredContentMatchesServer` 真实 `isDeepStrictEqual` 与 `assert` 整体删掉、字面量写 `true`，z3 七条全 PASS（exit 0）；把 C 探针里 `assert.equal(block.data, original.data)` 删掉并同步快照 `scriptSha256`，同样七条全 PASS。同类还有：`predicates.mcpTools` 接受 `['mcp__']`；`officialSdkVersion` 只证明「探针读到的版本等于磁盘上的版本」，不证明真的连过官方 SDK；删掉条款 body 里的 `passed('y2')` 后探针的红退出码不再被核。SDK 版本与实际导入包同目录的 `package.json` 核对；x2 的端到端成功同时要求帧往返与工具名集合等于 z2 的唯一预期清单。生产 runner 的 allowlist 用 TypeScript AST 定位真实 `sdk.createAgentSession` 的 `tools` 数组，注释与字符串里的伪调用不参与取样。
- E2b 之后的 MCP 会话收敛依据是 relay 每轮下发的权威活跃集合，不是对端的确认报文。`session_detach_ack` 已删除；确认报文只记录时间，不关闭重试。第五轮真实 gateway 探针确认 drain mode 到达 MCP domain。随后 `3d0a0e4` 为 drain exchange 加上窄投影，阻止 lease authorization 进入响应。该修复已在主 checkout 通过 `tests/worker-remote-domain.test.ts`、`pnpm typecheck`、`v-lease-contracts.sh` 和 `w-worker-remote.sh`。主 checkout 尚未重跑完整 z3 与全量 verify。8192 字节预算时 attach 暂缓，恢复预算后补发。
- `session_fence` 的 closed 行分支在生产代码里没有 `fenceMutationId` 写入点，只有读取，属 P4b 租约语义，R1 未接上也未删除。
- 生产 runner 调用 `registerSproutMcp` 时没有提供 sampling handler。elicitation 仅支持 absent 或 `{action:'cancel'}`。这些限制与固定 fixture 的协议往返证据一致，不代表生产模型采样或 Human 表单交互。
- `y2-mcp-http-worker.sh` 使用打包的 Worker CLI 子进程连接真实 stdio MCP server 和 streamableHttp server，已覆盖跨进程 stdio。没有真实模型自动选择 MCP 工具的一轮推理。
- Worker 下行 dispatch 项若未通过 `dispatcher.accept` 的身份校验会转成 `invalid_response` 并结束当前 Worker fiber，Worker 随后需要重连。该情况不会报告为 MCP 调用成功。
- 第五轮独立验收报告 [第五轮独立验收记录](acceptance-round5.md) 确认七条当前行为通过，同时发现 z3 六种证据变异仍全绿。z3 不能独立证明探针实际执行其声称的语义比较或故障路径，因此 z3 PASS 仅是必要检查，不是独立技术验收结论。技术验收仍待门禁整改与复验。Human 体验确认与一期范围纳入仍未完成。

## 第五轮独立复核补充（`efc7c28`）

第五轮在当前构建产物上复跑 z3 七条全 PASS，42 个 verify scripts 全绿，z2 连跑五次全绿。其独立探针重测了 Worker MCP session reconcile：合法但陈旧的对端确认不会停止权威快照重试；220 条历史积压时连续三轮均能发出新 attach；8192 字节极紧预算会暂缓 attach，预算恢复后补发。真实 gateway drain mode 已到达 MCP domain，但完整 response 仍含 drain schema 禁止的 lease authorization，因此 Worker 会拒收；此项作为 R1 整改阻塞，不能由 z3 七条 PASS 覆盖。报告见 `orchestrate/sprout-mio-r1/reports/acceptance-round5.md`。

- 生产 extension runner 调用 `registerSproutMcp` 时没有注入 sampling handler；当前验证 fixture 会注入固定响应。elicitation 合同只允许 absent 或 cancel，测试 handler 返回 `{action:'cancel'}`。两项都没有真实模型采样或 Human 表单交互。
- `y2-mcp-http-worker.sh` 通过打包 Worker CLI 子进程和真实 stdio MCP server 跑过端到端调用。没有真实模型按工具名自动选用 MCP 工具的一轮推理。
- Worker dispatcher 任一下行项目若在 `dispatcher.accept` 的 bound/身份校验失败，会转为 `invalid_response` 并结束当前 Worker fiber。该行为不是 MCP 工具调用成功，服务端需要等待 Worker 重连；本轮未修改该既有策略。
- z3 仍不能独立证明探针实际执行了其声称的比较或故障路径。第五轮六种新证据变异均保持七条 PASS。因此 z3 是可重复的必要检查，不是独立技术验收结论；R1 收口必须依赖独立审查证据生产路径，或先修门禁并通过新的变异攻击复核。
