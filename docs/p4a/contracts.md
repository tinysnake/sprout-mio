# I-P4a Machine 契约参考

实现依据为 coordinator 选定的 `orchestrate/sprout-mio-p4a/design-selection.md`。本单元提供共享契约、六表迁移和隔离 SQLite 约束验证。服务端授权、Worker 循环和 UI 由下游实现。

## 模块与数据形状

`src/contracts/machine.ts` 是 Human 投影和输入的唯一所有者。`src/contracts/worker.ts` 是 Worker 与 host 共用的私有 wire schema。两个模块只依赖 Zod 和共享契约，不依赖 Node、数据库、认证或 runtime。通用 `src/contracts/index.ts` 仅导出 Human 模块。

`ID_PREFIXES.machine` 为 `mch`。`MachineId` 使用现有 `AppId<typeof ID_PREFIXES.machine>`，没有新的品牌体系。所有边界 Machine、Project、boot 和 request ID 使用现有 `appIdPattern` 的小写前缀 UUID v4。attemptId 使用无前缀 UUID v4。Human createdBy 是认证系统的非空 user ID。

下文所有对象 schema 都拒绝未知字段。类型通过 Zod 推导。`MachineOperations` 是未来 server functions 的签名接口，没有占位实现。身份、连接代次、Project 工作目录意图分别建模。连接观察不表示租约、空闲、释放或远端操作能力。

## Human schema 与导出

| schema                             | type 或导出             | 精确约束                                                                                                                            |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `machineIdSchema`                  | `MachineId`             | `mch_` UUID v4                                                                                                                      |
| `positiveSafeIntegerSchema`        | 无单独类型              | 整数 1 到 9007199254740991                                                                                                          |
| `macosAbsolutePathSchema`          | 无单独类型              | 1 到 4096 个 JS 字符，以 `/` 开头，无 NUL；不 trim、不展开 `~` 或变量，不做文件系统探测                                             |
| `machineSchema`                    | `Machine`               | id、trim 后 1 到 80 字 name、非空 createdBy、ISO UTC createdAt 和 updatedAt                                                         |
| `machineConnectionViewSchema`      | `MachineConnectionView` | `kind=online` 或 `connecting` 必须有正整数 generation 与 ISO lastSeenAt；`offline` 的 generation 和 lastSeenAt 可 null，reason 必填 |
| `shellFactSchema`                  | `ShellFact`             | path 为绝对路径；kind 为 zsh、bash、sh、unknown；version 为最多 4096 字字符串或 null；checkedAt 为 ISO UTC；probe 为下述判别联合    |
| `capabilitySnapshotSchema`         | `CapabilitySnapshot`    | platform 仅 darwin；arch 为 arm64 或 x64；workerVersion 长 1 到 80；shells 最多 16 项；remoteOperations 仅 not_implemented          |
| `projectMachineIntentSchema`       | `ProjectMachineIntent`  | projectId、machineId、description 最多 500 字、directory 为绝对路径或 null、revision 为正 safe integer                              |
| `directoryObservationResultSchema` | 无单独类型              | accessible 必有绝对 realPath；unavailable 必有安全 reason；分支字段不可混用                                                         |
| `directoryObservationSchema`       | `DirectoryObservation`  | machineId、generation、projectId、revision、seq、checkedAt 和 result；generation、revision、seq 均为正 safe integer                 |
| `machineDetailSchema`              | `MachineDetail`         | machine、enrollmentStatus、connection、capability 和 bindings；下文定义组合                                                         |
| `machineEnrollmentSchema`          | `MachineEnrollment`     | detail、ticket 和 ISO UTC expiresAt；ticket 是 43 字符 base64url，不带 padding                                                      |

`MACHINE_OFFLINE_REASONS` 为 never_connected、closed、stale、host_restarted、superseded。connecting 表示 open 已认证，但尚无有效能力。online 由当前 boot、最新 generation、open 和未过期心跳共同决定。lastSeenAt 是通信观察，不证明物理 TCP 连接仍存在。

Shell probe 为 `{ kind: "success" }` 或 `{ kind: "failure", reason }`。reason 仅为 missing、denied、timeout、unsupported、failed、output_limit，不接收原始异常文本。目录 unavailable reason 仅为 missing、not_directory、denied、io_error。

MachineDetail 的 enrollmentStatus 仅为 pending 或 active。credential 的 secretHash 与 activatedAt 均为空时为 pending，均非空时为 active。该安全事实不依赖连接状态，因此已 enroll 尚未 open 的 Machine 仍显示 active，UI 只对 pending 显示续签入口。只投影状态字符串，不投影 credential 内容。

MachineDetail 的 capability 为 null 或 `{ generation, current, snapshot }`。bindings 是 `{ intent, observation }[]`，observation 为 null 或 `{ current, fact }`。current 标记由服务端根据 boot、generation 和绑定 revision 判定。旧观察可以展示，不能伪装成当前事实。bindings 只包含调用者可见的 Project；带 projectId 查询时只返回该 Project。

MachineDetail 不包含 ticket hash、secret hash 或长期 secret。enrollment 输出是独立的只显示一次的短期 ticket 结果，不属于普通 detail。所有边界失败使用现有 `MachineResult<T> = AppResult<T> & { fieldErrors?: Record<string, string> }`。

## Human 操作输入与输出

所有签名都返回 Promise。请求上下文和 requestId 由服务端边界获取，不属于浏览器输入。

| `MachineOperations` 方法    | 输入 schema 与 type                                                           | 成功 data              |
| --------------------------- | ----------------------------------------------------------------------------- | ---------------------- |
| `createMachine`             | `createMachineInput`、`CreateMachineInput`，`{ name }`                        | `MachineEnrollment`    |
| `renewMachineEnrollment`    | `renewMachineEnrollmentInput`、`RenewMachineEnrollmentInput`，`{ machineId }` | `MachineEnrollment`    |
| `listMachines`              | `listMachinesInput`、`ListMachinesInput`，`{}`                                | `MachineDetail[]`      |
| `getMachine`                | `getMachineInput`、`GetMachineInput`，`{ machineId, projectId? }`             | `MachineDetail`        |
| `listProjectMachines`       | `listProjectMachinesInput`、`ListProjectMachinesInput`，`{ projectId }`       | `MachineDetail[]`      |
| `saveProjectMachineBinding` | `saveProjectMachineBindingInput`、`SaveProjectMachineBindingInput`            | `ProjectMachineIntent` |

另导出 `machineIdInput`，用于仅接收 machineId 的边界。save 输入的全部字段为 machineId、projectId、description、directory、expectedRevision。description 必填，最多 500 字。directory 必填，可 null。expectedRevision 必填，可 null，否则为正 safe integer。null 表示首次绑定。相同目标值保留 revision，修改冲突返回 conflict。revision 在修改成功时递增，不得溢出。

服务端要求 Human session。未登录返回 unauthorized。跨 Human 访问返回 not_found。绑定要求 Project 与 Machine 的 owner 相同，并核对调用者对 Project 的权限。renew 只允许本人未激活的 Machine。ticket 有效期十分钟，续签替换旧 ticket。上述是操作契约，本单元不实现授权或事务。

以下是有效的保存输入。directory 为 null 只表示已加入 Project 且未设置目录。

```json
{
  "machineId": "mch_00000000-0000-4000-8000-000000000001",
  "projectId": "prj_00000000-0000-4000-8000-000000000002",
  "description": "本机开发目录",
  "directory": null,
  "expectedRevision": null
}
```

以下是有效的 Human detail。

```json
{
  "machine": {
    "id": "mch_00000000-0000-4000-8000-000000000001",
    "name": "Mac",
    "createdBy": "human-owner",
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-01T00:00:00Z"
  },
  "enrollmentStatus": "pending",
  "connection": {
    "kind": "offline",
    "generation": null,
    "lastSeenAt": null,
    "reason": "never_connected"
  },
  "capability": null,
  "bindings": []
}
```

AppResult 成功为 `{ "ok": true, "data": ..., "requestId": "req_..." }`。失败为 `{ "ok": false, "error": { "code": "not_found", "message": "未找到", "requestId": "req_..." }, "requestId": "req_..." }`。不混用成功和失败字段。

## Worker wire schema

仅从 `src/contracts/worker.ts` 导入以下内容。外部凭据只在此私有协议边界解析，不进入通用 barrel 或 Human detail。所有请求和响应都有 version 和 requestId。version 仅为 1。每个成功响应有 ok=true 和 data，失败有 ok=false 和 error，不接受混合对象。

| 请求 schema 与 type                          | 专有输入字段                                   | 响应 schema 与 type，成功 data                                                                |
| -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `workerEnrollInput`、`WorkerEnrollInput`     | machineId、secret、ticket                      | `workerEnrollResponseSchema`、`WorkerEnrollResponse`，`{ machineId }`                         |
| `workerOpenInput`、`WorkerOpenInput`         | machineId、secret、attemptId                   | `workerOpenResponseSchema`、`WorkerOpenResponse`，`{ session, pollIntervalMs, staleAfterMs }` |
| `workerExchangeInput`、`WorkerExchangeInput` | secret、session、seq、capability、observations | `workerExchangeResponseSchema`、`WorkerExchangeResponse`，`{ session, seq, bindings }`        |
| `workerCloseInput`、`WorkerCloseInput`       | secret、session                                | `workerCloseResponseSchema`、`WorkerCloseResponse`，`{ closed: true }`                        |

`workerSecretSchema` 接受恰好 43 字符的 `[A-Za-z0-9_-]` 字符串。ticket 与本地长期 secret 使用同一语法，生产端生成 32 个随机字节后 base64url 编码。文档示例中的重复字符只用于语法演示。

`workerSessionSchema` 与 `WorkerSession` 为 `{ machineId, generation, bootId, attemptId }`。seq 是正 safe integer。exchange 的 observations 最多 1000 项，每个 Project 最多一项；每项 machineId、generation、seq 必须等于会话及请求。Project revision 是否仍为当前值必须在接收事务中检查。capability 每次完整提交。响应 bindings 为该 Machine 的完整绑定意图快照。

`WORKER_ERROR_CODES` 为 validation_failed、unauthorized、not_found、conflict、superseded、stale、unsupported_version、stopping、internal。失败 error 为 `{ code, message }`，message 最多 200 字。错误消息由 host 生成安全文本；schema 的字符串长度限制不能替代脱敏。requestId 由服务端当前请求上下文确定。

协议默认常量如下。这些值是配置默认，不是延迟测量。

| 导出                       | 值     |
| -------------------------- | ------ |
| `WORKER_PROTOCOL_VERSION`  | 1      |
| `WORKER_POLL_INTERVAL_MS`  | 5000   |
| `WORKER_STALE_AFTER_MS`    | 15000  |
| `WORKER_ENROLLMENT_TTL_MS` | 600000 |

以下是有效的 exchange 请求，secret 是无真实身份含义的示例值。

```json
{
  "version": 1,
  "requestId": "req_00000000-0000-4000-8000-000000000003",
  "secret": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "session": {
    "machineId": "mch_00000000-0000-4000-8000-000000000001",
    "generation": 1,
    "bootId": "boot_00000000-0000-4000-8000-000000000004",
    "attemptId": "00000000-0000-4000-8000-000000000005"
  },
  "seq": 1,
  "capability": {
    "platform": "darwin",
    "arch": "arm64",
    "workerVersion": "0.1.0",
    "shells": [
      {
        "path": "/bin/zsh",
        "kind": "zsh",
        "version": "zsh 5.9",
        "checkedAt": "2026-01-01T00:00:00Z",
        "probe": { "kind": "success" }
      }
    ],
    "remoteOperations": "not_implemented"
  },
  "observations": [
    {
      "machineId": "mch_00000000-0000-4000-8000-000000000001",
      "generation": 1,
      "projectId": "prj_00000000-0000-4000-8000-000000000002",
      "revision": 1,
      "seq": 1,
      "checkedAt": "2026-01-01T00:00:00Z",
      "result": { "kind": "accessible", "realPath": "/Users/example/project" }
    }
  ]
}
```

有效的 unavailable 结果为 `{ "kind": "unavailable", "reason": "denied" }`。有效的失败响应如下。

```json
{
  "version": 1,
  "requestId": "req_00000000-0000-4000-8000-000000000003",
  "ok": false,
  "error": { "code": "superseded", "message": "连接已被替代" }
}
```

成功 open 的 data 包含完整 session 和两个正整数毫秒间隔。成功 exchange 的 data 包含同一 session、确认的 seq 和 bindings。成功 close 的 data 只含 closed=true。enroll 和 open 的输入由公共 envelope 加表中列出的必填字段组成，没有可选凭据字段。

## 六表持久模型

新增迁移为 `drizzle/0006_cooing_yellowjacket.sql`，配套 `drizzle/meta/0006_snapshot.json` 与 `_journal.json`。已合并迁移保持原样。现有 Project 仅增加 UNIQUE(id, created_by)，支持复合外键。

新表所有时间列使用 Unix epoch 毫秒，Drizzle `timestamp_ms` 在应用端映射为 Date。现有表的秒级时间列不变。时间由下游注入 Clock 提供。SQL 仅约束必填和状态配对，时间先后关系由生命周期事务维护。

| schema 导出、表                                        | 字段和关联                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machine`、machine                                     | id 主键；name；createdBy → user.id；createdAt、updatedAt 必填；UNIQUE(id, created_by)；trim 后名称长 1 到 80                                                                                                                                      |
| `machineCredential`、machine_credential                | machineId 主键 → machine.id；ticketHash、ticketExpiresAt 必填；secretHash、activatedAt 可空且必须同时有值或同时为空；ticketHash 唯一，非空 secretHash 唯一；hash 恰好 64 字符小写十六进制                                                         |
| `machineConnectionCounter`、machine_connection_counter | machineId 主键 → machine.id；highWater 默认 0，SQLite typeof 为 integer，范围 0 到 MAX_SAFE_INTEGER                                                                                                                                               |
| `machineConnection`、machine_connection                | 主键 machineId/generation；machineId → machine.id；bootId → runtime_boot.id；UNIQUE(machineId, attemptId)；attemptId 非空；generation 为正 safe integer；openedAt、lastSeenAt 必填；status、closedAt、seq、capability、lastPayloadHash 约束见下文 |
| `projectMachine`、project_machine                      | 主键 projectId/machineId；createdBy 分别与 Project 和 Machine 的 createdBy 组成复合外键；description 必填默认空字符串，最多 500；directory 可 null，否则绝对路径、最长 4096、无 NUL；revision 为正 safe integer；createdAt、updatedAt 必填        |
| `directoryObservation`、directory_observation          | 主键 machineId/generation/projectId/revision；machineId/generation → machine_connection；projectId/machineId → project_machine；revision、seq 为正 safe integer；checkedAt 必填；kind、realPath、reason 约束见下文                                |

machine_connection 的 seq 默认 0，必须为 SQLite integer，范围 0 到 MAX_SAFE_INTEGER。generation、revision、seq 和 highWater 的约束均拒绝浮点和精度溢出。wire 的 seq 从 1 开始，数据库 seq=0 专用于 open 后还未 exchange 的状态。

status=open 时 closedAt 必须为 null；status=closed 时 closedAt 必须非 null。seq=0 时 capability 和 lastPayloadHash 必须都为空。seq>0 时两者必须非空，hash 为 64 字符小写十六进制。capability 必须是合法 JSON object，嵌套能力结构由共享 Zod 校验。SQLite CHECK 不将 JSON `null` 视为有效能力。

directory_observation 的 accessible 必须有绝对 realPath 且 reason 为空。unavailable 必须 realPath 为空且 reason 在 missing、not_directory、denied、io_error 中。所有引用可空列的 CHECK 显式处理 NULL。SQL 不依赖 NULL 表达式隐式失败。

历史 observation 外键引用稳定 Project×Machine 身份，不引用当前 mutable revision。历史 connection 不引用 counter.highWater。推进 revision 或 highWater 不会阻止保存历史。外键不实现当前性判断，也不实现单调递增。

## 下游事务条件

enroll 保存凭据 hash，不保存原始 ticket 或 secret。同 ticket 有效期内同 secret 的成功重试幂等；不同 secret 拒绝。已激活身份通过保存的 secret 进行 open。

open 在 IMMEDIATE 事务中分配并持久化 highWater。相同 attempt 只在当前 boot、最新 generation 且会话仍有效时复用。旧 attempt 不得分配新 generation 抢回身份。分配前检查安全整数上限。

exchange 接收事务同时核对当前 boot、counter.highWater、attemptId、open、未过期心跳、seq 和当前绑定 revision。认证失败不能写事实。更大 seq 保存能力和观察，并更新 lastSeenAt。相同 seq 与相同语义载荷幂等，不回写旧 lastSeenAt；相同 seq 换载荷 conflict，较小 seq 拒绝。

`lastPayloadHash` 是这一幂等检查的持久字段。下游计算 SHA-256 小写十六进制。语义载荷为解析后的 `{ session, seq, capability, observations }`，不包含 secret、requestId 或 version。递归按对象键的 Unicode 码点顺序排序后紧凑 JSON 编码，保留数组顺序，再编码 UTF-8 后哈希。因此重试更换 requestId 不构成载荷冲突；改变观察或数组顺序构成冲突。函数实现归 host，当前单元只提供字段和约束。

close 只关闭精确匹配的当前 session，重复关闭幂等。查询也核对 boot，因此宿主重启后历史能力不会在线。目录 current 同时要求最新 generation 和当前绑定 revision。无需清理历史以推进连接和意图。

凭据不进入 argv、env、URL、日志或截图。协议模块可以解析外部 secret，但不能整体记录输入或 Zod 错误中的原始数据。Human 投影通过字段白名单构建。仅 loopback 允许 HTTP，其他 origin 要 HTTPS，拒绝 redirect 和 TLS 校验绕过；这些传输规则由下游实现。

## Risk → Test

| 风险                                  | 最低成本的真实断言                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Human 输入产生不可持久化意图          | 名称 trim、路径 NUL 和相对路径、revision 边界的 schema 测试                      |
| 长期私密身份进入 Human 投影或 barrel  | detail 拒绝额外私密字段；通用导出不存在 wire 入口                                |
| 旧会话事实混入 exchange、协议分支混用 | wire 解析测试拒绝不匹配 machine/generation/seq、重复 Project、未知版本和混合响应 |
| 跨 owner 绑定、身份复用、孤立观察     | 子进程真实迁移后直接 SQL，验证复合 FK、attempt 和凭据唯一性                      |
| mutable 当前指针阻止保留历史          | SQL 推进绑定 revision 与 highWater，同时保留两个 generation 的观察，再重复迁移   |
| SQLite NULL 语义或浮点使非法状态落库  | 直接 SQL 反证激活、连接、能力 JSON、观察组合、路径及整数范围，并保留合法对照     |

`tests/machine-contracts.test.ts` 共六项测试，其中三个通过独立 DATABASE_URL 的 tsx 子进程运行 `tests/fixtures/machine-contracts.ts`。`scripts/verify/s-machine-contracts.sh` 每次创建独立临时数据库，执行全量迁移、SQL 反证、重复迁移与针对性契约测试，输出证据目录。本单元没有已有缺陷的 red→green 声明。

本单元不验证 host 条件写、身份认证、真实 macOS 探测、HTTP 或浏览器操作。跨机 TLS、反向代理、物理断电和真机软键盘也未验证，不能从契约与 SQL 测试推断通过。
