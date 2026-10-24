# I-P4b 共享契约与数据库

本单元交付共享 schema 和新增迁移，不实现领域事务、HTTP 入口、Worker dispatcher 或 Pi 工具。实现输入为冻结的 `orchestrate/sprout-mio-p4b/design-selection.md`。租约单位为 Project × Machine；授权代次与连接代次是两个独立的计数器。工作目录不构成 OS 隔离。

## 导入清单

| 文件                              | 实际导出的 schema / 常量                                                                                                                                                                                                                                                                                                                                                                                                                                                | 实际导出的类型                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/lease.ts`          | `leaseKeySchema`, `leaseViewSchema`, `leaseMutationInputSchema`, `leaseMutationViewSchema`, `leaseReadInputSchema`                                                                                                                                                                                                                                                                                                                                                      | `LeaseKey`, `LeaseView`, `LeaseMutationInput`, `LeaseMutationView`, `LeaseReadInput`                                                                                                                                                                              |
| `src/contracts/remote.ts`         | `remoteOperationSchema`, `remoteResultPayloadSchema`, `remoteCommandSchema`, `remoteReportSchema`, `remoteFenceSchema`, `remoteFenceAckSchema`, `remoteExchangeInputSchema`, `remoteExchangeOutputSchema`, `remoteAgentRequestSchema`, `executionSubmitInputSchema`, `executionReadInputSchema`, `executionViewSchema`, `remoteToolGrantSchema`, `remoteToolInputSchemas`, `REMOTE_ERROR_CODES`, `REMOTE_EXECUTION_STATES`, `REMOTE_OUTCOMES`, `REMOTE_FAILURE_REASONS` | `RemoteOperation`, `RemoteResultPayload`, `RemoteCommand`, `RemoteReport`, `RemoteFence`, `RemoteFenceAck`, `RemoteExchangeInput`, `RemoteExchangeOutput`, `RemoteAgentRequest`, `ExecutionSubmitInput`, `ExecutionReadInput`, `ExecutionView`, `RemoteToolGrant` |
| `src/contracts/worker-session.ts` | `workerSessionSchema`, `workerSecretSchema`                                                                                                                                                                                                                                                                                                                                                                                                                             | `WorkerSession`                                                                                                                                                                                                                                                   |
| `src/contracts/worker.ts`         | 原 envelope/input/response/error/TTL 常量导出保持；`WORKER_PROTOCOL_VERSION=2`                                                                                                                                                                                                                                                                                                                                                                                          | 原 Input/Response 类型保持；session 类型移至上行文件                                                                                                                                                                                                              |
| `src/contracts/machine.ts`        | 原导出保持；新增 `REMOTE_OPERATION_KINDS`；`capabilitySnapshotSchema.remoteOperations` 改为去重数组                                                                                                                                                                                                                                                                                                                                                                     | `CapabilitySnapshot` 自动反映数组                                                                                                                                                                                                                                 |
| `src/contracts/agent-run.ts`      | 原私有 schema 改为导出 `runIdSchema`                                                                                                                                                                                                                                                                                                                                                                                                                                    | 原类型保持                                                                                                                                                                                                                                                        |
| `src/contracts/info-hub.ts`       | `projectInfoHubSchema.leases` 改为可用列表                                                                                                                                                                                                                                                                                                                                                                                                                              | `ProjectInfoHub` 自动反映新投影                                                                                                                                                                                                                                   |
| `src/contracts/result.ts`         | `APP_ERROR_CODES` 追加9项领域错误，`REMOTE_ERROR_CODES` 复用同一 readonly tuple                                                                                                                                                                                                                                                                                                                                                                                         | `AppErrorCode` / `AppError` / `AppResult` 自动包含新错误                                                                                                                                                                                                          |
| `src/contracts/ids.ts`            | `ID_PREFIXES.execution='exe'`, `.leaseMutation='lmu'`, `.remoteToolGrant='rtg'`                                                                                                                                                                                                                                                                                                                                                                                         | 复用 `AppId`，不增加品牌体系                                                                                                                                                                                                                                      |
| `src/db/schema.ts`                | `machineLease`, `leaseAuthorization`, `leaseMutation`, `workerExchangeFrame`, `remoteExecution`, `executionResult`, `remoteToolGrant`                                                                                                                                                                                                                                                                                                                                   | Drizzle 的 `$inferSelect` / `$inferInsert`                                                                                                                                                                                                                        |

Human barrel `src/contracts/index.ts` 导出 lease 全部、`executionSubmitInputSchema`、`executionReadInputSchema`、`executionViewSchema`、`remoteOperationSchema`、`remoteResultPayloadSchema`、`remoteToolInputSchemas`、`REMOTE_ERROR_CODES` 及其公开类型。它不 re-export grant、session、secret 或 Worker wire schema。私有 wire 直接导入 `remote.ts`、`worker-session.ts` 或 `worker.ts`。这些文件不依赖 Node、数据库、React 或服务端 runtime，编码长度通过标准 `TextEncoder` 计算。

`RemoteOperation` 等使用 `z.infer`，是 parse 后类型。输入中可省略的默认字段在输出类型中已经存在；需要表达未 parse 输入时使用 `z.input<typeof remoteOperationSchema>`。Command 的 shell 操作使用独立的 schema 分支，强制 `cwd` 已解析为绝对路径。

## 基础记法

以下 `O` 均为 `z.strictObject`，未知字段被拒绝；未写 `?` 的属性必须存在。`null` 与省略不同。

- `I(prefix)`：`appIdPattern(ID_PREFIXES.*)` 的前缀 UUID v4 字符串。run 使用 `runIdSchema`，格式 `run_UUIDv4`。
- `N`：整数且 `1 ≤ n ≤ 9007199254740991`。`Z`：整数且 `0 ≤ n ≤ 9007199254740991`。不做类型强转。
- `T`：`z.iso.datetime()`。wire 使用 ISO datetime，数据库新时间列使用 Unix epoch 毫秒。
- `H`：64 个小写十六进制字符。
- `P`：沿用 `macosAbsolutePathSchema`，`/` 开头、1–4096 个 JS 字符且无 NUL。允许项目目录以外的绝对路径。
- `S(n)`：无 NUL 且 UTF-8 编码不超过 n bytes 的字符串。长度按字节计算，中文和 emoji 不按字符数放宽预算。
- `WorkerSession=O({machineId:I(mch), generation:N, bootId:I(boot), attemptId:UUIDv4})`。这里的 generation 是 connection generation。
- `workerSecretSchema`：43 字符 base64url；仅定义 wire 格式，不签发凭据。

所有授权判断由服务端完成，schema 校验不代表授权。`authorizationGeneration` 不能省略，也不从连接代次推断。

## 租约与收据

```text
LeaseKey = O({projectId:I(prj), machineId:I(mch)})
LeaseView = O({...LeaseKey, generation:Z, state:free|held|fencing,
  holderInstanceId:I(ins)|null, changedAt:T, pendingMutationId:I(lmu)|null})
LeaseMutationInput = action 判别联合：
  acquire: O({...LeaseKey, action:'acquire', requestId:I(req), expectedGeneration:Z})
  release: O({...LeaseKey, action:'release', requestId:I(req), expectedGeneration:N})
  handoff: O({...LeaseKey, action:'handoff', requestId:I(req), expectedGeneration:N,
    targetInstanceId:I(ins)})
  reclaim: O({...LeaseKey, action:'reclaim', requestId:I(req), expectedGeneration:N,
    confirm:true})
LeaseReadInput = O({...LeaseKey, mutationId:I(lmu)?})
LeaseMutationView = O({...LeaseKey, mutationId:I(lmu), action:acquire|release|handoff|reclaim,
  state:pending|completed, expectedGeneration:Z, completedGeneration:Z|null,
  targetInstanceId:I(ins)|null, createdAt:T, completedAt:T|null})
```

视图还核对状态组合：free 的 holder 必须为 null；held/fencing 的 holder 非 null 且 generation>0；仅 fencing 有 pendingMutationId。handoff 恰有 target，非 acquire 的 expectedGeneration>0。pending 不可为 acquire，两个 completed 字段必须为 null。completed 的时间不早于创建时间，completedGeneration 必为 expected+1；acquire 也允许 expected 的幂等 no-op。正常读取返回 `{lease:LeaseView, mutation:LeaseMutationView|null}`；动作返回 `LeaseMutationView`，均由下游包在既有 `AppResult<T>` 内。

`projectInfoHubSchema.leases=O({available:true, items:Array(LeaseView).max(1000)})`。无租约时 items 为 `[]`。它不包含其他 Project 的租约、授权 hash 或 grant。

run 结束、释放、交接或收回不终止进程、不删文件。撤权请求可先返回 pending；完成 drain 后才 bump generation。schema 不把 pending 表达成已完成。

## 操作与结果

`remoteOperationSchema` 是 kind 判别联合：

| kind           | 输入属性（均在 O 内）                                           | 成功 payload（均含同名 kind）                                       |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| shell          | command:S(65536), cwd:P?, waitMs:Z≤10000 默认1000               | pid:N, exited:boolean, exitCode:integer                             | null, stdout:S(65536), stderr:S(8192), truncated:boolean |
| file_read      | path:P, maxBytes:N≤262144 默认65536                             | content:S(262144), truncated:boolean                                |
| file_write     | path:P, content:S(262144), mode:overwrite\|append 默认overwrite | bytesWritten:Z≤262144                                               |
| process_list   | limit:N≤200 默认100                                             | items:Array(O({pid:N,command:S(1024)})).max(200), truncated:boolean |
| process_signal | pid:N, signal:TERM\|INT\|KILL                                   | pid:N, signal:TERM\|INT\|KILL, delivered:true                       |

shell 的 exited 与 exitCode 是否非 null 必须一致。waitMs=0 是合法值，成功只表示启动/观察成功。成功 terminal report 中 exited=true 时 exitCode 必须为0。非零退出码放在失败 payload 的 partial 中。

失败 payload：`O({kind:上述五种 kind, failureReason:FailureReason, partial:同 kind 成功 payload?})`。partial 的 kind 必须相同。`remoteResultPayloadSchema` 接受成功联合或失败对象，不含任意 error message 或原生异常。

```text
FailureReason = stale_generation | not_holder | authorization_revoked | deadline |
  worker_lost | executor_error | capability_unavailable | directory_unavailable
ExecutionState = queued | dispatched | running | draining |
  succeeded | failed | rejected | timed_out | unknown
Outcome = succeeded | failed | rejected | timed_out | unknown
ExecutionSubmitInput = O({...LeaseKey, requestId:I(req), authorizationGeneration:N,
  operation:Operation})
ExecutionReadInput = O({...LeaseKey, executionId:I(exe)})
ExecutionView = O({...LeaseKey, executionId:I(exe), authorizationGeneration:N,
  holderInstanceId:I(ins), runId:I(run), chatId:I(cnv), requestId:I(req), operation:Operation,
  state:ExecutionState, createdAt:T, deadlineAt:T, terminalAt:T|null,
  failureReason:FailureReason|null, result:ResultPayload|null})
```

视图核对 deadline>createdAt，终态恰有 terminalAt 且不早于创建时间。非终态没有 failureReason/result，成功态无 failureReason，其他终态必有 failureReason。存在 result 时其 kind 必须匹配 operation，成功/失败分类须匹配 state，失败原因也须一致；timed_out 的结果必须为 deadline。unknown 可没有 result。

执行创建时服务端须固定默认值。shell.cwd 省略时服务端从 root/projectId 和 accessible observation 固定 realPath，directoryRevision 记录当时 rootRevision；显式 cwd 和其他操作的 directoryRevision=null。原始请求规范化 hash 保留 cwd 省略/显式的区别，避免 root 后来变化破坏幂等。本单元只定义 schema，不执行这一步解析。

## Pi 工具参数

下游直接使用 `remoteToolInputSchemas.<工具名>`，不重新定义参数。每个 schema 都 strict；Machine 必填，Project 从 grant 闭包注入 HTTP body。返回为 `AppResult<T>`，未实现工具注册或调用。

| 工具                         | 参数                                                                              | T                                                  |
| ---------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| sprout_lease_acquire         | machineId:I(mch), expectedGeneration:Z, requestId:I(req)                          | LeaseMutationView                                  |
| sprout_lease_release         | machineId:I(mch), expectedGeneration:N, requestId:I(req)                          | LeaseMutationView                                  |
| sprout_lease_handoff         | machineId:I(mch), expectedGeneration:N, targetInstanceId:I(ins), requestId:I(req) | LeaseMutationView                                  |
| sprout_lease_get             | machineId:I(mch), mutationId:I(lmu)?                                              | {lease:LeaseView,mutation:LeaseMutationView\|null} |
| sprout_remote_shell          | machineId:I(mch), authorizationGeneration:N, requestId:I(req), shell 输入去掉kind | ExecutionView                                      |
| sprout_remote_file_read      | 同公共执行属性，file_read 输入去掉kind                                            | ExecutionView                                      |
| sprout_remote_file_write     | 同公共执行属性，file_write 输入去掉kind                                           | ExecutionView                                      |
| sprout_remote_process_list   | 同公共执行属性，process_list 输入去掉kind                                         | ExecutionView                                      |
| sprout_remote_process_signal | 同公共执行属性，process_signal 输入去掉kind                                       | ExecutionView                                      |
| sprout_remote_execution_get  | machineId:I(mch), executionId:I(exe)                                              | ExecutionView                                      |

宿主 `sprout_status` 保持。没有默认或猜测的 Machine。Agent 无 reclaim 工具。

## Worker exchange v2

所有 enroll/open/exchange/close envelope 的 version 为2，不接受v1。五秒 poll 与现有 TTL 常量保持。session/secret 改从 `worker-session.ts` 导入，避免 worker↔remote 初始化循环。capability 的 `remoteOperations` 是上述五种 kind 的去重数组，最多5项；只宣告真实注册的能力。断联 shell 能力展示仍由下游沿用 P4a 当前事实规则。

```text
Command = O({executionId:I(exe), ...LeaseKey, authorizationGeneration:N,
  holderInstanceId:I(ins), requestId:I(req), fingerprint:H, operation:Operation,
  directoryRevision:N|null, deadlineAt:T, dispatchSession:WorkerSession, dispatchSeq:N})
Authorization = O({...LeaseKey, generation:Z, state:free|active|draining,
  holderInstanceId:I(ins)|null})
Fence = O({mutationId:I(lmu), ...LeaseKey, authorizationGeneration:N,
  executionIds:Array(I(exe)).max(64)})
FenceAck = O({...Fence, dispatchSession:WorkerSession})
Report = phase 判别联合，共同字段：
  executionId:I(exe), ...LeaseKey, authorizationGeneration:N, holderInstanceId:I(ins),
  dispatchSession:WorkerSession, dispatchSeq:N, fingerprint:H
  running: O({...共同字段, phase:'running', drained:false})
  terminal: O({...共同字段, phase:'terminal', drained:true, outcome:Outcome, payload:ResultPayload})
RemoteExchangeInput = O({results:Array(Report).max(64), fenceAcks:Array(FenceAck).max(64)})
RemoteExchangeOutput = O({authorizations:Array(Authorization).max(1000),
  commands:Array(Command).max(8), fences:Array(Fence).max(64),
  resultAcks:Array(O({executionId:I(exe), disposition:accepted|ignored_terminal})).max(64),
  fenceAcks:Array(O({mutationId:I(lmu), executionIds:Array(I(exe)).max(64)})).max(64)})
```

Command 的 shell.cwd 必填。directoryRevision 非 null 时 kind 必须是 shell。Command/Report/FenceAck 的 machineId 必须等于其 dispatchSession.machineId。Authorization 的 free holder=null；active/draining holder 非 null 且 generation>0。Fence/FenceAck/ack 的 executionIds 不允许重复。terminal report 的成功/失败 payload、shell 退出码和 timed_out 原因遵守上一节规则。schema 无法自行知道原 execution 的 operation，服务端仍须匹配 kind、holder、generation、fingerprint 和原投递身份。

```text
NormalExchange = O({version:2, requestId:I(req), secret:workerSecret,
  mode:'normal', session:WorkerSession, seq:N, capability:CapabilitySnapshot,
  observations:Array(DirectoryObservation).max(1000), remote:RemoteExchangeInput})
DrainExchange = O({version:2, requestId:I(req), secret:workerSecret,
  mode:'drain', session:WorkerSession, seq:N, remote:RemoteExchangeInput})
Success.data = O({mode:normal|drain, session:WorkerSession, seq:N,
  configuration:O({root:P|null, rootRevision:N,
    bindings:Array(O({projectId:I(prj),description:string.max(500)})).max(1000)})|null,
  remote:RemoteExchangeOutput})
```

normal 的 configuration 必须非 null；drain 必须 null，authorizations/commands 必须为空。normal 的 observations 必须匹配当前 Machine、connection generation 和 seq，Project 不重复。请求内 reports/fenceAcks 的完整 dispatchSession 必须等于当前 session；响应的授权/命令/fence 必须属于当前 Machine，命令的完整 session/seq 必须等于响应的投递身份。外层 failure 沿用原 envelope，新增 `remote_conflict`、`remote_limit` 进入 `WORKER_ERROR_CODES`。

exchange 请求和 Success.data 的**编码后总大小**在 schema 中限1MiB；单项限额不能替代总预算。服务端仍需执行2MiB原始 body 上限、按1MiB预算选择响应项，并用原帧保持幂等。schema 校验不实现选批、原帧存取或 dispatcher gate。

## Agent HTTP 私有 wire 与错误

```text
RemoteToolGrant = O({endpoint:HTTP(S) URL, secret:workerSecret, expiresAt:T, projectId:I(prj)})
RemoteAgentRequest = O({version:1, call:type 判别联合：
  O({type:'lease_mutate',input:LeaseMutationInput 的 acquire/release/handoff}),
  O({type:'lease_get',input:LeaseReadInput}),
  O({type:'execution_submit',input:ExecutionSubmitInput}),
  O({type:'execution_get',input:ExecutionReadInput})})
```

endpoint 必须无 userinfo/query/hash、路径恰为 `/api/remote/agent`；是否属于 configured APP_ORIGIN 由服务端核对。secret 只通过私有 runner 配置交付，HTTP 放在 Authorization header，不放进业务 body。TTL 为15分钟、不续期、run唯一；本单元不签发、不存 secret、不创建 endpoint。Agent response 使用现有 AppResult 外壳，认证失败401，跨界/业务拒绝是200+AppResult；不能仅按HTTP200判成功。服务端须拒绝任何 Origin header。

`REMOTE_ERROR_CODES` 直接引用 `APP_ERROR_CODES`，是同一个 readonly tuple，共16项：原有 `unauthorized`, `forbidden`, `not_found`, `validation_failed`, `conflict`, `too_many_requests`, `internal`，再加 `lease_conflict`, `lease_not_holder`, `lease_stale_generation`, `lease_fencing`, `machine_unavailable`, `directory_unavailable`, `remote_request_conflict`, `remote_grant_invalid`, `remote_run_inactive`。没有把 Worker 专属错误混入 AppError。本单元按范围不修改 `domain-errors.ts`，下游新增领域错误时必须同步 mapper。

## 有效载荷示例

以下示例为合成数据，不是凭据或远程输出。运行时 ID 使用既有 newId；每个示例只展示有界的公开形状。

```ts
import { newId, ID_PREFIXES } from "../../src/contracts/ids";
import { leaseMutationInputSchema } from "../../src/contracts/lease";
import { executionSubmitInputSchema, remoteReportSchema } from "../../src/contracts/remote";

const key = { projectId: newId(ID_PREFIXES.project), machineId: newId(ID_PREFIXES.machine) };
const requestId = newId(ID_PREFIXES.request);
leaseMutationInputSchema.parse({ ...key, requestId, action: "acquire", expectedGeneration: 0 });

const operations = [
  { kind: "shell", command: "true", waitMs: 0, cwd: "/tmp" },
  { kind: "file_read", path: "/tmp/example", maxBytes: 65536 },
  { kind: "file_write", path: "/tmp/example", content: "example", mode: "overwrite" },
  { kind: "process_list", limit: 100 },
  { kind: "process_signal", pid: 123, signal: "TERM" },
];
for (const operation of operations)
  executionSubmitInputSchema.parse({
    ...key,
    requestId: newId(ID_PREFIXES.request),
    authorizationGeneration: 1,
    operation,
  });
const payloads = [
  {
    kind: "shell",
    pid: 123,
    exited: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    truncated: false,
  },
  { kind: "file_read", content: "", truncated: false },
  { kind: "file_write", bytesWritten: 7 },
  { kind: "process_list", items: [], truncated: false },
  { kind: "process_signal", pid: 123, signal: "TERM", delivered: true },
];
const delivery = {
  ...key,
  executionId: newId(ID_PREFIXES.execution),
  authorizationGeneration: 1,
  holderInstanceId: newId(ID_PREFIXES.instance),
  fingerprint: "a".repeat(64),
  dispatchSeq: 1,
  dispatchSession: {
    machineId: key.machineId,
    generation: 1,
    bootId: newId(ID_PREFIXES.boot),
    attemptId: crypto.randomUUID(),
  },
};
for (const payload of payloads)
  remoteReportSchema.parse({
    ...delivery,
    phase: "terminal",
    drained: true,
    outcome: "succeeded",
    payload,
  });
remoteReportSchema.parse({
  ...delivery,
  phase: "terminal",
  drained: true,
  outcome: "timed_out",
  payload: { kind: "shell", failureReason: "deadline", partial: payloads[0] },
});
```

最小 normal 的 remote 输入为 `{results:[],fenceAcks:[]}`；最小 remote 输出为 `{authorizations:[],commands:[],fences:[],resultAcks:[],fenceAcks:[]}`。drain 使用同一个 session 和下一个 seq，但省略 capability/observations，返回 configuration=null。完整 request 仍必须提供 version、requestId 和私有 secret，不在文档打印 secret 示例。

## SQLite 迁移与 Drizzle 映射

新增 `drizzle/0009_hard_chameleon.sql`、`drizzle/meta/0009_snapshot.json`，journal 仅追加第9项。既有表只加 `agent_instance_id_project_unique(id,project_id)` 和 `agent_run_bound_identity_unique(id,instance_id,project_id,chat_id)`，未重建旧表或修改已合并迁移。

| SQL 表 / Drizzle 导出                       | 键和约束                                                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| machine_lease / machineLease                | PK(project_id,machine_id)，FK binding/同Project holder；generation为Z，非free必须>0；free恰无holder；changed_at为非负整数毫秒；更新generation只允许不变或+1                                                                                          |
| lease_authorization / leaseAuthorization    | PK(project,machine,generation)，复合唯一含holder；同Project holder FK；live free/active/draining 部分唯一；generation为Z；free/active/draining/revoked各自NULL-safe holder/revoked_at组合；issued_at非负整数，撤销时间不早于签发时间                 |
| lease_mutation / leaseMutation              | id PK；actorKind+actorId+requestId唯一；同lease一个pending部分唯一；expected/completed generation FK；handoff恰有target且同Project；agent只acquire/release/handoff，human只reclaim；pending/completed完整NULL-safe时间/代次组合                      |
| worker_exchange_frame / workerExchangeFrame | PK(machine,connection_generation,seq)，FK connection；connection_generation/seq为N；hash为H，response_json必须是JSON object，created_at非负整数                                                                                                      |
| remote_execution / remoteExecution          | id PK；holder+requestId唯一；复合唯一含Project/Machine/代次/holder；授权历史及run精确复合FK；delivery frame延迟FK；代次为N；directory_revision为N或NULL；operation_json必须object；投递列全空或完整；drained/terminal及failure_reason按状态组合CHECK |
| execution_result / executionResult          | execution_id PK；精确execution/Project/Machine/代次/holder FK；封闭outcome；H hash、object JSON；recorded_at非负整数。结果不可覆盖由事务实现，DB不额外加UPDATE trigger                                                                               |
| remote_tool_grant / remoteToolGrant         | id PK；secret_hash H且唯一、run唯一；Project owner/run身份复合FK；issued_at非负整数、expires_at>issued_at；revoked_at NULL或整数且≥issued_at                                                                                                         |

完整 CHECK SQL 以新增迁移为准。所有新 FK 为 NO ACTION；不使用 CASCADE。时间在 Drizzle 为 `integer(...,{mode:'timestamp_ms'})`，读写使用 Date；其他数值为 number。JSON 列使用 json mode：`operationJson:RemoteOperation`、`payloadJson:RemoteResultPayload`、`responseJson:WorkerExchangeResponse` 成功 data 类型；底层 SQL 仍为 TEXT。状态列使用 enum 类型，并保留真实 CHECK。

Drizzle 生成器没有重建既有表。部分唯一索引用 `.where(sql\`...\`)`表达。Drizzle 的 SQLite FK API / snapshot 不表达`DEFERRABLE INITIALLY DEFERRED`，generation trigger 也不在 snapshot 中；因此仅在本次新迁移中加入这两项 SQL。日后不能只用 snapshot 重建数据库或删掉这两项，须运行迁移。独立验证证明 execution 可以先更新delivery再插frame，缺frame的事务在COMMIT失败并回滚。

**历史 FK 的边界**：授权历史保留旧代次，所以一个存在且已 revoked 的旧授权仍能满足 remote_execution 的历史 FK。冻结 SQL 不判断它是否“当前授权”。真实 SQLite 测试明确证明：0代次被CHECK拒绝，不存在的旧代次/跨holder/跨Project被FK拒绝，但存在的revoked代次可作历史引用。下游必须在同一 immediate 事务核对 machine_lease 当前generation、held holder及active授权。这里的 SQL 反证不能替代 N5 的 HTTP旧代次拒绝、真实dispatcher旧帧重放拒绝或N6撤权drain。

租约generation trigger允许初始插入任意Z，保证UPDATE不回退/不跳号；初始化free/gen0和授权历史不可改身份仍是领域事务责任。没有添加租约TTL、run结束自动释放、信号或文件清理逻辑。

## Risk → Test 与复跑

| 风险                                                   | 最低成本真实证据                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 同Project重复持租、跨Project holder或run冒用           | 子进程真实迁移/SQLite PK、部分唯一、复合FK；同Machine不同Project并存               |
| 代次回退/跳号、缺失授权与历史代次被误当当前            | SQLite trigger/FK/CHECK；明确保留历史FK反例；command/submit缺代次或0代次拒绝       |
| SQLite把NULL CHECK当通过、超安全整数或半套投递数据漏过 | SQLite参数化反例；nullable时间/修订、终态组合、object JSON；deferred COMMIT及回滚  |
| 伪造执行状态/结果、错session/seq、UTF-8和总预算超限    | 公开schema测试：封闭状态、partial同kind、shell退出、normal/drain隔离、1MiB总预算   |
| 凭据外泄与客户端身份伪造                               | Human barrel导出检查、strict投影拒绝hash、Agent schema拒绝reclaim、工具Machine必填 |
| run生命周期误删lease或历史                             | 真实SQLite将run置终态后租约不变，删除run由NO ACTION FK拒绝                         |

执行 `bash scripts/verify/v-lease-contracts.sh`。脚本创建自己独有的 DATABASE_URL，真实迁移、SQL反证、重跑迁移和7项契约测试，不使用共享库；退出时仅清除自己创建的验证目录。`tests/fixtures/lease-contracts.ts` 的输出仅含固定PASS行，不打印操作内容、凭据、hash或私有SQLite内容。

首次新测试失败于free/gen0与acquire/expected0被错误的正整数复用排除；修正为独立非负安全整数后通过。该证据验证零代次tombstone契约。新功能没有既存旧实现可做完整功能red→green。

全量 check/typecheck/test 仍须由下游同步 v2 调用方、remoteOperations 数组和 leases 可用投影后复跑。此单元不修改Worker client、server functions、正式UI或旧验收脚本；因此全量检查的这些失败是集成接入缺口，不能标记整个I-P4b完成。真实macOS Worker/服务/HTTP/Chromium新账号、跨机网络和真机软键盘均不在本单元证据内。
