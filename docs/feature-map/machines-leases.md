# Machine 与 Lease

用户创建 Machine、完成 worker 配对，检查根目录与项目绑定，再把执行环境交给项目内的 AgentInstance。领域规则见 [Machines 决策](../machines-decisions.md)；相关运行路径见 [Chat 与 Run](chat-runs.md)和[远程执行与日志](remote-execution.md)。

## Sub-features

- `machine-enroll` 创建、显示与更新配对票据、首次配对和重连。
- `machine-status` 查看连接状态、能力、shell 信息与诊断。
- `machine-bindings` 设置根目录和项目绑定，刷新后保持，项目间相互隔离。
- `lease-lifecycle` 获取、释放、移交租约，并查看持有者与待处理状态。
- `lease-generation` 旧代次操作被拒绝，远端执行遵守当前租约。
- `lease-entry` Machine 管理页与 Info Hub 事实及管理链接一致。
- `lease-escrow` 分身把租约原地挂靠到 Group、由 Group 内分身领取、发起者撤销；人类只有可见性与强制收回。
- `lease-wait` 分身申请租约遇阻时在工具里阻塞等待（`sprout_lease_wait`），到点拿到失败与原因自行决定是否结束当前 run。等待对持有者完全不可见，既不抢占也不释放。
- `lease-timeout` 挂靠长时间没人处理时只提醒不释放：Agent owner 被直接唤醒去处理，人类 owner 只在 chat 里收到一条提醒且不产生自动接续；再过升级时限才升级 Human 并暂停该 owner 在这个挂靠上的自动尝试。

## How to get to it (user POV)

- 从全局 Machines 导航进入 `/machines`，创建 Machine，打开 `/machines/$machineId`。
- 按详情页安装和配对说明启动 worker；配对后查看状态、根目录和项目绑定。
- 从 Machine 详情的租约入口进入 `/machines/$machineId/lease`，选择相关项目与持有者，操作租约。
- 从项目或 Chat 的 [Info Hub](info-hub.md) 查看租约事实，沿管理链接进入同一租约页。

## Driving it with Playwright and verify scripts

前置条件是专用数据库、空闲端口、一次性 worker state directory 和测试根目录。租约操作还需项目成员及对应 Chat / AgentInstance。真实移交验收另需模型凭据。禁止把验收 worker 接到日常使用的 Machine 或目录。

| 路径                      | 命令或定位                                                                                                                 | 必须观察的结果                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实 Machine UI 与 worker | `bash scripts/verify/u-machine-ui.sh`，driver 是 [p4a-machine-flow.mjs](../../scripts/browser/p4a-machine-flow.mjs)        | 待配对到已配对的过程、连接和能力事实、配置保存、绑定隔离、票据和访问边界                                                                                                                  |
| Machine 操作定位          | `machine-name-input`、`machine-create-submit`、`machine-ticket-toggle`、`machine-renew`、`machine-refresh`                 | 新 Machine 身份保持；票据显隐与更新正确；实际 worker 连接后状态更新                                                                                                                       |
| 根目录与绑定              | `machine-root-directory`，其余表单沿 driver 操作                                                                           | 保存及刷新后值保持，切换项目没有串用绑定                                                                                                                                                  |
| Lease 界面与交互          | `bash scripts/verify/y-lease-ui.sh`；开发场景 driver 是 [p4b-lease-scenes.mjs](../../scripts/browser/p4b-lease-scenes.mjs) | 操作入口、持有者、移交及错误展示；该路径使用 fixture，无远端执行                                                                                                                          |
| Lease 真实链路            | `bash scripts/verify/z-lease-integration.sh`                                                                               | 实际 worker / Agent 运行、租约代次、持有者与移交结果对应；不能以场景截图替代                                                                                                              |
| Lease 挂靠与领取真实链路  | `bash scripts/verify/p8a-lease-integration.sh`                                                                             | 分身挂靠、旧持有者被拒、Group 成员领取、撤销回发起者；三者都经真实 Agent 工具与 worker                                                                                                    |
| 挂靠超时与等待的契约域层  | `bash scripts/verify/p8b-timeout.sh`                                                                                       | 计时起点是挂靠被接受时刻、只提醒一次、agent / human owner 分流、升级后暂停 owner 自动尝试、默认 30 分钟 / 2 小时与 5 分钟等待上界（1 小时封顶）                                           |
| 挂靠超时与等待的真实链路  | `bash scripts/verify/p8b-timeout-integration.sh`                                                                           | 分身经真实 `sprout_lease_wait` 阻塞等待（全程只发 `lease_get`）、到点返回失败与原因、持有者侧无任何消息或 run；提醒与升级由生产 scheduler 的 `advance()` 驱动，关闭自动接续的 chat 也照发 |

契约层改动先选 [s-machine-contracts.sh](../../scripts/verify/s-machine-contracts.sh) 或 [v-lease-contracts.sh](../../scripts/verify/v-lease-contracts.sh)；挂靠超时或申请等待改动先跑 [p8b-timeout.sh](../../scripts/verify/p8b-timeout.sh)，改到工具接线或提醒 / 升级驱动再加 [p8b-timeout-integration.sh](../../scripts/verify/p8b-timeout-integration.sh)。worker 协议变化再查 [t-machine-worker.sh](../../scripts/verify/t-machine-worker.sh) 与 [w-worker-remote.sh](../../scripts/verify/w-worker-remote.sh)。这些是按风险组合的入口，不需要因为同属 Machine 而全部运行。

U 脚本依赖当前代码的 `.output` 与 worker 构建产物，准备方式见 [worker artifact helper](../../scripts/verify/lib/ensure-worker-artifact.sh) 和项目 build 命令。driver 自己启动 production server，默认 `BASE_URL` 是 `http://127.0.0.1:3120`。证据在每次新建的 `.verify/p4a-machine-flow-*`，包含 `results.json`、日志和截图，最终输出打印实际路径。

Y 脚本自己启动 dev server，默认端口 3099，可用 `SPROUT_LEASE_SCENES_PORT` 调整。截图默认在 `.verify/p4b-ui/evidence`，日志在 `.verify/p4b-ui`。真实租约链路的日志与 JSON 位置以 [z-lease-integration.sh](../../scripts/verify/z-lease-integration.sh) 为准，记录动作与最终状态。

## Gotchas

- U 脚本使用专用数据库和真实 worker，但关闭 Pi。它不证明模型已正确使用租约或远程工具。
- `y-lease-ui.sh` 访问 `/__dev/ui/`。fixture 中点击后的状态变化只能证明呈现组件和场景交互。
- `lease-chat-select`、`lease-transfer-target` 等控件可能依赖可用 Chat。缺少前置记录时保留失败原因，不能删掉移交断言。
- 仅截图持有者文本不能证明旧 generation 被拒绝。涉及代次、强制移交和执行中止时，要核对真实链路响应与副作用。
- 挂靠、领取、撤销挂靠没有人类入口。三条命令只由分身通过 `sprout_lease_escrow`、`sprout_lease_claim`、`sprout_lease_escrow_cancel` 发起，人类只有可见性与强制收回；界面不需要为它们增加按钮。
- 超时提醒、升级与等待都不改变占用事实：它们只加只读的超时标记，绝不释放租约，也绝不向持有者发送任何资源请求；系统里不存在「协调请求」这个实体或通道。
- 验证挂靠超时不要直接调 `sweepLeaseEscrowTimeouts`：真实驱动路径是 `createContinuationScheduler` 的 `advance()`。时限用 Project 级 `wake_policy.leaseTimeouts` 压缩（默认 30 分钟 / 2 小时，最小 1 秒），产品代码读的是同一个配置，不是测试替身。
- 挂靠超时的提醒与升级不受 chat 自动接续开关影响；推送只做 chat 消息加（Agent owner 的）直接唤醒，唤醒失败沿用既有 agent-run 重试规则，不新增退避参数。
- 等待期间在现场只应看到 `lease_get`：一旦出现写入类远端调用，说明等待路径被接错了。
- 截图与日志里保留必要状态，配对票据和 worker 凭据按脚本的脱敏规则处理。
