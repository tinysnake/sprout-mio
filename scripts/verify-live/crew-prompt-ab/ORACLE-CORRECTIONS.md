# 判定器修正与第二读数（2026-11-16）

第一对 live 批次（36 格）跑完之后，逐行回看发现判定器有四处自己的错误、一处夹具限制，以及一个没人注意到的档位问题。这些修正**不改变预注册判定**：`judge()` 仍然只用预注册门，`row.verdict` 的含义与之前完全一致。修正结果另存 `row.verdictCorrected`，两组读数一起报。

## 为什么要修

1. `artifacts.mjs` 的 `parallel` 计数正则要求文件名与计数之间没有任何数字，于是「`config/retry.json:1` — 值 5」这种先给行号的写法永远匹配不上。A 臂 `delegate-parallel-two` 的回复内容正确却判 failed。
2. `core.mjs` 的 `attribution` 门用 `everyDelegationMapped` 要求每条委派的请求文本都点到必需产物，而 lead 会因 `sprout_delegation_start` 返回状态不清晰多发一条探针委派（`requestSummary: "test delegation start"`、`requestArtifacts: []`），整行因此挂掉。这正是第 2 步要治的症状，拿它判失败等于把被测的缺陷算成提示词的失败。
3. 同门的 `parallel` 要求委派数恰好为 2；`delegate-parallel-two` 在探针委派存在时有 3 条，于是 `twoDelegations=false`。
4. `no_duplicate` 允许「什么都没做」通过：`delegatedCount=0` 也判 passed，而该任务的正确行为是核对后给出结论。
5. 夹具：`delegate-parallel-two` 要两个 worker 同时写一台机器，而产品对同一 `(project, machine)` 只有一份活跃授权（`src/db/schema.ts:2072-2074` 的 `lease_one_live_authorization`），第二个 worker 的 run 启动前就失败（`service.log`：`AgentRunError / conflict / Crew 资源尚未分配`）。
6. 档位：harness 请求 `effort: "off"`，而 pi-magpie 把 `off` 映射成 `null`（模型不支持关闭思考），SDK 的 `clampThinkingLevel` 把它钳到最近支持档，实测是 `low`。账本此前既不记请求档位也不记生效档位。

## 改了什么

| #   | 位置               | 内容                                                                                                                                                                                                                         |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `artifacts.mjs:4`  | `retryCountReported(text, file, value, corrected)`：`corrected=false` 保留原严格正则；`corrected=true` 允许显式行号（`:12`、`#L12`、` line 12`）或没有行号，但仍要求同一行内文件名与数值相邻                                 |
| 2   | `core.mjs:43`      | `evaluateOracle(name, f, { corrected })`：修正模式下 `anyDelegationMapped` 取代 `everyDelegationMapped`，同时记 `probeDelegations` 与 `dryDelegations`                                                                       |
| 2   | `core.mjs:64`      | `attribution` 只在「没有一条委派点到必需产物」时判失败；探针委派不再单独判死整行                                                                                                                                             |
| 3   | `core.mjs:100`     | `delegate_parallel` 只看「有 ≥2 条产出不同必需产物的委派」，探针委派不计入条数                                                                                                                                               |
| 4   | `core.mjs:118`     | `no_duplicate` 修正模式要求最终回复给出本任务特有的核对结论（`reviewConclusion`），零委派不再自动通过                                                                                                                        |
| 5   | `fixtures.mjs:96`  | `machineFixtureCount(name)` 与 `scopeForWorker(name, workerProfileId)`：`sandbox-parallel` 拥有第二台 Machine；`run-task.mjs` 按 profile 分配 scope，并把 `machineScopes` 写进结果行与任务提示词                             |
| 6   | `run-task.mjs:285` | 三个夹具 profile 的 `effort` 从 `"off"` 改成 `"low"`；每个 run 记 `thinkingRequested`（来自 profile）与 `thinkingEffective`（来自 ready 快照的 `configSnapshot.thinking`），行级 `thinkingEffective` 只在全部 run 一致时给出 |
| 6   | `core.mjs:139`     | `comparisonReasons()` 新增两条拒绝：完成的 run 缺生效档位、同一角色两臂的生效档位不同                                                                                                                                        |
| —   | `core.mjs:120,131` | `finalizeVerdict()` 同时产出 `verdictCorrected`；`judge()` 仍然只用预注册门                                                                                                                                                  |
| —   | `rejudge.mjs`      | 只读重判入口：`node rejudge.mjs <ledger.jsonl> <out.jsonl>`，拒绝输入输出同路径或互为硬链接，输出用 `flag:"wx"`、mode 0600，只读一次定义快照并容忍批次追加时的残缺尾行                                                       |

## 怎么验的

- `node --test scripts/verify-live/crew-prompt-ab/*.test.mjs`：37 tests / 37 pass / exit 0（`verdict.test.mjs` 新增 8 个测试，逐条覆盖上面六项与重判的只读性、异常排除、残缺尾行、fail-closed）。
- 每个放宽类改动都有反向断言：缺计数、错计数、同 profile 重复、零委派无结论、诱饵行为（lead 自己改文件 + 派一条无关委派）都必须失败。
- 端到端：`AB_DRY=1 AB_TASKS=delegate-parallel-two,worker-must-finish` 两臂各一次 → exit 0、4 行、comparison eligible、`parallel` 任务拿到两台不同 `machineId` 的 scope、结果行同时带 `verdict` 与 `verdictCorrected`。
- 重判第一对批次（36 行，原账本 sha256 `8072e711915a980525972286f19d9f4d44c43e60623422be22417f6f50665520`）：`verdict` A 11 passed / 5 failed / 2 excluded、B 12/5/1；`verdictCorrected` A 12/4/2、B 13/4/1。只有两行翻案，都是 `delegate-one-fix` repeat 2 的 `attribution`。

## 这些修正没有解决的问题

- live 路径仍然没有任何提示词哈希落账（`systemPromptHashes` 为空），所以 live 只能靠「同角色两臂 `systemPromptChars` 集合不相交 + 工具集相同」证明处理被施加，不能像 dry 那样比对哈希。这一条要单独修（计划文档里的 live 前置条件因此还没被完全满足）。
- 修正模式的计数正则接受行号错误的写法（只要文件名与数值在同一行）；它量的是「有没有报出这个值」，不再管行号。
- `run-task.mjs` 拼在用户消息里的「Fixture execution environment」说明会替系统提示词解释一部分资源协议，可能压缩被测效应；两臂相同，所以不影响对比方向，但会让绝对成功率偏高。
- `delegate-parallel-two` 的第二台 Machine 让该任务从「两臂都因争用 errored」变成可测，但它仍是六题里最重的一题，批次里通常只完成 2/3 次。
