# P6a 门禁加固（第一轮验收 P1/P2 收口）报告

分支：`p6a/gate-hardening`，基线 `3b5bed0`（`integration/p6a`，已含 `sandbox.mjs` 白名单修复），代码头 `d95f37c`；本文随 `docs(p6a): report the gate hardening round` 单独提交。
目标：让门禁更可信。每条改动都做了「改坏 → 门禁红 → 改回 → 门禁绿」的实测，失败信息原文贴在下面。
没有任何既有断言被放宽；需要改动的既有断言逐条列在「断言变化」一节。

## 结论

| 条目                                 | 状态                   | 证据                                                                                                                                                                           |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2-1 落地期第二道闸门 + 数据库触发器 | 已加固                 | 触发器：一次纯 SQL `UPDATE` 关闭路径，7 条断言；落地期：`landingFence()` 断言 `wake_evaluation.state='stale'` 且 `result IS NULL`，在 `p6a-delivery` 与 `p6a-control` 各跑一次 |
| P2-2 「300 秒」单一来源              | 已加固                 | 成功检查后 `next_due_at - now === INTERVAL_MS`；另比对**最新迁移 SQL 里的触发器字面量**与 `INTERVAL_MS`                                                                        |
| P2-3 Worker 门禁在 `--only` 下必红   | 已修                   | `bb-task-live`、`bs-p5b-lifecycle` 的 `preparation` 补为 `worker`；`--only` 实测各 exit 0                                                                                      |
| P2-4 错误码数量约束                  | 已恢复                 | `expect(APP_ERROR_CODES).toHaveLength(34)` + 注释写清来源与「新增码必须同步改这里」                                                                                            |
| P3-1 `policy_changed` 死值           | 已注明为预留值         | `src/contracts/chat-automation.ts` 契约注释                                                                                                                                    |
| P3-3 `p6a-control` 重复断言标签      | 已区分                 | `… preserves the control (terminal run)` / `(other chat)`                                                                                                                      |
| P3-4 `p6a-pages` 调度预算            | 已改，但数值与建议不同 | 125 → 40（不是 15），理由见下                                                                                                                                                  |
| P1-1 自查                            | 已加                   | `validateGateTargets` 校验 `suite-plan` 里 `sandbox: true` 的 id 都在 `lib/sandbox.mjs` 白名单里，并有一条能变红的测试                                                         |

## 提交

| 提交      | 内容                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `40f0c7a` | P2-1 + P2-2 + P3-3：`tests/fixtures/p6a-schedule.ts`、`scripts/verify/p6a-control.sh` |
| `1146372` | P2-3 + P3-4：`scripts/verify/lib/suite-plan.mjs`                                      |
| `f82779b` | P2-4：`tests/lease-contracts.test.ts`                                                 |
| `9073250` | P1-1 自查：`scripts/verify/lib/targets-plan.mjs`、`scripts/verify/targets.test.mjs`   |
| `d95f37c` | P3-1：`src/contracts/chat-automation.ts`                                              |

## 破坏实验表

每一项都在本工作树实测，红/绿是 `bash scripts/verify/<gate>.sh` 或 `runner.mjs --only` 的真实退出码。

| #       | 改了什么                                                                                                                   | 门禁                                          | 结果                    | 失败信息（原文节选）                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1      | `src/domain/continuation-delivery.ts:350` `if (!evaluationCurrent(current))` → `if (false && !evaluationCurrent(current))` | `p6a-delivery`                                | **红** exit 1（改前绿） | `AssertionError [ERR_ASSERTION]: fenced landing marks the evaluation stale without storing the result` … `actual: ['decided', '{"decision":"continue",…}']` / `expected: ['stale', null, null, null, null]` |
| E1      | 同上                                                                                                                       | `p6a-control`                                 | **红** exit 1（改前绿） | 同一条：`fenced landing marks the evaluation stale without storing the result`，`actual` 第一项 `'decided'`，`expected` 第一项 `'stale'`                                                                    |
| E1 回滚 | 恢复 `if (!evaluationCurrent(current))`                                                                                    | `p6a-delivery` / `p6a-control`                | **绿** exit 0 / 0       | `PASS p6a-delivery: 45 assertions`、`PASS p6a-control: 35 assertions`                                                                                                                                       |
| E2      | `drizzle/0027_p6a_automation_off.sql:49` 触发器 `WHEN NEW.mode<>'enabled'` → `WHEN 0`                                      | `p6a-control`                                 | **红** exit 1（改前绿） | `AssertionError [ERR_ASSERTION]: raw SQL off deletes every Chat schedule row`（后续 3 条纯 SQL 断言同理）                                                                                                   |
| E2 回滚 | 恢复 `WHEN NEW.mode<>'enabled'`                                                                                            | `p6a-control`                                 | **绿** exit 0           | `PASS p6a-control: 35 assertions`                                                                                                                                                                           |
| E3      | `CHAT_AUTOMATION_POLICY.intervalSeconds` 300 → 30                                                                          | `p6a-scheduler`                               | **红** exit 1（改前绿） | `AssertionError [ERR_ASSERTION]: newest migration trigger literal in 0027_p6a_automation_off.sql equals INTERVAL_MS` … `actual [300000] expected [30000]`                                                   |
| E3 回滚 | 恢复 300                                                                                                                   | `p6a-scheduler`                               | **绿** exit 0           | `PASS p6a-scheduler: 23 assertions`                                                                                                                                                                         |
| E4      | `suite-plan.mjs` 里 `bb-task-live` 的 `preparation` 去掉（回到基线形状）                                                   | `runner.mjs --only bb-task-live`              | **红** exit 1           | `Prepared-only verification forbids producing server; current-run receipt or outputs do not match`（写在 `$EVIDENCE/build-service.log`，见「仍存疑」）                                                      |
| E4 回滚 | 加回 `worker` preparation                                                                                                  | `runner.mjs --only bb-task-live`              | **绿** exit 0           | `PASS bb-task-live`，`Verification scripts=1 failed=0`，墙钟 27s                                                                                                                                            |
| E4b     | 同一提交下                                                                                                                 | `runner.mjs --only bs-p5b-lifecycle`          | **绿** exit 0           | `PASS bs-p5b-lifecycle`，`Verification scripts=1 failed=0`，墙钟 22s                                                                                                                                        |
| E5      | `src/contracts/result.ts` 往 `APP_ERROR_CODES` 尾部加一个 `fixture_new_code`（模拟「新增码没同步改计数」）                 | `pnpm test tests/lease-contracts.test.ts`     | **红** exit 1           | `AssertionError: expected [ 'task_invalid_transition', …(34) ] to have a length of 34 but got 35`                                                                                                           |
| E5 回滚 | 删掉该码                                                                                                                   | 同上                                          | **绿** exit 0           | `Tests 7 passed (7)`                                                                                                                                                                                        |
| E6      | `scripts/verify/lib/sandbox.mjs` 白名单删掉 `"p6a-pages",`                                                                 | `node --test scripts/verify/targets.test.mjs` | **红** exit 1           | `Error: Suite plan sandboxes p6a-pages but lib/sandbox.mjs does not whitelist it`（6 条测试全红，因为 fixture 先做校验）                                                                                    |
| E6 回滚 | 加回 `"p6a-pages",`                                                                                                        | 同上                                          | **绿** exit 0           | `pass 6 / fail 0`                                                                                                                                                                                           |

## 具体改了什么

### P2-1 落地期第二道闸门与数据库触发器

两条路各自独立可观察：

1. **数据库触发器（纯 SQL 关闭路径，`scripts/verify/p6a-control.sh` inline 段）**
   新增 `rawOff(chatId)`：只执行 `UPDATE chat_automation_control SET mode='off',epoch=epoch+1`，不经过 `automation.applyChatAutomationCommand`。四个 Chat 分别准备：一个 `pending` 投递 + 一条已 `decided` 评估、一个 `pending` 评估、一个 `claimed` 评估、一个 `retry_wait` 评估。断言：
   - `raw SQL off advances the epoch without the domain layer`
   - `raw SQL off deletes every Chat schedule row`
   - `raw SQL off cancels the pending delivery as human_disabled`（`state='canceled'`、`cancel_reason='human_disabled'`、`next_attempt_at IS NULL`）
   - `raw SQL off cancels a pending evaluation and clears its claim fields`（`pending` → `canceled`，claim/lease/retry 全清）
   - `raw SQL off stales a claimed evaluation and clears its claim fields`（`claimed` → `stale`）
   - `raw SQL off stales a retry_wait evaluation and clears its retry time`（`retry_wait` → `stale`）
   - `raw SQL off leaves a decided evaluation and its result alone`（`decided` + `result` + `evaluated_at` 原样）

   `pending` 评估在触发器里是 → `canceled`、`claimed`/`retry_wait` → `stale`，与验收描述一致。

2. **落地期第二道闸门（`landingFence()`，`tests/fixtures/p6a-schedule.ts`）**
   基线里 `p6a-control` 的两处落地期断言只能看到「没有生成 delivery」：关闭走领域层时 `p6a_control_disabled` 触发器已经把 `claimed` 行改成 `stale`，`commitEvaluationResult` 早在 `state !== 'claimed'` 就返回，第二道 `evaluationCurrent` 闸门根本没被执行到；而 `createContinuationDelivery` 自身还有一次 `evaluationCurrent` 复核，会把被改坏的第二道闸门掩盖掉。

   所以新增的 `landingFence()` 只改**持久化的 Project 策略事实**（`UPDATE project SET wake_policy=…`，纯 SQL，不经 `updateProjectWakePolicy` 的 reconciler）：没有任何触发器或 reconciler 会碰 `wake_evaluation` 行，此时第二道闸门是唯一能封住迟到结果的写入者。断言读评估行本身：
   - `a policy fact change alone leaves the evaluation claimed for the landing gate`
   - `landing gate rejects a late result whose facts moved after the snapshot`
   - `fenced landing marks the evaluation stale without storing the result`（`state='stale'`、`result=null`、`claim_token/lease_until/next_attempt_at` 全 null）
   - `a fenced landing writes no continuation delivery`

   该 helper 在 `delivery` 与 `control` 两个 suite 末尾各调用一次，因此 `p6a-delivery` 与 `p6a-control` 都能单独抓住 E1。Project 策略在 `finally` 里恢复原值。

   既有两处落地期调用点（`p6a-control` inline 的 `commitEvaluationResult` 与 `disable during external provider request fences the late result`）没有放宽，仍保留；但要注意它们在「领域层关闭」场景下**不可能**区分第二道闸门（触发器先行 stale），所以判别力来自 `landingFence()`。这一点写进「仍存疑」。

### P2-2 「300 秒」单一来源

`p6a-scheduler` 新增：

- `a successful check re-arms exactly one policy interval from now`：一次成功评估后 `row.next_due_at - now === INTERVAL_MS`（读 `chat-schedule` 导出的常量，而不是字面量）。
- `migrations write the schedule interval as an explicit literal` + `newest migration trigger literal in <file> equals INTERVAL_MS`：用 `readdirSync("drizzle")` 排序后，取**最新**一个含 `NEW.updated_at+<digits>` 的迁移文件，把里面的字面量集合与 `INTERVAL_MS` 比对。取「最新」而不是「全部」，是因为历史迁移不该在常量演进时被改写；最新定义才是真正生效的触发器。

基线的 `equal(due, now.getTime() + 300000, "first check waits 300 seconds")` 未改动：它钉的是触发器写入值，现在是「触发器字面量 == INTERVAL_MS」这一条的互补证据。

### P2-3 Worker 门禁在 `--only` 下

`suite-plan.mjs`：

```diff
-  "bs-p5b-lifecycle": plan(36, { unit: 1, native: 1, process: 1 }),
-  "bb-task-live": plan(30, { native: 1, sdk: 1, timing: 1 }),
+  "bs-p5b-lifecycle": plan(36, { unit: 1, native: 1, process: 1 }, worker),
+  "bb-task-live": plan(30, { native: 1, sdk: 1, timing: 1 }, worker),
```

`worker = ["install", "server", "worker"]`，与两个 gate 自己做的 `prepare.mjs install/server` + `ensure-worker-artifact`（`prepare.mjs worker`）一一对应。`--only` 实测见 E4 表。

### P2-4 错误码表数量

```diff
-    // 码表数量不写死：每阶段都会加码（…）。
-    // 要守的是「无重复」以及下面那条「与 APP_ERROR_CODES 逐项一致」。
+    // 码表数量写死：新增码必须同步改这里，并写明属于哪个阶段（…）。
+    // 同时守「无重复」与「与 APP_ERROR_CODES 逐项一致」。
+    expect(humanContracts.APP_ERROR_CODES).toHaveLength(34);
     expect(new Set(REMOTE_ERROR_CODES).size).toBe(REMOTE_ERROR_CODES.length);
     expect([...REMOTE_ERROR_CODES]).toEqual([...humanContracts.APP_ERROR_CODES]);
```

`34` 的来源：`src/contracts/result.ts` 的 `APP_ERROR_CODES` 当前 34 项（base 12 + lease/member/machine 12 + execution 6 + `channel_membership_managed` + P6a 三码）。集合相等与无重复两条保留。

### P3-1 `policy_changed`

选择「注明预留」而不是接上新行为（改动面小、不影响行为）：

```ts
  "chat_archived",
  // 预留值：当前代码不写它。改 Project 判定器策略时，未 admit 的投递实际由
  // task_context_changed / 数据库触发器处理；将来真把它接上时必须同时补门禁。
  "policy_changed",
```

本 baseline 里还没有 P6a 收尾文档（`docs/` 下只有 `p0`…`p5b`/`ui`），所以没法在「已知限制」里加条目；这条注释就是留给收尾文档引用的一行。见「仍存疑」。

### P3-3 重复标签

```diff
-  for (const invalid of [run, queued(group().id, profiles[0])]) {
+  for (const [label, invalid] of [
+    ["terminal run", run],
+    ["other chat", queued(group().id, profiles[0])],
+  ]) {
-    prove("terminal/other-Chat run rejection preserves the control", …)
+    prove(`terminal/other-Chat run rejection preserves the control (${label})`, …)
```

### P3-4 `p6a-pages` 调度预算

`125` → **`40`**（不是验收建议的 15）。实测三种口径：

| 口径                                                                     | 实测                               |
| ------------------------------------------------------------------------ | ---------------------------------- |
| `bash scripts/verify/p6a-pages.sh`（共享树直跑，即验收所说的「4s」量级） | 5s                                 |
| 沙箱内单跑（`runner.mjs --only p6a-pages`，含 sandbox 复制整棵树）       | 12.8s（墙钟 17s，含 install 准备） |
| 11 个门禁并发批次里                                                      | 16.9–17.0s                         |

`suite-plan` 的其它行（`a-base` 54.969、`as-p5b-task-pages` 30 对应实测 28s）都是「沙箱内墙钟」量级，`p6a-pages` 的对应量是 ~13s；按「3–4 倍余量」给 40（≈3×13）。15 只比沙箱内实测大 1.2 倍、比并发实测还小，等于把预算又写成一个不能信的数。`estimatedMs` 目前只用于批次排序（`runner.mjs:390`），不是超时。

### P1-1 自查

`scripts/verify/lib/targets-plan.mjs`：

- 新增 `sandboxGates(root)`：把 `scripts/verify/lib/sandbox.mjs` 的 `const gates = new Set([...])` 当**文本**读出来（两份清单分属不同模块、职责不同，靠文本交叉校验才可能发现漂移）。
- `validateGateTargets(root)` 在原有的「门禁清单 / A-B 双目标」校验之后，比较 `SUITE_PLAN` 里 `sandbox: true` 的 id 是否都在白名单里；缺一个就抛 `Suite plan sandboxes <ids> but lib/sandbox.mjs does not whitelist it`，发生在任何命令 spawn 之前。

`scripts/verify/targets.test.mjs`：fixture 里拷入 `lib/sandbox.mjs`，新测试删掉 `"p6a-pages",` 这一行后断言 `validateGateTargets(directory)` 抛错、且 `targets.mjs ci --group docs` 以 exit 1 结束并**没有**创建 `.verify/`（即「跑之前就红」）。

## 断言变化（旧 → 新）

没有删除或放宽任何断言；以下是计数与逐条变化。

| 门禁                                                         | 基线断言数 | 现在               | 说明                               |
| ------------------------------------------------------------ | ---------- | ------------------ | ---------------------------------- |
| `p6a-control`（`p6a-schedule.ts control` 的 PASS 行）        | 31         | 35                 | +4：`landingFence()`               |
| `p6a-control` inline 控制模型（`control-model-result.json`） | 11         | 18                 | +7：纯 SQL 关闭路径                |
| `p6a-delivery`                                               | 41         | 45                 | +4：`landingFence()`               |
| `p6a-scheduler`                                              | 20         | 23                 | +3：间隔、迁移字面量、字面量存在性 |
| `tests/lease-contracts.test.ts`                              | 无数量断言 | `toHaveLength(34)` | 仅新增                             |
| `p6a-pages` 预算                                             | 125s       | 40s                | 调度估计，非断言                   |

逐条改动（旧值 → 新值）：

1. `scripts/verify/p6a-control.sh`：`"terminal/other-Chat run rejection preserves the control"`（两条同名）→ `… (terminal run)` / `… (other chat)`。语义不变，只是可区分。
2. `tests/lease-contracts.test.ts`：注释「码表数量不写死」→「数量写死：新增码必须同步改这里」，并新增 `toHaveLength(34)`。旧集合相等、无重复两条原样保留。
3. `scripts/verify/lib/suite-plan.mjs`：两条 gate 的 `preparation`（`[]` → `["install","server","worker"]`）；`p6a-pages` 的秒数 125 → 40。
4. `tests/fixtures/p6a-schedule.ts`：只新增断言与 `landingFence()`；原有的 `now+300000`、`30000`/`120000` backoff 断言未动。
5. `scripts/verify/lib/targets-plan.mjs` / `targets.test.mjs`：只新增校验与一条新测试。

## 跑过的命令与退出码

全部在本工作树执行。`pnpm install --prefer-offline` 5.2s（真实安装，未软链主 checkout）；`.env` 从 `/Users/snake/workspace/sprout-mio/.env` 复制。地址与 DB 都在 `.verify/` 下。

### 最终验证（commit `d95f37c`）

一条 `runner.mjs` 调用覆盖 11 个门禁（含 sandbox 副本与三条 prepare）：

```
node scripts/verify/runner.mjs --only \
  p6a-control,p6a-delivery,p6a-scheduler,p6a-integration,bf-p6a-lifecycle,p6a-pages,\
as-p5b-task-pages,i2-group-chat,i3-public-channel,bb-task-live,bs-p5b-lifecycle
```

| 门禁 / 命令         | 退出码 | 用时（gate 自报）                                                                                                          |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| prepare-install     | 0      | 4034ms                                                                                                                     |
| prepare-server      | 0      | 4590ms                                                                                                                     |
| prepare-worker      | 0      | 765ms                                                                                                                      |
| `p6a-control`       | 0      | 2747ms（35 assertions）                                                                                                    |
| `p6a-delivery`      | 0      | 1968ms（45 assertions）                                                                                                    |
| `p6a-scheduler`     | 0      | 1755ms（23 assertions）                                                                                                    |
| `p6a-integration`   | 0      | 1867ms                                                                                                                     |
| `bf-p6a-lifecycle`  | 0      | 7450ms                                                                                                                     |
| `p6a-pages`         | 0      | 16899ms（125 个断言组，3 视口）                                                                                            |
| `as-p5b-task-pages` | 0      | 29906ms                                                                                                                    |
| `i2-group-chat`     | 0      | 855ms                                                                                                                      |
| `i3-public-channel` | 0      | 2524ms                                                                                                                     |
| `bb-task-live`      | 0      | 18729ms                                                                                                                    |
| `bs-p5b-lifecycle`  | 0      | 18753ms                                                                                                                    |
| **批次整体**        | **0**  | `Verification scripts=11 failed=0`，总 39.3s，墙钟 40s，report `.verify/runs/2026-10-31T07-18-50-023Z-53178-0/report.json` |
| `bf-p6b-info`       | —      | 该 baseline 不存在（`scripts/verify/` 里只有 `bf-p6a-lifecycle.sh`），跳过                                                 |

### 单 gate / 其它

| 命令                                                     | 退出码 | 备注                              |
| -------------------------------------------------------- | ------ | --------------------------------- |
| `node scripts/verify/runner.mjs --only bb-task-live`     | 0      | 27s 墙钟（P2-3 回滚后）           |
| `node scripts/verify/runner.mjs --only bs-p5b-lifecycle` | 0      | 22s 墙钟                          |
| `node scripts/verify/runner.mjs --only p6a-pages`        | 0      | 17s 墙钟 / gate 12.8s             |
| `bash scripts/verify/p6a-pages.sh`（直跑对比）           | 0      | 5s                                |
| `pnpm typecheck`（3 个 tsconfig 项目）                   | 0      | 0 处错误                          |
| `node --test scripts/verify/targets.test.mjs`            | 0      | `pass 6 / fail 0`                 |
| `pnpm test tests/lease-contracts.test.ts`                | 0      | 7 passed                          |
| `pnpm exec vp fmt`                                       | 0      | 558 文件；只提交本任务的 7 个文件 |
| `pnpm exec vp lint`                                      | 0      | 只有既有 warning，改动文件无新增  |

`pnpm exec vp fmt` 会顺带改 `src/domain/wake-providers/jev.ts` 与 `tests/task-info-hub.test.ts`（baseline 自带的两处与格式化器版本漂移）。它们与本任务无关，已 `git checkout` 还原，未进提交。

## 仍存疑

1. **P3-1 无法落到「已知限制」章节**：本 baseline 没有 P6a 收尾文档（`docs/` 只到 `p5b`），所以只在契约枚举上写了预留值注释。P6a 收尾时需要把这一条抄进已知限制；如果那时选择接上行为，注释里也写明了必须同时补门禁。
2. **其它 P6a 触发器仍无「纯 SQL」覆盖**：这次只给 `p6a_control_disabled` 补了不经过领域层的路径。`p6a_task_insert` / `p6a_task_update` / `p6a_task_delete` / `p6a_chat_changed` 依然只被领域层写入间接触发；同 P2-1 的风险类别（触发器写坏、领域层另有一次复核把它盖住）对它们仍然存在。
3. **`p6a-control` 里的两处既有落地期断言没有判别力**：走领域层关闭时触发器先把 `claimed` 改成 `stale`，`commitEvaluationResult` 在 `state !== 'claimed'` 就返回，第二道 `evaluationCurrent` 闸门不会被执行。它们保留是因为仍声明了「不产生投递」这一事实，真正的判别力在 `landingFence()`。若以后有人把触发器改成不写 `wake_evaluation`，这两处会重新变得有意义。
4. **`--only` 红的可读性**：`bb-task-live` / `bs-p5b-lifecycle` 把 `prepare.mjs` 的输出重定向到 `$EVIDENCE/build-service.log`，所以 runner 的 tail 里只看得到 `EVIDENCE … (exit 1)`，那句 `Prepared-only verification forbids …` 在证据目录里。P2-3 的红绿判定不受影响，但排查成本高。未在本任务范围内改（会动两个 live gate 的输出约定）。
5. **迁移字面量校验只认最新定义**：如果未来的新迁移只在旧的触发器上追加而不重写间隔，校验会把旧字面量当成「生效值」；反过来，若真的缩短间隔，新迁移必须重写触发器，校验会正确要求字面量跟 `INTERVAL_MS` 一致。这是有意选择的边界。
6. **`p6a-pages` 预算 40 ≠ 建议 15**：口径差异见 P3-4 一节。若协调者坚持 15，改一行即可，但它在沙箱内（12.8s）就只剩 1.2 倍余量。
7. **P6a 里 `wake_evaluation` 的 `pending → canceled` 与领域层 `reconcileChatSchedule` 的 `pending → stale` 不一致**：这次把两者都断言成现状（触发器 `canceled`、领域 reconcile `stale`），没有裁决哪个才对。这是产品语义问题，不是门禁问题。
