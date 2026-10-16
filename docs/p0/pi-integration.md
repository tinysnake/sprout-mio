# P0-d: Pi 接入面（CLI headless / RPC / SDK）

- unit: p0-d-pi-integration
- branch: p0/p0-d-pi-integration
- 实验代码: `experiments/pi-probe/`
- 重跑入口: `cd experiments/pi-probe && bash verify.sh`（a、d），其余见 `experiments/pi-probe/README.md`
- 日期: 2026-10-16
- 参考的原 Sprout 仓库（`~/workspace/sprout`）: `5b48a53b385ee8a4c0fff219954c6244506b0b9f`（`src/engine/pi-host.ts`、`src/engine/pi-host-runner.mjs`）

## 结论先行

**主路径用 SDK，把 Pi 跑在宿主的一个独立子进程里。RPC 作为「零接线」备选保留。**

理由有三条，都来自本页实验：

1. SDK 的 steer、follow_up、abort、会话持久化与恢复本次全部真实验证通过，和 RPC 能力等价，但宿主拿到的是类型化方法而不是自己实现的 JSONL 协议。
2. Sprout 需要按分身授予具体 provider/model。SDK 的 `ModelRuntime` 加显式 `model` 正好表达这件事；CLI 的默认模型解析来自本机 `settings.json` 和已装 extension，是环境相关的，不适合做租约边界。
3. Sprout 的 extension 与 MCP 入口需要显式控制加载集合。SDK 用 `DefaultResourceLoader` 显式给出「加载什么」，而 CLI 会连带把 `~/.pi/agent` 下 20 多个用户 extension 全部拉起来。

但 SDK 不是零接线，两个前提必须满足，否则会退化成「模型选错且调用失败」：

- 显式构造 `ModelRuntime`，指向 `~/.pi/agent` 的 `auth.json`、`models.json`、`models-store.json`。
- 显式指定 `model`。裸 `createAgentSession()` 在本机解析到 `openai-codex/gpt-6.1-sol`，而不是配置里的默认 `magpie/group/auto-deepseek-v4-1-flash`，并且真实调用失败（`stopReason: "error"`, `WebSocket error`）。

原 Sprout 的 `pi-host-runner.mjs` 用的就是「沙箱子进程里跑 SDK」这一形态，本实验的推荐与参考实现一致。

## 接入面盘点

Pi 1.3.0 提供一个 agent 内核，四种接口形态共享同一套 session、资源与工具。

| 形态 | 接口 | 生命周期 | 适用 |
| --- | --- | --- | --- |
| Interactive | TUI | 到用户退出 | 人直接用 |
| Print | stdout 最后一段文本 | 一次调用 | 脚本要最终回答 |
| JSON | stdout JSONL 事件 | 一次调用 | 进程要结构化进度 |
| RPC | stdin 命令 + stdout 事件 | 长驻 | 双向控制 |
| SDK | TypeScript 进程内 | 宿主进程内 | Node/Bun 宿主 |

CLI 的启动参数在四种模式下都有效，所以工作目录、模型、工具、资源、会话持久化可以独立选择。

## 环境与版本

| 组件 | 值 |
| --- | --- |
| Pi | 1.3.0（`/Users/snake/.pi/agent/bin/pi`，托管安装） |
| Node | v26.11.1 |
| 默认 provider / model | `magpie` / `group/auto-deepseek-v4-1-flash` |
| magpie 来源 | `pi-magpie` extension 通过 `pi.registerProvider` 注册的自定义 gateway provider |
| 自定义 provider 的对照标准模型 | `deepseek/deepseek-flash`（`auth.json` 内 API key） |

实验中出现的 `extension_ui_request`（`setStatus`、`notify`）来自本机已装的 `pi-context-window-cap`、`pi-magpie`、`pi-better-compaction` 等 extension，不是被测结论。

## a) 配置与认证继承: 已验证

命令：

```bash
env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/bin:/bin" \
  /Users/snake/.pi/agent/bin/pi -p --session-dir /tmp/pi-probe-a2 \
  "Reply with exactly: PROBE_A_ENV_OK"
```

输出：

```
PROBE_A_ENV_OK
exit=0
```

环境变量被清空（没有 `*_API_KEY`、没有 `MAGPIE_*`）仍然成功，说明凭据与 provider 配置来自 `~/.pi` 磁盘文件。

反证（空配置目录，不改真实配置）：

```bash
env HOME=/tmp/pi-probe-empty PI_CODING_AGENT_DIR=/tmp/pi-probe-empty/agent \
  /Users/snake/.pi/agent/bin/pi -p --offline --session-dir /tmp/pi-probe-empty/sessions \
  "Reply with exactly: SHOULD_NOT_WORK"
```

输出：

```
No API key found for the selected model.
...
exit=1
```

`PI_CODING_AGENT_DIR` 一换，认证即失效。正反两侧合起来证明继承路径是 `~/.pi/agent`（默认，可用 `PI_CODING_AGENT_DIR` 覆盖），不是环境变量。

CLI 还顺带继承了自定义 provider。`pi --list-models` 列出 26 个 `magpie` 模型，默认模型即 `magpie/group/auto-deepseek-v4-1-flash`，无需额外参数。

## b) 会话恢复: 已验证

```bash
cd /tmp/pi-probe-b
pi -p --session-dir /tmp/pi-probe-b/sessions --name probe-b \
   "Remember this codeword: BANANA7. Reply with OK only."
pi -p --session-dir /tmp/pi-probe-b/sessions --continue \
   "What codeword did I ask you to remember? Reply with just the codeword."
```

输出：

```
OK
BANANA7
```

会话文件落在 `2026-10-16T18-52-03-986Z_01a1460e-9812-7212-b901-e9e211b769f8.jsonl`。`--continue` 取当前工作目录最近一条；恢复后历史对模型可见。

`--session probe-d` 的按 ID 恢复在 d 实验里另行验证，同样成立。

## c) 运行中投递: 已验证

用 RPC 模式，`--tools bash`，先让 agent 跑 `sleep 20`，在 bash 工具执行期间投递新消息。原始记录在 `results/c-steer.records.jsonl`、`results/c2-followup.records.jsonl`。

### steer（插队到当前轮之后）

```json
{"type":"steer","message":"Ignore the sleep task. Reply with exactly STEER_RECEIVED and nothing else."}
```

响应：

```json
{"command":"steer","success":true,"data":{"disposition":"queued"}}
```

结果：

```
finalText = "STEER_RECEIVED"
steerReachedTranscript = true
originalTaskAbandoned = true
```

steer 在工具调用结束后、下一次 LLM 调用之前送达。模型放弃原任务，最终回答 `STEER_RECEIVED`，并且这条消息以 user 角色进了会话历史（`get_messages` 可见）。

### 运行中投递普通 prompt（未指定 streamingBehavior）

```json
{"type":"prompt","message":"This prompt has no streamingBehavior and should be rejected."}
```

响应：

```json
{"command":"prompt","success":false,"error":"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."}
```

这是显式拒绝，不是静默排队。RPC 宿主必须显式选择投递语义。

### follow_up（等这一轮跑完）

```json
{"type":"follow_up","message":"Then, on the next line, write exactly FOLLOWUP_ACK."}
```

结果：

```
followUpResponse.disposition = "queued"
assistantTexts = ["SLEPT", "SLEPT\nFOLLOWUP_ACK"]
agentStartCount = 1
```

follow_up 不打断原任务。原任务先返回 `SLEPT`，随后同一个 run 内补了一轮 `FOLLOWUP_ACK`，没有新的 `agent_start`。

## d) 停止运行中的 agent: 已验证

`results/d-abort.summary.json`。运行 `sleep 60`，在 bash 执行期间发 `abort`。

```json
{"command":"abort","success":true}
```

```
isStreamingDuringRun    = true
isStreamingAfterAbort   = false
agentSettledAbortedFlag = true
childExit               = {"code":0,"signal":null}
```

abort 后进程干净退出，退出码 0。会话文件保留，abort 后的恢复在 `verify.sh` 内重放：

```
$ pi -p --session-dir results/d-sessions --session probe-d --tools bash \
    "Without running any command, answer in one line: what task was aborted?"
You asked me to run `sleep 60` and then reply with the single word DONE;
the command was aborted, so I never replied DONE.
```

`abort` 不删会话，也不留半截工具结果。`messageCount` 从 3 涨到 5，工具调用与其结果作为历史保留。

## e) extension 加载: 已验证

被测文件 `experiments/pi-probe/ext/sprout-probe.ts`，同时注册 `registerTool("sprout_probe_ping")`、`registerCommand("sprout-probe")`，并在 `session_start` 里 `appendEntry`。

```bash
pi -p --session-dir results/e-sessions -e ./ext/sprout-probe.ts \
   --tools sprout_probe_ping --thinking off \
   "Call the sprout_probe_ping tool, then reply with its exact output."
```

输出：

```
`SPROUT_EXTENSION_LOADED`
```

会话文件里出现 `sprout-probe-session-start` 条目，证明 `session_start` 回调确实执行。

对照组，同样的 `--tools sprout_probe_ping` 但不传 `-e`：

```
I don't have a tool named `sprout_probe_ping` available in my toolset.
...
exit=0
```

工具名不合法时 `--tools` 静默过滤，不报错。这是 e 的控制组，也是 d 里工具选择的注意点。

## f) SDK 路径: 已验证

`results/f-sdk.summary.json`。SDK 不装依赖，直接按绝对路径从托管 release 导入（和原 Sprout runner 一致）。

| 检查项 | 结果 |
| --- | --- |
| 裸 `createAgentSession()` 解析到的模型 | `openai-codex/gpt-6.1-sol`（不是配置默认 `magpie/...`） |
| 裸 factory 的 prompt 结果 | `stopReason: "error"`, diagnostic `WebSocket error`，未抛异常 |
| 显式 `ModelRuntime` + `deepseek/deepseek-flash` | `authInherited = true`，回答 `SDK_PROBE_OK` |
| `runtime.hasConfiguredAuth("deepseek")` | `true` |
| `runtime.getModel("magpie", ...)` | `undefined`（自定义 provider 未注册） |
| `session.steer(...)` | `"queued"`，最终回答 `SDK_STEER_RECEIVED` |
| `session.abort()` | 返回，观察到 `agent_settled` |
| `SessionManager.open(<file>)` 恢复 | `resumeSawHistory = true` |
| `additionalExtensionPaths` 加载同一 extension 文件 | `sdkExtensionLoaded = true`，工具在 `getActiveToolNames()` 里 |

裸 factory 的细节值得单独记一句。SDK 默认 `ModelRuntime` 读 `agentDir/auth.json` 与 `models.json`，而 CLI 的有效配置还包括 `models-store.json` 里的 magpie 目录，以及 `pi-magpie` extension 的 `registerProvider`。缺了后者，默认模型解析落到另一个 provider，调用失败但**不抛异常**，只把失败写进 assistant message 的 `stopReason`。SDK 调用方必须检查 `stopReason`。

## 接入方式推荐与理由

| 维度 | CLI RPC | SDK |
| --- | --- | --- |
| 认证继承 | 开箱即用，已验证 | 需显式 `ModelRuntime`，已验证可用 |
| 默认模型/provider 解析 | 与 CLI 完全一致，已验证 | 与 CLI 不一致，需显式指定，已验证 |
| 运行中投递 | `steer` / `follow_up` 命令，已验证 | `session.steer()` / `session.followUp()`，已验证 |
| 停止 | `abort` 命令，已验证 | `session.abort()`，已验证 |
| 会话恢复 | `--continue` / `--session`，已验证 | `SessionManager.open/create/inMemory`，已验证 |
| extension | `-e`，已验证 | `additionalExtensionPaths` / `extensionFactories`，已验证 |
| 内置 codemode / tool_search / MCP | 默认加载 | 默认不加载，需显式注册（未验证） |
| 宿主代价 | 自己实现 JSONL 协议、命令关联、事件流、extension UI 子协议 | 直接调方法 |
| 隔离 | 进程边界天然成立 | 需自己套子进程（参考实现的做法） |

**推荐 SDK，跑在宿主管理的子进程里。**

- 进程边界与 SDK 不冲突。本实验和参考实现都证明「子进程里 import SDK」可行，既拿到类型化 API，又保留崩溃隔离。
- 每分身模型授权由宿主控制。`ModelRuntime` + `model` 是显式入参，正好落在租约边界上；CLI 的默认解析依赖本机 `settings.json`，不适合当授权来源。
- 加载集合可控。SDK 的 `DefaultResourceLoader` 需要显式声明内置 extension，Sprout 的 MCP 入口才有确定位置。CLI 会把用户目录下已装的 20 多个 extension 一并加载。

保留 RPC 作为备选，适用场景是：宿主不是 Node，或者要求 Pi 的配置解析与命令行完全一致而对协议实现不在乎。

### 需要显式加载的扩展

CLI 侧，`~/.pi/agent` 的 extension、内置 codemode / tool_search / MCP 默认生效，Sprout extension 用 `-e <path>` 加载（已验证）。

SDK 侧，内置 codemode、tool_search、MCP **不会自动加载**。文档给出的做法是把 `createCodemodeExtension()`、`createToolSearchExtension()`、`createMcpExtension()` 放进 `DefaultResourceLoader` 的 `extensionFactories`，并调用 `session.bindExtensions()`。本实验只验证了普通 `registerTool` extension 经 `additionalExtensionPaths` 生效，三个内置 extension 的 SDK 加载**未验证**，P1 接 MCP 前必须单独验证。

SDK 的 `DefaultResourceLoader` 默认仍会扫描 `~/.pi/agent/extensions` 与已装 package。Sprout 若不需要这些，必须换成受控的 resource loader，否则会把无关 extension 拉进每个分身 session。

### 认证继承需要的条件

1. `agentDir` 指向含 `auth.json` 的目录，默认 `~/.pi/agent`。SDK 用 `getAgentDir()` 取同一路径。
2. 不需要环境变量里的 API key。`env -i` 正向实验已证。
3. 自定义 provider（如 magpie）必须显式注册。SDK 裸 factory 不会注册，`additionalExtensionPaths` 加载 `pi-magpie/index.ts` 后 `getModel("magpie", ...)` 仍为 `undefined` 且 `extensionsResult.errors` 为空（原因未查明，**未验证**）。参考实现的做法是手动 `runtime.registerNativeProvider(provider)`，并对 `@earendil-works/pi-ai/compat` 做模块解析 hook。若 Sprout 使用网关型 provider，这条路线必须补做验证。
4. 会话持久化与认证是两件事。`SessionManager` 决定历史存哪，`ModelRuntime` 决定用谁的凭据。

## 失败行为记录

| 行为 | 观察 | 状态 |
| --- | --- | --- |
| 运行中发普通 prompt，未给 `streamingBehavior` | RPC 返回 `success:false` 与明确错误串 | 已验证 |
| 运行中 `steer` | `disposition:"queued"`，工具调用后送达，原任务被放弃 | 已验证 |
| 运行中 `follow_up` | `disposition:"queued"`，本轮结束后同 run 内补一轮 | 已验证 |
| `abort` | 返回 `success`，`isStreaming` 变 false，`agent_settled.aborted=true`，进程 exit 0 | 已验证 |
| abort 后恢复 | 会话文件完整，`--session` 可继续，历史可见 | 已验证 |
| SDK 裸 factory 模型调用失败 | 不抛异常，assistant message `stopReason:"error"` | 已验证 |
| `--tools` 指定不存在的工具 | 静默过滤，无错误，模型报告「没有该工具」 | 已验证 |
| RPC stdout 混有 `extension_ui_request` | 来自已装 extension 的 `setStatus`/`notify`，客户端必须容忍 | 已验证 |

## 未验证

- SDK 加载内置 codemode / tool_search / MCP。
- SDK 注册自定义 provider（magpie）的正确写法。
- RPC 的 extension 对话框子协议（`extension_ui_response` 往返）。
- 客户端停止读取 stdout 时的背压表现。
- 多分身并发时的资源占用与隔离。
- Windows。

## 对 `docs/architecture-direction.md` 的影响

需要更新，共三处：

1. 原文「Pi SDK session 是否加载内置 MCP extension 必须单独检查」现在有答案。SDK 默认不加载，必须用 `createMcpExtension()` 显式注册。这条从待查变成前提条件。
2. 原文默认「宿主 Pi 会继承 CLI 的全部配置」。对 SDK 不成立。SDK 继承凭据，但不继承默认 provider/model 解析。接入方式要写清显式 `ModelRuntime` 与显式 `model`。
3. `src/engine/pi-host.ts` 锁的是 Pi 1.0.4，本机现装 1.3.0。接入前要按 1.3.0 重新对齐 `createAgentSession`、`SessionManager`、`ModelRuntime` 的签名。本页实验全部基于 1.3.0。
