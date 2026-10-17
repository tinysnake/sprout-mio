# 应用骨架参考

本文保留骨架建立时的目录与验收记录。数据库与认证的最终状态见 [data-auth.md](data-auth.md#验证证据)，runtime 的最终状态见 [runtime.md](runtime.md#验证命令与证据)，Project 页面见 [feature-sample.md](feature-sample.md#真实命令与输出摘要)。下文的历史测试数量与探针 `unimplemented` 值只代表当时的验收，当前后台就绪状态以 `/api/health` 为准。

## 目录职责

仓库采用单 package。下表列出应用入口及其归属。

| 路径                              | 职责                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/routes/`                     | TanStack 文件路由。`__root.tsx` 提供 HTML shell 和主题，`index.tsx` 显示应用名与版本。                 |
| `src/start.tsx`                   | 运行期 `defaultSsr: false` 与 `/api/ping` 请求探针。探针只表示 HTTP 能响应，不表示后台 runtime ready。 |
| `src/router.tsx`                  | 创建客户端 router，导入生成的 route tree。                                                             |
| `src/routeTree.gen.ts`            | TanStack 生成物，禁止手改。                                                                            |
| `src/components/ui/`              | 从 P0 复用的 Base UI Button 与 Dialog。                                                                |
| `src/styles.css`、`src/theme.css` | Tailwind、Geist 与 shadcn base-nova 主题变量。                                                         |
| `src/contracts/`                  | ID、AppResult、Project 输入、诊断事件与版本。浏览器和独立入口共用，无数据库依赖。                      |
| `src/lib/config.ts`               | 环境边界的 Zod 校验与 frozen config，不打开数据库。                                                    |
| `src/lib/utils.ts`                | 统一导出 `cn`。                                                                                        |
| `src/db/`                         | 数据库代码归属目录。当前只有 `.gitkeep`，没有 schema 或连接。                                          |
| `src/worker/`                     | Worker CLI 入口。连接、心跳和握手尚未实现。                                                            |
| `src/extension/`                  | Pi 函数式 extension、状态工具、状态命令与实际使用的 API 子集。                                         |
| `tests/`                          | 公共契约与配置边界测试。                                                                               |
| `scripts/verify/`                 | 可重跑验收脚本，按文件名顺序由 `scripts/verify.sh` 调用。                                              |
| `.verify/`                        | 本地验证日志与 Pi session，不提交。                                                                    |
| `data/`                           | SQLite 文件位置，不提交。                                                                              |
| `drizzle/`                        | 迁移产物位置，当前未创建。                                                                             |

目录证据由 `git ls-files src scripts tests docs/p1` 重建。生成物证据由 `pnpm build`、`pnpm worker:build` 与 `pnpm extension:build` 重建。

## 依赖与配置来源

版本及配置来源是 [P0 结论](../p0/summary.md)、[技术栈验证](../p0/stack-versions.md) 与 [SPA 验证](../p0/spa-auth-db.md)。根 `package.json`、catalog、peer 规则、锁文件与 TypeScript 配置以 `experiments/stack-app/` 为基线。SPA、Nitro、主题和组件来自 `experiments/spa-auth-db/`。

`pnpm install --frozen-lockfile` 使用根锁文件。实际版本包括 Start `1.169.2`、Router `1.170.44`、Vite+ `1.3.0`、React `19.3.1`、Effect `4.0.5`、Better Auth `1.7.10`、better-sqlite3 `12.11.1`、Drizzle ORM `0.45.4`、drizzle-kit `0.31.11`、TypeScript `6.0.3`。新增的直接依赖包括 Nitro `3.0.260610-beta`、Zod `4.6.7`、Vitest `5.0.5` 与 Playwright `1.63.0`。Nitro 和 Playwright 沿用 SPA 实验版本，Zod 和 Vitest 沿用 stack-app 锁文件中的版本。

`vite` 通过 catalog 指向 `npm:@voidzero-dev/vite-plus-core@1.3.0`。`pnpm-workspace.yaml` 的 overrides、`peerDependencyRules.allowAny` 和 `allowedVersions` 保留 P0 写法。单 package 不创建 `packages/`。

## 运行入口

开发命令是 `pnpm dev`，默认端口为 `3000`。临时端口使用 `pnpm dev --port 3112 --strictPort`。生产进程使用 `PORT`，与 `config.PORT` 默认值一致。`APP_ORIGIN` 必须填写相同的 HTTP origin。

生产构建命令是 `pnpm build`。实际入口为 `.output/server/index.mjs`，静态资源位于 `.output/public/assets/`，SPA shell 位于 `.output/public/_shell.html`。

生产启动命令是 `pnpm start`。自 p1-c-data-auth 接入认证、p1-d-runtime 接入启动边界后，必须提供有效 `BETTER_AUTH_SECRET`。共享 config 解析仍允许缺省，但生产入口在监听前强制要求至少 32 字符且不是示例占位值。构建的 prerender 跳过 runtime，不要求部署 secret。启动失败与构建证据见 [runtime.md](runtime.md#验证命令与证据)。对应的 Node 命令如下。

```sh
node --env-file-if-exists=.env.local .output/server/index.mjs
```

Node 默认不读取 `.env.local`，脚本显式指定该文件。环境变量中已存在的值优先于 env file。`vite.config.ts` 中的 `spa.enabled` 生成 shell。`src/start.tsx` 中的 `createStart(() => ({ defaultSsr: false }))` 关闭运行期 SSR。两个设置必须同时存在。未知页面的 GET 在请求边界将 HTML shell 的 404 转为 200，`/api` 与 server function 不做该转换。P0 的已知路由深链验证没有覆盖未知 URL，这个差异通过验收中的 `/projects/does-not-exist` 复现。

`GET /api/ping` 返回 JSON，其 `probe` 为 `http`，`runtime` 为 `unimplemented`。该探针不能用于判断后台服务或数据库就绪。

Worker 构建命令是 `pnpm worker:build`。`vp pack` 的 `worker` 配置读取 `tsconfig.worker.json`，将入口及版本常量打包为 `dist/worker/main.js`。`pnpm worker:start` 无参数运行只显示未实现说明并退出。

```sh
node dist/worker/main.js --version
node dist/worker/main.js --help
```

Pi extension 构建命令是 `pnpm extension:build`，产物为 `dist/extension/main.js`。注册的工具是 `sprout_status`，命令是 `/sprout-status`。两个入口返回同一版本与边界状态。`src/extension/types.ts` 是 Pi `1.3.0` 实际使用的结构化子集，升级 Pi 时按该版本的 `ToolDefinition`、`registerCommand` 与 `ui.notify` 重新复核，不依赖托管安装的绝对路径类型。

骨架建立时尚未接入数据库 schema、auth 与后台 runtime。数据库与认证已由 p1-c-data-auth 接入，启动前校验、迁移与 runtime 已由 p1-d-runtime 接入，原先 auth 未接入时可省略 secret 的条件已不适用于生产启动。`db:generate`、`db:migrate` 与 `setup` 现有真实迁移证据见 [data-auth.md](data-auth.md#连接与迁移入口)。Worker 连接与 Pi 会话仍未实现，分别属于 P4 与 P3。

## 验证命令与证据

`bash scripts/verify.sh` 按名字顺序执行各脚本，任一失败返回非零。`bash scripts/verify/a-base.sh` 单独重放本骨架的检查。脚本会删除当前 worktree 的 `node_modules`、`dist`、`.output` 和 `data`，只在可重建的验收 worktree 中运行。数据库验收必须使用独立数据目录。

每条安装、检查、构建和 Pi 调用最多运行 300 秒。脚本在启动生产与 dev 服务前检查端口，拒绝访问其他进程。检查结束后杀掉服务进程组。localhost 请求固定使用 `curl --noproxy '*'`。

可选变量包括 `SPROUT_VERIFY_PROD_PORT`、`SPROUT_VERIFY_DEV_PORT`、`PI_BIN` 与 `SPROUT_VERIFY_PI_MODEL`。默认端口为 `3111` 和 `3112`。Pi 默认入口为 `/Users/snake/.pi/agent/bin/pi`，使用宿主配置和认证。模型必须支持 tool calling。

| 结论                                          | 运行命令                                                                                                                                                                                                                                                                                                                | 输出摘要与证据                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已验证，三个源码入口通过类型检查。            | `pnpm typecheck`                                                                                                                                                                                                                                                                                                        | `tsc --noEmit` 与两份独立 tsconfig 均退出 0。                                                                                                                                                   |
| 已验证，生产构建生成 Nitro 与 client assets。 | `pnpm build`                                                                                                                                                                                                                                                                                                            | 退出 0，生成 `.output/server/index.mjs` 与 `.output/public/assets/`。                                                                                                                           |
| 已验证，Worker 正确公开未实现边界。           | `pnpm worker:build`，`node dist/worker/main.js --version`，`node dist/worker/main.js`                                                                                                                                                                                                                                   | 退出 0。版本输出为 `sprout-worker 0.1.0 protocol=unimplemented`。无参数输出含 `连接协议在 P4 实现，当前无连接能力`。                                                                            |
| 已验证，真实 Pi 实际调用编译后的工具。        | `/Users/snake/.pi/agent/bin/pi --no-extensions --no-skills --no-prompt-templates --no-themes -e dist/extension/main.js --tools sprout_status --mode json --session-dir .verify/a-base/pi-sessions -p 'Call sprout_status exactly once with empty arguments. Then report the returned payload. Do not use other tools.'` | `tool_execution_end` 中 `isError` 为 false，载荷包含 `app: sprout-mio`、`version: 0.1.0`、`contractVersion: 1`，两个连接状态均为 `unimplemented`。                                              |
| 已验证，契约与环境校验通过。                  | `pnpm test`                                                                                                                                                                                                                                                                                                             | 1 个测试文件、7 个测试通过，退出 0。测试配置不加载 Start 与 Nitro 插件。                                                                                                                        |
| 已验证，完整干净安装与 HTTP 验收重放。        | `bash scripts/verify.sh`，`bash scripts/verify/a-base.sh`                                                                                                                                                                                                                                                               | 两次均退出 0。总入口输出 `Verification scripts=1 failed=0`，单独脚本输出 `PASS a-base all checks passed`。首页、未知深链、探针返回 200，未知 API 返回 404，dev 响应成功，进程组退出后端口释放。 |

构建输出包含上游依赖的 `use client` 打包提示。命令退出 0，未更改依赖版本或屏蔽提示。
