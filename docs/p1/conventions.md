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

`BETTER_AUTH_SECRET` 在 auth 尚未接入时可省略，提供时至少 32 字符。认证模块接入时必须在自己的边界要求有效 secret，不得把 `.env.example` 中的开发占位值当作生产凭据。解析失败抛出包含字段名和约束的错误，不输出原始秘密。

`DiagnosticEvent` 必填 `id`、`at`、`level`、`event`、`requestId` 和 `message`。`at` 使用 ISO 字符串。`projectId`、`conversationId`、`instanceId`、`runId` 和 `executionId` 仅在实际关联存在时填写。不能为尚未实现的对象捏造 ID。日志级别只允许 `debug`、`info`、`warn` 和 `error`。

`pnpm test` 已验证环境缺省、冻结配置、端口与 origin 解析、非法字段名和秘密不泄漏。该验证不代表数据库连接或认证已实现。

## 新增功能的步骤

1. 阅读功能 brief，确定允许写入的目录、输入 schema、返回类型与 requestId 来源。
2. 在已有目录中实现最小业务服务，入口只负责 Zod 解析、调用服务和 AppResult 转换。
3. 数据库变更交由 schema 维护者生成 migration。事务和数据库约束负责持久不变量。
4. 页面调用 server function 并按 `result.ok` 展示结果。显示失败时保留 requestId 供诊断。
5. 按风险增加行为测试。涉及浏览器、SQLite、Pi 或 Worker 时，使用真实产物补充验收。
6. 在 `scripts/verify/` 新增按 unit 命名的检查。总入口会按文件名顺序执行，脚本不能依赖其他脚本留下的进程或数据。
7. 运行 `pnpm fmt`、`pnpm check`、`pnpm test` 与相关验收脚本。生成文件不手动改格式。

`src/routeTree.gen.ts`、`src/db/auth-schema.ts` 与 `drizzle/meta/**` 在根格式配置中排除。现存实验和根 `docs/` 文档不由应用格式命令改写。CI 使用 `pnpm check`，不加 `--fix`。验证脚本使用 PASS 和 FAIL 断言字符串说明步骤，不添加描述执行阶段的注释。
