# P1 工具链门禁

本文记录 P1 的检查、测试、构建与 CI 入口。每条结论都附真实命令与输出摘要。未跑过的项列在未验证项。

## 门禁清单

| 命令                   | 覆盖范围                                                                        | 失败会怎样                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm check`           | Oxfmt 格式、Oxlint lint、TypeScript 类型检查（`typeAware` 与 `typeCheck` 开启） | 非零退出。CI 与验证脚本在此停止，不带 `--fix`                                                 |
| `pnpm lint`            | 仅 Oxlint                                                                       | 非零退出                                                                                      |
| `pnpm typecheck`       | `tsc --noEmit` 与 Worker、extension 两份 tsconfig                               | 非零退出                                                                                      |
| `pnpm test`            | Vitest 5，匹配 `tests/**/*.test.ts`，`node` 环境                                | 非零退出。测试配置不加载 Start 与 Nitro 插件（`vite.config.ts` 的 `process.env.VITEST` 分支） |
| `pnpm build`           | Nitro 生产构建，产物 `.output/server/index.mjs` 与 `.output/public/`            | 非零退出                                                                                      |
| `pnpm db:migrate`      | Drizzle 迁移                                                                    | 需要 `drizzle/` 存在。当前不存在，CI 打印跳过说明而不是失败                                   |
| `pnpm worker:build`    | Worker 打包到 `dist/worker/main.js`                                             | 非零退出                                                                                      |
| `pnpm extension:build` | Pi extension 打包到 `dist/extension/main.js`                                    | 非零退出                                                                                      |

`bash scripts/verify.sh` 按文件名顺序执行 `scripts/verify/*.sh`，任一脚本失败即返回非零。当前包含 `a-base.sh` 与 `b-tooling.sh`，实测输出 `Verification scripts=2 failed=0`。

## 格式策略与排除项

写入用 `pnpm fmt`（`vp fmt`），只检查用 `vp fmt --check`，后者在有格式差异时退出 1。

覆盖范围是仓库根目录，先应用 `.gitignore` 规则（`node_modules`、`dist`、`.output`、`.verify`、`data`、`.tanstack`），再应用 `vite.config.ts` 的 `fmt.ignorePatterns`。实测匹配 33 个文件。

| 排除项                                 | 理由                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `experiments/**`                       | P0 实验产物，不在 P1 范围                                                   |
| `docs/*.md`、`docs/p0/**`、`README.md` | P0 与决策文档。重排会改写本 unit 范围外的文件，且格式改动与内容改动混在一起 |
| `drizzle/meta/**`                      | 生成物                                                                      |
| `src/routeTree.gen.ts`                 | 生成物。实测该文件不是 Oxfmt 格式，排除是必要的                             |
| `src/db/auth-schema.ts`                | 生成物。当前文件尚不存在，条目为 schema unit 预留                           |

`src/db/auth-schema.ts` 与 `src/routeTree.gen.ts` 由 P0 的 `vp check` 失败结论列出。把它复制到 `.verify/b-tooling/` 后 `vp fmt --check` 退出 1，证明它确实不是 Oxfmt 格式，`pnpm check` 全绿依赖这条排除。

`vp` 的 `--ignore-path` 不能覆盖 `vite.config.ts` 里的 `ignorePatterns`。传入空的 ignore 文件后仍是 33 个文件、全部通过。排除只能写在配置里。显式把被排除的路径传给 `vp fmt --check` 也不生效，输出为 `All matched files may have been excluded by ignore rules`。

operator 想改成全量格式时，删掉 `vite.config.ts` 的 `fmt.ignorePatterns` 条目，运行 `pnpm fmt`，然后单独提交格式改动。`experiments/**` 与三个生成物条目建议保留，因为手改生成物会和生成器冲突。

真实格式化结论是仓库已无差异。`vp fmt` 用 1245ms 处理 33 个文件，`git status` 无未提交的格式改动。CI 只跑 `pnpm check`，不带 `--fix`，残留差异即失败。

## CI 工作流

`.github/workflows/ci.yml` 触发条件为 `on: [push, pull_request]`，运行在 `ubuntu-latest`，`timeout-minutes: 20`，`concurrency` 取消同一 ref 的旧运行，`permissions` 只留 `contents: read`。

步骤依次为 `actions/checkout@v4`、`pnpm/action-setup@v4`（固定 `10.33.0`）、`actions/setup-node@v4`（`node-version-file: .node-version` 加 pnpm 缓存）、`pnpm install --frozen-lockfile`、`pnpm check`、`pnpm test`、`pnpm build`、条件迁移、生产启动 smoke、Worker 产物、extension 产物。

`.node-version` 写 `26.11.1`。GitHub runner 提供该版本，日志为 `Resolved .node-version as 26.11.1` 与 `Acquiring 26.11.1 - x64`，因此不需要回退到 LTS。

迁移步骤读真实状态决定行为，`drizzle/` 不存在时打印 `SKIP pnpm db:migrate: drizzle/ does not exist yet, the schema unit owns migrations`。schema 落地后该目录出现，步骤自动改为执行 `pnpm db:migrate`。

生产 smoke 在 3111 端口后台启动 `pnpm start`，轮询 `/`，再检查 `/`、`/projects/does-not-exist`、`/api/ping` 三个路径都返回 200，最后向进程组发 `SIGTERM` 并确认 10 秒内退出。

每次 push 与每个 pull_request 都跑同一个 workflow。下面是本 PR 分支上到 `ab06235` 为止的全部真实运行，都成功。

| 运行                                                                            | 触发                 | commit    | 结论      |
| ------------------------------------------------------------------------------- | -------------------- | --------- | --------- |
| [39013147691](https://github.com/tinysnake/sprout-mio/actions/runs/39013147691) | push，`p1/b-tooling` | `b876cbc` | 成功，29s |
| [39013168343](https://github.com/tinysnake/sprout-mio/actions/runs/39013168343) | pull_request，PR #2  | `b876cbc` | 成功，31s |
| [39013380235](https://github.com/tinysnake/sprout-mio/actions/runs/39013380235) | push，`p1/b-tooling` | `ab06235` | 成功      |
| [39013382888](https://github.com/tinysnake/sprout-mio/actions/runs/39013382888) | pull_request，PR #2  | `ab06235` | 成功      |

`39013147691` 与 `39013168343` 覆盖工具链代码，`39013380235` 与 `39013382888` 覆盖本文档第一版。改动本表的 commit 由同一 workflow 在 PR head 上验证，其 URL 记录在 PR 描述与本 unit 的报告中。

`gh run view --job=117339736206 --log` 的关键行如下。

- `Resolved .node-version as 26.11.1`，`Acquiring 26.11.1 - x64`。
- 安装：`Done in 4.7s using pnpm v10.33.0`（Actions 缓存命中）。
- 检查：`pass: All 33 files are correctly formatted (689ms, 4 threads)` 与 `pass: Found no warnings, lint errors, or type errors in 21 files (1.4s, 4 threads)`。
- 测试：`Test Files 2 passed (2)`。
- 迁移：`SKIP pnpm db:migrate: drizzle/ does not exist yet, the schema unit owns migrations`。
- 启动：`GET / -> 200`、`GET /projects/does-not-exist -> 200`、`GET /api/ping -> 200`、`{"app":"sprout-mio","version":"0.1.0","probe":"http","runtime":"unimplemented"}`、`production process group stopped on SIGTERM`。
- Worker：`sprout-worker 0.1.0 protocol=unimplemented`。

两次运行都带两条 GitHub annotation。一条是 `actions/checkout@v4`、`actions/setup-node@v4`、`pnpm/action-setup@v4` 面向 Node 20 的弃用警告。另一条是 `ubuntu-latest` 将在 2026 年 10 月 19 日迁到 Ubuntu 26。两条都不影响本次结论，未处理。

## 干净安装与生产启动

`bash scripts/verify/b-tooling.sh` 覆盖本机验收。步骤是端口守卫、`rm -rf node_modules dist .output`、`pnpm install --frozen-lockfile`、`pnpm check`、`pnpm test`、`pnpm build`、后台 `pnpm start` 加三次轮询、`kill -TERM` 进程组并确认 10 秒内退出。每条都打印 PASS 或 FAIL 以及命令和输出摘要，日志写在 `.verify/b-tooling/`。脚本保留仓库 `data/`，生产服务显式使用 `.verify/b-tooling/verification.sqlite`。以下安装耗时与输出是原 unit 的历史证据。

实测两次干净安装的墙钟耗时是 17s 与 16s。pnpm 自报的安装时间是 9.1s 与 8.2s，其余是 `rm -rf node_modules`、pnpm 进程启动和缓存校验的开销。这个数字的限流因素是热 pnpm store 与 `better-sqlite3` 原生绑定的复用，样本数为 1 的两次测量，不是基准。所有实测结果如下。

- `PASS clean frozen installation` 退出 0。
- `PASS format lint and type gate` 退出 0，33 个文件格式正确，21 个文件无 lint 与类型错误。
- `PASS contract and tooling tests` 退出 0，2 个文件 10 个测试。
- `PASS Nitro production build` 退出 0，产物 `.output/server/index.mjs` 与 `.output/public/assets/`。
- `PASS GET / returned 200 (1530 bytes)`、`PASS GET /projects/does-not-exist returned 200 (1363 bytes)`、`PASS GET /api/ping returned 200 (79 bytes)`。
- `PASS HTTP probe payload {"app":"sprout-mio","version":"0.1.0","probe":"http","runtime":"unimplemented"}`。
- `PASS SIGTERM stopped the production process group within 10s`。
- 总入口 `bash scripts/verify.sh` 输出 `Verification scripts=2 failed=0`，退出 0。

## `vp test` 结论

`vp test` 可用，不需要改用直接调用 vitest。`pnpm test` 实际执行 `vp test run`，跑 Vitest 5，2 个测试文件 10 个测试通过，退出 0。`package.json` 的 `test` 脚本保持原样。

新增 `tests/tooling.test.ts`，断言三件事。`APP_VERSION` 与 `package.json` 的 `version` 一致，保证 Worker 与 extension 的 `--version` 输出不会漂移。`CONTRACT_VERSION` 是正整数。`APP_ERROR_CODES` 的每个码经 `toAppError` 后保留码值，`internal` 与未知码统一归为安全的 `内部错误` 文案，且传入的旧 `requestId` 被替换为当前值。

测试门禁非空有红绿证据。该文件第一版把 `internal` 码也期望保留原 message，`pnpm test` 退出 1，`TEST_EXIT=1`，Vitest 报 `expected { code: 'internal' }` 与 `message: '内部错误'` 不一致。改对期望值后退出 0。格式门禁同样，对 `.verify/` 下一个人为写坏的文件运行 `vp fmt --check`，退出 1。

## 范围取舍

brief 的 SCOPE 允许新增 `scripts/verify/clean-install.sh`，但没有任务要求它。干净安装的验收已经包含在 `b-tooling.sh` 里，再写一个脚本会在 `scripts/verify.sh` 里重复执行一次删除并重装，因此没有创建该文件。需要单独脚本时从 `b-tooling.sh` 拆出前 5 步即可。

## 未验证项

- COLD pnpm store 的安装耗时与成功率。本地与 Actions 都是热 store 或缓存命中。
- ubuntu 与 macOS 的行为差异。本机为 macOS arm64，CI 为 ubuntu x64。本机没有 `timeout` 命令，脚本用 Node 计时或后台加轮询。
- Actions 缓存行为。两次运行都命中缓存，未测未命中时的耗时与缓存失效后的表现。
- `pnpm db:migrate` 在 schema 落地后的真实迁移行为。当前只有跳过路径被验证。
- GitHub runner 的 `ubuntu-latest` 迁到 Ubuntu 26 后的表现，以及三个 action 的 Node 20 弃用警告。
- brief 提到的 `scripts/verify/clean-install.sh` 单独入口不存在，理由见范围取舍。
