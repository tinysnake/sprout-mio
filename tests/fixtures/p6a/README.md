# P6a 中文唤醒 fixture

`zh-wake.json` 从 `orchestrate/sprout-mio-p6/samples/wake-samples.json` 的 30 条合成中文协作样本中选取 10 条派生。每例记录原始样本 id、源文件 SHA-256 和改写说明，保留中文正文，替换为固定应用 id 和时间。源文件位于编排 checkout，fixture 门禁自身不依赖该文件。

| 样本 | 覆盖                         | 装配路径                                |
| ---- | ---------------------------- | --------------------------------------- |
| w01  | 确认后等待，无需回复         | contextual，Agent 候选                  |
| w06  | 迁移和回归同时推进，多 Agent | contextual，逐候选独立判定              |
| w12  | 交接后由当前 owner 回答进度  | contextual                              |
| w13  | 正在运行时收到补充要求       | contextual，保留 activeRun              |
| w17  | 讨论收尾                     | contextual                              |
| w20  | Human owner 提醒             | 改写为 periodic，唯一候选为 Human owner |
| w22  | finished Task 后的新点名要求 | 既有点名规则，零 provider 调用          |
| w23  | finished Task 后的确认       | contextual，无 assigned Task            |
| w24  | 没有 Task 的周期触发         | skipped，零 provider 调用               |
| w25  | 仅 finished Task 的周期触发  | skipped，零 provider 调用               |

每例的 `facts` 是装配函数的完整输入；`input` 是冻结契约下的完整 `WakeEvaluationInput`。w24/w25 的 `input:null` 表示不得产生判定快照，因为契约要求 periodic 输入至少有一条 assigned Task。`expected` 明确列出装配路径、候选集合、selected 集合、单个所选 provider 的调用次数，以及零 run/message/input 副作用。字段白名单由 runner 校验，未知断言键不能静默通过。

Human owner 例沿用设计 §1 的周期责任范围：只问当前 Human owner 是否需要回应，不伪造 Human mutation context。其余源样本的期望按所选成员身份映射，不改变原有选中集合。没有采用 w04/w18/w30 的旧 d5 接续深度假设。

```bash
bash scripts/verify/p6a-routing.sh
```

该门禁迁移一个独立的真实 SQLite，检查消息、run 和 run input 表保持零行；模型网络边界使用显式 transport fixture。模型结论由 fixture 提供，因此此门禁证明输入装配、响应解析、逐人选取、失败封闭和副作用边界，不能证明真实模型理解中文的效果。额外矩阵覆盖：裸名字点名优先于 owner、当前成员资格、排除发言 Agent、非 owner Agent 普通回复、运行中补充要求、周期 owner 的多 Task 汇总、Unicode 裁剪、总预算、两条 provider 的失败和部分 unknown。

重建 fixture：

```bash
pnpm exec tsx tests/fixtures/p6a/generate.ts /absolute/path/to/orchestrate/sprout-mio-p6/samples/wake-samples.json
pnpm exec vp fmt tests/fixtures/p6a/zh-wake.json
```

真实模型门禁：

```bash
SPROUT_VERIFY_PI_MODEL=provider/model bash scripts/verify/p6a-live-routing.sh
```

模型选择由 `scripts/verify/lib/live-model.sh` 读取。小脑使用 `PI_CODING_AGENT_DIR`（默认宿主 `~/.pi/agent`）中的模型目录和只读认证，直接发无工具 completion，不创建 Agent session/run。JEV 仅使用独立的 `JEV_API_KEY`，模型固定为 `jev-latest`；缺少凭据时写失败收据并退出非零，不调用 fixture transport。

live 门禁对 8 条具有合法判定输入的样本分别直接测量两个适配器，包括 w22 的点名输入；这是适配器效果观察，生产装配仍将 w22 交给规则路径。每条收据包含 provider/model、输入快照、输入/输出用量、适配器耗时、runner 耗时、中文结论、期望对比、零副作用和退出码。证据默认写到 `.verify/p6a-live-routing/<UTC timestamp>/`，可用 `SPROUT_VERIFY_DIR` 指定。

小脑的 `probability:null`，`certainty:low` 或 `decision:unknown` 转为 unknown，不制造概率。JEV 用 Noul 的 yes 概率，设计默认 `p>=0.8` 为 yes、`p<=0.2` 为 no，中间为 unknown；版本和阈值必须显式注入。这些阈值尚未经本批真实中文数据校准。unknown 不进入 selected；同批其他明确 yes 可保留，结果带 `provider_low_certainty`。
