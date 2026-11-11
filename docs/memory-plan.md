# Hindsight 记忆接入计划

> 状态：进行中，MEM-0 已完成，MEM-1 起待开始。入口见[开发总计划](development-plan.md#首版推进顺序)。

## 目标

Project 打开记忆后，Agent 跨 session 记住这个 Project 的决定、纠正和可复用结论，用户能在 Project 设置里完成配置并看到组件与服务的真实状态。关闭记忆后，扩展、工具、提示词和技能都不进入 Pi，行为与现在一致。

## 不做什么

- 不做多 provider registry。`provider` 列保留，界面先只显示 Hindsight。
- 不做记忆编辑、单条删除和独立搜索页。首版只有状态、测试连接、导入和清空。
- 不把记忆放进 Info Hub，不自动开放聊天正文，边界仍按[核心范围](core-scope.md)执行。
- 不做跨 Project 查询。Agent 只能读写当前 Project 的 bank。
- 不做 codebase survey 和按美元计费的索引。
- 不在记忆配置里放 cron 表达式。整理页面由 adapter 按 run 计数触发。

## 已冻结的决定

| 决定 | 取值 | 理由 |
| --- | --- | --- |
| 配置归属 | Project 级，一个 Project 同时只启用一种记忆系统 | 不同 Project 可能接不同记忆服务，隔离与权限都按 Project 收口 |
| 安装归属 | Machine 级，按组件版本记状态 | 扩展文件在执行 Pi 的机器上，不随 Project 复制 |
| 修改权限 | 只有 Human 能改配置与执行动作 | 与渠道配置一致，见 `src/domain/channel-config.ts` 的 `assertChannelConfigHuman` |
| 密钥读写 | 只写不读，视图只返回 `hasToken` | 避免设置页和日志回显密钥 |
| bank 字段 | `bankPrefix` 默认 `sprout`，`bankName` 默认空 | 两个字段的“空”语义不同，不能合成一个输入框 |
| 服务地址 | 空则取 `SPROUT_HINDSIGHT_API_URL`，再退 `http://127.0.0.1:8888` | 默认值不写进每一行，部署可整体覆盖 |
| 组件版本 | 钉死 `0.8.7` 加 tarball integrity | 宿主自动升级会改变工具名，sprout 不跟随 |
| 开关默认 | 打开，但地址或组件没就绪时显示“已启用，不可用” | 不静默失败，也不挡 run |
| 自动动作 | 入库自动索引新提交、整理页面默认打开 | 与 Hindsight 的默认行为一致 |
| 安装失败 | 不回滚开关，状态留在 `failed` | 配置是人的意图，失败是组件状态 |
| 注入行为 | 跟随 Hindsight 默认；首轮约 2,278 token，后续约 886 token/轮 | MEM-0 实测。关闭自动注入用 `autoInject: "none"`，`false` 会退回 reflect |
| 启用副作用 | 启用态会写宿主全局 `~/.pi/agent/skills/hindsight-coding-agent` | factory 的 `syncCompanionSkill` 不认 runner 的 `agentDir`；接受为已知副作用，关闭态仍过滤 |
| 关闭 | 不加载扩展、不注册工具、不注入提示词、不继承 companion skill | 关闭必须等于今天的 Pi 行为 |

## 数据形状

### 表

`memory_config` 沿用 `channel_config` 的列约定（`src/db/schema.ts`）。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `project_id` | text | 引用 `project.id` |
| `provider` | text | 首版固定 `hindsight` |
| `enabled` | integer boolean | 默认 `true`，与“开关默认打开”的决定一致 |
| `settings` | json | `apiUrl`、`bankPrefix`、`bankName`、`autoIndexCommits`、`refreshPages` |
| `secrets` | json | `apiToken` |
| `revision` | integer | 乐观并发，默认 `0` |
| `updated_at_ms` | integer | 最后修改时间 |
| `updated_by_human_id` | text | 引用 `user.id` |

主键 `(project_id, provider)`。领域层保证一个 Project 最多一行启用。

`memory_install` 记录执行机上的组件状态。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `machine_id` | text | 引用 `machine.id` |
| `component` | text | 首版固定 `hindsight-extension` |
| `version` | text | 钉住的版本 |
| `status` | text | `missing`、`installing`、`ready`、`failed` |
| `error` | text | 失败摘要，不含密钥 |
| `updated_at_ms` | integer | 最后变化时间 |

主键 `(machine_id, component)`。

### 契约

新增 `src/contracts/memory.ts`，内容与 `src/contracts/channel.ts` 对齐。

- `memoryProviderSchema`，首版只有 `hindsight`。
- `memorySettingsSchema`、`memorySecretsSchema`、`saveMemoryConfigInput`、`MemoryConfigView`。
- `memoryDefaults`，含地址、bank 前缀、两个自动动作和版本。
- `resolveApiUrl(settings, env)`。
- `resolveBankTarget({ bankPrefix, bankName }, projectId)`，返回判别联合 `bare`、`namespaced`；前缀非空且 name 为空时用 projectId 拼出 `${prefix}::${projectId}`。
- `MEMORY_TOOL_NAMES`，八个 `hindsight_*` 名字。
- `HINDSIGHT_EXTENSION_VERSION` 与 tarball integrity。
- 生成配置的固定字段，`bankId`、`dynamicBankId: false`、`autoUpdate: false`；不要设置 `autoInject`，跟随默认 `reflect`，也就是 MEM-0 实测的 2,278 / 886 token。

校验规则。

- `bankPrefix` 空表示不要前缀；非空匹配 `[a-z0-9_-]{1,32}`。
- `bankName` 匹配 `[a-zA-Z0-9._-]{1,96}`，两个字段拼出的完整 bank 不超过 128 字符。
- `::` 直接拒绝，两个字段各自只表示一段。
- `bankPrefix` 空且 `bankName` 空是非法组合。
- 地址用与 `src/lib/config.ts` 相同的 `isInternalAddress` 规则，https 任意主机，http 只允许回环或内网。

### 运行时解析

`resolveMemoryRuntime(projectId, machineId)` 返回三态。

- `disabled`，不携带任何连接信息。
- `unavailable`，带原因 `invalid_config`、`machine_offline`、`not_installed`、`installing`、`install_failed`、`extension_load_failed`。没有配置行时按默认值视为已启用，不产生单独的“未配置”原因。
- `ready`，带 `apiUrl`、`bank`、`apiToken`、`bundlePath`。runner 用这些值生成一次性的临时配置，token 不进配置文件。

`ready` 的 token 只出现在 `open` 消息与 runner 进程环境里，run 快照只记录 `{ state, reason, bank }`。生成或读取配置失败一律返回 `unavailable`，不回退 bundle 默认值，因为默认的 `mapPathToBank` 会指向宿主的 live bank。

`SPROUT_PI_MACHINE_ID` 把 server 本机的 Pi 执行宿主绑定到 `machine.id`。配置了且可访问即视为在线，因为 Pi 就在这个进程所在机器上执行；未配置或不可访问时返回 `machine_offline`。云端实例与自建实例都通过 `apiUrl` 指向，`serverMode` 固定 `self-hosted`；云端端点的实际鉴权与路径由 MEM-6 验证。

### 状态

安装状态按 `missing → installing → ready | failed` 迁移。同一版本重复进入 `ready` 必须是空操作。

记忆的有效状态由配置与安装共同决定，顺序是配置非法、机器离线、组件未就绪、可用。服务是否可达由设置页的独立探测展示，不进入这个纯函数。设置页显示的就是这个有效状态，不是单独的布尔开关。

## 单元

| 单元 | 依赖 | 范围 | 单元结束时必须证明 |
| --- | --- | --- | --- |
| MEM-0 事实核对 | 无 | 只读核对 bundle 行为与真实服务 | 三件未知有结论，注入成本有数字，go/no-go 已记录 |
| MEM-1 契约与表 | MEM-0 | 契约、schema、迁移、领域读写 | 单测覆盖 bank 四行与两个非法组合、密钥脱敏、revision 冲突 |
| MEM-2 组件安装 | MEM-1 | Machine 级下载、校验、解压、状态机 | 冷装、幂等、并发单飞、校验失败、超时、残留锁都有测试 |
| MEM-3 Runner 激活 | MEM-1、MEM-2 | 扩展工厂、环境、工具面、技能过滤、快照 | 开、关、安装失败三种 run 的行为都被真实 runner 证明 |
| MEM-4 设置 API | MEM-1、MEM-2 | 读写、测试连接、重试安装、清空 | 权限、revision、空密钥保持、错误分类都有边界测试 |
| MEM-5 设置页 | MEM-4 | 先出 2 到 3 个 HTML 方案，Human 选定后实现 | 选定方案落地，浏览器脚本与截图证据，Human 评审通过 |
| MEM-6 真实链路 | MEM-3、MEM-5 | 真实服务、真实模型、功能地图与文档 | 写入后新 session 能检索到；关闭后无工具无注入；失败不挡 run |

### MEM-0 事实核对

只读，不改产品代码。用本机真实的 Hindsight 服务与真实 Pi runner 核对。

1. 直接 import `dist/pi.js` 后，`HINDSIGHT_CONFIG` 指向生成文件是否生效，`before_agent` 注入是否随 session 生命周期执行。
2. `HINDSIGHT_BANK_ID` 是否压过 `bankIdTemplate`，显式 bank 是否会在 `sprout` 前缀下按需创建。宿主当前用 `mapPathToBank` 按路径前缀解析 bank，sprout 生成自己的配置时必须显式写 bank，不能整份复制宿主配置。
3. 一个真实多轮 session 的注入 token 成本，第一轮、第二轮、第十轮各记一次；压缩后是否重复注入。
4. 0.8.7 实际注册的工具名与 `MEMORY_TOOL_NAMES` 是否一致。
5. retain 是否依赖 session transcript 文件，复用 session 文件的新进程能否正常写入。

产出 `docs/memory-spike.md`，记录命令、输出、数字和结论。结论是“bundle 可控”才进入 MEM-1；不可控就停下报告，改为在 sprout extension 里实现四个工具并直连 HTTP API，配置形状不变。

### MEM-1 契约与表

- 新增 `src/contracts/memory.ts`、`src/domain/memory-config.ts`、`tests/memory-config.test.ts`。
- 迁移编号 `0056`，由阶段集成 owner 生成。
- `saveMemoryConfig` 接受 `revision`，不匹配返回冲突；`apiToken` 为空表示保持原值。
- 视图返回 `hasToken`、有效状态、`lastError`，不返回密钥。

### MEM-2 组件安装

- 新增 `src/server/memory-install.ts`，目录是 `<SPROUT_PI_DATA_DIR>/extensions/hindsight/<version>`。
- 取 registry 元数据里的 tarball 与 integrity，校验 sha512 后解压到临时目录，再原子 `rename`。
- 解压用系统 `tar`，不引入新依赖，不执行包的 lifecycle 脚本。
- 进程内单飞加目录锁，锁带超时；整体 120 秒超时。
- 保存设置时触发一次，服务启动时预热；run 开始只读状态，不等待。
- 环境覆盖：`SPROUT_PI_HINDSIGHT_EXTENSION_PATH` 指向本地目录，`SPROUT_HINDSIGHT_EXTENSION_TARBALL` 指向本地 tarball，供测试与离线安装。

### MEM-3 Runner 激活

- `open` 消息增加 `memory` 块；runner 写 `HINDSIGHT_*` 环境变量后动态 import 工厂。
- 生成独立 JSON，显式写 `bankId`、`dynamicBankId: false`、`autoUpdate: false`，不写 `autoInject`（默认 `reflect` 才是实测成本那一档），并在 import 前设置 `HINDSIGHT_CONFIG`。生成或读取失败一律 `unavailable`，不回退 bundle 默认值。
- 八个工具名只在 `ready` 时进入 `tools` allowlist。
- 关闭时清掉从服务端继承的 `HINDSIGHT_*`，并按路径过滤 companion skill。`scripts/pi-host-skills.mjs` 目前会把 `~/.pi/agent/skills/hindsight-coding-agent` 继承给每个 session，这个过滤与开关无关，始终生效。
- 启用态的 factory 会调用 `syncCompanionSkill`，它不认 runner 的 `agentDir`，恒写 `~/.pi/agent/skills/hindsight-coding-agent`。接受为已知全局副作用，但关闭态仍必须过滤所有继承路径。
- 加载失败、注册断言失败、注入超时都降级为本次 run 无记忆，run 正常结束。
- 快照写 `memory` 状态，不写 token。

### MEM-4 设置 API

- 新增 `src/server/functions/memory.ts`，照 `src/server/functions/channels.ts` 的边界写法。
- 读接口返回配置视图与安装状态；写接口只允许 Human。
- 动作：测试连接、重试安装、清空本 Project 记忆。清空要求输入 Project 名。
- 测试连接区分不可达、401、403、bank 不存在和成功。建库确认用显式 `PUT` 加 `GET`，不能把空 retain 的 200 当建库成功；读取 404 不报成网络断线。

### MEM-5 设置页

先出 2 到 3 个可比较的 HTML 方案，经 Human 选定后再写页面。方案只决定信息层级与放置方式，不先写实现。

实现范围：`src/components/project/settings-tabs.tsx` 增加“记忆”，新增 `memory-config-panel.tsx` 与 `memory-config-copy.ts`，复用 `SettingsSection`、`ResultError` 和现有表单组件。

页面必须能表达这些事实，不依赖 toast。

- 开关、地址、密钥、`bankPrefix`、`bankName`、两个自动动作。
- 有效状态与原因：未配置、组件安装中、安装失败、服务不可达、已就绪。
- 实际使用的 bank，随输入实时更新。
- 最近写入与注入时间、最近错误摘要。
- 测试连接、重试安装、导入仓库历史、清空记忆。

### MEM-6 真实链路

在本机跑真实 Hindsight 与真实模型，记录付费调用次数。

1. 打开记忆，第一次 run 写入一条决定。
2. 新 session 的第二次 run 能检索到这条决定，且工具面包含八个记忆工具。
3. 关闭记忆，下一次 run 没有记忆工具、没有注入块、没有 companion skill。
4. 断开服务或让安装失败，设置页显示原因，run 仍然完成。
5. 清空记忆后检索不到旧内容，bank 仍可继续写入。
6. 非空 retain 是否自动建库、真实多轮 session 恢复、真实 compaction 后的注入与 token 成本、启用态对全局 skill 的写入。

同轮新增 `docs/feature-map/memory.md`，更新功能索引与开发总计划状态。

## 验证

| 层 | 覆盖 | 方式 |
| --- | --- | --- |
| 领域单测 | bank 解析、地址校验、密钥脱敏、revision、状态归并 | `pnpm test` |
| 安装器 | 幂等、并发、校验失败、超时、残留锁、无 lifecycle 脚本、本地 tarball 离线安装 | 本地 fixture tarball 单测 `tests/memory-install.test.ts` |
| Runner | 开、关、失败三态与工具面、注入、技能过滤 | 真实 runner 加 model fixture，新增 `scripts/verify/m2-memory-runner.sh` |
| API | 权限、并发、空密钥、动作错误分类 | 领域与 HTTP 边界测试 |
| 页面 | 信息层级、状态表达、交互 | 浏览器脚本、截图、Human review |
| 真实链路 | 写入、跨 session 检索、关闭隔离、失败降级 | 本机真实服务，记录付费调用 |

新增门禁登记到 `scripts/verify/targets.mjs`，按[验证约定](verification.md)记录受验 commit、实际命令、运行模式与未覆盖项。

## 开放问题

- ~~`HINDSIGHT_CONFIG` 的文件 schema 对直接 import 是否完整生效~~。已由 MEM-0 确认，见 `docs/memory-spike.md`。
- ~~`HINDSIGHT_BANK_ID` 与 `bankIdTemplate` 的优先级~~。已由 MEM-0 确认，文件字段优先于环境变量。
- Hindsight 是否支持按 bank 或 namespace 限权的 token。若不支持，Pi 进程里的 token 对 Agent 可见，需要单独记录并在设置页提示。
- 整理页面是否有服务端可调用的触发接口。没有就由 adapter 每 20 个 run 触发一次，不新增 UI 字段。
- 同一 bank 被两个 Project 共用时，并发 retain 是否互相覆盖。首版允许共用，但要在文档里写明后果。
- ~~0.8.7 的注入块实际开销~~。已由 MEM-0 测得首轮约 2,278 token、后续约 886 token/轮；`autoInject: "none"` 仍注入指南与 roster。

## 风险与回退

- bundle 不可控或升级破坏工具名。钉版本、注册断言、失败降级。回退路径是在 sprout extension 里实现四个工具直连 HTTP API。
- 注入成本过高。用 `autoInject: "none"` 降级，但它仍注入指南与 roster；若产品要求零注入，需要自建注入适配，首版不做。首轮约 2,278 token、后续约 886 token/轮已记入预算。
- 安装依赖 registry。提供本地 tarball 覆盖与离线安装路径；安装失败不挡 run。
- 执行机离线或组件缺失。状态按 Machine 记，设置页显示原因，不把 Project 配置改成失败。
- 密钥可见性。优先申请只覆盖 `sprout` namespace 的 token；拿不到就使用专用 token 并在设置页明示，不把宿主自己的 token 复制给 Project。

## 交付记录

| 单元 | 状态 | 证据 |
| --- | --- | --- |
| MEM-0 | 已完成 | [docs/memory-spike.md](memory-spike.md)，PR #41，`l-docs.sh` 与 `l-docs-probes.sh` 通过 |
| MEM-1 | 已完成 | PR #42，`05fa735`，迁移 `0056`，48 tests；验证者 GO WITH CHANGES，修正 `8207e9b`；F3 按现有 `channel-config` 约定保留 |
| MEM-2 | 已完成 | PR #43，`27959a7`，修正 `de78e30`、`cd4a9f1`、`3640b2d`，15 tests；第三次验证 GO WITH CHANGES，仅更正历史基准记录 |
| MEM-3 | 未开始 | |
| MEM-4 | 未开始 | |
| MEM-5 | 未开始 | |
| MEM-6 | 未开始 | |
