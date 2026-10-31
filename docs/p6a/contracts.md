# P6a 契约：自动接续、唤醒判定与人类控制

本文记录 I-P6a 在 `integration/p6a` 上冻结的共享契约与数据库形态，供 P6b/P6c 及后续章节引用。基线代码头 `bde6383`（`bde6383` 为第二轮独立技术验收的受验提交 `303fbf5` 之后唯一新增的文档提交）。

标注约定：**实测**＝本轮亲自执行并核对过输出；**引用**＝读源码、迁移或既有报告得出，未重复执行；**未验证**＝已知但未在本轮取证的推断。

## 冻结了什么

| 契约文件                                        | 冻结内容                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `src/contracts/wake-evaluation.ts`              | 判定输入快照、判定结果、11 个错误码、输入绑定的结果校验                    |
| `src/contracts/chat-automation.ts`              | 自动接续策略常量、能力表、控制命令、投递与读视图、取消原因                 |
| `src/contracts/chat-automation-capabilities.ts` | 8 个 `chat.automation.*` / `project.wake_policy.*` 动作的 Human/Agent 级别 |
| `src/contracts/project-wake-policy.ts`          | Project 判定器配置，与未配置时的读时默认                                   |
| `drizzle/0026_p6a_continuation.sql`             | 9 张新表、`project.wake_policy` 列、5 个触发器                             |
| `drizzle/0027_p6a_automation_off.sql`           | 控制表两态重建、取消原因改名、3 个触发器重建                               |

没有冻结：页面形状（由 Human 选定的方案 A 与后续评审决定）、模型提示词文本（可改，改后需重跑 `p6a-live-routing`）、阈值数值（`thresholdVersion` 只标识版本，不承诺版本内的数值）。

## 唤醒判定契约 `src/contracts/wake-evaluation.ts`

### 快照边界

判定输入是一个**自包含、只读、有预算**的快照，判定器不读库、不查历史、不发起新的读取。依据：`wakeEvaluationInputSchema` 的字段集合与 `.readonly()` 标注。

- 预算常量 `WAKE_CONTEXT_LIMITS`：`recentMessages` 20 条、单条 `messageCharacters` 2000、最近消息合计 `recentMessageCharacters` 12000、候选 `personaCharacters` 600、职责与外部工作摘要各 600、Task 摘要 `taskCharacters` 1000、整个快照 `snapshotCharacters` 24000 字符（按 `Array.from` 码点数计）。来源：`src/contracts/wake-evaluation.ts` 的 `WAKE_CONTEXT_LIMITS` 与 `characters()`。**引用**
- 完整性不可截断：`truncation.tasksComplete` 与 `truncation.candidatesComplete` 是 `z.literal(true)`，Task 与候选永远全量，只有最近消息可截断；截断必须同时给出 `droppedMessageIdRange`，且 `originalMessageCount > includedMessageCount` 与 `droppedMessageIdRange !== null` 必须同真同假。**引用**
- 字符预算必须自洽：`recentMessages` 实际码点合计必须等于 `truncation.recentMessageCharacters`，`includedMessageCount` 必须等于消息条数，整个 JSON 序列化后的码点数不得超过 24000。**引用**
- 结构自洽：消息按 `createdAt` 非降序、消息 id 与候选 `kind:id` 不重复、Task 必须属于本 Chat、外部工作（lease/execution）必须属于本 Project。**引用**
- 来源决定形状：`source === "message"` 时必须有独立 `triggerMessage` 且 `triggerId` 等于它的 id；`source === "task_periodic"` 时必须没有触发消息、`tasks` 非空。周期判定在 Group/Channel 上候选只能是对当前 owner，在 DM 上候选只能是其唯一 Agent 分身。**引用**
- 身份约束写进候选：Human 候选不得有 `instanceId`、`activeRun`、`latestRun`；Agent 候选必须有 `instanceId`；`activeRun` 只能是 `queued`/`running`，`latestRun` 必须是终态。**引用**
- 快照身份由 `snapshotHash`（`^[0-9a-f]{64}$`）承载，判定结果回写同一个哈希，`evaluation` 与 `delivery` 用它判断结果是否仍对应当前事实。**引用**

边界含义：判定器看到的就是契约允许它看到的一切；任何需要额外读取才能判断的场景，都必须在组装快照时决定，不在判定时补救。**引用**

### 结果形状

`wakeEvaluationResultSchema` 是严格对象，字段为 `decision`、`reason`、`reasonCode`、`recipients[]`、`selectedRecipients[]`、`probability`、`provider`、`model?`、`version`、`snapshotHash`、`errorCode`。**引用**

- `decision` 三值：`continue` / `do_not_continue` / `indeterminate`。
- `recipients[]` 逐候选给出 `decision: "yes" | "no" | "unknown"`、必填 `reason` 与可空 `probability`。
- `selectedRecipients[]` 必须**恰好**是所有 `yes`：不允许选了不写、写了不选。
- `decision` 由内容推导而非自报：有选中即 `continue`；无选中但有 `unknown` 或 `errorCode` 非空即 `indeterminate`；否则 `do_not_continue`。**引用**
- 一人一份：`recipients` 与 `selectedRecipients` 的 `kind:id` 都不得重复。

### 11 个错误码

`wakeEvaluationErrorCodeSchema` 的取值与含义（来源：同文件枚举；使用位置见 `src/domain/wake-evaluation.ts`、`src/domain/continuation-delivery.ts`）。**引用**

| 错误码                      | 含义                 | 典型来源                                 |
| --------------------------- | -------------------- | ---------------------------------------- |
| `provider_timeout`          | 判定器超时           | 适配器超时或 `TimeoutError`/`AbortError` |
| `provider_unavailable`      | 判定器不可用         | 缺凭据、模型不支持、服务拒绝             |
| `provider_auth_failed`      | 判定器认证失败       | 凭据被服务端拒绝                         |
| `provider_invalid_response` | 返回不合约           | Zod 校验失败或 JSON 解析失败             |
| `provider_low_certainty`    | 合法但不低确定的判定 | 适配器给出 `low` 确定度                  |
| `context_budget_exceeded`   | 快照超预算           | 组装时超 24000 字符                      |
| `context_stale`             | 快照已过期           | 落地时事实已变                           |
| `delivery_unavailable`      | 无可投递对象         | 候选或 owner 已不可用                    |
| `delivery_unknown`          | 投递结果未知         | ACK 不明，需人工补发                     |
| `run_repeated_failure`      | 同一 run 反复失败    | 达到 `repeatedRunFailureLimit`           |
| `internal_failure`          | Sprout 自身失败      | 非上述原因                               |

`provider_low_certainty` 是**合法结果**而非失败：它参与准确率测量，不阻断投递判定流程，也不触发自动降级。**引用**（判据见 [live 判据与实测](../../orchestrate/sprout-mio-p6/reports/p6a-live-policy.md#判据)）

### `wakeEvaluationResultForInputSchema` 的绑定语义

`wakeEvaluationResultForInputSchema(input)` 不复制快照，而是把**输入**作为校验上下文，返回一个在原结果 schema 之上追加三条规则的 schema。**引用**

1. `snapshotHash` 必须等于输入的 `snapshotHash`；`provider` 必须等于 `input.policy.provider`；当 `input.policy.model` 存在时 `model` 必须与之相等。当策略未命名模型（见下节）时不比对 `model`，因为此时宿主默认模型由宿主决定。
2. `recipients` 中不得出现候选集之外的接收者——判定器不能凭空发明接收者。
3. 当 `errorCode` 为 `null`（成功判定）时，`recipients` 必须**覆盖全部候选**；失败判定（`errorCode` 非空）则允许只返回部分候选。

这三条把「结果对不对得上这次判定」变成可在适配器边界执行的结构检查，而不是靠调用方自觉。因此「同一份快照、同一个 provider/model、同一组候选」是结果可接受的最小条件，**也是唯一条件**——契约不校验理由文本、概率数值或决定本身是否「判断正确」，正确性由门禁与人工复核处理。**引用**

### `thresholdVersion` 与 `model` 的可缺省性

先纠正一处常见误读：在这份契约里 **`thresholdVersion` 不是可空字段**，`model` 也不是可空（`null`）字段，二者分别有各自的缺省方式。

- `model: z.string().trim().min(1).max(200).optional()`：字段**可以整个缺省**，缺省的含义在注释里写明「Omitted model uses the host default model」。原因：新 Project 首次自动接续发生在 Human 配置判定器之前，此时没有可信的模型 id，而 P6a 不允许凭空写一个。缺省不是「不知道」，是「交给宿主默认」。**引用**
- 判定结果里的 `model: identifier.optional()` 同理，注释为「Provider resolution can fail before a host default model is known」：失败收据可能根本走不到解析模型那一步，此时不得伪造模型 id。**引用**
- `thresholdVersion: z.string().trim().min(1).max(80)` 是**必填**：它标识判定所用阈值集合的版本，`version` 字段就是它的值（`decidedWakeResult` 写 `version: input.policy.thresholdVersion`），JEV 适配器还要求调用侧阈值版本与策略版本严格相等。必填的原因是可追溯：任何一条判定都必须能回答「用哪版本阈值算的」，所以不给默认、不给 null。**引用**
- 真正「可空」的是**存储层**：`project.wake_policy` 列允许 `NULL`，`NULL` 在读时合成默认策略（见下节），不是契约字段可空。**引用**

## Chat 自动接续契约 `src/contracts/chat-automation.ts`

### `CHAT_AUTOMATION_POLICY` 每个取值与理由

```ts
export const CHAT_AUTOMATION_POLICY = {
  version: 1,
  intervalSeconds: 300,
  retryDelaySeconds: [30, 120],
  maxAttempts: 3,
  repeatedRunFailureLimit: 3,
} as const;
```

| 取值                           | 理由                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version: 1`                   | 策略整体版本。改动任一取值的语义时递增，让历史判定能对上是哪一代策略。                                                                             |
| `intervalSeconds: 300`         | 有 assigned Task 的 Chat 每 5 分钟检查一次。够快让协作不中断，又不至于每次消息都付一次模型钱；也是「每秒检查」和「每分钟检查」之间的成本折中。     |
| `retryDelaySeconds: [30, 120]` | 失败后退避两档：先 30 秒再 120 秒。第一档贴近间隔本身，避免瞬时故障白等一整轮；第二档把连续失败压到 2 分钟内最多一次，避免对故障判定器做密集重试。 |
| `maxAttempts: 3`               | 一份判定最多尝试 3 次（首次 + 两次退避重试）。`wake_evaluation.attempt` 的 CHECK 与投递视图的 `attempt` 上界都用它，超界即不可能被写入或展示。     |
| `repeatedRunFailureLimit: 3`   | 同一 run 连续失败 3 次判为 `run_repeated_failure` 并停止自动重投。让失败可自愈，但不无限循环。                                                     |

依据：`CHAT_AUTOMATION_POLICY` 常量与 `wake_evaluation_attempt_check`、`chatAutomationEvaluationViewSchema.attempt` 的上界引用。理由部分为本轮按取值与相邻约束归纳，**引用**。“300 秒”存在两处来源（TS 常量与 SQL 字面量），现在靠 `p6a-scheduler` 门禁钉住相等，不是物理单一来源，见 [已知限制](summary.md#p3-6-300-秒两处来源)。

### `CHAT_AUTOMATION_CAPABILITIES`

8 个动作分两级。级别只描述**第一道授权闸**，不是充分授权。依据：`src/contracts/chat-automation-capabilities.ts`。**引用**

| 动作                         | Human 级别 | Agent 级别 | 补充约束                                       |
| ---------------------------- | ---------- | ---------- | ---------------------------------------------- |
| `project.wake_policy.read`   | `project`  | `project`  | 读到的是 Project 可见范围内的当前策略          |
| `project.wake_policy.update` | `human`    | `never`    | 还要求 Project 创建者                          |
| `chat.automation.read`       | `member`   | `member`   | 需当前 Human Chat 资格                         |
| `chat.automation.disable`    | `member`   | `never`    | `applyChatAutomationCommand` 直接拒绝 Agent    |
| `chat.automation.enable`     | `member`   | `never`    | 同上                                           |
| `chat.automation.abort`      | `member`   | `never`    | 同上                                           |
| `chat.automation.retry`      | `member`   | `never`    | 还校验同一 Chat subject 与当前仍有可重试的判定 |
| `chat.automation.reissue`    | `member`   | `never`    | 还要求存在可核对的 `delivery_unknown`          |

Scheduler 的 evaluate / enqueue / admit 是内部入口，**不是**公开能力，不出现在这张表里。

### 控制命令、`mode`、`epoch` 与 `revision`

`chatAutomationCommandSchema` 是 `action` 上的判别联合，5 个动作共享 `projectId`、`chatId`、`expectedRevision`、`requestId`；`disable`/`enable`/`abort` 可带 `reason`，`abort` 可带 `runId`，`retry` 带 `evaluationId`，`reissue` 带 `deliveryId` 且 `confirmedUnknown` 必须是 `true`。**引用**

`mode` 只有两态：`enabled` / `off`。**引用**（`chatAutomationModeSchema`，以及 `automation_mode_check`）

三个**改 mode** 的动作，语义差异是这份契约最容易误读的地方：

| 动作                  | 写 `mode` | 递增 `epoch` | 中止当前轮次                                    | 清 schedule    |
| --------------------- | --------- | ------------ | ----------------------------------------------- | -------------- |
| `enable`              | `enabled` | 是           | 否                                              | 否（重新排期） |
| `disable`             | `off`     | 是           | **否**                                          | 是             |
| `abort`（无 `runId`） | `off`     | 是           | **是**：中止本 Chat 全部 `queued`/`running` run | 是             |
| `abort`（带 `runId`） | 不变      | **否**       | 是：只中止该 run                                | 否             |

`disable` 只关掉「以后还会不会来」：留在途 run 继续跑完，但不再安排新的自动接续。`abort` 才叫停当前工作。依据：`applyChatAutomationCommand` 中只有 `abort` 会调用 `persistAutomationRunStop` 与 `transitionAgentRun(id, "aborted")`；`abort` 带 `runId` 时走 `revision=revision+1` 分支，明确注释「Stopping one run must leave the Chat's continuation switch and epoch intact」。**引用**

`epoch` 是**控制代际**，不是版本号：

- 每次 mode 变更 `epoch+1`（`abort` 带 `runId` 除外），`revision` 也 `+1`。
- 判定快照带 `controlEpoch`，落地时（`landingFence()`）比对 epoch：不一致的在途结果一律落 `stale`、`result` 保持 `NULL`。这是第二道闸，第一道是触发器。
- `revision` 是乐观并发令牌：命令带 `expectedRevision`，与当前不符即 `conflict`（“自动接续版本已变化，请刷新后重试”）。
- 审计：`changed_by` 与 `changed_at` 必须同时为空或同时非空（`automation_audit_check`）。

### 取消原因枚举

`continuationCancelReasonSchema` 的 6 个取值，与 `state === "canceled"` 严格同真同假（`continuation_cancel_check`）。**引用**

| 取值                   | 写入者                                  |
| ---------------------- | --------------------------------------- |
| `human_disabled`       | Human `disable`（触发器与领域层）       |
| `human_aborted`        | Human `abort` 未 admit 的投递           |
| `membership_revoked`   | 撤权                                    |
| `task_context_changed` | Task 改派/改状态、Chat owner 或策略变更 |
| `chat_archived`        | Chat 归档                               |
| `policy_changed`       | **预留值，当前代码不写它**              |

`policy_changed` 的预留是明确决定，注释写在枚举里：改 Project 判定器策略时，未 admit 的投递实际由 `task_context_changed` 与数据库触发器处理；将来真要接上必须同时补门禁。来源：`src/contracts/chat-automation.ts` 枚举注释，与 `docs(contracts): mark policy_changed as a reserved cancel reason`（`d95f37c`）。**引用**

## Project 判定器配置 `src/contracts/project-wake-policy.ts`

`projectWakePolicySchema` 是**独立**的严格对象，不依赖 Chat、Task 或 run 的 schema：`provider`（`small_brain` | `jev`）、`configRevision`（正整数）、`model?`、`thresholdVersion`。**引用**

`DEFAULT_PROJECT_WAKE_POLICY` 是冻结字面量：

```ts
{ provider: "small_brain", configRevision: 1, thresholdVersion: "p6a-design-default-v1" }
```

关键点是它**读时合成、不写库**：

- `continuation-delivery.ts` 与 `chat-schedule.ts` 都写成 `rawPolicy === null ? DEFAULT_PROJECT_WAKE_POLICY : JSON.parse(rawPolicy)`（`src/domain/continuation-delivery.ts:80`、`src/domain/chat-schedule.ts:226` 附近）。**引用**
- 因此 `project.wake_policy IS NULL` 是合法且**持久**的状态，表示「Human 从未配置过」，而不是「漏写」，也不需要回填迁移。
- 默认没有 `model`，落到宿主默认模型；这与上节 `model` 可缺省的原因同源。
- 合成值参与 `snapshotHash` 计算，所以改默认策略等于改快照哈希，历史判定会自然失效，不需要额外的版本比对逻辑。**未验证**（推断自哈希覆盖 `policy` 字段，未构造对照实验）
- 配置写入路径要求环境提供模型与阈值版本，缺任一即 `wake_provider_unavailable`（“所选判定器尚未配置模型与阈值版本。”）。依据：`src/server/functions/project.ts` 的 `updateProjectWakePolicyBoundary`。**引用**

## 迁移 `0026_p6a_continuation.sql`：9 张表与 5 个触发器

9 张新表（依据 `CREATE TABLE` 语句顺序）。**引用**

| 表                            | 作用                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `chat_automation_control`     | 每 Chat 的控制态：`mode`、`epoch`、`revision`、审计字段                                                             |
| `chat_schedule`               | 每 Chat 一条排期：`next_due_at`、`round`、`fingerprint`                                                             |
| `wake_evaluation`             | 一次周期性判定的全部事实：来源、轮次、`control_epoch`、状态、claim、`input`、`result`、`error_code`                 |
| `wake_evaluation_task`        | 判定时的 assigned Task 快照（`evaluation_id` + `task_id` + 两个 revision）                                          |
| `continuation_delivery`       | 一份自动接续投递：接收者、状态、尝试次数、admit/deliver/present 时间、取消原因、未知投递的 `supersedes_delivery_id` |
| `continuation_delivery_task`  | 投递与 Task 的关联                                                                                                  |
| `chat_automation_command`     | 控制命令幂等表：`request_id` → `payload` + `result`                                                                 |
| `chat_automation_abort`       | 停止意图（在宿主 abort 之前提交）：`run_id`、`requested_at`、`signaled_at`                                          |
| `project_wake_policy_command` | 策略写入幂等表                                                                                                      |

同一迁移还给 `project` 加 `wake_policy text` 列，并建 5 个触发器：`p6a_task_insert`、`p6a_task_update`、`p6a_task_delete`、`p6a_control_disabled`、`p6a_chat_changed`。**引用**

`0026` 的 `chat_automation_control` 是**三态** `('enabled','paused','stopped')`，`p6a_control_disabled` 用 `CASE NEW.mode WHEN 'paused' THEN 'human_paused' ELSE 'human_stopped' END` 写取消原因。**引用**

## 迁移 `0027_p6a_automation_off.sql`：两态控制表

`0027` 做三件事，顺序不可调换。**引用**

1. `PRAGMA foreign_keys=OFF`，显式 `DROP TRIGGER p6a_task_insert` / `p6a_task_update` / `p6a_control_disabled`。
2. 重建控制表：`CREATE TABLE __new_chat_automation_control`（`CHECK mode in ('enabled','off')`）→ `INSERT ... SELECT` 把 `paused`/`stopped` 折成 `off`（`CASE WHEN mode='enabled' THEN 'enabled' ELSE 'off' END`），`epoch`/`revision`/审计字段原样保留 → `DROP TABLE` → `ALTER TABLE ... RENAME TO`。
3. 改写历史取消原因（`human_paused` → `human_disabled`、`human_stopped` → `human_aborted`），再重建三个触发器，恢复 `PRAGMA foreign_keys=ON`。

`p6a_task_delete` 与 `p6a_chat_changed` 不 drop、不重建，因为它们的 body 不涉及三态取值。

### 为什么先 drop 再重建触发器

- `p6a_control_disabled` 定义在 `chat_automation_control` 上，`DROP TABLE` 会连带删除它，所以**必须**重建；这一点没有选择余地。
- SQLite 的 `ALTER TABLE ... RENAME TO`（3.25 起默认 `legacy_alter_table=OFF`）会改写其他 schema 对象里对被改名表的引用，因此定义在**别的表**上的触发器（`p6a_task_insert` / `p6a_task_update`）即使不被 drop，body 也能继续指向重建后的控制表。**实测**：本机 `sqlite3` 3.54.0 复现「建表 + 三个触发器 → `__new_` 重建 → `DROP` → `RENAME`」，不加任何 `DROP TRIGGER` 时，定义在 `task` 上的两个触发器 body 原样保留（仍指向 `c`）且继续可用，定义在控制表上的那个随表消失，新表 CHECK 生效（写入 `mode='paused'` 被 `CHECK constraint failed` 拒绝）。复现脚本（不改仓库，只在 `/tmp` 下跑）：

```bash
cd /tmp && rm -f trig.db && sqlite3 trig.db <<'SQL'
CREATE TABLE task(id text primary key, chat_id text, e int);
CREATE TABLE c(chat_id text primary key, mode text NOT NULL, e int,
  CONSTRAINT chk CHECK(mode in ('enabled','paused','stopped')));
CREATE TRIGGER t_ins AFTER INSERT ON task BEGIN
  INSERT OR IGNORE INTO c(chat_id,mode,e) VALUES(NEW.chat_id,'enabled',0);
END;
CREATE TRIGGER c_off AFTER UPDATE OF mode ON c WHEN NEW.mode<>'enabled' BEGIN
  UPDATE task SET e=0 WHERE chat_id=NEW.chat_id;
END;
INSERT INTO task VALUES('t1','c1',1);
PRAGMA foreign_keys=OFF;
CREATE TABLE __new_c(chat_id text PRIMARY KEY NOT NULL, mode text DEFAULT 'enabled' NOT NULL,
  e integer DEFAULT 1 NOT NULL, CONSTRAINT chk CHECK(mode in ('enabled','off')));
INSERT INTO __new_c(chat_id,mode,e) SELECT chat_id,'off',e FROM c;
DROP TABLE c;
ALTER TABLE __new_c RENAME TO c;
PRAGMA foreign_keys=ON;
SELECT 'triggers:', group_concat(name) FROM sqlite_master WHERE type='trigger';
SQL
true
```

- 那为什么还要 drop 前两个？因为它们的内容在 `0026`/`0027` 之间**完全相同**（逐字比对），drop 再建不是语义修改，而是让整组触发器定义统一落在控制表重建**之后**、由本迁移一次性重述，不依赖 RENAME 时的 body 改写行为（该行为受 `legacy_alter_table` 与 SQLite 版本影响，而迁移要能在重建库上稳定复现）。**引用**（迁移文件本身没有写理由，此处为按语句顺序与上述实测的解读）

### `pending`→`canceled` 与 `claimed`/`retry_wait`→`stale` 的区别

`p6a_control_disabled` 与 `0026` 的对应触发器都把 `wake_evaluation` 按状态分成两路：**引用**

| 触发时状态   | 结果                                                              | 原因                                                                                                |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pending`    | `state='canceled'`，清 claim 字段                                 | 还没开始算，Human 的意思就是「不要再算」，`canceled` 是正确的终止态                                 |
| `claimed`    | `state='stale'`，清 `claim_token`/`lease_until`/`next_attempt_at` | 已经发给判定器，结果可能还会回来；标 `stale` 才能让晚到结果被第二道 epoch 闸挡下且**不写 `result`** |
| `retry_wait` | `state='stale'`                                                   | 已尝试过、正等退避；再试就是不尊重暂停                                                              |

区别的实质是**有没有已经付出去的判定在途**。`canceled` 表示「从未发生，也不会发生」，`stale` 表示「发生过但已作废」。投递侧同构：未 admit 的 `pending`/`bound` 落 `canceled` 并带原因，已 `presented` 的落 `stale`。

这条区分的直接后果由 `landingFence()` 承担：晚到结果落地时若 epoch 不符，`state` 已经是 `stale`，`result` 保持 `NULL`。第二轮验收独立复证过这一点，见 [summary 的 stale 小节](summary.md#暂停时在途判定落-stale-的独立复证)。

## 两条适配器与「不自动回退」

| 适配器 | 入口                                                                  | 协议                                                                                                                 |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 小脑   | `createSmallBrainJudge`（`src/domain/wake-providers/small-brain.ts`） | 冒泡宿主 runner，返回一份 `{ decisions: [...] }` 文本 JSON，逐候选给 `yes`/`no`/`unknown` 与 `certainty: high        | low` |
| JEV    | `createJevJudge`（`src/domain/wake-providers/jev.ts`）                | `POST https://api.typesafe.ai/v1/systemone`，每个候选一个独立 `Noul` 问题，返回各候选的 yes 概率，由本地阈值切成三值 |

两条适配器都实现同一个 `WakeJudge` 形状，失败统一经 `providerFailure()` 归到上表的 11 个错误码之一。**引用**

边界（三条都是契约，不是偏好）：

1. **一次判定只走一路**：`evaluateWake` 按 `input.policy.provider` 选适配器，不做级联、不做二次征求。JEV 适配器源码注释直接写「never a Choice contest or a provider fallback」。**引用**
2. **判定失败不自动切换 provider**：失败落 `error_code` 与 `attention`，由退避重试同一判定器；换判定器只能由 Human 改 Project 策略。这也是 [总计划](../development-plan.md#i-p6a-集成自动接续与人类控制) 异常条目「判定失败不自动切换 provider」的实现位置。**引用**
3. **产品默认小脑；JEV 适配器保留但不作为可部署选择**：JEV 在这批中文样本上校准 12/15、留出 9/15，且概率排序与意图反序，因此 `DEFAULT_PROJECT_WAKE_POLICY.provider` 是 `small_brain`，JEV 的请求/收据契约保持冻结但不承诺可用。依据：[Jev 作为唤醒判定器](../jev-wake-routing.md#实测结果)。**引用**，测量细节属并行单元，本轮未重复执行。

「不自动回退」的代价要写清：判定器坏掉时，自动接续会停在重试与 `attention`，不会静默降级成「没人被唤醒」或「全都唤醒」。这是有意的选择——静默降级会让「自动接续到底有没有在工作」不可观测。

## 这些契约没覆盖的

- **页面文案**：`disable` 在页面上叫「暂停自动接续」，与模型里的 `off` 不同名，见 [已知限制](summary.md#p3-2-disable-的页面文案)。
- **升级瞬间的残留**：`0027` 只重建表与映射原因，不主动清理旧态行，见 [已知限制](summary.md#p3-5-0027-的迁移残留)。
- **`thresholdVersion` 的具体数值**：版本号是契约，数值不是。当前数值来源是 live fixture 里的 `yes=0.8 / no=0.2`（`tests/fixtures/p6a-live-routing.ts`），未作为产品常量冻进契约。
