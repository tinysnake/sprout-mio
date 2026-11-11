# MEM-6 真实记忆链路验证

2026-11-11，在独立 worktree、临时数据库和专用 Hindsight bank 上完成验证。受验起点为 `6816aaeb1f6c19079f506d1ac0a5529f22d4d4bd`，本次 diff 修复关闭态遗漏官方 npm skill 的问题。本文记录实际执行结果，不更新 [memory-plan](memory-plan.md) 的单元状态。

真实写入和新 session 读取成功；关闭态的首次验证发现 skill 泄漏，回归修复后用真实包重新打开 session 检查通过；真实安装失败时，模型 turn 仍正常结束。关闭态修复后的检查没有再次发送付费 prompt，详见证据边界。

## 环境与隔离

| 项目 | 本次使用值 |
| --- | --- |
| 数据库 | `/tmp/mem6/sprout.sqlite` |
| Pi 数据目录 | `/tmp/mem6/pi` |
| 空白工作区 | `/tmp/mem6/workspace`，仅初始化 Git，无项目源码或锁文件 |
| Project / Machine | `mem6-project` / `mem6-machine`，均只存在于临时库 |
| Hindsight | `http://10.0.8.130:8888`，`/health` 返回 200 |
| 测试 bank | `sprout::mem6-b9af937b`，结束时已删除 |
| 凭据来源 | `~/.hindsight/coding-agent.json`；仅进程内读取及临时库配置行使用 |
| npm extension | `@vectorize-io/hindsight-coding-agents@0.8.7` |
| Pi SDK | `1.5.0` |
| 模型 | `magpie/auto/deepseek-v4.1-flash`，effort `low` |
| Runner | `scripts/pi-host-runner.mjs`，真实 SDK、真实 extension、真实模型 |
| 证据目录 | `/tmp/mem6/evidence` 和 `/tmp/mem6/run{1,2,3,4}` |

没有连接已部署 Sprout 实例，没有访问生产库 `/Users/snake/workspace/sprout-bin/prod/data/sprout.sqlite`，没有对 live bank `project::sprout-mio` 发出验证请求。测试配置显式指定 bank，runner 清除继承的 `HINDSIGHT_*` 后才装载本次配置；自动代码库播种关闭。宿主 agentDir 仅用于读取模型配置与认证。

## 执行命令与驱动

以下为本次实际命令。`/tmp/mem6/*.mjs` 是随证据保留的实验驱动，不是 CI 入口；再次实验应使用新的临时目录、随机 bank 和独立 session，不直接重复 seed。仓库未新增会自动调用付费模型的验收脚本。

```sh
DATABASE_URL=/tmp/mem6/sprout.sqlite pnpm db:migrate
node --import tsx /tmp/mem6/setup.mjs
node --import tsx /tmp/mem6/correct-config.mjs
node --import tsx /tmp/mem6/run.mjs 1
node /tmp/mem6/api-check.mjs
node --import tsx /tmp/mem6/run.mjs 2
node --import tsx /tmp/mem6/run.mjs 3
node --import tsx tests/fixtures/memory-runner.ts
MEM6_OPEN_ONLY=1 node --import tsx /tmp/mem6/recheck.mjs 3
node --import tsx /tmp/mem6/fail-install.mjs
node --import tsx /tmp/mem6/run.mjs 4
node --import tsx /tmp/mem6/final-check.mjs
node /tmp/mem6/cleanup.mjs
```

长命令在后台保存日志、PID 和退出标志；命令完成后按标志与进程状态判读。实验驱动通过 newline JSON 向 runner 发送 `open`、`prompt`、`close`；`open` 的 memory 来自 `resolveMemoryRuntime`，不是伪造 ready 状态。每次 run 使用不同 UUID 和 session 目录，继承的 skill 显式指向真实 npm 包。采集 `ready.snapshot`、`settled`、session JSONL 的 assistant 消息及 `custom_message/hindsight`。环境探针只写变量名；不记录 token 值。

初始化时曾将完整 bank 填入 `bankName`，resolver 正确拒绝为 `invalid_config`；随后改为 `bankPrefix: "sprout"`、`bankName: "mem6-b9af937b"`。两次 runner 输入错误（非法 Project ID、run ID）均在模型调用前被契约拒绝，纠正后才开始以下真实调用。

## 逐步结果

### 1. 真实安装与启用

`pnpm db:migrate` 退出 0，临时库有 57 条 migration 记录，包含 `0056`。`provisionMemoryExtension` 未提供 tarball 或 fetch stub，从 npm registry 下载官方 `0.8.7` 并校验固定摘要：

```text
sha512-GuGJdqvcPQpUuu9jWOjJa5OtaI/eAx20DgsiLKKEhfuSCDZXDBWH8Aa7lyj03dAVLMt40K7IciUBtD81QhdTBg==
/tmp/mem6/pi/extensions/hindsight/0.8.7/package/dist/pi.js
install.state = ready
runtime.state = ready
bank = sprout::mem6-b9af937b
```

证据：`/tmp/mem6/evidence/setup.json`。初始 `setup.log` 包含配置纠正前的结果，最终配置以 `setup.json` 为准。

### 2. Run 1：自动写入

提示：`记住：本项目的包管理器是 pnpm，不要用 npm。`

Session：`60ab69cc-ebf5-46ae-9baf-59e0a427e66a`。一次模型 completion，回答确认使用 pnpm；runner 发出 `settled`，`stopReason: stop`。session 有一个 `custom_message/hindsight` 注入块。自动写回后，真实 API 的 document detail 包含 pnpm，document 的 `memory_unit_count` 为 1；recall 返回两个结果，包含该约定。

```text
GET /v1/default/banks/{test-bank}/documents/{document-id} -> 200
POST /v1/default/banks/{test-bank}/memories/recall -> 200
query = 本项目用什么包管理器
results = 2，包含 pnpm
```

证据：`/tmp/mem6/run1/document-detail.json`、`/tmp/mem6/run1/recall.json`、`/tmp/mem6/run1/snapshot.json`、`/tmp/mem6/run1/summary.json`、`/tmp/mem6/evidence/run1.log`。

该 run 的实验驱动有一个观测错误：最初只检查 documents 列表元数据中是否含 pnpm，未读取 document detail，因而超时。随后独立 API 检查成功，模型 turn 早已正常结束；停止仍在等待的本次 runner 后，原驱动返回 1。不能把原驱动整体报告为 PASS，也不能将其超时归因为自动写入失败。

### 3. Run 2：新 session 读取

提示：`本项目用什么包管理器？`

新 Session：`3c627ca6-217a-4d54-be6a-9d375026d389`。最终回答：`本项目使用 pnpm（不要用 npm）。`，明确将结论归于 Hindsight 记忆。注入块包含 pnpm，共一个 `custom_message/hindsight`，正文 8659 字符。没有复用 run 1 的会话历史。

`tools` 与 `registeredTools` 两张表都包含以下八个工具：

```text
hindsight_capture_initiative
hindsight_diagnose
hindsight_ingest_document
hindsight_list_pages
hindsight_read_page
hindsight_reflect
hindsight_search_pages
hindsight_sync_status
```

模型先调用 `ls`、`grep`、`git_read` 检查空工作区，再回答，因此该 session 消耗三次 completion。没有从代码或锁文件读到 pnpm；本次证明自动注入可用于回答，不证明模型主动调用了 Hindsight 检索工具。驱动与 runner 均退出 0。

证据：`/tmp/mem6/run2/snapshot.json`、`/tmp/mem6/run2/summary.json`、`/tmp/mem6/run2/events.json`、`/tmp/mem6/evidence/run2.log`。

### 4. Run 3：关闭后的隔离与修复

将临时 Project 的 `memory_config.enabled` 置 0，新 Session `6106b433-3132-447d-bdca-7d50adb396a1` 以一次 completion 回答 `关闭记忆后会话正常。`，`stopReason: stop`，退出 0。工具列表无 `hindsight_*`，无记忆注入，`HINDSIGHT_*` 变量名列表为空。

首次隔离断言失败：`resources.skills` 仍有 `hindsight-coding-agent`，`resources.skillPaths` 仍有真实 npm skill。路径过滤只识别 `/hindsight-coding-agent/`，官方包实际路径为：

```text
/tmp/mem6/pi/extensions/hindsight/0.8.7/package/skill/SKILL.md
```

修复在 runner 的 SDK resource loader 边界按解析后的 skill `name` 过滤所有非 ready 状态，同时清理对应的显式文件路径。原路径过滤保留；普通 skill 不受影响。

回归将 `tests/fixtures/memory-runner.ts` 的普通 skill 和记忆 skill 都改为 npm 的 `package/skill/SKILL.md` 形状：修复前在 disabled 的 `skillPaths` 断言失败；修复后九个场景全部通过，包括 unavailable 和 extension 装载失败回退。另补齐既有 `autoSeed: false` 配置的陈旧期望值。

修复后用真实官方包再次 `open` 新 session，不发送 prompt：

```json
{
  "memory": { "state": "disabled" },
  "hindsightTools": [],
  "registeredHindsightTools": [],
  "skills": [],
  "skillPaths": [],
  "HINDSIGHT_variable_names": [],
  "systemPrompt": {
    "chars": 72,
    "hasHindsightSkill": false,
    "hasBundlePath": false
  },
  "additionalModelCompletions": 0
}
```

systemPrompt 探针读取 SDK getter 的原返回值，仅保存长度与命中布尔值，没有修改提示词。关闭态修复后的真实模型 turn 没有重跑；无注入的 turn 回归由本地模型 fixture 覆盖，真实包检查证明 session 初始化后的工具、资源和 systemPrompt 隔离。

证据：`/tmp/mem6/run3/isolation.json`（修复前失败）、`/tmp/mem6/run3/summary.json`、`/tmp/mem6/evidence/regression-red.log`、`/tmp/mem6/evidence/regression-green.log`、`/tmp/mem6/run3-fixed/snapshot.json`、`/tmp/mem6/run3-fixed/env.json`、`/tmp/mem6/run3-fixed/system-prompt-check.json`。

### 5. Run 4：真实安装失败不阻塞 turn

重新启用临时 Project，暂时移走已安装目录，使真实安装器必须重新校验；指定损坏的本地 tarball，沿安装器真实失败路径得到 `integrity_mismatch`，没有 mock fetch 或 install 状态。之后归还原目录，但保留失败状态行，验证 resolver 以持久化安装状态为准。

```json
{
  "installerError": "integrity_mismatch",
  "memory": { "state": "unavailable", "reason": "install_failed" },
  "answer": "安装失败后会话正常。",
  "stopReason": "stop",
  "modelCompletions": 1,
  "hindsightTools": [],
  "injectionCount": 0,
  "installRowUnchanged": true
}
```

新 Session：`93d0454c-5d92-4010-a2f1-ec0fc1407a8e`。runner 退出 0；无记忆 skill 或 `HINDSIGHT_*` 变量。安装状态在 turn 前后完全一致，runner 没有发起安装重试。该结论覆盖本次 runner 生命周期，不代表长时间运行的应用调度器已做重试压力测试。

证据：`/tmp/mem6/run4-install-before.json`、`/tmp/mem6/evidence/run4-install.log`、`/tmp/mem6/run4/snapshot.json`、`/tmp/mem6/run4/summary.json`、`/tmp/mem6/evidence/run4.log`、`/tmp/mem6/evidence/final-check.json`。

## 调用成本、清理和未验证项

| Run | 主模型 completion 数 | 用途 |
| --- | ---: | --- |
| 1 | 1 | 记住约定并自动写回 |
| 2 | 3 | 两轮工具交互后回答 |
| 3 | 1 | 关闭记忆后的真实 turn，修复前 |
| 4 | 1 | 安装失败后的真实 turn |
| 合计 | **6** | 四个真实 session |

修复后关闭态只执行 `open/close`，九场景回归使用本地模型 fixture，均不增加付费模型调用。Hindsight 服务内部抽取、整合和检索的模型成本不在 runner usage 中，未统计为零，也无法从本次客户端证据给出其调用次数或金额。

最终检查确认各 session 的 completion 总数为 6，安装失败行未变化，修复后关闭态隔离成立，并扫描文本证据无 token 明文（`/tmp/mem6/evidence/final-check.json`）。`DELETE /v1/default/banks/{test-bank}` 返回 200，随后 GET documents 返回 404；清理结果在 `/tmp/mem6/evidence/cleanup.json`。该 bank 已不存在，不能再直接对它重跑 recall。

未验证：真实 `testMemoryConnection` 建库、`clearMemory` 后召回为空、真实 compaction 后再注入、设置页浏览器操作、多 Machine 和应用调度器长期运行。没有用 stub 的结果冒充这些真实链路。

## 门禁

| 命令 | 结果与证据 |
| --- | --- |
| `pnpm test` | 通过，175 files / 1589 tests；`/tmp/mem6/evidence/gate-test.log` |
| `pnpm typecheck` | 通过；`/tmp/mem6/evidence/gate-typecheck.log` |
| `pnpm check` | 首次只因 fixture 格式失败，修正后重跑通过；`/tmp/mem6/evidence/gate-check-final.log` |
| `bash scripts/verify/l-docs.sh` | 新增文档后重跑通过；`/tmp/mem6/evidence/gate-docs-final.log` |
| `git diff --check` | 最终 diff 重跑通过；`/tmp/mem6/evidence/gate-diff-final.log` |

各次命令的实际退出码与命令耗时保存于 `/tmp/mem6/evidence/gates.json` 和 `/tmp/mem6/evidence/gates-final.json`；耗时为命令进程耗时，不是后台启动命令返回时间或整个工作流耗时。
