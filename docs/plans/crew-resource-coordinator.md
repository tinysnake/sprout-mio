# Crew 资源协调器设计（CR3）

CR3 把 Machine 租约的 owner 从「执行者实例」提升为「DM 实例或 Crew」，worker 只获得绑定 run 的执行授权。lead 提交批准、撤销与接管意图，runtime 负责分配与恢复。

## 持久模型

- 互斥单位仍是 Project × Machine（`machine_lease` 主键），不新增 `UNIQUE(machine_id)`；同 Project 的 Crew 与 DM 竞争同一份资源。
- `machine_lease` 增加 `owner_kind`（`instance|crew`）与 `holder_crew_chat_id`。free 时两者为空；`instance` owner 使用 `holder_instance_id`；`crew` owner 使用 `holder_crew_chat_id`，且跨 lead run 存活。FK 按 `(chat_id, project_id)` 约束到本 Project 的 Crew。
- `lease_authorization` 的 `holder_instance_id` 继续指实际执行者；增加 owner 快照（`owner_kind`、`owner_crew_chat_id`）。`authorityNow` 必须分别返回 owner 与执行 holder，不能继续把两者合并。
- 扩展现有 `lease_grant` 作为唯一授权事实：`crew_epoch`、`subject_kind`（`delegation|lead_run`）、`delegation_id`、`attempt`、`expires_at`。不新建第二套 grant 表。保持 grant→authorization 复合 FK、每代授权唯一 active grant、execution→run/instance 身份 FK 与 0065 触发器。
- 新增 `crew_resource_request`：`id, project_id, crew_chat_id, crew_epoch, revision, subject_kind, delegation_id, attempt, run_id, instance_id, chat_id, machine_id, membership_epoch, directory_real_path, directory_revision, operations_json, client_request_id, payload_hash, approval(pending|approved|revoked), approved_by_profile_id, approved_by_instance_id, state(queued|allocated|active|releasing|released|held|attention), mutation_id, grant_id, generation, created_at, updated_at, released_at, reason`。
  - `UNIQUE(crew_chat_id, client_request_id)`；同键异 payload 冲突。
  - 同 `(delegation_id, attempt, run_id, machine_id)` 最多一条未释放请求；lead 按 run。
  - 同 `(project_id, machine_id)` 最多一个占槽项（部分唯一索引覆盖 allocated/active/releasing/held）。
  - CHECK：worker 必有 delegation/attempt；lead_run 无 delegation；active 必有 grant/generation；released 必有 released_at。
- 新增 `crew_resource_event` 作为 outbox：`request_id, revision, kind, audience, crew_epoch, state, payload_json, message_id, bound_run_id, attention_reason`，唯一 `(request_id, revision, kind, audience)`，投递状态 pending/bound/acked/attention。资源等待不得伪装成 delegation blocked。
- `lease_mutation` 增加 `resource_request_id, target_run_id, target_attempt, crew_epoch`，fencing 后的目标固定，不能改绑最新 run。

## 生命周期

- `dispatchDelegation(..., resources?)` 在同一事务登记已批准需求并阻止该 queued run 提前 admission。
- worker `sprout_resource_request` 只登记 pending approval；lead `sprout_resource_approve` 批准 Machine/目录/操作范围；等待不反复唤醒 lead。
- coordinator 校验 epoch、成员、attempt、run、Machine membership 后占槽；队列项与 grant 是授权事实，通知送达不决定授权。
- worker `sprout_resource_release` 只提交归还意图；runtime 冻结新写、记录 mutation、取消/等待远端 execution，确认排空后提升 generation、撤销 grant，交下一项或释放。
- 当前 lead 可 revoke/takeover（目标另一 worker 或自己的 lead_run），不要求旧 worker 同意，不能抢其他 Crew/DM；Human force reclaim 仍是独立权限。
- 父 lead run 结束不释放 worker 资源；worker 完成/失败/取消时立即冻结并收尾，摘要完成不等于排空。
- Crew stop 停止新批准、分配、admission；未分配释放，已分配收尾，不自动杀已有 run。
- 换 lead 时未决请求、grant、held/attention 责任成为治理 blocker。
- 首版不保留无执行 holder 的空闲 Crew lease：有下一项则交接，否则释放。

## 并发与恢复

- 请求去重/插入、批准 CAS、占槽/冻结/create mutation、排空后撤销+generation+1+签发、admission 复核、stop/终态冻结，均用短 `BEGIN IMMEDIATE` 事务；网络 dispatch、取消、排空查询、消息投递在事务外按持久 ID 重试。
- mutation 用稳定 request ID；同请求重放返回原收据，异 payload 冲突；allocated 目标 run 不得被同实例后续 run 替换。
- 启动先阻止新分配，完成 run 恢复和 lease/execution 对账；scheduler 每轮先 reconcile 再推进资源。
- 恢复：queued 且资格有效保留顺序；allocated 无 grant 按同 mutation 续做；grant 已建未 admission 只恢复原 queued run；run 中断/epoch 失效/委派终态则冻结，已 dispatch 按持久 execution ID 查询/取消并等 `drainedAt`；无 pending 的 held 创建去重 recovery mutation，不能直接 UPDATE 为 free。
- `recoverAgentRuns()` 需窄化：从未 admission、因资源 gate 等待的 queued run 可保留；已运行 run 仍按现有规则中断，绝不复活终态 run。
- 离线、取消失败、排空未知保持 held/releasing 并 attention；定时器只触发重试，不证明停止。
- 只能 attention 交 Human：身份/owner 数据冲突、目标已移除且 mutation 无法落地、远端生死不明、旧 scope/隔离无法证明、旧 epoch 遗留责任。
- Human force reclaim 先建 mutation，再走既有确认流程，提升 generation 并记录未确认排空；coordinator 不能把它当 confirmed release 自动派下一位。

## 函数与工具边界

- `src/domain/crew-resource.ts`：`requestCrewResource`、`approveCrewResource`、`revokeCrewResource`、`advanceCrewResources`、`reconcileCrewResources`、`assertCrewExecutionScope`。
- `src/contracts/crew-resource.ts`、`src/server/crew-resource-coordinator.ts`、worker/lead tools、remote-agent gateway、remote 执行鉴权、admission/recovery、scheduler、成员移除/换 lead blocker。
- `authorityNow` 拆分后，Crew owner 分支的写检查必须要求存在匹配 grant（epoch、attempt、scope），DM 保留原语义。
- 排空必须覆盖已 dispatch、尚未 `drainedAt` 的旧代 execution，不能只看 terminalAt 或结果。

## 测试与验收

- 单测：双 worker FIFO；同键异 payload；同实例新 run 冒用；错误 epoch/attempt/目录；stop/完成与 grant 并发；grant 建立后 admission 前崩溃；无 pending held；失效目标；DM 回归；force 两类 owner；0066 CHECK/FK 反例。
- 真实 gateway/远端 fixture：取消有活进程、断线对账、释放失败、force reclaim、队列顺序、两 Machine 并行；不得用 mock 释放成功替代机器事实。
- live/perf 按 `docs/plans/crew-development-plan.md` 的 CR3 十 lane 与门槛执行；目录校验只是机器侧可执行边界，不是文件系统沙箱，安全强度需 Human 另行确认。
