# P6a 控制面收敛：UI 与夹具传播报告

状态：UI 与全部相关夹具已按 d44 收敛后的模型改写，本文列出的门禁全部 exit 0。领域、契约、schema、迁移 0027 与 `scripts/verify/p6a-control.sh` 的 inline 段未改动。

分支：`p6a/control-fixtures`，从 `p6a/control-model` 的 `aa0334e` 起。

## 提交

| 提交 | 内容 |
| --- | --- |
| `ec96fb1` | UI 与页面夹具：`automation-card.tsx`、`p6a-pages.ts`、`p6a-pages-client.tsx`、`p6a-pages-browser.ts` |
| `4d02a1c` | `tests/fixtures/p6a-schedule.ts`（control / delivery / scheduler 三个 suite） |
| `dcb4f37` | `tests/fixtures/p6a-lifecycle.ts` |
| `a8cfe47` | `tests/fixtures/p6a-wiring.ts` |
| `145a481` | 浏览器门禁一处断言组改名（`_disabled_stop_run_readable`） |

## 门禁结果

全部在本工作树执行。`pnpm install --prefer-offline` 用时 2.3s，`node_modules` 为真实安装（未指向主 checkout）。`.env` 从 `/Users/snake/workspace/sprout-mio/.env` 复制。时长是本机墙钟，单进程脚本受 tsx 启动影响。

| 命令 | 退出码 | 时长 | 断言数 |
| --- | --- | --- | --- |
| `pnpm typecheck`（3 个 tsconfig 项目） | 0 | 9s | 0 处错误（起始为 18 处） |
| `scripts/verify/p6a-control.sh` | 0 | 1s | inline 11 条 + `p6a-schedule.ts control` 31 条 |
| `scripts/verify/p6a-delivery.sh` | 0 | 1s | 41 |
| `scripts/verify/p6a-scheduler.sh` | 0 | 1s | 20 |
| `scripts/verify/p6a-integration.sh` | 0 | 1s | 13 |
| `scripts/verify/bf-p6a-lifecycle.sh` | 0 | 6s | 177 |
| `scripts/verify/p6a-pages.sh` | 0 | 3s | 125 个断言组（3 视口） |
| `scripts/verify/p6a-wiring.sh` | 0 | 1s | 95 |
| `scripts/verify/as-p5b-task-pages.sh` | 0 | 12s | 19 |
| `scripts/verify/as-p5a-chat-ui.sh` | 0 | 13s | 30 条浏览器断言 + build/server/sqlite 检查 |
| `scripts/verify/i2-group-chat.sh` | 0 | 0s | 13 |
| `scripts/verify/i3-public-channel.sh` | 0 | 1s | 6 |
| `pnpm test`（整套单元测试，附加验证） | 0 | 34s | 84 文件 / 711 用例 |
| `pnpm exec vp fmt` / `pnpm exec vp lint`（改动文件） | 0 | <1s | — |

`i2`、`i3` 与 `p6a-integration` 的 0–1s 是脚本自身耗时（本机 SQLite + fixture 进程），日志内含完整 PASS 行，不是被跳过的空跑。

## 改动的文件

- `src/components/automation/automation-card.tsx`
- `tests/fixtures/p6a-pages.ts`、`tests/fixtures/p6a-pages-client.tsx`、`tests/fixtures/p6a-pages-browser.ts`
- `tests/fixtures/p6a-schedule.ts`
- `tests/fixtures/p6a-lifecycle.ts`
- `tests/fixtures/p6a-wiring.ts`

没有改动 `src/contracts/**`、`src/domain/**`、`src/db/schema.ts`、`drizzle/**`、`scripts/verify/p6a-control.sh`，也没有改 `tests/task-automation-view.test.ts` 与 `tests/p6a-contracts.test.ts`（协调者已在新契约下更新，它们反过来约束了本文的 UI 文案）。

## UI：`automation-card.tsx`

不是断言改动，但与夹具文案直接绑定，一并列出。

| 位置 | 旧 | 新 | 依据 |
| --- | --- | --- | --- |
| 模式表 | `enabled` / `paused` / `stopped` 三段中文 | `enabled` / `off`；`off` 文案「自动接续已关闭」 | 模式只剩两态 |
| 「会不会来」 | 暂停、停止两条分支 | 单条「此 Chat 已关闭自动检查。」 | `paused`/`stopped` 不再存在 |
| 范围说明 | 「暂停或停止自动检查不会停止当前 run」 | 「关闭自动检查不会停止当前 run」 | 保留 `tests/task-automation-view.test.ts` 断言的「不会停止当前 run」子串，去掉两态措辞 |
| 开关按钮 | `pause`「暂停自动接续」/ `resume`「恢复自动接续」 | `disable`「暂停自动接续」/ `enable`「开启自动接续」 | 单元测试要求关闭态出现「开启自动接续」 |
| Chat 级动作 | `stop` + `scope: "chat"`「停止自动接续…」，确认键「确认停止」 | `abort` 无 `runId`「全部停止」，确认键「确认全部停止」 | 该动作用途是「全部停止」，且必须关闭 Chat |
| run 级动作 | `stop_run`「停止分身运行」 | `abort` + `runId`「停止这个运行」 | 一个 abort 命令、两种粒度 |
| run 控制说明 | 「停止分身运行只针对选定 run，自动检查开关需单独控制。」 | 「停止这个运行只中止选定的 run，不改自动接续开关与 epoch；全部停止会关闭自动接续。」 | 新模型下 run 级 abort 确实不动开关与 epoch |
| denial testid | `automation-<action>-denial`，动作名 pause/stop | 动作名 disable/abort，例如 `automation-disable-denial` | 命令改名 |
| 「全部停止」可见性 | 旧 `stopped` 模式下隐藏 Chat 级停止按钮 | 始终显示 | `off` 仍可能持有活动 run（`disable` 不中止 run），此时「全部停止」才是唯一能中止它们的入口 |

`submit()` 现在对 `abort` 分两路：带 `targetId` 时发 `{ action: "abort", runId }`，不带时发 `{ action: "abort" }`；`scope` 字段已随契约消失。Chat 级「全部停止」保留一次确认步骤（触发键文案逐字为「全部停止」），因为它是唯一会中止全部 run 的不可逆动作。

## 夹具旧 → 新对照

### `tests/fixtures/p6a-pages.ts`

| 旧 | 新 | 为什么 |
| --- | --- | --- |
| `p6aCases` 含 `paused`、`stopped` 两例 | 去掉两例，改为单例 `off` | 模式只剩 `enabled` / `off`；两例的区别（是否中止 run）不再是模式差异 |
| 夹具用例 `view.mode = name`（`paused`/`stopped`），原因文案「Human 暂停推进」 | `view.mode = "off"`，原因文案「Human 关闭自动检查」 | 同上 |
| denials：`pause`「当前身份无权暂停此 Chat」、`stop`「当前身份无权停止此 Chat」 | `disable`「当前身份无权关闭此 Chat 的自动接续」、`abort`「当前身份无权中止此 Chat 的 run」 | denial 键是命令名；文案按 disable/abort 的真实语义重写（**不是放宽**：两条 denial 都仍然存在） |

### `tests/fixtures/p6a-pages-client.tsx`（夹具外壳，见「存疑」第 1 条）

| 旧 | 新 | 为什么 |
| --- | --- | --- |
| 命令 `pause` → `automationFixture("paused")` | 命令 `disable` → `automationFixture("off")` | 命令改名，模式改名 |
| 命令 `stop` → `automationFixture("stopped")`，且随后把 `activeRunIds` 覆盖回原值 | 命令 `abort` → `automationFixture("off")`，并清空 `activeRunIds` | 新模型里 Chat 级 abort 会中止全部 run；旧夹具把 run 留住，是在旧模型下「stop 不宣称中止 run」的写法，现在与领域事实相反 |
| 命令 `resume` → `automationFixture("scheduled")` | 命令 `enable` → 同一目标 | 仅改名 |
| 无 | 命令 `abort` 带 `runId` → 从 `activeRunIds` 中移除该 run，模式与其余字段保持不变 | 新模型新增的能力，夹具必须能表达「只停一个 run」 |

### `tests/fixtures/p6a-pages-browser.ts`

| 旧断言组 | 新断言组 | 为什么 |
| --- | --- | --- |
| 用例 `paused` / `stopped` 各自检查「自动接续不会来」+「恢复自动接续」可用 | 单例 `off` 检查「自动接续不会来」+「开启自动接续」可用 | 两例合并为一例；开启文案与被测按钮一致 |
| `_human_can_resume` | `_human_can_enable` | 动词改名 |
| `idle`：`停止分身运行` 按钮 disabled 且可读 | `停止这个运行` | 按钮改名 |
| `denied`：`automation-pause-denial` 含「当前身份无权暂停此 Chat」 | `automation-disable-denial` 含「当前身份无权关闭此 Chat 的自动接续」，仍检查 `forbidden` | testid 与文案随命令改名 |
| 点击「暂停自动接续」→ 模式「自动接续已暂停」、命令 `action === "pause"` | → 模式「自动接续已关闭」、命令 `action === "disable"` | 命令与模式改名 |
| `_pause_contract_and_read_response` | `_disable_contract_and_read_response` | 动词改名 |
| 点击「恢复自动接续」→ 断言后无 `action` 检查 | 点击「开启自动接续」并新增 `action === "enable"` | 补上被点击命令的检查（原来只断文案，不验命令） |
| `_resume_contract_and_read_response` | `_enable_contract_and_read_response` | 动词改名 |
| 点击「停止自动接续…」→ 取消 → 无写入 | 点击「全部停止」→ 取消 → 无写入 | 按钮改名，取消路径语义不变 |
| `_stop_can_cancel_without_write` | `_abort_can_cancel_without_write` | 动词改名 |
| 确认后模式「自动接续已停止」，`stop.action === "stop"` 且 `stop.scope === "chat"` | 确认后模式「自动接续已关闭」，`abort.action === "abort"` 且 `"runId" in abort === false` | `scope` 字段已删除；「不带 runId」就是新的 Chat 级表达，所以断言从「显式 scope」改成「显式 absence of runId」 |
| `_stop_has_explicit_chat_scope` | `_abort_without_run_id_closes_the_chat` | 同上 |
| `_conflict_does_not_pretend_paused`（写入冲突后模式仍「已启用」） | `_conflict_does_not_pretend_disabled`（同一事实） | 措辞；断言强度不变 |
| `_disabled_stop_run_readable` | `_disabled_run_stop_readable` | 与按钮新名一致 |

组数变化：`p6aCases` 8 → 7 例，每个视口因此少 4 组固定断言（`copy` / `no_horizontal_scroll` / `scope_occupies_own_row` / `provider_disabled`），共 −12；同时新增 1 组 `_abort_without_run_id_closes_the_chat`，共 +3（3 视口）。当前 125 组。

### `tests/fixtures/p6a-schedule.ts`

| 旧断言 / 调用 | 新断言 / 调用 | 为什么语义真的变了 |
| --- | --- | --- |
| 控制助手 `action: "pause" \| "resume" \| "stop"`，`stop` 附带 `scope: "chat"` | `action: "disable" \| "enable" \| "abort"`，可选 `runId` | `scope` 已被契约删除；run 级 vs Chat 级由是否带 `runId` 表达 |
| `["paused", 2, 0]`「pause increments epoch and removes executable schedule」 | `["off", 2, 0]`「disable increments epoch and removes executable schedule」 | 模式名变了；epoch +1 与删调度的事实不变 |
| 「first epoch gate prevents checks while paused」 | 「…while automation is off」 | 措辞 |
| 「Human resume starts a fresh interval」 | 「Human enable starts a fresh interval」 | 措辞 |
| 「pause permits current run to finish」 | 「disable permits current run to finish」 | 同一条 d44 事实换了动词：`disable` 不动活动 run |
| **新** `[drow(bound.id).state, cancel_reason] === ["canceled", "human_disabled"]` | — | 旧模型 pause 写 `human_paused`，新枚举是 `human_disabled`；旧断言完全没有点名取消原因，这条是新增覆盖而不是替换 |
| 「third epoch gate rejects admission after control change」（`sends === 0`） | 「disabled Chat cannot admit a canceled continuation」（`sends === 0`） | **语义确实变了**：旧模型控制变更后投递行仍是 `bound`，靠 admit 时的 `control_epoch=(mode='enabled')` 栅栏拒绝；新模型 `disable` 在 reconcile 阶段就把未准入投递以 `human_disabled` 取消，admit 在状态检查处返回。准入时 epoch 栅栏因此不再能从控制命令到达，见「存疑」第 4 条 |
| agent 读取 `denials.resume`、agent 发 `action: "resume"` | `denials.enable`、`action: "enable"` | 命令改名；`forbidden` 断言与原样保留 |
| `["stopped", "aborted", 1]`：「Human stop stores stopped mode」+「stop aborts current run」+「host abort intent persists」 | 拆成四条：`["off", beforeAbort.epoch + 1]`「chat-wide abort closes automation and advances the epoch again」、run `"aborted"`、新投递 `["canceled", "human_aborted"]`、`chat_automation_abort === 1` | Chat 级动作现在必须同时关闭 Chat、+1 epoch、中止全部 run 并写明 `human_aborted`。原先「模式变 stopped」不再成立（没有 stopped 模式），由「模式变 off 且 epoch +1」取代；取消原因与中止范围是新增覆盖 |
| **新** `ok(abortable, "enabled Chat builds a fresh unadmitted continuation")` | — | 为了让「全部停止取消未准入投递」有真实对象 |
| `["stopped", 0, null]`「fresh process cannot bypass stop」 | `["off", 0, null]`「fresh process cannot bypass abort」 | 模式改名 |
| `allowedActions.includes("chat.automation.pause") && !denials.pause` | `chat.automation.disable` / `denials.disable` | 能力名随命令改名 |
| **新** run 级 abort 四连：两条 run、`["enabled", "enabled", 原 epoch]`、`["aborted", "queued"]`、`chat_automation_abort === 2` | — | d44 新增的核心语义（只中止一个 run、不动开关与 epoch），旧夹具完全没有覆盖 |
| 「disable during external provider request fences the late result」 | 同一条，动词 `pause` → `disable` | 措辞 |
| 「…while paused」「pause preserves unadmitted ordinary input…」 | 「…while automation is off」「disable preserves…」 | 措辞 |
| 「resume does not automatically resend an unknown input」 | 「enable does not automatically resend an unknown input」 | 措辞；disable→enable 后未知投递仍是屏障 |
| 「Chat stop aborts all real runs even when responsible owner is Human」 | 「Chat abort stops every live run even when the responsible owner is Human」 | 命令改名；断言对象（`queued`/`running` 计数为 0）不变 |

`p6a-schedule.ts` 的 control suite 现在 31 条断言（原为 24 条：+8 条新增覆盖，−1 条不再成立的「Human stop stores stopped mode」，其余为等价替换或改名）。

### `tests/fixtures/p6a-lifecycle.ts`

| 旧 | 新 | 为什么 |
| --- | --- | --- |
| 控制助手 `"pause" \| "resume" \| "stop"` + `scope: "chat"` | `"disable" \| "enable" \| "abort"` | 契约改名 |
| mode `"paused"`「Human pause applies immediately」 | `"off"`「Human disable applies immediately」 | 模式改名 |
| 「Human resume applies immediately」 | 「Human enable applies immediately」 | 措辞 |
| `stop` → `assigned(..., "停止后显式接续")`「new assigned work cannot revive stopped automation」 | `abort` → `assigned(..., "全部停止后显式接续")`「new assigned work cannot revive a closed Chat」 | 旧文案把 stopped 当模式名；断言对象（`row(chat.id) === undefined`）不变 |
| stale 矩阵 `["pause", "stop", "reassign", "resume"]` | `["disable", "abort", "reassign", "enable"]` | 四类 Human 竞态仍是：关闭、全部停止、改派、重新开启 |
| `if (change === "resume") control(..., "pause")` | `if (change === "enable") control(..., "disable")` | 为「重新开启」营造关闭前态 |
| epoch 期望 `control_epoch + (resume ? 2 : 1)` | `control_epoch + (enable ? 2 : 1)` | 语义不变：enable 是 disable+enable 两步 epoch，abort/disable 各一步 |
| 各冻结点 `control(..., "pause")` | `control(..., "disable")` | 这些调用只用于冻结 Chat（不中止 run）；在新模型里正是 `disable` 而不是 `abort`；模式从 paused 变 off 不影响后续断言（它们此后不再断言 mode） |

### `tests/fixtures/p6a-wiring.ts`

| 旧 | 新 | 为什么 |
| --- | --- | --- |
| 助手 `pause(chatId)`，`action: "pause"` | `disable(chatId)`，`action: "disable"` | 命令改名 |
| `const paused = group()`、`beforePause`、`evaluationsBeforePause` | `disabled`、`beforeDisable`、`evaluationsBeforeDisable` | 变量名不把旧模式留在夹具里 |
| 「paused due Chat makes no provider requests」/「paused due Chat produces no evaluation」 | 「disabled due Chat …」两条 | 措辞；断言对象（`calls` 不变、`wake_evaluation` 计数不变）不变 |

六处 `disable(...)`（含默认策略与显式模型 Chat）都只是冻结后续用例，不新增或放宽断言。

## 存疑与需要协调者确认的地方

1. **多改了一个文件**：`tests/fixtures/p6a-pages-client.tsx` 不在 brief 的清单里，但它是 `p6a-pages-browser.ts` 唯一导入的夹具外壳，`p6a-pages` 门禁必须经它才能跑到 `pause`/`stop` 命令分支，不改则门禁直接失败。改动仅限命令→视图映射（见上表）。请确认是否接受它归入页面夹具块。
2. **「全部停止」保留一次确认**：brief 只给了按钮文案。触发键逐字为「全部停止」，确认键为「确认全部停止」。若期望单击即中止，去掉 `confirmation === "abort"` 分支即可，夹具里对应的一组断言也要一并改。
3. **`src/extension/remote-tools.ts` 未改**：它的工具描述仍是「读取当前 Chat 的自动接续模式、周期检查、提醒和投递状态；不能暂停、停止、恢复或重发。」这是只读工具的能力说明（在说它**不能**做什么），不是模式名；且 `src/extension` 不在本次范围。若希望彻底统一动词（改为「不能关闭、停止或恢复」），请指派。
4. **一处覆盖位置发生了移动，而不是原样保留**：准入时的 `control_epoch = (mode='enabled')` 栅栏现在无法从控制命令到达，因为 `disable` / Chat 级 `abort` 会在 reconcile 阶段取消未准入投递。现在这条路径由「投递被取消且原因正确」的断言覆盖；epoch 栅栏其余覆盖点仍在本 suite（`commitEvaluationResult` / `createContinuationDelivery` 两条 `null`）与 lifecycle stale 矩阵的 epoch 断言，inline 段也直接断言 abort 的 epoch 语义。如果认为准入栅栏必须继续由夹具直测，需要一个不经过控制命令的构造方式，我没有自行发明。
5. **未加 `tests/task-migration.test.ts` 的 0026→0027 数据用例**：brief 说「需要时」可加且不要与 inline 重复。`p6a-control.sh` 的 inline 段已带真实数据升级证明（`paused`/`stopped` → `off`，epoch/revision/审计保留，FK 检查），我判断加一条会重复，故未加。
6. **`i2-group-chat` / `i3-public-channel` 只是回归**：它们不涉及控制命令，本分支改动经全量单元测试与它们共同验证无回归，但它们本身不证明新控制模型。
7. **时长口径**：表中时长为单次墙钟；`typecheck` 与整套 `pnpm test` 为附加验证（非 brief 判据），其余为 brief 判据。工具等待时间未从墙钟里扣除。
