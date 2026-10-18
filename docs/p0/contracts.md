# P0：身份、事务与授权基础契约

对应 [development-plan-functional.md](../development-plan-functional.md) P0 第 7 条。实验代码在
[`experiments/contract-checks/`](../../experiments/contract-checks)，重跑入口
`experiments/contract-checks/scripts/verify.sh`（`tsc --noEmit` + 真实 SQLite 断言）。

语义来源是 [architecture-direction.md](../architecture-direction.md) 的「分开记录身份和生命周期」表。
数据库层行为参考 p0-b 的 [spa-auth-db.md](spa-auth-db.md) 结论（Drizzle 0.45.4 + better-sqlite3 12.11.1），
协议语义参考 p0-e 的 [worker-lease.md](worker-lease.md)。本单元未阅读原 Sprout 源码。

环境：macOS arm64，Node v26.11.1，npm 11.20.0，SQLite 3.53.2。

## 结论表

「数据库约束保证」= 第二个写入者即使跳过业务代码也违反不了。
「应用层保证」= 数据库只能约束一部分，剩下由明确的提交协议表达，并已用测试验证。
「应用层保证（未验证）」= 语义已确认，但没有可重跑证据。

| # | 契约 | 约束表达 | 由谁保证 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 分身（profile × Conversation）唯一 | `UNIQUE INDEX agent_instance(profile_id, conversation_id)` | 数据库约束保证 | `instance_unique_rejects_second`、`concurrent_instance_create_exactly_one_wins_{delete,wal}` |
| 2 | 同 profile 可存在于另一 Conversation | 同上，索引按两列组合 | 数据库约束保证 | `instance_unique_allows_same_profile_other_conversation` |
| 3 | 分身身份独立于 run、宿主连接与服务重启 | `agent_instance.id` 为主键，表内无 run 级列；`agent_run.instance_id` 外键指向它 | 结构保证（数据库 schema） | `partial_unique_indexes_present_in_sqlite_master`、schema |
| 4 | Project × Machine 同时最多一个活跃租约 | `UNIQUE INDEX machine_lease(project_id, machine_id) WHERE state = 'active'` | 数据库约束保证 | `lease_exclusive_rejects_second_active`、`concurrent_lease_acquire_exactly_one_wins_{delete,wal}` |
| 5 | 释放后可由新 holder 接管，租约历史保留 | 同上（部分索引只约束 `active`）；释放行写 `state='released'` + `ended_at` | 数据库约束保证 | `lease_released_allows_new_holder` |
| 6 | 直接交接不经过释放空窗 | 单事务内 `release` + `insert`（partial 索引拒第二活跃租约） | 应用层保证（事务协议）；数据库只保证不出现两个活跃租约，不阻止零租约窗口 | `lease_handoff_single_transaction_no_gap`（事务内 active=1）；反例 `lease_handoff_two_transactions_has_gap_negative_control` |
| 7 | 租约状态与结束时间一致 | `CHECK (state='active') = (ended_at is null)`、`CHECK state in ('active','released','revoked')`、`CHECK generation >= 1` | 数据库约束保证 | `partial_unique_indexes_present_in_sqlite_master`（schema 迁移 SQL） |
| 8 | 同一分身串行 run | `UNIQUE INDEX agent_run(instance_id) WHERE status = 'active'` | 数据库约束保证 | `run_serial_rejects_second_active` |
| 9 | 不同分身可并行 run | 同上（索引按 `instance_id`，不是全局） | 数据库约束保证 | `run_parallel_across_instances_allowed`（同时 2 个 active） |
| 10 | run 结束后允许下一轮 | 部分索引只约束 `active` | 数据库约束保证 | `run_after_end_allows_next` |
| 11 | run 终态一致，非法状态不可写 | `CHECK status in (...)`、`CHECK (status='active') = (ended_at is null)` | 数据库约束保证 | `run_check_rejects_contradictory_ended_at` |
| 12 | 执行 ID 稳定 | `remote_execution.id` 为主键（执行身份，不由 run/连接派生） | 数据库约束保证 | `execution_same_request_returns_same_row` |
| 13 | 执行请求幂等（安机 + request ID） | `UNIQUE INDEX remote_execution(machine_id, request_id)` | 数据库约束保证（唯一性）+ 应用层保证（重复提交解析到既有行） | `execution_same_request_returns_same_row`、`concurrent_execution_same_request_single_row_{delete,wal}`（并发下仍 1 行） |
| 14 | 幂等键绑定命令指纹 | 同 request ID 不同指纹抛 `DuplicateRequestMismatch`，不新建行 | 应用层保证（已验证） | `execution_fingerprint_mismatch_rejected` |
| 15 | 幂等键按 Machine 限定 | 索引 `(machine_id, request_id)`，非全局 | 数据库约束保证 | `execution_request_key_scoped_per_machine` |
| 16 | 唤醒去重（同目标 + 同去重键） | `UNIQUE INDEX wake_request(target_instance_id, dedup_key)` + `ON CONFLICT DO UPDATE` 合并 | 数据库约束保证（唯一性）+ 应用层保证（合并语义） | `wake_dedup_merges_second_enqueue` |
| 17 | 重复入队不复活已处理唤醒 | 合并只更新 `source`/`payload`/`enqueued_at`，保留 `id` 与 `processed_at` | 应用层保证（已验证） | `wake_merge_does_not_resurrect_processed` |
| 18 | 去重键按目标分身限定 | 索引含 `target_instance_id` | 数据库约束保证 | `wake_dedup_scoped_per_target` |
| 19 | 关系完整性（分身/租约/唤醒引用已存在对象） | 外键 + `PRAGMA foreign_keys = ON` | 数据库约束保证（依赖连接显式开启） | `instance_fk_rejects_unknown_profile`（`pragma_foreign_keys=1`） |

应用层保证但本单元未验证：run 状态迁移方向（`active → completed/failed/canceled` 不可回退）、
租约 holder 必须是该 Project 的参与分身（授权）、唤醒执行前重新检查参与权与暂停控制、
代次门禁拒绝旧代次（协议层由 p0-e 的 `worker-probe` 验证，本单元只固定 `generation` 列）。

## 契约细节

### 1. 身份

`agent_profile` 只存人设与默认配置，与生命周期解耦。`conversation` 属于 Project。
分身 `agent_instance` 只由 `(profile_id, conversation_id)` 决定，`id` 是主键，
没有 run 级或连接级列，所以它天然跨 run、跨宿主连接、跨服务重启保持同一身份。

同 profile × Conversation 的第二个分身被唯一索引拒绝。第二次测试证明索引是组合键，
不是「一个 profile 只能有一个分身」。

### 2. Project × Machine 租约互斥与交接

活跃租约用部分唯一索引 `(project_id, machine_id) WHERE state='active'` 表达互斥。
释放或撤权把 `state` 改为 `released`/`revoked` 并写 `ended_at`，行保留用于审计，
部分索引因此不再约束它，新 holder 可以接管。

直接交接必须保持占用。`handoffLease` 在**一个** `db.transaction` 内先释放旧租约、再插入新租约，
并在事务内读取活跃租约数断言为 1。反例 `lease_handoff_two_transactions_has_gap_negative_control`
把释放与获取拆成两个事务，观测到 `active=0` 的空窗，且一个非预期 holder 能抢进这个窗口，
原定接手者被唯一索引拒绝。**数据库约束阻止两个活跃租约，但不阻止零租约空窗；
「不出现释放空窗」只能靠单事务协议保证。**

### 3. run 串行

同分身第二个活跃 run 被部分唯一索引拒绝。索引按 `instance_id`，所以不同分身各自一份活跃 run。
结束 run 必须同时写终态与 `ended_at`，CHECK 约束保证 `active` 与 `ended_at IS NULL` 等价，
不会出现「active 但已有结束时间」这类非法组合。结束后的下一轮 run 可以正常开始。

### 4. 执行 ID 与幂等

`remote_execution.id` 是稳定执行 ID（主键），`(machine_id, request_id)` 是幂等键。
`submitExecution` 先尝试插入。唯一冲突时回查既有行：指纹相同返回既有行
（`created=false`，不产生第二行）；指纹不同抛 `DuplicateRequestMismatch`，绝不静默改跑另一条命令。
并发两个连接提交同一 `(machine, requestId)`，恰好一个插入成功，最终仍只有 1 行。

「执行 ID 由 Worker 生成、跨宿主连接稳定」的进程间证据在 [worker-lease.md](worker-lease.md)；
本单元只固定存储层唯一性。

### 5. 唤醒去重

`wake_request` 的唯一键是 `(target_instance_id, dedup_key)`。第二次入队用
`ON CONFLICT DO UPDATE` 合并进同一行：`id` 不变，`payload`/`source`/`enqueued_at` 更新为最新。
合并不清空 `processed_at`，所以重复入队不会复活一条已经投递过的唤醒。
去重键按目标分身作用域，同一逻辑事件发给两个分身在两行里各存一份。

**推导出的生产者规则**：一个 `dedup_key` 在一生中只对应一行唤醒。需要再次触发的
逻辑事件必须派生新的去重键，否则第二次入队只会合并、不会新建。

### 6. 约束落在数据库，不在业务分支

三个部分唯一索引在迁移后存在于 `sqlite_master`，SQL 里带 `WHERE ... = 'active'`。
外键引用完整性要求连接显式 `PRAGMA foreign_keys = ON`（better-sqlite3 默认关闭），
本实验的连接初始化函数固定打开它。

## 并发验证

`worker_threads` 各开一个独立的 better-sqlite3 连接指向同一数据库文件，用
`SharedArrayBuffer` + `Atomics.notify` 对齐起跑线，同时尝试写同一约束。断言：恰好一个成功、
一个拿到 `SQLITE_CONSTRAINT_UNIQUE`，最终表内只有 1 行。`busy_timeout = 5000`，
败者等待赢者提交后拿到唯一约束错误，没有 `SQLITE_BUSY` 逃逸。

在 `journal_mode = DELETE` 与 `journal_mode = WAL` 两种模式下各跑一遍，六个并发用例
（分身、租约、执行各两种模式）全部恰好一个赢家。为排除「顺序写本来就会撞唯一约束」的假象，
先跑一个反例 `sequential_insert_is_not_a_race_negative_control` 说明顺序第二写同样失败。

连续 6 次完整运行（1 次 `verify.sh` + 5 次单跑）均为 `checks: 25, passed: 25, failed: 0`。

## 影响基础契约的发现

1. **部分唯一索引是表达「活跃互斥 + 历史保留」的正确结构。** 用布尔列做唯一索引会把历史行
   也锁死；用 `state` 列加 `WHERE state='active'` 既能强制互斥，又能保留已释放的审计记录。
   三个互斥对象（分身、租约、run）都能用同一个形状表达，不需要触发器。
2. **零租约空窗不是数据库约束能防的。** 部分唯一索引防的是「两个活跃租约」，防不了
   「零个活跃租约」。交接必须建模成单个事务里的 release + acquire，并在事务内自检活跃数。
   这条必须写进 P4 的交接实现，否则测试会漏。
3. **run 的状态与结束时间要用 CHECK 绑成等价关系。** `(status='active') = (ended_at is null)`
   让「active 但有 ended_at」和「已结束但无 ended_at」都无法写入，比应用层校验可靠。
4. **唤醒去重的合并必须显式保留 `processed_at`。** `ON CONFLICT DO UPDATE` 的 `set` 里漏掉
   它就会复活已处理唤醒；把它排除在 set 之外是刻意的契约，需要一条测试锁住。
5. **外键默认关闭。** SQLite 的 `PRAGMA foreign_keys` 是每连接设置且默认 0，better-sqlite3
   不会自动打开。所有打开数据库的入口（含 Worker 独立连接）必须显式开启，否则引用完整性
   静默失效。
6. **WAL 与 DELETE 都不影响唯一约束语义。** 并发下的恰好一个赢家在两种 journal 模式下一致，
   所以 P1 选 WAL 只影响并发读写吞吐，不改变契约行为。

## 需要更新的架构说明

- 「分开记录身份和生命周期」的租约行需要补一句：活跃性由 `state` 列 + 部分唯一索引表达，
  释放行保留为审计历史；直接交接是单事务协议，不是「先释放再获取」两步。
- 「Wake request」的「去重身份」需要写明去重键的作用域是目标分身，且一个去重键终身只对应
  一条记录，重复触发需要派生新键。
- 「Remote execution」需要写明幂等键是 `(Machine, request ID)` 且绑定命令指纹，稳定执行 ID
  是独立的主键。
- 数据库连接一节需要写明 `PRAGMA foreign_keys = ON` 是每连接必需项。

## 未验证项

- 多进程（独立 Node 进程）并发写同一 SQLite 文件。本单元是同一进程内多连接（worker_threads），
  不是多进程，也不是多宿主。
- WAL 的 checkpoint、`busy_timeout` 取值、写饥饿与长事务行为。
- run 状态迁移方向（能否从终态回退、是否允许 active 直接变 failed）没有用触发器或应用状态机
  约束。
- 租约 holder 的授权校验（holder 必须是该 Project 的参与分身）只在架构文档里，没有数据库或
  应用层强制。
- 唤醒执行前的参与权与暂停控制复查未实现。
- 代次门禁（拒绝旧代次请求）在存储层只固定了 `generation >= 1`，跨进程协议行为由 p0-e 验证。
- 租约 TTL、心跳超时、撤销的异步确认（「数据库更新不能单独证明 Worker 已撤销旧权限」）。
- 唤醒 payload 的结构与大小上限。
