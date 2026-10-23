# I-P3 UI 追赶记录

状态：内容已交付，技术验证通过，Human 体验确认已记录（`869bf22`，2026-10-23）。本记录替代原计划的独立整章交付材料，见下文「与计划的关系」。

## 范围与基线

- 功能契约沿用 [P3 结论](../p3/summary.md) 与 [P3 验收](../p3/acceptance.md)，包括其部分交付限制。
- UI 交付发生在 I-P1/P2 迁移期内：P3 页面在新组件上重建，而不是在旧页面上做视觉调整。迁移区间为 `edd198b..869bf22`。
- 不在本记录内的范围：P4a 及之后的 Machine、租约、长命令、交接、多人、Task、P6、P7 均未开工。

## 为什么没有独立里程碑

计划原来把 P3 作为单独一次整章集成。实际执行时，P3 的界面（Chat 运行状态、宿主仓库入口、Info Hub 运行事实）与新 Chat 工作区是同一批文件、同一批组件，拆成两次集成会要求先交付一套中间态布局。迁移选择一次做完，把 P3 回归放进同一轮验收。

代价是本记录不是独立验收轮次的产物。见「未验证与边界」。

## 交付内容对照

| UI-P3 计划条目                                                               | 交付物                                                                                                                                            | 验证                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Human 与 Agent 消息、运行状态、当前轮追加消息和停止                          | `components/chat/message-list.tsx`、`run-status.tsx`、`message-composer.tsx`，发送键为 Enter，Shift+Enter 换行                                    | `scripts/verify/o-turn-semantics.sh`        |
| 宿主未启用、未开始、排队、运行中、停止、失败与重启中断，错误详情与 requestId | `run-status.tsx` 的 `pi-host-status` 与失败块（`run-failure`、`run-failure-request`）、单行状态区（`pending-input-count`、`restore-undelivered`） | `o-turn-semantics.sh`、`q-info-hub-runs.sh` |
| profile 修改从下一轮生效的提示                                               | `agent-profile-editor.tsx` 保存提示、`chat-inspector.tsx` 的下一轮说明                                                                            | `h-project-agents.sh`、`i-chat.sh`          |
| 宿主仓库配置、复用副本、按需获取、获取中与失败，来源 ref 与 commit           | `components/project-config/project-repo-panel.tsx`（`repo-state`、`repo-prepare`、`repo-prepared`、`repo-empty`）                                 | `p-repo-entry.sh`                           |
| inspector 与相关页面的 Agent status、活动 runs、错误与仓库依据               | `components/info-hub/run-facts.tsx`（聚合视图，不列逐轮历史）、`chat-inspector.tsx`                                                               | `q-info-hub-runs.sh`、`o-turn-semantics.sh` |
| 跨页面演示与章节交付材料                                                     | 本文档，以及 `docs/p3/evidence/` 的既有证据与 `.verify/` 的重跑产物                                                                               | 见下                                        |

## 验证

- `scripts/verify.sh` 在 `869bf22` 上跑完 21 个脚本，293 行 PASS。`a-base.sh` 当次因本机预览服务占用 3000 端口失败（`.env.local` 的 `PORT=3000` 覆盖脚本的 `--port 3112`），停掉预览后单独重跑 12/12 通过。两次结果合起来是 21/21，不是单次干净运行。
- 与 P3 直接相关的三个脚本在同一轮通过：`o-turn-semantics.sh`、`p-repo-entry.sh`、`q-info-hub-runs.sh`。
- 独立技术验收在 [技术收口](evidence/p1p2/technical-acceptance.md) 中复核过 P3 的关键断言未删（排队与运行标识、未投递计数、停止后状态、`?info=1` 打开 inspector）。
- 单测 165 个通过，`pnpm check` 0 error、1 条既存 warning（`scripts/ui-review/review.mjs`），`r-ui-layout.sh` 29 项通过。

## 未验证与边界

- 独立技术验收没有为 I-P3 单独立项，P3 的独立复核发生在 I-P1/P2 那把验收里。本记录不把它改写为「独立的 I-P3 整章验收」。
- P3 自身未完成的一项继续沿用：宿主 Pi 工具的完整保留与 Sprout extension 加载是部分交付，见功能计划 P3。
- 未投递输入的人工处置、Info Hub 自动刷新不在本期范围。
- Human 体验确认记录在 `869bf22`，不覆盖 P4a 之后的任何能力。

## 与计划的关系

`docs/development-plan-ui.md` 的 UI-P3 章节勾选依据本记录。`docs/development-plan.md` 的 I-P3 集成单元按已收尾状态记录，并在该项下注明独立验收的归属差异。

后续若要恢复「P3 单独整章集成」的原意，需要由总计划重新安排一次 I-P3 独立验收，本记录不构成对该安排的替代承诺。
