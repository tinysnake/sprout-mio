# P0：恢复承诺实验（宿主断线、宿主重启、Worker 重启、Machine 重启）

对应 [development-plan-functional.md](../development-plan-functional.md) P0 第 6 条。实验代码在
[`experiments/recovery-probe/`](../../experiments/recovery-probe)，重跑入口
`experiments/recovery-probe/scripts/verify.sh`。

这是原型，不是生产实现。它用真实进程、真实 kill、真实重连跑出 12 格证据，回答四个问题。
哪些结果能恢复。哪些变成显式 unknown。哪些绝不重跑。PID 存活为什么不能证明结果可恢复。

原文参考 `~/workspace/sprout` 的 `src/worker/recovery-journal.ts`，参考 commit
`5b48a53b385ee8a4c0fff219954c6244506b0b9f`。本次未复制其源码。

## 结论表

四种故障 × 三种命令状态。每格是实验测得的承诺，不是设计意图。

| 故障 | 进行中短命令 | 进行中长命令 | 已完成未取结果 |
| --- | --- | --- | --- |
| 宿主断线（进程存活，连接断开） | 恢复。重连后先 running，命令继续，随后 exited:0 | 恢复。重连后 running，命令继续 | 恢复。重连后 exited:0 |
| 宿主重启（kill 宿主进程） | 恢复。新宿主从意图 journal 重建，先 running 后 exited:0 | 恢复。新宿主从意图 journal 重建，查回 running | 恢复。新宿主查回 exited:0 |
| Worker 重启（kill Worker 进程，子进程变孤儿） | 恢复。新 Worker 用 pid + token 认领孤儿，先 running 后 exited:0 | 状态可查为 running。之后孤儿被杀且无结果，变 unknown | 恢复。exited:0 |
| Machine 重启（kill 整个进程组） | unknown，不重跑 | unknown，不重跑 | 恢复。exited:0（结果在死前已落盘） |

三条跨格不变量。

- unknown 是一等状态，带明确 reason，不被伪装成成功或失败。
- 同 requestId 重提交返回同一 executionId 和同一状态，副作用行数不变。
- 已完成且结果已落盘的命令，连 Machine 重启都能查回。结果没落盘的在途命令，任何故障后都不猜。

## 恢复模型

三层持久化，各自持有不同的权威。

1. **宿主意图 journal。** 提交前写入。重启后的宿主从这里重建在途意图，不靠内存。
2. **Worker 执行 journal。** spawn 前写入。持有 executionId、fence token、runner pid 和状态。
   重启后的 Worker 只做归约，绝不重新 spawn 非终态记录。
3. **Runner 的 claim 与 result 文件。** Runner 启动时写 claim（pid 与 token），sleep 结束后写
   result。被杀在 result 之前，磁盘上就没有结果。

执行状态是可判别联合，不是并列布尔：

```
starting | running | exited { code, signal } | unknown { reason }
```

归约规则决定重启后每个记录的去向。

- result 文件存在，状态为 `exited`，已知。
- result 不存在，claim 的 token 匹配且 pid 存活，状态为 `running`。
- result 不存在，claim 不匹配或 pid 已死，状态为 `unknown`，reason 说明是
  `child-exited-without-result` 还是 `no-fence-record`。
- 当前 incarnation 自己持有子进程句柄时，活动 pid 集合阻止归约误降级。

unknown 通过 `query` 返回。它不会被静默重跑。重提交同一 requestId 只返回已有记录，
副作用文件行数不变，这是每格都记录的 no-rerun 证据。

## 12 格证据

完整运行输出：[`experiments/recovery-probe/evidence/matrix-run.txt`](../../experiments/recovery-probe/evidence/matrix-run.txt)。
每次运行的逐格现场保留在 `experiments/recovery-probe/.matrix/<cell-id>/`，含 `effects.log`、
`worker-state/journal.json`、`exec/*.claim.json` 与 `exec/*.result.json`。

重跑命令：

```bash
cd experiments/recovery-probe && bash scripts/verify.sh
```

`verify.sh` 后台启动 harness 并轮询，任何一格违反承诺即以非零码退出。最后一次完整运行
`ALL PASS (12 cells)`。连续两次完整运行输出逐字节相同（`diff` 无差异）。

单格证据摘要（摘自 `matrix-run.txt`）。

| 格 | 关键观测 |
| --- | --- |
| `host-disconnect__short-running` | afterReconnect=running, final=exited:0/null, effects=1 |
| `host-disconnect__long-running` | afterReconnect=running, effects=1 |
| `host-disconnect__completed-unretrieved` | afterReconnect=exited:0/null, effects=1 |
| `host-restart__short-running` | pendingRecoveredFromJournal=true, afterReconnect=running, final=exited:0/null |
| `host-restart__long-running` | pendingRecoveredFromJournal=true, afterReconnect=running |
| `host-restart__completed-unretrieved` | pendingRecoveredFromJournal=true, afterReconnect=exited:0/null |
| `worker-restart__short-running` | afterRestart=running, orphanPidClaimed=true, final=exited:0/null |
| `worker-restart__long-running` | afterRestart=running, afterOrphanKilled=unknown:child-exited-without-result, 重提交 reused=true 且 effects 仍为 1 |
| `worker-restart__completed-unretrieved` | afterRestart=exited:0/null |
| `machine-restart__short-running` | afterRestart=unknown:child-exited-without-result, 重提交 reused=true, effects=1 |
| `machine-restart__long-running` | afterRestart=unknown:child-exited-without-result, 重提交 reused=true, effects=1 |
| `machine-restart__completed-unretrieved` | afterRestart=exited:0/null |

## 影响基础契约的发现

1. **恢复权威分散在三层，缺一层就有盲区。** 宿主意图 journal 决定「重启后还知道要查什么」。
   Worker 执行 journal 决定「这条命令是否已经跑过」。Runner 的 result 文件决定「in-flight 命令
   的终态是否可恢复」。宿主重启只用到第一层，Worker 重启用到第二、三层，Machine 重启用到第三层。
2. **PID 存活只证明进程还在跑，不证明结果可恢复。** Worker 重启后对孤儿进程报 running，依据是
   pid 存活加 token 匹配。终态仍要等 result 文件。孤儿被杀且没有 result 时状态落回 unknown。
3. **result 文件把「已完成」和「在途」分开。** Machine 重启后，已完成命令 exited:0 可查，在途命令
   unknown。这正是「结果已落盘才叫完成」的可执行版本。
4. **未知结果绝不触发重跑。** 同 requestId 重提交返回同一 executionId，状态仍是 unknown，
   副作用文件行数保持为 1。幂等键绑定命令指纹，换命令要显式拒绝（沿用 P0-e 的结论）。
5. **归约与直接观测要分开。** 当前 incarnation 直接观测到子进程 exit 时记录 exited。新 incarnation
   只能归约磁盘事实，不能把「查不到」当成没跑过。

## 需要更新的架构说明

- [architecture-direction.md](../architecture-direction.md) 的「跨 run 与宿主连接持续执行是一期要求」
  已写「PID 存活不能证明结果可恢复」和「自动重启 Worker 不能自动重跑未知结果的命令」。本次补上
  正向要求：Worker 侧执行记录与命令终态必须由执行端持久化，宿主只保存意图与查询点。
- 同节应写明恢复分三层权威（宿主意图、Worker 执行、执行端结果），并写明 `unknown` 是一等返回态。

## 未验证项

- 真实跨机、跨网络分区。四种故障都在同一台机器上用进程 kill 与连接关闭模拟。
- 真实断电、内核崩溃、文件系统掉电。实验假设已写入磁盘的文件在重启后仍完整。
- 用 cgroup、launchd 或 Windows 服务管理器的真实 Worker 监督与进程组回收。本实验用
  `detached` 进程组加 `kill -KILL` 模拟机器全灭。
- 真实宿主与 Worker 在多宿主、多租约并发下的恢复。本实验每条命令一个宿主、一个 Worker。
- 命令执行超时、SIGTERM 到 SIGKILL 的升级、取消语义、日志游标与流式输出。原型只保留终态。
- 结果文件落盘的部分写、校验和、损坏检测。原型用临时文件加 rename，但没有 fsync。
- 长时间在线期间 Worker 对自身 journal 的容量上限与裁剪。
