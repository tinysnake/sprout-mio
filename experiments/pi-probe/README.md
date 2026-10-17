# pi-probe

P0-d 最小实验：用本机真实 Pi 1.3.0 验证 Sprout 宿主直接管理 Pi 的接入面。结论文档在 `docs/p0/pi-integration.md`。

实验不改 `~/.pi` 任何文件。所有会话写到 `results/` 下的临时目录，不动 `~/.pi/agent/sessions`。

## 环境

| 组件 | 值 |
| --- | --- |
| Pi | 1.3.0（`/Users/snake/.pi/agent/bin/pi`，托管安装在 `~/.pi/agent/install/releases/1.3.0`） |
| Node | v26.11.1（`/opt/homebrew/bin/node`） |
| 默认 provider / model | `magpie` / `group/auto-deepseek-v4-1-flash`（自定义 gateway provider，由 `pi-magpie` extension 注册） |
| 参考的原 Sprout commit | `5b48a53b385ee8a4c0fff219954c6244506b0b9f`（`src/engine/pi-host.ts`、`src/engine/pi-host-runner.mjs`） |

## 重放 a 与 d

```bash
bash verify.sh
```

`verify.sh` 跑 7 个断言：认证继承、空配置目录反证、abort 响应、abort 后非 streaming、`agent_settled.aborted`、子进程干净退出、aborted session 可恢复。2026-10-16 结果 `passed=7 failed=0`。

## 全部实验

| 实验 | 命令 | 验证的接入面 |
| --- | --- | --- |
| a 认证与配置继承 | `env -i HOME=$HOME PATH=/opt/homebrew/bin:/usr/bin:/bin /Users/snake/.pi/agent/bin/pi -p --session-dir <tmp> "Reply with exactly PROBE_A_OK"` | CLI 从 `~/.pi` 继承登录与配置 |
| b 会话恢复 | `pi -p --session-dir <D> --name probe-b "Remember this codeword: BANANA7..."` 然后 `pi -p --session-dir <D> --continue "What codeword..."` | `--continue` / `--session <id>` |
| c 运行中投递（steer） | `node c-steer.mjs` | RPC `steer` 与 streaming 中未指定 `streamingBehavior` 的错误 |
| c2 运行中投递（follow_up） | `node c2-followup.mjs` | RPC `follow_up` 在同一个 run 内补一轮 |
| d 停止运行中的 agent | `node d-abort.mjs` | RPC `abort`、退出码、abort 后恢复 |
| e extension 加载 | `pi -p --session-dir <D> -e ./ext/sprout-probe.ts --tools sprout_probe_ping "Call the sprout_probe_ping tool..."` | `registerTool` / `registerCommand` / `on("session_start")` |
| f SDK 路径 | `node f-sdk.mjs` | `createAgentSession`、`ModelRuntime`、`SessionManager`、`steer()`、`abort()`、`additionalExtensionPaths` |

`c-steer.mjs`、`c2-followup.mjs`、`d-abort.mjs`、`f-sdk.mjs` 各自把原始记录与摘要写到 `results/`（该目录被 gitignore，可重跑再生成）：

- `<name>.summary.json` 判据字段
- `<name>.records.jsonl` RPC/SDK 原始记录（c/c2/d）
- `f-sdk-sessions/`、`d-sessions/`、`e-sessions/` 会话文件

## `lib/rpc.mjs`

自写的 RPC 客户端，故意只实现协议文档要求的最小面：按 LF 切分、持续读 stdout、stdin 关闭请求退出。它存在的意义是证明「自己写 RPC 客户端」的成本，也是 f 实验里 SDK 对照的基线。

## 依赖

无。脚本只用 Node 内置模块，SDK 用绝对路径从托管 release 导入（`~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js`），和原 Sprout `pi-host-runner.mjs` 的加载方式一致。
