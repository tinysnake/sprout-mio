# 部署与实例

本文定义 Sprout 部署到一台常驻机器上的运行时形态、实例隔离规则与操作入口。仓库只放代码与脚本，运行时状态全部落在仓库外的运行根目录。

## 为什么要把运行时挪出仓库

`DATABASE_URL` 默认 `./data/sprout.sqlite`，相对当前工作目录解析。结果是每个 worktree 都长出一份库，切换分支、重开目录、跑演练都会分叉出互不相干的数据。`data/` 虽然在 `.gitignore` 里，但「靠 ignore 保护隐私」只挡得住手滑提交，挡不住把库拷来拷去。

运行根目录之外的东西，一律不算运行时状态：仓库里的 `data/`、`.verify/`、`orchestrate/` 都只是本机临时产物，可以随时删。

## 实例

一个实例 = 一份运行根目录 + 一个数据库 + 一套 Pi 目录与仓库目录 + 一个端口。

| | prod | drill | dev |
| --- | --- | --- | --- |
| 用途 | 正式使用 | 拿 prod 数据验新代码与新迁移 | 日常开发 |
| 数据库 | `$SPROUT_RUNTIME_ROOT/prod/data/sprout.sqlite` | `drill/data/sprout.sqlite`（每次从 prod 备份刷新） | `dev/data/sprout.sqlite`（按需刷新） |
| Pi 目录 | `.../prod/pi` | `.../drill/pi` | `.../dev/pi` |
| 仓库目录 | `.../prod/repos` | `.../drill/repos` | `.../dev/repos` |
| 自动化 | 开 | 关（`SPROUT_AUTOMATION_ENABLED=false`） | 关 |
| 端口 | 3220 | 3221 起 | 3000 |

运行根目录默认 `~/sprout-runtime`，可用 `SPROUT_RUNTIME_ROOT` 覆盖。

`SPROUT_AUTOMATION_ENABLED` 是实例级开关，默认 `true`，只接受 `true` 或 `false`。关掉后运行时不装判定器、不启动调度器、判定边界直接拒绝，`/api/health` 的 `automationEnabled` 报告实际取值。`deploy-automation-off` 门禁在两种取值下各跑一遍并比对证据：关闭时到期排期不被认领、不产生判定与投递、两个模型边界调用数为 0；打开时同一轮判定与投递各发生一次，付费模型调用数为 0。

```text
~/sprout-runtime/
  prod/
    env            # 实例环境变量，chmod 600，不进仓库
    data/sprout.sqlite
    backups/
    pi/
    repos/
    app/           # 干净 checkout，只在部署时更新
  drill/
    env
    data/sprout.sqlite
    backups/
    pi/
    repos/
    app/
  dev/
    env
```

## 三条不变量

脚本与门禁保证这三条，不靠记性。

1. **一个数据库同时只有一个进程。** 调度器在进程内跑，两个进程挂同一个库会重复判定、重复投递。
2. **`DATABASE_URL` 必须是绝对路径，且不在仓库内。** 相对路径会被解析到 checkout 里，直接违反上一条。
3. **实例之间不共用 Pi 目录、仓库目录与端口。** 共用 Pi 目录会混 session，共用仓库目录会让两个实例抢同一批 worktree。

## 隐私数据

会泄露的只有四类，四类都在运行根目录里：

- 实例环境变量里的密钥（`BETTER_AUTH_SECRET`、`JEV_API_KEY`、模型凭据）。
- 数据库文件与其 WAL/SHM。
- 备份文件。
- 远端 Worker 的机器凭据（哈希在库里，原文在机器上）。

仓库里只允许出现 `.env.example` 的键名。`scripts/verify/deploy-leaks.sh` 逐项检查：`.gitignore` 是否真的忽略运行产物、tracked 文件里有没有密钥形状的字符串与绝对家目录路径、以及实例环境变量里的值有没有出现在任何 tracked 文件里。

## 机器与凭据

Machine 是远端 Worker，注册与连接是两件事：

- **注册**用一次性 ticket 换长期凭据，每个实例做一次。A 连三个实例就是三次注册。
- **连接**是 Worker 拿凭据按间隔轮询，凭据在手就一直连得上。

所以刷新演练数据不重新注册。做法是：拷 prod 的库（机器 id 原样保留，历史租约与执行记录继续有效），然后把副本里 `machine_credential.secret_hash` 改写成演练实例那把凭据的哈希。Worker 不知道库被换过。

演练实例的固定凭据原文存在 `$SPROUT_RUNTIME_ROOT/drill/env` 的 `SPROUT_DRILL_MACHINE_SECRET` 里，由 `refresh-data.sh` 写入哈希。

同一个物理机器连两个实例时，Worker 上报的 `rootDirectory` 必须不同，否则两个实例的 Worker 会抢同一批检出。这是机器侧的配置。

远端 Worker 如何保存「机器 id + 凭据」这一对，目前没有确认。如果只支持一组，就要为每个实例跑一个 Worker 进程，各自带自己的配置。这不影响注册一次的性质。

## 操作入口

所有操作都走脚本，不提供「也可以手动这样」的路径。脚本自己检查前置条件与后置状态，任何一步不满足就退出，不半途继续。

| 命令 | 作用 |
| --- | --- |
| `scripts/deploy/init-instance.sh <instance>` | 建运行根目录、生成 `env`、初始化空库 |
| `scripts/deploy/backup.sh <instance>` | `VACUUM INTO` 备份并校验完整性 |
| `scripts/deploy/refresh-data.sh <instance>` | 从 prod 备份刷新目标实例的数据，重写机器凭据哈希 |
| `scripts/deploy/start.sh <instance>` | 起服务、写 pid 文件、等健康检查通过 |
| `scripts/deploy/stop.sh <instance>` | 先 SIGTERM，十秒不退再 SIGKILL |
| `scripts/deploy/check-migration.sh <db>` | 在库副本上先跑一次迁移并比对表数量与完整性 |
| `scripts/deploy/drill.sh <sha>` | 在演练实例上部署某个提交并做健康检查 |
| `scripts/deploy/promote.sh <tag>` | 把某个 tag 部署到 prod，失败自动回滚 |
| `scripts/deploy/rollback.sh [备份文件]` | 恢复最近一次（或指定）备份并切回上一个 tag |
| `scripts/deploy/verify.sh <instance>` | 校验实例后置状态，含 `/api/health` 里的 `automationEnabled` |
| `scripts/deploy/selftest.sh` | 在临时运行根目录里把上面整条链路跑一遍 |

`selftest.sh` 是这套脚本自己的门禁。它不复述文档，而是真的建目录、建库、备份、刷新、校验，然后断言每一步的后置状态。文档与脚本不一致时它会红。

## 部署 prod

```bash
git tag deploy/2026-11-01-1200
bash scripts/deploy/promote.sh deploy/2026-11-01-1200
```

`promote.sh` 的顺序固定，任何一步失败都停在那一步，并在已开始改动时自动回滚：

1. 备份当前库，校验备份可打开且 `integrity_check` 通过。
2. `git fetch` 并 `git checkout <tag>` 到 `$SPROUT_RUNTIME_ROOT/prod/app`。
3. `pnpm install --frozen-lockfile`。
4. 在**库的副本**上跑迁移，用表与列快照对比确认只多了预期的变化。
5. 迁移真库。
6. `pnpm build`。
7. 重启服务并等 `/api/health` 通过。

第 4 步是关键。迁移是单向的，跑错就没得退，所以先在副本上跑一遍并比对快照，再动真库。

## 演练

```bash
bash scripts/deploy/drill.sh <sha>
```

它拷 prod 最新备份、重写机器凭据、跑迁移、构建、起在 3221、等健康检查，然后打印地址与迁移前后的表结构差异。验完 `Ctrl-C` 或者按提示停止，数据库留在 `$SPROUT_RUNTIME_ROOT/drill/data/`，下次刷新再覆盖。

## 迁移纪律

- 迁移只由部署脚本执行一次。进程启动不自动迁移。
- 迁移前必须有备份，回滚只允许「恢复备份 + 切回 tag」，不写 down migration。
- `drizzle/meta/_journal.json` 已发布的条目不许改 `when`。改了会让已经迁过的库重放该迁移，撞 `table ... already exists`，而且库会停在半应用状态。
- 迁移跑在副本上时，用 `scripts/p7/storage/snapshot.ts` 那套表与列比对当断言。

## 反向代理与 PWA

PWA 需要安全上下文，所以 prod 前面要有 HTTPS。用 Caddy 或 `tailscale serve` 终止 TLS，转发到 `127.0.0.1:3220`，并把 `APP_ORIGIN` 设成对外那个 https 地址。`APP_TRUSTED_ORIGINS` 用于同一进程经不同内网地址访问的情形。

## 未确认项

- 远端 Worker 的凭据存储形态，见上文。
- `SPROUT_AUTOMATION_ENABLED=false` 时是否还有未覆盖的自动接续入口。`deploy-automation-off` 门禁覆盖运行时接线、调度器、投递路径与两个判定器边界。

## 验证

```bash
bash scripts/verify/deploy-automation-off.sh  # 实例开关的关闭与打开对照
bash scripts/verify/deploy-leaks.sh     # 隐私数据不进仓库
bash scripts/deploy/selftest.sh         # 脚本链路自检
bash scripts/verify/deploy-selftest.sh  # 上面的门禁入口
```
