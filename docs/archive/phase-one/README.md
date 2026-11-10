# 一期计划归档

一期已交付，当前工作状态见[开发总计划](../../development-plan.md)。本目录收存归档基线 `1cfa15f` 中的计划与执行记录，不启动新的功能或 UI 工作。

## 归档结构

| 记录 | 内容 |
| --- | --- |
| [原开发总计划](development-plan.md) | 一期集成顺序、暂停安排、I-P4a 至 I-P7 的交付与 Human 确认，以及一期收尾条件 |
| [原功能计划](development-plan-functional.md) | P0–P7、R1 的原始功能清单、阶段概览、完成记录与提交范围，以及待设计的历史 P8 条目 |
| [原 UI 计划](development-plan-ui.md) | UI 阶段设计、演示前端、集成条件与逐条交付状态 |

三份快照增加归档说明、调整相对链接并整理 Markdown 格式，原复选框与正文证据保持原状。原文件路径保留为当前入口，并保留所有原章节锚点到归档的链接。阶段文档、截图、设计稿和验收记录没有搬动或复制。

## 证据入口与状态判读

| 阶段 | 原始证据 |
| --- | --- |
| P0–P2 | [P0 summary](../../p0/summary.md)、[P1 summary](../../p1/summary.md)、[P2 summary](../../p2/summary.md)与 [P2 acceptance](../../p2/acceptance.md) |
| P3 | [summary](../../p3/summary.md)与 [acceptance](../../p3/acceptance.md)，原第 2 条保持部分交付、未勾 |
| P4a–P4d | [P4a](../../p4a/summary.md)、[P4b](../../p4b/summary.md)、[P4c](../../p4c/summary.md)、[P4d](../../p4d/summary.md)，各章含技术证据与带版本的 Human 确认 |
| P5a–P5b | [P5a](../../p5a/summary.md)、[P5b](../../p5b/summary.md) |
| P6a–P6c | [P6a](../../p6a/summary.md)、[P6b](../../p6b/summary.md)、[P6c](../../p6c/summary.md) |
| P7 | [summary](../../p7/summary.md)，Human 确认除 PWA 装机外的一期体验；UI-P7 第 3 条仍未勾 |
| R1 | [summary](../../r1/summary.md)与 [第七轮独立验收](../../r1/acceptance-round7.md)，Human 体验确认不适用与一期纳入决定分别记录 |

同一文档的概览、早期验收和后续补记可能记录不同时间点。例如功能计划仍有“P4c 待确认”“P7 待开始”及旧的下一任务，而总计划与 summary 后续已补入带版本的完成记录。当前入口按后续证据列出状态，归档不改写历史快照。

同理，P3 原工具面未包含的 MCP、用户 skills，后来已有 R1 和宿主 skills 继承、内联技能标记等增量。原第 2 条不因此补勾；现状按[当前总计划](../../development-plan.md#一期交付状态)和对应实现、提交理解。各阶段早期“后续阶段未开始”的文字只描述当时状态。

所有限制与未验证项继续由各章 summary 维护。部署、HTTPS 与 PWA 装机仍待验证和 Human 评审；归档不把阶段通过改写成这些范围也已完成。

## 本次归档核对

归档核对了三份计划、阶段 summary、Human 版本记录与 Git 历史，并查看 `src/server/pi-host/skills.ts`、`src/server/message-skills.ts` 的后续 skills 实现。归档前基线的 `bash scripts/verify/l-docs.sh` 实际执行为 exit 0。历史技术验收与 Human 确认来自上述原始记录，本次没有启动应用、重跑产品验收或收取新的 Human 确认。

归档后的文档验证按[验证约定](../../verification.md)执行，结果如下。门禁读取本目录的历史计划，继续核对证据、提交可达性、P3 部分交付与 Human 确认。

| 本次实际执行 | 结果 |
| --- | --- |
| `bash scripts/verify/l-docs.sh`（内部包含 `f-docs.sh`） | exit 0，文档证据、提交、全部 docs 内部链接与锚点通过 |
| `bash scripts/verify/l-docs-probes.sh` | exit 0，32 个探针通过；首轮 runner 耗时 65 秒，表格匹配调整后的最终一轮为 57 秒；含新增的归档入口断链、P3 误补勾与 PWA 误补勾反例 |
| 相关 Markdown 的 `pnpm fmt ... --check` 与 `git diff --check` | 均为 exit 0；formatter 按仓库配置检查 AGENTS 与三份归档计划，`docs/*.md` 和 README 被配置排除，另核对空白与链接 |
| 归档原文与旧锚点独立核对 | 三份快照逐一与 `1cfa15f` 原文比较，只允许归档说明、链接重定位与 formatter 变化；67 个原计划标题锚点均保留；另核对根目录 README 与 AGENTS 的链接 |

首次归档链接检查和格式检查发现的问题已修正，最终结果见交付报告。本次跳过全量测试、build、应用启动与页面评审：改动只涉及文档与文档门禁，相关反例由上述探针覆盖。
