# P2 结论一览

P2 已建立 Project 配置、Agent profile、成员、DM 与持久分身。Human 可以从稳定 URL 打开同一对话，发送消息，修改配置与人设，并在生产进程重启后保留身份和历史。六项清单的证据与 [开发计划](../development-plan.md#p2-建立身份成员与持久对话) 对齐。

实现基线为 `28d4fb2`，a～e 的实现与合入范围为 `28d4fb2..d8f4e2b`，包含 PR #10 至 #14。`git log --oneline 6836b06^..d8f4e2b` 可重建该区间。下表列出经 `git log --oneline` 与 `git show --stat` 核对的 head 和 merge。本收尾只补充文档与只读验收，不增加应用能力。验收环境为 macOS arm64、Node v26.11.1、pnpm 10.33.0，CI 为 ubuntu x64。

## 各 unit 结论与复跑入口

| unit                                                       | 结论                                                                                                                                                                                                                         | 证据位置                                                                                                                                                                         | 复跑命令                                                                                  | 未验证项                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| a，数据与授权，PR #10，head `cfa5d4d`，merge `6836b06`     | 7 张新增表、持久身份、创建者授权、消息排序与业务诊断事务成立                                                                                                                                                                 | [表与约束](identity-data.md#表列与约束)、[服务入口](identity-data.md#服务入口)、[验证记录](identity-data.md#验证记录)                                                            | `bash scripts/verify/g-identity-data.sh`                                                  | 多进程 SQLite 竞争未验证，工作目录只保存配置，不访问宿主文件系统   |
| b，配置与成员页面，PR #11，head `fdad1ca`，merge `53c9cb7` | Project 配置、profile 创建编辑与成员增删可由真实页面完成，刷新保留值                                                                                                                                                         | [页面行为](project-agents.md#页面行为)、[验证记录](project-agents.md#验证记录)、[截图](project-agents.md#截图)                                                                   | `bash scripts/verify/h-project-agents.sh`                                                 | 并发编辑与大量成员的界面表现未验证，尚无运行时配置消费方           |
| c，DM，PR #12，head `bf7ffa4`，merge `2b814eb`             | 重复发起复用同一 DM 与分身，人设编辑保留身份和消息，真实重启后持久                                                                                                                                                           | [唯一性](conversation-dm.md#分身身份与唯一性的实现位置)、[验证记录](conversation-dm.md#验证记录)、[重启验收](conversation-dm.md#重启持久性验收)                                  | `bash scripts/verify/i-conversation.sh`                                                   | 真实 Pi、自动回复、run、消息分页与归档入口未实现                   |
| d，Info Hub，PR #13，head `dc11b8a`，merge `da4aebb`       | 查询模块提供 Project 与 Conversation 两视角，run 与 Machine 显式标注未实现                                                                                                                                                   | [模块入口](info-hub.md#模块入口与边界)、[不可用标记](info-hub.md#显式不可用标记的设计理由)、[验证记录](info-hub.md#验证记录)                                                     | `bash scripts/verify/j-info-hub.sh`                                                       | Agent status、活动 run、Machine 与租约未实现，聚合性能与分页未验证 |
| e，独立验收，PR #14，head `872e62d`，merge `d8f4e2b`       | 真实 Chromium 验证两用户隔离、七个 URL 导航、生产重启字面量一致与 SQLite 唯一约束；验收独立于 b/c/d 页面实现者，但与授权实现者 p2-a 同家族，授权边界的跨家族复核由 [跨家族补充复核 k2](acceptance.md#跨家族补充复核-k2) 补充 | [命令记录](acceptance.md#真实命令记录)、[隔离反证](acceptance.md#隔离反证与正常对照)、[导航矩阵](acceptance.md#七个页面的导航矩阵)、[重启字面量](acceptance.md#出口条件与字面量) | `bash scripts/verify/k-acceptance.sh`，`bash scripts/verify/k2-cross-family-isolation.sh` | 运行时快照、并发、性能、会话过期与备份恢复未验证                   |
| f，文档收尾                                                | 六项证据、三个出口条件、完成记录与架构事实可定位，由只读脚本核对                                                                                                                                                             | [清单对照](#p2-清单证据对照)、[收尾验证](#收尾验证与证据约定)                                                                                                                    | `bash scripts/verify/l-docs.sh`，`pnpm check`                                             | 文档检查不替代 g～k 的真实运行验收                                 |

各 unit 文档中的测试数量、输出和对象 ID 是它们当时的观测，不是最新 HEAD 的全套结果。最新集成行为以 k-acceptance 与各 unit 自己脚本的当前输出为准。a 文档记录的 P1 schema 精确断言失败是历史状态，PR #10 的 `cfa5d4d` 已把 [c-data-auth.sh](../../scripts/verify/c-data-auth.sh) 改为 P1 表与索引的包含检查，迁移数由实际 SQL 文件推导。完整复跑结论见 [收尾验证](#收尾验证与证据约定)。

## P2 清单证据对照

| 项                                    | 状态   | 证据与具体命令或章节                                                                                                                                                                              | 判定范围                                                                                                  |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1，Project 配置、Agent profile 与成员 | 已勾选 | [配置与成员验证](project-agents.md#验证记录)，`bash scripts/verify/h-project-agents.sh`                                                                                                           | 页面保存、刷新、人设编辑、成员添加与移除，当前用户仅管理自己的 profile                                    |
| 2，Conversation 与持久分身唯一        | 已勾选 | [分身唯一性](conversation-dm.md#分身身份与唯一性的实现位置)、[SQLite 唯一约束反证](acceptance.md#p2-六项对应关系)，`bash scripts/verify/i-conversation.sh`，`bash scripts/verify/k-acceptance.sh` | profile × Conversation 唯一索引拒绝重复行，重复发起与重启保留同一分身                                     |
| 3，DM、持久消息与配置编辑保留历史     | 已勾选 | [重启持久性](conversation-dm.md#重启持久性验收)、[出口字面量](acceptance.md#出口条件与字面量)，`bash scripts/verify/i-conversation.sh`，`bash scripts/verify/k-acceptance.sh`                     | conversation、instance、两条有序消息、三项配置与人设逐字比较，不代表真实 Pi 回复                          |
| 4，稳定 URL 与 Project 上下文         | 已勾选 | [七个页面的导航矩阵](acceptance.md#七个页面的导航矩阵)，`bash scripts/verify/k-acceptance.sh`                                                                                                     | 七个目标分别直接进入、刷新、后退、前进，并比较 URL 与对象值                                               |
| 5，Project 授权与查询错误隔离         | 已勾选 | [授权入口](identity-data.md#project-授权与配置)、[隔离反证与正常对照](acceptance.md#隔离反证与正常对照)，`bash scripts/verify/g-identity-data.sh`，`bash scripts/verify/k-acceptance.sh`          | B 对 A 六个页面与 17 个 RPC 均 not_found 且零泄漏，B 自己的 Project 可用。P2 无运行时快照，未验收快照隔离 |
| 6，已有对象的 Info Hub 查询与呈现     | 已勾选 | [Info Hub 验证](info-hub.md#验证记录)、[未实现状态与限制](acceptance.md#未实现状态截图与限制)，`bash scripts/verify/j-info-hub.sh`，`bash scripts/verify/k-acceptance.sh`                         | Project 成员与 DM 链接、Conversation 成员与消息统计可见，run 和 Machine 只有显式不可用状态                |

P2 六项均有证据。P3 至 P8 与 R1 的复选框保持未勾，未实现对象不因 P2 完成而升级为支持。

## P2 出口条件对照

| 出口条件                              | 已验证证据                                                                                                                                                                                                                                                                                                                                                                                    | 未覆盖面                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 重启后同一对话仍对应同一分身          | [重启验收](conversation-dm.md#重启持久性验收)、[出口字面量](acceptance.md#出口条件与字面量)，`bash scripts/verify/i-conversation.sh`，`bash scripts/verify/k-acceptance.sh`。两次生产进程 bootId 不同，conversation ID、instance ID 与单元素对话列表相等                                                                                                                                      | Pi session 映射、run 恢复、异常断电和多宿主恢复未验证                           |
| 消息与配置保留                        | [出口字面量](acceptance.md#出口条件与字面量)，`bash scripts/verify/k-acceptance.sh`。两条消息正文与顺序、Git remote、默认分支、工作目录、人设、profile ID 均从页面重新读取并比较                                                                                                                                                                                                              | 备份恢复、并发编辑、大量消息分页与每轮配置快照未验证                            |
| 两个 Project 的上下文与查询边界可验证 | [隔离反证](acceptance.md#隔离反证与正常对照)、[导航矩阵](acceptance.md#七个页面的导航矩阵)，`bash scripts/verify/k-acceptance.sh`。独立 Chromium context、六页与 17 RPC 的 not_found 和 leaked 空数组、B 正常对照及七个 URL 的上下文比较通过；[跨家族补充复核 k2](acceptance.md#跨家族补充复核-k2)，`bash scripts/verify/k2-cross-family-isolation.sh` 由另一模型家族独立编写断言复核同一边界 | 授权是创建者模型，未验收多 Human 共享 Project 或 Agent 真实运行时主动查询与快照 |

main `d8f4e2b` 的 [CI run 39062616946](https://github.com/tinysnake/sprout-mio/actions/runs/39062616946) 为 completed、success。核对命令为 `gh run list --branch main --limit 3 --json databaseId,headSha,status,conclusion,url`。CI 覆盖检查、测试、构建、迁移与生产 smoke，不包含真实 Chromium 或真实 Pi，边界沿用 [CI 工作流](../p1/tooling.md#ci-工作流)。

## 已落实的架构说明更新

[architecture-direction.md](../architecture-direction.md#分开记录身份和生命周期) 同步以下已有实现与验收。

- [access.ts](../../src/domain/access.ts) 的 `assertProjectAccess` 仅允许 Project 创建者，不存在与越权统一返回 `not_found`。全局 profile 按创建者授权，Project 内查询关联已授权的 projectId。
- [conversation.ts](../../src/domain/conversation.ts) 在 IMMEDIATE 事务中复用既有 DM，数据库 `agent_instance_profile_conversation_unique` 强制 profile × Conversation 唯一。kind 目前仅为 `dm`，人设编辑不重建分身或历史。
- [info-hub.ts](../../src/domain/info-hub.ts) 是只读查询模块，由 Project hub 与对话页消费。run、Machine 与租约视角以 `available: false` 和非空原因表达，不返回成功空值。
- [身份写事务](identity-data.md#诊断与事务) 已把业务与诊断一同写入。真实 conversation、instance 关联已存在，runId 与 executionId 仍为空。人设与消息正文不写入诊断。
- 五个边界共用 [domain-errors.ts](../../src/server/functions/domain-errors.ts) 的一张领域错误映射表，`internal` 只留给真正的未知错误。该缺陷类唯一真实实例是 p2-h 修的 `createDirectConversationFn` 漏映射 `AgentError`；p2-i 的调用图清扫确认五边界的映射集合等于各自可达集合、差异表为空，并把可达集合表与不存在 id 的负路径锁进 `tests/error-mapping.test.ts` 与 `scripts/verify/m-error-mapping.sh`。

## 未验证项汇总

- P3 的真实 Pi 会话、Agent 自动回复、run、同分身串行、运行中投递和停止、每轮配置快照、Agent 主动查询与宿主仓库入口未实现。P2 保存配置，不证明下一轮已消费配置。
- P4 的 Machine、租约、真实 macOS Worker、远端执行与跨机恢复未实现。P0 原型不等于产品支持。
- P5 的 Task、Group 与 Public Channel 未实现。Conversation kind 只有 `dm`，归档入口未实现。
- P6 的自动接续、完整 Info Hub 视角、快照与运行期变更提示、成员治理未实现。
- P7 的手机响应式验收、在线 PWA 与完整一期端到端验收未完成。Windows Worker 与 MCP 接入没有新增产品验收证据。
- 多进程 SQLite 并发、写锁竞争、并发编辑、并发消息发送、异常断电、备份恢复与高负载未验证。IMMEDIATE 事务与唯一索引不等于已证明这些能力。
- 消息、成员与 Info Hub 无分页，聚合性能与大数据界面表现未验证。
- 冷 pnpm store、Actions 缓存失效、平台差异、runner 升级、会话过期刷新、静态托管与 CDN rewrite 未系统验证。Chromium 为本机验收，CI 不运行浏览器流程。
- 跨家族独立性的残余限制：[跨家族补充复核 k2](acceptance.md#跨家族补充复核-k2) 跑在 `magpie/group/auto-mimo-v2-6-flash`，与授权实现者 p2-a（`magpie/codex/gpt-6.1-sol`）不同家族，但与 b/c/d 页面实现者同家族。k2 只覆盖 P2 授权边界的拒绝面、正对照、身份改写与诊断查询，不构成对 b/c/d 页面与功能实现的独立复核，也不覆盖 P3 及以后对象。k2 发现的 `createDirectConversationFn` 错误映射缺陷（引用他人或不存在的 profileId 被报成 `internal`）已由 p2-h 修复并改回严格 `not_found` 断言，见 [跨家族补充复核 k2](acceptance.md#跨家族补充复核-k2) 与 `tests/conversation.test.ts`。
- runtime 的 dev 信号优雅关闭、WebSocket 与多进程恢复仍未验证，生产 HTTP 排空边界沿用 [P1 补充验收](../p1/graceful-drain-report.md)。

## 收尾验证与证据约定

收尾命令为 `bash scripts/verify/l-docs.sh`、`bash scripts/verify.sh` 与 `pnpm check`。l 只读文档与仓库文件，核对六项已勾清单、六行 summary 映射、三个出口条件、P2 源码路径、docs 内部链接和锚点，以及完成记录中的 PR、head 与 merge。PR 号与 merge 提交标题匹配，head 与 merge 第二父提交匹配。P3 至 P8 与 R1 的每个复选框都必须未勾。外部 HTTP 链接只声明存在，不发网络请求。

本 worktree 在实现基线 `d8f4e2b` 上的真实收尾结果如下。可能超过 60 秒的命令在后台执行，日志和退出码分别写入 `/tmp/p2-f-*.log` 与 `/tmp/p2-f-*.exit`。构建和测试子命令上限为 300 秒，全套脚本总上限为 1800 秒。

| 命令                                   | 退出码 | 关键输出与证据                                                                                                                                                                                                        |
| -------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`       | 0      | 安装 562 个依赖，锁文件不变。`/tmp/p2-f-install.log`                                                                                                                                                                  |
| `bash scripts/verify/l-docs.sh`        | 0      | 六项已勾、六行映射、三个出口条件、五个 unit、PR #10 至 #14 与 Git 一致，62 个后续复选框未勾。全套日志 `/tmp/p2-f-verify-full.log`，独立复跑日志 `/tmp/p2-f-l-docs.log`                                                |
| `bash scripts/verify.sh`               | 0      | `Verification scripts=14 failed=0`。包含真实构建、生产启动、SQLite、Chromium、重启与真实 Pi 状态工具调用。`/tmp/p2-f-verify-full.log`                                                                                 |
| 全套中的 `pnpm test`                   | 0      | 12 个文件、65 个测试通过。`.verify/g-identity-data/test.log`                                                                                                                                                          |
| 全套中的 k 浏览器与生产进程            | 0      | 重启前 65/65、重启后 12/12、runner 8/8。两次 SIGTERM 均退出 0，bootId 改变，conversation、instance、消息与配置相等，隔离响应均零泄漏。`.verify/k-acceptance/evidence.json`、`browser-before.log`、`browser-after.log` |
| `pnpm check`                           | 0      | 120 文件格式通过，95 文件无 warning、lint error 或 type error。`/tmp/p2-f-check.log`                                                                                                                                  |
| `python3 /tmp/p2-f-negative-probes.py` | 0      | 临时仓库副本的 13 类故障均使 l 退出 1，原始与恢复副本均退出 0。`/tmp/p2-f-negative-final.log`                                                                                                                         |
| `bash -n scripts/verify/l-docs.sh`     | 0      | shell 语法通过                                                                                                                                                                                                        |

13 类反证覆盖缺失文档、章节、复跑脚本、P2 未勾、summary 状态不符、链接式与行内源码路径失效、错误 PR、错误已有 head、不存在 SHA、误勾 P3、缺失出口条件和未定义引用式链接。首次反证基准退出 1，原因是表格格式化补空格后，脚本按固定空格匹配出口条件。修正为读取单元格并 trim 后，全部反证与完整验收通过。首轮失败日志为 `/tmp/p2-f-negative-probes.log`。本机没有找到 cursor-team-kit 的 deslop 插件，未将本次检查称为插件审查。

文档证据使用 Markdown 链接，章节使用标题锚点，复跑命令使用行内代码。l 复用 [P1 文档脚本](../../scripts/verify/f-docs.sh) 的全 docs 链接扫描，再核对 P2 路径与映射。`.verify/`、`.output/` 等为可重建的本机产物，认证 cookie 和 secret 不提交。重跑截图可能改写 `docs/p1/evidence/`，本收尾只提交四个 SCOPE 文件。

收尾不修改开发计划 P2 一节和完成记录表以外的文字。因此计划开头、阶段状态表与末尾下一任务仍保留原有 P2 待开始文字；P2 的完成判定以六项证据与完成记录为准。
