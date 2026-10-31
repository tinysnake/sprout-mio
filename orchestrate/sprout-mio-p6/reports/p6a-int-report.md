# I-P6a 章节集成验证：在途暂停的审计状态不符合 brief

状态：**阻塞，未通过章节验收**。发现产品契约失败后，按 brief 的产品缺陷边界停止。没有修改产品代码、迁移、既有门禁、既有断言或门禁登记文件。

分支 `p6a/int`。开工时 `HEAD` 与 `integration/p6a` 同为 `d565ab80b9057fd3609b5381519ac0e569da2aa5`。冻结设计从主 checkout 的 `orchestrate/sprout-mio-p6/reports/p6a-design.md` 读取；该忽略文件没有复制进本单元。

新增交付文件为 `tests/fixtures/p6a-lifecycle.ts`、8 行的 `scripts/verify/p6a-lifecycle.sh` 和本报告。夹具启动生产 `startRuntime()`、真实 SQLite 和生产 scheduler。只替换 `complete` 与 `fetch` 模型边界。owner 通过真实 `PiSessionProcess`、`executeRun`、remote grant 和 HTTP gateway 使用 Task 命令。运行不需要 `.env`，没有调用外部模型。

## 阻塞：Human 暂停使在途 evaluation 成为 canceled

brief 第 3 条要求：判定在途时 Human 暂停，epoch 改变，落地结果记为 `stale`，零 run 输入、零消息，并且不能静默记为成功。

实际调用链为：

1. 默认 Project 创建 Group Chat 和 assigned Task，不立即开始。
2. 令 schedule 到期，调用 runtime 的 `scheduler.advance()`。
3. `complete` 替身停在 Promise 屏障。数据库已有 `claimed` evaluation，保存了 input、claim token 和 epoch 1。
4. Human 调用 `applyChatAutomationCommand({ action: "pause", ... })`。control 立刻成为 `paused`、epoch 2。
5. 释放模型屏障，返回有效的继续判定，等待 `scheduler.settled()`。
6. evaluation 保持 `canceled`，`result` 为 NULL。断言期望 `stale`，实际为 `canceled`，进程 exit 1。

最小复现入口：

```bash
P6A_SCENARIO=stale bash scripts/verify/p6a-lifecycle.sh
```

失败信息：

```text
AssertionError [ERR_ASSERTION]: pause leaves a visible stale result
+ actual - expected
+ 'canceled'
- 'stale'
```

最终独立复现的 SQLite 是 `.verify/p6a-lifecycle/run/1793424202793-af121a15-68e0-4988-b5f4-4655c32dfac8/lifecycle.sqlite`。JSONL 是同级 `1793424202793-af121a15-68e0-4988-b5f4-4655c32dfac8-main.jsonl`。`human-race-outcome` 保存了变化前后的 evaluation、control、Task 以及所有可见副作用。

该次复现的实际事实：

| 事实                    | 结果                                                     |
| ----------------------- | -------------------------------------------------------- |
| 模型请求数              | 1                                                        |
| 暂停前 evaluation       | claimed，control_epoch 1，claim_token 非空，input 已保存 |
| 暂停后 control          | paused，epoch 2，revision 2                              |
| 判定返回后的 evaluation | canceled，claim_token NULL，result NULL                  |
| continuation_delivery   | 0                                                        |
| agent_run               | 0                                                        |
| message                 | 0                                                        |
| Task 状态               | assigned                                                 |
| chat_schedule           | 无                                                       |

这不是重复投递或暂停失效。失败在于本 brief 要求的审计状态没有保留。

相关产品位置：

- `src/domain/chat-automation.ts:280` 更新 control mode 和 epoch。
- `drizzle/0026_p6a_continuation.sql:180` 的 `p6a_control_disabled` trigger 在 mode 禁用时执行。
- 同一迁移的第 182 行把 pending、claimed、retry_wait evaluation 全部改为 `canceled`，并清空 token。
- `src/domain/continuation-delivery.ts:352` 检查 evaluation 仍为 claimed 且 token 相同。当前行已经 canceled，因此直接返回，未进入第 354 行把过时结果记为 stale 的分支。
- `src/domain/chat-schedule.ts:267` 的 reconcile 仅把 pending、claimed、retry_wait 改成 stale，无法再修改 trigger 已取消的行。

按本单元契约，已发出模型请求的 claimed evaluation 在 Human 改变 epoch 后应保留 `stale` 审计语义，同时仍然禁止投递。尚未执行的 pending 检查是否继续采用 canceled，交由产品实现单元与协调者确定。此单元不修改迁移或提交逻辑，也不把断言放宽成 `stale | canceled`。

## 不变量与已执行覆盖

| 要求               | 夹具中的断言或证据                                                                                                                                                                              | 实际状态                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 连续生命周期       | 无 policy override，宿主默认模型，assigned 不创建 run，两轮 due，两次 owner 输入和 ACK，第一轮写记录与发言，第二轮通过 HTTP 完成 Task，无 Task 删 schedule 和 timer，暂停、恢复、停止、显式恢复 | 首次完整执行中全部经过并通过；随后在 stale 场景失败。尚无完整绿色验收       |
| 1：同 due 并发     | 两个生产 scheduler 并发 advance，模型屏障保持 claimed，evaluation 数 1、provider 请求 1、attempt 1、第二 writer 无 claim、delivery 数 1                                                         | 经过并通过；未做故意破坏，不能宣称已完成 CAS 破坏验证                       |
| 2：跨 Project 隔离 | 两 Project 四 Chat 的四个请求同时在途，Project 名、persona、Task 标题带独立 canary，候选和 delivery 只属于本 Chat                                                                               | 经过并通过；没有单独构造另一 Project 的历史消息正文                         |
| 3：stale 不投递    | 在途 pause、stop、reassign；检查 state、delivery、run、message、schedule                                                                                                                        | pause 的零副作用断言通过，state 断言失败。stop 和 reassign 因停止规则未继续 |
| 4：重启恢复        | 同文件 crash、recover、recover-again 模式；提交后 observer 真实 SIGKILL，再启动 runtime 扫描，检查 delivery identity、next due、host 输入一次                                                   | 已编写，未执行。失败前没有到达此场景                                        |
| 5：Human 优先      | 连续生命周期的立即控制、停止后新 assigned 不复活、显式恢复可再到期；在途 pause 的零副作用                                                                                                       | 上述路径经过并通过；在途 stop、reassign 后续覆盖未执行                      |
| 6：业务写边界      | TEMP trigger 记录所有 main table 的 INSERT、UPDATE、DELETE；调度观察窗口允许业务执行表和调度元数据表，Task 状态不变                                                                             | 已编写，未执行。当前只观察专用调度窗口，还不是整条生命周期的完成证据        |
| 7：预算            | 65 个完整 assigned Task 超 24000 字符，拒绝 input 和模型调用、零 delivery；Human 减少 assigned Task 后下一轮恢复                                                                                | 已编写，未执行。未声称预算边界通过                                          |

重启和预算后半段保留为未验证代码，方便协调者修复 blocker 后继续验收。仅 typecheck 通过不证明这些路径正确。

## 实测命令与退出码

| 命令                                                                                       | 实际退出码 | 结果                                         |
| ------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------- |
| `pnpm install --prefer-offline`                                                            | 0          | 依赖安装成功                                 |
| `pnpm typecheck`，最终版本                                                                 | 0          | 三份 tsconfig 均无错误                       |
| `pnpm exec vp lint tests/fixtures/p6a-lifecycle.ts`，最终版本                              | 0          | 无告警                                       |
| `pnpm exec vp fmt --check tests/fixtures/p6a-lifecycle.ts scripts/verify/p6a-lifecycle.sh` | 0          | 改动匹配文件格式通过，shell 不由该格式器处理 |
| `node --import tsx tests/fixtures/p6a-lifecycle.ts`，首次完整执行                          | 1          | 71 条断言通过，随后 pause/stale 断言失败     |
| `P6A_SCENARIO=stale bash scripts/verify/p6a-lifecycle.sh`，独立复现 1                      | 1          | 9 条断言通过，同一 pause/stale 断言失败      |
| `P6A_SCENARIO=stale bash scripts/verify/p6a-lifecycle.sh`，最终独立复现                    | 1          | 9 条断言通过，同一 pause/stale 断言失败      |
| `shasum -a 256 -c .verify/p6a-lifecycle/source-sha256.txt`                                 | 0          | 最终 fixture、薄壳与产品来源哈希匹配         |

上述三个实际产品失败的 fixture 计时分别为 1112.770166 ms、785.416292 ms、820.9255 ms。计时从 fixture 初始化到写入 result，未计最后的 runtime shutdown，也不是 shell 总耗时或工具等待耗时。没有三个 exit 0，不能把这些失败复现记作要求的三次绿色运行。

更早的夹具开发轮次先后暴露两个 TypeScript 编译问题，以及 Project API 省略默认 `wakePolicy` 字段导致的一次断言编写错误。已仅在新增夹具中修正。该 API 断言错误的 JSONL 保留在证据目录，不能算产品失败。最终同时验证 API 字段为 undefined、SQLite policy override 为 NULL。

按“发现产品代码缺陷后报告并停止”的边界，下列要求的门禁**未执行，退出码均为 N/A**：

| 门禁              | 退出码 | 原因           |
| ----------------- | ------ | -------------- |
| i2-group-chat     | N/A    | blocker 后停止 |
| i3-public-channel | N/A    | blocker 后停止 |
| i4-agent-fanout   | N/A    | blocker 后停止 |
| i6-chat-info      | N/A    | blocker 后停止 |
| ba-task-domain    | N/A    | blocker 后停止 |
| bs-p5b-lifecycle  | N/A    | blocker 后停止 |
| p6a-scheduler     | N/A    | blocker 后停止 |
| p6a-delivery      | N/A    | blocker 后停止 |
| p6a-control       | N/A    | blocker 后停止 |
| p6a-integration   | N/A    | blocker 后停止 |
| p6a-wiring        | N/A    | blocker 后停止 |
| as-p5b-task-pages | N/A    | blocker 后停止 |
| p6a-pages         | N/A    | blocker 后停止 |

第 1、3、4 条要求的“改坏 → 红 → 修回 → 绿”均未执行。第 3 条目前直接在原产品上为红，不存在可据实报告的修回绿色证据。

## 证据与交接

`.verify/p6a-lifecycle/` 包含 `base-commit`、`source-sha256.txt`、`exit-code`、`run/*.jsonl`、每次运行自己的 SQLite、生成的确定性 owner runner 和 host-inputs JSONL。最终 `exit-code` 为 1。薄壳保留失败退出码，不使用 `|| true`。

独立复现只运行 `P6A_SCENARIO=stale`，该选择是定位入口，不能替代最终无筛选门禁。默认入口仍然尝试完整连续生命周期和全部场景。

协调者需要先解决或明确修订 claimed evaluation 在 Human pause 后的 stale 契约，再交由新的验证单元继续后半段、三个绿色运行、破坏验证和列出的既有门禁。本报告没有将 I-P6a 登记为完成。
