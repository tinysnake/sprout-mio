# P8 章节结论：二期四项能力

P8 交付二期的四块能力：租约挂靠与领取、挂靠超时提醒与申请遇阻等待、Agent 强制移除与自动善后、Windows Worker。判据与边界见 [核心范围](../core-scope.md)、[Machines 决策](../machines-decisions.md)、[Communication 决策](../communication-decisions.md) 与 [架构方向](../architecture-direction.md)。

技术交付基线：**`f9caed5`**（`integration/p8b`，合入 main 的最新 P8 功能提交）。此后的生产构建收口提交是 **`b86c4f9`**（历史快照降级、租约页两处修复与数据迁移 `0039`），它也是 Human 亲自体验确认的版本。

| 项       | 值                                                                                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 交付线   | 功能、UI、集成三线，四个集成单元 I-P8a/I-P8b/I-P8c/I-P8d                                                                                                                                                                                                                           |
| 新增契约 | `src/contracts/lease.ts`（`leaseEscrow*`、`lease_wait`）、`src/contracts/project-wake-policy.ts`（`leaseTimeouts`）、`src/contracts/project-member-removal.ts`（`projectMemberRemovalOutcome`）、`src/contracts/remote.ts`（三条挂靠工具、`sprout_lease_wait`、平台与 shell 能力） |
| 迁移     | `0037_p8a_lease_escrow`（`lease_escrow` + `lease_authorization` 重建）、`0038_p8b_lease_timeout`（超时与提醒列）、`0039_wake_evaluation_provider_repair`（复用 P8 预留号，回填旧库 `wake_evaluation` 的 provider 快照）；`0040`–`0046` 未使用                                      |
| 门禁     | `p8a-lease-escrow`、`p8a-lease-integration`、`p8b-timeout`、`p8b-timeout-integration`、`p8c-removal`、`p8c-removal-integration`、`p8d-windows-worker`（MANUAL）、`p8d-windows-integration`（MANUAL），加 `y-lease-ui`、`p8a-escrow` 等既有回归                                     |

## 交付了什么

1. **挂靠与领取。** 持有者把自己的租约挂靠到本 Project 的 Group / Public Channel（可指定 Group 内的 Agent）；挂靠期间 `machine_lease` 仍 `held`、持有者字段不变、原持有者的授权转 `escrowed` 并失去操作权；Group 内的分身凭自己的身份领取后 `generation + 1` 成为新持有者；发起挂靠的分身可撤销收回。**这三条命令没有人类入口**：人类只有只读事实与强制收回，界面不提供表单、按钮，也不用「发指令消息」替分身代劳。
2. **挂靠超时提醒与升级。** 超时从挂靠被接受时刻起算，默认 30 分钟，可按 Project 覆盖；只加只读标记与一条提醒消息，绝不释放租约。Group owner 是 Agent 时直接唤醒并说明要处理什么，owner 是人类时在该 Group 的 chat 里留一条消息（不触发唤醒、不自动接续）；只提醒一次；owner 为 Agent 且超时后再 2 小时仍未处理时升级给人类，并暂停该 owner 的自动尝试。超时与升级**不受「人类暂停自动唤醒」影响**，是那条规则的明确例外。
3. **申请遇阻只等待。** 没有「自动协调」这回事：不发请求、不合并、不重查、不广播。申请方 Agent 一次阻塞式等待（自己指定时长，建议 5 分钟、上限钳到 1 小时，不提供 Project 级配置），到点同步拿到失败与原因，由它自己决定是否提前中止当前 run 并汇报。等待期间该身份不接其他工作；等待永不释放租约。
4. **强制移除与自动善后。** 人类确认后中止本项目全部活动 runs、剥夺参与与操作权，不要求先逐项清理；Group/Public Channel owner 默认转给 Project 创建者，Tasks 留原对话，DM 未完成且仍分配给该 DM 的 Tasks 退回 `proposed` 并清空分配；确认撤权后自动释放租约，**无法确认时保留待处理占用（`fencing` + `pending`），绝不显示空闲**；文件与进程不自动清理，其他 Projects 不受影响。交接确认门会重查目标：租约不会被落到已移除的实例名下。
5. **Windows Worker。** 分别探测 PowerShell 7、Windows PowerShell 5.1、cmd 的路径/版本/自检并如实上报，按 kind 分派调用；文件操作走跨平台 API；进程取消用 `taskkill /T /F` 并只报「已投递」；区分用户登录 session；长命令在 Windows 上杀 runner 即随控制台结束，不伪造结果、不重跑；重连同序号请求幂等。
6. **呈现收敛。** 挂靠中取代「持有中」，「挂靠中 · 超时未处理 / 已升级给人类」作为后缀并入状态位；租约页只剩状态事实与人类可做的「强制收回」；Chat 里的超时提醒是一条消息；强制移除的善后结果是弹窗；Machine 详情给出执行环境与 shell 探测事实。演示场景不再虚构人类没有的权利。

明确不在二期：项目级 Agent 权限等级（`role`）、成本统计、图形桌面工具、其他 harness 与 MCP server、固定开发 workflow、Linux 验收范围。

## 怎么验的

- **门禁**：`bash scripts/verify/p8a-lease-escrow.sh`、`p8a-lease-integration.sh`（12 项通过，真实走一遍挂靠→原持有者写被拒→领取→新持有者读写的链路）、`p8b-timeout.sh`、`p8b-timeout-integration.sh`（真 SQLite + 真 `PiSessionProcess` + 真 HTTP + 生产调度器，时限压到秒级）、`p8c-removal.sh`（四个场景 80 条断言）、`p8c-removal-integration.sh`（含交接确认门硬断言）、`y-lease-ui.sh`（p4b 18 + p8a 5 + p8b 8）。
- **Windows**：`p8d-windows-worker.sh`（10 项）与 `p8d-windows-integration.sh`（14 项通过 + 1 项按设计 UNVERIFIED）在真实 Windows 11 机器上跑，覆盖三条 shell 的真实版本、诚实性反证（没有 shell 就报缺失）、文件操作字节等价、进程树整体终止、session 映射、长命令恢复不重跑、重连去重。
- **独立验收**：I-P8a 与 I-P8c 各由一个只读验收 agent 复核（不复用实现者），结论均为可合入；I-P8c 的交接缺口由验收证据复现、修复后由反向打补丁实验证明承重。
- **全量**：`pnpm verify` 在 `03e8f87` 上 124 项通过、5 项失败，5 项全部与 P8 无关——`b-tooling`、`x-remote-tools`、`ae-remote-tools-cancel-log` 是宿主缺托管 Pi SDK（在 P8 合并前的 `b40bf65` 上可复现同样失败），`d-runtime` 与 `aq-p4d-pages` 是机器负载导致的超时，单独重跑均通过。
- **未验证**：真实 30 分钟与 2 小时墙钟（只用压到秒级的覆盖值验过）、进程重启后的超时恢复、跨进程 `identity_busy`、等待被 signal 中断、Windows 桌面会话（sshd 固定 Session 0，`interactive_desktop` 判定与桌面用户环境不可验）、Windows 断网与重启恢复矩阵、`tasklist` 200 行截断分支。

## 功能线证据

- **挂靠与领取**（`f9caed5`）：`escrowLease` / `claimLease` / `cancelLeaseEscrow` 三个域函数、`lease_escrow` 表与三条挂靠工具、领取后 `generation + 1` 换持有者、原持有者授权转 `escrowed` 后写入被拒。重跑 `bash scripts/verify/p8a-lease-escrow.sh`。
- **挂靠超时提醒与遇阻等待**（`f9caed5`）：`src/domain/lease-timeout.ts` 的超时与升级判定、`src/domain/lease-wait.ts` 的阻塞式等待、`project.wake_policy.leaseTimeouts` 覆盖值；超时只加标记与一条消息，永不释放租约。重跑 `bash scripts/verify/p8b-timeout.sh`。
- **强制移除与自动善后**（`f9caed5`）：`forceRemoveProjectMember` 的「中止 runs、转接责任、退回 DM Task、释放租约」顺序，无法确认撤权时保留 `fencing` + `pending`。重跑 `bash scripts/verify/p8c-removal.sh`。
- **Windows Worker**（`e4fc55f`）：`src/worker/platform.ts`、`src/worker/probes.ts` 的三条 shell 探测与按 kind 分派、`taskkill /T /F` 取消、session 映射。重跑 `bash scripts/verify/p8d-windows-worker.sh`（MANUAL，缺真实 Windows 会明示失败）。

## UI 线证据

- **呈现收敛**（`f9caed5`）：挂靠中取代「持有中」，「挂靠中 · 超时未处理 / 已升级给人类」并入状态位，租约页只剩状态事实与人类可做的强制收回，Chat 里的超时提醒是一条消息，强制移除的善后结果是弹窗，Machine 详情给出执行环境与 shell 探测事实。重跑 `bash scripts/verify/y-lease-ui.sh`、`bash scripts/verify/p4a-machine-scenes.sh`。
- **两轮评审的删改**（`b86c4f9`）：删除人类的申请/释放/交接入口与租约页解释文字、重复标题合并、提醒不再解释「不会唤醒」、Machine 不属于本 Project 时不再请求执行事实、没有 `held` 租约时不渲染强制收回。重跑 `bash scripts/verify/p4a-machine-scenes.sh`。

## 集成线与技术验收证据

- **四个单元的集成门禁**（`f9caed5`）：`p8a-lease-integration` 用真实 domain 走完挂靠→原持有者写被拒→领取→新持有者读写；`p8b-timeout-integration` 在真 SQLite + 真 `PiSessionProcess` + 真 HTTP + 生产调度器上跑；`p8c-removal-integration` 覆盖四个场景与交接确认门；`p8d-windows-integration` 覆盖三条 shell 真实版本、诚实性反证、文件字节等价、进程树终止与 session 映射。重跑 `bash scripts/verify/p8a-lease-integration.sh`、`bash scripts/verify/p8b-timeout-integration.sh`、`bash scripts/verify/p8c-removal-integration.sh`、`bash scripts/verify/p8d-windows-integration.sh`（MANUAL）。
- **交接确认门**（`b40bf65`）：目标已被移除时拒绝把租约交出去，保留 `fencing` + `pending` 而绝不置 `free`；反向打补丁实验证明该断言承重。重跑 `bash scripts/verify/p8c-removal-integration.sh`。
- **旧数据降级与迁移 `0039`**（`b86c4f9`）：判定结果兼容旧枚举、`turn_context` 快照解析失败按「不可用」降级、`wake_evaluation` 的 `small_brain` 快照回填为 `llm`。重跑 `bash scripts/verify/p8a-lease-integration.sh`。
- **独立验收**（`b40bf65`、`e4fc55f`）：I-P8a 与 I-P8c 各由一个只读验收 agent 复核（不复用实现者），结论均为可合入；I-P8b 与 I-P8d 由编排者在合并前逐门禁复跑。重跑 `bash scripts/verify/p8c-removal-integration.sh`。

## Human 体验确认

四块能力分两轮在真实页面上评审：第一轮看 I-P8a/I-P8c（当场指出挂靠与领取的「主体错位」——人类不该有领取按钮，`docs/frontend-design.md` 的「简洁优先」原则据此写入并要求删掉租约页的说明文字与人类入口），第二轮看 I-P8b/I-P8d。评审结论为通过，删改按 Human 指示落地：删除人类申请/释放/交接入口、删除租约页与远端操作区的解释文字、重复标题合并、超时提醒不再解释「不会唤醒」。之后 Human 明确「集成效果没出来之前不再审演示 UI」，改为在真实生产构建上评审。2026-11-08 Human 在 3200 上的生产构建（含 `b86c4f9`）走查了按 P8c → P8a → P8b → P8d 排出的优先级，回复「好了，没问题，过」，四条 checklist 据此按证据勾选。

- 确认记录：Human 亲自体验确认通过，版本 `b86c4f9`
