# P4d 章节结论：集成交接收回与 Machine 移除

P4d 让「谁现在有权操作这台 Machine」从执行行上的一个代次数字，变成由租约当前 holder 派生的事实，并给它配齐三条落地路径：承租方把租约原子交给另一分身且新 holder 接续既有执行、Human 强制收回、带租约把 Machine 移出 Project。移出用 epoch 表达关系生命周期，撤销通知走独立发件箱，页面在事实不新鲜时关闭全部写入口。

交接与强制收回的内核在 P4b 已完成（`src/server/lease.ts` 的 `mutate` 与 `forceReclaimLease`），本章补的是它与执行权威、关系生命周期、通知投递和页面之间的接缝。

## 交付范围

- 契约与数据形状：`docs/p4d/contracts.md`，迁移 `drizzle/0020_p4d_membership_notices.sql`（`3445264`、`37471ca`，merge `de3a9b4`）。
- 关系与通知：`src/server/membership.ts` 的解绑与重新加入 epoch、`src/server/notices.ts` 的资源撤销发件箱、`src/server/pi-host/run.ts` 按 `notice:<id>` 走既有输入投递（`eb2cc23`、`3302a33`、`10ff375`，merge `19c1a6f`）。
- 执行权威：`authorityNow` 只读 `machine_lease` 的 holder 与代次，`assertExecutionContinuity` 与 `assertExecutionWrite` 取代按行内 holder 判定的旧校验，`executionView` 的 `authority` 与 `currentAuthorizationGeneration` 改为必填（`82b6abd`，merge `ea605b5`）。
- 交接后的事实归约：`delivery()` 先核对历史投递帧证明再归约，缺证明的终态报告 fail closed（`2792b3e`）。
- 移出与强制收回的内核接线：`detachMachine` 走事务内的 `reclaimLeaseInTransaction`，`mutate` 不再从 `raw.action` 推断意图（`dcbdce3`）。
- 目录观测绑定关系身份：观测携带绑定 revision，接收端要求关系 active、绑定 revision 一致、根目录一致，关系失效时删除当前观测（`dbc8776`）。
- 页面：`src/components/machine/membership-sections.tsx` 的分区结构、`membership-view.ts` 的状态投影、`use-machine-relations.ts` 的五秒刷新与失败保留（`b12ebf2`、`a50e786`、`87529f6`，merge `683dadd`）；`WriteGate` 单一闸门覆盖全部写入口（`73a9864`）。
- 门禁：`an-p4d-authority`、`ap-p4d-handoff-worker`、`aq-p4d-pages` 三条新门禁，以及 `z-lease-integration` 的导航定位修正（`5396ba3`、`814d6bd`、`8d2e69b`、`c9df940`）。

## 数据形状

| 形状       | 建模                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 关系       | `project_machine_membership` 按 `(projectId, machineId, epoch)` 存一行，`state` 为 `active`、`detaching`、`removed` |
| 关系身份   | epoch 单调递增；重新加入写 `epoch + 1` 的 active 行；缺行一律拒绝                                                   |
| 执行权威   | 不落在执行行上，由 `machine_lease` 当前 holder 与代次派生；执行行只记派发时事实                                     |
| 接续谓词   | 执行行的发起代次 ≤ 当前代次，且派发帧在历史里可证                                                                   |
| 通知       | `run_resource_notice` 独立发件箱，唯一键 `(kind, causeId, runId)`，投递后由输入轮询取走                             |
| 待处理投影 | `membership_detaching > lease_fencing > notice_undelivered`，优先级与阈值由服务端给                                 |
| 目录观测   | 携带 `bindingRevision`，只表达关系的当前事实；关系失效即删除                                                        |

## 1. 向指定分身原子交接，占用不经过释放空窗

交接是租约内核的一次 `mutate`：旧 holder 的代次在同一事务里推进，新 holder 从 `lease_authorization` 的被授予记录取得当下有效授权，中间没有「已释放、未持有」的窗口。

反证覆盖断连、响应丢失与重复交接，见 `orchestrate/sprout-mio-p4d/reports/design-selection.md` 的决定 5。实现见 `ea605b5`（`src/server/lease.ts:121` 的 `authorityNow`），门禁 `bash scripts/verify/an-p4d-authority.sh`。

## 2. 验证旧请求、重复交接、响应丢失和离线重连，交接后旧 holder 不再有操作权

旧 holder 在交接后的写请求按代次精确拒绝，读请求在关系与代次都成立时才能继续；重复交接与响应丢失走幂等键，返回既有结果而不是新开一次交接。

真机验证见 `ap-p4d-handoff-worker` 的 12 项：交接后进程存活、文件继续写入、新 holder 读到交接前的帧。实现见 `82b6abd`，门禁 `bash scripts/verify/an-p4d-authority.sh` 与 `bash scripts/verify/ap-p4d-handoff-worker.sh`。

## 3. Human 强制收回与带租约移除 Machine 的警告确认，无法确认撤权时保留待处理占用

强制收回只作用于当前 Project × Machine，确认文案写明不终止进程与文件、也无法确认远端已停止；收回完成但撤权未确认时，关系停在 `removed` 且页面显示「撤权未确认」，不显示执行已停止。

带租约移出：有 dispatched 未排空的执行时停在 `detaching` 并出现在待处理区；无在途执行时同事务推进到 `removed`。实现见 `3302a33`，门禁 `bash scripts/verify/an-p4d-authority.sh` 与 `bash scripts/verify/aq-p4d-pages.sh`。

## 4. 验证新 holder 可以查询和管理原有执行，租约动作不自动清理进程或文件

新 holder 对交接前的执行可读可管：列表、日志、结果与取消都按 `authority=inherited` 放行，写操作仍要求代次不早于发起代次。租约释放、交接、强制收回三条路径都不动进程与文件。

真机证据见 `p4d-int-live`：写文件 23 行增至 70 行，最大写入间隔 224ms，新 holder 读到 24 帧（含交接前 8 帧）。实现见 `b6a3ce7`，门禁 `bash scripts/verify/ap-p4d-handoff-worker.sh`。

## 5. 向受影响的活动 runs 投递资源撤销通知，不一律停止 run

撤销通知是独立事实：写入 `run_resource_notice` 后由 run 的输入轮询以 `notice:<id>` 取走，投递失败的留在待处理投影的 `notice_undelivered`；没有任何路径因为通知存在而自动把 run 判失败。

实现见 `10ff375`（`src/server/notices.ts:17-278`），门禁 `bash scripts/verify/an-p4d-authority.sh`。

## 6. 将 Machine、租约和执行相关事实接入已有页面与 Info Hub

Project 设置页与 Machine 详情页共用同一份关系投影：当前资源、待处理、已移出与重新加入、Human 只读历史四段；Info Hub 的 Machine 面板读到的是同一套事实，不另算授权。

实现见 `b12ebf2` 与 `a50e786`，门禁 `bash scripts/verify/aq-p4d-pages.sh`。

## 7. 完成向指定分身交接、Human 强制收回和 Machine 移除的交互、警告与确认

移出与强制收回都走对话框，确认文字写明范围与后果：只作用于当前 Project × Machine、不终止进程、detach 可能停在待处理、force 无法确认远端已停止。Human 在 Lavish 评审里选定的是 B 分区加对话框确认。

实现见 `b12ebf2`，门禁 `bash scripts/verify/aq-p4d-pages.sh`。

## 8. 呈现授权变化、离线待处理和无法确认撤权的状态，相关页面与 inspector 更新为同一事实

待处理条目常显状态、等待时长、Worker 在线与下一步，细节按需展开；页面五秒刷新一次关系事实，刷新失败时保留上次事实、标「当前状态未确认」，并通过 `WriteGate` 暂停全部写入口，包括已经打开的对话框提交。

实现见 `87529f6` 与 `73a9864`，门禁 `bash scripts/verify/aq-p4d-pages.sh`。

## 9. 说明交接、释放与收回对既有执行的实际影响，避免让用户误以为租约操作会清理进程或文件

页面与确认文案都写明租约动作不清理进程或文件；撤权未确认时显示「无法确认远端执行已停止」而不是「执行已停止」；历史区只读，不提供替 Agent 读日志或标记已读的入口。

实现见 `87529f6`，门禁 `bash scripts/verify/aq-p4d-pages.sh`。

## 功能交付证据

功能线六条交付均已落地并通过门禁：交接与收回内核接线、旧请求与重连反证、强制收回与带租约移出的警告确认、新 holder 接续、撤销通知投递、页面与 Info Hub 接入。实现提交 `ea605b5`、`dcbdce3`、`19c1a6f`，门禁矩阵见下节。

重跑 `bash scripts/verify/an-p4d-authority.sh`。

## UI 交付证据

Human 在 Lavish 评审里选定 D01 分区 B、D02 待处理摘要常显细节按需展开、D03 历史内容收起、D04 对话框确认，四项都有对应的门禁断言。实现提交 `b12ebf2` 与 `73a9864`，产物在 `.verify/p4d-ui-sketch/`。

重跑 `bash scripts/verify/aq-p4d-pages.sh`。

## 技术验收证据

第一轮独立验收在 `0ad4e1d` 判 FAIL，四项阻断：stale 后已打开对话框仍可写、目录观测未按关系失效、removed 后执行读错误码错位、缺投递证明的终态仍被 accepted。修复提交 `dbc8776`、`eae7a73`、`2792b3e`、`73a9864` 与夹具 `d7dcfb8`。

第二轮独立验收在 `a1ccbed` 判 PASS，四项全部关闭，并核对既有断言没有被放宽。评审同时驳回「Worker 收到一次 conflict 后不再重试」的猜测：`src/worker/client.ts:179` 每轮按配置重探，`:247` 收到 conflict 后断开并转 drain，`:269` 结束内层循环后由 `:139` 重新 open。

完整验证在 `0912047` 上跑过全量：`bash scripts/verify.sh` 的 53 个脚本全部通过，用时 1531 秒，报告 `.verify/runs/2026-10-29T16-56-04-997Z-79869-0/report.json`。

重跑 `bash scripts/verify/an-p4d-authority.sh`、`bash scripts/verify/ap-p4d-handoff-worker.sh`、`bash scripts/verify/aq-p4d-pages.sh`、`bash scripts/verify/z-lease-integration.sh`。

## Human 体验确认

- 确认记录：Human 亲自体验确认通过，版本 `d275a9c`
- Human 于 2026-10-30 在 `d275a9c` 的集成分支上亲自体验 Machine 详情页的关系分区、待处理与已移出呈现，回复「p4d 没问题，评审通过」。评审环境为 `integration/p4d` 的 dev server 加独立评审库，库内种子只含 3 台机器与 1 条移出记录，未接真实 Worker，因此在线状态、租约与执行段落为空态，交接与强制收回的真实结果由门禁覆盖，重跑 `bash scripts/verify/an-p4d-authority.sh`、`bash scripts/verify/ap-p4d-handoff-worker.sh` 与 `bash scripts/verify/aq-p4d-pages.sh`。

## 已知限制

- q1 一类情况仍未消除：fence 已封住旧执行通道，但物理进程可能仍存活，此时用户只能拿到 `cancellation_already_terminal`。应当在后续阶段为停止与接管补一条可验证的物理退出事实。
- `z-lease-integration` 出现两次 `timeout: directory ready` 后重跑即过，第二轮验收判定为夹具就绪诊断问题而非产品缺陷，但当时没有保留 Worker 日志与 DB 现场，触发点未还原。门禁应把就绪快照与失败现场持久化，而不是靠超时字符串猜原因。
- 关系历史与执行历史只提供只读入口，跨 Project 的批量视图与分页留给后续阶段。
