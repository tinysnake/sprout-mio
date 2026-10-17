# P1 graceful drain 修复报告

工作分支为 `p1/graceful-drain`，基线为 main `400c9ea`，全部工作在 host 创建的独立 worktree 完成。没有修改主 checkout、Nitro preset、node_modules、schema 或依赖。旧 runtime 文档中的空闲 SIGTERM 证据保留；它当时没有证明在途请求安全。

## 最终关闭顺序

实现位于 [server-entry.ts](../../src/server/server-entry.ts)、[http-drain.ts](../../src/server/http-drain.ts) 和 [runtime.ts](../../src/server/runtime.ts)。

1. 首次 SIGTERM/SIGINT 同步进入 draining，后到的应用请求直接返回 503，不进入认证、业务和诊断，不访问 DB。新 TCP 连接在 listener 关闭后由网络层拒绝，503 保证针对仍进入应用边界的请求。
2. 持久化 boot `stopping`。在从信号开始的 8 秒期限内，等待已接收请求的应用处理与 Node 响应结束，并等待已观察到的 Node server 发出 close。
3. 排空完成才调用幂等 `shutdownRuntime()`，dispose Effect Scope，关闭共享 SQLite 连接。
4. 独立短连接写 `stopped` 与 `stopped_at`，关闭短连接，进入内存 stopped，退出 0。

排空超时写 stderr 错误、把内存 phase history 的 result 标为 failed，退出 1；不 dispose、不写 stopped。冻结 schema 没有 failed 状态，持久 boot 保持 stopping，供下次恢复为 interrupted。9 秒总截止保留，释放或持久化失败也退出 1。定时器不能抢占阻塞事件循环的同步操作。Nitro close hook 复用同一个排空 Promise。

请求计数放在 app.fetch 请求边界，早于 Nitro request hook。锁定 Nitro 的 request hook return 值被 hookable 忽略，错误又被生成代码 catch，因此无法用该 hook 可靠地拒绝新工作或包住全部错误路径。fetch 的 finally 保证业务结束一定被标记；计数只有在业务结束和响应 finish/close 两项均成立后才释放，重复通知不会重复减计数。客户端断开时仍等待没有完成的异步业务，避免关闭 DB 后 scrypt 才返回继续写库。响应 hook 发生在发送之前，不用它递减计数。诊断模块顶层加载完毕、响应诊断同步执行，draining 时跳过，没有异步导入恢复后碰到已关闭 DB 的窗口。

## 核实到的 srvx 行为与协作

源码核对 Nitro `3.0.260610-beta` 的 node-server preset、生成的 `.output/server/index.mjs`，以及 srvx `0.11.22` 的 Node adapter 和 graceful plugin。

- Nitro 把 `tracingSrvxPlugins` 传给 serve；srvx Node adapter 仍会在用户 plugins 之外调用 gracefulShutdownPlugin。空列表不禁用该插件。普通生产运行确实注册 SIGTERM/SIGINT；CI 或 TEST 非空且没有显式 gracefulShutdown 配置时不注册。
- srvx 调用 server.close 并等待连接，默认 5 秒后强制断连接，不调用 process.exit，也不释放应用 DB。入口按 srvx 相同的 parseInt 规则把无效或小于 10 秒的 SERVER_SHUTDOWN_TIMEOUT 提升为 10 秒，确保应用 8/9 秒截止先决策。
- Nitro 不导出 srvx 句柄。当前 Node adapter 请求的 runtime.node 含原生 req/res；应用通过 req.socket.server 观察 server 的真实 close 事件。这是对当前 Node 实现的接线，Socket.server 不属于稳定的跨适配器 API，升级时必须复核。
- 信号同步设 draining 后，排空用 microtask 检查 server 是否仍 listening。普通环境先让 srvx 的 listener 发起 close，再复用 close 事件；CI/TEST 没有该 listener 时应用调用同一个 Node server.close。应用不以 srvx.close Promise 作为已关闭证明，因为该方法发现 server.listening 已为 false 时可能提前返回。
- 应用计数仍必需：连接关闭不能证明已断开的客户端对应的异步认证/业务已经停止使用 DB。反过来，fetch Promise 完成也不证明响应 body 已发完。

Context7 文档查询返回 fetch failed；上述版本相关结论来自已安装源码、生产产物和真实 HTTP，不使用最新文档代替锁定版本行为。

## HTTP 方法、证据与限制

复跑 [drain-http.sh](../../scripts/verify/drain-http.sh)，内部由 [drain-http.mjs](../../scripts/verify/drain-http.mjs) 驱动真实生产进程。脚本默认清理产物并构建；已有同版本产物可使用 SPROUT_VERIFY_DRAIN_SKIP_BUILD=1。原始响应、生产日志、独立 SQLite 与汇总在 `.verify/drain-http/`，均为忽略的本地产物，不提交认证数据。没有向生产代码加入 verify-only 慢路径。

采用真实 `POST /api/auth/sign-up/email`：先发送完整 headers 和 JSON 第一个字符，保留剩余 body，等请求进入应用后发送信号。日志确认 activeRequests=1，DB 确认 stopping 且 stopped_at=null，进程保持运行。另一个信号前只发部分 headers 的连接，在信号后补完为注册请求，得到 503；断言 rejected 用户不存在，diagnostic_event 数量不变。保持原慢上传至少 350ms 后补完 JSON，观察 HTTP 200、实际用户行、boot stopped、进程 exit 0，并断言日志顺序 stopping → drained → scope-disposed → stopped。普通环境覆盖 SIGTERM，CI=true 禁用 srvx listener 的环境覆盖 SIGINT。

该方法证明上传中的真实认证请求能跨信号继续完成解析、scrypt、用户写入和响应；不证明信号恰落在 scrypt 计算内部，也不模拟高并发、高负载或慢响应消费者。503 样本来自预先建立但尚未进入应用的 HTTP 连接，不能声称关闭 listener 后新 TCP 连接仍会收到 503。

超时样本始终不补完真实 body，约 8 秒后 exit 1，日志包含 `[runtime] 失败 stopping HTTP 排空超时 (8000ms)`，boot 为 stopping/stopped_at=null，无 scope-disposed 或 stopped。测试不止检查退出码；它排除了先写 stopped 再失败的假正常状态。

本次实测关键输出：

```text
PASS term: draining rejects new work without DB writes
PASS term: in-flight signup completes before stopped and exit 0 code=0 signal=null
PASS int-ci: draining rejects new work without DB writes
PASS int-ci: in-flight signup completes before stopped and exit 0 code=0 signal=null
PASS timeout: deadline fails without disposing DB or claiming stopped code=1 signal=null
PASS drain HTTP all checks passed
```

## 回归 red → green 与风险映射

临时把当前 worktree 的入口和 runtime 源码替换为 HEAD 基线版本，构建后运行同一个新 HTTP 探针，再完整恢复修复源码。没有改动主 checkout。基线构建退出 0，探针退出 1，关键错误如下；基线日志和 SQLite 留在 `.verify/drain-http-red/`，运行输出为 `/tmp/graceful-drain-http-red.log`。

```text
FAIL drain-http AssertionError: process exited with an unfinished auth upload;
boot={"phase":"stopped","stopped_at":1792251858}; response=""
0 !== null
```

修复后的相同探针通过。首次 green 期间探针错误地期待状态行含 200 OK，实际响应 reason phrase 为空，已改成按 HTTP 状态码断言；这是探针判断错误，没有改变生产行为。

| 风险                                             | 保护                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 信号立刻 dispose 导致业务或响应中断、boot 假正常 | 真实慢上传注册完成、用户行、停止时序和退出 0；基线 red 已复现                                     |
| draining 后新业务或诊断继续写 DB                 | 部分 headers 连接补成新注册，503、无用户行且诊断数不变                                            |
| srvx 被 CI 禁用后无人停止 listener               | CI=true 下真实 SIGINT，监听和连接关闭后 exit 0                                                    |
| 卡住的请求被标为正常 stopped                     | 真实未完成上传，8 秒错误、exit 1、stopping/null、无 dispose                                       |
| 客户端断开但异步业务仍在运行，或重复完成通知     | [http-drain.test.ts](../../tests/http-drain.test.ts) 的两项完成条件、finish/close 与重复通知      |
| 应用处理结束后仍有响应传输、排空等待泄漏         | 同一测试文件的发送结束与 deadline 行为；HTTP 证据验证实际接线                                     |
| 原 runtime 单例、恢复、关闭幂等和健康状态退化    | 原 [runtime.test.ts](../../tests/runtime.test.ts) 保持不改并通过，原 d-runtime 验收保持不改并通过 |

## 验收命令与产物

所有 bash 工具调用设置 timeout，可能超过 60 秒的步骤通过 nohup 后台运行，并读取日志确认退出码。命令在当前 worktree 实际执行。

| 命令                              | 退出码 | 关键输出                                                                                        | 本机日志                             |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| pnpm install --frozen-lockfile    | 0      | Lockfile is up to date；562 packages；Done in 3.7s                                              | `/tmp/graceful-drain-install.log`    |
| pnpm check                        | 0      | 70 files 格式通过；52 files 无 warning、lint error 或 type error                                | `/tmp/graceful-drain-check.log`      |
| pnpm test                         | 0      | 7 files、33 tests passed，包含原 runtime 测试                                                   | `/tmp/graceful-drain-test.log`       |
| bash scripts/verify/d-runtime.sh  | 0      | d-runtime all checks passed；SIGTERM 10 秒内退出 0；原 stopping/scope-disposed/stopped 顺序通过 | `/tmp/graceful-drain-d-runtime.log`  |
| bash scripts/verify/f-docs.sh     | 0      | 7 项证据、146 个内部链接/锚点、105 个仓库路径通过；f-docs all checks passed                     | `/tmp/graceful-drain-f-docs.log`     |
| bash scripts/verify/drain-http.sh | 0      | 最终版本清理重建后全部通过；SIGTERM 486ms/exit 0，CI SIGINT 507ms/exit 0，超时 8010ms/exit 1    | `/tmp/graceful-drain-http-final.log` |

原 d-runtime 验收脚本及其 SIGTERM 断言未修改。构建会输出现有模块 externalized、ineffective dynamic import 与 use client 指令告警，构建仍退出 0；这些不作为浏览器功能验收。

## 覆盖边界

已覆盖单进程 Node HTTP/1.1、上传中的认证请求、晚到应用请求的拒绝、响应完成、客户端关闭通知的计数语义、普通生产 SIGTERM、CI 下 SIGINT、boot 正常与超时状态。srvx 的 TEST 禁用条件已源码核对，没有单独再跑 TEST=true 的 HTTP 样本。

至少一个 HTTP 进入应用后才能从请求观察 server，此后 server.close 会等待该 server 的连接；首次 HTTP 之前的半连接无法由本应用取得句柄，不属于排空保证。WebSocket、dev worker 信号、完整 worker 重启、多进程、恢复事务中途崩溃、其他 HTTP 适配器、脱离请求的异步 DB 工作、慢响应消费者和高负载未验证。内部 fetch 没有 Node 响应时只等待应用处理，不声明网络传输保证。人为再次 SIGINT 仍可能触发 srvx 的 force-close 行为，不能当作单次信号的优雅关闭保证。没有把这些未验证面升级为支持。
