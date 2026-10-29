# P4d 数据形状：关系生命周期、执行权威与撤销通知

本章新增两张表，并给执行视图加两个派生字段。迁移 `drizzle/0020_p4d_membership_notices.sql` 只做加法：不改既有列，不重建被复合外键引用的中心表。

## 关系：`project_machine_membership`

| 列 | 含义 |
| --- | --- |
| `project_id`、`machine_id` | 关系两侧，外键指向 Project 与 Machine |
| `epoch` | 关系代次，同一对 Project × Machine 从 1 开始单调递增 |
| `state` | `active`、`detaching`、`removed` |
| `detach_reason`、`removed_at` | 移出原因与完成时点 |

约束表达三件事：同一对 Project × Machine 同时最多一个非 `removed` 的 epoch（部分唯一索引）、epoch 必须为正、`detaching` 与 `removed` 必须有原因。`project_machine` 行不删除，因此历史关系与租约收据始终可读。

重新加入写 `epoch + 1` 的 `active` 行，并要求调用方给出 expectedEpoch；epoch 不匹配时抛冲突，不覆盖更新的关系。

## 通知：`run_resource_notice`

| 列 | 含义 |
| --- | --- |
| `kind`、`cause_id`、`run_id` | 与原因绑定的唯一键，保证同一原因对同一 run 只投递一次 |
| `body` | 投递给 run 的文本 |
| `delivered_at` | 被 run 输入轮询取走时写入 |

投递走既有输入通道：`src/server/pi-host/run.ts` 以 `notice:<id>` 作为输入标识取走通知，不新开推送给 Agent 的旁路，也不因为通知存在而改变 run 的状态。

## 执行权威

执行行只记录派发当时的事实：`authorization_generation` 与 `holder_instance_id` 不再改写，它们是「谁发起的」的 origin 证据，且被日志帧、结果与取消三张表的复合外键引用。

「谁现在有权」由 `machine_lease` 当前行派生：holder 取 `machine_lease.holder_instance_id`，代次取 `machine_lease.generation`。不能用 `lease_authorization.holder_instance_id`，因为撤销只改该行的 state，行还在，会把被撤权的 holder 误判为持有者。

| 派生值 | 含义 |
| --- | --- |
| `authority: "holder"` | 调用者就是当前 holder |
| `authority: "inherited"` | 执行发起代次不晚于当前代次，且派发帧在历史里可证 |
| `authority: "history"` | 关系已不 active，只能读历史 |
| `currentAuthorizationGeneration` | 当前租约代次，用于与执行发起代次比较 |

判定顺序是四段合取：custody holder 是调用者、租约处于 `held`、租约 holder 是调用者、执行发起代次不晚于当前代次。任一段不成立都精确拒绝，不降级成「暂时当作没权限」。

## 目录观测

观测是关系的当前事实，不是审计历史：`bindingRevision` 来自 `project_machine.revision`，接收端要求关系 active、绑定 revision 一致、根目录与 root revision 一致；关系失效、绑定 revision 变化或收回完成时删除该 Project × Machine 的旧观测。因此重新加入之后，没有新 epoch 的观测不可能被当成当前。

## 错误码

| 码 | 何时 |
| --- | --- |
| `detach_pending` | 移出尚未完成，关系停在 `detaching` |
| `membership_removed` | 关系已移出，写操作与取消被拒 |
| `lease_not_holder` | 调用者不是当前 holder，或关系非 active 时的连续性读 |
| `conflict` | epoch、绑定 revision 或代次不匹配的乐观并发冲突 |
