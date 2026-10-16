# P0-c: 常驻 Effect runtime 与 TanStack Start 共进程

- unit: p0-c-runtime
- branch: p0/p0-c-runtime
- 实验代码: `experiments/runtime-host/`
- 重跑入口: `cd experiments/runtime-host && npm install && bash scripts/verify.sh`
- 日期: 2026-10-16
- 参考的原 Sprout 仓库（`~/workspace/sprout`）: 未复用其源码，因此不记录参考 commit SHA。

## 结论先行

**共进程成立，可以在 P1 继续按「Web 与后台同进程」推进**，但必须满足两个条件，否则 HMR 会静默产生双份后台工作：

1. 常驻 runtime 必须是进程（准确说，是承载 SSR 的运行时单元）级单例，用 `globalThis` 缓存 `ManagedRuntime`，不能只靠模块级变量。模块级变量在 HMR 重新求值时会被重建。
2. 信号驱动的关闭必须挂在进程入口的主线程上，不能依赖「在 SSR 模块里 `process.on('SIGTERM')`」。生产构建在主线执行，模块内注册有效；dev 模式由 Nitro 把 SSR 放进 worker thread，模块内注册的 listener 收不到进程信号。

证据不支持把后台拆成独立进程。没有任何一项验证点要求跨进程边界。

## 环境与版本

| 组件 | 版本 |
| --- | --- |
| Node | v26.11.1 |
| vite | 8.3.4 |
| effect | 4.0.5 |
| @tanstack/react-start | 1.169.2 |
| @tanstack/react-router | 1.170.44 |
| react / react-dom | 19.x |
| nitro | 3.0.260903-beta |

`effect@4.0.5` 是实验时的当前稳定版。Effect 4 与 3 的 API 有差异，本实验实际用到的是 `ManagedRuntime.make`、`Layer.effect`（Effect 4 里取代了 3 的 `Layer.scoped`，自带 layer scope）、`Scope.addFinalizer`、`Effect.forkScoped`、`Effect.forever`、`Effect.sleep`、`Effect.ensuring`。

## 实验构成

`experiments/runtime-host/src/server/runtime.ts` 是唯一的被测单元。

- 模块级 `ManagedRuntime.make(HostRuntime.layer)`，layer 持有一个 `Effect.forever(Effect.sleep("1 second"))` 的后台 fiber，每秒给计数器 +1 并推送给订阅者。
- 两个 `Scope.addFinalizer`，用于观察关闭顺序；后台 fiber 用 `Effect.forkScoped` 挂在 layer scope 上，scope 关闭时被中断。
- `globalThis.__sproutHostRuntime__` 保存 `ManagedRuntime`、构造计数、活跃 ticker 数、实例列表。`HOST_RUNTIME_SINGLETON=0` 可关闭单例防护，用于对照。
- 路由：`GET /api/counter`（读取并 bump，返回快照）、`GET /api/events`（SSE，把每个后台 tick 推给连接）、`GET /api/diagnostics`（跨模块求值的全局计数，用来暴露 HMR 泄漏）。

对照实验的关键判据是三个全局计数：`moduleEvals`（模块被求值次数）、`runtimeConstructions`（`ManagedRuntime` 创建次数）、`activeTickers`（存活的后台 ticker 数）。没有单例防护时，HMR 会让后两者增长。

## 验证点

下文命令均在 `experiments/runtime-host/` 下执行；`curl` 需绕过本机代理，统一用 `curl --noproxy '*'`。

### a) 请求完成后 runtime 状态仍在: 已验证

命令（`bash scripts/verify.sh` 的 step 1，输出见 `.verify-artifacts/a-dev-first.json`、`a-dev-second.json`、`a-dev-concurrent.json`）

```
curl --noproxy '*' http://localhost:3117/api/counter     # t=0
sleep 3
curl --noproxy '*' http://localhost:3117/api/counter     # t=3
# 30 个并发 counter 请求后
curl --noproxy '*' http://localhost:3117/api/diagnostics
```

输出摘要

- dev: 两次请求间 counter 1 -> 5，`instanceId=rt-ib0a66` 不变。
- dev: 30 个并发请求后 `moduleEvals=1`、`runtimeConstructions=1`，没有重新初始化。
- dev: SSE 连接断开后 counter 继续增长（38 -> 68），`activeTickers=1`。
- 生产: counter 1 -> 5，`moduleEvals=1`。

请求结束不销毁 runtime，也不重建它。

### b) dev HMR 是否重复初始化: 已验证（含防护前后对照）

命令（step 1 与 step 2）

```
# 单例防护开
printf '\n// hmr-probe\n' >> src/server/runtime.ts
# 等待 moduleEvals 增加后读 diagnostics
curl --noproxy '*' http://localhost:3117/api/diagnostics
# 单例防护关
HOST_RUNTIME_SINGLETON=0 npm run dev
printf '\n// hmr-probe-off\n' >> src/server/runtime.ts
```

输出摘要

- 防护开（`.verify-artifacts/b-dev-on-*`）: `moduleEvals` 1 -> 2，但 `runtimeConstructions=1`、`activeTickers=1`、`instanceId` 不变、counter 连续。日志 `module re-evaluated, reusing singleton instance=rt-ib0a66`。
- 防护关（`.verify-artifacts/b-dev-off-after.json`）: `moduleEvals` 1 -> 2，`runtimeConstructions` 1 -> 2，`activeTickers` 1 -> 2，实例列表出现第二个 `instanceId`，新实例 `ticks` 归零，旧实例的后台 ticker 仍在跑且不再被任何路由引用。

结论: 改一次代码确实会触发 runtime 模块重新求值。没有单例防护时会产生第二份常驻 runtime 和双份后台任务，旧实例泄漏。`globalThis` 单例防护有效。

HMR 由 Nitro 的 dev worker 处理（`node_modules/nitro/dist/runtime/internal/vite/dev-worker.mjs`，通过 `env-runner/vite` 持久化 SSR 环境并按失效文件重新求值），不是每请求重建模块图。

### c) 长连接 + 后台推送: 已验证（SSE）

命令（step 1 与 step 3）

```
curl --noproxy '*' -N 'http://localhost:3117/api/events?durationMs=32000'
curl --noproxy '*' -N 'http://localhost:3118/api/events?durationMs=32000'
```

输出摘要

- dev: 32s 内收到 32 个 `event: tick`，连接期间 `subscribers=1`，断开后回到 0。
- 生产: 32s 内收到 32 个 `event: tick`。
- 连接断开只做每连接清理（取消订阅），不动 runtime。

WebSocket 未验证。本实验只覆盖 SSE。

### d) 生产构建 + 生产启动: 已验证

命令（step 3）

```
npm run build
PORT=3118 node .output/server/index.mjs
curl --noproxy '*' http://localhost:3118/api/counter
curl --noproxy '*' http://localhost:3118/api/diagnostics
```

输出摘要

- 构建产物 `.output/server/index.mjs` 存在（nitro 输出）。
- 生产进程 `isMainThread=true, threadId=0`，counter 1 -> 5，`moduleEvals=1`，SSE 32 ticks。
- 生产 adapter 不会重复初始化 runtime，也不会在请求后销毁它。

### e) SIGTERM / SIGINT 的 Scope 关闭顺序: 生产已验证，dev 未验证

命令（step 3，`kill -TERM <prod pid>`）

输出摘要（`.verify-artifacts/e-prod-shutdown-order.txt`、`prod-run.log`）

```
[host-runtime] signal=SIGTERM main=true thread=0
[host-runtime] shutdown-requested reason=SIGTERM instance=rt-m2e5ez counter=37
[host-runtime] finalizer#2 ticker-interrupted instance=rt-m2e5ez ticks=35 activeTickers=0
[host-runtime] finalizer#1 close-subscribers instance=rt-m2e5ez counter=37 ticks=35 subscribers=0
[host-runtime] shutdown-complete
```

生产环境顺序正确且可重复: 先停止后台 fiber（`finalizer#2`），再关闭订阅者（`finalizer#1`）。finalizer 逆注册顺序执行，`Effect.forkScoped` 的后台 fiber 先于之前注册的 finalizer 被中断。nitro 自身打印 `Stopping server gracefully (5s)...`，两个 listener 共存。

dev 模式**未验证**，且在当前实现下不成立: dev SSR 运行在 Nitro 的 worker thread 里（diagnostics 返回 `isMainThread=false, threadId=1`），模块内注册的 `process.on('SIGTERM')` 收不到发往进程的信号。`listenerCount('SIGTERM')` 为 1，但 kill 主进程后 dev 日志里没有任何 `shutdown-requested` / `finalizer` 行。dev 下进程结束时 worker 被直接终止，Effect scope 不执行。

## 未验证项

- dev 模式信号驱动的优雅关闭（见 e）。要补，需要在 Vite/Nitro 主线程侧挂 hook，再通过 env-runner 通知 worker 里的 runtime 释放。
- WebSocket 长连接。
- `vite.config.ts`、依赖、插件变化导致的 worker 重启 / 全量 reload 行为。
- 生产进程崩溃、重启后的状态恢复（超出 P0-c 范围）。
- 浏览器端行为；本实验只验证服务端。
- 真实 Pi、数据库、外部基础设施（本 unit 不引入）。

## 对架构说明的影响

与 `docs/architecture-direction.md`「让运行生命周期独立于请求」**不冲突**，该假设得到证据支持。建议在该节补一条约束，因为这是实验发现的、原描述未覆盖的点：

> 常驻 runtime 的单例防护与关闭顺序必须绑定到进程入口的主线程。SSR 代码可能在 worker thread 中执行（TanStack Start dev 由 Nitro `env-runner` 提供），其中注册的进程信号监听不会触发。生产入口在主线执行，dev 入口由 Vite/Nitro 拥有。

其余选择（Effect Scope 管理连接与临时资源、run Scope 结束不释放业务租约）不在本实验范围，未涉及。

## 重跑

```
cd experiments/runtime-host
npm install
bash scripts/verify.sh
```

脚本会依次跑 dev 单例开、dev 单例关、生产构建与启动，逐项打印 PASS/FAIL，原始证据写到 `.verify-artifacts/`（该目录 gitignore）。脚本会临时给 `src/server/runtime.ts` 追加一行注释触发 HMR，退出时还原。全流程约 2.5 分钟，其中三个 32s 的 SSE 观测占大头。
