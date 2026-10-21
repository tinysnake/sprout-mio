# P3 结论一览

Human 已能在 DM 中分析已推送仓库，无需创建 Task 或申请 Machine 租约。同一持久分身跨轮次与宿主重启复用 Pi session，运行中的新消息进入当前轮，用户停止不会生成假回复。独立验收判定七条清单中六条成立，第 2 条未完整交付，保持未勾。详细证据见 [P3 阶段验收](acceptance.md#七条-checkbox-逐条判定) 与 [开发计划](../development-plan-functional.md#p3-跑通真实-pi-对话和仓库入口)。

实现基线为 `db185f8`，a 至 d 的实现与合入范围为 `db185f8..e5e2b4e`。`git log --first-parent --oneline db185f8..e5e2b4e` 可重建 PR #19 至 #22 的合入顺序。下表的 head 与 merge 经 Git 和编排 store 字段比较核对。验收与收尾不增加应用能力。

## 各 unit 结论与复跑入口

| unit                 | PR、head 与 merge                       | 结论与证据                                                                                                                   | 复跑入口                                                                              | 未验证项                                                      |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| a，Pi session 与 run | PR #19，head `dcd1ddd`，merge `34b078e` | [持久分身、状态与恢复](pi-session.md#数据与事务)，SDK 子进程、只读宿主认证、配置快照、Sprout extension 与跨重启续史成立      | `bash scripts/verify/n-pi-session.sh`，`bash scripts/verify-live/pi-dm-turn.sh`       | 宿主完整工具面、magpie native provider 真实推理与缺省模型回退 |
| b，轮次语义          | PR #20，head `32eac6c`，merge `a73770c` | [steer、停止与错误](turn-semantics.md#领域路径)，同分身串行、运行期投递、aborted 无回复、profile 下一轮生效                  | `bash scripts/verify/o-turn-semantics.sh`，`bash scripts/verify-live/pi-dm-turn.sh`   | pending 人工重投与清理、follow_up、多分身并发                 |
| c，宿主仓库入口      | PR #21，head `e51fe69`，merge `0d51b1f` | [复用与按需克隆](repo-entry.md#两种入口)，每轮 provenance 与快照 commit 相符；认证错误、磁盘超限显式失败                     | `bash scripts/verify/p-repo-entry.sh`，`bash scripts/verify-live/pi-repo-analysis.sh` | 公网 https/ssh 认证与代理、大仓库、跨进程锁、淘汰             |
| d，Info Hub run 视角 | PR #22，head `eb4d141`，merge `55da85f` | [真实 run 与轮初上下文](info-hub-runs.md#契约变化)，两视角显示状态、错误、pending 与仓库依据；上下文不注入 prompt            | `bash scripts/verify/q-info-hub-runs.sh`                                              | N+1、无分页无缓存、面板不轮询、多 DM 同时活动的 UI            |
| e，阶段验收          | 只读，无 PR、无 head 或 merge           | [六条成立、一条部分交付](acceptance.md#阶段结论)，glm 家族在承担本次验收前未参与 P3 产出；独立于 a/f 的 sol 与 b/c/d 的 mimo | [门禁、live 与最小实验](acceptance.md#可复跑的最小实验清单)                           | [本验收没有覆盖的面](acceptance.md#本验收没有覆盖的面)        |
| f，收尾              | PR #23，head `aa41061`，merge `e5e2b4e` | 验收正文落地、P2 文档过期表述更正、plan 状态与下一任务、SO28/SO29 进 conventions、`l-docs.sh` 七类新断言                     | `bash scripts/verify/l-docs.sh`                                                       |

## Ledger 与验收五行视图

以下是四行 ledger verdict 加一行只读验收的合并视图。e 的结论来自阶段 decisions 与验收正文，不是第五行 ledger，不填造 PR 或 SHA。各行的脚本数量和运行结果只描述当时观测，不能当作最新 HEAD 的结果。

| unit | 来源与 verdict                                                      | 已有证据                                                                                                                                                                                    | 独立性边界                                                          |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| a    | ledger PR #19，`live-ui-verified`                                   | coordinator 复跑真实模型、跨 SIGTERM 重启同 session、真实 Chromium；[a 的命令记录](pi-session.md#可复跑证据)                                                                                | `coordinator-rerun`，不是阶段干净的独立验收                         |
| b    | ledger PR #20，`live-ui-verified`                                   | coordinator 复跑 steer、停止无回复与 profile 下一轮；[b 的命令记录](turn-semantics.md#可复跑证据)                                                                                           | `coordinator-rerun`，独立性不由 verdict 字面推出                    |
| c    | ledger PR #21，`live-ui-verified`                                   | coordinator 复跑真实模型读推送仓库，快照、provenance 与远端 commit 三方一致；[c 的真实与桩边界](repo-entry.md#真实与桩的界限)                                                               | `coordinator-rerun`；F2 的 SHA 损坏说法已判为显示层脱敏误报         |
| d    | ledger PR #22，`live-ui-verified`                                   | coordinator 复跑门禁与 live；[d 的验证记录](info-hub-runs.md#验证记录)                                                                                                                      | verifier 明示与 b/c 作者同属 mimo，不能宣称独立于 b/c               |
| e    | 只读阶段验收，六成立一部分交付                                      | [七条逐项判定](acceptance.md#七条-checkbox-逐条判定)、[直接实验](acceptance.md#可复跑的最小实验清单)；coordinator 独立复验快照并裁定 F2                                                     | glm 在本次验收前没有 P3 产出，相对 a/f 的 sol 与 b/c/d 的 mimo 独立 |
| f    | ledger PR #23，`unit-test-verified`，head `aa41061` merge `e5e2b4e` | 收尾：验收正文落地、`docs/p3/summary.md`、plan 状态与下一任务、P2 文档过期表述更正、`docs/p1/conventions.md` 的 SO28/SO29 规则、`l-docs.sh` 七类新断言（故意破坏全部变红）；merge `e5e2b4e` | `coordinator-rerun`，作者与 p3-a 同属 sol 家族                      |

F2 的实际文件比较显示 PR #21 head 与 `git rev-parse 0d51b1f^2` 相等，各为 40 字节，`units.tsv` 与 `status.md` 同样无损。长十六进制串的工具显示可能脱敏。文件内容必须由比较的退出码或校验和判断。冻结验收保留了原误报的尾部引用，其 [F2 更正行](acceptance.md#ledger-与证据一致性1922-逐行) 给出裁定。

## P3 清单最终状态

| 项                                           | plan 状态        | 判定与证据                                                                                                                                                                              |
| -------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1，持久分身映射 session、每轮快照与 run 状态 | 已勾选           | [第 1 条](acceptance.md#1-将持久分身映射到-pi-session记录每轮配置快照和-run-状态--成立)，live 同一 session 文件续史，直接 SQL 拒绝非法终态                                              |
| 2，宿主工具、配置与认证、Sprout extension    | 未勾选，部分交付 | [第 2 条](acceptance.md#2-保留宿主-pi-工具配置与认证加载-sprout-extension--未完整交付部分交付)，四个工具与 Sprout extension 在，codemode、tool_search、MCP 与用户 skills 不在分身工具面 |
| 3，串行、当前轮投递、停止与错误              | 已勾选           | [第 3 条](acceptance.md#3-实现同分身串行新消息进入当前轮停止及明确的错误结果--成立)，并发 SQL 反证与真实 steer、aborted、错误不成功                                                     |
| 4，复用已有副本与按需获取仓库                | 已勾选           | [第 4 条](acceptance.md#4-实现宿主仓库入口支持复用已有副本与按需获取数据不仅支持手动绑定目录--成立)，绑定副本与托管克隆均验证，旧副本 fresh=false                                       |
| 5，来源、commit/ref、时点、并发、认证与磁盘  | 已勾选           | [第 5 条](acceptance.md#5-记录分析依据的来源commit-或-ref-与获取时点处理并发更新git-认证失败和磁盘占用策略--成立)，provenance 真实 commit、进程内串行、认证与磁盘拒绝                   |
| 6，Info Hub status、runs、错误与轮初上下文   | 已勾选           | [第 6 条](acceptance.md#6-将-agent-status活动-runs-和错误接入-info-hub提供轮初必要上下文--成立)，两视角真实数据，轮初上下文只供 Human 与后续 P6，`injectedIntoPrompt=false`             |
| 7，profile 下一轮与宿主恢复不虚构成功        | 已勾选           | [第 7 条](acceptance.md#7-验证-profile-更新仅影响下一轮宿主重启后不虚构旧-run-已成功完成--成立)，真实模型 PROFILE_V2 与 interrupted 恢复直接实验                                        |

## 第 2 条部分交付的理由与决定

宿主配置与认证保留，Sprout extension 已加载。coordinator 从 live 库 `agent_run.config_snapshot` 独立复验六行，`tools=["bash","edit","read","write"]`、`extensions=["sprout-extension"]`，model 与 transcript 一致。codemode、tool_search、MCP 内置 extension、用户 extension 与 skills 均未进入分身工具面。作者在 [Pi 资源加载记录](pi-session.md#pi-sdk-与资源加载) 已披露这项边界。第 2 条未完整交付，不能因出口条件通过而勾选。

F1 已路由给 P4 的远端工具面或 P6。决定是在出现第一个确实需要这些宿主工具的分身任务时，再评估加载方式，先测加载后一轮的延迟与失败率。本次编排已出现 context7 与 UnityMCP 超时，把这些 MCP 加进每轮可能使分身承担额外失败和等待。收尾不以开启资源开关来改变既定验收判定。

## 验收家族与方法

验收者为 `magpie/group/auto-glm-5-3-flash`，glm 家族在承担本次验收前没有 P3 代码、文档或验收产出。相对 a/f 的 `magpie/codex/gpt-6.1-sol` 和 b/c/d 的 `magpie/group/auto-mimo-v2-6-flash` 均独立。这一声明不扩展到 coordinator 对各 PR 的复跑。

验收先从 plan 的七条和出口条件推导命题，再核对代码、SQLite 实值、真实模型运行与直接 SQL 反证。作者文档只作待核对声明。验收报告记录的 RPC 清单与实际入口比对无差异，作者文档的 17 条抽样无不一致。收尾复核另发现 d 的 `pendingInputs=2` 前置条件措辞错误，已按 coordinator 授权最小更正并在 [验收抽样节](acceptance.md#文档与代码一致性抽样每份-5-条) 补记。收尾保留其余正文，只加指定作者说明、更正 F2、补记这处发现，并按授权做空白与表格对齐。验收日志与临时实验在本机，仓库保留验收结果及可复跑入口，不依赖被忽略的编排目录才能阅读结论。

## 未验证项汇总

- F1 的完整宿主工具面仍未交付。magpie native provider 的真实推理与缺省模型回退未由 live 证明，现有 live 使用显式 deepseek。模型遵循口令与 steer 时机可能波动，失败需要检查 transcript 与 run 实值。
- 多分身并发真实模型 run、stdout 背压、超大工具输出、强杀后全部后代进程清理、Windows 与 dev worker 信号转发未验证。多进程宿主同时扫描同一数据库不在 P3 保证内。
- F3 的 run 归属一致性仍没有复合外键。直接 SQL 可写不一致行，领域读取、投递与完成拒绝消费；P4 增加跨实体引用时复核约束方案。
- F4 的终态 run 遗留 pending 输入如实显示未投递，没有重投、作废或清理入口，下一轮不继承。处置语义归 P6；同 run 的 follow_up 也未接入。
- 公网 GitHub https/ssh 的真实认证与代理未验证；本地 401 和 `file://` 的成功不能代替公网行为。大仓库的克隆与磁盘统计耗时、增量 fetch 超限、仓库子目录、detached HEAD、稀疏检出等边界未完整实测。托管副本的 `.sprout-pi` 未跟踪目录无专门断言，淘汰与配额回收未实现。
- d 的查询存在按 chat 和 run 逐项读取的 N+1，无分页、无缓存、无规模测试。Project 多 DM 同时活动的 UI 未实测。Info Hub 面板不轮询，下次导航或刷新才更新；b 的 run 状态面板轮询不覆盖它。归 P5 多成员前置评估或 P6。
- 轮初上下文不注入模型 prompt，类型固定 `injectedIntoPrompt=false`。Agent 主动查询与运行期变更提示归 P6，不能声称模型已看到上下文。
- 单独运行固定路径的验证脚本仍可能复用旧迁移账本；`verify.sh` 会清理自己的 `verification.sqlite`，脚本各自重置库的进一步改造归 P4 或触发问题时处理。
- e 最可能漏掉的面是规模、长运行与外部环境交互，包括多分身并发、背压、进程树、公网认证代理、大仓库、magpie 推理与缺省回退。完整边界见 [验收未覆盖面](acceptance.md#本验收没有覆盖的面)。
- F5 为既有事项复核。coordinator 的路由还保留 P2 的 CSRF 中间件、索引缺口与 `getInstance` 死代码。与 e 的 F5 原文所列验证库、Info Hub 性能及 P2 过期文案分别记录，不能把两份枚举当成同一组新发现。P2 文案由本收尾更正，其余不在本 unit 范围。
- Machine、租约、真实 macOS Worker 与远端执行仍属 P4。Task、Group、Public Channel 属 P5；自动接续与完整 Info Hub 属 P6；手机、PWA 与一期整体验收属 P7。P0 的跨机与网络故障未验证项没有因本阶段通过而关闭。

## 收尾验证

文档门禁为 `bash scripts/verify/l-docs.sh`。它保留 P2 的六项证据、三个出口条件与 PR #10 至 #14 的核对，增加 P3 六勾一未勾、部分交付说明、summary 与验收文件、PR #19 至 #22 的 Git 身份、阶段状态、下一任务与 P2/P3 最终提交范围。P4 以后的复选框继续保持未勾。

完整门禁顺序为 `pnpm test`、`pnpm check`、`bash scripts/verify.sh`，一次只跑一个入口。`verify.sh` 按 `scripts/verify/*.sh` 收集脚本，脚本数量由文件列表推导。本收尾在实现基线 `55da85f` 上实跑结果如下。

| 命令                                                    | 退出码 | 关键输出与本机日志                                                                                         |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                             | 0      | 17 个文件、124 个测试通过，`/tmp/p3-f-test.log`                                                            |
| `pnpm check`                                            | 0      | 152 文件格式通过，121 文件无 lint 或类型错误，`/tmp/p3-f-check-final.log`                                  |
| `bash scripts/verify.sh`                                | 0      | `Verification scripts=20 failed=0`，含仓库真实 Chromium 流程与真实 Pi 状态工具调用，`/tmp/p3-f-verify.log` |
| `bash scripts/verify/l-docs.sh`                         | 0      | P2 原核对与 P3 新状态、PR、基线全部通过，`/tmp/p3-f-l-docs.log`                                            |
| `python3 /tmp/p3-f-negative.py`                         | 0      | 七类临时破坏各使 l 退出 1，恢复后退出 0，`/tmp/p3-f-negative-final.log`                                    |
| `cmp /tmp/p3-f-proof/expected.md docs/p3/acceptance.md` | 0      | e 原文仅应用授权内容变更的预期副本与仓库文件，经相同 `vp fmt` 后字节相等，`/tmp/p3-f-format-proof.log`     |

七类反证覆盖取消第 1 条勾选、误勾第 2 条、删除部分交付正文、回退 P3 状态、回退下一任务、写错 P2 最终范围与写错 P3 PR。临时修改全部恢复。首轮 `pnpm check` 仅因 Markdown 格式退出 1；coordinator 授权验收正文只改空白与表格对齐后通过。收尾另发现 d 的 pending 前提措辞错误，按授权只更正该句并补入验收，七条判定不变。真实模型的阶段证据沿用 e 和 coordinator 已完成的 live 复跑，收尾没有新增模型能力声明。

本机缺少 cursor-team-kit 的 `/deslop` 与 `control-ui`，不声明执行。新增文档按本机 `unslop` 清理；提交前自行检查 diff。浏览器由仓库的 `scripts/browser/*.mjs` 随门禁执行。
