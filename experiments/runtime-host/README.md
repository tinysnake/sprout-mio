# runtime-host

P0-c 最小实验: 常驻 Effect runtime 与 TanStack Start 共进程。结论文档在 `docs/p0/runtime-host.md`。

## 运行

```bash
npm install
npm run dev            # http://localhost:3117
npm run build          # 产出 .output/server/index.mjs
npm start              # 生产启动，默认 3118? 见下
```

生产启动用 `PORT=3118 node .output/server/index.mjs`。

## 端点

- `GET /api/counter` 读取并 bump 常驻状态，返回快照与全局诊断
- `GET /api/events?durationMs=30000` SSE，每个后台 tick 推一帧
- `GET /api/diagnostics` 跨模块求值的全局计数，用来暴露 HMR 泄漏

## 判据字段

`moduleEvals` 是模块被求值次数，`runtimeConstructions` 是 `ManagedRuntime` 创建次数，`activeTickers` 是存活后台 ticker 数。单例防护失效时后两者会随 HMR 增长。

`HOST_RUNTIME_SINGLETON=0` 关闭 `globalThis` 单例防护，用于对照。

## 验证

```bash
bash scripts/verify.sh
```

跑 dev 单例开、dev 单例关、生产构建与启动三组，逐项 PASS/FAIL，原始证据在 `.verify-artifacts/`。
