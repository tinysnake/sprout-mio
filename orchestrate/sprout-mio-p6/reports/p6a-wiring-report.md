# P6a 默认判定策略补充报告

分支：`p6a/policy-default`；基线：`p6a/wiring`（`65d9e4e`）。新建 Project 的 `wake_policy=NULL` 现在可经真实 runtime 与 scheduler 完成默认小脑判定并创建接续 delivery。Project 配置保持 NULL；第一次人类显式配置仍从设计默认版本 1 递增到 2。指定七个门禁、typecheck、改动文件的 lint 与格式检查均实际执行通过。

本文下半部保留原 wiring 单元报告作为历史记录；其中“NULL policy 阻断默认接续”的遗留问题由本次变更解决，不再是当前遗留问题。

## 改动与默认语义

`src/contracts/project-wake-policy.ts` 将 `model` 改为 `z.string().trim().min(1).max(200).optional()`，注释明确省略表示宿主默认模型。`provider`、`configRevision`、`thresholdVersion` 仍必填。这里导出冻结的 `DEFAULT_PROJECT_WAKE_POLICY`，内容恰为 `{ provider: "small_brain", configRevision: 1, thresholdVersion: "p6a-design-default-v1" }`，没有 model。

`src/domain/continuation-delivery.ts` 的 `buildPeriodicInput()` 仅在数据库值为 NULL 时使用上述默认策略；显式配置仍走原 schema 校验。合成策略进入 `WakeEvaluationInput.policy` 并参与原快照哈希，持久化 input 中不提前补入宿主模型。门禁重新计算整个快照哈希并验证相等。读取路径没有数据库写入；临时 `AFTER UPDATE ON main.project` trigger 观察完整默认检查与调度推进，记录的更新次数为 0，数据库 wake_policy 前后均为 NULL。

宿主模型仍由未修改的 `src/server/wake-runtime.ts` 解析。小脑 completion 请求及最终回执包含解析后的具体模型，而原判定 input 保持省略模型的配置语义。显式模型始终优先，JEV 只调用 JEV，没有 provider 级联。

## 连带类型与校验位置清单

除 brief 指定的 policy 契约、输入构建和原 fixture 外，仅调整三个文件中的以下四处必要类型或校验位置：

1. `src/contracts/wake-evaluation.ts` 的 `wakeEvaluationResultSchema.model` 随 policy 变为可选。既有 `failedWakeResult()` 与 `decidedWakeResult()` 都从 policy 取得 model；尚未解析宿主模型的失败/规则判定不能伪造具体模型标识。字段一旦存在仍须通过原 identifier 校验，真实完成判定的回执保留已解析模型。
2. 同文件的 `wakeEvaluationResultForInputSchema()` 在 input 明确指定 model 时继续严格比较；省略 model 时允许宿主解析出的具体模型通过。snapshotHash、provider、候选覆盖以及其余回执校验保持原样。这是省略模型的输入与已解析模型回执之间所需的边界校验调整。
3. `src/domain/wake-providers/small-brain.ts` 在 completion 边界明确拒绝尚未解析的 model，返回原 `provider_unavailable` 错误；因此传入 `SmallBrainRequest.model` 的类型仍为 string。
4. `src/domain/chat-schedule.ts` 的 `deliveryContextMatches()` 对持久化 NULL policy 使用同一设计默认进行比较，否则默认判定虽能生成 delivery，却会在投递校验时被认作过期。不存在 Project 的 undefined 仍拒绝，非 NULL policy 的哈希比较完全保持原样。

后两项分别是一个类型收窄位置和一个投递上下文校验位置；它们都直接服务于省略模型/默认 policy 的真实接续路径。`currentFingerprint()`、配置版本比较、显式配置的 staleness 判定均未改动。没有修改 `src/domain/wake-evaluation.ts` 的快照限额或判据、runtime provider 选择、数据库迁移，或 `scripts/verify/lib/*.mjs`。

## 原门禁新增的四组回归场景

在 `tests/fixtures/p6a-wiring.ts` 内增加 24 条断言，保留原 71 条断言及原先的所有计数预期，最终为 95 条。新场景在原业务场景之后、既有副作用汇总断言之前运行，复用既有 `complete`/`fetch` 替身、真实 runtime、真实 scheduler 与真实 SQLite。宿主设置来自独立验收目录，退出时恢复原 `PI_CODING_AGENT_DIR`；没有读取个人模型配置或调用付费模型。

1. **新 Project 没有 policy。** 创建新 Project、Agent 成员、一个 assigned Task 和到期 schedule。断言一条 `wake_evaluation` 的回执 provider 为 small_brain、continuation_delivery 恰增加一条、小脑 transport 恰调用一次而 JEV 不增加。TEMP trigger 证明没有任何 UPDATE project，数据库 policy 仍为 NULL。另验证默认策略完整内容、可复现快照哈希、实际宿主模型及 receipt 模型，以及 `deliveryContextMatches()` 不把默认 delivery 判为过期。
2. **同一 Project 显式配置 JEV。** 首次人类配置得到 configRevision=2；该 Project 下一个到期 Chat 的 input/provider/revision 与配置一致，实际仅增加一次 JEV transport。保持原 JEV 概率阈值行为，不回退到小脑。
3. **显式小脑模型。** 配置与宿主默认不同的 `fixture/explicit-model`，逐项确认 input、completion request、receipt 都保留它。
4. **显式小脑省略模型。** 配置入口接受省略 model；持久化 input.policy.model 为 undefined，configRevision 正常递增到 4；小脑被调用，request 和 receipt 使用宿主设置的 `fixture/runtime-default-model`。

## 红绿证据与实际验证

红：临时把 `buildPeriodicInput()` 中的默认分支还原为 `if (!rawPolicy) throw new Error("provider_unavailable")`，运行 `bash scripts/verify/p6a-wiring.sh`，实际 exit 1。失败准确发生在新增第一个断言 `NULL policy reaches the real small-brain runtime and persists its receipt`，actual=null、expected=small_brain，未走到新增场景的后续断言。原始日志 `/tmp/p6a-policy-default-red.log`，退出码 `/tmp/p6a-policy-default-red.exit`。

绿：恢复合成默认并格式化后，同一门禁实际 exit 0 / 95 assertions；日志 `/tmp/p6a-policy-default-green.log`，runner 记录 `/tmp/p6a-policy-default-green.json`。没有删减、放宽或跳过任何既有断言，红色变异没有进入最终代码。

| 实际命令                                  | exit code | 实际断言/检查                              |  runner 秒 |
| ----------------------------------------- | --------: | ------------------------------------------ | ---------: |
| `pnpm typecheck`                          |         0 | 三个 TypeScript 配置均 0 错误              |      7.830 |
| `bash scripts/verify/p6a-wiring.sh`       |         0 | 95 assertions                              |      1.076 |
| `bash scripts/verify/p6a-scheduler.sh`    |         0 | 20 assertions                              |      1.456 |
| `bash scripts/verify/p6a-delivery.sh`     |         0 | 41 assertions                              |      1.477 |
| `bash scripts/verify/p6a-control.sh`      |         0 | 23 assertions                              |      1.363 |
| `bash scripts/verify/p6a-integration.sh`  |         0 | 13 assertions                              |      1.756 |
| `bash scripts/verify/p6a-routing.sh`      |         0 | 305 assertions + 1 次独立 import assertion |      1.634 |
| `bash scripts/verify/i2-group-chat.sh`    |         0 | 13 checks（脚本未汇总 assert 调用数）      |      0.820 |
| `pnpm exec vp lint <六个改动的 TS 文件>`  |         0 | 无 lint 报错                               | 未单独计时 |
| `pnpm exec vp fmt --check <七个改动文件>` |         0 | 六个 TS 文件及本报告格式通过               | 未单独计时 |

六个 TS 文件为 `src/contracts/project-wake-policy.ts`、`src/contracts/wake-evaluation.ts`、`src/domain/chat-schedule.ts`、`src/domain/continuation-delivery.ts`、`src/domain/wake-providers/small-brain.ts`、`tests/fixtures/p6a-wiring.ts`。每个 gate 的实际 stdout/stderr、exit code 与耗时保存在 `/tmp/p6a-policy-default-<gate>.log` / `.json`，最终 wiring 断言产物为 `.verify/p6a-wiring/wiring-result.json`。

表中 runner 秒为实际进程从启动到退出的墙钟时间，包含启动开销。typecheck 的后台启动返回时间不计为执行时间；六个回归 gate 并行运行，不能把各行时长之和称为工作流总耗时。类型检查和绿色门禁的 Python runner 对每条命令设置 300 秒总超时，lint/格式检查的 bash 工具调用设置 60 秒总超时，全部正常退出，没有超时或跳过。新 worktree 首次试跑因未安装 tsx 在 fixture 加载前 exit 1；随后 `pnpm install --offline --frozen-lockfile` 实际 exit 0、2.437 秒，才取得上述业务红绿证据。首次模块加载失败不计为业务回归红证据。

## 遗留问题与范围

本 brief 的默认 policy 问题已修复，无阻塞遗留。验收替身只替换小脑 completion 与 JEV HTTP；不宣称真实 provider 认证、网络可用性、中文判定质量或 Agent 真实执行完成已经得到证明。执行宿主仍按原门禁关闭，证据覆盖到 durable evaluation / continuation delivery 与上下文有效性。全量验证、独立技术验收、真实页面/模型体验及门禁 registry 登记仍由协调者按章节安排，本单元没有登记或新建门禁。

---

# P6a 判定器接线报告（wiring 单元历史记录）

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
