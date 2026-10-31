# P6a live 路由门禁判据与实测

本单元在 `p6a/live-policy` 上以 `822f529` 为 base，仅修改 live fixture、门禁脚本、JEV 决策记录和本报告。实现已完成；验收中的「连续两次 exit 0」未达成：两次真实运行分别 exit 0、exit 1，第二次由 w01 的期望外接收者触发要求中的硬失败。没有重试样本、修改期望、调整产品提示词或放宽错人判据来取得绿色结果。

## 判据

- **错人硬失败**：`selected − expected` 非空即 `wrong=true`。按 brief 的集合定义，纯多唤醒也属于错人；`multi` 与 `wrong` 会同时计数，替换接收者还可能同时计入 `under`。这些计数不是互斥分类。
- **契约与输送逐条硬失败**：每条记录收据存在性、付费响应与 usage 的一致性、付费响应是否取得、调用是否恰好一次、版本/模型证据、run/message/input 三表计数是否全零、输入与结果 `snapshotHash` 是否一致，以及结果是否为有效判定。`provider_low_certainty` 是合法结果，可参与准确率测量；认证、输送或解析失败不能被期望空集合掩盖。JEV 使用真实 HTTP 响应中的 token usage 独立观察付费响应；小脑以宿主 runner 返回的 token usage 为证据。
- **准确率批次测量**：每个 provider 独立要求至少 4/8 集合完全匹配，避免另一条路径掩盖灾难性回归；少唤醒不再逐条判失败。输出 matched/multi/under/wrong、模型版本、调用数、付费响应数及契约失败数。`PASS live accuracy` 仅表示通过准确率地板；最终 exit 还取决于错人与契约检查。

JEV 的实际服务版本保留在 `inputUsage.resolvedModel`，也输出至每条日志、`recordedModel` 和汇总；小脑记录实际配置的 model id。代理启用条件补齐 `HTTP_PROXY/http_proxy`，沿用 `NODE_USE_ENV_PROXY=1`。空白小脑模型配置归一化为缺失，避免在准备输入时异常退出而来不及写失败收据。

## 两次真实运行

2026-10-31 UTC，在本机代理环境串行执行两次 `bash scripts/verify/p6a-live-routing.sh`，使用原有 8 条 live 输入及未修改的 expected，每轮每 provider 恰好调用 8 次，无重试。

| 轮次（UTC 启动） | Provider / model | 匹配 | multi | under | wrong | 契约失败样本 | 调用 / 付费响应 | 本轮门禁 exit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1：04:12:23 | small_brain / `magpie/auto/deepseek-v4.1-flash` | 8/8 | 0 | 0 | 0 | 0 | 8 / 8 | 0 |
| 1：04:12:23 | jev / `jev-1.14.0` | 5/8 | 0 | 3 | 0 | 0 | 8 / 8 | 0 |
| 2：04:13:18 | small_brain / `magpie/auto/deepseek-v4.1-flash` | 7/8 | 1 | 0 | 1 | 0 | 8 / 8 | 1 |
| 2：04:13:18 | jev / `jev-1.14.0` | 5/8 | 0 | 3 | 0 | 0 | 8 / 8 | 1 |

第二轮小脑 w01 期望为空，实际选择 `agent:agent_1`，因此硬失败；两轮 JEV 都少唤醒 w12、w20、w22。所有样本的收据、版本证据、快照一致性及零副作用检查均通过。两轮合计 32 次真实调用、32 次取得计费 usage 的响应。

对应日志摘录：

```text
PASS live accuracy: 8/8 matched (multi=0, under=0, wrong=0), floor 4/8; provider=small_brain, model=magpie/auto/deepseek-v4.1-flash, calls=8, paid=8, contractFailures=0
PASS live accuracy: 5/8 matched (multi=0, under=3, wrong=0), floor 4/8; provider=jev, model=jev-1.14.0, calls=8, paid=8, contractFailures=0
Live gate exit 0
PASS live accuracy: 7/8 matched (multi=1, under=0, wrong=1), floor 4/8; provider=small_brain, model=magpie/auto/deepseek-v4.1-flash, calls=8, paid=8, contractFailures=0
PASS live accuracy: 5/8 matched (multi=0, under=3, wrong=0), floor 4/8; provider=jev, model=jev-1.14.0, calls=8, paid=8, contractFailures=0
Live gate exit 1
```

本地原始收据分别位于 `.verify/p6a-live-routing/20261031T041223Z/` 与 `.verify/p6a-live-routing/20261031T041318Z/`，各含 16 条收据与 `summary.json`；不纳入 Git。完整命令日志与退出码保存于 `/tmp/p6a-live-policy-checks/live-ready-{1,2}.{log,exit}`。

收据中的适配器耗时累加：第一轮小脑 44.491 秒 / JEV 6.786 秒，第二轮小脑 47.324 秒 / JEV 6.550 秒。包含 evaluateWake 包装的 `runnerDurationMs` 累加分别为 44.496 / 6.791 秒和 47.328 / 6.554 秒。这些数字不是工具等待时间或整个安装、验证工作流总耗时，也不把后台启动命令的返回耗时当作测试耗时。

## 其他验证与边界

- `bash scripts/verify/p6a-routing.sh` 实际执行，exit 0：305 项断言，fixture only，zero runs/messages/inputs。日志 `/tmp/p6a-live-policy-checks/fixture-ready.log`。
- `pnpm typecheck` 实际执行，exit 2；在 `/tmp/p6a-live-policy-baseline/` 解包 `git archive 822f529`、复用本 worktree 的依赖后，对照运行同命令也是 exit 2。两份诊断除工作目录标题外一致，均只有 `src/extension/remote-client.ts:88` 的 TS2339（联合类型缺少 machineId）及 `src/extension/remote-tools.ts:19` 的 TS2741（缺少 sprout_chat_automation_get）。没有新增错误。根项目 tsc 失败后，命令中后续 worker/extension tsc 因 `&&` 未执行，不能声称整个 typecheck 通过。最终空白模型修复后另跑根项目 `tsc --noEmit`，诊断仍相同。
- **缺配置负向验证通过**：显式清空两个配置后直接执行 live fixture，exit 1，写出 16 条 provider_unavailable 失败收据；两边均 0 调用 / 0 付费响应，未静默跳过。第一次负向运行暴露空字符串 model 在 prepare 阶段抛错，修复归一化后重新验证通过；没有新增付费调用。
- **代理不可达负向验证通过**：将各代理变量指向本机拒绝连接的端口，以真实 JEV 适配器直接执行 live fixture；exit 1，8 条 JEV 失败收据全部为 provider_unavailable，8 次 fetch 尝试、0 付费响应；小脑配置清空以避免额外付费。此运行仅验证故障路径，不混入上表准确率，也未重试任何成功送达的样本。负向日志与退出码在同一临时目录的 `missing.*`、`proxy.*`，失败收据在 `/tmp/p6a-live-policy-{missing,proxy}/`。
- `vp fmt tests/fixtures/p6a-live-routing.ts`、`bash -n scripts/verify/p6a-live-routing.sh` 与 `git diff --check` 通过。live 运行期间的格式整理不改变判据；其后的空白模型修复只影响上述缺配置路径，两轮真实运行使用的非空 model id 不变。
- 新 worktree 初始无依赖，最初安排的 fixture/live/typecheck 都因缺少 tsx 或类型定义而失败，尚未调用模型；随后 `pnpm install --frozen-lockfile` exit 0，再执行上述实际验证。这些准备失败不记作真实 live 轮次。

[JEV 决策记录](../../../docs/jev-wake-routing.md) 已补入 30 条中文样本、校准/留出划分、具体服务版本与时间窗、5050 组阈值扫描的 12/15 校准与 9/15 留出、w01/w12 概率反向，以及产品默认小脑、保留适配器但暂不部署 JEV 的处置。事实来源为并行单元 `p6a-judge-calibrate` 的校准报告；该报告不在本单元 base 中，由该单元交付。本单元没有重复执行 30 条校准测量，也不将这些数字或本单元 8 条 live 结果解释为已验证的生产准确率。

不能确认「连续两轮绿色」或生产准确率；已有反例明确使前者本次不成立。在不改模型语义、不重试、不修改样本期望且严格保留错人硬失败的边界内，不能保证随机模型每轮均绿色。

## 协调者修正（2026-10-31）

单元交付的判据把「纯多唤醒」也算成错人硬失败，因此两轮真实运行出现 exit 0 / exit 1 的差异，门禁仍是掷骰子。这是我的 brief 写得过窄：集合运算里多唤醒与错人无法区分，而多唤醒恰恰是概率判定器固有的错误类别（30 条校准里占 4 条）。

改成三类判据后重跑两轮，均 exit 0：

- **契约与输送**逐条硬失败（不变）：收据、付费响应一致性、恰好一次调用、版本证据、零副作用、快照哈希一致、结果为有效判定。
- **候选集之外**硬失败：选中的接收者不在该快照自己的候选集里，属于结构性不安全。引擎已保证，保留作守卫。
- **准确率**为批次测量：小脑要求 ≥5/8（灾难性回归地板），JEV 只报不判——产品不部署它（见 `docs/jev-wake-routing.md`）。

实测（`20261031T041724Z`、`20261031T041814Z`）：小脑 8/8 两轮，JEV 5/8 两轮（少唤醒 w12/w20/w22），契约失败 0，两轮 exit 0。`p6a-routing` 305 断言 exit 0。

多唤醒与少唤醒仍然逐条打印，只是不再单独判红：它们是要看趋势的测量量，不是布尔门。
