# 宿主仓库入口与 provenance

本 unit 让 P2 存储的 `project_profile.gitRemote`、`defaultBranch`、`workDirectory` 三个字段被真实消费：宿主把 Project 绑定的仓库取到磁盘，DM 里的分身在真实轮次中以工作副本为 cwd 读到仓库内容，「这次分析基于哪个 commit」成为持久事实。真实接入结论只由 `bash scripts/verify-live/pi-repo-analysis.sh` 支撑；`bash scripts/verify/p-repo-entry.sh` 是 hermetic 验收，用脚本自建的本地裸仓库当远端，不依赖公网，不需要模型。

## 两种入口

| 入口         | 配置                                             | 行为                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 复用本地副本 | `workDirectory`（相对 `SPROUT_REPO_DIR` 的路径） | 不重新 clone。`git rev-parse` 取副本自身 HEAD 为分析依据；配置了 `gitRemote` 时先 `git fetch origin <defaultBranch>` 验证远端可达并更新引用，但**不改写工作树**（不 checkout、不 reset），副本的未提交状态被尊重    |
| 按需获取     | 只有 `gitRemote`                                 | clone 到 `<SPROUT_REPO_DIR>/<projectId>`。目录不存在时 `git clone --branch <defaultBranch> --single-branch`；已是托管仓库时 `git fetch` + `git checkout -f -B <defaultBranch> FETCH_HEAD`，工作树强制对齐到目标 ref |

两者都未配置时，run 沿用 p3-a 的分身实例目录 `<SPROUT_PI_DATA_DIR>/<instanceId>/workspace`，不写 provenance。`workDirectory` 解析为 `join(SPROUT_REPO_DIR, workDirectory)`，与 P2 契约的「相对路径」约束一致，不新造配置字段。轮次 cwd 的传递方式是宿主在 `open` 命令里把 `cwd` 指向工作副本；runner 与 p3-a/b 的事件语义、投递与关闭时限不变。

绑定副本的语义是宿主管理：fetch 会更新远端引用，但工作树保持用户副本的原样，provenance 如实记录 HEAD 的 commit 与 `fresh = false`，UI 显示「本地副本（宿主复用）」且获取时点为空时显示「宿主未取过」。托管副本属于宿主，可以被强制对齐与清理。

## schema 与 provenance 字段

迁移 `drizzle/0004_thin_leopardon.sql` 新增两张表，不改 0002/0003。

`repo_checkout`（每个 Project 至多一行，`repo_checkout_project_unique`）：

| 列                  | 含义                                                       |
| ------------------- | ---------------------------------------------------------- |
| `id` / `project_id` | `repoc_` UUID 主键，Project 唯一外键                       |
| `path`              | 工作副本绝对路径                                           |
| `source_kind`       | `managed_clone`（宿主克隆）或 `bound_copy`（复用本地副本） |
| `source`            | 来源：配置了 `gitRemote` 时是该 URL，否则是本地路径        |
| `ref` / `commit`    | ref 名与 `git rev-parse` 的完整 SHA 实值，不由宿主拼接     |
| `fetched_at`        | 宿主最近一次真实 fetch/clone 的时点，从未取过为 NULL       |
| `resolved_at`       | 最近一次 rev-parse 确认状态的时点                          |
| `size_bytes`        | 最近一次准备时的目录占用                                   |
| `status`            | `preparing`（git 操作进行中）或 `ready`                    |

`repo_provenance`（每次分析依据一行，`run_id` 唯一，与 run 一对一）：

| 列                                                   | 含义                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `run_id` / `project_id` / `checkout_id`              | 关联的 run、Project 与副本行                                           |
| `path` / `source` / `source_kind` / `ref` / `commit` | 该轮实际使用的工作副本路径与分析依据，与该轮快照的 `repo` 字段同源写入 |
| `fresh`                                              | 该轮是否由宿主把工作树更新到目标 ref。托管克隆为 1；绑定副本永远为 0   |
| `size_bytes` / `recorded_at` / `fetched_at`          | 占用、记录时点与最近取用时点                                           |

provenance 在 runner `open` 成功之后、run 进入 `running` 之前写入，因此每一行 provenance 都对应一次真实使用该副本的 run；准备或 open 失败的 run 不留 provenance，run 以 `failed` 加 errorCode 结束。快照新增可选字段 `configSnapshot.repo`（`src/contracts/agent-run.ts` 的 `RunRepoSnapshot`），记录 provenanceId、path、source、sourceKind、ref、commit、fresh、sizeBytes、recordedAt；已有字段语义不变。查询入口 `getRunRepoBasis(runId, ctx)` 与 `getProjectRepoState(projectId, ctx)` 经 Project 授权，供 p3-d 的 Info Hub 使用。

## 锁的设计与范围

`src/server/git/lock.ts` 的 `withRepoLock(projectId, fn)` 是进程内按 Project 串行的 promise 链，加上 `repo_checkout.status = 'preparing'` 的持久行表达进行中状态。同一 Project 的 clone/fetch/checkout 不会交错；不同 Project 使用不同 key，互不阻塞。局限：锁只在单宿主进程内有效，P3 的保证范围就是单进程宿主；两个进程同时写同一数据库不在保证内。崩溃残留的 `preparing` 行在下一次准备时被覆盖，不影响正确性。

## git 错误分类表

所有 git 操作经 `src/server/git/git.ts` 的同一子进程入口：`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS`/`SSH_ASKPASS` 置空、`GIT_SSH_COMMAND` 带 `BatchMode=yes`、`-c credential.helper=`（绕开本机凭据助手）、`LC_ALL=C` 固定英文输出、默认 120 秒超时强杀。stderr 按模式分类，run 失败时 `errorMessage` 取 `fatal:` 首行。

| code                      | 触发                             | hermetic 复现方式                |
| ------------------------- | -------------------------------- | -------------------------------- |
| `repo_auth_failed`        | 401、凭据被拒、publickey 拒绝    | 本机起 401 HTTP 服务当远端       |
| `repo_remote_not_found`   | 远端不是 git 仓库或不存在        | `file://` 指向不存在的路径       |
| `repo_remote_unreachable` | DNS/连接失败                     | （ssh 连接被拒等）               |
| `repo_ref_not_found`      | clone/fetch 的 ref 不存在        | `defaultBranch` 指向不存在的分支 |
| `repo_timeout`            | 操作超时被强杀                   | （分类由子进程超时路径保证）     |
| `repo_disk_limit`         | 占用超过 `SPROUT_REPO_MAX_BYTES` | 小上限 + 16KB 仓库               |
| `repo_workdir_missing`    | `workDirectory` 不存在或不是目录 | 绑定 `ghost-dir`                 |
| `repo_workdir_invalid`    | 目录存在但不是 git 工作副本      | （rev-parse 失败路径）           |
| `repo_unconfigured`       | 手动「立即获取」但两个字段都为空 | UI 空配置点获取                  |
| `repo_git_failed`         | 其余 git 失败                    | 兜底                             |

失败全部变成 run 的 `failed`，带 errorCode 与非空 errorMessage（p3-b 的 `agent_run_failed_check` 强制）。`RepositoryError` 已加入 `src/server/functions/domain-errors.ts` 的共享错误表；`repo_*` 不在封闭的 `AppErrorCode` 内，HTTP 边界降为 `conflict` 并原样透出可读分类消息与 requestId。

## 磁盘策略

- `SPROUT_REPO_DIR` 默认 `~/.local/share/sprout-mio/repos`，是托管克隆的根，也是 `workDirectory` 相对路径的基准。
- `SPROUT_REPO_MAX_BYTES` 默认 2 GiB，作用于单个工作副本。超限时托管克隆被整个删除（半成品不留盘），run 以 `repo_disk_limit` 失败；绑定副本不被删除（用户数据），但同样显式失败并注明未修改副本。
- 占用可查询：`repo_checkout.size_bytes` 与设置页的「占用」行。
- 淘汰（eviction）本阶段不实现：宿主不会主动删除旧副本回收磁盘，磁盘增长只来自 fetch 的增量对象与克隆本身。

## 真实与桩的界限

- `scripts/verify/p-repo-entry.sh` hermetic：真实生产构建、真实 SQLite、真实 git 子进程与脚本自建的本地裸仓库（真实 commit、真实 ref、真实 fetch）、协议桩 runner 只替代 Pi SDK 与模型。它证明宿主行为、provenance 与 `git rev-parse`/`git log` 实值一致、并发不交错、四类错误分类与磁盘清理、UI 呈现。并发断言与 CHECK 直接 SQL 反证在 `tests/repository.test.ts`（p 脚本真实运行该文件）。
- `scripts/verify-live/pi-repo-analysis.sh` 真实模型：仍用脚本自建的本地裸仓库当远端，真实模型在 DM 里被要求读仓库文件并复述唯一标记，断言回复含标记、快照与 provenance 的 commit 等于远端 HEAD 实值、获取时点落在本轮窗口内。缺 Pi 凭据时打印 SKIPPED 并退出非 0。

## 采用与简化了什么

参考 `~/workspace/sprout`（commit `5b48a53b3`）：

- 采用：宿主侧统一的 workspace 根（其 `workspaceRoot = join(workingDirectory, '.sprout-workspaces')` 对应本 unit 的 `SPROUT_REPO_DIR`）；Project 绑定必须指向真实存在且可用的目录、取不到就显式失败而不是假装就绪（其 `validProjectBinding` / `RemoteWorkspaceUnavailableError` 的拒绝姿态）；失败进 run 的可解释错误。
- 简化：原 Sprout 没有宿主侧 git clone/fetch，工作副本全部来自远端 Worker 上的既有绑定。本 unit 的 git 子进程层是新增的。砍掉的部分：远端 Worker 与跨机 gateway、租约与 fencing（epoch/generation）、recovery receipt、MCP 检查与 lease、容器环境、remote operation store、断线重连与代际恢复。并发控制从跨机租约缩为单进程内互斥加一行持久状态。

## 未验证项

- 真实公网远端（GitHub over https/ssh）的认证与代理行为未验证；hermetic 只覆盖本地 401 与 `file://`，分类模式基于真实 git 的英文 stderr 但样本有限。
- 大仓库（GB 级）的克隆时长、磁盘统计在巨大目录上的耗时、以及 fetch 增量对象导致绑定副本超限的完整路径未实测。
- 绑定副本指向另一个仓库子目录、detached HEAD、稀疏检出等边界状态的行为未验证。
- 托管副本中的 `.sprout-pi`（runner 的 agentDir）与仓库内容并存，`git status` 会看到未跟踪目录；对分身读取无影响，但没有专门断言。
- 并发保证只覆盖单宿主进程；多进程同库不在保证内。
- 淘汰与配额回收未实现（见磁盘策略）。
