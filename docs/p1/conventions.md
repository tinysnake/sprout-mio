# 开发约定

前端设计与代码修改还必须遵守 [前端设计基线](../frontend-design.md) 和 [前端开发约定](../frontend-conventions.md)。两者规定共享组件、token、Tailwind / CSS、开发演示及浏览器验证方式；旧样例页面和默认组件外观不构成设计规范。

## 命名与归属

普通文件名使用 kebab-case。导出的函数和变量使用 camelCase，类型和 React 组件使用 PascalCase，常量使用 UPPER_SNAKE_CASE。TanStack 约定的 `Route`、`__root.tsx` 与生成的 `routeTree.gen.ts` 保留框架命名。

路由文件决定 URL。页面位于 `src/routes/`，共享 UI 位于 `src/components/ui/`，共享载荷和边界 schema 位于 `src/contracts/`。Worker 和 Pi extension 只写各自目录。共享契约不导入 React、数据库、认证或后台 runtime。不要为单个功能创建 package。

数据库 schema 的维护权属于数据库 unit。其他 unit 读取共享契约，需要修改契约时先向 coordinator 报告。配置解析位于 `src/lib/config.ts`，不导入 db，也不打开连接。长生命周期服务由独立的启动和关闭边界拥有，不能由 HTTP 请求拥有。

现有文件归属使用 `git ls-files src` 核对。`pnpm typecheck` 已验证 Web、Worker、extension 的模块形状兼容。

## 输入与错误

在 HTTP、server function、CLI 和环境变量边界使用 Zod 解析外部数据。内部代码接收已解析的类型，不重复校验同一份数据。

Project 创建输入使用 `createProjectInput.parse()` 或 `safeParse()`。名称 trim 后长度为 1 到 80，description 可省略，存在时长度不超过 500。完整对象使用 `projectSchema` 校验带 `prj_` UUID 的 ID 与 ISO 日期。完整对象和详情输入的 ID 都复用 `src/contracts/ids.ts` 的 `appIdPattern(ID_PREFIXES.project)`，只接受相同的 UUID v4 格式。

业务结果统一使用 `AppResult<T>`。成功分支为 `{ ok: true, data, requestId }`，失败分支为 `{ ok: false, error, requestId }`。成功必须有 data，失败必须有 error，不允许同时携带两个分支的字段。TypeScript 判别字段是 `ok`。

调用方式如下。

```ts
const { requestId } = getRequestContext();
const input = createProjectInput.safeParse(raw);
if (!input.success) {
  return fail(toAppError(input.error, requestId));
}
return ok(input.data, requestId);
```

该示例只展示契约转换，不创建或存储 Project。

每个结果和诊断事件必须携带当前 requestId。错误通过 `toAppError(unknown, requestId)` 转换。Zod 错误映射为 `validation_failed`。明确的业务错误使用 `validation_failed`、`unauthorized`、`forbidden`、`not_found`、`conflict` 或 `too_many_requests`。未知错误与 `internal` 错误统一返回 `内部错误`，不把 stack、SQL、文件路径或秘密写入用户载荷。

不要用 HTTP 200 判断 server function 的业务成功。读取 `result.ok`，失败时读取 `result.error.code` 和 `result.error.requestId`。错误中的 requestId 使用当前请求值，不能信任传入错误对象里的旧值。

认证 server function 的 `login` 与 `register` 必须在调用 `auth.api` 前同步消费账号与进程预算，成功和失败均计数；`logout` 不消费认证预算。限流返回 HTTP 200 与 `fail({ code: "too_many_requests", message: "尝试过于频繁，请稍后再试", requestId })`。诊断为 `warn` / `auth.rate_limited`，data 只含 action，不记录邮箱、密码、IP 或内部 key。`authenticate` 使用 Nitro 当前 requestId，使响应头、AppResult 与诊断一致。Better Auth HTTP router 保留原生 429 与 `X-Retry-After` 协议；两种边界不可混用状态码判断。策略与局限见 [认证限流](data-auth.md#认证限流)。

`pnpm test` 已验证 ID 前缀与唯一性、结果分支、错误映射和脱敏、Project 文本边界及日期拒绝，共 7 个测试与配置验证同跑。

## 环境与诊断

应用使用 frozen `config`。默认 `DATABASE_URL` 为 `./data/sprout.sqlite`，`APP_ORIGIN` 为 `http://localhost:3000`，`PORT` 为 3000，`NODE_ENV` 为 `development`，`LOG_LEVEL` 为 `info`。`APP_ORIGIN` 必须是完整的 http 或 https origin，不带路径。`PORT` 必须是 1 到 65535 的整数。

开发与生产入口都监听全部接口（`0.0.0.0`）：`pnpm dev` 显式带 `--host 0.0.0.0`，`pnpm start` 的 Node 入口未指定 host 时由框架绑定全部接口。因此可以用 `127.0.0.1`、局域网 IP 或 VPN 地址打开页面。`APP_ORIGIN` 仍是主 origin：auth 的 `baseURL`、cookie 与回调按它生成。要同时接受其他内网或 VPN 地址，在 `APP_TRUSTED_ORIGINS` 里列出模式（逗号分隔），例如 `http://192.168.1.10:3200,http://192.168.50.*:3200`；`APP_ORIGIN` 隐式可信，不需要重复写。校验入口是 `src/lib/origin.ts` 的 `isTrustedOrigin`，Better Auth 的 `trustedOrigins` 共用同一份列表。

可信模式必须是完整 http 或 https origin：主机段可以是 `localhost`、`*.localhost`、`*.local`，或四段 IPv4 中末尾一段写 `*`（如 `192.168.50.*`）。展开后的地址必须落在回环、私有网段、链路本地或 CGNAT 内；`http://*:3000`、公网域名、带路径或带凭据的写法都会被配置解析拒绝。模式按整串匹配，不做前缀匹配。绑定全部接口意味着同一网络内的其他设备可以访问未认证的页面根与 API；本机处可信内网时可直接使用，其他环境需自行加前置鉴权或改为只监听回环。

认证限流在所有环境始终启用，没有关闭开关。`AUTH_RATE_LIMIT_MAX` 默认 5，校验为 1 到 1000 的整数，控制 server function 账号预算；`AUTH_RATE_LIMIT_WINDOW_SECONDS` 默认 60，校验为 1 到 3600 的整数，是两个边界的窗口秒数；`AUTH_RATE_LIMIT_GLOBAL_MAX` 默认 100，校验为 1 到 10000 的整数，只控制 server function 进程总预算；`AUTH_RATE_LIMIT_HTTP_MAX` 默认 100，校验为 1 到 10000 的整数，独立控制所有 Better Auth HTTP 路径的每 IP、每路径预算。server function 不读取 IP 请求头。HTTP 保留 Better Auth 默认 IP header 解析，直连或不受信代理下可被伪造，只有部署在受信代理后其 per-IP 分桶才有意义。不可通过伪造 IP 绕过的是 server function 按账号预算，不能将此保证推广到 HTTP 路径。进程内存预算不跨重启或进程共享，部署变更需重新评估。

`BETTER_AUTH_SECRET` 在共享 config 解析层允许缺省，提供时至少 32 字符。自 p1-c-data-auth 接入认证、p1-d-runtime 接入启动边界后，auth 与生产入口都强制要求有效 secret，生产入口在监听前拒绝缺失、短值与示例占位值。原先 auth 未接入时可省略的条件已不适用于生产启动。构建 prerender 跳过 runtime，不要求部署 secret。证据见 [runtime.md 的验证命令与证据](runtime.md#验证命令与证据)。解析失败抛出包含字段名和约束的错误，不输出原始秘密。

`DiagnosticEvent` 必填 `id`、`at`、`level`、`event`、`requestId` 和 `message`。`at` 使用 ISO 字符串。`projectId`、`chatId`、`instanceId`、`runId` 和 `executionId` 仅在实际关联存在时填写。不能为尚未实现的对象捏造 ID。日志级别由 `DIAGNOSTIC_LEVELS` 定义，只允许 `debug`、`info`、`warn` 和 `error`；类型、环境配置和数据库约束共用这份定义。

认证和 Project server functions 的载荷 requestId 必须等于响应头 `x-sprout-request-id` 与该请求的 `http.response` 诊断行 requestId。Project boundary 的依赖加载、会话查询、Zod 校验与领域调用共享一个 try；基础设施失败返回脱敏 `internal`，服务端记录真实原因，并写入 `project.request_failed` error 诊断，data 只含安全错误码。诊断存储本身不可用时只能记录服务端错误。

`queryDiagnostics` 必须接收认证调用者的 `actorId`。Project 诊断仅创建者可见，即使指定其他人的 projectId 或 requestId 也返回空；非 Project 诊断只在指定具体 requestId 时可见。HTTP `/api/diagnostics` 还必须提供 requestId 或 projectId，否则返回 HTTP 400 与 `validation_failed`，不能无过滤列举。

`pnpm test` 已验证环境缺省、冻结配置、端口与 origin 解析、非法字段名和秘密不泄漏。配置解析测试的范围不包含数据库连接或认证；数据库与认证的真实验证另见 [data-auth.md](data-auth.md#验证证据)。

## 数据库约束与迁移

SQLite 的 CHECK 仅在表达式为 FALSE 时拒绝，表达式为 NULL 时放行。凡约束引用可空列，必须通过 `IS NOT NULL` 或 `IS NULL` 明确处理 NULL。例如完成状态要求 stop 原因时，`CHECK (status <> 'completed' OR stop_reason = 'stop')` 会放行 `completed` 配 NULL，必须改为 `CHECK (status <> 'completed' OR (stop_reason IS NOT NULL AND stop_reason = 'stop'))`。每项这类约束都配直接 SQL 反证，绕过领域服务 INSERT 非法组合，断言数据库拒绝，并保留合法组合的正常对照。领域层校验不能替代数据库反证。此约定沿用 SO28。

迁移一旦合并或被任何共享 DB 应用，就不得原地编辑或重生成同一文件，必须新增迁移。只有同一 PR 内尚未合并、且未被任何共享 DB 应用的迁移，才允许原地重生成。提交前核对 SQL 与 `drizzle/meta/_journal.json` 的变更及应用范围。此约定沿用 SO29。

Drizzle SQLite migrator 按 journal 的 `when`，即 `folderMillis`，决定是否重放，不能把记录的 hash 当成重放依据。重生成抬高 `when`，已应用过的 DB 会重放并可能撞上已有表。只改 SQL 而保持 `when` 不变，已应用过的 DB 则静默跳过，造成 schema 分叉。开发与验证库会跨次保留账本，允许重生成的本机实验使用新的独立 `DATABASE_URL` 或删除自己的可重建库；不得据此删除共享数据。`scripts/verify.sh` 会清理 `.verify/*/verification.sqlite`，单跑脚本仍需核对所用库的迁移历史。

## 新增功能的步骤

本清单由 `docs/p1/feature-sample.md` 的 Project 样例逐条核对过，每一步都在该样例里真实执行过。后续 Agent 新增功能时按此执行，并以该样例为验收样例。

1. 阅读功能 brief，确定允许写入的目录、输入 schema、返回类型与 requestId 来源。requestId 在 server function 内取 `getRequestContext().requestId`，直接持有 Request 的路由 handler 取 `getRequestContext(request)`。不要用 `newId` 另造一个，否则它与响应头和诊断行对不上。
2. 目录固定：业务服务 `src/domain/<feature>.ts`，边界 `src/server/functions/<feature>.ts`，页面 `src/routes/_authed/<feature>*.tsx`，组件 `src/components/<feature>/**`，契约 `src/contracts/<feature>.ts`，测试 `tests/<feature>.test.ts`，验收 `scripts/verify/<unit>.sh`，浏览器流程 `scripts/browser/<feature>-flow.mjs`。
3. 先定数据形状：业务服务接收已解析输入与 `{ userId, requestId }` 上下文，返回领域类型或抛出领域错误。HTTP 概念只出现在边界。
4. Zod 只在边界，顺序固定为会话 → zod → 事务。失败一律 HTTP 200 加 `AppResult` 载荷，响应头 `x-sprout-request-id` 由框架边界写入。字段级错误沿用 `ProjectResult` 的模式（`AppResult<T> & { fieldErrors?: Record<string, string> }`），不改 `AppResult` 本身。
5. 事务把业务行与诊断行一起写：在同一个 `sqlite.transaction` 里插入 `diagnostic_event`（`event`、`requestId`、业务 id），不要调用会吞掉写入失败的 `recordDiagnostic`。它使用共享 db 连接，不能把调用成功返回当作诊断写入成功。留一个可注入的失败 hook 用于证明回滚。
6. 服务端专有导入（`src/db`、`src/lib/auth`、`src/server/session`）必须在 server function 或 boundary 函数内部 `await import(...)`。顶层静态导入会把 `better-sqlite3` 打进客户端包，应用直接白屏启动失败。
7. TanStack 文件路由：父路由文件必须渲染 `<Outlet />`，否则子路由不会出现。`projects.index.tsx` 是 Project 列表与入口分发，`projects.$projectId.tsx` 只承担 Project 上下文布局，`projects.$projectId.index.tsx` 把 Project 根重定向到该 Project 的 Chats，`projects.tsx` 只是外壳。新增路由后运行 `pnpm exec tsr generate`，`src/routeTree.gen.ts` 是生成物，不手改。
8. 页面用 loader 取数，按 `result.ok` 判断。失败时显示错误码、消息与 requestId，字段错误显示在对应输入旁。列表与详情都要能通过 URL 直接刷新。登入后访问 `/` 会经 `/projects` 分发到 Project 的 Chats；身份与登出在侧栏 `account-menu` 弹层内（`session-email`、`sign-out`），`scripts/verify/c-data-auth.sh` 的 Chromium 检查依赖这两处，改动前先核对那个脚本。
9. 数据库变更交由 schema 维护者生成 migration。事务和数据库约束负责持久不变量。
10. 行为测试写在 `tests/<feature>.test.ts`，用子进程（`tsx` 加独立 `DATABASE_URL`）导入模块，因为 `src/lib/config.ts` 在导入时读取 env。断言用户可观察的结果（数据库行、载荷、字段错误），不测内部调用。boundary 函数可直接调用，不需要起 HTTP。
11. 验收脚本 `scripts/verify/<unit>.sh` 启动真实生产进程并用 curl 驱动。server function 的请求体是 Seroval CrossJSON，函数 id 从 `.output/server` 按 `name` 提取。公开的 `pnpm build` 先删 `.output` 再构建，防止残留 `.output/public/_shell.html` 引用上一次构建的资源名。
12. 浏览器验收用 Playwright 加真实 Chromium，每步打印 PASS/FAIL，截图默认写入 `.verify/<unit>/evidence/`。已提交的章节证据目录只放交付版本：章节交付或记录更新时由人手动复制过去，并同时更新该目录的索引。验收脚本不直接写 `docs/`，否则重跑一次就会静默改写历史章节的证据图。
13. 运行 `pnpm fmt`、`pnpm check`、`pnpm test` 与 `bash scripts/verify.sh`。生成文件不手动改格式。

`src/routeTree.gen.ts`、`src/db/auth-schema.ts` 与 `drizzle/meta/**` 在根格式配置中排除。现存实验和根 `docs/` 文档不由应用格式命令改写。CI 使用 `pnpm check`，不加 `--fix`。验证脚本使用 PASS 和 FAIL 断言字符串说明步骤，不添加描述执行阶段的注释。分 unit 的验收脚本由 `scripts/verify.sh` 按文件名顺序执行，脚本之间不共享进程、cookie 或数据库文件。
