# P0 A：技术栈版本组合结论

实验产物：`experiments/stack-app`（TanStack Start + Vite+ + Drizzle/SQLite + Better Auth + shadcn/Base UI + Effect 的最小可启动组合）。
验证脚本：`experiments/stack-app/scripts/verify.sh`（可重跑，退出码即结论）。

环境：macOS arm64，Node v26.11.1，pnpm 10.33.0，npm 11.20.0。
参考原 Sprout 仓库 `~/workspace/sprout` HEAD = `5b48a53b385ee8a4c0fff219954c6244506b0b9f`（仅作参考，未复制代码）。

## 版本表（已验证 = 下列命令真实跑通）

| 组件 | 包 | 版本 | 状态 |
| --- | --- | --- | --- |
| 元框架 | `@tanstack/react-start` | 1.169.2 | 已验证 |
| 路由 | `@tanstack/react-router` | 1.170.44 | 已验证 |
| 工具链 | `vite-plus`（`vp` CLI） | 1.3.0 | 已验证 |
| Vite（别名） | `vite` → `@voidzero-dev/vite-plus-core` | 1.3.0（内部 Vite 8.3.4） | 已验证 |
| React 插件 | `@vitejs/plugin-react` | 6.1.2 | 已验证 |
| ORM | `drizzle-orm` | 0.45.4 | 已验证 |
| 迁移 | `drizzle-kit` | 0.31.11 | 已验证 |
| SQLite 驱动 | `better-sqlite3` | 12.11.1 | 已验证 |
| 认证 | `better-auth` | 1.7.10 | 已验证（仅启动与 `/api/auth/ok`） |
| UI 基元 | `@base-ui/react` | 1.9.0 | 已验证 |
| UI 生成器 | `shadcn`（CLI） | 4.22.0 | 已验证 |
| 样式 | `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | 已验证 |
| 并发/资源 | `effect` | 4.0.5 | 已验证（同步 `Effect.gen` + `runPromise`） |
| React | `react` / `react-dom` | 19.3.1 | 已验证 |
| TypeScript | `typescript` | 6.0.3 | 已验证（`tsc --noEmit`） |

`@base-ui/react` 是 Base UI 现在的包名（旧名 `@base-ui-components/react` 停留在 `1.0.0-rc.0`）。shadcn 通过 `components.json` 的 `"style": "base-nova"` 选择 Base UI 变体，不再依赖 Radix。

## 证据

全部命令在 `experiments/stack-app` 下执行，输出为真实退出码。

1. 干净安装（先 `rm -rf node_modules dist dev.db .tanstack`）
   - `pnpm install --frozen-lockfile` → 退出码 0，`Done in 3.1s`。
   - 需要说明的是，`3.1s` 是**热 pnpm store**（`~/Library/pnpm/store/v11` 已缓存全部包）的数字，冷 store 未测。
   - `better-sqlite3` 原生绑定在同一次安装中构建完成（`build/Release/better_sqlite3.node` 存在）。
2. `pnpm typecheck`（`tsc --noEmit`）→ 退出码 0。
3. `pnpm build`（`vp build`）→ 退出码 0，客户端 169 模块、SSR 742 模块，产物 `dist/server/server.js` 与 `dist/client/assets/*`。
4. dev server：`pnpm exec vp dev --port 3111`，`localhost:3111`
   - `GET /` → 200（HTML）
   - `GET /api/health` → 200 `{"ok":true,"probes":1}`。该路由用 Effect 程序写一行 `stack_probes` 再计数，所以这个 200 同时证明 Effect 在 Start 的服务器运行时里真实执行，以及 Drizzle 真的落到 SQLite 文件。
   - `GET /api/auth/ok` → 200 `{"ok":true}`，证明 Better Auth 带 drizzle adapter 能正常启动。
5. 稳定性由三次连续运行确认。`bash scripts/verify.sh` 连续 3 次全绿；删 `node_modules` 重装后再跑全绿；移走 `.env.local` 后再跑全绿（即全新 clone 不需要任何本地 env 文件）。
6. 真正的全新 clone 也已验证。`git clone --branch p0/p0-a-stack` 到空目录后，`pnpm install --frozen-lockfile` 退出码 0（2.6s，同样是热 store），紧跟一次 `bash scripts/verify.sh` 全绿，证明本单元交付的分支本身自洽。
7. `pnpm exec vp lint`（Oxlint）→ 退出码 0，无告警。
8. `pnpm db:generate` / `pnpm db:migrate` → 生成并应用 `drizzle/0000_safe_rictor.sql`（`stack_probes`）与 `drizzle/0001_wealthy_rachel_grey.sql`（better-auth 生成的 `user`/`session`/`account`/`verification`），迁移后 `sqlite_master` 含 6 张表。

## 选择理由

- **Vite+ 驱动 TanStack Start 的构建与 dev 是成立的**，这是本单元最大的未知。做法是按 Vite+ 官方迁移规则落地：`package.json` 声明 `vite: "catalog:"`，`pnpm-workspace.yaml` 的 catalog 把 `vite` 指向 `npm:@voidzero-dev/vite-plus-core@1.3.0`，并用 `overrides.vite@*: catalog:` 与 `peerDependencyRules.allowAny.vite` 让 `@tanstack/react-start` 声明的 `vite: ">=8.0.0"` peer 得到满足（别名包的版本号是 `1.3.0`，语义版本比较本身不成立，必须靠 overrides/peer 规则）。
- **`vp migrate` 而不是手写工具链接线**：迁移把脚本 `vite` → `vp dev` / `vp build`、把 `vite.config.ts` 的 import 改成 `vite-plus` 并加 `lazyPlugins`、把 inline 插件包起来，这些是 Vite+ 的写法约定，手写容易漏。
- **shadcn 用 Base UI 变体而不是 Radix**：直接由架构方向 `shadcn + Base UI` 决定。`components.json` 写 `"style": "base-nova"`，组件里 import 的是 `@base-ui/react/button`。
- **Drizzle 用 `better-sqlite3` 同步驱动**：TanStack scaffolder 的 sqlite 预设就是它，同步 API 让 Effect 里的 `Effect.sync` 包装是直白的。驱动与迁移方式在 `docs/architecture-direction.md` 中被列为待定的 P0 项，本单元把它收敛为 `better-sqlite3 + drizzle-kit generate/migrate`。
- **Effect 只做最小闭环**：一个 `Effect.gen` 里 `Effect.sync` 写库 + 读计数，由 server route 用 `Effect.runPromise` 跑。目的只是证明 Effect 4 能被 Vite+ 打进 SSR bundle 并在真实服务器运行时执行，不引入任何业务语义。

## 失败过的尝试

1. **`vp migrate --no-interactive` 的安装步骤失败**。`pnpm dlx --package=vite-plus@1.3.0 vp migrate` 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`：`baseline-browser-mapping@2.11.29`、`electron-to-chromium@1.5.458`、`set-cookie-parser@3.1.4` 超出本机的 `minimumReleaseAge` 窗口，而迁移已经把它们写进了 `minimumReleaseAgeExclude`，vp 自带的 pnpm（报告为 12.14.0）仍然拒绝。随后用系统 `pnpm@10.33.0` 直接 `pnpm install` 成功。副作用是这次失败的安装把 `better-sqlite3` 留在未构建状态。
2. **`shadcn init` 在本环境不可用**，两个独立问题：
   - 只要进程环境里有 `http_proxy` / `https_proxy` / `ALL_PROXY`，它就稳定报 `Request to https://ui.shadcn.com/init?... failed, reason: other side closed`（同一个 URL 用 `curl` 和 Node 原生 `fetch` 都返回 200）。清空这些变量后网络正常。
   - `-y` 并不能跳过全部交互：`shadcn init -b base -p nova -y` 仍会问 "Would you like to use TypeScript"。无 tty 时 `prompts` 在第一个问题就 EOF 退出；用 expect 分配 pty 后卡在 `Preflight checks.`（仅在 `ALL_PROXY` 被清空时发生）；`yes |` 直接 SIGABRT。
   - 绕过方式如下。先用 `curl` 取 registry 自己返回的 preset（`/init?base=base&style=nova&...`，`type: registry:base`），据此手写 `components.json`，再用 `shadcn add "<那个 init URL>" -y` 让 CLI 真正执行 base 的依赖安装与 `styles.css` 注入。`shadcn add button -y` 同样跑通。也就是说组件与应用是由真实 CLI 从真实 registry 生成的，只有 `components.json` 那一个文件是手工写入。
3. **`pnpm typecheck` 在 scaffolder 自带的文件上就红了**：`src/routes/api/auth/$.ts` 与我的 `health.ts` 都报 `'server' does not exist in type ...`。原因是 `server` 路由选项的类型来自 `@tanstack/start-client-core` 对 `@tanstack/router-core` 的模块增强，而 scaffold 里没有任何文件 import `@tanstack/react-start`，该增强不在 TS program 内。修法是在 `tsconfig.json` 的 `compilerOptions.types` 里加 `"@tanstack/react-start"`。scaffold 原本没有 `typecheck` 脚本，所以这个洞一直没暴露。
4. **`scripts/verify.sh` 一开始给出假阴性**：`pnpm exec vp dev` 的 vite 子进程不会随 `pnpm` 一起被 kill，于是每次验证都在 3111 端口留下一个孤儿 dev server；下一轮的 ready 检查被旧进程应答，`/api/health` 打到持着已删除 `dev.db` inode 的旧进程上，稳定返回 500。修复是 `set -m` + 按进程组 `kill -- -$PID`，加上启动前的端口占用守卫。这条是"验证失败要先怀疑观测方法"的实例。
5. **`vp check` 不是绿的**：Oxlint 部分通过（`vp lint` 退出码 0），但 Oxfmt 报 24 个文件有格式差异，包含 scaffolder 自带文件（`README.md`、`.cta.json`、`pnpm-workspace.yaml`、`vite.config.ts`、`src/routeTree.gen.ts`）和生成文件（`drizzle/meta/*.json`、`src/db/auth-schema.ts`）。没有跑 `vp check --fix`，因为那会把这 24 个文件的重格式化噪声混进本单元的 diff；本单元的结论因此只覆盖 lint 与类型检查，不覆盖格式化门禁。

## 未验证项

- 冷 pnpm store 的安装耗时与成功率（只验证了热 store 的 3.1s）。
- Effect 的长期运行能力：`Scope`、fiber、`Queue`、重试、并发、取消一律未测；只验证了同步 `Effect.gen` + `runPromise` 在 SSR 运行时执行。
- Better Auth 的登录、注册、session、cookie 流程一律未测（本单元 FORBIDDEN），只验证了进程启动与 `/api/auth/ok`。
- SQLite 的事务、并发写约束、备份恢复未测（架构方向里这是独立的 P0 选型实验）。
- `vp test`（Vitest 5）/ `vp pack` / `vp run` / `vite:monorepo` 模板未跑。
- 生产进程（`node dist/server/server.js` 或 `vp preview`）未启动验证；只验证了构建产物存在。
- `pnpm install` 的包来源是 `~/.npmrc` 配置的 `registry.npmmirror.com` 镜像，不是 registry.npmjs.org。版本解析结果依赖该镜像，换源后 lockfile 中的版本可能不同。

## 与 `docs/architecture-direction.md` 的关系

未发现冲突。需要补充/收窄两点：

1. 该文档把「SQLite driver 与迁移方式」列为待定的 P0 项。本单元已把它收敛为 `better-sqlite3@12.11.1` + `drizzle-kit generate/migrate`，并以真实迁移与运行证据支持；建议把该行更新为已选定。
2. 该文档给 Vite+ 的职责写了「开发、构建、检查、测试」。实测「构建」与「lint」成立，「测试」（Vitest）未跑，而「检查」里的格式化门禁（Oxfmt）在 scaffold 默认产物上直接失败，需要先决定是接受 Oxfmt 的格式还是把生成目录排除。这是**需更新或补注架构说明**的一点。
