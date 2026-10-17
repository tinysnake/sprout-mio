# 开发约定

## 命名与归属

普通文件名使用 kebab-case。导出的函数和变量使用 camelCase，类型和 React 组件使用 PascalCase，常量使用 UPPER_SNAKE_CASE。TanStack 约定的 `Route`、`__root.tsx` 与生成的 `routeTree.gen.ts` 保留框架命名。

路由文件决定 URL。页面位于 `src/routes/`，共享 UI 位于 `src/components/ui/`，共享载荷和边界 schema 位于 `src/contracts/`。Worker 和 Pi extension 只写各自目录。共享契约不导入 React、数据库、认证或后台 runtime。不要为单个功能创建 package。

数据库 schema 的维护权属于数据库 unit。其他 unit 读取共享契约，需要修改契约时先向 coordinator 报告。配置解析位于 `src/lib/config.ts`，不导入 db，也不打开连接。长生命周期服务由独立的启动和关闭边界拥有，不能由 HTTP 请求拥有。

现有文件归属使用 `git ls-files src` 核对。`pnpm typecheck` 已验证 Web、Worker、extension 的模块形状兼容。

## 输入与错误

在 HTTP、server function、CLI 和环境变量边界使用 Zod 解析外部数据。内部代码接收已解析的类型，不重复校验同一份数据。

Project 创建输入使用 `createProjectInput.parse()` 或 `safeParse()`。名称 trim 后长度为 1 到 80，description 可省略，存在时长度不超过 500。完整对象使用 `projectSchema` 校验带 `prj_` UUID 的 ID 与 ISO 日期。

业务结果统一使用 `AppResult<T>`。成功分支为 `{ ok: true, data, requestId }`，失败分支为 `{ ok: false, error, requestId }`。成功必须有 data，失败必须有 error，不允许同时携带两个分支的字段。TypeScript 判别字段是 `ok`。

调用方式如下。

```ts
const requestId = newId(ID_PREFIXES.request);
const input = createProjectInput.safeParse(raw);
if (!input.success) {
  return fail(toAppError(input.error, requestId));
}
return ok(input.data, requestId);
```

该示例只展示契约转换，不创建或存储 Project。

每个结果和诊断事件必须携带当前 requestId。错误通过 `toAppError(unknown, requestId)` 转换。Zod 错误映射为 `validation_failed`。明确的业务错误使用 `validation_failed`、`unauthorized`、`forbidden`、`not_found` 或 `conflict`。未知错误与 `internal` 错误统一返回 `内部错误`，不把 stack、SQL、文件路径或秘密写入用户载荷。

不要用 HTTP 200 判断 server function 的业务成功。读取 `result.ok`，失败时读取 `result.error.code` 和 `result.error.requestId`。错误中的 requestId 使用当前请求值，不能信任传入错误对象里的旧值。

`pnpm test` 已验证 ID 前缀与唯一性、结果分支、错误映射和脱敏、Project 文本边界及日期拒绝，共 7 个测试与配置验证同跑。

## 环境与诊断

应用使用 frozen `config`。默认 `DATABASE_URL` 为 `./data/sprout.sqlite`，`APP_ORIGIN` 为 `http://localhost:3000`，`PORT` 为 3000，`NODE_ENV` 为 `development`，`LOG_LEVEL` 为 `info`。`APP_ORIGIN` 必须是完整的 http 或 https origin，不带路径。`PORT` 必须是 1 到 65535 的整数。

`BETTER_AUTH_SECRET` 在共享 config 解析层允许缺省，提供时至少 32 字符。自 p1-c-data-auth 接入认证、p1-d-runtime 接入启动边界后，auth 与生产入口都强制要求有效 secret，生产入口在监听前拒绝缺失、短值与示例占位值。原先 auth 未接入时可省略的条件已不适用于生产启动。构建 prerender 跳过 runtime，不要求部署 secret。证据见 [runtime.md 的验证命令与证据](runtime.md#验证命令与证据)。解析失败抛出包含字段名和约束的错误，不输出原始秘密。

`DiagnosticEvent` 必填 `id`、`at`、`level`、`event`、`requestId` 和 `message`。`at` 使用 ISO 字符串。`projectId`、`conversationId`、`instanceId`、`runId` 和 `executionId` 仅在实际关联存在时填写。不能为尚未实现的对象捏造 ID。日志级别只允许 `debug`、`info`、`warn` 和 `error`。

`pnpm test` 已验证环境缺省、冻结配置、端口与 origin 解析、非法字段名和秘密不泄漏。配置解析测试的范围不包含数据库连接或认证；数据库与认证的真实验证另见 [data-auth.md](data-auth.md#验证证据)。

## 新增功能的步骤

本清单由 `docs/p1/feature-sample.md` 的 Project 样例逐条核对过，每一步都在该样例里真实执行过。后续 Agent 新增功能时按此执行，并以该样例为验收样例。

1. 阅读功能 brief，确定允许写入的目录、输入 schema、返回类型与 requestId 来源。requestId 在 server function 内取 `getRequestContext().requestId`，直接持有 Request 的路由 handler 取 `getRequestContext(request)`。不要用 `newId` 另造一个，否则它与响应头和诊断行对不上。
2. 目录固定：业务服务 `src/domain/<feature>.ts`，边界 `src/server/functions/<feature>.ts`，页面 `src/routes/_authed/<feature>*.tsx`，组件 `src/components/<feature>/**`，契约 `src/contracts/<feature>.ts`，测试 `tests/<feature>.test.ts`，验收 `scripts/verify/<unit>.sh`，浏览器流程 `scripts/browser/<feature>-flow.mjs`。
3. 先定数据形状：业务服务接收已解析输入与 `{ userId, requestId }` 上下文，返回领域类型或抛出领域错误。HTTP 概念只出现在边界。
4. Zod 只在边界，顺序固定为会话 → zod → 事务。失败一律 HTTP 200 加 `AppResult` 载荷，响应头 `x-sprout-request-id` 由框架边界写入。字段级错误沿用 `ProjectResult` 的模式（`AppResult<T> & { fieldErrors?: Record<string, string> }`），不改 `AppResult` 本身。
5. 事务把业务行与诊断行一起写：在同一个 `sqlite.transaction` 里插入 `diagnostic_event`（`event`、`requestId`、业务 id），不要调用会吞掉写入失败的 `recordDiagnostic`。它使用共享 db 连接，不能把调用成功返回当作诊断写入成功。留一个可注入的失败 hook 用于证明回滚。
6. 服务端专有导入（`src/db`、`src/lib/auth`、`src/server/session`）必须在 server function 或 boundary 函数内部 `await import(...)`。顶层静态导入会把 `better-sqlite3` 打进客户端包，应用直接白屏启动失败。
7. TanStack 文件路由：父路由文件必须渲染 `<Outlet />`，否则子路由不会出现。Project 的列表页是 `projects.index.tsx`，详情页是 `projects.$projectId.tsx`，`projects.tsx` 只是外壳。新增路由后运行 `pnpm exec tsr generate`，`src/routeTree.gen.ts` 是生成物，不手改。
8. 页面用 loader 取数，按 `result.ok` 判断。失败时显示错误码、消息与 requestId，字段错误显示在对应输入旁。列表与详情都要能通过 URL 直接刷新。已登录首页 `/` 的 `已登录，<姓名>` 文案与 `登出` 按钮被 `scripts/verify/c-data-auth.sh` 的 Chromium 检查依赖，改动前先核对那个脚本。
9. 数据库变更交由 schema 维护者生成 migration。事务和数据库约束负责持久不变量。
10. 行为测试写在 `tests/<feature>.test.ts`，用子进程（`tsx` 加独立 `DATABASE_URL`）导入模块，因为 `src/lib/config.ts` 在导入时读取 env。断言用户可观察的结果（数据库行、载荷、字段错误），不测内部调用。boundary 函数可直接调用，不需要起 HTTP。
11. 验收脚本 `scripts/verify/<unit>.sh` 启动真实生产进程并用 curl 驱动。server function 的请求体是 Seroval CrossJSON，函数 id 从 `.output/server` 按 `name` 提取。脚本先删 `.output` 再构建：残留的 `.output/public/_shell.html` 会引用上一次构建的资源名，页面白屏。
12. 浏览器验收用 Playwright 加真实 Chromium，每步打印 PASS/FAIL，截图写入 `docs/p1/evidence/`。
13. 运行 `pnpm fmt`、`pnpm check`、`pnpm test` 与 `bash scripts/verify.sh`。生成文件不手动改格式。

`src/routeTree.gen.ts`、`src/db/auth-schema.ts` 与 `drizzle/meta/**` 在根格式配置中排除。现存实验和根 `docs/` 文档不由应用格式命令改写。CI 使用 `pnpm check`，不加 `--fix`。验证脚本使用 PASS 和 FAIL 断言字符串说明步骤，不添加描述执行阶段的注释。分 unit 的验收脚本由 `scripts/verify.sh` 按文件名顺序执行，脚本之间不共享进程、cookie 或数据库文件。
