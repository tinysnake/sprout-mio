# 远程执行与日志

Agent 使用远程工具操作 Machine，用户从项目、Chat 或 Machine 租约上下文查看执行、读取日志和取消请求。契约见 [P4b 执行契约](../p4b/contracts.md)与 [P4c 长命令与日志契约](../p4c/contracts.md)。

## Sub-features

- `remote-tools` 文件与命令工具走目标 Machine，遵守当前租约和目录边界。
- `long-command` 长命令持续输出、正常结束及超时。
- `execution-log` 按 cursor 读取日志，识别缺口、截断与不可用状态。
- `execution-cancel` 提交取消请求并观察执行最终状态与副作用。
- `execution-recovery` 断连和重启后的执行状态、日志恢复及不确定结果。
- `execution-context` 执行身份、Run、持有者和授权代次对应同一目标。

## How to get to it (user POV)

- 在具备 Machine 与 Lease 的 Chat 中，让 Agent 使用远程工具，产生一条执行记录。
- 在项目设置、Chat 的 Info Hub 或 Machine 租约页查看执行记录。当前接入分别见 [Project Settings](../../src/routes/_authed/projects.$projectId.settings.tsx)、[Chat Inspector](../../src/components/info-hub/chat-inspector.tsx)和 [Machine Lease](../../src/components/machine/machine-lease.tsx)。
- 从记录展开日志，执行允许的取消操作，观察请求状态与最终结果。
- 开发场景从 `/__dev/ui/` 的 Machine 场景进入执行记录，用于检查呈现与交互分支。

## Driving it with Playwright and verify scripts

真实链路的前置条件是已配对 worker、测试根目录、项目绑定、有效 Lease 和可用 AgentInstance。Agent 端工具路径还需当前 extension 构建产物。UI 分支若没有真实执行记录，先通过远程工具产生记录，再沿实际页面打开。

| 改动或要证明的行为       | 验证入口                                            | 证明标准                                                                 |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------ |
| 远程工具路由与权限       | `bash scripts/verify/x-remote-tools.sh`             | 返回值与目标 Machine 的实际文件或命令副作用一致，宿主未代替远端执行      |
| 执行日志契约             | `bash scripts/verify/aa-execution-log-contracts.sh` | 合法记录与 cursor 行为通过，非法输入被拒绝                               |
| worker 长命令            | `bash scripts/verify/ab-worker-long-command.sh`     | 命令进程、输出、结束与超时事实一致                                       |
| 恢复与日志               | `bash scripts/verify/ac-execution-recovery-log.sh`  | 重启或恢复后的状态与保留日志相符，不把未知结果报告为成功                 |
| Agent 工具取消与日志链路 | `bash scripts/verify/ae-remote-tools-cancel-log.sh` | 工具请求、worker 动作、日志及取消后的结果对应同一执行                    |
| UI 状态、日志和取消呈现  | `bash scripts/verify/ad-execution-log-ui.sh`        | 开发场景的按钮、日志、错误和状态转换符合 fixture；不据此判断真实取消成功 |

浏览器呈现路径在 [p4c-execution-scenes.mjs](../../scripts/browser/p4c-execution-scenes.mjs)，通过 `machine-executions-link` 进入 `executions-scene`。真实 Chat 中的记录以 `chat-executions` 为入口，单条记录的状态、日志与取消控件由 [remote-execution-panel.tsx](../../src/components/machine/remote-execution-panel.tsx) 的 `testId` 前缀生成，按当前记录的执行标识定位。

AD 脚本自己启动 dev server，默认端口 3098，可用 `SPROUT_EXECUTION_SCENES_PORT` 调整；默认截图在 `.verify/p4c-ui/evidence`，日志在 `.verify/p4c-ui`。AE 在 `.verify/ae-remote-tools-cancel-log-*` 保存 `evidence.json`。其他领域脚本使用各自 `.verify/` 目录，运行前核对脚本的路径与依赖。

证据保存命令开始、输出、取消动作、最终状态、执行标识以及目标目录中的副作用。涉及日志恢复时，保存断开前后的 cursor 与读取结果。

## Gotchas

- `ad-execution-log-ui.sh` 使用开发 fixture。组件交互通过后，真实链路与实际页面入口仍按改动验证。
- 取消请求被接受与远端进程已终止是不同事实。检查实际执行状态和副作用。
- 日志缺口、截断、超时及结果未知都有独立语义，不能因为最后一屏可读就忽略。
- 项目设置、Chat Inspector、Machine Lease 共用呈现组件。修改共享组件后，按受影响入口覆盖，不能只验证最方便的开发场景。
- worker 或 extension 代码变化后，先按脚本要求准备当前构建产物；旧 bundle 的成功结果不能证明当前源码。
