# R1（MCP tools 接入）第六轮独立验收

- 仓库：`/Users/snake/workspace/sprout-mio`
- head：`22fe0fbcbf3de6b6ec955942c4c1bd1395726bff`
- 只读执行：未修改仓库任何文件（验收前后 `git status --short` 均为空）；所有变异在 `/tmp/r6-manual`、`/tmp/r6-resid` 的独立 clone 中完成，临时产物只在 `/tmp`。
- 执行者：poteto-agent（独立验收角色）

---

## 1. 结论

**不通过（部分通过）。** 第五轮的两条主因都已经真实修好并由我复现：

- **C4 drain 契约冲突**：修复有效，且有一条会因回退而实质变红的集成测试。
- **M1–M6 六种证据生产端变异**：14 个变异 case 我全部实跑，目标条款都 FAIL、门禁 exit 1、无 INCONCLUSIVE、无原始值泄漏。

但 R1 技术验收仍不能判「通过」，原因有两条，都是我实测得到的、不是推测：

1. 门禁仍有**同类**未被覆盖的证据生产端伪造路径（至少三条，见 §3.3），其中一条能让「stdio 与 streamableHttp 真的跑通 + 官方 SDK 真连过」在官方 SDK 一次都没连的情况下保持 R1-1 PASS。
2. `docs/r1/summary.md` 与当前门禁/代码**实质不符**：它仍把 v3/v4 已修好的部分描述为未修，把「技术验收未通过」的原因写成第五轮状态，并宣称 drain 修复「主 checkout 尚未重跑完整 z3」（实际已重跑，我本轮也重跑）。R1-7 明确不校验文档语义，所以这不是门禁红，而是必须记录、且应由文档所有者修掉的交付缺陷。

补一句判断口径：七条**行为**我认为是真的；不通过的是「这七条行为已被证据链独立证明」这件事。

---

## 2. 七条逐条判定

基线运行（我自己跑的）：

```
$ bash scripts/verify/z3-mcp-acceptance.sh
PASS R1-1 .verify/z3-mcp-acceptance-3Qyw4G/clause-1.json
PASS R1-2 .verify/z3-mcp-acceptance-3Qyw4G/clause-2.json
PASS R1-3 .verify/z3-mcp-acceptance-3Qyw4G/clause-3.json
PASS R1-4 .verify/z3-mcp-acceptance-3Qyw4G/clause-4.json
PASS R1-5 .verify/z3-mcp-acceptance-3Qyw4G/clause-5.json
PASS R1-6 .verify/z3-mcp-acceptance-3Qyw4G/clause-6.json
PASS R1-7 .verify/z3-mcp-acceptance-3Qyw4G/clause-7.json
EXIT=0
```

另一次基线（`.verify/z3-mcp-acceptance-YJO1nz`）同样 exit 0、七条 PASS；把它的 `clause-*.json` 与 `docs/r1/evidence/` 逐字段 diff，**只差 `startedAt`/`elapsedMs`（以及 clause-7 的 `head`）**，说明快照可由当前脚本确定性复现。

| 条款 | 判定 | 我的依据 | 证据端是否可信 |
| --- | --- | --- | --- |
| R1-1 stdio 与 streamableHttp | PASS（行为）/ 证据端有洞 | y2 真实打包 Worker CLI + x2 真中继；`observed.toolsListMatchesExpected` 由门禁用自己的 20 工具名单与 x2 私有原始名单独比对（v4 修复，我用手工 M1 复现变红） | 部分：`officialSdk` 只核版本，不核连接（§3.3-②） |
| R1-2 Pi 工具面 / allowlist / 显式登记 | PASS（行为）/ 证据端有洞 | 真实 Pi AgentSession，5 个 `mcp__*`、read 可执行、notify 不注册、host_sentinel 不进 catalog 且未启动 | 部分：`predicates.mcpTools` 仍接受 `['mcp__']`（§3.3-③） |
| R1-3 指定实例 / root 隔离 / 不改投 | PASS | 两个独立 stdio server；`observed.crossRootReadRejected` / `crossRootWriteRejected` 由门禁读 root 调用日志重算（v4，手工 M3 由驱动+报告证实变红） | 可信（该两条已 gate-computed） |
| R1-4 图片与 structuredContent | PASS | `x3ImageBytesEqual` / `x3StructuredContentEqual` 由门禁对私有原始观察值（含 SHA 承诺）自己算；两个 M2 变异实测 R1-4 FAIL | 可信（x3 路径）；`c.image.bytesEqual/structuredContentEqual` 仍是探针自报，但不再是唯一依据 |
| R1-5 资源 / 目录变化 / 重建 / 超时 / 旧代次 | PASS | `requestReachedServer`、`oldGenerationRejected` 均由门禁重算（含自己打开 SQLite 数 `mcp_frame`）；M5/M6 实测 FAIL | 可信（该两条已 gate-computed） |
| R1-6 生命周期与已有服务 | PASS | `configuredServiceExited` 由门禁自己 `process.kill(pid,0)` 判 ESRCH；手工 M4 实测 R1-6 FAIL | 可信（终止事实）；不证明「为什么终止」（报告已自认） |
| R1-7 组合与纳入阶段 | PASS（是它声明的那种检查） | 文档存在、design 关键词、summary/scope 关键词、`scriptSha256` 等于当前脚本、`sourceCommit` 是 HEAD 祖先 | 只做一致性，不做语义（见 §5/§6） |

判定说明：七条**行为**没有再发现新的产品缺陷；问题都在「证据端能否独立支撑这个 PASS」。上一轮已经确立「PASS 但证据端可伪造 = 不算通过」的口径，本轮沿用。

---

## 3. 门禁变异抵抗性（实测）

### 3.1 驱动实跑

```
$ python3 scripts/verify/z3-mcp-acceptance-mutations.py
... 14 行 JSON ...
{"baseline":"22fe0fbcbf3de6b6ec955942c4c1bd1395726bff","cases":14,...}
EXIT=0
```

我逐条打印（`rawVis` 为驱动对 stdout / run.log / clause-*.json / evidence 的泄漏扫描结果）：

```
clean                                         exit=0  1PASS 2PASS 3PASS 4PASS 5PASS 6PASS 7PASS  rawVis=False
image-comparison-removed                      exit=1  1PASS 2PASS 3PASS 4FAIL 5PASS 6PASS 7PASS  rawVis=False
structured-comparison-removed                 exit=1  1PASS 2PASS 3PASS 4FAIL 5PASS 6PASS 7PASS  rawVis=False
raw-observation-path-removed                  exit=1  1PASS 2PASS 3PASS 4FAIL 5FAIL 6PASS 7PASS  rawVis=False
raw-observation-path-swapped                  exit=1  1PASS 2PASS 3PASS 4FAIL 5PASS 6PASS 7PASS  rawVis=False
raw-observation-path-removed-probe-succeeds   exit=1  1PASS 2PASS 3PASS 4FAIL 5PASS 6PASS 7PASS  rawVis=False
x3-evidence-removed-after-success             exit=1  1PASS 2PASS 3PASS 4FAIL 5FAIL 6PASS 7PASS  rawVis=False
x3-observations-removed-after-success         exit=1  1PASS 2PASS 3PASS 4FAIL 5PASS 6PASS 7PASS  rawVis=False
observation-not-a-png                         exit=1  1PASS 2PASS 3PASS 4FAIL 5FAIL 6PASS 7PASS  rawVis=False
tools-list-comparison-removed                 exit=1  1FAIL 2PASS 3PASS 4PASS 5PASS 6PASS 7PASS  rawVis=False
cross-root-read-assertion-removed             exit=1  1PASS 2PASS 3FAIL 4PASS 5PASS 6PASS 7FAIL  rawVis=False
configured-service-liveness-hardcoded         exit=1  1PASS 2PASS 3PASS 4PASS 5PASS 6FAIL 7PASS  rawVis=False
timeout-probe-hardcoded                       exit=1  1PASS 2PASS 3PASS 4PASS 5FAIL 6PASS 7FAIL  rawVis=False
stale-generation-constant                     exit=1  1PASS 2PASS 3PASS 4PASS 5FAIL 6PASS 7FAIL  rawVis=False
```

与 `gate-audit-v4.md` §4.2 的表逐行一致。目标条款的 `error` 我全部读过，都是意图字段：

- `R1-1: toolsListMatchesExpected at observed.toolsListMatchesExpected must equal true`（`false !== true`）
- `R1-3: crossRootReadRejected at observed.crossRootReadRejected must equal true`
- `R1-6: configuredServiceExited at observed.configuredServiceExited must equal true`
- `R1-5: requestReachedServer at observed.timeoutRequestReachedServer must equal true`
- `R1-5: oldGenerationRejected at observed.oldGenerationRejected must equal true`

### 3.2 驱动判据与我自己手搓的两个变异

驱动判据我读过：`run_case()` 要求 `statuses[target] == "FAIL"`，显式拒绝 `PASS`（记「mutation is not detected」）与 `INCONCLUSIVE`（记「must be rejected as FAIL」），并要求 `returncode != 0`；另有 §3.1 的泄漏扫描。这比「退出码非 0 就算过」严格，**判据本身没问题**。

手工复现（在 `/tmp/r6-manual` 独立 clone，非驱动）：

**① tools-list-comparison-removed（改 fixture）** —— 两处 fixture 改动：
`isDeepStrictEqual(rawToolNames, expectedToolNames)` → 自身比较；`rawToolNames` 末尾 `.slice(1)`。实跑：

```
FAIL R1-1 .verify/z3-mcp-acceptance-SF0wLf/clause-1.json
PASS R1-2..R1-7
EXIT=1
clause-1 error: R1-1: toolsListMatchesExpected at observed.toolsListMatchesExpected must equal true
                false !== true
```

只有 R1-1 红，无连带，红的原因就是目标字段。

**② configured-service-liveness-hardcoded（改脚本内嵌模板）** —— y2 fixture 改成 SIGKILL、`waitFor(()=>true)`、`aliveAfterWorkerExit:false` 字面量、并删掉清除幸存者的分支。实跑：

```
PASS R1-1..R1-5
FAIL R1-6 .verify/z3-mcp-acceptance-krUXM6/clause-6.json
PASS R1-7
EXIT=1
clause-6 error: R1-6: configuredServiceExited at observed.configuredServiceExited must equal true
                false !== true
```

同样只有目标条款红。这两条直接否掉了「驱动只是自报」的怀疑。

### 3.3 连带 R1-7 是否掩盖真实拦截

M3/M5/M6 改的是 z3 脚本本身，所以 `evidenceScriptCurrent` 必然变红（`rawObservationPath` 也印证：`7FAIL`）。我确认这是**无害副作用、不是掩盖**：

- 目标条款自己的 `error` 是意图字段（上面五条），不是 sha 不匹配；
- 如果把 `docs/r1/evidence/evidence.json` 的 `scriptSha256` 同步刷新（我在 §3.4 的三个残留实验里就这么做），目标条款依然红/绿如预期，说明拦截不依赖 R1-7。
- 副作用带来的一个真实限制：凡是改 z3 的变异都会连带 R1-7 红，因此「只看总 exit code」无法区分「目标条款拦截」和「只是脚本变了」——必须读 clause JSON。驱动和 v4 报告都要求读 clause JSON，这一点没问题。

### 3.4 同类未被覆盖的伪造路径（三条，全部仍在，全部我实测）

第五轮点名过三条，本轮门禁（v3/v4）**没有修它们**，我逐条复现。三例都在独立 clone 里改「证据生产端」并把快照 `scriptSha256`/`sourceCommit` 同步到变异版本（与第五轮报告同样手法），因此 R1-7 不干扰结论。

**① `officialSdk` 从不连接官方 SDK，R1-1 仍 PASS**

把 z3 内嵌的 `checked('officialSdk', ...)` 改成只读磁盘版本、返回
`{stdioConnected:false, stdioToolCount:0, streamableHttpConnected:false, httpToolCount:0}`：

```
$ bash scripts/verify/z3-mcp-acceptance.sh   # /tmp/r6-resid
PASS R1-1 ... PASS R1-7
EXIT=0
```

原因：`REQUIRED[1]` 只有 `officialSdkVersion` 一个 SDK 字段，且 `requireProbe('officialSdk')` 只信 C 探针自报的 `status:'PASS'`；`stdioConnected`/`stdioToolCount`/`streamableHttpConnected`/`httpToolCount` 门禁**一个都不读**。第五轮结论「`officialSdkVersion` 不证明真连过官方 SDK」仍然成立。

**② 删掉 `passed('y2')` 后 y2 的红退出码在 R1-1 不再被核**

把 y2 脚本追加 `exit 1`（evidence 已写、产物完整），再删掉 R1-1 body 里的 `passed('y2');`：

```
基线（保留 passed('y2')）：R1-1 FAIL  R1-5 FAIL  R1-6 FAIL  EXIT=1
删掉 passed('y2') 后：      R1-1 PASS  R1-5 FAIL  R1-6 FAIL  EXIT=1
```

也就是说：**R1-1 可以在 y2 明确失败的情况下保持 PASS**。R1-5/R1-6 仍会红，所以整包不会被完全绕过，但第五轮点名的这条路径在 R1-1 上确实没有被修。根因是 `REQUIRED` 只放证据字段，探针退出码只由 body 里的 `passed()` 显式调用，删掉即失守。

**③ `predicates.mcpTools` 仍接受 `['mcp__']`**

把内嵌 C 探针的 `activeMcpTools` 返回值改成字面量 `['mcp__']`（其余 surface 字段保持 true）：`R1-2 PASS`。门禁对该字段只要求「非空数组且每项以 `mcp__` 开头」，不钉 5 个真实工具名——而同一脚本对 x2 的 20 个工具名有精确名单（v4 的做法），说明这不是能力问题而是遗漏。

三条的性质与 M1–M6 完全同类（改证据生产端 → 探针 exit 0 → 门禁绿），只是对象不同。因此「门禁已能抵抗证据生产端伪造」这个一般性结论**不成立**；成立的是「门禁已能抵抗 v4 列出的那五个具体变异」。

---

## 4. C4 drain 修复实测

### 4.1 代码

- `src/server/remote.ts`：`applyRemoteExchange` 增加重载，`mode:"drain"` 返回窄类型 `DrainProjection`（`fences/resultAcks/fenceAcks/logAcks/mcp/mcpCursors`）；授权只在此前已存在的 `ctx.mode === "normal"` 分支里 push；drain 在命令/取消构建前提前返回投影。
- `drainRemoteResponse(projection)` 补 `authorizations: []`、`commands: []`、`cancellations: []`。
- `src/server/worker-gateway.ts:369` drain 分支用 `drainRemoteResponse(applyRemoteExchange(..., mode:"drain"))`；normal 分支（:316）不变。
- `src/contracts/worker.ts` 的 `workerExchangeResponseSchema.superRefine` 明确：`mode==="drain"` 时 `authorizations.length>0 || commands.length>0` 即报错。
- 唯一的 drain 调用点就是 `worker-gateway.ts`；normal 与 drain 都已覆盖，无其他调用点。

### 4.2 覆盖它的测试

- `tests/worker-remote-domain.test.ts`（vitest，spawn fixture）实跑 **PASS**（1 test, 676ms）。
- `bash scripts/verify/w-worker-remote.sh` 实跑 **PASS，EXIT=0**。
- `tests/fixtures/worker-remote-domain.ts:275-284` 在**已持有租约**（generation 5→6）的状态下发 `mode:"drain"`，断言 `authorizations/commands/cancellations` 长度均为 0，然后把整个响应交给 `workerExchangeResponseSchema.safeParse(...) === true`。断言对象是「Worker schema 能接受这个响应」，不是「函数返回了某个形状」。

### 4.3 「删掉 drain 投影，哪个检查会红」——我直接做了

- 只删 `worker-gateway.ts` 的 `drainRemoteResponse(...)` 包装：`tests/worker-remote-domain.test.ts` **变红**（`drainResponse.remote.authorizations` 为 `undefined` → TypeError）。这是形状性红。
- 完整回退到修复前（`applyRemoteExchange` drain 也返回带授权/命令的完整 remote，并去掉网关投影）：**实质变红**。

```
AssertionError: Expected values to be strictly equal:
2 !== 0
at tests/fixtures/worker-remote-domain.ts:275:8   # assert.equal(drainResponse.remote.authorizations.length, 0)
```

`2` 正是两个活动租约。所以：**有真测试，且红的是目标断言，不是旁路原因。**

附带发现（不是缺陷，是去重信息）：`remote.ts` 的窄化与 `worker-gateway.ts` 的 `drainRemoteResponse` 是**双层**投影。只删 `remote.ts` 的窄化（保留网关投影）时测试仍绿——因为网关会再投影一次。这层冗余不影响正确性，但说明这两层里任意单层并不是回归检测点；真正的检测点是组合路径。

### 4.4 判定

**C4：PASS。** 产品契约冲突已修；drain 响应确实不含 authorization/commands/cancellations；有真实集成测试，且回退会实质变红。

---

## 5. 证据与文档缺陷

### 5.1 十份快照与当前脚本自洽（通过部分）

- `docs/r1/evidence/*.json` 10 个文件 SHA-256 与 `gate-audit-v4.md` §4.4 表逐项一致；`evidence.json.scriptSha256 = 5f5fe21e…f34` 等于当前 `scripts/verify/z3-mcp-acceptance.sh`；`sourceCommit = 2325d66…` 是 HEAD 祖先。R1-7 绿。
- 我的新运行可确定性复现快照（只差时间戳）。
- 泄漏扫描：`docs/r1/evidence/` 下无 200+ 连续 base64 串、无绝对路径、无 SQLite 内容、无 structuredContent 正文；命中的 `base64`/`StructuredContent`/`sqlite`/`root-1` 全是字段名或工具名。`c-evidence.json` 只含布尔/计数/工具名/错误码。

### 5.2 缺陷 1（证据溯源不自洽，必须记录）

`docs/r1/evidence/evidence.json` 声称 `sourceCommit: 2325d66`，但 **2325d66 这个 commit 里的 z3 脚本 SHA 是 `466ba0a8…`，不是快照记录的 `5f5fe21e…`**。产生该快照的脚本内容在 `22fe0fb`（当前 HEAD）里。

```
$ git show 2325d66:scripts/verify/z3-mcp-acceptance.sh | shasum -a 256
466ba0a8035811fba702b1bdbd7db016a96870af23db03bca50eed690ee5af94
$ git show 22fe0fb:scripts/verify/z3-mcp-acceptance.sh | shasum -a 256
5f5fe21e6cfa1b8773113a37213be4d2300fb9298b1eef62cbdbcdaeab2b4f34
```

R1-7 只查「祖先」，所以仍绿。结论：快照是从未提交的工作树产物采集的，`sourceCommit` 不足以复现它（checkout 2325d66 后无法得到同 SHA 的脚本）。要么在包含该脚本的 commit 上重跑并刷新 `sourceCommit`，要么额外记录「产生快照的树」。**不影响七条行为结论，但影响「可发布证据」的可复现性**。

### 5.3 缺陷 2（summary.md 明显落后于 v3/v4，逐条核对）

`docs/r1/summary.md` 仍停留在第五轮状态。具体不符之处（要点，不含措辞偏好）：

1. 开头「R1 整体技术验收未通过……第五轮证明 z3 仍可被证据生产端变异绕过」——未反映 v3/v4 及本轮 14 个变异全部被拒。
2. 「**上面这一条只约束条款 body，不约束证据生产端。门禁读到的是探针自己写进 evidence 的布尔值**」——这句现在是**部分错误**。v3/v4 之后，R1-1 的 `toolsListMatchesExpected`、R1-3 的跨 root 两项、R1-4 的 x3 两项、R1-5 的 `requestReachedServer`/`oldGenerationRejected`、R1-6 的 `configuredServiceExited` 都由门禁从私有原始观察值/SQLite/进程状态自己算，不是读探针布尔。
3. 同段落列举的三个例子：`predicates.mcpTools`、`officialSdkVersion`、删 `passed('y2')`——**都还在**（我在 §3.4 逐条复现）。所以这条「同类还有」清单应保留，但不能继续用「门禁只读探针布尔」这一总括句来支撑。
4. 「第四轮实测：把 x3 的 structuredContent 比较整体删掉……z3 七条全 PASS」——现在**已不成立**（`structured-comparison-removed` 实测 R1-4 FAIL）。
5. drain 段：「随后 `3d0a0e4` 为 drain exchange 加上窄投影……主 checkout 尚未重跑完整 z3 与全量 verify」——`3d0a0e4` **不在 main 上**（只在 `r1/drain-fix` 分支；main 上是 `f7f1c0c`，两者仅格式化差异）；且 z3 已重跑并刷新快照（`efc7c28`、`d5d3907`、`2325d66`、`22fe0fb`），我本轮也重跑。
6. 末段「第五轮独立验收报告……技术验收仍待门禁整改与复验」「z3 仍不能独立证明探针实际执行其声称的比较或故障路径」——后半句在 v4 之后已被部分推翻（见第 2 点），至少需要限定为「`officialSdk`、C 探针 surface/image 自报字段仍未由门禁重算」。
7. summary 完全未提及 v3/v4 的门禁整改，也没有记录这批整改引入的 `gateComputed` 证据字段。

这属于交付文档缺陷，不属门禁红。按仓库 `AGENTS.md` 的「文档不由门禁保证语义」约定，责任在文档所有者/编排者，不在本轮验收者。

### 5.4 `docs/core-scope.md`

第 112 行仍把 **MCP tools 接入** 列为明确的后续交付能力，写明触发条件（P4c 身份与授权契约稳定、R1 独立验收通过、Human 确认）与「条件满足后在 P4c 之后纳入一期」。**符合要求，未见缺陷。**

---

## 6. 未验边界（明确列出）

以下行为**没有被 z3 门禁覆盖**；有些被其他 domain test 覆盖，标注清楚：

1. **真实模型自动选择 MCP 工具的一轮推理**：未验（无付费模型推理）。summary 已如实声明。
2. **官方 SDK 真实连接**：门禁只比对版本字符串（§3.4-① 实测可绕过）。行为本身在 C 探针里有真实连接代码，但门禁不核。
3. **Pi 工具面内容**：门禁只核「非空且都以 `mcp__` 开头」，不钉 5 个真实工具名（§3.4-③）。
4. **220 条积压 / 8192 字节预算下的 attach**：不在 z3 里；被 `tests/mcp-worker-domain.test.ts`（含 `tests/fixtures/mcp-ack-backlog.ts`，第 195/240/252 行）覆盖，我实跑 3 tests PASS。但门禁 PASS 不构成对它的证明。
5. **drain exchange 契约**：不在 z3 里；只有 `tests/worker-remote-domain.test.ts`（+ `pnpm test`）覆盖，我实跑 PASS。
6. **R1-7 只做脚本/提交一致性**：不校验 summary/design 的语义，也不校验 `sourceCommit` 是否包含产生快照的脚本（§5.2 就是它没抓住的例子）。
7. **探针退出码与条款的绑定**：R1-1 的 y2 退出码只靠 body 里的 `passed('y2')` 显式调用，删掉即失守（§3.4-②）。
8. **sampling / elicitation**：生产 runner 无 sampling handler，elicitation 仅 absent/cancel；无真实模型采样或 Human 表单交互。
9. **Unity / Blender 插件**：未验，不属本轮 PASS 范围。
10. **`session_fence.closed` 无生产写入点**：P4b 遗留，R1 未接也未删。
11. **M4 只证明「configured_service 已终止」，不证明终止原因**（报告 §5.3 已自认；我复核成立）。
12. **变异驱动本身**：14 个 case 依赖 `pnpm install --offline` 成功与约 30s/case 的隔离副本；它不覆盖「把整个门禁换成打印七条 PASS 的桩」这类更极端的攻击（那种情况下目标条款仍可能被伪造为 PASS，因为驱动只读门禁输出）。这是威胁模型的边界，不是本轮的回归。

---

## 7. 对三份整改报告的采信与反驳

### `gate-audit-v3.md`（M2 / R1-4 证据端）

- **采信**：`observed.x3.imageBytesEqual`/`x3StructuredContentEqual` 确实由门禁从带 SHA 承诺的私有原始观察值重算；`raw-observation-path-*`、`x3-*-removed-after-success`、`observation-not-a-png` 六种变异我实跑全部 R1-4 FAIL；无原始值泄漏。
- **补充（非反驳）**：`REQUIRED[4]` 仍保留 `c.image.bytesEqual`/`c.image.structuredContentEqual` 两个探针自报布尔。它们已不是唯一依据，所以不再构成伪造路径；但「探针不再发布结论布尔」这句在 C 探针上不成立（x3 上成立）。

### `gate-audit-v4.md`（M1/M3/M4/M5/M6）

- **采信**：14 case 表与我的实跑逐行一致；目标条款 error 都是意图字段；无 INCONCLUSIVE；clean baseline 绿；`rawVis=False` 全为真；§4.4 十个 SHA 与当前文件逐一相符；§6 的脚本/夹具 SHA 也与当前文件一致。
- **指出（措辞夸大）**：§3「each mutation makes the gate print FAIL on exactly the clause that owns the observation」用「exactly」过强——M3/M5/M6 同时把 R1-7 打红（它自己的表里也列了）。表是准的，散文应写成「至少目标条款红，改脚本时会连带 R1-7」。
- **指出（范围局限）**：v4 只声明修 M1–M6；它没有、也没有声称修 `officialSdk`、`mcpTools`、`passed('y2')` 三条同类路径。所以不能由 v4 推出「门禁已抵抗证据生产端伪造」。
- **指出（溯源）**：v4 说「Snapshot `sourceCommit` is `2325d66…`, an ancestor of HEAD」并把「是祖先」当作通过依据。事实是祖先，但该 commit 不含产生快照的脚本（§5.2）。报告把它写成「currency check 通过」是准确的，但读者容易误以为可复现。

### `acceptance-round5.md`（上一轮验收）

- **采信**：C4 的观察（真实 gateway drain 响应带 authorization → Worker schema 拒收）成立，且 f7f1c0c 修复后我用回退实验确认整条链会实质变红。
- **确认仍开放**：第五轮列出的三条同类路径全部仍在（§3.4）。第五轮「门禁证明充分性 FAIL」的判断在当时成立；v3/v4 之后应细化为「部分修复，三条同类仍在」。
- **反驳一处**：第五轮 C4 行说「当前完整 drain 响应契约受阻」——现在已不成立。

### 整体

三份报告**没有发现凭空捏造**：所有可核对的数字、SHA、变异表、错误信息都与我实测一致。问题有两类：(a) v4 的散文比其表更强；(b) 三份报告都只在自己的范围内诚实，**没有一份把「同类的另外三条伪造路径仍然开放」放到显著位置**，而对下游读者来说，「门禁已整改」很容易被读成「门禁可信」。这一点必须由 summary 修正来兜底，而 summary 恰恰没改。

---

## 8. 明确回答

**R1 的技术验收现在是否通过？——不通过（部分通过）。**

- **已通过并清掉的**：C4 drain 契约修复（代码 + 真实集成测试 + 回退实质变红）；第五轮 M1–M6 六类证据变异（14 case 全部目标条款 FAIL、exit 1、无 INCONCLUSIVE、无泄漏、clean baseline 绿）。
- **仍不过的**：门禁还有三条同类证据生产端伪造路径（§3.4），其中 `officialSdk` 那条能让 R1-1 在官方 SDK 从未连接时保持 PASS；`passed('y2')` 那条能让 R1-1 在 y2 明确失败时保持 PASS；`mcpTools` 那条能让 R1-2 用单个 `mcp__` 通过。加上 summary.md 与代码/门禁实质不符（§5.3）与证据 `sourceCommit` 不可复现（§5.2）。
- **需要谁做什么**：
  1. 门禁所有者（下一轮 gate 整改）：把 `officialSdk` 的连接事实（`stdioToolCount`/`httpToolCount` > 0、传输列表）纳入 `REQUIRED` 并由门禁重算或至少交叉核验；把 `mcpTools` 谓词钉成真实 5 个工具名（照抄 v4 对 x2 的精确名单做法）；把探针退出码折进 `REQUIRED`，或保留 `passed()` 时加一条「每个被引用探针的 exitCode 必须为 0」的全局校验。
  2. 文档所有者：按 §5.3 重写 summary 的「已知限制」与头部结论，补记 v3/v4 的 `gateComputed` 字段与 14 个变异结果，修正 `3d0a0e4` 引用与「尚未重跑 z3」的过期表述。
  3. 证据所有者：在包含当前 z3 脚本的 commit 上重跑一次并刷新 `sourceCommit`（或在 evidence.json 里记录产生快照的树 SHA），使快照可复现。
  4. 独立验收：上述三项完成后，至少复跑 `z3` + `z3-mcp-acceptance-mutations.py` + 三条残留路径的复现脚本，再判 R1 收口。

七条**行为**本身在本轮没有发现新的产品级失败；不通过的是证据链的完备性与文档一致性。
