# contract-checks

P0 第 7 条：身份、事务与授权契约的约束验证。契约结论见
[`docs/p0/contracts.md`](../../docs/p0/contracts.md)。

## 运行

```bash
npm install
bash scripts/verify.sh      # tsc --noEmit + 真实 SQLite 断言，退出码即结论
```

`src/run.ts` 单跑检查套件；`scripts/verify.sh` 把输出写到 `.verify/checks.log`。

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/schema.ts` | 契约级 Drizzle schema。互斥与唯一性写成数据库约束 |
| `drizzle/0000_*.sql` | 由 schema 生成的迁移，含三个部分唯一索引与 CHECK 约束 |
| `src/operations.ts` | 数据库表达不了的提交协议（幂等解析、指纹绑定、事务交接、唤醒合并） |
| `src/checks-contract.ts` | 每条契约一个「尝试违反 → 必须失败」用例 |
| `src/checks-concurrency.ts` | 多连接同时抢租约、同时建分身、同时提交同一执行 |
| `src/concurrent-worker.mjs` | worker_threads 工作线程，各开独立 better-sqlite3 连接 |

不实现业务逻辑，不接 Web 层。数据在内存库或 `.verify/` 下的文件库里，跑完即弃。
