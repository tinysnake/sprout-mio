# P5b 章节结论：Task 总览与生命周期

P5b 交付 Project 所有、Chat 承接的 Task：四态分栏总览、详情、分配与可选立即开始、清单、施工记录、末条记录中的完成结果，以及 Human 纠正与重开。Task 状态、run 活动和 Machine 租约保持独立；本章没有自动接续或独立 Human inbox。

## 交付范围

- 契约与数据形状：`docs/p5b/contracts.md`、`src/contracts/task.ts`、`src/contracts/task-capabilities.ts`、`src/db/schema.ts`、`drizzle/0025_p5b_tasks.sql`。
- 领域：`src/domain/task.ts`（单一命令入口与读模型）、`src/domain/task-capabilities.ts`（能力与当前责任）、`src/domain/task-input.ts`（完整开始快照与发送尝试边界）、`src/domain/agent-run.ts`（输入、ACK 与 owner Agent 点名例外）。
- 入口：`src/server/functions/task.ts`、`src/server/remote-agent-gateway.ts`、`src/extension/task-tools.ts`；Agent 新增 11 项 Task/Chat 工具，仍以本 run grant 限定身份与范围。
- 页面：`src/components/tasks/**`、`src/routes/_authed/projects.$projectId.tasks.tsx`；Chat 与 Info Hub 同时展示 Task 关联，普通编辑、终态 Human 纠正与重开读同一能力事实。
- 设计依据：`orchestrate/sprout-mio-p5b/reports/design-selection.md`；阶段裁定与理由记录在同目录上级的 `decisions.tsv`，含 AFK 期间协调者代人类裁定。设计选择与技术页面自检不等于 Human 已确认真实应用体验。

## 数据形状

| 形状       | 建模                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| Task       | proposed、assigned、finished、canceled；Chat 可空，没有 running 或启动标志          |
| 清单       | 独立条目、递增 position、软删除，不复用历史位置                                     |
| 记录与结果 | Chat message 上九个可空 Task 列，按 Task 内 seq 排列；末条进度/纠正记录就是完成结果 |
| 事件       | 每次命令追加一条不可变审计事件，不存正文，不作为恢复队列                            |
| 责任与能力 | DM 唯一有效 Agent、Group 当前 owner、频道当前为创建者 Human；页面与写入口共用能力表 |
| 输入       | 完整 start 快照，投递前重验，admitted 与 delivered 分离，已尝试输入不盲重发         |
| Info Hub   | 四态计数、摘要、清单与记录引用、同 Chat 活动 run；`taskRunBinding:false`            |

## 1. 四态生命周期与 Human 修正

创建 proposed，分配进入 assigned；不勾立即开始只保存分配。完成要求末条进度或纠正记录，重开保留旧完成引用与历史；终态由 Human 专用入口纠正。Task/run/lease 不互相代替状态，也不绑定执行归属。

证据提交 `c0e9c74`：重跑 `bash scripts/verify/ba-task-domain.sh`、`bash scripts/verify/bd-task-migration.sh`、`bash scripts/verify/be-task-info.sh`，以及独立验收中的直接 SQL 反例、生产迁移升级库与六表回滚比较。

## 2. 真实开始投递与 owner 协作

DM 投给唯一分身，Agent owner Group 只投 owner；Human owner 的 Group/频道只留 Chat 叙述消息。已有活动 run 走 steer，无活动 run 走 prompt；发送前核对最新责任，owner Agent 显式 @ 成员可组织协作，普通成员回报不会继续级联。

证据提交 `c0e9c74`：重跑 `bash scripts/verify/bc-task-start.sh`、`bash scripts/verify/bb-task-live.sh`、`bash scripts/verify/bs-p5b-lifecycle.sh`；ACK 与撤回的先后以 admitted 同步发送尝试为界，不把 ACK 当作工作完成。

## 技术验收证据

证据根为 `/Users/snake/workspace/sprout-mio/orchestrate/sprout-mio-p5b/reports/`。第一轮 `p5b-acceptance.md` 给出两个 P1：真 Worker 门禁误入 Ubuntu CI、ACK 观察器越序/丢帧。修复后第二轮在受验 HEAD `c0e9c748ed4f5d3fe108f7c5b6abe8eaed72700d` 独立复验。

**结论：可以合入 main。两个上一轮 P1 均已关闭；本轮没有发现新的 P1 或其他技术合入阻塞。** 判定基于第二轮独立执行的八轮生命周期、九个旁路门禁、登记测试、typecheck、CI 单元全集，以及故障注入、AST 和 SQLite 复核；详见 `p5b-acceptance-round2.md`。这不是全新 Ubuntu 的八组 CI 已运行，也不是 Human 体验确认。

| 证据／复跑命令                                 | 已证明的范围与结果                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `bash scripts/verify/ba-task-domain.sh`        | 真实 SQLite 四态、能力、CAS、回滚、历史和租约独立性；第二轮通过                                      |
| `bash scripts/verify/bb-task-live.sh`          | 真实 HTTP/gateway/SDK/runner/Worker、首 prompt 与同 run steer；第二轮通过                            |
| `bash scripts/verify/bc-task-start.sh`         | 开始上下文重验、admission/ACK 分离、错误与远端权限；可控 transport，第二轮通过                       |
| `bash scripts/verify/bd-task-migration.sh`     | 生产 0024→0025 升级，含 assistant_message_id 外键种子与历史保全；第二轮通过                          |
| `bash scripts/verify/be-task-info.sh`          | 聚合、scope、正文裁剪、Task/run/lease 独立变化；第二轮通过                                           |
| `bash scripts/verify/bs-p5b-lifecycle.sh`      | 生产 HTTP 生命周期、撤回竞态、真实 Worker 租约、历史与跨域；第二轮串行八次全通过，故障注入能打红审计 |
| `bash scripts/verify/as-p5b-task-pages.sh`     | 真实 Chromium Human 页面、19 项断言及响应式截图；第二轮通过，边界见下节                              |
| `node --test scripts/verify/targets.test.mjs`  | 全量登记与矩阵检查 5/5；bb 与生命周期只在 LOCAL_GATES，49 个 CI 门禁分八组                           |
| `pnpm typecheck`、验收报告中的 CI 单元全集命令 | 第二轮通过，79 文件、631/631；不是执行全仓原生测试或完整 CI                                          |

第二轮旁路还通过 `i2-group-chat`、`i4-agent-fanout`、`i6-chat-info`、`i7-chat-scope` 和迁移重建回归。验证记录另点名 `tests/verify-preparation.test.ts`：第一轮在基线 `add6d6d` 独立执行为退出 1、12/13，日志 `baseline-preparation.log`；修复 fixture 后当前 13/13，不计入本阶段 Task 能力结论，环境原因见下一节。原始命令、退出码与实际 wall time 在第二轮证据目录的 `results.json`；runner 自报耗时单列，不用后台启动耗时替代执行耗时。此次 closeout 只执行文档验证，不重跑上述产品门禁。

## 证据与它的边界

- `bb-task-live` 默认 `mode=model-fixture`：Pi SDK、runner、SQLite、gateway、Worker 真实，但**没有真实模型调用**，`paid-model-calls=0`。生命周期门禁也用固定 loopback 模型工具脚本；不证明真实供应商推理、模型自主遵循指令或付费模式。
- `as-p5b-task-pages` 用 fixture config 让 queued run 进入活动态，浏览器认证只覆盖 Human。Agent 能力分支使用真实 scoped domain 结果生成 SSR 后检查，Agent 权限由真实 grant 的 HTTP 用例另证；不能据此宣称真实 runner 已启动或 Agent 浏览器鉴权通过。
- `tests/verify-preparation.test.ts` 的一条环境性用例在基线 `add6d6d` 就失败：临时树缺 `scripts/verify/lib/spend.mjs`，13 项中 12 通过、1 失败、退出 1。第一轮 `baseline-preparation.log` 留存反证；`7557b53` 修复 fixture 依赖复制后当前 13/13，通过不计作 Task 产品能力。递归导入仍是有限语法扫描，未来新增传递依赖须复核 fixture，第一轮 P2 维护提醒仍保留。
- 没在全新 Ubuntu 上跑完整八组 CI，也没有远端 GitHub CI 执行回执；平台前提来自入口追查、矩阵与登记检查。没有跑付费真实模型模式，也没有做 Human 体验评审。
- “不立即开始不通知”以零开始消息/run/input、资源通知零增量和同步路径审计取证，没有独立外网 egress 观测器；不等于未来 inbox/外部通知适配器已经验证。失去 DM 参与权的重开拒绝有领域证据，该分支未另做页面操作。

## 已知限制

| 限制                                           | 用户可见行为与替代操作                                                                                                                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公共频道 owner 保持 Human                      | `docs/tasks-decisions.md` 的“人类指定和变更公共频道 owner”本阶段未落地；当前固定 Project 创建者，尝试变更返回 `forbidden`，非法责任目标为 `task_assignment_invalid`。可由该 Human 在频道推进，或分配到 Agent owner 的普通 Group；不改写产品决定消除差距。 |
| proposed 无新记录入口                          | 追加施工记录或完成返回 `task_invalid_transition`，页面无追加入口；先分配到有效 Chat，再记进展或结果。                                                                                                                                                     |
| 归档或失去 DM 参与权的旧 Chat 须先恢复才能重开 | 重开保留原 Chat，返回 `task_assignment_invalid` 且仍维持终态；先恢复 Chat/原参与资格，再重开。不能在重开时偷偷换 Chat。归档拒绝有页面证据，失去 DM 参与权分支有领域证据。                                                                                 |
| 立即开始快照超过 8000 字明确失败               | 页面显示 `validation_failed` 并提示缩短目标、要求或清单；完整事务回滚、不截断。缩短后再请求，或先不勾立即开始只保存分配，再整理上下文。                                                                                                                   |

## 功能与 UI 交付证据

功能线与 UI 线已在 `integration/p5b` 接入，契约与数据形状见本章及 `docs/p5b/contracts.md`。证据提交 `c0e9c74`：重跑 `bash scripts/verify/as-p5b-task-pages.sh`、`bash scripts/verify/be-task-info.sh`、`bash scripts/verify/i6-chat-info.sh`。技术浏览器检查覆盖总览到详情、分配、记录、完成、Human 纠正与重开，Chat/inspector 同时表达 Task 与 run，租约事实独立。设计依据与 AFK 裁定见交付范围，技术证据见上述七门禁；功能计划 P5b 五项与 UI-P5b 四项按交付勾选。

## P6 前置条件

P6 尚未开工。接入前沿用本章四态、同 Chat 关联与 admitted 的“已尝试，禁止盲重发”边界；当前 start 仅 Human 可用，事件与 message 也没有 system 主体，调度器身份必须先定契约，不能伪造 Human。周期检查的间隔、上下文、去重合并、退避、暂停/停止后的恢复仍待设计；只有 assigned 进入检查，不增加运行中 Task 状态。

Human owner 的提醒目前只在承接 Chat；若做独立 inbox，须明确与本章不新增 inbox 的边界。自动恢复要处理 8000 字完整快照约束与已尝试未 ACK 输入；委派关联可另行设计，不能把独立委派单当作一期已交付。Info Hub 全部视角、自动刷新、成员正常移除与恢复按 P6 计划推进，公共频道 owner 的产品实现差距仍需后续安排。

## human-体验确认

- 确认记录：尚无人类对本章真实应用的明确体验通过确认；没有确认版本。
- 确认范围：待 Human 亲自体验 Task 总览、DM/Group/频道分配与开始、记录与完成、纠正与重开、Chat/Info Hub 关联及限制提示。
- 待办事项：由编排者启动真实页面评审，收取明确确认并记录版本；I-P5b 前三条技术项已完成，第四条保持未勾选，P6 未开工。
