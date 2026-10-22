# p1p2 证据目录

本目录按阶段存放 I-P1/P2 迁移的截图与机器可读记录。目录里同时存在多轮产物，判断“哪张是最终版本”看索引，不看文件新旧。

## 索引

- `final-verification.json` 是本轮唯一索引。`images` 是 `251ddbb`（`src` 树 `e61c23a`）上本轮新跑的 46 项截图；`regressionImages` 是独立回归 worker 在同一基线跑 `verify.sh` 产出的 R/P3、隔离与断点图；`retained` 说明原样保留、但**不计入最终版本**的历史图片。
- `base-verification.json` 是早期 foundation 阶段记录（来源 `0a64fd9`），连同它引用的 6 张 `base-*.png` 一起原样保留，用于文档链接存在与该阶段可追溯。

## 阶段边界

| 文件 | 阶段 | 是否本轮最终版本 |
| --- | --- | --- |
| `final-*.png` | 本轮 46 项 | 是；`final-real-*` 为修复后重跑（`c1fd6ba`） |
| `regression-*.png` | 本轮完整回归（`251ddbb`，worker 执行） | 是，主线程复跑待完成 |
| `base-*.png`、`base-verification.json` | foundation（`0a64fd9`） | 否 |
| `layout-*`、`list-*`、`p2-*`、`p3-*`、`project-*`（无 `regression-` 前缀） | `8f7cce2` 前后历史轮次 | 否 |

同名画面在两个阶段都出现时，以 `final-` / `regression-` 前缀为准；无前缀的旧图保留不删，避免破坏历史章节引用。

`docs/p1/evidence/` 与 `docs/p3/evidence/` 未被本目录改动。

截图生成不等于视觉验收。视觉结论需要实际读图，并由主线程给出。

真实业务 10 项已在重复 key 修复（`3c745a6`，本分支 `c1fd6ba`）后重跑 10/10，`final-real-*.png` 已替换并重算 sha256。fixture 的 36 项未随该修复重跑。
