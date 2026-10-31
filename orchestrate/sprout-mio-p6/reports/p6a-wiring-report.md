# P6a 判定器接线报告

分支：`p6a/wiring`；基线：`integration/p6a`（`1354ec9`）。已接通生产 runtime → scheduler → wake evaluator → 指定 provider → 验证后的 result → durable evaluation / continuation delivery。最终要求的八个门禁及 typecheck、lint、格式检查均通过。存在一项上游契约边界：Project 完全没有 wake policy 时，现有 `buildPeriodicInput()` 在调用 evaluator 前拒绝请求，详见末尾。

改动仅为 brief 允许的四个代码/门禁文件，以及本报告：

- `src/server/wake-runtime.ts`：新增 `createWakeEvaluator({ clock, complete?, fetch? })`。经既有 `evaluateWake()` 按 policy provider 选择唯一判定器，其内部 `wakeEvaluationResultForInputSchema` 保留响应验证；把 receipt 的 `result` 交回调度器。
- `src/server/runtime.ts`：在 `state.automation.start()` 前安装 evaluator。`startRuntime()` 仅透传既有 complete/fetch 模型边界，生产无参数调用保留真实 Pi completion / JEV HTTP 默认实现。停机路径没有改动。
- `tests/fixtures/p6a-wiring.ts`：真实 runtime、真实 scheduler、真实 SQLite，71 条断言。
- `scripts/verify/p6a-wiring.sh`：与现有门禁一致的 8 行薄壳，独立 `.verify/p6a-wiring/verification.sqlite`。未修改 `scripts/verify/lib/*.mjs` 或任何既有门禁断言。

小脑 agentDir 与宿主使用相同来源及表达式：`resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"))`。模型优先取 policy.model；模型字段为空时，从该 agentDir 的 settings.json 读取 defaultProvider/defaultModel，组成宿主模型标识。JEV 读取 JEV_API_KEY，使用冻结设计阈值 `p6a-design-default-v1`（yes=0.8、no=0.2）；其他阈值版本由原判定器拒绝，不假装支持。凭据只传给 JEV provider，未写入日志、diagnostic、receipt 或期望文件；门禁只使用进程内生成的临时假凭据，原环境在 finally 中恢复。

原 brief 把 EvaluateWake 描述为返回 WakeReceipt，但现有 `src/domain/continuation-delivery.ts` 的实际类型是 `Promise<WakeEvaluationResult>`。适配器保留 receipt 验证后返回 `.result`，不改共享契约；usage 不被当前 wake_evaluation 存储模型持久化。

## 验证证据

以下均实际执行并等待进程退出。耗时是 Python runner 对每个命令从启动到退出的墙钟时间，包含 Node/tsx 启动开销；不是后台启动耗时，也不是模型延迟或性能基准。各调用总超时 300 秒。原始日志及机器可读退出码在 `/tmp/p6a-wiring-validation/`，最终门禁证据在 `.verify/p6a-wiring/wiring-result.json`。

| 实际命令                                                                                                 | exit code | 门禁自报的断言/检查                     | runner 秒 |
| -------------------------------------------------------------------------------------------------------- | --------: | --------------------------------------- | --------: |
| `pnpm typecheck`                                                                                         |         0 | 0 TypeScript 错误                       |     7.821 |
| `bash scripts/verify/p6a-wiring.sh`                                                                      |         0 | 71 assertions                           |     1.009 |
| `bash scripts/verify/p6a-scheduler.sh`                                                                   |         0 | 20 assertions                           |     0.862 |
| `bash scripts/verify/p6a-delivery.sh`                                                                    |         0 | 41 assertions                           |     0.934 |
| `bash scripts/verify/p6a-control.sh`                                                                     |         0 | 23 assertions                           |     0.863 |
| `bash scripts/verify/i2-group-chat.sh`                                                                   |         0 | 13 checks                               |     0.429 |
| `bash scripts/verify/i3-public-channel.sh`                                                               |         0 | 6 channel checks + 5 remote/host 检查点 |     1.188 |
| `bash scripts/verify/i4-agent-fanout.sh`                                                                 |         0 | 12 PASS 检查点                          |     1.162 |
| `bash scripts/verify/p6a-routing.sh`                                                                     |         0 | 305 assertions + 独立 import 成功检查   |     1.049 |
| `pnpm exec vp lint src/server/runtime.ts src/server/wake-runtime.ts tests/fixtures/p6a-wiring.ts`        |         0 | 无 lint 报错                            |     1.243 |
| `pnpm exec vp fmt --check src/server/runtime.ts src/server/wake-runtime.ts tests/fixtures/p6a-wiring.ts` |         0 | 格式通过                                |     0.664 |

I2/I3/I4 的既有脚本没有自报精确 assert 调用总数，表中保持它们真实输出的检查点单位，不把检查点数冒充 assertion 数。所有既有断言完整运行，没有修改、放宽或删除。

新门禁的 Risk → Test 映射：

1. 遗漏生产接线：runtime 初始化后全局 evaluator 存在；到期 Chat 被真实调度器认领，小脑 result 持久化为 decided，continuation_delivery 恰新增一条。
2. 错误回退：缺失 JEV key 时保存 provider_unavailable 的 result/error_code，小脑增量调用为 0、JEV HTTP 为 0，消息/run/delivery 计数均不变。两个 provider 的 transport throw、非法响应也都保存 indeterminate 失败事实，另一 provider 调用增量为 0。
3. 配置切换污染历史：small_brain → jev → small_brain 的后续检查使用新 policy；configRevision 增加，旧成功检查的完整行不变；旧失败检查的 input/result/error_code 不变。旧 retry_wait 随 policy 改变变为 stale，是既有调度语义，不把生命周期字段也误称为不可变。
4. 暂停仍请求模型：schedule 已到期后暂停，真实 scheduler.advance / settled 不新增 provider 调用或 evaluation。
5. 判定器越权产生副作用：对两个 provider 各调用一次真实安装的 evaluator，使用 SQLite TEMP trigger 观察完整判定调用期间每张业务表的 INSERT/UPDATE/DELETE；chat、chat_member、message、task、task_event、task_checklist_item、machine_lease、lease_authorization、lease_mutation、agent_run、continuation_delivery 的操作计数逐项为 0。调度器提交和 delivery 绑定发生在判定边界之外。
6. 默认模型漂移：验证实际 policy.model、宿主 agentDir 来源，并以临时宿主 settings.json 验证 defaultProvider/defaultModel 的解析及模型标识进入验证后的失败 result。

回归红绿证据：临时仅移除 runtime 中 `installWakeEvaluator(...)` 调用，运行新门禁返回 exit 1，准确失败于 `runtime installs its evaluator`；日志在 `/tmp/p6a-wiring-red.log`。随后恢复安装语句，最终完整门禁 exit 0 / 71 assertions。初次运行因新 worktree 尚无 tsx 在加载 fixture 前退出 1；`pnpm install --frozen-lockfile` exit 0 后恢复执行，没有把依赖失败计作业务验证。开发过程中还修正了本次新 fixture 对 no 决策名和 stale 生命周期的两个初始预期；没有改动任何既有门禁。

## 替身的范围与未证明的内容

`complete` 替掉小脑的宿主模型 SDK/subprocess completion；`fetch` 替掉 JEV 的远端 HTTP 请求。provider 的请求构造、候选集合校验、响应 schema、确定性/概率阈值转换、异常到 failedWakeResult 的转换、唯一 provider 派发、runtime 生命周期、claim/commit、数据库触发器及 delivery 创建/绑定均是真实实现。

本轮没有证明付费模型服务的可用性、真实认证配置、真实 SDK 模型发现、JEV 服务概率质量、真实小脑中文判定质量，或 Pi 实际运行并完成自动接续任务。门禁关闭执行宿主，证明到 durable delivery / queued run 的边界；真实模型接入及质量证据仍应由 live-routing 和章节集成验收负责。

## 遗留与协调者登记建议

Project 的 wake_policy 完全为 NULL 时，`buildPeriodicInput()` 当前直接抛 provider_unavailable；WakeEvaluationInput 的 policy/model 以及 ProjectWakePolicy 的 model 都是必填。因此工厂内的宿主默认模型解析能够处理缺少模型值的适配器输入，但无法使一个完全没有 policy 的 Project 到达 evaluator。这不是新增环境开关能解决的问题；需要协调者决定是否在后续单元调整上游 policy 默认配置契约。遵守 brief 的禁止项，本单元没有改 continuation-delivery、wake-evaluation 或 policy 语义，也没有在 runtime 偷写 Project 配置。

建议登记为独立 server/domain fixture suite：执行 `scripts/verify/p6a-wiring.sh`，不要求应用 build、浏览器或模型/网络，SQLite 使用独立目录，无共享服务资源。依赖归属覆盖 runtime、automation-scheduler、wake-runtime、wake-evaluation、wake-providers、chat-schedule、continuation-delivery、chat-automation 及相关契约/迁移。实测单次 runner 约 1.0 秒；此数仅用于协调者安排门禁成本，不代表生产判定延迟。三处 suite registry 均未修改。

执行采用已读取的 Model the Domain 原则，将 provider 选择保持为既有 judges 映射；Boundary Discipline 原则使 receipt 验证和 result 适配留在 runtime 边界；Prove It Works 原则要求真实 runtime/SQLite/scheduler 及移除安装语句的红绿验证。未启动额外 delegate；poteto-mode 中引用的 cursor-team-kit deslop skill 在当前已定位技能目录不存在，提交前人工检查了差异与注释，没有声称执行该插件审查。
