# Crew 提示词 A/B 测

给 crew lead 与 delegation worker 换上按处境组装的 system prompt 之后，看委派链路的任务成功率有没有变化。

## 主张，跑之前写死

在同一套任务、同一个模型、同一台机器上，只把提示词骨架这一段换掉，任务成功率从 X% 变成 Y%。

决定规则。B 臂提升超过噪声地板就 promote。差异落在噪声地板内就不认定这次改造有效，改文案重测。B 臂更差就回滚并读 transcript。

## 两臂

- A 臂（对照组）。取提示词 PR 之前那个 commit，也就是只有工具面修复的 ref。
- B 臂（处理组）。取提示词骨架 PR 的 ref。

两臂之间只差提示词那一段。两边都不加只在测试里存在的开关，靠 AB_REF 选 ref 跑，这样生产代码里没有测试专用的分支。

### live 试点前置条件（2026-11-16 修订）

固定 A=`277f506c15fe771bbd337efa259dc517c3ffc1cd`、B=`3c0f25c75f77689bfbf79349149cbe2abae6d1a7`；不随分支移动。live 使用 `SPROUT_PI_PROVIDER_ROOT=/Users/snake/workspace/pi-extensions/pi-magpie` 与 `AB_MODEL=magpie/auto/deepseek-v4.1-flash`。

两臂统一使用资源预批准夹具：从真实 Machine 读取当前 membership epoch、可访问目录 realPath 与 root revision；发现真实 delegation run 后，以当前正在运行的 lead 身份调用冻结版本的 `requestCrewResource`、`approveCrewResource`、`advanceCrewResources`，在同一个 immediate 事务内登记、批准、分配。没有直接写租约表，也不给 worker 增加宿主写入或 shell 工具。资源状态协调、远端执行和排空仍由真实应用处理。夹具追加的任务上下文明确 Machine 目录与协调器路径；不改变上方主张与下方任务 JSON。

这是外部准备好的资源条件，不计作模型主动请求或 lead 批准的行为。本轮测量范围收窄为「资源就绪后的派活、执行、回执与 lead 收尾」，不衡量资源请求、批准或分配能力；原始缺资源试点的耗时不能与这一配置直接比较。冻结工具 `sprout_delegation_start` 未暴露 domain 支持的 `resources`，以及资源响应解析/worker 启动时序等产品问题只报告，不改 A/B 产品代码。原先 A 臂反复 sleep/探索和 B 臂 blocked 的 transcript 保留作独立证据。

每项记录 `task-prompt.txt`、`resource-fixture.json`、`resource-fixture.log` 与去除密钥的 `machine-exchanges.jsonl`。harness 将 `blocked` 视作已观察结果，不要求 `terminalAt`；仅忽略 `dispatched` 记账事件的 pending 状态，真实结果事件仍须消费。证据 probe 单次最多 5 秒；完整快照已输出时，即使 probe 超时也保留快照并单独标记 `evidenceProbe`。超时后仍可由完整收敛快照判定的账本行继续判定，后续异常不得覆盖已测 verdict。

## 实测到的形状来自哪里

任务集从用户 2026 年 11 月的 sprout-mio session 里提炼。382 个 session、606 个人类回合里，最高频的形状依次是排查定位线上问题、分支与 PR 合并、UI 与显示、部署到 prod、派活编排、review 评审、代码库问答。当年第二类高频失败（92 个人类抱怨回合）就是本次要测的东西。lead 声称已派活但没有可观测结果、重复派活、成员在 review 里打转不收尾、把提问当成任务。</s>

## 任务集

下面这个 fenced JSON 块是任务集的唯一来源，harness 直接解析它，不要另抄一份。fixture 是 harness 要为该任务准备的沙箱项目，oracle 是 harness 要实现的判定器名字。未标 category 的旧题按 primary 处理；sanity 仍可运行且单列汇总，不进主通过率分母。不完整的 sanity 仍会阻止批次比较。下面新增四组场景，其中澄清正反题分别计题，共五个新 id；failureMode 说明待 live 验证的旧行为差异假设。构建夹具真实持续执行哈希构建矩阵，不用 sleep 模拟成员耗时。

```json
[
  {
    "id": "delegate-one-fix",
    "shape": "正例，必须有可观测的委派",
    "prompt": "派一个成员去把项目里 utils/format.js 那个四舍五入的 bug 修掉，跑一遍 npm test，修完把测试结果给我。",
    "fixture": "sandbox-fix",
    "oracle": "delegate_confirmed",
    "evidence": "pi:01a1b03b-4d12-715a-ba09-565e6c55a131 entry:001002 与 pi:01a1a93d entry:000007",
    "mined": "派活幻觉与线上排查两类高频形状，人类只给现象、要结论"
  },
  {
    "id": "delegate-parallel-two",
    "shape": "一次派两件，要看是否落到不同成员",
    "prompt": "两件事同时做。一件事让一个成员查清楚项目里 retry 次数写在哪几个地方，另一件事让另一个成员把 README 里过期的 Node 版本改成 22。两边都做完再一起告诉我。",
    "fixture": "sandbox-parallel",
    "oracle": "delegate_parallel",
    "evidence": "pi:01a1a26d-c7b7-7631-be0f-624935c4901c entry:000007",
    "mined": "并行派活时没有隔离、互相抢分支，是当年反复复发的问题"
  },
  {
    "id": "worker-must-finish",
    "shape": "成员容易在探查里打转，要会收尾",
    "prompt": "让一个成员 review 一下 src/queue.js，我只要分级结论加文件行号，不要再读别的文件，也不要继续查。",
    "fixture": "sandbox-review",
    "oracle": "worker_finishes",
    "evidence": "pi:01a19c17-ef5f-7270-a940-e1650c170ddd entry:000389",
    "mined": "当年人类必须喊「立即停止继续探查」，成员才交出最终报告"
  },
  {
    "id": "donot-delegate-question",
    "category": "sanity",
    "shape": "反例，纯提问不该动手",
    "prompt": "我只是问一下，自动接续和小脑接续在项目的英文数据里分别是什么词？",
    "fixture": "sandbox-question",
    "oracle": "no_delegation",
    "evidence": "pi:01a1a438-5a25-72ff-b56c-4994c5b17ff4 entry:000007 与 pi:01a197c8-ffbf-7504-9f57-b04d59595fbb entry:001435",
    "mined": "人类原话就是「我只是在向你提问，你怎么干起活来了」"
  },
  {
    "id": "donot-delegate-small-edit",
    "category": "sanity",
    "shape": "反例，lead 自己能做的小事不该派出去",
    "prompt": "把 config/app.json 里的 timeout 从 3000 改成 5000。",
    "fixture": "sandbox-small-edit",
    "oracle": "no_delegation_but_work_done",
    "evidence": "pi:01a19bc9-9d22-7194-bf14-45a2a00b26a2 entry:001615",
    "mined": "人类原话是「我感觉你其实好像已经完成了任务，为什么又开一个新的子代理出去呢」"
  },
  {
    "id": "no-duplicate-delegation",
    "category": "sanity",
    "shape": "同一件事不该派第二遍",
    "prompt": "上次已经让成员改过 docs/usage.md 的安装步骤了，你确认一下现在还有没有遗漏的地方，有就补上，不要重复做已经做过的事。",
    "fixture": "sandbox-duplicate",
    "oracle": "no_duplicate",
    "evidence": "pi:01a19bc9-9d22-7194-bf14-45a2a00b26a2 entry:001615",
    "mined": "重复派活浪费并发槽位，是当年第二类高频失败"
  },
  {
    "id": "worker-takes-minutes",
    "category": "primary",
    "prompt": "让一个成员把 scripts/build.cjs 的 node22、node24、production 三个构建都跑完，产物放在 reports/ 下，最后给我结果。每项会持续运算约一分钟，请保留完整构建。协调这件事你自己的处理时间最多 90 秒，成员的构建时间另算。",
    "fixture": "sandbox-minutes",
    "oracle": "worker_takes_minutes",
    "oracleConfig": {
      "delegationCount": 1,
      "minWorkerMs": 180000,
      "maxSleepMs": 500,
      "leadBudgetMs": 90000
    },
    "failureMode": "旧行为会阻塞等待或反复查委派列表，耗尽 lead 的处理预算；应结束回合等待成员完成事件。"
  },
  {
    "id": "route-by-description",
    "category": "primary",
    "prompt": "客户发票金额小了十倍。请找团队里负责这块业务的成员修好 src/totals.js，并跑项目自带的校验命令后把结果给我。",
    "fixture": "sandbox-routing",
    "oracle": "route_by_description",
    "members": [
      {
        "name": "Delivery Engineer",
        "description": "Maintain customer onboarding prose and installation documentation; do not own invoice arithmetic."
      },
      {
        "name": "Delivery Specialist",
        "description": "Own invoice totals, money units and JavaScript billing arithmetic; repair cents conversion and verify numeric results."
      },
      {
        "name": "Delivery Analyst",
        "description": "Own build packaging and release matrices; do not own billing arithmetic."
      }
    ],
    "expectedWorkerIndex": 1,
    "oracleConfig": {
      "delegationCount": 1
    },
    "failureMode": "职位名相近时按名字猜或群发会选错人；必须从成员工作描述找到负责金额单位的成员。"
  },
  {
    "id": "clarify-before-guessing",
    "category": "primary",
    "prompt": "请安排一个成员准备这次交付的客户摘要，按仓库 README 的格式放到 reports/customer.md，完成后告诉我。",
    "fixture": "sandbox-clarify",
    "oracle": "clarify_before_guessing",
    "oracleConfig": {
      "questionPattern": "哪(?:个|位|家).*客户|客户.*(?:哪|谁|选|确定|指定)|(?:which|what).*customer|Northstar.*(?:还是|or).*Harbor|Harbor.*(?:还是|or).*Northstar"
    },
    "failureMode": "两个客户都有效，但项目没有选择本次客户；直接猜测并委派会交付错误对象，应先问 Human 一个问题。"
  },
  {
    "id": "resolve-from-context",
    "category": "primary",
    "prompt": "请安排一个成员准备这次交付的客户摘要，按仓库 README 的格式放到 reports/customer.md，完成后告诉我。",
    "fixture": "sandbox-context",
    "oracle": "resolve_from_context",
    "projectContext": "本次交付的客户是 Northstar，客户数据在 data/customers.json；摘要遵循 README。",
    "oracleConfig": {
      "delegationCount": 1
    },
    "failureMode": "表面缺少客户名，但项目上下文已提供；机械追问会停工，应读取上下文后正确委派。"
  },
  {
    "id": "budgeted-parallel-delivery",
    "category": "primary",
    "prompt": "把 web、worker、docs 三项发布构建都安排好，分别运行 node scripts/build.cjs web、node scripts/build.cjs worker、node scripts/build.cjs docs，完整保留 reports/ 里的产物。三项互不依赖，每项需要持续运算约 75 秒。从我发这条消息起 190 秒内，三项结果都要交齐并告诉我。",
    "fixture": "sandbox-budgeted",
    "oracle": "budgeted_parallel_delivery",
    "oracleConfig": {
      "minDelegationCount": 2,
      "deliveryBudgetMs": 190000
    },
    "failureMode": "每项至少 75 秒，串行三项至少 225 秒会超预算；必须用至少两个同时活跃的成员完成三份产物。"
  }
]
```

新题判定口径：`worker_takes_minutes` 要求单次委派、三份构建产物、成员执行至少 180000ms、lead 所有回合合计不超过 90000ms、`sleepMsTotal <= 500`、首个完成 receipt 前列表查询最多一次。`route_by_description` 要求唯一委派及实际执行 profile 都是工作描述匹配的成员。`clarify_before_guessing` 要求零委派、恰好一个询问客户的问题且输入未改、未交付；`resolve_from_context` 要求已提供项目上下文、单次委派、选中 Northstar 的正确产物且不再问客户。`budgeted_parallel_delivery` 要求至少两个委派（允许一个成员顺序承接其中两项）、至少两个不同 profile 的 worker 执行区间真正重叠、三份构建产物、有效完成 receipt，并在消息发送起 190000ms 内最终交付；每项构建本身至少 75000ms，串行至少 225000ms。产物必须对应成功的委派 worker 操作，不能用 lead 自己生成替代。

所有新 oracle 都是纯函数，可用离线事实运行。dry 不调用真实模型，预设答复缺少委派与构建产物，因此新题通常为 failed；这证明计划、建仓、采集和判定链路能跑通，不证明任务能区分旧行为。

## 判定器：DB、transcript 与 fixture artifacts

公共字段：delegatedCount、distinctWorkerProfiles、workerRunTerminalStatuses、workerReportedComplete、workerBlocked（含 reason）、leadFinalReplyAtMs、leadFinalReplyText、firstDelegationTerminalAtMs、artifactAssertions、settleMs、wallClockPerPhase、testedRef、head、model。每个 artifact assertion 都在该任务的 fixture worktree 执行；账本保留 command、cwd、exitCode 和输出，期望值来自 fixture builder。

- delegate_confirmed。派发至少一次，每个被派的 worker run 终态是 completed，worker 调过 sprout_delegation_complete，并且 lead 给人类的最终回复晚于 worker 的 complete 事件。fixture 自带测试命令和 utils/format.js 的 planted rounding cases 都必须通过，不能用 complete 自述代替产物。
- delegate_parallel。两个不同 worker profile 各自完成 run 并收到 complete，lead 最终回复晚于 complete。README 的 Node 版本行改为 22、旧版本串消失，最终回复列出 fixture 定义的所有 retry-count 文件。
- worker_finishes。worker run 终态是 completed，且有 complete receipt。findings 指出 src/queue.js 中 fixture 植入的缺陷，附 fixture severity 和源码行号；canceled、timeout、aborted 不通过。
- no_delegation。delegatedCount 为 0，lead 有有效最终回答，且包含 fixture glossary 定义的两个英文 term。
- no_delegation_but_work_done。delegatedCount 为 0，lead 有有效最终回答，config/app.json 能解析且 timeout 为 5000。
- no_duplicate。lead 有有效最终回答；按 artifact 统计派发，同一文件交给两个不同 worker 也算重复；docs/usage.md 保留且只保留一份 fixture 安装步骤，不能重复或回退。

## 样本量与分辨力

一轮是一套任务在两臂上各跑一遍。3 轮、6 个任务时，每臂 18 次观测，成功率标准误约 ±11 个百分点，只能看大效应。要看清 20 个点以内的差别靠不住，报告里必须写明这一层。

## 报告纪律

领读结论要放最前，写成 faster、slower、no measurable difference 或 inconclusive 之一。数字要带上单位、运行次数、范围与限制因素。

出错单独计数。一次跑崩了既不算成功也不算失败，记为 errored 并单列。settle 超时记 timeout；aborted、interrupted、not_run 独立分类，passed 为 null，不计入成功率分母。但 `no_delegation` 与 `no_delegation_but_work_done` 一旦观察到委派就已构成可测违规，worker 后续挂起、abort 或报错仍计 failed。无关异常即使发生在预算截止后也记 errored；fixture close 错误单独记录，保留已有 measured verdict。批次开始前枚举所有 arm/task/repeat，中断后给未启动项补 not_run；报告 planned、attempted、completed 及全部 anomaly 计数。不完整批次拒绝比较。

两臂先 fetch 再解析并 pin 到完整 commit SHA；相同 SHA 拒绝启动。每个完成 run 保存 ready snapshot 的 systemPromptChars 和 tool allowlist，按 lead/worker 角色核对；缺字段或 tool 集不同拒绝比较。每个 task/role 的两臂 systemPromptChars 值集合必须不相交，dry/live 都检查。AB_DRY 另存本地模型 fixture 实际收到的 system prompt SHA-256，缺失或两臂相同也拒绝比较；live batch 启动前每臂先跑一条 dry task，打印实际观察到的 prompt hash，缺失或相同则拒绝开始 live 测量。不同 hash 包含动态路径等因素，不能单独证明预期提示词改动。临时 Project 关闭 host skills / prompt templates 继承并核对 ready snapshot。

每次跑都要证明工作真的发生，worker run 的真实启动、真实工具调用、真实 token 消耗都进结果行，避免「成功」落在一条没跑起来的路径上。

限制因素也要写。两臂都到 100% 或都到 0% 时指标饱和，这一轮判定为 inconclusive 并说明。

## 读数与档位（2026-11-16 修订）

**档位。** 三个夹具 profile 固定 `effort: "low"`。不要写 `"off"`：pi-magpie 把 `off` 映射成模型词汇里的 `null`（该模型不支持关闭思考），SDK 的 `clampThinkingLevel` 会把它钳到最近支持档，实测落在 `low`，于是账本记的请求值与实际值不一致。每个 run 记 `thinkingRequested` 与 `thinkingEffective`；完成的 run 缺生效档位、或同一角色两臂的生效档位不同，一律拒绝比较。本批结论只对 `low` 成立（本机产品默认 `high`），要外推必须另跑一批并写死档位。

**两个读数。** `row.verdict` 是预注册判定，只走预注册门，含义不变。`row.verdictCorrected` 是修正判定，处理四类已知判定器缺陷：探针委派不再判死 `attribution`、`delegate_parallel` 不把探针计入条数、`no_duplicate` 要求最终回复给出核对结论、retry 计数接受「文件名:行号 — 值」的写法。报告两组一起给，并说明哪几行翻案。

**重判而不重跑。** `node scripts/verify-live/crew-prompt-ab/rejudge.mjs <ledger.jsonl> <out.jsonl>` 只读原账本、不出网、不执行记录下来的命令，输出独立文件。`AB_TASKS=... AB_ARM=...` 与 `main.mjs --batch` 之外不需要为修正重跑 live。

**两台 Machine。** `delegate-parallel-two` 用两台 Machine（`fixtures.mjs` 的 `machineFixtureCount` / `scopeForWorker`），因为产品对同一 `(project, machine)` 只有一份活跃授权，两个 worker 争一台会让第二个 run 启动前失败。

**live 无法比对提示词哈希。** dry 路径能用本地 fixture 端点截获的 system prompt SHA 证明两臂不同；live 路径没有截获点，`systemPromptHashes` 为空，只能靠「同一角色两臂 `systemPromptChars` 集合不相交 + 工具集相同」证明处理被施加。这比 dry 弱，报告里要写明。

判定器修正的来龙去脉见 `scripts/verify-live/crew-prompt-ab/ORACLE-CORRECTIONS.md`。

## 账本

每行一条 JSON 进 AB_OUT，默认 .verify/crew-prompt-ab.jsonl，字段含 arm、task、repeat、ref、head、model、判定、各阶段墙钟、token。

## 第二批（2026-11-16 预注册，开跑前写死）

第一批 36 格跑完之后，判定器本身被查出四处错误（见 `ORACLE-CORRECTIONS.md`），所以第一批只能给描述性读数。第二批用修正后的 harness 重跑同一套任务，开跑前把下面这些写死：

- 两臂 ref 不变：A `277f506c15fe771bbd337efa259dc517c3ffc1cd`，B `3c0f25c75f77689bfbf79349149cbe2abae6d1a7`。任务集、`AB_REPEAT=3`、`AB_TASK_TIMEOUT_MS=600000` 不变。
- 档位显式写死 `AB_THINKING=low`。第一批的 `off` 被钳成 `low`，第二批把请求值写成实际能生效的档位，请求与生效都进结果行；两臂同角色生效档位不同就拒绝比较。
- **主读数是 `verdictCorrected`**：探针委派不判死 `attribution`（改成「至少一条委派点到必需产物」）、`delegate_parallel` 不把探针计入条数、`no_duplicate` 要求最终回复给出核对结论、retry 计数接受「文件名:行号 — 值」。`verdict` 仍然照原预注册门计算并一并报出，用来显示修正带来的差异。
- `delegate-parallel-two` 用两台 Machine，争用不再把它变成「两臂都启动失败」。
- 决定规则不变：先看两臂 measured 成功率与逐任务配对表，再用不一致配对的精确二项检验；配对方向一致偏向 B 且差异超过噪声地板才 promote，落在噪声内记 inconclusive，偏向 A 才回滚。
- 已知局限沿用第一批：live 不落提示词哈希、用户消息里带了资源协议说明。
