# P7 存储运维入口

本目录的脚本是 P7 的运维/验收入口，不挂在页面上，也不由请求路径触发。

## 一致备份

```bash
node --import tsx scripts/p7/storage/snapshot.ts backup \
  --database data/sprout.sqlite \
  --out /absolute/new/dir/sprout-$(date -u +%Y%m%dT%H%M%SZ).sqlite
```

- 用 SQLite `VACUUM INTO` 生成单文件快照。它在一个读事务里写出新库，包含 WAL 中**已提交但尚未 checkpoint** 的事务；直接 `cp` 主库文件会漏掉这些事务，反证在 `tests/storage-snapshot.test.ts`。
- 目标路径必须不存在；脚本不覆盖任何既有文件。输出 JSON 含大小、sha256、`integrity_check`、`foreign_key_check`、迁移数与各表行数。
- 不需要同时复制 `-wal` / `-shm`。快照创建后是独立文件。

## 恢复

```bash
# 1. 先停服务（SIGTERM，确认 runtime_boot.phase = stopped）
# 2. 恢复到全新目录（目标文件必须不存在）
node --import tsx scripts/p7/storage/snapshot.ts restore \
  --backup /absolute/backup.sqlite \
  --database /absolute/restored/sprout.sqlite

# 3. 用恢复后的库启动生产服务
DATABASE_URL=/absolute/restored/sprout.sqlite \
  APP_ORIGIN=http://127.0.0.1:3000 \
  PORT=3000 NITRO_PORT=3000 \
  node .output/server/index.mjs
```

恢复脚本先完整校验备份（`integrity_check`、`foreign_key_check`），复制到同目录临时文件并 `fsync` 后原子改名； refuses 已有目标。服务启动时由现有 `migrateDatabase` 再校验迁移与外键，并把上次未关闭的 `queued`/`running` run 恢复为 `interrupted`，不会把未知执行写成成功。

## 验证入口

```bash
bash scripts/verify/p7-storage-recovery.sh
bash scripts/verify/p7-service-baseline.sh
```

- `p7-storage-recovery`：空库→0028、0025 历史库首次启动升级、重跑幂等、历史消息/引用/FK、在线备份期间并发写入的分组原子性、主库文件复制反证、全新目录恢复启动、旧 run/execution 非成功、诊断关联链、同版本重启 boot 边界。
- `p7-service-baseline`：生产构建上的 5 个本地 HTTP 端点（单对象/列表/分页）p50/p95；日志 512 帧 × 1 KiB 的 cursor 分页完整性与延迟；Worker outbox 4 MiB 高水位/1 MiB 低水位回落。数字写入 `.verify/p7-service-baseline.json`，不设产品 SLA。

## 备份不覆盖的边界

数据库单文件不等于整个执行现场。Worker 的本地 journal/结果文件、Git checkout、模型 session 文件仍在数据库之外；跨机恢复、真实磁盘满与物理断电未验证。恢复时以 `runtime_boot`、run、execution 行和 Worker 归约事实为准，不把缺证据的状态补成成功。
