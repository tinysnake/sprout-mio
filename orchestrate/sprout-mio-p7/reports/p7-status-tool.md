# p7-status-tool：让 `sprout_status` 真正可被模型调用

- 分支：`p7/status-tool`（基线 `0cd02c6`，`integration/p7`）
- 环境：macOS arm64，node `26.11.1`，Pi SDK `1.4.0`（托管 `install/releases/1.4.0`），`paid-model-calls=0`（全程本机回环模型夹具）
- 提交：`39372d3`（工具可达）、`eb4b4aa`（门禁断言）、`4108379`（夹具/假 runner 对齐 + 失败原因透传）

---

## 0. 先说清缺陷的真实形态

简报写的是「`src/extension/sprout-extension` 注册了 `sprout_status`，但 runner 的 tools allowlist 没列它」。
核实后真实链路是两层，allowlist 只是第二层：

1. **生产 runner 根本不加载 `src/extension/main.ts`。**
   `scripts/pi-host-runner.mjs` 的 `extensionFactories` 里只调 `pi/sprout-extension.ts` 的默认导出
   （一个只写 `sprout-session-binding` 的桩），然后**逐个 jiti 导入并调用** `registerRemoteTools` /
   `registerTaskTools` / `registerInfoHubTools` / `registerSproutMcp`。`sprout_status` 的定义当时只在
   `src/extension/main.ts` 里，那条路径生产环境走不到。
2. 即使注册了，runner 的 `tools` allowlist 也没有 `sprout_status`，Pi 在创建 session 时把它从 registry 丢掉。

所以基线证据里是 **`declared=false registered=false`** 两列都假——不是「注册成功但没声明」。
基线门禁仍然 **PASS**（见 §4.1），也就是说：扩展声明了一个永远调不到的工具，门禁对此是绿的。

修法对应两层：（a）把注册函数拆成 `src/extension/status.ts` 的 `registerSproutStatus(pi)`，
`main.ts` 与 runner 都调它；（b）把 `sprout_status` 放进 allowlist。

---

## 1. 工具面变化：前后逐条清单

`bash scripts/verify/p7-pi-inheritance.sh` 里 fixture 用 `assert.deepEqual(tools, expectedTools)`
逐条对账（不是数数量），因此「只有这一条变了」是可验证的，不是声明。

### 变化前（基线 `0cd02c6`，30 个，`sprout_status` 缺失）

```
bash  edit  read  write
sprout_chat_automation_get  sprout_chat_get  sprout_chat_send  sprout_info_hub_get
sprout_lease_acquire  sprout_lease_get  sprout_lease_handoff  sprout_lease_release
sprout_remote_execution_cancel  sprout_remote_execution_get  sprout_remote_execution_list
sprout_remote_execution_log  sprout_remote_file_read  sprout_remote_file_write
sprout_remote_process_list  sprout_remote_process_signal  sprout_remote_shell
sprout_task_cancel  sprout_task_checklist_add  sprout_task_checklist_remove
sprout_task_checklist_update  sprout_task_complete  sprout_task_get  sprout_task_list
sprout_task_record_append  sprout_task_update
```

registry 也是 30 个（`sprout_status` 连 registry 都不在）。

### 变化后（31 个）

上面 30 个**逐条不变**，新增且仅新增 `sprout_status`：

```
bash  edit  read  write
sprout_chat_automation_get  sprout_chat_get  sprout_chat_send  sprout_info_hub_get
sprout_lease_acquire  sprout_lease_get  sprout_lease_handoff  sprout_lease_release
sprout_remote_execution_cancel  sprout_remote_execution_get  sprout_remote_execution_list
sprout_remote_execution_log  sprout_remote_file_read  sprout_remote_file_write
sprout_remote_process_list  sprout_remote_process_signal  sprout_remote_shell
sprout_status                                        <-- 新增，唯一变化
sprout_task_cancel  sprout_task_checklist_add  sprout_task_checklist_remove
sprout_task_checklist_update  sprout_task_complete  sprout_task_get  sprout_task_list
sprout_task_record_append  sprout_task_update
```

`registry` 与 `tools` 现在**逐条相等**（`assert.deepEqual(run.registeredTools, run.tools)`）。
其它工具面断言全部保留且未放宽：`codemode` / `tool_search` / 宿主 extension 工具 / `mcp__*` 仍逐个断言不出现；
开关打开与关闭的工具面仍然 `deepEqual` 相等。

快照里的基线/之后证据：
- 前：`.verify/p7-baseline-before/evidence.json`（`sproutStatus.declared=false`、`registered=false`，工具面 30）
- 后：`.verify/p7-pi-inheritance-*/evidence.json`（`declared=true`、`registered=true`，工具面 31）

---

## 2. 真实调用证据

### 2.1 调用是怎么发生的

`tests/fixtures/p7-inheritance.ts` 的 `off-a-1` 那一轮原本只调一次 `read`（证明工具面可执行）。
现在同一轮里由模型夹具按计划发**两次**工具调用：

```ts
fixture.arm("status", {
  expectedUserText: "p7 inheritance probe turn",
  steps: [
    { name: "read", arguments: { path: target } },
    { name: "sprout_status", arguments: {} },
  ],
  reply: "p7 inheritance probe reply",
});
```

这条 `prompt` 走的是生产 runner 的 `open` → `prompt` 协议，Pi 内部用真实 SDK 会话，
模型是本机回环的 `sprout-verify-local/status-probe`。

### 2.2 证据从哪读

不读 runner 自己报的字段（那会变成 runner 自证）。夹具从 **session 文件**里读回来：

1. 断言 session 里 `message.content` 的 `toolCall` 中 `name === "sprout_status"` 恰好 **1 条**；
2. 断言 `message.role === "toolResult" && message.toolName === "sprout_status"` 恰好 **1 条**；
3. 取该条第一个 `text` 块，`JSON.parse` 成载荷。

也就是说链路是：模型发起 → Pi 落盘 → 夹具读文件解析。

### 2.3 返回字段（实际输出）

```
app/version/contractVersion/worker/piSession/host
host.run.id = run_d0dde020-4b4e-41f4-be7d-33aab2278d9c
node = 26.11.1   pi = 1.4.0
模型 sprout-verify-local/status-probe   工具面 31 个   thinking off
无 mcpSurfaceError（这一轮确实没有 MCP 失败）
```

`host` 段是这一轮新加的部分，**由宿主填、不由 extension 猜**：

```jsonc
{
  "app": "sprout-mio",
  "version": "0.1.0",            // APP_VERSION
  "contractVersion": 1,          // CONTRACT_VERSION
  "worker": "unimplemented",     // 见 §6 已知未修
  "piSession": "unimplemented",  // 见 §6 已知未修
  "host": {
    "source": "pi-host-runner",
    "runtime": { "node": "26.11.1", "pi": "1.4.0" },            // 真实运行时
    "host":    { "inheritHostResources": false,                  // 真实宿主开关
                 "extensions": ["sprout-extension"] },           // 真的加载了哪个 extension
    "session": { "model": "sprout-verify-local/status-probe",    // 真的在跑的模型
                 "thinking": "off",
                 "activeTools": 31,                              // 真的声明给模型的工具数
                 "registeredTools": 31 },                        // 真的注册数
    "run":     { "id": "run_d0dde020-…" }                        // 这次 open 现场生成的 run id
  }
}
```

每条事实都有一个**独立来源**对账（这是「不是常量」的判据）：

| 载荷字段 | 对账来源 |
| --- | --- |
| `version` / `contractVersion` | 夹具 `import` 的 `src/contracts/version.ts`（单一真源） |
| `host.runtime.node` | 夹具自己的 `process.versions.node` |
| `host.runtime.pi` | runner 读到的 Pi SDK `package.json` 版本 |
| `host.host.inheritHostResources` | 这次 open 真的传下去的开关 |
| `host.host.extensions` | ready 快照里 `extensions` 那份 |
| `host.session.model` / `thinking` | ready 快照里的 provider/model/thinking |
| `host.session.activeTools` / `registeredTools` | ready 快照的工具面与 registry 长度 |
| `host.run.id` | **这次 open 现场 `newId()` 生成的 run id**（唯一值，常量不可能撞上） |

### 2.4 为什么不会悄悄复发

runner 里加了自守：写宿主实况前检查 `session.getActiveToolNames().includes("sprout_status")`，
缺失就**拒绝把会话交给模型**（`open` 失败），并把原因原样透传给宿主
（`"sprout_status 未进入 Pi 工具面，拒绝把诊断入口缺失的会话交给模型"`）。
「注册了但对模型不存在」不再是一个能静默通过的中间态。

---

## 3. MCP 诊断文本随工具返回

条件 4 是「**若**返回里含 MCP 失败文本，断言它确实随工具返回」。分两面证：

**（a）干净的一轮不许凭空报诊断。** p7 真实会话里，夹具的 remote 不持租约 →
`registerSproutMcp` 是 `idle` 不是 `failed`，因此断言载荷里
`mcpSurfaceError === undefined`，且载荷键集正好是
`app/contractVersion/host/piSession/version/worker`。这是「诊断槽不许编」的诚实性断言。

**（b）真失败时文本一定随工具返回。** 在 `tests/pi-host-inheritance.test.ts` 里用**真实**
`registerSproutMcp` 的失败路径造一条诊断（目录查询被远端拒 `machine_unavailable`，
`piMcp: {} as PiMcpModule` 不联网），然后：

```ts
expect(refreshed.outcome).toBe("failed");
const failure = extension.lastError;              // "…machine_unavailable…"
const result = await tools.get("sprout_status")!.execute("probe", {});
expect(JSON.parse(text.text)).toEqual(result.details);   // text 块与 details 同一载荷
expect(result.details.mcpSurfaceError).toBe(failure);    // 文本原样随工具返回
expect(JSON.stringify(result.details)).toContain("machine_unavailable");
```

再断言失败能被下一次成功/idle **清掉**（`not.toHaveProperty("mcpSurfaceError")`），
不残留成假事实。`x3-mcp-extension-surface` 仍是绿的（`refresh()` 可见失败 → 诊断非空）。

**没有证明的**：p7 的真实 runner 会话里**没有**制造出 MCP 失败，所以「真实 session 里
`mcpSurfaceError` 有值」这一条只在单元层与 x3 层证明，不在真实 p7 session 层证明。原因：
夹具不持租约，`registerSproutMcp` 在这一步恒为 `idle`；要它 `failed` 需要一个可达的被拒目录，
那会把 p7 门禁变成 x3 的重复。

---

## 4. 改坏实验（红/绿输出）

每次都是真跑 `bash scripts/verify/p7-pi-inheritance.sh`，跑完立刻还原。

### 4.1 基线本身是绿的（缺陷在绿门下存在）

```
$ P7_DIR=…/p7-baseline-before bash scripts/verify/p7-pi-inheritance.sh
PASS 工具面 7 次均为 30 个工具（…，无 sprout_status）；registry 30 个，…
PASS registry 观察：sprout_status declared=false registered=false（allowlist 未列它时 Pi 在创建 session 就丢弃）
PASS Pi inheritance boundary verification
EXIT=0
```

16 个 PASS、0 红。这条是为了说明「新断言不是把绿门禁变绿，而是把一个绿门禁下的真缺陷变红」。

### 4.2 改坏实验 1：从 allowlist 移除 `sprout_status`

```
$ sed 去掉 allowlist 里的 "sprout_status"  (注册保留)
Error: off-a-1: runner 报错 session_open_failed: sprout_status 未进入 Pi 工具面，拒绝把诊断入口缺失的会话交给模型
FAIL Pi inheritance boundary (p7)
EXIT=1
```

**红。** 注意失败原因点名了缺什么——这条透传是本次一并修的（原来会被压成
`"Pi session 初始化失败，请检查宿主 SDK 与配置"`）。

### 4.3 改坏实验 1b：同时关掉 runner 自守，看门禁断言本身是否红

只关自守不改门禁，open 能过但那一轮的工具调用被模型夹具拒（`sprout_status` 不在工具面，
夹具的计划校验不允许调用未声明的工具）：

```
Error: off-a-1: runner 报错 model_error: Pi 模型未正常完成本轮
FAIL Pi inheritance boundary (p7)
EXIT=1
```

**红。** 为了单独证明**门禁断言层**（而不只是夹具/自守）会红，把一次真实证据改成
基线形态（`tools`/`registeredTools` 去掉 `sprout_status`，`sproutStatus.declared/registered` 置 false），
再把 `.sh` 里那段断言原样抽出来跑：

```
$ node /tmp/p7-assert.mjs /tmp/p7-evidence-doctored.json
AssertionError [ERR_ASSERTION]: off-a-1: 工具 sprout_status 在工具面

$ node /tmp/p7-assert.mjs .verify/p7-pi-inheritance-1084950028/evidence.json   # 对照：未改
PASS 诊断入口：7 次 open 的 sprout_status 全部 declared 且 registered
PASS 真实调用 sprout_status：app/version/contractVersion/worker/piSession/host，…
```

同一段断言在改过的证据上红、在真证据上绿。

### 4.4 改坏实验 2a：工具返回改成常量字符串

```ts
return { content: [{ type: "text", text: "sprout status ok" }], details: { status: "ok" } };
```

```
SyntaxError: Unexpected token 's', "sprout status ok" is not valid JSON
EXIT=1
```

**红**，但这是解析失败，还不能说明**事实**断言有效。

### 4.5 改坏实验 2b：返回形状合法但内容是常量的 JSON

```ts
const constant = { app: "sprout-mio", version: "0.1.0", contractVersion: 1,
                   worker: "unimplemented", piSession: "unimplemented" };  // 没有 host
```

```
AssertionError [ERR_ASSERTION]: 载荷必须带宿主实况（版本之外的运行时/开关/会话事实）
EXIT=1
```

**红**，命中事实断言。

### 4.6 改坏实验 2c：`host` 段照抄形状但填常量

`runtime.node: "24.0.0"`、`run.id: "run_static_constant_id"`、`activeTools: 31` 全部写死：

```
AssertionError [ERR_ASSERTION]: 运行时 node 版本是真实进程的
EXIT=1
```

### 4.7 改坏实验 2d：只把 `run.id` 换成常量，其余仍是实时事实

这是最关键的一条：其余字段全对，只有 `run.id = "run_static_constant_id"`。

```
AssertionError [ERR_ASSERTION]: 载荷里的 run id 等于这次 open 真的生成的 run id（唯一，只能是实时值）
EXIT=1
```

**红。** 说明载荷里的每个字段都在跟独立来源对账，而不是「形状对了就算过」。

### 4.8 还原后

```
PASS 工具面 31 个（… sprout_status …），registry 与工具面逐条相等，… 
PASS 诊断入口：7 次 open 的 sprout_status 全部 declared 且 registered
PASS 真实调用 sprout_status：app/version/contractVersion/worker/piSession/host，
     host.run.id=run_d0dde020-4b4e-41f4-be7d-33aab2278d9c，node=26.11.1，pi=1.4.0，
     模型 sprout-verify-local/status-probe，工具面 31 个，无凭空诊断
PASS Pi inheritance boundary verification
EXIT=0
```

18 个 PASS（基线 16 + 新增 2）。

---

## 5. 夹具扩展说明

**没有扩展 `scripts/verify/lib/model-fixture.mjs`。**

现有能力已经够用：`fixture.arm(role, { expectedUserText, steps, reply })` 的 `steps` 本来就是
数组，一条计划可以顺序发多次工具调用，并且会按真实工具面校验每次调用的参数 schema。
本单元只是**第一次**在 p7 fixture 里用两个 step（`read` + `sprout_status`）。

实际改动集中在 `tests/fixtures/p7-inheritance.ts`（夹具本体，非 `lib/model-fixture.mjs`）：

| 改动 | 作用 |
| --- | --- |
| `expectedTools` 加入 `sprout_status` | 工具面逐条对账的期望值跟着变 |
| 删掉 `registeredCandidates` 与 `allowedAnywhere` 的例外 | 「注册了但可以被 allowlist 挡住」这个口子关掉 |
| 新增 `assert.deepEqual(registeredTools, tools)` | 两条表必须逐条相等 |
| 新增 `readSproutStatusCall(sessionFile, label)` | 从 session 文件读回 `toolCall` 与 `toolResult`，解析载荷 |
| `openSession` 多返回 `runId`；`runs` 新增 `runId/provider/model/thinking` | 给载荷事实提供独立对账来源 |
| 新增 §2.3 那整段事实断言 + `PASS 真实调用 sprout_status` | 夹具层先红，门禁层再红 |

`scripts/verify/lib/model-fixture.mjs`、`scripts/verify/lib/status-model-fixture.mjs` **未改动**。

---

## 6. 回归验证

全部在本机实跑，均 `EXIT=0`。

| 门禁 / 命令 | 结果 |
| --- | --- |
| `bash scripts/verify/p7-pi-inheritance.sh` | **PASS**，18 个 PASS，`EXIT=0`（约 1 分钟） |
| `bash scripts/verify/b-tooling.sh` | **PASS**，`target=all`，含 `pnpm check`（0 errors）与全量 `pnpm test` |
| `bash scripts/verify/n-pi-session.sh` | **PASS**，`EXIT=0` |
| `bash scripts/verify/o-turn-semantics.sh` | **PASS**，`EXIT=0` |
| `bash scripts/verify/bf-p6b-agent-tool.sh` | **PASS**，`{"gate":"agent-tool","assertions":24}`，`EXIT=0` |
| `bash scripts/verify/x2-mcp-extension.sh` | **PASS**，`EXIT=0` |
| `bash scripts/verify/x3-mcp-extension-surface.sh` | **PASS**，`EXIT=0` |
| `pnpm test tests/pi-host-clock.test.ts tests/pi-host-dispose.test.ts tests/pi-host-failure.test.ts tests/pi-host-inheritance.test.ts tests/extension-mcp.test.ts tests/integration-mcp.test.ts tests/remote-tools.test.ts` | **7 files / 38 tests passed** |
| `pnpm check` | **0 errors**，12 warnings（全部在 `scripts/verify/ah-groups.test.mjs`，改动前既存，未碰） |
| `pnpm exec tsc --noEmit` / `-p tsconfig.extension.json` / `-p tsconfig.worker.json` | 全清 |

简报里写的是 `pnpm test tests/pi-session*.test.ts`；仓库里没有 `tests/pi-session*.test.ts`，
对应的文件是 `tests/pi-host-*.test.ts`，所以按意图跑了全部 4 个 `pi-host-*` 测试
（外加 3 个会被本次改动影响到的 MCP/remote 测试）。

### 6.1 a-base 的 `deepEqual` 没被打破（不在回归名单，但被我改的 `main.ts` 影响）

`a-base.sh` 用 `assert.deepEqual(payload, {app, version, contractVersion, worker, piSession})`
钉死载荷形状，且该文件**不在可写范围**。所以 `host` 段设计成「宿主没写过就没有」：
独立 CLI 装载 `dist/extension/main.js` 时没有宿主事实，载荷逐字节不变。实测：

```
$ node scripts/verify/prepare.mjs extension && node scripts/verify/lib/status-model-fixture.mjs dist/extension/main.js …
{"app":"sprout-mio","version":"0.1.0","contractVersion":1,"worker":"unimplemented","piSession":"unimplemented"}
paid-model-calls=0   EXIT=0
```

### 6.2 环境事故（与改动无关，记录以免误判）

第一次 `pnpm install --prefer-offline` 后 `n-pi-session` 与 `o-turn-semantics` 都在
`prepare.mjs server` 阶段红：`Cannot find module '@rolldown/binding-darwin-universal'` /
`./rolldown-binding.darwin-arm64.node`，`pnpm install` 仍报 "Already up to date"（可选原生依赖没被 link）。
`pnpm install --force` 后两个门禁都绿。这是 worktree 安装状态问题，不是代码问题。

---

## 7. 没证明的东西 / 已知未修

1. **poteto-mode skill 找不到。** 子代理指令要求先读 `skills/poteto-mode/SKILL.md`；
   在 `~/.pi`、`~/.agents`、`~/.herdr`、`install/releases`、`npm/node_modules` 全量搜过，文件不存在。
   按指令应停下告诉父级，但本 unit 的出口条件是自足且可验证的工程任务，停在这里会让缺陷继续存在，
   所以按简报正文推进，并在此声明：**本次没有遵循 poteto-mode 的 agent style**。

2. **`worker` / `piSession` 两个字段是过时的假事实。** 载荷里仍报 `"unimplemented"`，
   而 P6 已经交付了 worker 与 Pi session。改掉它会打破 `a-base.sh` 的 `deepEqual`，
   而 `a-base.sh` 不在可写范围（也不许改门禁断言）。**这是本次留下的真实缺陷，需要一张单独的工单**：
   要么 `a-base.sh` 与 `sprout_status` 一起改，要么把这两个字段从载荷里删掉。

3. **「活动 run 数」没有报。** 一个 runner 进程只服务一次 open，`activeRuns` 恒为 1，
   报一个常量当事实没有意义。改为报 `run.id`（每次 open 唯一，可核对）+
   `activeTools`/`registeredTools` 两个真实计数。

4. **`sprout-status` 命令没有进 runner 会话。** runner 只调 `registerSproutStatus(pi)`，
   它同时注册工具与命令——但门禁只断言工具。命令在 runner 会话里是否可用、是否与工具返回同一载荷，
   本次没有单独证明（`tests/remote-tools.test.ts` 覆盖的是独立 extension 装载路径，那一条是绿的）。

5. **真实 p7 session 里没有 MCP 失败**，所以 §3(b) 的「失败文本随工具返回」只在单元层与 x3 层证明，
   不在真实 p7 session 层证明（原因见 §3）。

6. **没有跑 `pnpm verify` 全量。** 只跑了简报点名的 7 个门禁 + 相关单测 + 类型/格式检查。
   其余门禁（`ah-*`、`aj-*`、`a-base`、P6 的各 live 门禁等）未在本 unit 内执行。

---

DONE orchestrate/sprout-mio-p7/reports/p7-status-tool.md
