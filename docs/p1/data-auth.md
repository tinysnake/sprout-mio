# 数据与 Human 认证参考

## 状态与范围

持久层、真实 HTTP 认证和浏览器登录流程已验证。生产入口的启动前配置校验归属 `p1-d-runtime`。Nitro 在收到请求后才加载应用模块，直接启动 `.output/server/index.mjs` 不会立即执行 `config` 或 auth 的校验。

认证边界已拒绝缺失 secret、短 secret 和旧示例占位值。验收脚本单独以坏配置导入 auth，断言进程非零退出且打印可读错误。生产入口只记录真实退出码与信号，打印带 owner 的 GAP，不再作为 c 的失败门禁。d 负责验证 `pnpm start` 在非法配置下非零退出。

## 表与索引

`src/db/schema.ts` 汇总导出全部七张表。下表使用真实 SQL 列名。Drizzle 属性使用 camelCase，例如 `createdBy` 对应 `created_by`。

| 表                 | 列与约束                                                                                                                                                                                                                                                                                                                                                                                                                                           | 显式索引                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `project`          | `id text PRIMARY KEY NOT NULL`，`name text NOT NULL`，`description text NULL`，`created_by text NOT NULL REFERENCES user(id)`，`created_at integer NOT NULL DEFAULT (unixepoch())`，`updated_at integer NOT NULL DEFAULT (unixepoch())`。                                                                                                                                                                                                          | 无。                                                                                                                                       |
| `diagnostic_event` | `id text PRIMARY KEY NOT NULL`，`at integer NOT NULL`，`level text NOT NULL`，`event text NOT NULL`，`request_id text NOT NULL`，`project_id text NULL REFERENCES project(id)`，`conversation_id text NULL`，`instance_id text NULL`，`run_id text NULL`，`execution_id text NULL`，`message text NOT NULL`，`data text NULL`。CHECK `level IN ('debug','info','warn','error')`。                                                                  | `diagnostic_event_at_idx(at)`，`diagnostic_event_request_id_idx(request_id)`，`diagnostic_event_project_id_idx(project_id)`，均非 UNIQUE。 |
| `runtime_boot`     | `id text PRIMARY KEY NOT NULL`，`started_at integer NOT NULL`，`stopped_at integer NULL`，`phase text NOT NULL`，`pid integer NOT NULL`，`app_version text NOT NULL`。CHECK `phase IN ('starting','ready','stopping','stopped','interrupted')`。                                                                                                                                                                                                   | 无。                                                                                                                                       |
| `user`             | `id text PRIMARY KEY NOT NULL`，`name text NOT NULL`，`email text NOT NULL`，`email_verified integer NOT NULL DEFAULT false`，`image text NULL`，`created_at integer NOT NULL`，`updated_at integer NOT NULL`。两个时间列默认使用当前 Unix 毫秒。                                                                                                                                                                                                  | UNIQUE `user_email_unique(email)`。                                                                                                        |
| `session`          | `id text PRIMARY KEY NOT NULL`，`expires_at integer NOT NULL`，`token text NOT NULL`，`created_at integer NOT NULL DEFAULT 当前 Unix 毫秒`，`updated_at integer NOT NULL`，`ip_address text NULL`，`user_agent text NULL`，`user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE`。                                                                                                                                                         | UNIQUE `session_token_unique(token)`，非 UNIQUE `session_userId_idx(user_id)`。                                                            |
| `account`          | `id text PRIMARY KEY NOT NULL`，`account_id text NOT NULL`，`provider_id text NOT NULL`，`user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE`，`access_token text NULL`，`refresh_token text NULL`，`id_token text NULL`，`access_token_expires_at integer NULL`，`refresh_token_expires_at integer NULL`，`scope text NULL`，`password text NULL`，`created_at integer NOT NULL DEFAULT 当前 Unix 毫秒`，`updated_at integer NOT NULL`。 | 非 UNIQUE `account_userId_idx(user_id)`。                                                                                                  |
| `verification`     | `id text PRIMARY KEY NOT NULL`，`identifier text NOT NULL`，`value text NOT NULL`，`expires_at integer NOT NULL`，`created_at integer NOT NULL DEFAULT 当前 Unix 毫秒`，`updated_at integer NOT NULL DEFAULT 当前 Unix 毫秒`。                                                                                                                                                                                                                     | 非 UNIQUE `verification_identifier_idx(identifier)`。                                                                                      |

SQLite 另建 PRIMARY KEY autoindex 与迁移账本 `__drizzle_migrations(id, hash, created_at)`。上述八个显式索引由验收脚本逐项核对。

业务表时间列存 Unix 秒。Drizzle 的 `mode: 'timestamp'` 接收和返回 `Date`。调用者写入 `new Date()`，跨契约边界使用 `.toISOString()`。`project.updatedAt` 没有自动更新触发器，更新业务记录时需显式写入新时间。

auth 表来自 `experiments/spa-auth-db/src/db/auth-schema.ts`，保留生成物的 `timestamp_ms`，不得换成秒。`user` 的 `email_verified` 映射 boolean。Better Auth 负责账号和会话 ID，业务 ID 使用已有的 `prj_`、`diag_` 和 `boot_` 前缀。

`conversation_id`、`instance_id`、`run_id`、`execution_id` 只保存 ID，分别为 P2、P3、P4 的实际关联预留。它们没有外键，也没有对应空表。无真实关联时使用 NULL。`data` 是 JSON 字符串，调用者负责 `JSON.stringify` 与读取时的解析。

## 连接与迁移入口

| 入口                   | 签名与职责                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/index.ts`      | 导出 `db` 和 `sqlite`。`db` 是带完整 schema 的 Drizzle 实例，`sqlite` 是同一连接的 better-sqlite3 实例。按数据库绝对路径缓存在 `globalThis`，模块重新求值复用连接。普通调用者不关闭共享连接。                                     |
| `src/db/connection.ts` | `openDatabase(databaseUrl: string): DatabaseConnection`。返回 `{ sqlite, db }`，每次建立独立连接，创建父目录，显式启用 `foreign_keys = ON` 与 `journal_mode = WAL`。调用者负责 `sqlite.close()`。初始化失败会关闭连接并抛出原因。 |
| `src/db/index.ts`      | 同时重导出 `openDatabase` 与 `DatabaseConnection`，方便已有 server function 复用。只想开独立连接且不初始化进程单例时直接导入 `connection.ts`。                                                                                    |
| `src/db/migrate.ts`    | `migrateDatabase(databaseUrl = config.DATABASE_URL, migrationsFolder = 'drizzle'): void`。同步应用 Drizzle 迁移，成功返回，失败抛出，始终关闭自己的迁移连接。相对目录基于进程 cwd。                                               |
| CLI                    | `node --import tsx src/db/migrate.ts`。成功输出 `数据库迁移完成`，迁移失败输出 `数据库迁移失败` 并设置退出码 1。配置解析错误也退出非零并打印字段与约束。该 CLI 默认只读进程环境，需要 env file 时加 Node 的 `--env-file`。        |

连接不会自动迁移。d 应在进程启动边界调用 `migrateDatabase()`，之后才启动需要表结构的工作。独立迁移连接与应用单例连接使用同一个数据库路径。生产资源关闭由进程入口拥有。

初始 SQL 是 `drizzle/0000_pale_famine.sql`。它由 `pnpm db:generate` 生成。再次生成显示 `7 tables` 和 `No schema changes, nothing to migrate`。空库初始化与第二次迁移均已运行，迁移账本保持一条记录。

`pnpm db:migrate` 沿用 a 的 `drizzle-kit migrate` 脚本。`drizzle.config.ts` 显式读取 `.env.local` 与 `.env`，按解析后的 `DATABASE_URL` 递归创建数据库父目录，再交给 drizzle-kit 打开文件；`:memory:` 不创建目录。默认路径仍为 `./data/sprout.sqlite`，不依赖 `pnpm setup` 先运行。程序化入口使用 Drizzle ORM migrator。两者消费同一 `drizzle/` 和迁移账本，验收已验证先用 CLI 迁移、再用程序化入口重复执行成功。

SQLite 查询构造器约束错误的驱动码在 `error.code`，Drizzle `.run(sql)` 包装错误的驱动码在 `error.cause.code`。本实现的外键行为测试使用真实连接，不以 mock 替代 SQLite。

## 干净目录验证

已在当前 worktree 复现 CI 的失败。修复前运行 `rm -rf data .verify data/sprout.sqlite`，随后执行 `pnpm db:migrate`，退出 1，错误为 `Cannot open database because the directory does not exist`。根因是 drizzle-kit 的连接没有经过 `src/db/connection.ts`，已有连接工厂的目录创建逻辑未覆盖这个 CLI。

应用父目录创建补丁后，实际运行以下命令。

```sh
rm -rf data
pnpm db:migrate
```

命令退出 0，输出 `migrations applied successfully!`。随后以只读 SQLite 连接检查，`data/sprout.sqlite` 已存在，包含 `project`、`diagnostic_event`、`runtime_boot`、`user`、`session`、`account`、`verification` 和迁移账本。没有先运行 `pnpm setup`。输出日志为 `.verify/c-data-auth/clean-migrate.log`。

再次删除 `data/` 后，实际执行 `pnpm start`。验证进程注入运行时生成的随机 `BETTER_AUTH_SECRET`，其余环境覆盖与请求命令如下。

```sh
rm -rf data
PORT=3114 NITRO_PORT=3114 APP_ORIGIN=http://localhost:3114 \
	DATABASE_URL=./data/sprout.sqlite pnpm start
curl --noproxy '*' -fsS http://localhost:3114/api/auth/get-session
```

生产进程成功监听 3114，auth endpoint 返回 HTTP 200、`null`。请求后检查确认 `data/sprout.sqlite` 已创建，日志不含 `directory does not exist`。进程经 SIGTERM 清理后退出 0。日志为 `.verify/c-data-auth/clean-start.log`。

该启动检查证明连接工厂能处理缺少父目录。它不代表启动入口完成迁移；启动前迁移与配置校验接线仍归属 `p1-d-runtime`。

## 配置与首次运行

全部环境变量列在 `.env.example`。默认值如下。

| 字段                 | 默认值与校验                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | `./data/sprout.sqlite`，非空 SQLite 文件路径。                                                                                       |
| `APP_ORIGIN`         | `http://localhost:3000`，完整 http 或 https origin，不含路径或尾斜杠。auth 的 `baseURL` 和 trusted origin 显式使用它。               |
| `BETTER_AUTH_SECRET` | 无默认值。共享配置允许缺省，提供时至少 32 字符。auth 边界要求存在，并拒绝旧开发示例占位值。用 `openssl rand -base64 32` 生成随机值。 |
| `PORT`               | `3000`，1 到 65535 的整数。必须与访问 origin 的端口一致。                                                                            |
| `NODE_ENV`           | `development`，允许 `development`、`test`、`production`。                                                                            |
| `LOG_LEVEL`          | `info`，允许 `debug`、`info`、`warn`、`error`。                                                                                      |

首次运行的操作顺序如下。

1. 运行 `pnpm install --frozen-lockfile`。
2. 将 `.env.example` 复制为 `.env.local`，填写随机 `BETTER_AUTH_SECRET`。
3. 运行 `pnpm setup`。该命令创建 `data/` 并应用迁移。
4. 运行 `pnpm build`，然后运行 `pnpm start`。开发使用 `pnpm dev`。
5. 打开 `http://localhost:3000/login`，选择注册并创建第一个 Human。

注册不会创建 Project，也不会写入演示业务数据。验收库中两个 Human 注册后，`project` 行数仍为 0。

Node 生产入口默认不读 `.env.local`。a 提供的 `pnpm start` 已显式执行 `node --env-file-if-exists=.env.local .output/server/index.mjs`。指定其他文件的命令是 `node --env-file=/absolute/path/to/env .output/server/index.mjs`。已有 shell 环境变量优先于 env file。

## 认证与会话接口

`src/lib/auth.ts` 用 Better Auth、SQLite Drizzle adapter 和 `tanstackStartCookies()`。email 和 password 登录已启用。secret 和 base URL 在 dev 与 production 都显式传入。没有邮箱验证、密码重置、组织、角色或邀请功能。

`GET` 和 `POST /api/auth/$` 直接交给 Better Auth handler。非浏览器 POST 必须带与 `APP_ORIGIN` 一致的 `Origin`。原生 Better Auth endpoint 返回自己的协议，调用方不得把它误认为 AppResult。`src/lib/auth-client.ts` 导出标准同源 `authClient`，供需要 Better Auth 原生客户端的调用者使用。

页面使用 `authenticate` server function，注册、登录、登出都经过真实 HTTP。它要求请求 Origin 等于 `config.APP_ORIGIN`，缺失时返回 `forbidden`，被拒登出不会清除已有 session。`AuthInput` 是按 `action` 区分的联合类型，包含 register、login 和 logout。email、密码长度和注册姓名在 server function 边界校验。Zod 校验在 handler 内转换，返回 `validation_failed`，不会抛出原始异常到 UI。Better Auth 的已知错误映射为封闭 AppErrorCode，未知错误统一转换为安全的 `internal`。页面显示安全消息、code 与 requestId。

`src/server/session.ts` 导出以下接口。

```ts
export type SessionInfo = {
	userId: string;
	email: string;
	name: string;
	expiresAt: string;
};

readSession(headers: Headers): Promise<SessionInfo | null>;
requireSession(headers: Headers, requestId: string): Promise<AppResult<SessionInfo>>;
getSessionInfo(): Promise<AppResult<SessionInfo | null>>;
getProtectedSession(): Promise<AppResult<SessionInfo>>;
authenticate({ data: input }): Promise<AppResult<{ userId: string } | null>>;
```

`readSession` 受 `createServerOnlyFn` 保护，只能在服务端调用。它从实际请求 headers 读取 session，匿名时返回 null。`expiresAt` 是 ISO 字符串，不返回 cookie、token、password 或原始数据库对象。后续 server function 传入 `getRequestHeaders()`，API route 传入 `request.headers`。

`requireSession` 接受调用者已有的 requestId。匿名时返回 `fail({ code: 'unauthorized', message: '请先登录', requestId })`，不会通过 HTTP 状态推断授权。它允许认证基础设施异常抛给调用者，调用者应在自己的边界用 `toAppError` 转换。

`getSessionInfo`、`getProtectedSession` 和 `authenticate` 是可调用的 Start server function。它们生成 `req_` UUID 并返回 AppResult。d 可以直接使用 `readSession` 或 `requireSession`，无需从 HTTP 再调这些 function。

首页的 `beforeLoad` 调用 `getProtectedSession`。未登录时客户端跳转 `/login`。本应用保持 SPA，HTTP GET `/` 返回 shell 200，实际保护由导航检查与服务端授权共同完成。每个后续业务 server function 都必须单独要求 session，不能依赖页面跳转作为授权。

首页与登录页的 `beforeLoad` 仅在客户端执行。auth API handler 在收到请求后才导入 auth，避免静态路由导入在 shell 预渲染时要求运行期 secret。已运行 `env -u BETTER_AUTH_SECRET pnpm build` 并检查 `.output/public/_shell.html`，输出 `Prerendered 1 pages`。对照日志分别为 `.verify/c-data-auth/build-without-secret-before.log` 和 `build-without-secret-after.log`。

Better Auth 默认密码长度限制之外的密码强度策略尚未设计。表单当前校验 8 到 128 字符。密码始终由 Better Auth 处理，不自行实现哈希。

## 验证证据

验收入口是 `bash scripts/verify/c-data-auth.sh`。总入口 `bash scripts/verify.sh` 已按 glob 包含它，无需修改总脚本。验收只删除 `.verify/c-data-auth/auth.sqlite` 与其 WAL、SHM，不删除用户数据库。默认端口为 3113，可用 `SPROUT_VERIFY_AUTH_PORT` 覆盖。curl 使用 `--noproxy '*'`。脚本为每个子命令设置超时，并关闭自己启动的进程。

| 结论                                                          | 运行命令                                                                                                                    | 输出摘要与产物                                                                                                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已验证，迁移可从零重放且可重复执行。                          | `pnpm db:generate`，指定验收库后 `pnpm setup`，`pnpm db:migrate`，`node --import tsx src/db/migrate.ts`。                   | SQL 为 `0000_pale_famine.sql`。七张表、八个显式索引正确，账本一条。日志位于 `.verify/c-data-auth/generate.log`、`setup.log`、`migrate-again.log`、`migrate-entry.log`、`schema.log`。                 |
| 已验证，真实 HTTP 注册与 cookie session。                     | `bash scripts/verify/c-data-auth.sh`。                                                                                      | `PASS curl signup with Origin`，`PASS session cookie readable`。请求与响应证据为 `signup.*`、`session.*`。cookie jar 与这些响应包含凭据，仅留在忽略的 `.verify/`，不提交。                            |
| 已验证，受保护 function 的成功和失败载荷。                    | 同上。                                                                                                                      | 带 cookie 返回 HTTP 200、`ok:true`、ISO `expiresAt`。登出后同一调用返回 HTTP 200、`ok:false`、`unauthorized`。证据为 `protected-authenticated.*`、`protected-after-signout.*`。                       |
| 已验证，无 Origin 的 POST 被拒。                              | 同上。                                                                                                                      | HTTP 403，载荷 `{"message":"Missing or null Origin","code":"MISSING_OR_NULL_ORIGIN"}`。证据为 `no-origin.*`。                                                                                         |
| 已验证，非法输入返回统一错误。                                | 同上。                                                                                                                      | HTTP 200、`validation_failed`，不回显密码。证据为 `invalid-input.*`。                                                                                                                                 |
| 已验证，Chromium 的注册、受保护页面刷新、登出跳转与密码登录。 | 同上。                                                                                                                      | `PASS Chromium register and protected reload` 与 `PASS Chromium logout, redirect, safe error and password login`，无 pageerror。截图为 `.verify/c-data-auth/authenticated.png` 与 `login-error.png`。 |
| 已验证，注册不造 Project。                                    | 同上。                                                                                                                      | `users=2 projects=0`，证据为 `no-project.log`。                                                                                                                                                       |
| 已验证，单元与集成行为测试。                                  | `pnpm test`。                                                                                                               | 两个测试文件、13 个测试通过。新增测试覆盖空库迁移、重复迁移保留数据、每连接外键与 WAL、debug CHECK、非法 phase、匿名 session、非法 config 和缺失 secret 的 auth 边界。                                |
| 已验证，源码检查与构建。                                      | `pnpm typecheck`，`pnpm check`，`pnpm build`。                                                                              | 三个入口类型检查通过，格式、lint 与类型门禁退出 0，生产入口及 client assets 生成。                                                                                                                    |
| 已验证，auth 导入拒绝坏配置。                                 | 验收脚本以非法 PORT 和缺失 secret 分别执行 `node --import tsx --input-type=module -e 'await import("./src/lib/auth.ts")'`。 | 要求自行非零退出，并打印 `环境变量校验失败` 及 `PORT` 或 `BETTER_AUTH_SECRET`。日志为 `bad-port-auth-import.log` 和 `missing-secret-auth-import.log`。                                                |
| GAP，生产入口启动校验归属 p1-d-runtime。                      | 验收脚本直接启动 `node .output/server/index.mjs`，分别传入非法 PORT 与缺失 secret。                                         | 记录 exit 与 signal，不断言生产入口必须拒绝。观测日志为 `bad-port.log` 和 `missing-secret.log`。                                                                                                      |

本次修订运行 `bash scripts/verify/c-data-auth.sh`，退出 0，输出 `PASS c-data-auth all checks passed`。迁移、HTTP 和 Chromium 检查全部 PASS。两个 auth 独立导入检查均自行退出 1、signal 为 null，分别打印含 `PORT` 和 `BETTER_AUTH_SECRET` 的可读校验错误。两个生产入口观测均为 exit=null、signal=SIGKILL，各打印一条 owner 为 `p1-d-runtime` 的 GAP。完整输出在 `.verify/c-data-auth/verify.log`。

此前总验收运行 `bash scripts/verify.sh`，退出 1，输出 `Verification scripts=2 failed=1`，原因是当时仍将生产入口校验归为 c 的失败门禁。本次未重跑总验收。模拟 CI 时已按要求清理 `.verify/`，早期总验收与 a-base 日志不再保留；本次证据见 `clean-migrate.log`、`clean-start.log` 和 `verify.log`。

脚本固定 `NITRO_PORT` 以隔离验收端口。应用仍应在启动边界拒绝无效的 `config.PORT`。监听成功不能代替配置校验。

## 给 d 的接入限制

d 的 `src/server/server-entry.ts` 应在主线程监听 HTTP 之前读取 `config`，调用 `requireAuthSecret(config)`，再迁移和启动 runtime。`requireAuthSecret(settings: { BETTER_AUTH_SECRET?: string }): string` 从 `src/lib/auth.ts` 导出。该模块同时构造 auth 和导入 db，因此会打开应用连接，生产入口需考虑启动顺序。

coordinator 已将生产入口的启动前配置校验归属 `p1-d-runtime`，并要求 d 在 `pnpm start` 入口完成接线与验收。c 不修改 `package.json`、`vite.config.ts` 或 d 的 server entry。c 对生产入口只报告 GAP，校验逻辑本身仍须通过独立导入的 PASS 断言。

数据库表的 phase 只记录持久状态，不能写入 d 的内存中间阶段 `migrating` 或 `recovering`。这些阶段保持在 runtime 快照中。所有写诊断的 `project_id` 必须真实存在，其他尚无对应表的关联位没有外键。

## 未验证项与偏离

生产入口在监听前拒绝非法配置尚未验证，owner 为 `p1-d-runtime`。本机观测到非法 PORT 和缺失 secret 的进程均监听验收端口，10 秒后由脚本终止，exit 为 null、signal 为 SIGKILL。对应日志为 `.verify/c-data-auth/bad-port.log` 和 `missing-secret.log`。独立导入 auth 的退出码与可读错误单独验证，不能替代 d 的入口验收。

多进程并发写 SQLite、WAL checkpoint 和写饥饿、session 过期与刷新、额外密码强度策略、真实跨机访问均未验证。连接的 HMR 复用通过结构性 `globalThis` 缓存实现，尚无真实 dev HMR 的连接数量观测。

`src/routeTree.gen.ts` 由 TanStack 重新生成，以登记 `/login` 和 `/api/auth/$`。这是新增路由必须更新的生成物，未手工编辑。coordinator 本次另授权修改 `drizzle.config.ts`，仅按现有 DATABASE_URL 创建父目录。没有修改共享契约、runtime、Vite 配置、package scripts、CI 工作流或其他 worktree。

没有可用的 delegate 工具，宿主中也未找到 cursor-team-kit 的 deslop 技能，因此没有独立多模型审查或插件审查结果。已直接检查 diff、注释与作用域，并运行真实门禁。没有修改技能文件。

设计遵循 Model the Domain，以表约束、会话 DTO 和认证动作联合类型表达边界。Build the Lever 使 HTTP、SQLite、Chromium 的证据可重跑。Prove It Works 要求保留真实启动观测并明确 GAP 的 owner，不能用独立模块测试代替生产入口验收。
