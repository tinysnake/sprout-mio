# R1 第五轮独立技术评审

- 仓库：`/Users/snake/workspace/sprout-mio` 的只读 worktree `/Users/snake/.herdr/worktrees/sprout-mio/r1-ac5b-readonly`
- 冻结 head：`efc7c28139d2a4b5d47a7b41d1c43318dd3b9183`
- 执行者模型：magpie/auto/deepseek-v4.1-flash（本轮执行）
- 所有独立产物位于 `/tmp/r1-ac5b/`。完整验证与探针日志没有收录原始服务日志或 SQLite 内容。
- 工作区状态：结束时 `git status --porcelain` 为空，`git diff efc7c28` 为空。

## 实际执行的命令

- `pnpm install --frozen-lockfile --offline`，worktree 首次安装依赖，`/tmp/r1-ac5b/install.log`。
- `pnpm worker:build && pnpm build`，worktree 生成当前 head 的产物，`/tmp/r1-ac5b/build.log`。之后 `dist/worker/main.js` 与 `.output/server/index.mjs` 均存在。
- `bash scripts/verify/z3-mcp-acceptance.sh`，独立基线，exit 0，七条全 PASS，`/tmp/r1-ac5b/z3-baseline.log`；运行 JSON 在 `.verify/z3-mcp-acceptance-t338DO/`。
- `bash scripts/verify.sh`，exit 0，42 scripts、failed=0，`/tmp/r1-ac5b/full-verify.log`。
- `bash scripts/verify/z2-mcp-integration.sh` 连跑 5 次，五次 exit 0，`/tmp/r1-ac5b/z2-five-summary.log` 与 `/tmp/r1-ac5b/z2-1.log` 至 `z2-5.log`。
- `pnpm typecheck`，exit 0，`/tmp/r1-ac5b/typecheck.log`。
- `pnpm check`，exit 0，0 errors、2 warnings，`/tmp/r1-ac5b/check.log`。
- `SPROUT_PI_ENABLED=false DATABASE_URL=/tmp/r1-ac5b/independent-probe-drain5.sqlite pnpm exec tsx /tmp/r1-ac5b/session-probe.mts`，exit 0，`/tmp/r1-ac5b/session-probe-drain5.log`。
- 五个独立 git clone 变异副本各运行 `bash scripts/verify/z3-mcp-acceptance.sh`。命令日志分别为 `/tmp/r1-ac5b/tools-equality.z3.log`、`image-comparisons.z3.log`、`crossroot-read.z3.log`、`configured-lifecycle.z3.log`、`timeout-unknown.z3.log`、`stale-generation.z3.log`。变异副本位于 `/tmp/r1-ac5b/experiments/`。这里实际做了六种变异，六次门禁都七条全 PASS。

> 时间字段：verify runner 报告各子进程耗时；完整 verify 的工具墙钟总时长约 12 分钟。基线 z3 的 runner 依次记录 y2 2.8 秒、x2 12.2 秒、x3 2.4 秒、C 探针 5.6 秒。

## 必判点总表

| 组 / 子项                                        | 结论                                           | 一句话依据                                                                                                                                                                                                       | 本轮独立证据                                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 七条当前状态                                  | PASS                                           | 当前产物构建后 z3 exit 0，七条全 PASS；下列值各自有真实路径复核，证据端仍可被变异绕过                                                                                                                            | `.verify/z3-mcp-acceptance-t338DO/clause-1.json` 至 `clause-7.json`；`/tmp/r1-ac5b/z3-baseline.log`                                                                           |
| A1-1 两种 transport、工具数与往返                | PASS                                           | 独立官方 SDK 连 stdio 4 工具与 streamableHttp 1 工具；x2 经真实 Worker dispatcher 收发 20 个 server-everything 工具、上行 3 帧、下行 6 帧，工具名与 z2 名单深比较                                                | `.verify/z3-mcp-acceptance-t338DO/c-evidence.json`、`.verify/x2-mcp-extension-3897460352/evidence.json`                                                                       |
| A1-2 工具面与 allowlist                          | PASS                                           | Pi AgentSession 活动工具实际为 5 个获准 MCP 工具，read 调用成功，notify 与宿主 sentinel 不可见且未启动                                                                                                           | `.verify/z3-mcp-acceptance-t338DO/c-evidence.json`、`/tmp/r1-ac5b/z3-baseline.log`                                                                                            |
| A1-3 root 隔离、目标消失、不改投                 | PASS                                           | 自有 stdio server 的两组 root 读写隔离与跨 root 拒绝通过；结束 A 后 session/process 绑定不变，存活 B 仍可读且没有错投写入                                                                                        | `.verify/z3-mcp-acceptance-t338DO/c-live.mts:112-127,184-193`、`.verify/z3-mcp-acceptance-t338DO/c-evidence.json`                                                             |
| A1-4 图片与 structuredContent 字节/深度相等      | PASS（真实比较存在）；门禁证明充分性 FAIL      | 原始 fixture 做了 base64 字符串逐字符比较和 structuredContent 深比较；变异成仅长度/存在性判断后门禁仍 PASS                                                                                                       | `tests/fixtures/mcp-extension-surface.ts:182-183,214-218`、`.verify/x3-mcp-extension-surface-1194869217/evidence.json`、变异 `/tmp/r1-ac5b/image-comparisons.z3.log`          |
| A1-5 list_changed、超时、旧代次                  | PASS（真实路径）；门禁证明充分性 FAIL          | 新工具真实调用回 `called:added-1`；超时实际请求 server 后结果 unknown；旧代次 MCP 调用返回 `lease_stale_generation` 且帧数不变                                                                                   | `.verify/x3-mcp-extension-surface-1194869217/evidence.json`、`.verify/z3-mcp-acceptance-t338DO/c-live.mts:177-180,211-224`                                                    |
| A1-6 owner_managed / configured_service 生命周期 | PASS（真实 y2 路径）；门禁证明充分性 FAIL      | owner_managed 不 spawn，删除与 Worker 退出后服务存活；configured_service 的实际子进程 PID 与服务响应 PID 一致，Worker 退出后 PID 不存活                                                                          | `.verify/y2-mcp-http-worker-rHHasx/evidence.json`、`tests/fixtures/mcp-http-worker-live.ts:353-365,541-582`                                                                   |
| B1 summary 对门禁边界的描述                      | PASS（准确但边界本身不足）                     | summary 明确写明门禁只核探针布尔等于期望、不能核布尔如何算出，也明确不把 z3 PASS 等同技术验收                                                                                                                    | `docs/r1/summary.md:41-44`                                                                                                                                                    |
| B2 五种以上新变异                                | FAIL（门禁抵抗性）                             | 六种变异都保持 z3 exit 0，七条全 PASS                                                                                                                                                                            | `/tmp/r1-ac5b/tools-equality.z3.log`、`image-comparisons.z3.log`、`crossroot-read.z3.log`、`configured-lifecycle.z3.log`、`timeout-unknown.z3.log`、`stale-generation.z3.log` |
| B3 门禁可独立支撑技术验收                        | FAIL                                           | 只要探针比较、故障路径或生命周期断言被替换成同类型满足值的弱判断，发布哈希同步后仍全绿                                                                                                                           | 上述变异日志；见 §门禁变异表                                                                                                                                                  |
| C1 对端伪造“完成”状态                            | CONFIRMED（E2b 关闭旧伪 ack 缺陷）             | Worker 发出的 reconcile ack 在 bound/hash 正确但与 Worker 实际仍活跃 entry 不一致时，被 relay 接收为帧事实但不确认 detached；下一轮仍发送快照，Worker entry 仍 active，随后同 process 新 attach 成功             | `/tmp/r1-ac5b/session-probe-drain5.log`，`/tmp/r1-ac5b/session-probe.mts:84-105`                                                                                              |
| C2 220 条积压三轮 attach                         | CONFIRMED                                      | 独立真实生产路径中 220 条关闭历史加新会话后，三轮各发出 1 个 attach 和 1 个 reconcile                                                                                                                            | `/tmp/r1-ac5b/session-probe-drain5.log`                                                                                                                                       |
| C3 8192 字节极紧预算                             | PASS（符合摘要描述）                           | 8192 字节预算下 0 个控制项、8 个游标、attach 未发出；正常预算恢复后 attach 发出                                                                                                                                  | `/tmp/r1-ac5b/session-probe-drain5.log`                                                                                                                                       |
| C4 gateway drain 到 MCP drain                    | CONFIRMED（可达）；当前完整 drain 响应契约受阻 | gateway drain 真实调用 `applyMcpExchange`；该函数确实收到 drain，空 reconcile；但 `applyRemoteExchange` 仍返回 authorization，合法 worker response schema 拒绝整包。registration fact 在 drain 中由 MCP 分支拒绝 | `/tmp/r1-ac5b/session-probe-drain5.log`；`src/server/worker-gateway.ts:179-183,335-369`、`src/server/remote.ts:1199-1206,1218`、`src/domain/mcp/exchange.ts:150-193`          |
| D1 summary 关于 sampling handler                 | PASS（如实）                                   | 生产扩展调用点不注入 handlers；组合 fixture 注入固定响应，正如 resume 所述                                                                                                                                       | `src/extension/mcp-extension.ts:216-221`、`tests/fixtures/mcp-extension-live.ts:374-381`；`docs/r1/summary.md:38-39`                                                          |
| D2 elicitation 仅 cancel                         | PASS（如实）                                   | 合同仅有 absent/cancel，fixture 返回 `{action:'cancel'}`                                                                                                                                                         | `src/contracts/mcp.ts:75-78`、`tests/fixtures/mcp-extension-live.ts:374-381`                                                                                                  |
| D3 dist worker stdio 跨进程未跑                  | REFUTED（resume 说未跑，但本轮验证已跑）       | y2 fixture spawn `dist/worker/main.js`，Worker CLI `realCli=true`、`bundled=true`，transport 包含 stdio 和 streamableHttp，确有跨进程 stdio MCP service                                                          | `tests/fixtures/mcp-http-worker-live.ts:300-320`、`.verify/y2-mcp-http-worker-rHHasx/evidence.json`                                                                           |
| D4 真实模型选工具对话                            | PASS（如实）                                   | summary 明确只有真实 Pi 工具注册与定义调用，未发起真实模型推理                                                                                                                                                   | `docs/r1/summary.md:39`                                                                                                                                                       |
| D5 dispatch 项失败导致 Worker 退出               | PASS（代码状态）                               | `dispatcher.accept` 抛错被转为 `ClientError("invalid_response")`，Effect 失败结束本次 Worker fiber                                                                                                               | `src/worker/client.ts:254-258`                                                                                                                                                |
| D6 gateway ctx.mode                              | REFUTED（旧注解错误）                          | normal 与 drain 分支分别传自身 mode；实际 drain 到 `applyMcpExchange`，未见 mode 硬编码错误                                                                                                                      | `src/server/worker-gateway.ts:241-316,335-369`、`/tmp/r1-ac5b/session-probe-drain5.log`                                                                                       |
| D7 session_fence closed 分支死代码               | CONFIRMED                                      | 仓库生产写入点搜索只有 schema、映射和两处读取；无生产赋值点，列默认 null                                                                                                                                         | `src/db/schema.ts:1409`、`src/server/mcp-relay.ts:174`、`src/domain/mcp/exchange.ts:497,630-638`                                                                              |
| E1 空数据库迁移                                  | PASS                                           | 全量 verify 中 v-mcp-contracts 与 y2 都从独立空库运行迁移、完整外键检查通过                                                                                                                                      | `/tmp/r1-ac5b/full-verify.log` 搜索 `empty database migrations`、`foreign_key_check`                                                                                          |
| E2 typecheck/check                               | PASS                                           | typecheck exit 0；check exit 0，有 2 warnings                                                                                                                                                                    | `/tmp/r1-ac5b/typecheck.log`、`/tmp/r1-ac5b/check.log`                                                                                                                        |
| E3 全量验证与范围脚本                            | PASS                                           | 42 scripts、failed=0；w-worker-remote PASS；z2 连续 5 次 PASS                                                                                                                                                    | `/tmp/r1-ac5b/full-verify.log`、`/tmp/r1-ac5b/z2-five-summary.log`                                                                                                            |

## 门禁变异实验

所有变异均在 `git clone --no-hardlinks` 的 `/tmp/r1-ac5b/experiments/<name>/` 副本中完成，不改主 worktree；变更脚本 SHA 时同步副本里的 `docs/r1/evidence/evidence.json`。每个命令都跑全套 z3。

| #   | 变异                                                                             | 改动位置                                  | 实测       | 说明                                                     |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------- | ---------- | -------------------------------------------------------- |
| M1  | tools/list 深比较替换为 `rawToolNames` 与自身深比较                              | `tests/fixtures/mcp-extension-live.ts`    | 绿，7 PASS | 没有比较服务端工具名和预期名单，工具数、帧数不变         |
| M2  | 图片 base64 相等改成仅长度大于 100；structuredContent 深比较改成字段存在         | `tests/fixtures/mcp-extension-surface.ts` | 绿，7 PASS | 断言不再验证服务端和 Pi 收到的数据相同                   |
| M3  | 删除不同 root 的跨 root read 拒绝断言                                            | z3 内嵌 `c-live.mts` 生成模板             | 绿，7 PASS | A3 对应断言只在 fixture 中，harness 使用该证据端自报布尔 |
| M4  | configured_service Worker 退出后等待立即成功，证据固定 false                     | `tests/fixtures/mcp-http-worker-live.ts`  | 绿，7 PASS | 不再等待子进程终止，字段仍声称已终止                     |
| M5  | timeout 探针直接返回 `{requestReachedServer:true,outcome:'unknown'}`             | z3 内嵌 `c-live.mts` 生成模板             | 绿，7 PASS | 未调用永不响应工具、未检查请求 marker                    |
| M6  | 旧代次 MCP 调用及错误捕获改为本地常量 `lease_stale_generation`，前后帧数比较照旧 | z3 内嵌 `c-live.mts` 生成模板             | 绿，7 PASS | 不再触达服务端旧代次路径                                 |

这些结果与 summary 记录的证明边界一致。它准确写出门禁的不足，但不足仍足以否定“门禁可独立采信”的要求。运行脚本哈希只能证明快照跟当前脚本自洽，不能证明探针比较本身存在。

## 技术判定值的来源与语义

- **第 1 条**：独立 SDK 对照的 `stdioConnected=true/stdioToolCount=4` 与 `streamableHttpConnected=true/httpToolCount=1` 是分别 `connect` 后调用 `listTools()` 的结果。产品侧 x2 连接真实 server-everything，经 `RemoteDispatcher` 帧传输后 Pi `listTools()` 得到 20 个名字；`toolCount=toolNames.length`。`endToEndToolsList` 是正向帧数且 `toolsListMatchesExpected` 的函数结果，名字数组逐项与 z2 固定清单深比较。当前断言语义充分，但门禁 M1 证明比较可被删除并更新断言。
- **第 3 条**：不同 root 的 read/write 与 cross-root reject 均执行真实 stdio 子进程。进程 A 被 SIGTERM 后检查旧 session 行及 `process_id` 数组不变、A 写调用拒绝、root B 的 `value.txt` 仍是 `root-1`。c-evidence 中若干结果布尔是在断言执行后写 true，语义由模板断言支持。门禁 M3 证明可移除关键故障断言而让布尔继续 PASS。
- **第 4 条**：`mcp-extension-surface.ts` 确实保存由 Pi 工具 definition 调用结果和同一 MCP client 直接调用 server 的值；base64 是字符串严格相等，structuredContent 是 `isDeepStrictEqual`；C 探针也对图片字符串 `assert.equal(block.data, original.data)`、对结构化值 `assert.deepEqual(...)`。证据不是散列或首尾校验。注意 C 探针的 `bytesEqual` 等字段在 return 里写 true，但之前有真实断言；x3 的字段则取真实比较布尔。本轮 M2 证明门禁信任结果生产代码的比较。
- **第 5 条**：list_changed 后新定义进入工具列表，真实执行返回 `called:added-1`；超时调用在 server 写出 marker，结果 outcome 为 unknown；旧代次从 `releaseLease` 后真实 `mcpSessionExchange` 获取错误，数据库 `mcp_frame` 行数前后相同。M5/M6 证明这些故障路径的实测可被删掉。
- **第 6 条**：y2 启动的是打包后的 CLI 子进程；worker 的子进程表只含 configured_service 的真实 PID，owner server 的 PID 等于 fixture HTTP server；DELETE 之后 owner 服务仍能由 HTTP 请求访问，Worker 退出后仍可访问。configured_service 等 Worker 退出后，waitFor 观察 PID 不存在，live() 为 false。M4 显示该终态断言可被固定值冒充。

## 会话收敛探针结果

探针 `/tmp/r1-ac5b/session-probe.mts` 自建主体、grant、Machine、项目绑定、租约、SQLite 和真实 stdio server，通过 `openWorker`、`exchangeWorker`、`applyRemoteExchange`、`applyMcpExchange`、`McpRuntime`、`RemoteDispatcher` 与 relay open/close。输出在 `/tmp/r1-ac5b/session-probe-drain5.log`。

- 第一轮保留旧 Worker entry，关闭服务端 session 后截住 cleanup delivery。随后把 relay 发出的 snapshot 原样转成 `session_reconcile_ack`，只改 closed hash 让确认内容合法但不对应 relay 当前历史。`exchangeWorker` 接受该类型帧；ack 不会推进 `worker_detached_at`。响应仍有 `session_reconcile`；entry 仍 active=1。立即同 process 打开新 session，下一 exchange 发出 attach，绑定 process ID 不变。
- 建立 220 条关闭历史，再逐轮建新 session。`attachForFresh=[1,1,1]`、`reconciliationCounts=[1,1,1]`。独立探针会话行总数含先前场景，因此日志显示 225 条 closed 行，核心积压循环仍为 220。
- `maxBytes=8192` 得到 `controls=0,cursors=8,attachEmitted=0`；预算恢复后 `resumedAttach=1`。
- 核实 drain mode 更正：`exchangeWorker` 对 `mode:"drain"` 进入 `drainExchange`，传 `{...ctx,mode:"drain"}` 给 `applyRemoteExchange`；函数在同一调用栈将它传给 `applyMcpExchange`。实际 drain 返回空-session reconcile。但 `applyRemoteExchange` 当前仍添加一条 `draining` authorization。真实完整 response 因此不符合 `workerExchangeResponseSchema`，Worker 会拒绝响应。这是 `src/server/remote.ts` 的 drain envelope 问题，不是 gateway mode 丢失。若输入 registration_fact，MCP domain 按 `ctx.mode !== "normal"` 报 `MCP registration during drain`，gateway 映射成 `remote_request_conflict`。

## 未验边界与摘要诚实性

| 边界                                | resume checkpoint             | summary                                       | 本轮判定                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生产 runner 不注入 sampling handler | 写了                          | 没有直接列为限制；只写 fixture 与模型推理边界 | summary 不完整。生产 `registerSproutMcp` 可由调用方注入 handlers；实际宿主 runner 调用没有提供，因此当前无 sampling handler。                                                                             |
| elicitation 只返回 cancel           | 写了                          | 未直接列为限制                                | summary 不完整。协议 handler 由 fixture 注入且只有 cancel。                                                                                                                                               |
| `dist/worker/main.js` 跨进程 stdio  | 写“未跑”                      | 未列                                          | **REFUTED**。y2 用真实 CLI 子进程及真实 stdio server 跑过。应更新 resume 的过时边界；summary 建议明示该覆盖。                                                                                             |
| 真实模型自动选工具对话              | 写了                          | 写了未发起真实模型推理                        | 如实                                                                                                                                                                                                      |
| dispatch item 失败使 Worker 退出    | 写了                          | 没写                                          | summary 未记录。调用链仍存在，影响是 MCP 响应项若违反 bound/身份/代次校验，`dispatcher.accept` 转 `invalid_response`，当前 Worker fiber 退出；服务端可能需等 Worker reconnect，不会把这种协议拒绝当成功。 |
| gateway mode 硬编码 normal          | checkpoint 已订正为原注解记错 | 没写                                          | 旧问题 REFUTED。新实测：gateway 确实传 drain 到 MCP；完整响应被 `applyRemoteExchange` 的 authorization 与 drain response schema 冲突阻塞。                                                                |
| `session_fence` closed 行生产写入点 | 写了                          | 写了                                          | 如实，生产无写点，迁移/默认均 null；closed 分支目前没有可由生产流程制造的 mutation id。                                                                                                                   |

## 额外验证

- 从零建库与迁移：全量 verify 的 v-mcp-contracts 跑空 SQLite，应用表 37 张匹配、迁移 ledger 等于 15 个 SQL 文件；y2 另从 0011 前账本迁移到 0014 并重复迁移。`/tmp/r1-ac5b/full-verify.log`。
- `pnpm typecheck` exit 0；`pnpm check` exit 0，0 errors、2 warnings（两个既有 TS lint warning，位于 `src/domain/mcp/exchange.ts` 附近）。
- 冻结 head 的 `bash scripts/verify.sh` 实际 42 脚本，failed=0；其中 `w-worker-remote.sh`、`z2-mcp-integration.sh`、z3 均 PASS。另 z2 单独连跑五次全绿。本轮没有复测旧 head `f0c8715` 上的来源归属，也不将当前全绿外推到其历史根因。

## 新发现与阻塞项

1. **阻塞 R1 技术验收：z3 门禁允许证据源不执行所称语义。** 六种新变异全绿，涵盖内容比较、故障路径、生命周期、隔离断言。当前 summary 已诚实描述这个限制；编排者/Human 必须将独立探针人工审查作为技术验收条件，或先把证据生产计算搬入门禁并再次攻击验证。
2. **真实 gateway drain 响应链仍失败（高，建议阻塞 drain 相关收口）。** mode 已正确到达 MCP domain，清除当前 authorization 输出后才有机会通过 worker drain response schema。每个 drain 请求会遇到 `applyRemoteExchange` 添加授权的既有逻辑，schema 明确拒绝 drain authorization。此次只读评审未修。
3. **summary 未汇总两项 handler 边界与 dispatch 失败后 Worker 退出影响。** resume 有记，summary 缺少，建议补充，避免七条 PASS 被读成生产模型能力与任意协议错误都已覆盖。
4. **summary/resume 的 stdio 边界记录不同步。** summary 目前未说明，resume checkpoint 写“未跑”；本轮实际 y2 子进程跑了打包 Worker 和真实 stdio MCP server，应在最终报告更新此行。
5. 生产 `session_fence` mutation id 无写入路径。该分支仅靠直接 SQL 修改才能触发，当前仍属死路径，scope 外，不建议本轮动。

## 结论

**R1 七条当前技术行为本身：PASS（证据为本轮实测）。R1 技术验收整体：暂不可判通过。**

最小阻塞项是门禁证据生成可被替换而保持七条 PASS，导致门禁 exit 0 不能独立支撑验收。当前已知限制描述准确，所以也可以由编排者明确要求独立审查原始探针与本轮证据；仅凭发布证据快照和七条 PASS 不足以通过。真实完整 drain envelope 仍有单独问题，若 R1 接受 Worker drain 会话清理为技术范围则需修复或明示暂不验。

Human 体验确认与一期范围归属仍不由本报告代替。
