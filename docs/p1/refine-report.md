# P1 重构验收报告

本次在 host 创建的 `p1/refine` 独立 worktree 执行，base 为 main。仅修改该 worktree；未运行 db:generate，未新增 migration。历史 unit 输出与截图保持原证据，新增运行日志位于忽略的 `.verify/` 与 `/tmp/p1-refine-*.log`，不提交 cookie、数据库或 secret。

## 提交与行为

| 范围 | 提交           | 文件与可观察结果                                                                                                                                                                                                                                                                                                                           |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1   | `8a07fce`      | `src/contracts/ids.ts`、`src/contracts/project.ts`、`src/contracts/diagnostics.ts`、`src/db/schema.ts`、`src/lib/config.ts`、`tests/contracts.test.ts`、`scripts/verify/c-data-auth.sh`：ID runtime 校验与日志级别各有单一来源；详情 ID 使用完整格式；数据库 CHECK 由 sql.join 构造；c 验收读取既有 migration 并真实重放迁移，不生成 SQL。 |
| C2   | `f374a96`      | `src/server/session.ts`、`scripts/verify/c-data-auth.sh`：三个认证函数复用当前 HTTP requestId；成功会话与失败登录断言 payload、响应头、http.response 三处相等。                                                                                                                                                                            |
| C3   | `80e5d1b`      | `src/server/functions/project.ts`、`tests/project.test.ts`：依赖只加载一次，加载、session、校验与领域调用共享异常边界；未知错误脱敏为 internal，stderr 保留原因并写安全 error 诊断；已有 unauthorized、not_found 和事务回滚断言保留。                                                                                                      |
| C4   | `3c8d60b`      | `src/server/diagnostics.ts`、`src/routes/api/diagnostics.ts`、`tests/diagnostics.test.ts`、`scripts/verify/d-runtime.sh`、`scripts/verify/e-project.sh`：查询必填 actorId，Project 行按归属隔离，非 Project 行按具体 requestId 查询；HTTP 拒绝无过滤列举；非法 limit 用例带合法 requestId，继续独立验证 limit。                            |
| C5   | `12c3011`      | `package.json`、`scripts/verify/e-project.sh`：公开 pnpm build 自动清理 .output；e 去掉额外清理，直接检验公开入口。                                                                                                                                                                                                                        |
| C6   | `c0771f6`      | `scripts/verify/a-base.sh`、`scripts/verify/b-tooling.sh`：干净安装保留仓库 data/；服务使用各自日志目录的 verification.sqlite；现有检查、构建与 smoke 继续执行。                                                                                                                                                                           |
| 文档 | 本报告所在提交 | 同步 summary、conventions、feature-sample、runtime、skeleton、tooling、data-auth 及架构方向；保留历史输出，明确当前 requestId、诊断可见性与构建约定。                                                                                                                                                                                      |

## 验收命令与输出

| 命令                                     | 退出码 | 关键输出                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`         | 0      | `Lockfile is up to date, resolution step is skipped`；`Packages: +562`；`Done in 2.3s using pnpm v10.33.0`。                                                                                                                              |
| `pnpm check`                             | 0      | `All 67 files are correctly formatted`；`Found no warnings, lint errors, or type errors in 49 files`。首次退出 1 的三个泛型推导错误已修复，并归入 C3 提交。                                                                               |
| `pnpm test`                              | 0      | `Test Files 6 passed (6)`；`Tests 31 passed (31)`。                                                                                                                                                                                       |
| `pnpm build`，第一次                     | 0      | `rm -rf .output && vp build`；入口 `index-Bc5-Zpez.js`。                                                                                                                                                                                  |
| `pnpm build`，第二次                     | 0      | 临时修改客户端文案后入口变为 `index-DOZg0SrW.js`；源码随后恢复。                                                                                                                                                                          |
| `bash scripts/verify/d-runtime.sh`       | 0      | `PASS authenticated diagnostics filters and validation {"status":200,"count":1,"invalidLimit":400}`；`PASS dev HMR reuses runtime and resource`；`PASS d-runtime all checks passed`。最终重跑包含补强后的非法 limit 用例和 8 项行为测试。 |
| `bash scripts/verify/e-project.sh`       | 0      | `PASS diagnostics rejects unfiltered listing {"status":400,"code":"validation_failed"}`；`PASS 真实 Chromium 流程`；`PASS 生产进程 SIGTERM 退出 {"code":0,"signal":null}`。                                                               |
| `bash scripts/verify/c-data-auth.sh`     | 0      | `PASS c-data-auth all checks passed`；真实 HTTP 与 Chromium 注册、登出、错误呈现、登录均 PASS。                                                                                                                                           |
| `bash scripts/verify/f-docs.sh`          | 0      | 七项清单证据 PASS；内部链接/锚点 141；仓库路径 125；`PASS f-docs all checks passed`。                                                                                                                                                     |
| `bash scripts/verify/b-tooling.sh`，额外 | 0      | `PASS clean frozen installation`；check、test、build、三条 HTTP 200 与 SIGTERM 全部 PASS；`PASS b-tooling all checks passed (clean install 4s)`。                                                                                         |

两次构建通过 `/tmp/p1-refine-builds.mjs` 驱动实际 pnpm build，每次子进程上限 300 秒，输出写入独立文件。第二次 shell 的所有 JS/CSS 引用均存在，旧入口 `index-Bc5-Zpez.js` 和旧路由资源 `routes-dCngzk9N.js` 均不再被引用且文件已删除。第二次对应资源为 `index-DOZg0SrW.js`、`routes-Cb3c2r4W.js`。日志输出：

```text
pnpm build #1: exit=0; signal=null; log=/tmp/p1-refine-build-1.log
pnpm build #2: exit=0; signal=null; log=/tmp/p1-refine-build-2.log
PASS consecutive public builds
EXIT_CODE=0
Client source restored
```

认证 HTTP 断言的真实输出：

```text
PASS protected-authenticated requestId matches payload, header and http.response req_816f9883-8e17-400a-8a38-676122df7e95
PASS failed-login requestId matches payload, header and http.response req_d3ea009b-bd44-4646-9519-bc97d4fd2f90
PASS Chromium register and protected reload authenticated.png
PASS Chromium logout, redirect, safe error and password login login-error.png; no page errors
PASS registration does not create Projects users=2 projects=0
```

Project 浏览器输出保存在 `.verify/e-project/browser.log`，12/12 通过，含页面错误、响应头和 http.response requestId 相等；本次截图另存 `.verify/e-project/screenshots/`，仓库历史截图已恢复。

## 回归证据与限制

- session 基础设施失败 → 三个 boundary 都返回 internal 与当前 req_x，并写三条 project.request_failed。测试通过 Headers Proxy 抛错触发真实 Better Auth Headers 转换，无生产测试 hook。修复前 tsx 子进程因 `Error: session infrastructure secret` reject，测试退出 1；修复后 Project 测试 7/7，退出 0。诊断 data 严格等于 `{"code":"internal"}`，客户端不含原始原因。
- 跨用户泄漏 → 用 auth.api.signUpEmail 注册 A/B，领域服务各建一个 Project，查询 A 无过滤只得到 A 的 project.created，指定 B 的 projectId 或 requestId 均为空。修复前实际返回两用户 Project 加两条非 Project 行，测试退出 1；修复后 diagnostics 4/4，退出 0。
- ID 与日志契约 → 复用既有契约、配置、真实 SQLite 约束测试；未创建只镜像实现的新测试。
- 诊断模块或数据库本身不可用时，无法保证持久化错误诊断；boundary 仍返回脱敏 internal 并记录 stderr。recordDiagnostic 的失败保持非致命。
- 多用户浏览器端到端、并发创建、高负载、冷 pnpm store、静态托管/CDN rewrite 不在本次验证范围。a-base 的真实 Pi 流程没有额外复跑；既有断言保留。

C1 另用 Drizzle SQLiteSyncDialect 比较新 CHECK 与原有 SQL 的输出及参数，断言完全相同：

```text
PASS unchanged diagnostic CHECK SQL {"sql":"\"diagnostic_event\".\"level\" in ('debug', 'info', 'warn', 'error')","params":[]}
```

C6 的额外数据保留验收通过 `/tmp/p1-refine-data-safety.mjs` 驱动完整 b 脚本，上限 300 秒，前后比较仓库 data/ 中全部文件的 SHA-256，并确认独立验收数据库存在。没有删除用户文件，验收哨兵保留在忽略的 data/ 内。输出为：

```text
bash scripts/verify/b-tooling.sh: exit=0; signal=null
PASS clean install and production smoke preserve data hashes: {"data/p1-refine-preserve.txt":"e6f4d9e839941247eb68ffd2c0d733f06888fa443d0246a6b87ac65acca0ebf8","data/sprout.sqlite":"da63a52bdf62b3fc863995d79f497584be3ba97c1de4c55d1d301afbafab6cfc"}
PASS isolated .verify/b-tooling/verification.sqlite exists
EXIT_CODE=0
```

所有验收脚本均通过 bash -n，逐项检查脚本删除目标仅涉及 node_modules、dist、.output 或 .verify 下的隔离库/cookie，没有 verify 脚本删除仓库 data/。drizzle/ 与 pnpm-lock.yaml 相对 main 的 diff 为空。

日志索引：安装 `/tmp/p1-refine-install.log`；首次 check `/tmp/p1-refine-check.log`、最终 check `/tmp/p1-refine-check-final.log`；全套 test `/tmp/p1-refine-test.log`（b 又完整运行一次）；构建 `/tmp/p1-refine-build-1.log`、`/tmp/p1-refine-build-2.log`、`/tmp/p1-refine-builds.log`；runtime 最终 `/tmp/p1-refine-d-runtime-final.log`；Project `/tmp/p1-refine-e-project.log`；认证 `/tmp/p1-refine-c-data-auth.log`；文档 `/tmp/p1-refine-f-docs.log`；干净安装 smoke `/tmp/p1-refine-b-tooling.log` 与 `/tmp/p1-refine-data-safety.log`。红绿证据分别为 `/tmp/p1-refine-project-red.log`、`/tmp/p1-refine-project-green.log`、`/tmp/p1-refine-diagnostics-red.log`、`/tmp/p1-refine-diagnostics-green.log`。各脚本详细子命令输出保存在对应 .verify 目录。

C1–C6 与要求的文档、验收均完成，无未解决阻塞。仅额外的 a-base 全套真实 Pi 验收未复跑，不属于本次必跑清单；其生产/dev 数据库隔离设置与不删除 data 的改动已做源码及 shell 语法检查。
