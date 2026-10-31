# P6a judge 单元交付报告

状态：实现与 fixture 门禁完成；真实模型门禁按实际结果失败。分支 `p6a/judge`。未修改数据库 schema、页面、Task mutation 或周期调度，也未创建 Sprout run、投递消息或构造 `ProjectContext.human`。

## 实现与集成入口

- `src/domain/wake-evaluation.ts` 提供 `prepareWakeEvaluation(facts, now)`，返回 `model`、`rule`、`skipped` 或 `failed`。调用方按当前数据库事实提供可读消息、当前成员资格、已有 instance/run/外部工作摘要和全部关联 Task；装配器和 provider 不补读数据库、Machine 或任何远端工具。
- Group 由当前有效成员、Public Channel 由项目当前 Agents 的有效成员事实装配候选，排除发言 Agent。沿用 `routeWakeCandidates` 的裸名字点名及点名优先于 owner 规则。无点名的 contextual 不再退化为 owner-led；普通非 owner Agent 回复也可进入判定。DM 保留唯一 Agent 的规则路径。周期检查仅含当前 Chat 的 assigned Tasks，Group/Channel 仅当前 owner（允许 Human），DM 仅唯一 Agent。零 assigned 提前 skipped，无模型调用。
- 最近消息按时间升序，最多 20 条，单条 2000 Unicode 字符，正文合计 12000。触发消息独立保留并标记截断。人设最多 600、Task 标题与末条记录合计最多 1000。总快照超过 24000 字符时先删较早消息，再缩短人设及末条记录正文，保留完整候选和 Task 身份；仍超限返回 `context_budget_exceeded`。截断计数、丢弃范围、完整性标记和 SHA-256 一并保存。`now: Date` 由调用者注入，领域代码没有 `Date.now()`。
- `evaluateWake(input, judges)` 仅调用 `input.policy.provider` 指定的适配器一次，验证结果仍绑定该 input 的候选、model 和 hash，不自动切换 provider。返回 `{result, usage}`；冻结的 `WakeEvaluationResult` 没有新增字段。usage 单独记录 provider 的输入/输出 token、state 字符数和通过注入 monotonic clock 计算的适配器耗时。
- `createSmallBrainJudge({agentDir, clock, ...})` 通过 `scripts/pi-wake-runner.mjs` 使用宿主安装的 Pi `ModelRuntime.complete` 和 `ReadOnlyAuthStorage`，显式 `tools:[]`，不创建 Agent session。只读取宿主模型配置和认证，不载入项目扩展、技能、上下文或 Machine 配置。runner 支持既有宿主 magpie provider 注册。
- `createJevJudge({apiKey, threshold, clock, ...})` 直连 `POST https://api.typesafe.ai/v1/systemone`，固定 `jev-1.14.0`，每候选一个独立 Noul 问题，在 instructions 中明确写入该候选身份与职责，不使用 Choice。拒绝缺项、额外项、非数值、越界概率和错误模型版本。401/403、超时及不可用均转为闭合失败码。

小脑要求每名候选返回 `yes/no/unknown + high/low certainty + 中文 reason`。`low` 强制转为 unknown，`probability:null`，没有把自报确定性包装为校准概率。JEV 使用真实 Noul yes 概率；阈值及版本显式注入，live 采用设计 §1.2 的协调者默认 `p>=0.8 → yes`、`p<=0.2 → no`、中间 unknown，版本 `p6a-design-default-v1`，尚未校准。unknown 从不进入 selected，同批其他明确 yes 可保留，并记录 `provider_low_certainty`。请求失败时 selected 为空。

契约的 `errorCode` 枚举使用 `provider_unavailable`；brief 所要求的 `wake_provider_unavailable` 放在 `reasonCode`，缺凭据的 reason 明确列出 `TYPESAFE_API_KEY`。没有修改冻结契约的枚举来绕过验证。

## 必要的相邻修复

首次从独立进程直接 import 新 evaluator，复现了基线契约循环：`wake-evaluation → chat → agent → project → wake-evaluation`，在 `wakeProviderSchema` 初始化前读取它而抛 ReferenceError。将 `fieldErrorsFrom` 移至 `src/contracts/field-errors.ts`，`agent.ts` 和 `project.ts` 保留原公开重导出，函数行为及契约形状不变。门禁增加独立进程直接 import 的回归断言；原始失败和修复后的成功均已实际观察。

新增 shell 门禁需要登记到现有验证清单。已在 suite plan 注册两条门禁资源，在 CI tasks 组登记 fixture 门禁，并补登记基线已有的 `tests/p6a-contracts.test.ts`。真实模型门禁加入 `MANUAL_GATES`：普通全量验证和 CI/local 目标不自动运行；显式 `--only p6a-live-routing` 或直接 bash 才可运行，不降级成 fixture。现有 runner 测试增加“默认不执行、显式选择才执行”的回归保护，目标清单 fixture 同步覆盖手动门禁。

## fixture 来源与验证风险

`tests/fixtures/p6a/zh-wake.json` 从原 30 条中文合成协作样本中选取 10 条：w01、w06、w12、w13、w17、w20、w22、w23、w24、w25。源文件 SHA-256 为 `5adb5fe30f5d2b31e04bf17633d21a4a10ac56637c708177d7b811a33734c27d`。每例包含完整 facts、合法判定 input（禁止判定的周期例为 null）、预期候选及 selected、调用次数和零 run/message/input 断言。生成器、来源说明与重建命令在同目录提交。

五类中文场景分别由 w01 无需回复、w06 多 Agent、w12 交接、w13 补充要求、w17 收尾覆盖；w20 由源消息提醒改成周期 owner 提醒，原文仍保留在最近消息；w22/w23 覆盖 finished Task 的新要求与确认；w24/w25 守住无 assigned 时零判定。w22 生产装配走规则，fixture 门禁断言零 provider 调用。未采用 w04/w18/w30 的旧 d5 接续深度预期。

Risk → Test 映射：

| 风险                                                      | 可重跑保护                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 成员已退出、发言者被唤醒、点名被 owner 覆盖、运行中被跳过 | 候选资格、非 owner Agent、裸名字和 activeRun fixture                            |
| 中文/emoji 截断损坏、触发消息丢失、候选/任务被裁掉        | 单条/合计/总预算、20 条上限、完整多 Task 和独立触发消息断言                     |
| 单赢家误用或低确定性误唤醒                                | 多选、全 unknown、部分 yes/unknown，两条适配器分别验证                          |
| 坏 JSON、缺项、重复候选、坏概率、错误模型、认证/网络失败  | 两条 provider 的失败矩阵与准确失败码，所选 provider 外调用为零                  |
| 判定写入 run/message/input 或获得远端工具                 | 迁移的独立真实 SQLite 三表零行，判定模块能力边界静态断言，无工具真实 completion |
| routine 验证意外付费、门禁漏登记                          | suite/target 清单和手动门禁显式选择回归测试                                     |

fixture transport 预设模型输出，证明适配器协议和路由行为，不证明中文模型效果。小脑 fixture 输入概率为空；JEV fixture 中的 0.95/0.05/0.5 是测试数据，不是实际模型收据或阈值校准。

## 实际执行结果

| 调用                                                                                             | 实际结果                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash scripts/verify/p6a-routing.sh`                                                             | 退出 0；runner 305 条断言全部通过，另有独立进程 import 1 条；逐样本与失败变体打印断言数；run/message/input 均零                                                                         |
| `SPROUT_VERIFY_PI_MODEL=magpie/auto/deepseek-v4.1-flash bash scripts/verify/p6a-live-routing.sh` | 退出 1；小脑 8 次真实请求，7 例匹配、1 例多唤醒；JEV 缺凭据，8 例均显式失败，实际 HTTP 请求数 0                                                                                         |
| `pnpm exec vp test run tests/p6a-contracts.test.ts tests/chat-wake.test.ts`                      | 退出 0；2 文件、32 测试通过                                                                                                                                                             |
| 覆盖上述文件及 verify-runner/targets/ah-groups/sandbox 的 6 文件定向运行                         | 初次为 62 通过、1 个目标清单失败；补登记基线 p6a-contracts 后，仅重跑失败的 verify-targets，退出 0、1 测试通过。最终这些文件各自最新结果均通过，未声称重新跑过全部 6 文件               |
| `pnpm exec vp test run tests/remote-tools.test.ts tests/lease-contracts.test.ts`                 | 16 通过、1 失败；remote-tools 已通过。lease-contracts 仍在第 98 行要求每个 remote schema 都拒绝 `{}`，与基线新增 `sprout_chat_automation_get` 无参 schema 不一致；本单元未修改该 schema |
| `pnpm typecheck`                                                                                 | 退出 2，仅报告基线 extension 两处错误，新增/改动文件没有报错。首段 tsc 失败，因此串联的 worker/extension 两段没有执行                                                                   |
| 改动文件 `pnpm exec eslint ... --max-warnings 0`                                                 | 退出 0。仓库未安装 eslint，使用 `/tmp/p6a-judge-tools` 的 ESLint 9.39.4 与 typescript-eslint 8.72.1，临时 recommended 配置保存在检查证据目录                                            |
| 改动文件 `pnpm exec prettier --check --print-width 100 ...`                                      | 退出 0，覆盖改动的代码、JSON、README 与本报告；Prettier 3.9.10 来自同一临时工具目录                                                                                                     |
| 改动文件仓库原生 `pnpm exec vp lint ... --deny-warnings` / `vp fmt --check ...`                  | 退出 0，包含 native 类型感知检查                                                                                                                                                        |

全仓 typecheck 的现有阻塞：

1. `src/extension/remote-client.ts:88`：新增无参 remote tool 使结果 union 不再总有 `machineId`。
2. `src/extension/remote-tools.ts:19`：工具描述映射缺少 `sprout_chat_automation_get`。

曾使用 `pnpm test -- <两个文件>`，该调用被当前 runner 解释成全量测试，实际跑了 83 文件、701 测试，695 通过、6 失败。之后改用直接 `vp test run <文件>` 定向验证。自身引入的资源/目标登记问题已经修复；remote-tools 的计时失败、AH deadline 及 sandbox 的失败在定向重跑中通过；lease-contracts 的基线冲突仍失败。该全量执行保留为失败事实，没有将局部通过改写成全仓通过。

## 真实模型收据

小脑模型选择来自主 checkout `.env` 的 `SPROUT_VERIFY_PI_MODEL`，以同值显式传入门禁，再由 `scripts/verify/lib/live-model.sh` 读取。没有猜测模型或使用 fixture 代替。JEV 固定模型为 `jev-1.14.0`，宿主没有 `TYPESAFE_API_KEY`。

| 小脑样本 | 输入 tokens | 输出 tokens | 适配器耗时 ms | 结果                              |
| -------- | ----------: | ----------: | ------------: | --------------------------------- |
| w01      |        1046 |         410 |          4117 | FAIL：应等待，实际多选 Agent      |
| w06      |        1043 |         260 |          3331 | PASS：两名 Agent                  |
| w12      |        1110 |        1662 |         11687 | PASS：当前 Agent owner            |
| w13      |        1238 |        1117 |          6975 | PASS：运行中的 owner 收到补充要求 |
| w17      |         997 |         184 |          2935 | PASS：无人接续                    |
| w20      |         928 |         517 |          5571 | PASS：仅 Human owner              |
| w22      |        1057 |         351 |          3520 | PASS：点名对象                    |
| w23      |         865 |         235 |          3619 | PASS：finished 后确认，无人接续   |

收据中的 inputTokens/outputTokens 来自宿主 SDK usage；inputCharacters 是输入 state 的 Unicode 字符数，不是 system prompt/问题合计，也不是 token 推算。durationMs 是适配器外侧注入 clock 的实际耗时，包含小脑子进程启动、SDK 准备和请求；runnerDurationMs 另记。不把工具等待、后台启动返回时间或工作流总耗时称为模型延迟。

live 门禁直接测两个适配器，包括 w22 点名输入；这不改变生产装配中的规则短路。JEV 全部收据均为 `requestAttempted:false`、token 为 null、selected 为空、`errorCode=provider_unavailable`、`reasonCode=wake_provider_unavailable`，reason 明确缺少凭据。没有真实 JEV 中文效果结论，没有 30 条样本的校准/留出集成绩，也没有可据此宣布模型可用的结论。小脑 w01 的多唤醒保留原始失败结果，不修改样本预期迎合模型。

证据目录（位于本 worktree，交付后需由协调者保留）：

- `.verify/p6a-live-routing/20261031T024030Z/`：16 条逐样本收据和 `summary.json`。
- `.verify/p6a-judge-checks/`：fixture、全量误执行、定向重跑、typecheck、eslint/prettier、原生检查日志及 eslint 配置。

## 方法与边界

应用 poteto-mode 的 Model the Domain：把准备结果表示为互斥的 model/rule/skipped/failed，Human 用 recipient 类型表达，不制造 Human 上下文。Build the Lever：提交源样本生成器及两个可重跑门禁。Prove It Works：保留 fixture 成功与真实请求失败的独立证据，不拿 fixture 成绩替代模型效果。

未新增模型效果校准、重试策略、调度 timer、投递、控制锁或持久收据表；这些由对应单元负责。代码已作本地差异检查；本 delegate 没有额外派生子 agent，独立集成 review 仍由协调者组织。poteto 包引用的 cursor-team-kit `deslop` 在当前环境未找到，未声称执行该插件。
