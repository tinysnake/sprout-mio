# P1 结论一览

P1 已建立可运行的应用骨架与 Project 标准功能样例。Human 可以注册、登录、创建 Project 并通过稳定 URL 重新打开它。后续实现者可以沿用页面、server function、业务服务和事务的路径，复跑同一套验收。七项清单的证据均成立，状态与 [开发计划](../development-plan.md#p1-建立可重复的工程骨架) 对齐。

实现基线为 `7e4f039`，a～e 的实现与合入范围为 `7e4f039..c3af8ad`，包含 PR #1 至 #5。本收尾提交补充文档验收，不增加应用能力。`git log --oneline 7e4f039..c3af8ad` 可重建范围。验收环境为 macOS arm64、Node v26.11.1、pnpm 10.33.0；CI 为 ubuntu x64。

## 各 unit 结论与复跑入口

| unit                            | 结论                                                                          | 证据位置                                                                                                                             | 复跑命令                                      | 未验证项                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------- |
| a，骨架，`e7edfe4`，PR #1       | Start、Worker 与 extension 三入口成立，共享契约可用，真实 Pi 调用状态工具成功 | [骨架验证](skeleton.md#验证命令与证据)                                                                                               | `bash scripts/verify/a-base.sh`               | Worker 连接未实现，Pi 会话业务未接入。工具的 unimplemented 是边界结果       |
| b，工具链，`ab06235`，PR #2     | 检查、测试、构建与 CI 成立，干净工作目录可安装、构建、生产启动并关闭          | [干净安装](tooling.md#干净安装与生产启动)、[CI 工作流](tooling.md#ci-工作流)、[vp test](tooling.md#vp-test-结论)                     | `bash scripts/verify/b-tooling.sh`            | 冷 store、缓存失效、平台差异与 runner 升级未系统验证                        |
| c，数据与登录，`935bf54`，PR #3 | 七张应用表与迁移账本、重复迁移、真实 HTTP session 与 Chromium 登录成立        | [数据与认证验证](data-auth.md#验证证据)、[干净目录验证](data-auth.md#干净目录验证)                                                   | `bash scripts/verify/c-data-auth.sh`          | session 过期与刷新、多进程 SQLite、WAL 行为未验证。历史启动 GAP 已由 d 关闭 |
| d，runtime，`5916067`，PR #4    | 监听前配置校验、迁移、boot 恢复、ready、生产 SIGTERM 与请求诊断成立           | [runtime 验证](runtime.md#验证命令与证据)、[阶段保证](runtime.md#阶段与保证)                                                         | `bash scripts/verify/d-runtime.sh`            | dev 信号优雅关闭、WebSocket、多进程和恢复中途崩溃未验证                     |
| e，Project，`9631ad2`，PR #5    | 创建、列表、详情、重新打开、字段错误、事务回滚与三处 requestId 一致成立       | [真实操作](feature-sample.md#真实命令与输出摘要)、[事务与错误](feature-sample.md#事务与错误路径证据)、[截图](feature-sample.md#截图) | `bash scripts/verify/e-project.sh`            | 多用户端到端隔离、并发创建与高负载未验证。增量构建有已知旧 shell 问题       |
| f，文档收尾                     | 证据映射、复选框、完成记录与架构说明对齐，secret 约束漂移已修正               | [清单对照](#p1-清单证据对照)、[收尾验证](#收尾验证与证据约定)                                                                        | `bash scripts/verify/f-docs.sh`，`pnpm check` | 文档验收不替代 a～e 的运行验收，独立多模型审查未执行                        |

各文档中的测试数量和旧探针值是对应 unit 当时的观测，不是最新 HEAD 的全套结果。最新集成行为以 d、e 的证据与复跑脚本为准。b 的「尚无 drizzle」与 c 的「启动 GAP」是历史状态，不能当作当前结论。

## P1 清单证据对照

| 项                                        | 状态   | 证据与具体命令或章节                                                                                                                                                                            | 判定范围                                                                                   |
| ----------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1，Start、Worker、Pi extension 与共享契约 | 已勾选 | [骨架的验证命令与证据](skeleton.md#验证命令与证据)，`bash scripts/verify/a-base.sh`                                                                                                             | 真实构建三个入口并在真实 Pi 调用编译后的 sprout_status。未将 Worker 或 Pi 会话标为支持     |
| 2，工具链、CI 与干净安装启动              | 已勾选 | [干净安装与生产启动](tooling.md#干净安装与生产启动)，`bash scripts/verify/b-tooling.sh`；[CI 工作流](tooling.md#ci-工作流)                                                                      | 检查、测试、构建和生产 smoke 均真实执行。工作目录干净，pnpm store 可为热缓存               |
| 3，迁移、配置、Human 登录与初始化         | 已勾选 | [数据与认证验证证据](data-auth.md#验证证据)，`bash scripts/verify/c-data-auth.sh`                                                                                                               | 从零迁移、重复迁移、真实 cookie session 与浏览器注册登录。注册不造 Project                 |
| 4，runtime 启动、恢复、ready 与关闭       | 已勾选 | [runtime 验证命令与证据](runtime.md#验证命令与证据)，`bash scripts/verify/d-runtime.sh`                                                                                                         | 单进程 boot 恢复、启动前失败与生产关闭。不含业务作业恢复或 dev 信号优雅关闭                |
| 5，Project 全层样例                       | 已勾选 | [真实命令与输出摘要](feature-sample.md#真实命令与输出摘要)、[事务与错误路径证据](feature-sample.md#事务与错误路径证据)，`bash scripts/verify/e-project.sh`                                      | 页面、server function、业务服务、真实 SQLite 事务与安全错误呈现                            |
| 6，可运行模板与约定                       | 已勾选 | [新增功能的步骤](conventions.md#新增功能的步骤)，`bash scripts/verify.sh`；[Project 真实操作](feature-sample.md#真实命令与输出摘要)                                                             | 以已运行样例固定目录、命名、校验、错误与验收步骤                                           |
| 7，基础诊断与实际 ID 关联                 | 已勾选 | [runtime 验证命令与证据](runtime.md#验证命令与证据)、[Project 事务与错误路径证据](feature-sample.md#事务与错误路径证据)，`bash scripts/verify/d-runtime.sh`，`bash scripts/verify/e-project.sh` | requestId 与 projectId 有真实关联。尚无分身、run、execution，不填假 ID，不声称其关联已验证 |

P1 七项均有证据，没有保持未勾的 P1 条目。P2 至 P8 与 R1 的复选框保持未勾，因为本次没有这些阶段的实现验收证据。下述未验证能力不因 P1 完成而升级为支持。

## P1 出口条件对照

| 出口条件               | 已验证证据                                                                                                                                                                                      | 未覆盖面                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 用户可以登录           | [认证验证](data-auth.md#验证证据) 的 Chromium register、logout、password login；[Project 浏览器输出](feature-sample.md#真实命令与输出摘要) 的 register_sets_session、login_opens_protected_area | session 到期、刷新与密码恢复未验证                            |
| 创建并重新打开 Project | [Project 浏览器输出](feature-sample.md#真实命令与输出摘要) 的 create_project_appears_in_list、reload_keeps_same_project、history_back_and_forward_keep_target                                   | 多用户隔离、成员授权与并发创建未验收                          |
| 干净环境检查与构建     | [工具链验收](tooling.md#干净安装与生产启动) 的 frozen install、check、test、build、production start 与 SIGTERM；[干净目录迁移](data-auth.md#干净目录验证)                                       | 冷 store 与全新 OS 未验证。构建前需删除旧输出                 |
| 最小真实操作           | [Project HTTP 与 Chromium 流程](feature-sample.md#真实命令与输出摘要)、[真实 Pi 状态工具](skeleton.md#验证命令与证据)、[真实 SQLite 事务](feature-sample.md#事务与错误路径证据)                 | Pi 会话业务属于 P3。真实跨机、真实 macOS Worker 端到端仍属 P4 |

本次通过 `gh run list --branch main --limit 2 --json databaseId,headSha,status,conclusion,url` 核对 main `c3af8ad` 的 [CI run 39023423314](https://github.com/tinysnake/sprout-mio/actions/runs/39023423314)，状态 completed，结论 success。它覆盖检查、测试、构建、迁移、生产 smoke、Worker 与 extension 打包，不含真实 Chromium 或真实 Pi。b 的历史 run URL 保留在 [CI 工作流](tooling.md#ci-工作流)。

## 已落实的架构说明更新

以下更新仅反映现有实现与验收，落点为 [architecture-direction.md](../architecture-direction.md)。

1. Vite+ 的 `vp test` 与格式门禁改为已验证。写入命令为 `pnpm fmt`，CI check 不带 `--fix`。注明根决策文档、P0 和生成物的排除范围，以及配置层 ignore 的限制。
2. 保留 SPA 的两项设置，补充 `pnpm start` 显式加载 env file、监听前验证 secret、构建 prerender 跳过 runtime。未知页面 shell 转为 200，API 与 server function 不做该转换，静态托管仍未验证。
3. 生命周期入口落实到 `src/server/server-entry.ts` 的 Nitro plugin 与顶层 await。globalThis 单例、boot 中断恢复、ready 后监听和生产主线程信号关闭有证据。调度器、Pi 会话管理与 Worker 连接仍未实现。
4. 基础诊断落实到 Nitro 请求与响应 hooks、`src/server/request-context.ts`、`src/server/diagnostics.ts` 和 Project 事务。requestId 覆盖客户端值，Project 创建关联 requestId 与 projectId，其他尚不存在的关联为空。c 的 session server functions 仍自行生成 ID，不能宣称全部载荷都已统一。
5. Project 业务与诊断在同一事务中写入，错误按 AppResult 判别。补充先清理输出再构建的已知限制，避免将干净构建证据推广为增量构建可靠。

同时修正 [skeleton.md 的运行入口](skeleton.md#运行入口) 与 [conventions.md 的环境与诊断](conventions.md#环境与诊断)。共享 config 允许缺省 secret 的解析契约没有改变，但自认证与 runtime 入口接入后，生产启动不再允许缺省。明确生效阶段，避免把骨架建立时的条件复制到新功能中。

另一个文档事实需要区分。feature-sample.md 把 recordDiagnostic 描述为「另开连接」，实际 [诊断实现](../../src/server/diagnostics.ts) 导入共享 db，没有逐次开连接。它会捕获失败并返回 false，Project 需要在事务中直接写诊断以传播写入失败。已修正 conventions.md 对该调用的描述。feature-sample.md 不在本次可写范围，历史措辞保留，当前连接事实以源码为准。

## 未验证项汇总

- 真实跨机、网络分区、真实 macOS Worker 安装认证重连与端到端执行仍属 P4。Worker 入口只公开未实现边界，P0 协议原型不等于产品支持。Windows 与其他平台验收没有新增证据。
- Pi 状态工具在真实 Pi 中已调用，持久会话业务与宿主仓库分析未接入，属于 P3。SDK 内置扩展加载与多分身资源占用未验证。
- 冷 pnpm store、Actions 缓存失效、macOS 与 ubuntu 系统差异、runner 升级未系统验证。action Node 20 弃用提示仍保留。
- 多进程 SQLite、WAL checkpoint、写饥饿、备份恢复、session 过期刷新与额外密码策略未验证。邮件验证、密码重置等能力未实现。数据库 HMR 连接数量未独立观测，不能把 runtime 单例实验推广到所有连接。
- dev 信号优雅关闭、WebSocket、完整 worker 重启、多进程 runtime 和恢复事务中途崩溃未验证。生产进程 ready 后监听，没有观测到监听期间的 503 到 200 窗口；不可用与就绪状态来自行为测试。
- Project 的第二用户端到端隔离、并发创建与高负载诊断未验证。createdBy 过滤是现有实现，不是后续授权模型。时间戳精确到秒。分身、run、execution 的真实诊断关联未验证。
- 残留 .output 下增量构建会留下旧 shell 资源引用。现有 e 验收清理输出后构建，该缺陷未修复。静态托管与 CDN rewrite 未验证。
- Chromium 在本机验收，CI 没有浏览器流程。curl 的 server function ID 提取与 Seroval CrossJSON 编码依赖当前 Start 产物结构，升级后需要重新核对。
- 本次没有独立多模型审查，也未找到 cursor-team-kit 的 deslop 插件。文档证据检查、范围核对与 pnpm check 不等于这些审查。

## 收尾验证与证据约定

收尾命令为 `bash scripts/verify/f-docs.sh` 与 `pnpm check`。前者核对七项清单中的 P1 文档章节与复跑命令、summary 的七行映射、P1 文档的具体仓库路径和 docs 下的内部链接。它只验证证据可定位，不执行 a～e，也不把未验证能力判为支持。`bash scripts/verify.sh` 会自动包含新增的 f 脚本。

本次收尾实测两条命令均退出 0。f-docs 的七项证据、内部链接、章节锚点、仓库路径与最终 secret 约束均 PASS；pnpm check 输出 66 个文件格式通过，49 个文件无 warning、lint error 或 type error。另在临时仓库副本分别注入缺失证据文件、缺失章节、缺失复跑命令、summary 状态不一致、缺失源码路径、未定义引用式链接与普通死链，七种故障均退出 1，恢复副本后退出 0。日志分别为 `.verify/f-docs/verify.log`、`.verify/f-docs/check.log` 与 `.verify/f-docs/negative-probes.log`，只保留本机，不提交。

仓库没有 docs/link 目录。这里按 docs 下的内部链接检查理解 brief 的「docs/link 无死链」。检查包含相对路径、章节锚点、引用式链接和本地文件的存在性；外部 HTTP 链接保留为来源，不在离线脚本里发网络请求。

引用仓库证据使用 Markdown 链接，章节用标题锚点，复跑命令使用行内代码。源码、脚本与已提交截图必须存在。带通配符的目录引用必须匹配实际文件。conventions.md 的 feature 和 unit 参数模板表示待创建的路径，不是已存在的证据。

历史文档中以 .verify、.output、dist、data、node_modules 开头的路径是忽略的本地产物，不要求 fresh checkout 已有这些文件。它们由对应 a～e 命令重建，认证 cookie 与 secret 不提交。tooling.md 明确记录未创建的 clean-install.sh 只是一项范围取舍，不作为成功证据。脚本会单独打印这些类别的数量，不能把跳过本地产物解读为已经核验其内容。

复跑 a～e 时使用可重建的验收 worktree。a、b 会删除 node_modules、dist、.output 和 data；e 会生成截图，d 会临时修改源码触发 HMR。这些是运行验收步骤，f 本身只读文档与仓库文件。本次收尾沿用已合入 unit 的真实运行记录与 coordinator 在 c3af8ad 上的五脚本全通过结果，不重复运行会写源码或截图的流程。
