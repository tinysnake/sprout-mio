# P6a 章节结论：自动接续与人类控制

P6a 交付「有 assigned Task 的 Chat 会定期检查，判定该谁接话，并把接续投进对应的 run；Human 随时能关掉它、随时能叫停当前轮次」这一条链路，以及它在页面上的最小呈现。契约、迁移与边界见 [P6a 契约](contracts.md)。

技术交付基线：**`bde6383`**（`integration/p6a` 的第二轮验收受验提交是 `303fbf5`；`bde6383` 是其后唯一的文档提交）。本文随 `docs(p6a)` 提交写入。

Human 体验确认：**尚无确认版本**。

## 交付范围

| 线     | 交付内容                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| 契约   | 唤醒判定输入/结果与 11 个错误码；自动接续策略、能力表、控制命令与读视图；Project 判定器策略；取消原因枚举      |
| 数据库 | `0026` 九张表 + `project.wake_policy` + 5 个触发器；`0027` 控制表两态重建 + 取消原因改名 + 3 个触发器重建      |
| 领域   | 排期与周期检查、判定落地（两道闸：epoch 与触发器）、投递状态机与 ACK、退避与 `attention`、Human 控制、重启恢复 |
| 适配器 | 小脑（宿主 runner）与 JEV（System One Noul）两条，一次判定只走一路，不自动回退                                 |
| 页面   | Task 详情、Chat 详情与 Info Hub Chat inspector 的自动接续卡片；Project 设置里的判定器选择与不可用原因          |
| 门禁   | 9 个 P6a 门禁（8 个 CI/local + 1 个人工 live）                                                                 |

明确不在 P6a：Info Hub 全量视角（P6b）、成员治理与重新加入（P6c）、手机与 PWA（P7）。

## 功能线证据

基线 `bde6383`。本轮实际执行，全部 exit 0：

```bash
bash scripts/verify/p6a-scheduler.sh   # 23 条断言
bash scripts/verify/p6a-delivery.sh    # 45 条断言
bash scripts/verify/p6a-control.sh     # 35 条断言
bash scripts/verify/p6a-integration.sh # 13 条断言
```

| 结论                                                   | 级别 | 证据                                                                                                                                                                                                           |
| ------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 有 assigned Task 才检查，没有 assigned Task 就停止检查 | 实测 | `p6a-scheduler`（23 断言，exit 0）：`assigned Chat has one schedule`、`two assigned Tasks share Chat key`、`shutdown clears timer`；无 assigned 后触发器删除 schedule                                          |
| 周期检查真的发生，且只发生一次                         | 实测 | `p6a-scheduler`：`startup-restored timer drives real evaluation`、`a successful check re-arms exactly one policy interval from now`；两个 scheduler 并发 `advance` 只产生一份 evaluation/请求/attempt/delivery |
| 持久去重（同一事实不重复唤醒）                         | 实测 | `p6a-delivery`（45 断言，exit 0），含 `admitted input cannot send twice before ACK`                                                                                                                            |
| 运行中合并                                             | 实测 | `p6a-integration`（13 断言，exit 0）：running 时 steer 复用同一 run 并收到自己的 ACK                                                                                                                           |
| 重启恢复                                               | 实测 | `p6a-scheduler` `fresh process recovers persisted schedule` / `restart preserves due time`；`p6a-delivery` `restart preserves attempted unknown delivery`                                                      |
| 失败退避与不装成功                                     | 实测 | `p6a-delivery`：连续失败依次 `retry_wait(30s)` → `retry_wait(120s)` → `attention(provider_unavailable)`，delivery=0                                                                                            |
| Human 暂停/停止优先，且跨重启仍阻断                    | 实测 | `p6a-control`（35 断言，exit 0）+ `bf-p6a-lifecycle`（177 断言 exit 0；`P6A_SCENARIO=stale` 另 52 断言 exit 0），含「停止后新 assigned 不复活、显式恢复可再到期」                                              |
| 判定器零副作用                                         | 引用 | `bf-p6a-lifecycle` 对全部主表装审计触发器，主生命周期内判定不产生 run/input/message（本轮跑了该门禁并 exit 0，但未逐条比对审计输出的明细）                                                                     |
| 判定失败不自动切换 provider                            | 引用 | `src/domain/wake-evaluation.ts` 按 `policy.provider` 单路分发；失败只落 `error_code`，换判定器只能由 Human 改策略。见[契约的「不自动回退」](contracts.md#两条适配器与不自动回退)                               |
| 中文样本与模型采用结论                                 | 引用 | 见[判定准确率只报不判](#判定准确率只报不判)                                                                                                                                                                    |

## ui-线证据

基线 `bde6383`。复跑：

```bash
bash scripts/verify/p6a-pages.sh
```

`p6a-pages` 在真实 Chromium 上按 3 个视口 × 8 个状态渲染同一份真实契约数据，断言状态文案、控制按钮的可用性与拒绝原因、失败与退避呈现、Human owner 无 run 条、投递未知必须显式确认、以及 disable/enable/abort 的写读往返。**实测**：本轮执行 `bash scripts/verify/p6a-pages.sh` exit 0，`P6a pages: 125 assertion groups passed`，另含 `pageerror_zero` / `console_error_zero`。

| 结论                                               | 级别 | 证据                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动接续状态、Human 暂停与停止、失败反馈与恢复控制 | 实测 | `p6a-pages`（125 组断言，exit 0）的 `*_disable_contract_and_read_response`、`*_enable_contract_and_read_response`、`*_abort_can_cancel_without_write`、`*_abort_without_run_id_closes_the_chat`、`*_conflict_does_not_pretend_disabled`、`*_failure_and_backoff` |
| Task、run 与自动检查语义独立                       | 实测 | 同门禁 `*_disabled_run_stop_readable`、`*_human_without_run_bar`；`tests/task-automation-view.test.ts` 9 项（引用）                                                                                                                                              |
| 判定器选择与不可用原因                             | 引用 | `wake-provider-select.tsx` 只展示 `small_brain` / `jev`，缺模型或阈值版本时禁用并给原因；不自动 fallback                                                                                                                                                         |
| 拒绝原因与错误码可见                               | 实测 | `*_denial_reason_and_code`、`*_unknown_requires_explicit_confirmation`                                                                                                                                                                                           |
| 普通信息可见性与正文/操作权分离                    | 引用 | 第二轮验收判据 8 的 17 条 authz 探针，见 [集成线与技术验收证据](#集成线与技术验收证据)；本轮未重跑                                                                                                                                                               |

页面形状来源：Human 选定方案 A（`orchestrate/sprout-mio-p6/ui/design-a.html`，该目录只存在于主 checkout，本 worktree 未纳入 Git），三条视觉必修项来自视觉评审，落实记录见 [P6a UI 实现报告](../../orchestrate/sprout-mio-p6/reports/p6a-ui-report.md)。**引用**

## 集成线与技术验收证据

| 结论                                                 | 级别 | 证据                                                                                                                                                            |
| ---------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 集成线完成接入与自检                                 | 实测 | `bf-p6a-lifecycle` exit 0、177 条断言（生产 `startRuntime()` + 真实 SQLite + 生产 scheduler，只替换模型边界）；`P6A_SCENARIO=stale` exit 0、52 条断言           |
| 独立技术验收通过、可以合入 main                      | 引用 | 第二轮独立验收在 `303fbf5` 判定 12 条判据全部成立，结论「可以合入 main」，见 [第二轮验收报告](../../orchestrate/sprout-mio-p6/reports/p6a-acceptance-round2.md) |
| 9 条判据里与「自动行为不抵消人类控制」直接相关的两条 | 引用 | 同报告判据 6（人类控制优先）与判据 3（周期检查真的发生）                                                                                                        |
| 既有 P5a/P5b 未被弄坏                                | 引用 | 第二轮验收判据 9：12 个回归门禁 exit 0、全量单元 84 文件 711 测试通过、CI `tasks` 11/11、`browser` 11/11                                                        |

复跑：

```bash
bash scripts/verify/bf-p6a-lifecycle.sh
P6A_SCENARIO=stale bash scripts/verify/bf-p6a-lifecycle.sh
```

## 本轮执行记录

本轮亲自跑过的门禁与工具。每一行都是真实退出码；报告引用但未重跑的不入表。

| 命令                                                         | 退出码 | 结果                                                    |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------- |
| `bash scripts/verify/p6a-routing.sh`                         | 0      | 305 条断言，fixture only，zero runs/messages/inputs     |
| `bash scripts/verify/p6a-scheduler.sh`                       | 0      | 23 条断言                                               |
| `bash scripts/verify/p6a-control.sh`                         | 0      | 35 条断言（含 18 条纯 SQL）                             |
| `bash scripts/verify/p6a-delivery.sh`                        | 0      | 45 条断言                                               |
| `bash scripts/verify/p6a-integration.sh`                     | 0      | 13 条断言                                               |
| `bash scripts/verify/bf-p6a-lifecycle.sh`                    | 0      | 177 条断言                                              |
| `P6A_SCENARIO=stale bash scripts/verify/bf-p6a-lifecycle.sh` | 0      | 52 条断言                                               |
| `bash scripts/verify/p6a-pages.sh`                           | 0      | 125 组断言，真实 Chromium                               |
| `bash scripts/verify/p6a-wiring.sh`                          | 0      | 95 条断言                                               |
| `node scripts/verify/targets.test.mjs`                       | 0      | 门禁登记与单元清单自检，fail 0                          |
| `bash scripts/verify/f-docs.sh`                              | 1      | 只有一条既有的断链（见[失败原文](#文档门禁的失败原文)） |
| `bash scripts/verify/l-docs.sh`                              | 1      | 在 f-docs 前置即退出（同上）                            |
| `bash scripts/verify/l-docs-probes.sh`                       | 1      | 27/28，基线上就是红的（同上）                           |

没有执行：`bash scripts/verify/p6a-live-routing.sh`（人工门禁，真实付费调用，不适合收尾轮无预算重跑），因此本轮的准确率结论全部是**引用**而非新的实测。

本表不把后台启动命令的返回时间当测试耗时；每行的工具等待时间未计入任何结论。

## 控制面收敛到三个动作

结论：控制面最终只有 `enabled` / `off` 两态，只有 **enable / disable / abort** 三个改态动作；`retry` 与 `reissue` 是针对单份判定与单份投递的运维动作，不改 `mode`、不改 `epoch`（`retry` 会递增 `revision` 并把 `next_due_at` 提前到当下，`reissue` 另建一份新 delivery identity 并链接原未知投递）。

收敛过程：原型与早期实现里有 `paused` / `stopped` 两个独立状态，Human 在 m02876 指出「暂停自动接续」与「全部停止」在页面上读起来像同一件事。协调者据此裁定收敛为两态三动作，并用一条判据把区别钉住：

- **`disable` 不中止当前轮次。** 它只关掉「以后还会不会来」：`mode=off`、`epoch+1`、删除 `chat_schedule`，在途 run 继续跑到自然结束。
- **`abort` 才中止。** 无 `runId` 时中止本 Chat 全部 `queued`/`running` run 并关闭自动接续；带 `runId` 时只中止那一个 run，且**不改 mode、不改 epoch、不动 schedule**。

这条区别的证据（第二轮验收判据 6，`out/control.log`）：在途判定期间 disable 使 `epoch+1`、`mode=off`、timer 删除，晚到结果落 `stale`、`result` 为 `null`、delivery=0；abort-all 同时中止真实 run 并拒绝晚到结果；run-scoped abort 不改 mode/epoch/timer。实现位置：`src/domain/chat-automation.ts` 的 `applyChatAutomationCommand`。**引用**

`0027` 是这次收敛的落地：三态 CHECK 折成两态，`paused`/`stopped` 一律折成 `off`，历史取消原因 `human_paused` → `human_disabled`、`human_stopped` → `human_aborted`。**实测**：本轮 `p6a-control` 的 `0026 populated upgrade maps paused/stopped to off and preserves epoch/revision/audit` 断言通过，`modeDistribution` 记录 before `enabled/paused/stopped` 各 1 行、after `enabled` 1 行 + `off` 2 行；`human_aborted` / `human_disabled` 由同一轮的取消原因断言覆盖

页面文案仍未跟上模型，见[已知限制 P3-2](#p3-2-disable-的页面文案)。

## 判定准确率只报不判

Human 在 m02131 的原话裁决：判定准确率**只报不判**。也就是说准确率是给人看的测量量，不是门禁的布尔条件。这条已经落进判据（[live 判据与实测](../../orchestrate/sprout-mio-p6/reports/p6a-live-policy.md#协调者修正2026-10-31)），不是口头约定。

门禁真正判的是结构性错误，与模型概率无关：候选集之外的接收者、任何副作用写入（run/message/input 非零）、快照哈希不一致、同一样本多次调用、以及「已付费响应必须完全合契约」。未取得付费响应时只允许 `provider_unavailable` / `provider_timeout` / `provider_invalid_response`，且每 provider 每轮最多容忍 1 次。**引用**

小脑的真实回放记录（8 条固定 live 输入，未改期望、无重试）：**共 5 次真实回放，8/8、7/8、8/8、8/8、7/8**。前四次记在 [live 判据与实测](../../orchestrate/sprout-mio-p6/reports/p6a-live-policy.md#两次真实运行) 与同文「协调者修正」两节，第五次是第二轮独立验收自己跑的一次（`small_brain 12,641 tokens`，7/8，exit 0）。**引用**（本轮没有重跑 live 门禁）

一处口径更正：本轮派工单写的是「三轮回放 8/8、7/8、8/8」。按可查记录实际是 **5 次**（多出协调者修正后的第二轮 8/8 与验收轮自己的 7/8）。本文以记录为准，不把次数改小到与派工单一致。

JEV 在这套中文样本上**不可用**，产品不部署它：

- 30 条中文样本，校准集 w01–w15 / 留出集 w16–w30，服务实际解析为 `jev-1.14.0`；扫描 5050 组单阈值后校准仍只有 **12/15** 集合匹配，独立留出 **9/15**。
- 概率排序与意图反序：w01（人类确认后等结果，不应唤醒）概率 0.69，w12（owner 交接后追问，应唤醒）0.66；要选中 w12 就会选中 w01，要排除 w01 就会漏掉 w12。调 `no` 阈值只能改 no/unknown，修不了排序。
- 处置：**产品默认小脑**（`DEFAULT_PROJECT_WAKE_POLICY.provider = "small_brain"`），**JEV 适配器与请求/收据契约保留，但当前不作为可部署选择**。live 门禁对 JEV 只记录、不参与 exit（`reported only, not deployed`）。

上列数字为**引用**（并行校准单元交付，见 [Jev 作为唤醒判定器](../jev-wake-routing.md#实测结果)），本轮未重复执行 30 条校准。小脑的 8/8、7/8 均为**引用**（对应报告已在仓库内，本轮未重跑 live 门禁）。两组数字都不外推为生产准确率：样本只有 8 条 live / 30 条离线，且模型是随机的。

## 成本与 usage 边界

`wake_evaluation` 表**不持久化 usage**：`0026` 的列里没有 input/output token 字段（`grep usage drizzle/0026_p6a_continuation.sql` 无命中）。**实测**

因此成本事实只存在于两处，都不进产品库：

- `p6a-live-routing` 的每轮收据（`.verify/p6a-live-routing/<UTC>/`，含每条样本的 usage 与 `summary.json`），不纳入 Git。**引用**
- 校准报告与 [live 报告](../../orchestrate/sprout-mio-p6/reports/p6a-live-policy.md) 里的累计数字。**引用**

已知的真实花费：live 报告两轮 32 次调用、32 次拿到计费 usage；第二轮验收一次 16 次付费调用、29,657 tokens（small_brain 12,641、JEV 17,016）。**引用**

代价是产品侧无法回答「这个 Project 这周在判定上花了多少」。这是 P6a 有意的边界——判定成本远小于 run 成本，先不引入计费维度；一旦要做预算或计费，第一件事是给 `wake_evaluation` 加 usage 列并补迁移。

## 门禁登记与人工门禁

9 个 P6a 门禁在四处登记文件里的齐备情况（本轮**只核对、不改**）。**实测**（逐文件 `grep`）

| 门禁               | `lib/suite-plan.mjs`        | `lib/targets-plan.mjs`        | `lib/test-targets.mjs` | `lib/sandbox.mjs` |
| ------------------ | --------------------------- | ----------------------------- | ---------------------- | ----------------- |
| `p6a-routing`      | 有                          | 有（`tasks`）                 | 不适用                 | 不适用            |
| `p6a-scheduler`    | 有                          | 有（`tasks`）                 | 不适用                 | 不适用            |
| `p6a-control`      | 有                          | 有（`tasks`）                 | 不适用                 | 不适用            |
| `p6a-delivery`     | 有                          | 有（`tasks`）                 | 不适用                 | 不适用            |
| `p6a-integration`  | 有                          | 有（`tasks`）                 | 不适用                 | 不适用            |
| `p6a-live-routing` | 有（且列入 `MANUAL_GATES`） | 有（`manual`，不含 CI/local） | 不适用                 | 不适用            |
| `bf-p6a-lifecycle` | 有                          | 有（`tasks`）                 | 不适用                 | 不适用            |
| `p6a-wiring`       | 有                          | 有（`tasks`）                 | 不适用                 | 不适用            |
| `p6a-pages`        | 有（`sandbox: true`）       | 有（`browser`）               | 不适用                 | 有                |

三处「不适用」是登记职责不同，不是缺登记：

- `lib/test-targets.mjs` 登记的是**单元测试清单**（`UNIT_TARGETS`），不是门禁名。P6a 在这份清单里的映射是 `tests/p6a-contracts.test.ts` 进 `ci`，且 `validateUnitTargets` 要求 `tests/**/*.test.ts` 与清单严格相等，多一个少一个都报错。
- `lib/sandbox.mjs` 只白名单**需要隔离工作树运行**的门禁。`p6a-pages` 是 P6a 里唯一 `sandbox: true` 的门禁，所以只有它在白名单里。两个模块共享这个事实，`validateGateTargets()` 会把 `suite-plan` 里所有 `sandbox: true` 的 id 与 `lib/sandbox.mjs` 的白名单文本比对，不一致就在任何命令启动前失败。
- `MANUAL_GATES = ["p6a-live-routing"]`：它是全仓库唯一需要真实付费调用的门禁，因此不进 CI 也不进本地批量运行；`targets.test.mjs` 另断言它不出现在 `ci` 与 `local` 里。

`p6a-live-routing` 的模型边界要说清：**routine 门禁一律用确定性替身**（`scripts/verify/lib/model-fixture.mjs` 的 `sprout-verify-local` provider，`SPROUT_PI_ENABLED=false`，不联网、不付费）；只有这一个门禁走真实 provider，而它的准确率只记录、不判定。所以「模型行为」在常规门禁里是确定性的，「模型效果」只能人工跑一次看趋势。

核对命令（本轮已执行，exit 0）：

```bash
node scripts/verify/targets.test.mjs
```

## 暂停时在途判定落 stale 的独立复证

这条结论来自第一轮验收发现的产品缺陷（在途判定期间暂停，结果落成 `canceled` 而不是 `stale`），修复后被独立复证过两次：

1. **第一轮修复**：`integration/p6a` 的 `b837f82` 把 `p6a_control_disabled` 改成只把 `pending` 标 `canceled`、把 `claimed` 与 `retry_wait` 标 `stale`。复验命令 `P6A_SCENARIO=stale bash scripts/verify/p6a-lifecycle.sh` exit 0、当时 35 条断言通过（本轮同一命令 exit 0、52 条断言，断言数随门禁加固增长），见 [I-P6a 章节集成验证](../../orchestrate/sprout-mio-p6/reports/p6a-int-report.md#协调者修复--复验)。**引用**
2. **第二轮独立复证**：验收者不只看门禁，另用独立探针重跑了一遍：`/tmp/p6a-r2-probes/out/control.log` 记录在途判定期间 disable 后 `epoch+1`、`mode=off`、timer 删除，晚到结果落 `stale`、`result` 为 `null`、delivery=0；`/tmp/p6a-r2-probes/out/migration.log` 记录升级前 paused 行的在途结果落地为 `stale/result=null`、pending delivery 变 `canceled/human_disabled`，stopped 行的 claimed evaluation 由第一次 `recoverSchedules` 变 `stale` 并删掉 timer。见 [第二轮验收报告](../../orchestrate/sprout-mio-p6/reports/p6a-acceptance-round2.md) 的「12 条判据」第 6 项与「升级路径」小节。**引用**（验收者执行，本轮未重跑其探针）

这条之所以值得单列：它是「自动行为不抵消人类控制」的唯一硬证据形式。落成 `canceled` 会让「已经付出去的判定」和「从没发生的判定」在库里长得一样，事后无法区分到底是 Human 抢在前面还是系统漏了一次。

## 第一轮验收缺陷的关闭证据

第一轮验收共留 9 条：1 条 P1、4 条 P2、4 条 P3。逐条去向如下，全部指向 [门禁加固报告](../../orchestrate/sprout-mio-p6/reports/p6a-gate-hardening-report.md) 与 [第二轮验收报告](../../orchestrate/sprout-mio-p6/reports/p6a-acceptance-round2.md) 的「第一轮 P1/P2/P3 复核」表。

| 编号 | 内容                                                 | 状态               | 关闭证据                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | `p6a-pages`、`as-p5b-task-pages` 未进 sandbox 白名单 | 关闭               | `validateGateTargets` 新增白名单比对 + 一条能变红的测试（`9073250`）；第二轮复核 `--only p6a-pages` 12.112s exit 0、`--only as-p5b-task-pages` 21.831s exit 0、CI browser 11/11                                                           |
| P2-1 | 控制面的两道闸门没有门禁                             | 关闭               | `p6a-control` 新增 18 条纯 SQL 断言（`pending→canceled`、`claimed/retry_wait→stale`、schedule 删除、`decided` 不动）；`landingFence()` 同时断言 evaluation 行五个字段与 delivery 行数（`40f0c7a`）；破坏实验 E1/E2 分别红在落地期与触发器 |
| P2-2 | 「300 秒」两处来源                                   | 关闭               | `p6a-scheduler` 新增「成功检查后 `next_due_at - now === INTERVAL_MS`」并读取最新迁移的 `NEW.updated_at+<literal>` 与 `INTERVAL_MS` 比较；破坏常量与破坏 SQL 字面量分别红在不同断言（`40f0c7a`）                                           |
| P2-3 | Worker 门禁在 `--only` 下必红                        | 关闭               | `bb-task-live`、`bs-p5b-lifecycle` 的 `preparation` 补 `worker`（`1146372`）；`--only` 在门禁加固轮实测各 exit 0；故意去掉 `worker` 后同一命令 exit 1（本轮未重跑，引用报告）                                                             |
| P2-4 | 错误码数量约束丢失                                   | 关闭               | `lease-contracts.test.ts` 恢复 `toHaveLength(34)` 并注明来源（`f82779b`）；加一个码后测试红                                                                                                                                               |
| P3-1 | `policy_changed` 是死值                              | 关闭               | 契约里注明是预留值，代码仍不写它（`d95f37c`）；`grep -rn '"policy_changed"' src` 只命中契约                                                                                                                                               |
| P3-2 | 页面「暂停自动接续」与 `off`、与「全部停止」混淆     | **未关闭（有意）** | 本轮不改，理由见[已知限制](#p3-2-disable-的页面文案)；待 Human 体验确认时一并裁决文案                                                                                                                                                     |
| P3-3 | `p6a-control` 重复断言标签                           | 关闭               | 两个 terminal 标签加 `(terminal run)` / `(other chat)` 后缀（`40f0c7a`）；`control-model-result.json` 18 条标签 18 个唯一值                                                                                                               |
| P3-4 | `p6a-pages` 调度预算 125s                            | 关闭               | 改成 40s（`1146372`），门禁加固轮实测 11.254s；仍是约 3.4 倍高估但不影响正确性（本轮未重跑，引用报告）                                                                                                                                    |

一处口径更正：本轮派工单写「1 P1 + 4 P2 + 4 P3 **全部关闭**」。按上表实际是 **8 条关闭 + P3-2 一条未关闭**，P3-2 由协调者裁定留到 Human 体验确认时与文案裁决一起处理。不把未关闭的一条记作已关闭。

## 计划状态与本轮门禁冲突

本轮按派工单更新了三处计划的 P6a checklist，并为每条勾选补了行内证据（指向本文对应小节，被指向的小节都自带基线 commit 与可跑命令）：[总计划 I-P6a](../development-plan.md#i-p6a-集成自动接续与人类控制)、[功能计划 P6a](../development-plan-functional.md#p6a-完成自动接续与人类控制)、[UI 计划 UI-P6a](../development-plan-ui.md#ui-p6a-完成自动接续与人类控制呈现)。

Human 体验确认没有做，因此 I-P6a 第 4 条**不勾**，正文写「尚无确认版本」。

由此触发的门禁冲突：`scripts/verify/l-docs.sh` 当前把 `I-P6a`、`P6a`、`UI-P6a` 的 checkbox 钉成「必须留空」（断言原文 `… checkbox must remain unchecked`），这是 P6a 未交付时的护栏。技术项已通过验收、需要勾选时，这条护栏必须由同一个提交里的门禁改动一起放宽；本轮按派工单**只动文档、不改 `scripts/verify/**`**，所以勾选之后 `l-docs` 与 `l-docs-probes` 仍是红的。注意两者当前**先**卡在 f-docs 的一条既有断链上，护栏本身另需要一次门禁改动；失败原文与区分见下节。

## 文档门禁的失败原文

四条命令全部实际执行，退出码均为 1，`scripts/verify/**` 未改动。

### `bash scripts/verify/f-docs.sh` → exit 1

```text
FAIL docs/jev-wake-routing.md: missing link ../orchestrate/sprout-mio-p6/reports/p6a-judge-calibration.md
FAIL f-docs 1 checks failed
```

这条**不是本轮引入**的：在 `bde6383` 的干净 worktree（`git worktree add --detach`）里跑同一条命令，输出逐字相同。原因是 [Jev 作为唤醒判定器](../jev-wake-routing.md) 引用的校准报告由并行单元 `p6a-judge-calibration` 交付，不在本分支。本轮新增的 `docs/p6a/*` 共 29 条站内链接（20 条带 anchor）全部可解析，f-docs 的失败条数与基线相同，没有新增一条。

### `bash scripts/verify/l-docs.sh` → exit 1

```text
FAIL docs/jev-wake-routing.md: missing link ../orchestrate/sprout-mio-p6/reports/p6a-judge-calibration.md
FAIL f-docs 1 checks failed
```

`l-docs.sh` 第一行就 `bash scripts/verify/f-docs.sh` 且 `set -e`，所以它在上面那条既有失败处直接退出，还没走到自己的断言。也就是说：它现在根本没到 P6a 护栏那一步。

### `l-docs` 单跑（跳过 f-docs 前置检查）→ exit 1，8 条

为把护栏的原文取出来，在 `/tmp` 里复制 `scripts/verify/l-docs.sh`，只把第一行的 f-docs 调用换成注释、root 钉到本 worktree，其余断言一字未改（工作树里的脚本没有被改）。这条命令**不是验证，只是取证**。

```bash
sed -e 's|^bash scripts/verify/f-docs.sh$|# f-docs precheck skipped for this probe only|' \
    -e 's|^root=.*|root="/Users/snake/.herdr/worktrees/sprout-mio/p6a-closeout"|' \
    scripts/verify/l-docs.sh > /tmp/l-docs-probe-nofdocs.sh
bash /tmp/l-docs-probe-nofdocs.sh
```

```text
FAIL I-P6a checkbox must remain unchecked: 功能线交付就绪，编排者已核对本单元范围、版本、验证证据与已知限制。证据 [P6a 功能线证据](p6a/summary.md#功能线证据)，基线 `bde6383`，重跑 `bash scripts/verify/p6a-scheduler.sh`、`bash scripts/verify/p6a-delivery.sh`、`bash scripts/verify/p6a-control.sh`；已知限制见 [P6a 已知限制](p6a/summary.md#已知限制)。
FAIL I-P6a checkbox must remain unchecked: UI 线交付就绪，编排者已核对 Human 确定的设计、演示代码与自检证据。证据 [P6a UI 线证据](p6a/summary.md#ui-线证据)，基线 `bde6383`，重跑 `bash scripts/verify/p6a-pages.sh`；页面形状为 Human 选定的方案 A。
FAIL I-P6a checkbox must remain unchecked: 集成线完成接入与自检，独立技术验收通过，编排者已核对结论与可运行版本。证据 [P6a 集成线与技术验收证据](p6a/summary.md#集成线与技术验收证据)，基线 `bde6383`，重跑 `bash scripts/verify/bf-p6a-lifecycle.sh`；第二轮独立验收在 `303fbf5` 判「可以合入 main」，见 [第二轮验收报告](../orchestrate/sprout-mio-p6/reports/p6a-acceptance-round2.md)。
FAIL UI-P6a checkbox must remain unchecked: 完成自动接续状态、人类暂停与停止、失败反馈及恢复控制的呈现，保持 Task、run 与自动检查语义独立。证据 [UI 线证据](p6a/summary.md#ui-线证据)，基线 `bde6383`，重跑 `bash scripts/verify/p6a-pages.sh`；文案遗留见 [P3-2 disable 的页面文案](p6a/summary.md#p3-2-disable-的页面文案)。
FAIL UI-P6a checkbox must remain unchecked: 核对普通信息可见性与聊天正文访问、对象操作权限的区别，完成全章演示和交付材料。证据 [UI 线证据](p6a/summary.md#ui-线证据)与[集成线与技术验收证据](p6a/summary.md#集成线与技术验收证据)，基线 `bde6383`，重跑 `bash scripts/verify/p6a-pages.sh`。
FAIL P6a checkbox must remain unchecked: - [x]
FAIL P6a checkbox must remain unchecked: - [x]
FAIL P6a checkbox must remain unchecked: - [x]
FAIL l-docs 8 checks failed
```

8 条全部是 P6a 相关护栏，没有一条是链接、锚点、路径或其它章节状态。`P6a checkbox must remain unchecked` 那条打印的是 `- [x] `（正则只捕获到列表符号），但按出现顺序对应功能计划 P6a 的三条。

### `bash scripts/verify/l-docs-probes.sh` → exit 1，27/28

```text
FAIL current docs pass (exit 1)
…
FAIL docs/jev-wake-routing.md: missing link ../orchestrate/sprout-mio-p6/reports/p6a-judge-calibration.md
FAIL docs/p6a/summary.md: missing link ../../orchestrate/sprout-mio-p6/reports/p6a-acceptance-round2.md
…（docs/p6a 下共 11 条同类）
FAIL f-docs 13 checks failed
FAIL current docs pass: exit 1, expected success
…
FAIL l-docs-probes 27 of 28 probes failed
```

两点必须分开说，否则会读成「本轮把探针门禁弄坏了」：

1. **27/28 是既有状态**：在 `bde6383` 的干净 worktree 里跑同一条命令同样是 `FAIL l-docs-probes 27 of 28 probes failed`。机理是探针会在 `PROBE_BASE`（默认 `main`）的 worktree 里覆写并重跑 f-docs，而 `docs/jev-wake-routing.md` 的那条校准报告链接在 `main` 上就是断的（`main` 没有 `orchestrate/sprout-mio-p6/reports/`）。每个用例的前置 f-docs 先红，就永远到不了它真正要检验的 l-docs 行为。
2. **11 条新增失败同源**：本文与契约里指向 `orchestrate/sprout-mio-p6/reports/` 的链接，在 `main` 的树里同样不存在。它们在本分支是通的，合并进 `main` 后也是通的，只在「`main` 的树 + 本分支的 docs」这个探针特有人造组合里断。默认基线上 f-docs 从 2 条变 13 条，就是这 11 条。

用脚本自带的 `PROBE_BASE` 指到本分支，可以让这些报告链接解析出来：

```bash
PROBE_BASE=integration/p6a bash scripts/verify/l-docs-probes.sh
```

结果仍是 `27 of 28 probes failed`（原因 1 未消除），但每个用例的前置失败只剩那一条既有的 `p6a-judge-calibration.md`（`f-docs 1 checks failed`），日志里 `docs/p6a` 的命中数是 **0**。这反过来说明：本文的跨目录链接在「含 `orchestrate/` 的树」里全部可解析，探针门禁的真实阻塞点是缺失的校准报告，不是 P6a 的文档。

### 处置建议

两条既有失败都不在本轮的改动权限内，也不该由 P6a 收尾改门禁来绕过：

1. `p6a-judge-calibration.md` 该由并行校准单元交付，或在确认不交付时改掉 `docs/jev-wake-routing.md` 的那条链接。补上之后 f-docs 与 l-docs-probes 的前置会一起变绿。
2. P6a 的 checkbox 护栏需要一次显式的门禁改动：把 `I-P6a`/`P6a`/`UI-P6a` 从「必须留空」改成与 P4b/P5b 同样的「勾选时必须带可解析证据」。这一步与本文不在同一个单元，本轮不代做。

## 已知限制

### P3-2 disable 的页面文案

页面用「暂停自动接续」表示 `disable`，而契约与协议里只有 `enabled` / `off`；旁边的「全部停止」是 `abort`。两个词读起来像同一类事情，差别（一个不中止当前轮次、一个中止）只在卡片正文里解释。

协调者裁定：`disable` 不中止当前轮次、`abort` 才中止，这是**语义**结论；这个语义差别由 Human 体验确认时一并裁决是否改文案。本轮不改文案，也不改测试（`tests/fixtures/p6a-pages-browser.ts:124,150,178` 仍按「暂停自动接续」定位按钮）。**实测**（本轮执行 `grep -n "暂停自动接续" tests/fixtures/p6a-pages-browser.ts` 命中 124、150、178 行；第二轮验收 P3-2 亦判未关闭）

### P3-5 0027 的迁移残留

`0027` 只重建控制表与映射取消原因，**不主动清理** `paused`/`stopped` 行上残留的 `claimed` evaluation 与 `chat_schedule`。它们要等第一次 `recoverSchedules` / `scanChatSchedules` 才收敛成 `stale` / 删除。

后果：升级后到第一次扫描之间的窗口里，数据库仍留旧态行。这些行**不会投递**——第二道 epoch 闸会在落地时拦成 `stale`。所以这是脏读窗口，不是行为窗口。**引用**（第二轮验收 migration 探针 `/tmp/p6a-r2-probes/out/migration.log`；本轮跑了 `p6a-control` 确认升级映射与统计，但没有重跑该残留窗口探针）

### P3-6 300 秒两处来源

「300 秒」有 TS 常量（`CHAT_AUTOMATION_POLICY.intervalSeconds`）与 SQL 字面量（`0026` 触发器里的 `NEW.updated_at+300000`）两处来源。现在靠 `p6a-scheduler` 的门禁钉住相等（读最新迁移的触发器字面量与 `INTERVAL_MS` 比较），**不是物理单一来源**。

这意味着改间隔必须同时改两处，只改一处会被门禁抓住（P2-2 的破坏实验证实过）。但它仍是双写点：新增迁移如果再写一个触发器字面量，必须同时更新那条比较。**引用**（比较逻辑见 `tests/fixtures/p6a-schedule.ts`；P2-2 的破坏实验由门禁加固轮实测）

## 未验证项

| 项                                    | 为什么没验                                | 归属                                                           |
| ------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Human 亲自体验并确认                  | 尚未进行                                  | I-P6a 第四条，待 Human                                         |
| 生产环境的判定准确率                  | 只有 8 条 live 与 30 条离线样本，模型随机 | 随 PR 累计数据观察，不承诺                                     |
| JEV 是否值得重新评估                  | 本轮已裁定不部署                          | 模型或请求契约变化后重跑校准 + 留出集                          |
| `p6a-live-routing` 连续两轮绿         | 判据已改为「只报不判」，不再要求          | 不再是目标                                                     |
| Firefox / Safari、暗色主题、完整 WCAG | 只做了 Chromium 三视口                    | 随 P7 整体体验验收                                             |
| 判定成本的产品化统计                  | `wake_evaluation` 不持久化 usage          | 需要时加列 + 迁移                                              |
| 默认策略哈希失效推断                  | 未构造对照实验                            | 见[契约](contracts.md)的「Project 判定器配置」一节，标为未验证 |
