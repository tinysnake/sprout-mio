# effect-clock-spike

本实验回答一个问题：把时间决策迁到 Effect 之后，哪些真实等待能被 `TestClock` 快进，哪些不能。

它同时说明了为什么另外三条路走不通。这条结论决定了哪些代码迁到 Effect，哪些刻意留在边界类里。应用侧的规则与证据见 [runtime.md](../../docs/p1/runtime.md) 和 [pi-session.md](../../docs/p3/pi-session.md)，可执行的快进测试在 `tests/pi-host-clock.test.ts`。

## 环境

| 组件 | 值 |
| --- | --- |
| Node | v26.11.1 |
| effect | 4.0.5（`ManagedRuntime`、`Layer.effect`、`Scope.addFinalizer`、`TestClock`） |
| tsx | 仓库 devDependency，无需额外安装 |

## 运行

```bash
bash experiments/effect-clock-spike/verify.sh
```

脚本跑 `spike.ts`，把四个形状各测一次，再断言五条关系。任何一条不成立就以非零退出。原始输出留在 `.verify/effect-clock-spike/spike.log`（已 gitignore）。

单独看测量结果用 `npx tsx experiments/effect-clock-spike/spike.ts`。

## 测什么

`spike.ts` 把 pi-host 今天的形状照搬成四份，每份用不同机制实现同一个 2500ms 截止。

| 测量 | 形状 | 实测墙钟 |
| --- | --- | --- |
| A | 今天的 `setTimeout(2500)` 加 `Promise.race` | 2501ms |
| B | 同一个决策写成 `Effect.timeout("2500 millis")`，跑在 `TestClock` 上 | 11ms |
| C | 保留真实计时器，只注入 `now()` | 2536ms |
| C' | `Date.now()` 在 `TestClock` 下读到的值 | 机器时间，不是虚拟时间 |
| D | 真实 500ms 子进程套一个 10ms 的 `Effect.timeout`，跑在 `TestClock` 上 | 超时判定 1ms 触发，子进程 617ms 后才真退出 |

A 到 D 都在本机重复跑过多次，数值稳定。上面是 2026-10-18 的一次输出。

## 五条断言

1. `TestClock` 能压缩调度决策，B 远快于 A。
2. 真实计时器路径仍然消耗真实时间，A 超过 2 秒。
3. 注入 `now()` 压不动调度，C 仍然超过 2 秒。这是关键反证：仓库里已有的注入时钟模式只压缩"读数"，压不动"等待"，因为延迟来自 `setTimeout` 本身。
4. `Date.now()` 不受 `TestClock` 影响，只有 `Clock.currentTimeMillis` 受影响。因此领域代码里的时间戳不会被虚拟化，需要参与决策的时间必须走 `Clock`。
5. 真实子进程不被压缩。超时分支可以瞬间触发，但子进程仍然按真实时间退出。

## 它不宣称什么

- 不是测试套件，也不测量整个应用的墙钟。它测的是四个孤立形状。
- `verify.sh` 的断言只覆盖上表那五条关系，不覆盖 pi-host 的行为。行为由 `tests/pi-host-clock.test.ts` 和 `scripts/verify/o-turn-semantics.sh` 钉住。
- 真实子进程的耗时不可压缩这一条，是用 `node -e "setTimeout(()=>{}, 500)"` 测的，不代表所有外部 I/O 的比例关系。

第 3 条和第 5 条是怎么被用的：`src/server/pi-host/process.ts` 的 30s 与 600s 协议超时、1500ms 强杀，以及入口的 8s 排空与 9s 关闭截止，都留在原来的边界类里，没有迁到 `Clock`。理由是它们的守卫对象是真实子进程和真实事件循环，搬过去只会得到一个"快进了强杀间隔、子进程还活着"的测试。
