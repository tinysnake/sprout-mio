# R1（MCP tools 接入）第七轮独立验收

- 仓库：`/Users/snake/workspace/sprout-mio`
- 验收起点 head：`c7e4b5959c08a51aaa6dbfada177e2ba49d6b19f`（`docs(r1): summary 反映 v3-v5 门禁整改与第六轮验收结论`）
- 验收期间 head 漂移：另一并发任务在 20:54 提交了 `be082db`（只格式化 `docs/r1/acceptance-round6.md`，未动 `scripts/**`、`docs/r1/evidence/**`、`docs/r1/summary.md`）。本报告结论对两者同时成立。
- 只读执行：仓库文件未改动。所有变异在 `/tmp/r7-manual`、`/tmp/r7-repo` 的独立 clone 中完成；主 checkout 的 `git status --porcelain` 在验收结束时仍为空。
- 环境说明：主 checkout 上同时有另一个 Job 在跑 `scripts/verify.sh`（其 `pnpm install` 会短暂改写 `node_modules`）。我第一次在主 checkout 直接跑 z3 因此报 `ERR_MODULE_NOT_FOUND better-sqlite3`，随后改在 `/tmp/r7-repo`（`c7e4b59` 的 `--local` clone + `pnpm install --offline`）完成全部实测。该并发 verify 结束时输出 `Verification scripts=42 failed=0`，其 z3 目录 `sourceCommit=be082db`、`scriptSha256=49086f04…`、七条全 PASS，作为旁证引用但不计入我的执行。

---

## 1. 结论

**R1 的技术验收本轮通过。** 第六轮点名的四项阻塞全部清除：① officialSdk 指定攻击被 R1-1 拒绝；② y2/x3 的退出码绑定是结构性的，删 `passed()` 不能绕过；③ 工具面与门禁持有的 5 个真实工具名精确比较，裸前缀/少一个/多一个全部 FAIL；④ 快照 `sourceCommit` 内含产生它的 z3 脚本，SHA-256 相等且七条产物可确定性复现。`docs/r1/summary.md` 已按现状重写，第六轮点出的四处过期表述均不再出现。

仍须记录的是证据端能力边界与一处表述不精确：门禁只能校验「探针交来的私有产物是否与门禁期望一致」，不能识别一个故意伪造该产物的探针（我实测可以让 R1-1 重新 PASS）；summary 第 43 行对官方 SDK 产物称「附承诺」，实际该文件没有 commitment，且 R1-4 仍有 4 个探针字面量字段。这些是边界与文档精度问题，不推翻七条行为结论。

---

## 2. 第六轮四项阻塞的逐项复验（我自己的命令与输出）

### ① `officialSdk` 只核版本不核连接 —— PASS

**重建的攻击（与第六轮逐字相同）**：在 `/tmp/r7-manual` 删掉 C 探针 `officialSdk` 块里的 `stdio.connect()/stdio.listTools()/http.connect()/http.listTools()`，只返回
`{version, stdioConnected:true, stdioToolCount:4, streamableHttpConnected:true, httpToolCount:1, referenceOnly:true}`。

```
$ bash scripts/verify/z3-mcp-acceptance.sh
exit=1
FAIL R1-1 …/clause-1.json
PASS R1-2 … R1-6
FAIL R1-7 …（门禁脚本被改，SHA 不再等于快照，预期）
R1-1 error: officialSdk reported success but left no connection observation
```

门禁现在读 `$Z3_DIR/sdk-observations.json`，按门禁自持的集合
`stdio={never_reply,notify,read,write}`、`http={wire_echo}` 做深度比较，并只在比较通过后生成 `sdk.*`。探针删掉真实调用就不会留下产物 → FAIL，不判 INCONCLUSIVE。**指定攻击被拒。**

**我额外做的更强攻击（记为边界，不判本条 FAIL）**：保留 `writeFileSync(sdk-observations.json)`，把工具名数组直接写死为期望集合，仍然不调用 `connect()/listTools()`。

```
PASS R1-1 …   （clause-1 status=PASS）
```

即：门禁校验的是「产物内容与期望集合一致」，不是「探针真的连过」。任何探针都能伪造自己的产物；这与 v5 报告 §6-8「不证明门禁二进制可信」同源，但 v5/summary 没有把它明确写成「探针可伪造私有产物」。**这个残余必须在 summary 的边界里写清，不能靠现有措辞掩盖。**

### ② 探针退出码与条款绑定太弱 —— PASS（结构性成立）

**y2 攻击**：`y2-mcp-http-worker.sh` 在写完 evidence 后 `exit 1`，并删除门禁里全部 3 处 `passed('y2');`。

```
$ bash scripts/verify/z3-mcp-acceptance.sh
exit=1
FAIL R1-1 …  error: 探针退出码非 0：y2
FAIL R1-5 …  error: 探针退出码非 0：y2
FAIL R1-6 …  error: 探针退出码非 0：y2
FAIL R1-7 …  （门禁被改）
```

绑定位于 `clauses` 循环之后：`evidenceAt()` 把每个条款实际读过的 `y2/x2/x3/c` 记进 `clauseProbeRefs`，跑完所有条款后统一核对 `execution.exitCode===0`，超时/启动失败同样算失败。条款 body 无法通过少写 `passed()` 绕过。**成立。**

**我额外验证的同类攻击**：`x3` 写完 evidence 后 `exit 1`，删掉 2 处 `passed('x3');`。

```
FAIL R1-4 …  error: x3 completed with failing assertions
FAIL R1-5 …
```

R1-4 由门禁自己的 `observe()` 在计算 `observed.x3.*` 前检查 `executions.x3.exitCode!==0`，所以即使 `passed('x3')` 被删也红。**x3 方向同样成立。**

### ③ `predicates.mcpTools` 接受裸前缀 —— PASS

我在隔离副本里分别把 `return {activeMcpTools:active,` 换成 4 组字面量：

| 注入值                                    | 结果              |
| ----------------------------------------- | ----------------- |
| `['mcp__']`                               | exit 1，R1-2 FAIL |
| `['mcp__a']`                              | exit 1，R1-2 FAIL |
| 少一个真实名（去掉 `mcp__root-1__write`） | exit 1，R1-2 FAIL |
| 多一个（追加 `mcp__root-1__extra`）       | exit 1，R1-2 FAIL |

R1-2 的 `REQUIRED.activeMcpTools` 已直接与门禁自持的 5 个名字做 `assert.deepEqual`，`predicates.mcpTools`（裸前缀谓词）现在**没有任何引用**（`grep -n mcpTools` 只剩第 517 行定义），不再参与判定。**成立。**

### ④ 快照 `sourceCommit` 不可复现 —— PASS

```
$ c=$(python3 -c "import json;print(json.load(open('docs/r1/evidence/evidence.json'))['sourceCommit'])")
$ echo $c
41b8df05002c49b9676f2203f3ae9de740e6e73f
$ git show $c:scripts/verify/z3-mcp-acceptance.sh | shasum -a 256
49086f0485a3d776ba6ae33aca331bde6d778b0bc4cd4630815f5ca7c3bf51cc  -
$ python3 -c "...['scriptSha256']"
49086f0485a3d776ba6ae33aca331bde6d778b0bc4cd4630815f5ca7c3bf51cc
$ shasum -a 256 scripts/verify/z3-mcp-acceptance.sh      # 当前工作树
49086f0485a3d776ba6ae33aca331bde6d778b0bc4cd4630815f5ca7c3bf51cc
$ git merge-base --is-ancestor 41b8df0 HEAD && echo yes
yes
```

两者相等；`41b8df0` 是当前 main 的祖先，且 `git diff 41b8df0 HEAD -- scripts/verify/z3-mcp-acceptance.sh` 为空。**指定判据通过。**

**确定性复现（我自己跑的）**：在 `/tmp/r7-repo`（c7e4b59 clone）连跑两次 z3，两次均 `exit 0`、七条 PASS。把两次产物与 `docs/r1/evidence/` 的十份快照做归一化比较（剔除 `generatedAt`、`startedAt`、`elapsedMs`、`evidencePath`、`head`、`evidenceSourceCommit` 这些描述单次运行或提交位置的字段）：

```
run1 == run2          clause-1 … clause-7 全部一致
published == 我的 run  clause-1 … clause-7 全部一致
```

即快照除时间戳/路径/提交位置外可由当前脚本确定性复现。

### ⑤ summary.md 是否仍落后 —— 基本修正，剩一处不精确（见 §4）

第六轮点名的四处已全部改正：

| 第六轮指出的过期表述     | 现状                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 门禁只读探针布尔         | 第 43 行改为逐项列出「门禁自己观测或重算」的字段                                                                                                                                                                                                                  |
| 第四轮 x3 删比较仍全绿   | 全文已无此断言；且 `structured-comparison-removed` 实测 R1-4 FAIL                                                                                                                                                                                                 |
| drain 修复指向 `3d0a0e4` | 第 46 行写的是 main `f7f1c0c`；实测 `3d0a0e4` 不在 main                                                                                                                                                                                                           |
| 主 checkout 尚未重跑 z3  | 第 46 行写「已在主 checkout 通过完整 z3 与全量 verify（42 scripts，failed=0）」；`/tmp/r1-resume2/full3.log` 结尾为 `PASS scripts/verify/z3-mcp-acceptance.sh` + `Verification scripts=42 failed=0`，本轮并发 verify 的 `full7.log` 也在 `be082db` 上重复了该结果 |

---

## 3. 七条逐条判定与证据端可信度

z3 实测（`/tmp/r7-repo`，c7e4b59）：`exit=0`，R1-1…R1-7 全 PASS；已发布快照 `run.log` 同为 7 行 PASS。

| 条款                                 | 判定 | 证据端与可信度                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 stdio/streamableHttp + 官方 SDK | PASS | 20 个工具名集合由门禁与固定清单比对（x2 的原始产物带 SHA/字节 commitment）；官方 SDK 两种传输的真实工具名由门禁与固定集合比对。**边界**：`sdk-observations.json` 无 commitment，伪造即可骗过（实测）。                                                                                                                                                                                                                                    |
| R1-2 Pi 工具面/allowlist/显式登记    | PASS | `activeMcpTools` 与门禁自持的 5 个名字精确比较；裸前缀/缺/多均 FAIL（我实测）。allowlist、host sentinel 字段仍是探针布尔，但探针内有对应断言且 `requireProbe('surface')` 要求 status=PASS。                                                                                                                                                                                                                                               |
| R1-3 实例隔离/跨 root/不改投         | PASS | 跨 root 两项由门禁读自己生成的 root server 调用日志重算；分布/会话绑定来自 C 探针断言。                                                                                                                                                                                                                                                                                                                                                   |
| R1-4 图片与 structuredContent        | PASS | 核心两项（`x3ImageBytesEqual`、`x3StructuredContentEqual`）由门禁从私有原始观察值 + commitment 重算；`image-comparison-removed`/`structured-comparison-removed`/非 PNG 等变异全部 R1-4 FAIL。**边界**：`c.image.bytesEqual/structuredContentEqual/throughSproutRelay/throughRealPiToolDefinition` 在 C 探针里是字面量 `true`（`z3-mcp-acceptance.sh:243`），真实比较靠探针内 `assert`；这两条事实另有 x3 重算兜底，另两条只是描述性字段。 |
| R1-5 资源/目录变化/重建/超时/旧代次  | PASS | `requestReachedServer` 来自门禁读 root server 日志；`oldGenerationRejected` 由门禁自己打开私有 SQLite 数 `mcp_frame` 行数；`callReturned`/`callTextMatchesServer` 由真实调用返回值计算（x3 原始产物带 commitment）。                                                                                                                                                                                                                      |
| R1-6 生命周期/已有服务登记           | PASS | `configuredServiceExited` 由门禁 `kill(pid,0)` 只看 ESRCH；`configured-service-liveness-hardcoded` 变异 R1-6 FAIL。                                                                                                                                                                                                                                                                                                                       |
| R1-7 采用组合与纳入阶段              | PASS | 只做可机器判定项：文档存在、关键词、脚本 SHA、`sourceCommit` 祖先。文档语义不保证（summary 已如实写明，我也确认第 43 行边界段存在）。                                                                                                                                                                                                                                                                                                     |

**已发布证据泄漏扫描（`docs/r1/evidence/`，10 个文件、共 28,844 字节）**：无 `/Users/`、`/private/`、`/tmp/` 绝对路径；无 ≥400 字符 base64；无 `SQLite format` 内容；无 secret/cookie/authorization/bearer/token；`structuredContent` 只作为字段名 `structuredContentEqual` 出现。**干净。**

**定向测试**（在 `/tmp/r7-repo`）：

```
$ pnpm exec vp test run tests/worker-remote-domain.test.ts
Test Files 1 passed (1) / Tests 1 passed (1)   exit=0
$ bash scripts/verify/w-worker-remote.sh
PASS … N5/N6 … / PASS force real environment evidence …   exit=0
```

C4 drain 未重做回退实验（第六轮已判 PASS），只确认两处仍绿。

---

## 4. summary.md 核对结果

已核对 `docs/r1/summary.md`（c7e4b59）与代码。仍存在的不精确：

1. **第 43 行**：「…官方 SDK 两种传输的真实工具名集合（探针把实际结果写进私有产物**并附承诺**，门禁读回比对）」。`sdk-observations.json` **没有** commitment（代码只在 `z3-mcp-acceptance.sh:158` 以 0600 写 JSON；带 commitment 的是 x2 的 `x2-tools.json.commitment` 与 x3 的 `image.rawObservations.sha256`）。读者会误以为 SDK 产物与 x3 一样防篡改。
2. **第 43 行**：「R1-4 的图片字节与 structuredContent（门禁从私有原始观察值重算）」。R1-4 的 `x3ImageBytesEqual`/`x3StructuredContentEqual` 确实重算；但同一 `REQUIRED` 里的 `bytesEqual`、`structuredContentEqual`、`throughSproutRelay`、`throughRealPiToolDefinition` 取自 `c.image.*`，而 C 探针第 243 行把这四个值写成字面量 `true`（真实比较在其前面的 `assert`）。「不再采信探针布尔」这句对这一组字段不成立。
3. **第 43 行**未记录 §2-① 的伪造产物残余（探针写死 `sdk-observations.json` 即可让 R1-1 PASS）。这是「门禁能力边界」段最该补的一条。
4. 其余：第 3–4 行「z3 返回 0 且七条全 PASS」「drain 已修复…独立复验尚未完成，因此技术验收未通过」与代码/实测一致；第 46 行 drain 指向 `f7f1c0c` 正确，其「42 scripts，failed=0」有 `/tmp/r1-resume2/full3.log` 与 `full7.log` 支撑；第 51 行对第六轮结论的复述与我读到的报告一致。

附注：`pnpm check` 在 c7e4b59 上会因 `docs/r1/acceptance-round6.md` 格式问题失败；该文件是 c7e4b59 新增的，`be082db` 已修好。在 `be082db` 上实测 `Found 0 errors and 2 warnings in 317 files`，与 `gate-audit-v5.md` §5 的 claim 一致——v5 自己的提交（41b8df0/685532c）里没有该文件，所以 v5 没有误述。

---

## 5. 未验边界

1. **真实模型自动选择并调用 MCP 工具的一轮推理**：未验（无付费模型推理）。summary 已如实声明。
2. **探针可伪造私有产物**：我实测把 `sdk-observations.json` 写死为门禁期望集合后 R1-1 仍 PASS。同理适用于 x2/x3 的原始产物（其 commitment 也由探针生成）。门禁实际证明的是「读到的值与期望一致」，不是「探针执行了声称的比较」。
3. **官方 SDK 的失败模式**（网络异常、超时、协议降级）：不在 z3。
4. **工具描述/参数 schema/调用语义**：门禁只核工具名集合。
5. **全量 verify**：我未运行 `scripts/verify.sh`（按 brief 禁止）。42 scripts failed=0 来自并发 Job 的 `full7.log` 与历史 `full3.log`，属旁证，非我的实测。
6. **220 条积压 / 8192 字节预算 attach**：不在 z3，由 `tests/mcp-worker-domain.test.ts` 覆盖；本轮未重跑该项。
7. **`session_fence.closed` 无生产写入点**：P4b 遗留，R1 未接也未删。
8. **R1-7 不校验文档语义**：summary 第 43 行的上述不精确不会被门禁红出来，只能靠人工核对。

---

## 6. 对整改报告的采信与反驳

**`gate-audit-v5.md`**：

- 采信：三条攻击的「改前/改后」与我的复现一致；`official-sdk-connections-removed`、`y2-exits-after-success-without-passed`、`mcp-tools-bare-prefix` 三个变异在隔离副本里均让目标条款 FAIL；`16 个变异全部目标条款 FAIL`、`rawValuesVisible=false`、`cases: 17`、驱动 exit 0 我都复跑确认；快照两步提交与 SHA 相等的描述属实。
- 反驳/补充：① §2-① 称「门禁读取该私有产物并按集合深度比较」，但没有说明产物本身没有 commitment、可被探针伪造——这是该修复的真实上限，补一句比留给验收者发现更好。② §5「pnpm check 通过」对 41b8df0/685532c 成立（那两个提交里没有后来新增的 `docs/r1/acceptance-round6.md`），不是误述。
- 未采信（未验）：`pnpm check` 我没有在其提交上直接跑（只在等价树上跑过）；其余项均有我的实测。

**`docs/r1/summary.md`（c7e4b59 重写稿）**：整体已从「第五轮状态」更新到「v5 之后状态」，四处过期表述全部改正；但 §4 列出的三处不精确属实，其中「附承诺」是对证据强度的夸大，建议文档所有者改写为「产物内容与门禁期望集合比对；产物无 commitment，探针可伪造」，并把 R1-4 的字面量字段与伪造产物残余写进「已知限制」。

**第六轮报告（acceptance-round6.md）**：其四项阻塞的判断在当轮成立；本轮已逐项消除，故本轮不再沿用其「不通过」结论。

---

## 7. 明确回答

**R1 的技术验收现在通过。** 依据：①–④ 四项阻塞我用自己重建的攻击全部确认被门禁拒绝；z3 七条 PASS、exit 0，且产物两次运行与已发布快照确定性一致；17 个变异 case（clean + 16）全部符合目标条款 FAIL、无 INCONCLUSIVE、无原始值泄漏；快照 `sourceCommit` 与脚本 SHA 相等且可复现；`worker-remote-domain` 与 `w-worker-remote` 仍绿。七条各自的证据端在 §3 逐条列出，其中 R1-1/R1-3/R1-4/R1-5/R1-6 的核心事实已由门禁自算或门禁自读的原始观察值支撑，R1-2 已钉成真实工具名集合，R1-7 只做机器可判定项。

仍须记录的边界：探针可伪造私有产物（含无 commitment 的 `sdk-observations.json`）；R1-4 有 4 个探针字面量字段；summary 第 43 行「附承诺」与「不再采信探针布尔」对 SDK/R1-4 不完全成立；真实模型推理、SDK 失败模式、schema 语义、全量 verify 与积压 attach 未由本轮独立实测。
