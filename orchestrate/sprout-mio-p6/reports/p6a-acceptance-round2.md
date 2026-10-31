# P6a 独立技术验收（第二轮）

- 受验对象：`integration/p6a` 的 `303fbf5`（`303fbf588a734157d03528bd5858681e74fec56c`），工作树在验收前 `git status --porcelain` 为空。
- 环境：本 worktree 自己 `pnpm install --prefer-offline` 安装依赖，未软链 `node_modules`；`.env` 从 `/Users/snake/workspace/sprout-mio/.env` 复制。验收时负载 3.52 / 3.88 / 4.51（开始为 3.63 / 4.90 / 5.18），没有出现时间预算假红。
- 第一轮报告与门禁加固报告只当作线索。本文所有结论都来自本轮自己执行的命令、探针和数据库观测。
- 探针都放在 `/tmp/p6a-r2-probes/`，只改临时副本 `/tmp/p6a-r2-probe`（`git archive 303fbf5` 解出，再 `git init` 以便 Worker 门禁读 HEAD），没有改本 worktree 的产品代码、门禁或断言。

## 结论

**可以合入 main。**

没有遗留 P1 或 P2。第一轮的 1 个 P1、4 个 P2、4 个 P3 中，P1-1、P2-1、P2-2、P2-3、P2-4、P3-1、P3-3、P3-4 已关闭；P3-2 仍未处理，属于人类文案问题。本轮另外记录两条 P3（见下）。

阻塞项（P1/P2）：无。

未关闭的 P3 与复现命令：

| 编号 | 内容 | 复现 |
| --- | --- | --- |
| P3-2 | 页面仍用「暂停自动接续」表示 `disable`，而模型与协议只有 `enabled/off`，与旁边的「全部停止」（abort）容易混淆 | `grep -n "暂停自动接续" tests/fixtures/p6a-pages-browser.ts` 命中 124、150、178 行 |
| P3-5 | 0027 迁移只改表和取消原因，不主动清理 `paused/stopped` 行上残留的 claimed evaluation 与 schedule；要等第一次 `recoverSchedules` / `scanChatSchedules` 才收敛 | `sed -n "1,24p" drizzle/0027_p6a_automation_off.sql` 只有重建控制表与 cancel_reason 映射，没有清理 evaluation/schedule；`grep -n "recoverSchedules" -A 20 src/domain/chat-schedule.ts` 才做 stale 与删除。探针证据 `/tmp/p6a-r2-probes/out/migration.log` |
| P3-6 | 「300 秒」仍是两处来源（TS 常量与 SQL 字面量），现在靠门禁钉住相等，不是物理单一来源 | `grep -rn "intervalSeconds\|NEW.updated_at+" src/contracts/chat-automation.ts drizzle/0027_p6a_automation_off.sql` |

## 12 条判据

| # | 判据 | 结果 | 本轮证据 |
| --- | --- | --- | --- |
| 1 | 四态 Task 与自动接续的边界 | 成立 | 探针 `out/states.log`：`task` DDL 含 `proposed/assigned/finished/canceled`，数据库拒绝 `running/awaiting/blocked`；一次真实检查前后 `task` 1 行、`task_event` 2 行完全不变。生命周期门禁 `.verify/task-lifecycle-CzRjlvPh/run/fixture.log`：`real runner model_error leaves Task assigned`、`Human completion ... preserves real lease and Machine rows` |
| 2 | 不立即开始就不产生任何东西 | 成立 | `out/states.log`：分配后 run/delivery/evaluation/message 均为 0；`chat_schedule.next_due_at - task.updated_at = 300000`。`p6a-scheduler` 23 条断言通过，结果 `.verify/p6a-scheduler/scheduler-result.json` |
| 3 | 周期检查真的发生 | 成立 | `p6a-scheduler` 通过，含 `startup-restored timer drives real evaluation`、`a successful check re-arms exactly one policy interval from now`。live 门禁真实付费调用 16 次，见 `.verify/p6a-live-routing/20261031T073028Z/summary.json` |
| 4 | 判定器零副作用 | 成立 | `out/side-effects.log`：对 14 张非自动化表装 INSERT/UPDATE/DELETE 审计触发器，判定后审计表为空；evaluation=`decided`，delivery=1 |
| 5 | 失败不装成功 | 成立 | `out/failure.log`：provider 连续失败依次 `retry_wait(30s)`、`retry_wait(120s)`、`attention(provider_unavailable)`，delivery=0。`p6a-delivery` 45 条断言通过 |
| 6 | 人类控制优先 | 成立 | `out/control.log`：在途判定期间 disable 使 epoch+1、mode=off、timer 删除，晚到结果落 `stale`、result 为 null、delivery=0；abort-all 同时中止真实 run 并拒绝晚到结果；run-scoped abort 不改 mode/epoch/timer。`p6a-control` 18 条纯 SQL 断言 + 23 条控制套件断言通过 |
| 7 | 投递语义不撒谎 | 成立 | `p6a-delivery` 45 条断言通过，含 `admitted input cannot send twice before ACK`、`restart preserves attempted unknown delivery`、`unknown delivery blocks automatic new checks`、`admitted unknown is never selected again`、`Human confirmation creates a new delivery identity linked to unknown original`。`p6a-integration` 另证 running steer 复用同一 run 并收到自己的 ACK |
| 8 | 越权与跨域拒绝 | 成立（比第一轮强） | `out/authz.log` 17 条：非成员、跨 Project、Project/Chat 不匹配、撤销成员、Agent 越权 disable、Agent 跨 Chat 读、Agent 改策略全部拒绝；真实 run scope 只能读自己 Chat。另用真实 grant 双向证明：撤销且过期的 grant 不会移除本人 Chat 的读权限，也不能把 Agent 扩到兄弟 Chat。结论是 automation 读路径根本不消费 grant，不存在「用失效 grant 换取访问」的入口 |
| 9 | P5a 与 P5b 没被弄坏 | 成立（比第一轮强） | 12 个回归门禁经 runner 一次跑完，exit 0，32.198s（`.verify/runs/2026-10-31T07-29-34-743Z-99176-0/report.json`）；`bb-task-live` 与 `bs-p5b-lifecycle` 单独 `--only` 均 exit 0；全量单元 84 文件 711 测试通过；CI `tasks` 组 11/11 exit 0（`.verify/targets/ci-tasks.json`）；CI `browser` 组 11/11 exit 0，309.416s（`.verify/targets/ci-browser.json`），第一轮红的 `as-p5b-task-pages` 与 `p6a-pages` 现在都是 0 |
| 10 | 门禁本身可信 | 成立 | 7 次新破坏全部被抓到，破坏点与第一轮不同，见下表。每次还原后对应门禁重新变绿 |
| 11 | 成本与边界如实 | 成立 | 本轮真实模型只跑 `p6a-live-routing` 一次：16 次付费调用，29,657 tokens（small_brain 12,641，JEV 17,016），exit 0。其余门禁全是本地 fixture，无付费调用 |
| 12 | 未来兼容 | 成立 | `out/future.log`：新 Project 的 `wake_policy` 为 null、policy command 0，首次检查读默认策略；显式配置只落 1 条命令；改策略后旧投递绑定前被 `task_context_changed` 取消；`getChatAutomation` 视图通过 schema；自动接续不换 owner、不清 assigned Task、不取租约 |

判据 8 的边界说明：判据原文里的「已失效 grant」在 automation 读路径没有对应输入，这是设计事实，不是缺口。现在不仅证明「该路径不读 grant」，还证明「库里有撤销且过期的 grant 时，权限结果不变」，比第一轮的「无法证明」更强。

## 第一轮 P1/P2/P3 复核

| 编号 | 状态 | 本轮复核 |
| --- | --- | --- |
| P1-1 sandbox 白名单 | 关闭 | `p6a-pages`、`as-p5b-task-pages` 已进白名单；`node scripts/verify/targets.test.mjs` 6/6 通过；`node scripts/verify/runner.mjs --only p6a-pages` exit 0（12.112s，`.verify/runs/2026-10-31T07-45-42-514Z-59734-0/report.json`）；`--only as-p5b-task-pages` exit 0（21.831s）；CI browser 组 11/11 绿 |
| P2-1 两道闸门无门禁 | 关闭 | `p6a-control` 现在有 18 条纯 SQL 断言（pending→canceled、claimed/retry_wait→stale、schedule 删除、decided 不动），`p6a-schedule.ts` 的 `landingFence()` 同时断言 evaluation 行 `state/result/claim_token/lease_until/next_attempt_at` 与 delivery 行数。两个破坏实验可分别观察到 |
| P2-2 300 秒来源 | 关闭 | `p6a-scheduler` 新增「成功检查后 `next_due_at - now === INTERVAL_MS`」，并读取最新迁移的 `NEW.updated_at+<literal>` 与 `INTERVAL_MS` 比较；`p6a-contracts` 仍钉 `intervalSeconds: 300`。破坏常量与破坏 SQL 字面量分别红在不同断言 |
| P2-3 Worker 门禁 `--only` 假红 | 关闭 | `--only bb-task-live` exit 0（17.448s），`--only bs-p5b-lifecycle` exit 0（12.764s）。去掉 `worker` preparation 后，同一命令 exit 1，日志原文 `Prepared-only verification forbids producing server; current-run receipt or outputs do not match` |
| P2-4 错误码数量 | 关闭 | `lease-contracts.test.ts` 恢复 `toHaveLength(34)`；往 `APP_ERROR_CODES` 加一个码后测试红，原文 `expected [ 'task_invalid_transition', …(34) ] to have a length of 34 but got 35` |
| P3-1 `policy_changed` 死值 | 关闭 | 契约里已注明是预留值，代码仍不写它；`grep -rn '"policy_changed"' src` 只命中契约 |
| P3-2 「暂停」文案 | 未关闭 | 页面测试仍按「暂停自动接续」定位按钮 |
| P3-3 重复断言标签 | 关闭 | `control-model-result.json` 18 条标签 18 个唯一值，两个 terminal 标签带 `(terminal run)` / `(other chat)` 后缀 |
| P3-4 `p6a-pages` 预算 | 关闭 | 预算从 125s 改成 40s；本轮 runner 实测 11.254s，browser 组内 11.789s。仍是约 3.4 倍高估，但不影响正确性 |

## 破坏实验（新破坏点，全部在临时副本）

| # | 改了什么 | 门禁 | 结果 | 失败信息原文 |
| --- | --- | --- | --- | --- |
| E1 | `drizzle/0027` 中 `p6a_control_disabled` 对 claimed 的 `state='stale'` 改成 `'canceled'` | `p6a-control` | 红 | `AssertionError [ERR_ASSERTION]: raw SQL off stales a claimed evaluation and clears its claim fields`，`actual: { state: 'canceled' }`，`expected: { state: 'stale' }` |
| E1b | 同上，趁 E1 未还原跑 landing fence | `p6a-delivery` | 绿 | `PASS p6a-delivery: 45 assertions`。说明纯 SQL 触发器和落地期闸门可分开观察 |
| E2 | `continuation-delivery.ts` 的 `if (!evaluationCurrent(current))` 改成 `if (false && ...)` | `p6a-control` | 红 | `AssertionError [ERR_ASSERTION]: fenced landing marks the evaluation stale without storing the result`，`actual: ['decided', '<完整 result JSON>', null, null, null]`，`expected: ['stale', null, null, null, null]`，位置 `p6a-schedule.ts:219`（由 `:970` 调用）。同一次运行里 control-model 的 18 条纯 SQL 断言已全部通过并写出 JSON，说明闸门确实分开 |
| E3 | `CHAT_AUTOMATION_POLICY.intervalSeconds` 300 改成 301 | `p6a-scheduler`；单元 `p6a-contracts` | 红；红 | scheduler: `newest migration trigger literal in 0027_p6a_automation_off.sql equals INTERVAL_MS`，`actual: [300000]`，`expected: [301000]`。contracts: `expected { version: 1, …(4) } to deeply equal { version: 1, …(4) }`，diff 为 `intervalSeconds: 300` 对 `301` |
| E4 | `drizzle/0027` 三处 `NEW.updated_at+300000` 改成 `+301000` | `p6a-scheduler` | 红 | `AssertionError [ERR_ASSERTION]: first check waits 300 seconds`，`actual: 1793432490925`，`expected: 1793432489925` |
| E5 | 从 `scripts/verify/lib/sandbox.mjs` 删除 `"p6a-pages"` | `targets.test.mjs`；`targets.mjs ci --group browser` | 红；红 | 两者同一原文 `Error: Suite plan sandboxes p6a-pages but lib/sandbox.mjs does not whitelist it`，抛在 `targets-plan.mjs:122`，命令在任何 gate 启动前退出 1 |
| E6 | 往 `APP_ERROR_CODES` 加 `probe_extra_code` | `tests/lease-contracts.test.ts` | 红 | `AssertionError: expected [ 'task_invalid_transition', …(34) ] to have a length of 34 but got 35` |
| E7 | 从 `bb-task-live` 的 suite plan 去掉 `worker` preparation | `runner --only bb-task-live` | 红 | `Prepared-only verification forbids producing server; current-run receipt or outputs do not match`（证据 `/tmp/p6a-r2-probe/.verify/task-live-QAml3ybA/build-service.log`），还原后同一命令 exit 0 |

所有破坏都还原，并在临时副本上重跑对应门禁确认变绿。E1b 与 E2 一起回答 P2-1 的「各自能被单独观察」。

## 新增的行为验证

1. **迁移路径（带数据的 0026 升 0027）**，`out/migration.log`。数据库先迁到 0026，写入 enabled / paused / stopped 三种控制行、在途 claimed evaluation、pending delivery、legacy cancel reason，再用真实 migrator 连跑两次 0027。结果：
   - paused/stopped 映射为 off，epoch/revision/audit 原样保留；
   - `human_paused → human_disabled`、`human_stopped → human_aborted`；
   - 升级后表继续拒绝第三种 mode；
   - 升级前 paused 行的在途结果落地为 `stale/result=null`，pending delivery 变 `canceled/human_disabled`；
   - 升级前 stopped 行的 claimed evaluation 由第一次 `recoverSchedules` 变 `stale` 并删掉 timer；
   - enabled 行的在途 claim 与 decided/pending 行不受影响；
   - `foreign_key_check=[]`，`integrity_check=ok`，0027 可重复执行。
   迁移本身不清理 paused/stopped 行，这是 P3-5。安全上不影响，因为落地期与 claim 期都检查 mode。

2. **并发（两个进程同时抢到期判定）**，`out/conc-1.json`、`out/conc-2.json`、`out/conc-db.json`。两个进程在同一 barrier 后各跑 10 次 `claimDueEvaluation`：
   - 8 个 Chat 同时到期，最终每个 Chat 恰好 1 条 evaluation、attempt=1、round=1；
   - 单 Chat 版本中两个进程竞争同一行，只有一个拿到 claim，另一个 0 条。
   局限：本轮没有让两个进程同时进入 provider 再同时落地，那一层用下面的租约实验覆盖。

3. **租约过期后的旧 claim 不能落地（第一轮没覆盖的边界）**，`out/lease.log`。先 claim 得到 token A，时间推进到租约过期后再 claim，同一条 evaluation 变成 attempt=2、token B。A 的 `commitEvaluationResult` 返回 null，行仍是 claimed 且 token 为 B；只有 B 能落地并创建 delivery。最终 `decided/attempt=2`，没有 A 的晚到 result。

## 成本与边界

- 门禁侧真实模型调用：只跑 `p6a-live-routing` 一次，16 次付费调用，29,657 tokens。small_brain 12,641（输入 8,027、输出 4,614），JEV 17,016（输入 16,750、输出 266）。准确率 7/8 与 5/8，JEV 有 3 个 under，contractFailures=0，门禁 exit 0，`reported only, not deployed`。
- 我这个验收 agent 自己的会话（截至写报告时，读 `PI_SESSION_FILE` 的 assistant usage 汇总）：174 次模型调用，输入 258,459，输出 87,912，cacheRead 18,545,536，API 口径 totalTokens 18,891,907，provider 报告的 cost 为 0。非缓存输入加输出为 346,371。与门禁付费相加，总计 190 次调用、非缓存 376,028 tokens、API totalTokens 18,921,564。
- 门禁耗时（墙钟，含 runner）：快速批 5 门禁 15.637s；12 个回归门禁 32.198s；`bb-task-live` 17.448s；`bs-p5b-lifecycle` 12.764s；CI tasks 组 20.715s；CI browser 组 309.416s；全量单元 34.74s；live 约 56s。typecheck exit 0，未单独计时。
- 没做的事：没有真等满 300 秒看一次自然到期（用真实 timer 在 1.2 秒后触发，周期用 `next_due_at - now` 证明）；没有跑 CI 的 base/tooling/docs/contracts/api/turns 六组；跨进程「恰好一次」的负向事实仍无法直接观测，只能证明系统把 admitted 未确认标成 `delivery_unknown` 并要求人类核对。
- 方法学：`claimDueEvaluation` 是跨 Chat 全局选最早到期的，任何多场景探针都要单独进程或显式调整各 Chat 的 `next_due_at`，否则会拿到别的 Chat。本轮 authz 探针最初就因此把 delivery 建到了错误的 Chat。

## 证据索引

| 内容 | 路径 |
| --- | --- |
| 快速 5 门禁 | `.verify/runs/2026-10-31T07-27-12-454Z-92269-0/report.json` |
| 回归 12 门禁 | `.verify/runs/2026-10-31T07-29-34-743Z-99176-0/report.json` |
| CI tasks 组 | `.verify/targets/ci-tasks.json` |
| CI browser 组 | `.verify/targets/ci-browser.json` |
| 单跑 p6a-pages | `.verify/runs/2026-10-31T07-45-42-514Z-59734-0/report.json` |
| 单跑 as-p5b-task-pages | `.verify/runs/2026-10-31T07-46-02-592Z-60987-0/report.json` |
| live 付费 | `.verify/p6a-live-routing/20261031T073028Z/summary.json` |
| 控制套件 | `.verify/p6a-control/control-model-result.json`、`control-result.json` |
| 投递套件 | `.verify/p6a-delivery/delivery-result.json` |
| 调度套件 | `.verify/p6a-scheduler/scheduler-result.json` |
| 生命周期 | `.verify/task-lifecycle-CzRjlvPh/run/fixture.log` |
| 探针输出 | `/tmp/p6a-r2-probes/out/{states,side-effects,failure,lease,authz,future,control,migration,conc-1,conc-2,conc-db}.{log,json}` |
| 破坏日志 | `/tmp/p6a-r2-probes/e{1,2,3,4,5,6,7}-*.log`，`/tmp/p6a-r2-probes/e1-delivery.log` |
