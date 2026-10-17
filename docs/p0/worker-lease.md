# P0：Worker 最小协议实验（重复提交、响应丢失、授权代次、旧请求拒绝）

对应 [development-plan.md](../development-plan.md) P0 第 5 条。实验代码在
[`experiments/worker-probe/`](../../experiments/worker-probe)，重跑入口
`experiments/worker-probe/scripts/verify.sh`。

这是原型，不是生产实现。它用最小传输（loopback TCP 上的 NDJSON）检查四条协议语义，
目的不是定义 Mio 的正式协议。原文参考 `~/workspace/sprout` 的
`src/worker/gateway.ts`、`src/worker/gateway-protocol.ts`、`src/worker/recovery-journal.ts`、
`src/environment/worker-epoch.ts`、`src/worker/protocol.ts`，协议按 Mio 语义重新设计。

## 结论

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 重复提交不重复启动，返回同一 execution ID | 已验证 | `01-duplicate-request-id`，同一 `requestId` 三次提交返回同一 executionId，副作用文件始终 1 行 |
| 同一 requestId 换命令被显式拒绝 | 已验证 | `01`，`code=duplicate-mismatch`，副作用仍 1 行 |
| 响应丢失后按 request ID 取回执行，且命令只跑一次 | 已验证 | `02-lost-response-recovery`，宿主丢弃后按 requestId 恢复同一 executionId，副作用 1 行；重提交也只 1 行 |
| 授权代次切换，旧代次被拒、新代次成功 | 已验证 | `03-generation-switch`，宿主推进到 N+1 后 Worker 的 N 帧被拒 `stale-generation`，grant 后 N+1 帧被接受 |
| 代次高水位跨重启不回退 | 已验证 | `03`，Worker 重启重连拿到 N+2，高于持久高水位 N+1 |
| 低代次携带的旧执行查询与取消被拒 | 已验证 | `04-stale-execution-request`，旧代次的 query 与 cancel 都被拒 `stale-generation`，命令仍在运行，副作用 1 行 |
| 当前代次仍能查询与取消同一执行 | 已验证 | `04`，当前代次 query 返回 running，cancel 返回 exited + SIGTERM |
| 真实身份认证与密钥证明 | 未验证 | `hello` 自报 workerId，无凭据 |
| TLS 与跨机传输 | 未验证 | 只跑 loopback 明文，按 FORBIDDEN 不实现 |
| 并发 Worker 数、多 Worker 隔离 | 未验证 | 每个宿主实例只接一个 Worker 身份 |
| 真实宿主进程重启 | 未验证 | probe 2 用同一进程内的新宿主实例模拟，磁盘状态相同，内存状态全丢 |
| Worker 执行中途崩溃后的子进程与结果 | 未验证 | 账本有 running→unknown 的降级逻辑，但没有 probe 触发它 |
| Machine 重启、日志游标、流式输出、执行超时、SIGKILL 升级 | 未验证 | 原型只保留终态 |

最后一次完整运行：`ALL PASS (4 probes)`。完整套件连续跑 4 次共 16 个 probe 全部通过。

## 环境

Node v26.11.1（实测路径 `/opt/homebrew/bin/node`），macOS。无第三方依赖，无构建步骤，
`node` 直接运行 `.mjs`。

参考原 Sprout 仓库 `tinysnake/sprout` 的 commit
`5b48a53b385ee8a4c0fff219954c6244506b0b9f`，本次未复制其源码。

## 运行方式

```bash
cd experiments/worker-probe
bash scripts/verify.sh
```

逐个 probe 的输出与 `PASS` 行写入 `.verify-artifacts/`（已 gitignore）。退出码非零表示有
probe 失败。单跑一个 probe 用 `node probes/01-duplicate-request-id.mjs`。

## 原型构成

| 文件 | 职责 |
| --- | --- |
| `src/protocol.mjs` | 帧类型、不可信输入解析、两个接收方共用的唯一代次规则 |
| `src/host.mjs` | TCP 监听、持久代次高水位、宿主侧门禁 |
| `src/worker.mjs` | Worker 进程。主动连接，执行 `run`，对每个宿主帧做代次门禁 |
| `src/ledger.mjs` | Worker 的持久执行账本。幂等键与恢复记录 |
| `fixtures/append-tick.mjs` | 副作用夹具。追加恰好一行后可选 sleep，行数就是命令执行次数的证据 |
| `probes/` | 每个语义一个文件 |

## 协议草图

### 传输

换行分隔 JSON（NDJSON），loopback TCP。Worker 主动连接宿主（与原 Sprout
`src/worker/gateway.ts` 的方向一致）。连接建立后 `hello`，宿主回 `accepted` 并发放代次。

### 帧字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `v` | number | 协议版本，当前为 1 |
| `kind` | string | 帧类型，未知类型即 `protocol-mismatch` 或 `invalid-request` |
| `workerId` | string | Worker 身份。原型自报，未认证 |
| `generation` | number | 发送方当前持有的授权代次。除 `hello` 外每帧必填 |
| `correlationId` | string? | 宿主请求的关联 ID。Worker 在 `execution` 与 `error` 上回显 |
| `requestId` | string? | 幂等键。`run` 必填，`query` 与 `executionId` 二选一 |
| `executionId` | string? | 执行身份，Worker 生成，跨宿主连接稳定 |
| `fingerprint` | object? | `run` 的命令指纹 `{ executable, argv, cwd? }` |
| `state` | object? | 执行状态 |
| `code` / `detail` | string? | 拒绝码与说明 |

### 方向

| 发送方 | 帧 |
| --- | --- |
| Worker | `hello`, `worker-state`, `execution`, `error` |
| 宿主 | `accepted`, `granted`, `run`, `query`, `cancel`, `error` |

方向在解析时校验。发送方发错方向的帧按 `invalid-request` 拒绝，不进入业务处理。

### 代次语义

- 宿主按 `workerId` 铸造单调递增 `generation`。高水位落到磁盘，重启不回退。
- 连接 `accept` 时发 `accepted{ generation }`，Worker 记录为「持有代次」。
- 之后每一帧都带发送方持有的 `generation`。
- 两个接收方用同一条规则。`claimed === current` 接受，`claimed < current` 拒绝
  `stale-generation`，`claimed > current` 拒绝 `future-generation`。
- 拒绝不改变任何状态，也不执行该帧要求。
- 授权逐操作核验，不在连接建立时一次性授予，也不靠缓存的入口绕过。

代次推进与代次通知是两个动作。`promote()` 只推进宿主的持久权威，`notifyGrant()` 才把新代次
推给 Worker。真实系统里推进由接受新连接触发，但「权威已推进、Worker 尚不知情」的窗口必须
能表达，probe 3 就落在这个窗口里。

### 幂等语义

- `requestId` 是幂等键。
- Worker 在 spawn 之前先把记录持久化（状态 `unknown('accepted-not-started')`），再 spawn，
  再置 `running`。崩溃不会留下「已接受但没有记录」的 requestId。
- 同 `requestId` 同 `fingerprint` 返回同一 `executionId`，不重复启动。
- 同 `requestId` 不同 `fingerprint` 拒绝 `duplicate-mismatch`。
- Worker 启动时把账本里的 `running` 记录降级为 `unknown('worker-restarted')`。进程死亡不能
  证明子进程已被 fence，所以不自动重跑。

执行状态是一个可判别联合，不是一组并列布尔：

```
running
exited { code, signal }
unknown { reason }
```

`unknown` 是一等结果，用于「无法确认」，不伪装成成功或失败。

## 1. 重复提交（probe 01）

```bash
node probes/01-duplicate-request-id.mjs
```

输出摘要：

```
  evidence: first submit: requestId=req-A executionId=exe-262e7d0e... state=running lines=1
  evidence: repeat submit: executionId=exe-262e7d0e... (same) lines=1
  evidence: repeat after exit: executionId=exe-262e7d0e... (same) state=exited lines=1
  evidence: same requestId, different fingerprint: refused code=duplicate-mismatch lines=1
PASS 01-duplicate-request-id (1010ms)
```

## 2. 响应丢失（probe 02）

```bash
node probes/02-lost-response-recovery.mjs
```

宿主 A 提交后立即停止并丢弃全部内存状态。宿主 B 在相同端口、相同持久代次目录上新建，
所以它有零条执行记忆。Worker 是独立进程，重连后拿到更高代次。

输出摘要：

```
  evidence: host A: generation=1 executionId=exe-b32723ba... state=running lines=1
  evidence: host A stopped and discarded; host B has no execution memory; worker reconnected at generation=2 (was 1)
  evidence: recovered by requestId: executionId=exe-b32723ba... (same) state=running
  evidence: re-submit after recovery: executionId=exe-b32723ba... (same) state=exited lines=1
PASS 02-lost-response-recovery (1655ms)
```

宿主重启在这里是「同进程内新建宿主实例 + 同一份磁盘状态」。真实进程重启的差别只是操作系统
回收 socket，协议相关的状态转移完全相同。这一点在未验证项里列出。

## 3. 授权代次切换（probe 03）

```bash
node probes/03-generation-switch.mjs
```

输出摘要：

```
  evidence: baseline accepted at generation=1; authority promoted to 2 without notifying the worker
  evidence: worker frame kind=worker-state claimed=1 refused code=stale-generation
  evidence: granted 2; next worker frame accepted at 2; durable high-water=2
  evidence: worker restart reconnect: generation=3 > durable high-water 2
PASS 03-generation-switch (897ms)
```

## 4. 旧请求拒绝（probe 04）

```bash
node probes/04-stale-execution-request.mjs
```

输出摘要：

```
  evidence: generation=1: executionId=exe-5bac6b4a... state=running lines=1
  evidence: stale query and stale cancel both refused code=stale-generation (claimed=1)
  evidence: refused cancel did not stop the command: still running, lines=1
  evidence: current generation cancel accepted: state=exited signal=SIGTERM
PASS 04-stale-execution-request (474ms)
```

## 影响基础契约的发现

1. **requestId、correlationId、executionId 是三个不同的东西。** `requestId` 是幂等键，
   `executionId` 是执行身份，`correlationId` 把响应配回请求。`query` 与 `cancel` 没有自己的
   `requestId`（`query` 的 `requestId` 是查询目标），没有关联 ID 就无法把响应配回请求。
   architecture-direction 目前只列了「请求 ID 与执行 ID」。
2. **代次门禁必须在两个方向都做。** 宿主持有的是权威高水位，Worker 持有的是它被授予的代次。
   权威先推进、Worker 后知情，这个窗口里 Worker 发来的帧必须被宿主拒绝（probe 3）。旧持有者
   带着老代次到达 Worker 的 query 与 cancel 也必须被 Worker 拒绝（probe 4）。只在连接建立时
   核验不够。
3. **恢复权威在 Worker 的持久执行账本，不在宿主的持久代次。** 宿主重启后唯一能回答「这条
   命令是否已经跑过」的是 Worker。所以「响应丢失后不重跑」要求 Worker 持持久执行记录，而不
   是宿主拿同一 requestId 盲重试。
4. **幂等键必须绑定命令指纹。** 同 `requestId` 换命令要显式拒绝。否则一次重试会静默变成
   另一条命令，副作用无法解释。
5. **代次推进与代次通知要分开建模。** 原型把它们拆成 `promote` 与 `grant` 两个动作。真实系统
   里推进由 accept 连接触发，但「权威已推进、Worker 尚不知情」的窗口必须能表达。

## 需要更新的架构说明

- `architecture-direction.md` 的「命令协议需要显式表达以下信息」应补上关联 ID（响应配对），
  与 request ID、execution ID 并列。
- 同节「租约授权建议使用持久代次，Worker 拒绝旧代次请求」应写明宿主也拒绝旧代次 Worker 帧，
  两个方向都逐操作核验。
- 「让 Worker 提供整机操作能力」应写明 Worker 执行记录的持久化是响应丢失后不重跑的前提。

## 未验证项

- 真实身份认证与密钥证明。`hello` 只自报 `workerId`，没有 enrollment、claim secret 或签名证明。
- TLS 与跨机传输。只跑 loopback 明文。
- 并发 Worker 数、多 Worker 隔离、多宿主并发。每个宿主实例只接一个 Worker 身份，代次存储与
  账本都是单进程整体重写，无跨进程锁。
- 真实宿主进程重启。probe 2 用同进程新建实例模拟。
- Worker 执行中途被 SIGKILL。账本有 `running` 降级为 `unknown` 的逻辑，但无 probe 触发，孤儿
  子进程的实际行为未测。
- Machine 重启、宿主断线期间的长命令续跑。
- 日志游标与流式输出。probe 只保留终态，没有增量日志。
- 等待超时与执行超时、SIGTERM 到 SIGKILL 的升级、取消的确认语义。
- 执行状态的 `unknown` 在真实不确定路径下的产生。原型只在账本载入降级与
  `accepted-not-started` 两处产生。
- `future-generation` 分支。代码有这条规则，但没有 probe 断言。
- 同一宿主并发在途请求、背压、帧大小上限。
- 跨 Worker 的幂等。幂等键目前是 `(workerId, requestId)`。
