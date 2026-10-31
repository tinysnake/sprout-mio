# I-P6a 章节集成验证

当前状态：**七个不变量与第 1、3、4 条破坏验证通过；三次连续绿色待完成**。门禁登记名为 `bf-p6a-lifecycle`，脚本为 `scripts/verify/p6a-lifecycle.sh`，夹具为 `tests/fixtures/p6a-lifecycle.ts`。本单元仅改这两个新增文件和本报告，不改产品实现、迁移、既有门禁与登记文件。

开工基点为 `d565ab80b9057fd3609b5381519ac0e569da2aa5`。首批三个文件先提交为 `cf5ea73`，再按协调者要求 rebase 到修复 `b837f820b0dc901262a0e50efe8663b5a7d43376`，首批提交变为 `3f33f54`。冻结设计从主 checkout 的 `orchestrate/sprout-mio-p6/reports/p6a-design.md` 读取，未复制进本单元。

## 协调者修复 + 复验

修复前，默认 Project 建 Group Chat 和 assigned Task，不立即开始。让生产 scheduler 到期，`complete` 模型替身停在 Promise 屏障。此时真实 SQLite 已有 `claimed` evaluation、input、claim token 和 epoch 1。Human 暂停后，control 成为 `paused`、epoch 2；释放模型请求并等待 `scheduler.settled()`，evaluation 最终为 `canceled`，与 brief 要求的 `stale` 不符。

原失败断言保持不变：

```text
AssertionError [ERR_ASSERTION]: pause leaves a visible stale result
+ actual - expected
+ 'canceled'
- 'stale'
```

修复前的独立复现位于 `.verify/p6a-lifecycle/run/1793424202793-af121a15-68e0-4988-b5f4-4655c32dfac8-main.jsonl`，SQLite 位于同名目录的 `lifecycle.sqlite`。该轮 exit 1，9 条断言通过，fixture 计时 820.9255 ms。日志保存了 claimed → canceled、control epoch 1 → 2、零 delivery、零 run、零 message、Task 仍 assigned、schedule 已删除。

协调者裁定该失败为产品缺陷，在 `integration/p6a` 提交 `b837f82` 修复。`drizzle/0026_p6a_continuation.sql` 的 `p6a_control_disabled` trigger 现在只把 pending 标 canceled，把 claimed 与 retry_wait 标 stale。本单元通过 rebase 引入修复，没有修改产品代码，也没有放宽断言。

在 `3f33f54` 基础上的最终复验命令：

```bash
P6A_SCENARIO=stale bash scripts/verify/p6a-lifecycle.sh
```

该轮 **exit 0、35 条断言通过、fixture 计时 741.710042 ms**。日志为 `.verify/p6a-lifecycle/run/1793425157602-2043ed60-8773-411a-84ff-f88b7e9cafc4-main.jsonl`，SQLite 为同名目录的 `lifecycle.sqlite`。

| 在途变更      | 最终 evaluation | delivery | agent_run | agent_run_input | message |
| ------------- | --------------- | -------- | --------- | --------------- | ------- |
| Human pause   | stale           | 0        | 0         | 0               | 0       |
| Human stop    | stale           | 0        | 0         | 0               | 0       |
| Task reassign | stale           | 0        | 0         | 0               | 0       |

`human-race-outcome` 保存每种变更前后的 evaluation、control、run、run input、消息、Task 和 schedule。run input 使用真实 `agent_run_input JOIN agent_run` 计数，不以零 run 推断。修复前后的证据同时保留。

## 生命周期与七个不变量

夹具启动生产 `startRuntime()`、真实 SQLite 和生产 scheduler。只替换 `complete` 与 `fetch` 模型边界。owner 经真实 `PiSessionProcess`、`executeRun`、remote grant、HTTP gateway 使用 Task 命令，不联网调用真实模型。

当前完整运行在 `b54f338` 加夹具变更上通过：**exit 0、177 条断言**，其中主进程 151 条、SIGKILL 与两次重启子进程合计 26 条。fixture 耗时 4759.802542 ms，整个脚本进程耗时 5022.008292 ms。每轮证据位于 `.verify/p6a-lifecycle/step2/`，主 JSONL 为 `.verify/p6a-lifecycle/run/1793425387702-8d2d140d-cf0f-44d4-95f5-f09b83a76a0f-main.jsonl`。

主进程的 Task 命令用 Human 或 owner 来源标记，除此之外的整个观测区间默认标记为 automation。Human 同步命令结束后，后续 scheduler microtask 仍进入 automation 计数；执行 owner 的真实 run 与授权 HTTP 时使用 owner 标记。审计从 Project 创建前持续到生命周期及并发、预算场景结束。

下列断言均已在同一次无筛选运行中通过：

| 范围                | 断言                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连续生命周期        | 新 Project 没有 policy override，默认 small_brain 使用宿主模型；assigned 不立即执行；两轮 due、receipt、owner envelope、ACK、发言、Task 完成；无 assigned Task 删除 schedule 和 timer；Human 暂停、恢复、停止、显式恢复 |
| 1：一次检查一次判定 | 两个生产 scheduler 并发 advance；evaluation、provider 请求、attempt、delivery 各最多一份；错误 claim token 提交不得写入 receipt 或 delivery                                                                             |
| 2：不跨 Chat 泄漏   | 两 Project 四 Chat 同时在途；成员、Task 与真实消息正文包含各 Project 私有 canary；候选和 delivery 只属于本 Chat                                                                                                         |
| 3：stale 不投递     | 在途 pause、stop、reassign 后 stale、零 delivery、零 run input、零消息                                                                                                                                                  |
| 4：重启恢复         | 提交后 observer 真实 SIGKILL；两个独立进程重启 runtime；检查原 receipt、delivery identity、next due 与 host 输入次数                                                                                                    |
| 5：Human 优先       | 立即控制、停止后新 assigned 不复活、显式恢复可再到期；在途先暂停再恢复使 epoch 前进两次，旧判定 stale，只有新判定产生 delivery                                                                                          |
| 6：不越权           | 整条主生命周期使用 TEMP trigger 记录所有 main table 的 INSERT、UPDATE、DELETE；记录 Human、owner、automation 来源与 Task 状态变化                                                                                       |
| 7：预算             | 65 个完整 assigned Task 超 24000 字符，确定性拒绝且不调用模型、不投递；Human 减少 assigned Task 后下一轮正常恢复                                                                                                        |

TEMP 审计把身份、run input、run 关联、diagnostic 和 schedule、evaluation、delivery 元数据列为执行基础设施。业务表仍按 brief 限制；额外断言 automation 不写 Task、Task event 或 message，Task 状态只来自 Human 或 owner 命令。审计用实际 SQL trigger 计数，不靠最终状态猜测是否写过。

## 破坏验证

在 `7292439` 上完成第 1、3、4 条的“改坏 → 红 → 修回 → 绿”。每个实验都复制产品代码、迁移、同一份 fixture 和配置到 `/tmp/p6a-int/mutation-checkouts/<scenario>`，只改独立副本。当前 checkout 的 `src/**` 和 `drizzle/**` 全程不变。

| 不变量       | 故意破坏                                                                        | 红证据（exit 1）                                                                                                                         | 恢复后的绿证据（exit 0）                    |
| ------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1：claim CAS | 删除 `commitEvaluationResult` 对 claim_token 的比较，保留 state 检查            | `losing claim token fails CAS before writing receipt or delivery` 期望 NULL，却得到新 delivery ID；失败前通过 8 条断言                   | 原比较恢复，18 条通过                       |
| 3：stale     | 将 `p6a_control_disabled` 恢复为修复前的取消逻辑                                | `pause leaves a visible stale result` 期望 stale，实际 canceled；失败前通过 10 条                                                        | 修复后的两条状态更新恢复，52 条通过         |
| 4：重启      | 为 pending 扫描 SQL 添加 `WHERE 0 AND ...`，使恢复扫描漏掉所有 pending delivery | 真 SIGKILL 后 recover 子进程的 `startup scanner binds durable pending delivery` 期望 bound，实际 pending；父进程也因 recover exit 1 失败 | 原扫描恢复，34 条通过，包括子进程中的 26 条 |

三组实验的红进程耗时分别为 941.051958 ms、812.409584 ms、2098.119334 ms；绿进程耗时分别为 763.147208 ms、801.042125 ms、2893.633125 ms。这里是完整子进程耗时，不是 fixture 内部计时。

证据保存在 `.verify/p6a-lifecycle/mutations/{claim,stale,recovery}/`：`mutation.patch`、`mutation.json`、`result.json`、`red/exit-code`、`green/exit-code`、标准输出、JSONL 与真实 SQLite。总表为 `mutations/results.json`，复现脚本为 `mutations/reproduce.py`。每组原源码 SHA-256 与恢复后 SHA-256 完全相等；三组 fixture SHA-256 都是 `3ad917070d9af105217d9da2d480c9a50b4cd6c3257d6aacaad55c84d4ad88cd`。

复现会重新创建 `/tmp` 下对应副本，不改当前产品源码：

```bash
python3 .verify/p6a-lifecycle/mutations/reproduce.py
```

## 新门禁与既有门禁

连续三次绿色运行与 brief 指定的 13 个既有门禁结果待后续提交登记。定向 stale 复验不替代无筛选的新门禁。

依赖已执行 `pnpm install --prefer-offline`，exit 0。当前 TypeScript、lint、格式检查与最终源码证据将在验收结束时统一记录。

`.verify/p6a-lifecycle/` 保存 `base-commit`、`source-sha256.txt`、`exit-code`、`run/*.jsonl`、每轮 SQLite、生成的确定性 owner runner 与 host-inputs JSONL。fixture 计时从初始化到 result 写入，不含最后的 shutdown；shell 进程总耗时另行记录，不把工具等待计入 runner 耗时。

首轮调试曾将 Project API 省略的 `wakePolicy` 字段误写为期望 NULL。已改为 API 字段 undefined、SQLite override NULL 的两个断言，该早期夹具错误不记作产品缺陷。首轮产品失败前通过的 71 条断言也不记作完整绿色验收。

第 2 步补充 resume 竞态时曾直接对 enabled control 调用 resume，领域契约正确拒绝“自动接续已开启”。夹具已改为在旧请求仍在途时先 pause 再 resume。该次夹具错误保留在 `.verify/p6a-lifecycle/step2-initial/`，不记作产品缺陷，也不计入后续连续绿色运行。
