# P8d 契约增量：Windows Worker

本页记录二期 Windows 支持的契约变化。一期（P4a–P4c）冻结的字段语义不变，改动只有三类：把「只有 macOS」的字段放宽为「跨平台」、为平台事实增加可选字段、把只适用于 POSIX 的执行假设换成按平台分派。没有新增迁移，没有改变请求/响应的操作集合。

## 能力快照

`capabilitySnapshotSchema`（`src/contracts/machine.ts`）的变化：

| 字段                   | 之前                              | 现在                                                                                              |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `platform`             | `"darwin"`                        | `"darwin"` 或 `"win32"`                                                                           |
| `shells[].path`        | 以 `/` 开头                       | 绝对路径：POSIX、盘符（`C:\` 或 `C:/`）或 UNC（`\\server\share`）；仍限 1–4096 个 JS 字符且无 NUL |
| `shells[].kind`        | `zsh` / `bash` / `sh` / `unknown` | 追加 `pwsh`（PowerShell 7）、`powershell`（Windows PowerShell 5.x）、`cmd`                        |
| `executionEnvironment` | 不存在                            | 可选 `{ sessionId: number \| null, sessionKind }`，见下                                           |

`macosAbsolutePathSchema` 保留为一期契约名称的别名，指向同一套绝对路径校验；一期的文档与测试可以继续引用它。

`executionEnvironment` 可选是有意的：旧 Worker 不上报时页面显示「执行环境未上报」，不默认成桌面会话。`sessionKind` 取值：

- `service_session_0`：Windows 服务会话（sshd 等），没有交互桌面。
- `interactive_desktop`：登录后的桌面会话。
- `not_applicable`：非 Windows 平台。
- `unknown`：读不到 SessionId 时的诚实结论。

SessionId 只报实测值，读不到就给 `null`，不用 `0` 占位。

`cmd` 的版本号取 `ver` 输出里的数字部分（如 `10.0.26300.9711`），因为版本横幅随系统语言本地化，原文不是稳定事实。

## shell 调用

探测与执行共用一套调用语法（`src/worker/platform.ts` 的 `shellInvocation`，runner 内保持同一份规则）：

| kind                                      | 参数                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| `pwsh` / `powershell`                     | `-NoLogo -NoProfile -NonInteractive -Command <text>` |
| `cmd`                                     | `/d /s /c <text>`                                    |
| 其他（`zsh` / `bash` / `sh` / `unknown`） | `-lc <text>`                                         |

命令正文始终是单个 argv 元素，不拼引号、不解析 shell 文本。文件读写继续走 `node:fs`；进程列表在 Windows 用 `tasklist /FO CSV /NH` 并按 CSV 解析，POSIX 仍是 `ps -axo pid=,comm=`；工作目录按 root 自己的分隔符拼接。

Windows 候选 shell 依次为：PATH 上的 `pwsh.exe`（否则 `%ProgramFiles%\PowerShell\7\pwsh.exe`）、`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`、`%ComSpec%`（否则 `%SystemRoot%\System32\cmd.exe`）。每个候选仍要过版本与自检，探测失败只降级该条能力，不编造成功。

## 执行与恢复

进程树：POSIX 保持「命令自成进程组、信号打 `-childPid`」；Windows 没有可送达的 SIGTERM，取消与超时一律 `taskkill /PID <pid> /T /F`，因此 `process_signal` 在 Windows 上也按子树强制终止，并且必须报 `kill_delivered`，不能报 `term_delivered`。

runner：Windows 上命令不使用 `detached`。实测 PowerShell 7 在 `detached: true` 下会丢弃继承的输出（inherited 与 piped 两种 stdio 都为空），而日志回传是必要的；Windows 的取消本来就用 `taskkill /T` 打 `childPid`，不依赖进程组。代价是 Windows 上 runner 被杀死时命令会随控制台一起结束：此时磁盘上仍没有 `result.json`，恢复只能把它当成「未观测退出」（`child-exited-without-result`），自动重启不得重跑。POSIX 行为不变，命令在 runner 死后继续运行。

重连与去重沿用一期：同一 `attemptId` 的重复提交交给恢复事实，不重跑；`runner.json` 的 claim 与 `result.json` 是唯一权威，先 tmp 后 rename。

## 呈现

`machine-shell-summary` 在 Shell 能力小节里直接列出每个 shell 的 `✓/✗/?`、自检结论（失败原因用中文，如「找不到可执行文件」）、等宽字体路径与版本；完整版本串与检查时间仍在「查看完整探测详情」弹层里。执行环境单独一行，五种说法互不相同：未上报 / 会话未知 / 不适用（非 Windows）/ 服务会话（Session 0）/ 交互桌面 · Session N，带实测 SessionId。除「不适用」外都标「桌面相关能力未验证」，只有实测在交互桌面会话里才不标。Windows 上 pwsh 不可用时给降级提示，写清当前可用的是 Windows PowerShell 5.1 还是只有 cmd。设计判断与截图见 `orchestrate/sprout-mio-p8/reports/p8d-ui-design.md`。

## 验证边界（真实 Windows，Session 0）

`scripts/verify/p8d-windows-worker.sh` 在真实 Windows 主机上验证：平台与架构、三种 shell 的路径/版本/自检、执行环境与 SessionId 自洽、目录探测、三种 shell 经 runner 执行、退出码透传、进程树终止、runner 被杀后不伪造结果。它属于 MANUAL 门禁：没有 Windows 主机时明确失败，不静默通过。

`scripts/verify/p8d-windows-integration.sh` 在同一台机器上走生产路径（`RemoteDispatcher`）做端到端验收：能力探测的诚实性反证（候选 shell 全缺失时报 `missing` 不报成功、不声明 shell 能力）、跨平台文件操作、进程枚举与 `taskkill /T /F`、Session 0 与桌面会话的区分、取消只报 `kill_delivered`、重连去重（同序号原帧幂等、同 executionId 换序号报 `stale_generation`）、runner 被杀后的未观测退出与重启不重跑。同样是 MANUAL 门禁：没有 Windows 主机时明确失败。它用的 harness 是 `tests/fixtures/p8d-windows-integration.ts`。

在这台以 sshd 进入的机器上，SessionId 固定为 0，因此**不能**验证：登录桌面会话下的 `interactive_desktop` 判定、桌面用户环境（托盘、交互式凭据、图形程序）、服务会话与桌面会话的差异行为。这些只能在有桌面登录的 Windows 机器上复验，报告里必须按实际所在 Session 写明，不能把 Session 0 的结论外推成「Windows 桌面亦然」。
