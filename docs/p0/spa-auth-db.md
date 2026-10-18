# P0：Start SPA 深链、Better Auth session、Drizzle 事务与 migration、shadcn + Base UI

对应 [development-plan-functional.md](../development-plan-functional.md) P0 第 2 条。实验代码在
[`experiments/spa-auth-db/`](../../experiments/spa-auth-db)，一个可重跑的验证脚本
`experiments/spa-auth-db/verify.sh`。

## 结论

| 项 | 结论 | 证据 |
| --- | --- | --- |
| Start SPA 模式深链刷新 | 已验证 | `deep_link_*` 5 项 + `deep_link_client_render`（Chromium 实际渲染 `/second`） |
| Better Auth email-password 注册登录与 session cookie | 已验证 | `sign_up_*`、`session_*`、`sign_out_*` 9 项 |
| 受保护 server function 未登录被拒 | 已验证（拒绝信号在响应载荷，不在 HTTP 状态，见发现 4） | `protected_call_rejected_without_session`、`protected_call_allowed_with_session` |
| Drizzle SQLite migration 可从零重放 | 已验证 | `migration_replay_from_empty`（删 `dev.db` 后重放） |
| 显式事务回滚 | 已验证 | `db_transaction_rollback` + 正对照 `db_insert_without_transaction_persists` |
| 唯一约束冲突行为 | 已验证 | `db_unique_conflict` |
| shadcn + Base UI 组件真实渲染、无样式报错 | 已验证 | `shadcn_button_styled`、`base_ui_dialog_open`、`no_console_errors` |
| 静态托管（CDN rewrite 到 `_shell.html`） | 未验证 | 只确认构建产物存在，未部署任何静态主机 |
| 并发写入、多进程、多宿主下的 SQLite 行为 | 未验证 | 超出本次范围 |
| Better Auth 组织/多用户模型 | 未验证 | 按 FORBIDDEN 不实现 |

最后一次完整运行：`checks: 32, passed: 32, failed: 0`。

## 版本

p0-a 尚未产出结论，本文的版本组合由本单元自行选定并实测。Node v26.11.1，npm 11.20.0。

| 包 | 版本 | 包 | 版本 |
| --- | --- | --- | --- |
| @tanstack/react-start | 1.169.2 | @tanstack/react-router | 1.170.44 |
| better-auth | 1.7.10 | drizzle-orm | 0.45.4 |
| drizzle-kit | 0.31.11 | better-sqlite3 | 12.11.1 |
| vite | 8.3.4 | nitro | 3.0.260610-beta |
| react / react-dom | 19.3.1 | tailwindcss | 4.3.3 |
| @base-ui/react | 1.9.0 | shadcn (CLI/主题包) | 4.22.0 |
| playwright | 1.63.0 | typescript | 6.0.3 |

参考原 Sprout 仓库仅用于核对已装依赖（例如 Playwright 版本与浏览器缓存），
参考 commit `5b48a53b385ee8a4c0fff219954c6244506b0b9f`（`Finish r226 (#285)`），
未复制其源码。

## 运行方式

```bash
cd experiments/spa-auth-db
npm install
npm run verify          # 删库 → 迁移 → 生产构建 → 起服务 → HTTP + Chromium 检查
```

`verify.sh` 在缺少 `.env.local` 时会自行生成（含随机 `BETTER_AUTH_SECRET`），
在端口 3000 启动 `.output/server/index.mjs`，结果写入 `.verify/`。

## 1. SPA mode 与深链

实现由两半组成，缺一半都不成 SPA：

- 构建期 `vite.config.ts` 的 `tanstackStart({ spa: { enabled: true } })`，产出路由无关的
  `.output/public/_shell.html`。
- 运行期 `src/start.tsx` 的 `createStart(() => ({ defaultSsr: false }))`，让服务端在
  文档请求上只发 shell，路由与 loader 全在客户端执行。

`verify.sh` 输出：

```
PASS deep_link_returns_200 :: GET /second
PASS deep_link_serves_shell :: response body has no server-rendered route markup
PASS deep_link_bootstraps_client :: shell references the client entry bundle
PASS deep_link_http_status :: GET /second -> 200, client-only markup (no SSR body): true
PASS deep_link_client_render :: /second rendered marker "deep-link-target"
```

最后一项是真实 Chromium 直接导航到 `http://localhost:3000/second`，等
`[data-testid="second-marker"]` 出现并读到 `deep-link-target`；同时断言响应体里没有
`Second page`，即 HTTP 层确实是 shell、内容由客户端渲染。

开发模式（Vite dev server 的 `TSS_SHELL` 路径，未纳入 `verify.sh`）：

```
$ npm run dev -- --port 3100
$ curl -s -o /tmp/dev-second.html -w "status=%{http_code} bytes=%{size_download}\n" "http://[::1]:3100/second"
status=200 bytes=2202
$ grep -c "Second page" /tmp/dev-second.html
0
$ grep -o 'src="/@id/[^"]*"' /tmp/dev-second.html | head -1
src="/@id/virtual:tanstack-start-dev-client-entry"
```

注意 dev server 只监听 `[::1]`；本机 `http_proxy` 会让 `curl http://127.0.0.1:3100` 走到代理并
返回 502，需用 `--noproxy '*'` 或 `[::1]`。

未知路径不返回 shell：`GET /no-such-route -> 404`（`unknown_route_404`），静态资源缺失也是
404（`missing_asset_404`）。静态托管用 catch-all rewrite 时未知路径会返回 200 + shell，
这条路径本单元未验证。

## 2. Better Auth

`src/lib/auth.ts` 用 `drizzleAdapter(db, { provider: 'sqlite', schema })` + `better-sqlite3`，
插件 `tanstackStartCookies()`；`src/routes/api/auth/$.ts` 挂 `auth.handler`。
受保护入口是 `src/server/auth-functions.ts` 的 `readProtectedValue`，它调用
`src/server/session.ts` 的 `requireSession(getRequestHeaders())`，无 session 时抛
`UnauthorizedError`。

`verify.sh` 输出：

```
PASS sign_up_returns_200 :: POST /api/auth/sign-up/email (curl-1792175213@example.com)
PASS sign_up_sets_session_cookie :: Set-Cookie: better-auth.session_token=...
PASS get_session_http_200_with_cookie :: GET /api/auth/get-session with cookie jar
PASS session_readable_with_cookie :: session.user.email matches the signed-up user
PASS get_session_http_200_without_cookie :: GET /api/auth/get-session with no cookie
PASS session_absent_without_cookie :: anonymous request has no session
PASS sign_out_returns_200 :: POST /api/auth/sign-out (better-auth CSRF check needs an Origin header)
PASS session_gone_after_sign_out :: session cleared after sign-out
```

浏览器侧（真实 Chromium，同一 cookie 语义）：

```
PASS sign_up_sets_session :: session-email === probe-1792175214771@example.com
PASS session_survives_reload :: session cookie read on a fresh document load
PASS protected_call_allowed_with_session :: server fn 200 -> "ok: protected-ok (hkJhNXa1...)"
PASS sign_out_clears_session :: session-email === no-session
PASS protected_call_rejected_without_session :: server fn HTTP 200 carries the error in the payload (true) -> "rejected: Unauthorized"
```

## 3. Drizzle：migration、事务、唯一约束

Schema 在 `src/db/schema.ts`：`probe_items(id text pk, slug text unique not null, label text not null)`
加上 Better Auth CLI 生成的 `src/db/auth-schema.ts`（user / session / account / verification）。
唯一性与主键不变量放在数据库约束里，不在应用分支里。

从零重放：

```
PASS migration_replay_from_empty :: drizzle-kit migrate applied 0000 from a deleted dev.db
```

检查逻辑在 `src/server/db-checks.ts`，经 `POST /api/probe/db` 走真实 HTTP 与真实连接：

```
PASS db_unique_conflict :: {"error":{"code":"SQLITE_CONSTRAINT_UNIQUE","message":"UNIQUE constraint failed: probe_items.slug"},"rowsAfterConflict":["probe-unique-1"]}
PASS db_insert_without_transaction_persists :: {"error":{...,"code":"SQLITE_CONSTRAINT_PRIMARYKEY"},"rowsAfterFailedInsert":["probe-control"]}
PASS db_transaction_rollback :: {"error":{...,"code":"SQLITE_CONSTRAINT_PRIMARYKEY"},"rowsAfterRollback":[],"positiveControl":"insert_without_transaction_persists"}
```

回滚项不是只看“第一行不存在”：正对照先证明同一失败在没有事务时会留下 `probe-control` 行，
再用 `db.transaction` 跑同样两条插入，断言 `probe-tx-rollback` 不存在。

## 4. shadcn + Base UI

组件由 shadcn CLI 以 Base UI 为基元生成：`src/components/ui/button.tsx`
（`@base-ui/react/button`）与 `src/components/ui/dialog.tsx`
（`@base-ui/react/dialog`），渲染在 `/second`。

```
PASS shadcn_button_styled :: button computed styles {"background":"oklch(0.205 0 0)","radius":"10px","height":"32px","dataSlot":"button"}
PASS base_ui_dialog_open :: dialog content visible with "dialog-rendered"
PASS no_console_errors :: no console.error or uncaught page errors
```

“无样式报错”的判据是三条：组件真实挂载、`getComputedStyle` 读到 Tailwind 主题值
（背景不是透明的、高度是 32px 而不是 UA 默认）、整轮浏览器检查无 console error 与未捕获异常。

## 影响基础契约的发现

1. **`spa.enabled` 不会关掉 node server 的 SSR。** 只配置 `spa: { enabled: true }` 时，
   生产 node server 仍然对 `/second` 做完整 SSR（响应体含 `Second page`），
   运行期必须再设 `createStart(() => ({ defaultSsr: false }))`。构建产物 `_shell.html`
   与运行期行为是两件事。
2. **生产启动必须显式加载环境变量。** `node .output/server/index.mjs` 不读 `.env.local`；
   漏掉 `--env-file=.env.local` 时 `DATABASE_URL` 为 undefined，better-sqlite3 静默建内存库，
   表现为 `no such table: user`。部署路径需要固定一条环境变量加载方式。
3. **Better Auth 的 POST 需要 Origin/Referer。** 无 Origin 的 POST 返回
   `403 {"code":"MISSING_OR_NULL_ORIGIN"}`。浏览器不受影响；任何非浏览器入口
   （curl、Worker、MCP 代理）必须带 Origin，或改走别的鉴权路径。
4. **server function 的错误不体现在 HTTP 状态码上。** 未登录调用 `readProtectedValue`
   返回 `HTTP 200`，响应体是
   `{"t":10,"i":0,"p":{"k":["error"],"v":[{"t":25,"i":1,"s":{"message":{"t":1,"s":"Unauthorized"}},"c":"$TSR/Error"}]},"o":0}`。
   以 HTTP 状态码判断授权会被绕过，必须解析载荷。若以后把 server function 当作 Worker 协议
   的传输，这条必须显式改写。
5. **Drizzle 会包装错误，sqlite 错误码要读 `error.cause.code`。** 通过 `.run(sql\`...\`)`
   执行时抛 `DrizzleError`，`error.code` 不存在，`SQLITE_CONSTRAINT_*` 在 `error.cause.code`；
   通过查询构造器 `tx.insert(...).run()` 时才是裸 `SqliteError` 带 `error.code`。
   约束分类逻辑不能只读一层。
6. **shadcn CLI 对 TanStack Start 会猜错样式文件路径。** `shadcn init -t start` 仍往
   `app/globals.css` 写主题并报 ENOENT，`components.json` 也写成 Next 默认值。
   本单元改为手工修正 `components.json` 并新增
   `scripts/apply-shadcn-theme.mjs`，从 `base-nova` preset 重新生成 `src/theme.css`。
   另外 shadcn 已改用 `cn` 包与 `@base-ui/react`，不再是 clsx + tailwind-merge + Radix。

## 需要更新的架构说明

- [architecture-direction.md](../architecture-direction.md) 第 9 行把 TanStack Start 标为
  「SPA、路由、server functions、server routes」，需要补一句：SPA 运行期依赖
  `createStart({ defaultSsr: false })`，否则 node server 默认 SSR。
- 「常规功能沿着页面、server function、业务服务、数据库的固定路径实现」需要补错误契约：
  server function 的授权失败不是 HTTP 状态码，边界转换必须落到载荷。
- 「SQLite + Drizzle 是单宿主部署的候选默认组合，尚未锁定数据库 driver」现在可以收敛为
  better-sqlite3（同步驱动），并记录发现 5 的约束分类要求。
- 生产部署一节需要写明环境变量加载方式与 404 到 shell 的 rewrite 责任方。

## 未验证项

- 静态托管（CDN / link 到 `_shell.html` 的 rewrite）下的深链与 API allow-list，只验证了构建产物。
- 多进程或多宿主并发写 SQLite 的行为、busy timeout、WAL 设置。
- `defaultSsr: false` 下 `beforeLoad` / loader 的服务端执行被跳过这一点的逐条验证（只由文档说明与本实验的 shell 证据间接支持）。
- `_shell.html` 在未知路径 rewrite 后的客户端 not-found 行为。
- 生产构建的包体、首屏时间、CDN 缓存策略。
