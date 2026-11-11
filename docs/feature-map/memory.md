# Project 记忆

## Sub-features

- 为当前 Project 开启或关闭记忆，保存服务地址、bank 前缀与名称、只写 token 及自动维护设置。
- 显示 Machine 上记忆组件的安装状态；测试连接、重试安装、确认清空当前 Project 的 bank。
- 开启且组件 ready 时，新 worker session 装载八个 `hindsight_*` 工具，读取记忆并自动写回会话。
- 关闭、配置不可用或 extension 装载失败时，新 session 不暴露记忆工具、skill、注入或 `HINDSIGHT_*` 环境变量；普通对话仍可继续。

## How to get to it (user POV)

进入 Project → 设置 →「记忆」，深链为 `/projects/<projectId>/settings?tab=memory`。有修改权限的用户可启用并保存；无修改权限时查看当前配置与状态。token 保存后不回显。

先保存配置，再使用「测试连接」「重试安装」「清空记忆」。清空需要输入 Project 名确认。设置变更用于后续 session；验证开关时新建 session，避免沿用已有 runner。

## Driving it with …

### 领域测试与真实 runner fixture

按本次改动选择测试，命令使用仓库已有的 Vitest 配置：

```sh
pnpm test tests/memory-config.test.ts tests/memory-settings.test.ts tests/memory-server-boundary.test.ts
pnpm test tests/memory-actions.test.ts tests/memory-install.test.ts tests/memory-runtime.test.ts
pnpm test tests/memory-config-view.test.ts tests/memory-config-migration.test.ts
pnpm test tests/memory-runner.test.ts
```

`tests/fixtures/memory-runner.ts` 启动真实 Pi runner，但模型和记忆 extension 使用本地 fixture，不调用付费模型或真实 Hindsight。覆盖 disabled、unavailable、ready、import/factory/session_start 失败、工具注册不完整、assistant 和 legacy 九种场景。核对 `snapshot.tools` 与 `snapshot.registeredTools`、资源路径及 skill 名、环境清理、配置文件权限、回退后的正常 turn、退出清理。

其中普通 skill 和记忆 skill 都采用 `package/skill/SKILL.md` 目录形状，防止只按 `/hindsight-coding-agent/` 路径名过滤导致官方 npm 包泄漏。ready 保留两者，其余状态保留普通 skill，移除记忆 skill。

### 真实 Hindsight 与模型

前置条件：可访问的 Hindsight 服务、认证、可用的模型、独立临时数据库与数据目录，以及专用随机 bank。先迁移临时库至最新，再用 `provisionMemoryExtension` 安装钉死版本和摘要的官方 npm bundle；使用 `resolveMemoryRuntime` 组装 worker 配置。凭据只能在进程环境或配置行使用，输出必须脱敏。

依次验证：

1. 启用 Project 记忆并确认安装 ready；新 session 提醒记住一条无歧义事实，待 turn 结束后通过真实 API 的 document detail 和 recall 核对自动写入。
2. 再建 session 询问该事实；核对答案、八个 `hindsight_*` 工具、记忆注入块与不同 session ID。
3. 关闭记忆后再建 session；核对工具、skill、skill 路径、systemPrompt、注入和环境变量均不含记忆内容，并确认 turn 可结束。
4. 制造安装器真实失败后再建 session；核对失败原因可观察、turn 正常结束、安装状态没有在 runner 内反复重试。

完整执行记录、命令、脱敏输出、调用次数和边界见 [MEM-6 真实链路记录](../memory-e2e.md)。该记录的测试 bank 已删除；复跑必须重新建库。主模型调用数按 assistant completion 统计，工具交互后的继续生成也计入，不将 session 数当作调用数。

### 页面检查

页面行为从 `data-testid="memory-config-panel"` 和 `memory-config-status` 定位。检查未保存草稿时操作受限、保存失败保留草稿、安装状态与错误文案、token 不回显、清空确认及只读权限。真实页面评审遵循 [Human Review](../human-review.md) 与宿主预览约定。MEM-6 通过 runner 验证运行链路，没有执行浏览器页面检查。

## Gotchas

- bank 的完整标识由前缀和名称组合；不要把 `sprout::name` 整体填入 `bankName`。改变 bank 选择不会迁移旧记忆。
- `/documents` 列表主要返回元数据，判断内容应读取 document detail 或执行 recall；不能只在列表中搜索原句。
- 会话注入保存在 session JSONL 的 `custom_message`，`customType` 为 `hindsight`；只查看普通 `message` 会误判为没有注入。
- 官方 npm skill 的目录名是 `package/skill`。隔离必须同时检查 SDK 解析后的 skill 名及实际 systemPrompt，不能只查目录段。
- 已安装目录有效时安装器会复用它。制造安装失败需在专用临时目录移开目标，不能改已部署实例的 bundle 或生产库。
- 八个工具的可见性、自动注入回答、主动调用检索工具分别是不同证据；记录实际发生的路径。自动回写是异步的，按完成条件等待并设置总超时。
- 配置关闭不会删除 bank；「清空记忆」会删除其内容。共享 bank 选择需要特别核对，真实验证仅使用自己创建的测试 bank。
- 真实链路不接 CI。Hindsight 内部抽取与整合也可能调用模型；客户端无法观测时明确记录为未统计。`testMemoryConnection`、`clearMemory`、compaction 和浏览器检查需分别记录，不从普通读写成功推断通过。
