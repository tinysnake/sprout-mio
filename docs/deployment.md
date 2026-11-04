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
| 对话接续 | 开 | 开（`drill/env` 设 `true`） | 关 |
| 端口 | 3220 | 3221 起 | 3000 |

运行根目录可以在任意位置，默认 `~/sprout-runtime`。脚本按这个顺序解析：

1. `SPROUT_RUNTIME_ROOT` 环境变量；
2. `~/.sprout-runtime-root` 指针文件的第一行（可用 `SPROUT_RUNTIME_ROOT_FILE` 改路径）；
3. `~/sprout-runtime`。

三条路径都必须是绝对路径，脚本不接受相对路径，也不从仓库位置推导。把运行根目录放到别的盘上也一样：

```bash
printf '%s\n' /Volumes/Data/sprout > ~/.sprout-runtime-root
bash scripts/deploy/init-instance.sh prod
```

prod 的代码 checkout（`$SPROUT_RUNTIME_ROOT/prod/app`）从远端 clone，默认取开发 checkout 的 `origin`，可用 `SPROUT_DEPLOY_REMOTE` 指定。部署脚本不使用开发 checkout 的路径，所以 prod 可以整体搬走，只要重跑一次 `init-instance.sh` 与 `promote.sh`。

`SPROUT_CONTINUATION_ENABLED` 是实例级开关，默认 `true`，只接受 `true` 或 `false`。关掉后运行时不装判定器、不启动调度器、判定边界直接拒绝，`/api/health` 的 `continuationEnabled` 报告实际取值。`init-instance.sh` 建实例时写入 prod `true`、drill 与 dev `false`；`verify.sh` 按该实例 env 里声明的值校验 `/api/health` 是否一致，改这一项要重启实例才生效（旧名 `SPROUT_AUTOMATION_ENABLED` 会被忽略，等于没设）。`deploy-continuation-off` 门禁在两种取值下各跑一遍并比对证据：关闭时到期排期不被认领、不产生判定与投递、两个模型边界调用数为 0；打开时同一轮判定与投递各发生一次，付费模型调用数为 0。

`SPROUT_WAKE_THRESHOLD_VERSION`、`SPROUT_WAKE_LLM_MODEL`、`SPROUT_WAKE_JEV_MODEL` 与 `JEV_API_KEY` 是唤醒判定的部署配置，都是可选项：不配时实例照常运行，只是 Project 设置页里的判定器选项按可用性置灰，保存配置会返回 `wake_provider_unavailable`。

| 变量 | 作用 | 缺失时 |
| --- | --- | --- |
| `SPROUT_WAKE_THRESHOLD_VERSION` | 判定口径版本，两个 provider 共用 | 两个判定器都不可选 |
| `SPROUT_WAKE_LLM_MODEL` | LLM 判定器的模型，写作 `provider/model` | LLM 判定器不可选 |
| `SPROUT_WAKE_JEV_MODEL` | JEV 判定服务的模型 | JEV 判定器不可选 |
| `JEV_API_KEY` | JEV 判定服务的凭据 | JEV 判定器不可选（`missing_credentials`） |

浏览器只选 provider：模型与阈值版本由服务端在保存时从 env 取，写进 Project 的 `wake_policy`（`configRevision` 每次递增，写入经审计路径 `project_wake_policy_command`）。由此带来三条口径：

- 判定记录上的 `version` 就是保存时的 `SPROUT_WAKE_THRESHOLD_VERSION`；改这个值等于换口径，历史记录保留旧版本。
- JEV 服务返回的阈值版本与 policy 不一致时按失效处理（`src/domain/wake-providers/jev.ts:47`）。
- policy 省略 `model` 时运行时用宿主 pi 的默认模型补齐（读 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent` 的 `settings.json`）；实例自己的 `SPROUT_PI_DATA_DIR` 与判定器模型无关。

prod 当前取值（2026-11-04，`prod/env`）：`SPROUT_WAKE_THRESHOLD_VERSION=p6a-design-default-v1`、`SPROUT_WAKE_LLM_MODEL=magpie/auto/deepseek-v4.1-flash`，未配 JEV。`init-instance.sh` 不写这些变量——判定器是可选的实例能力，需要哪个就手工加进 `$SPROUT_RUNTIME_ROOT/<实例>/env`，再用 `launchd.sh` 重启。样例见仓库根目录的 `.env.example`。

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

仓库里只允许出现 `.env.example` 的键名。`scripts/verify/deploy-leaks.sh` 逐项检查：`.gitignore` 是否真的忽略运行产物、tracked 路径里有没有运行产物、tracked 文件里有没有密钥形状的字符串、以及实例环境变量的值有没有出现在任何 tracked 文件里。

## 实例出网

实例的 git 子进程继承实例进程的环境变量。launchd 托管的实例只拿到 plist 里的 `PATH`、`SPROUT_RUNTIME_ROOT` 与实例 `env` 里的变量，所以跑在需要代理的网络上的实例，代理必须写进该实例的 `env`；写在开发者 shell 里的 `https_proxy` 对 prod 无效。用 `promote.sh` 以 nohup 起的实例会额外带上传入 shell 的环境，两者的代理来源不同。git 自己仍会读 `$HOME/.gitconfig`，`GIT_CONFIG_NOSYSTEM=1` 只关掉 system config。

直连被拦时看到的是这类报错：`Error in the HTTP2 framing layer`，或 `Failed to connect to github.com port 443 after <n> ms`。拦截是间歇的，同一个入口可能一会儿通一会儿不通，所以判断实例自己的出网要看探针结果与 `repo_checkout` 有没有建成，不能看某一次 curl。

代理可以在两个层级上给。实例整体走代理用 `http_proxy`、`https_proxy`，配 `no_proxy` 排掉本机与内网（`localhost,127.0.0.1,<实例所在主机的内网 IP>,::1`），否则实例之间与浏览器访问也会绕进代理。这会让 Pi 的模型调用等其它 https 出口一起走代理，这是产品上的选择，不是技术上的限制：prod 现在是这个配置。

只想让 git 出去时，用 `GIT_CONFIG_*` 三元组按 URL 前缀配，只对目标主机生效：

```text
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=http.https://<host>/.proxy
GIT_CONFIG_VALUE_0=http://<代理主机>:<端口>
```

两个层级可以同时开：实例整体系代理负责 git 之外的子进程（包安装、curl），`GIT_CONFIG_*` 把 git 钉在同一个出口上，`http_proxy` 被去掉时 git 仍然能出去。prod 两样都有。

具体值不要写进仓库。`scripts/verify/deploy-leaks.sh` 会拿实例 `env` 里键名形如 `[A-Za-z0-9_]+`、值长度不小于 16 的项去 grep tracked 文件，写了就红。

出网检查是 preflight，不是每次校验都要跑的不变量。`SPROUT_VERIFY_EGRESS=1 bash scripts/deploy/verify.sh prod` 会对库里每个 http(s) 远端做一次 `ls-remote --heads`，30 秒上界内没有成功就 FAIL。`scripts/deploy/promote.sh` 在 clone 之前带这个开关跑一次，失败就在动 prod 之前退出；部署后的校验、`rollback.sh`、`drill.sh` 与 `rehearse.sh` 的部署后校验不带开关，所以断网不会把一次已经成功的部署回滚。`scripts/deploy/selftest.sh` 的两个负向用例也带开关。

检查是近似：探针只清掉调用方 shell 自己设的代理变量（实例 `env` 里写的照常生效），关掉终端交互提示，并按进程组在 30 秒后强杀（1 秒轮询，最坏再多 2 秒）。它仍和实例共用 `$HOME/.gitconfig`，也不是在实例进程的环境里跑的。

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
| `scripts/deploy/rekey-ids.sh <instance>` | 把实例库与 `repos/`、`pi/` 里的旧格式 id 重写成 `前缀_8 位 hex`，幂等 |
| `scripts/deploy/drill.sh <sha>` | 在演练实例上部署某个提交并做健康检查 |
| `scripts/deploy/promote.sh <tag>` | 把某个 tag 部署到 prod，失败自动回滚 |
| `scripts/deploy/rollback.sh [备份文件]` | 恢复最近一次（或指定）备份并切回上一个 tag |
| `scripts/deploy/verify.sh <instance>` | 校验实例后置状态，含 `/api/health` 里的 `continuationEnabled` |
| `scripts/deploy/selftest.sh` | 在临时运行根目录里把上面整条链路跑一遍 |
| `scripts/deploy/rehearse.sh` | 用本地裸远端演练首次部署、升级、回滚三条路径 |
| `scripts/deploy/reset-password.sh <实例> <邮箱>` | 直接改某个账号的密码，不依赖发信服务 |
| `scripts/deploy/launchd.sh install\|uninstall\|status [实例]` | 用 launchd 托管实例：开机自启、崩溃重起 |
| `scripts/deploy/serve.sh <实例>` | 前台跑实例，供 launchd 调用 |
| `scripts/worker/package.sh <输出目录>` | 从构建产物里取出两个文件并校验只依赖 node 内置模块 |


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
6. 把库里的旧格式 id（`前缀_UUID`）重写成 `前缀_8 位 hex`，同时改名 `repos/` 与 `pi/` 下的目录（`scripts/deploy/rekey-ids.sh`）。
7. `pnpm build`。
8. 重启服务并等 `/api/health` 通过。

第 4 步是关键。迁移是单向的，跑错就没得退，所以先在副本上跑一遍并比对快照，再动真库。

第 6 步也是单向的。`rekey-short-ids.ts` 幂等，完成标记写进库（`__id_rekey_done`），第二次运行零变更；它在单个事务里改写 id 列与外键列、摘除并重建身份不可变触发器、跑 `foreign_key_check`，失败整体回滚。文件系统阶段在数据库提交之后，中断时可单独重跑 `--fs` 续上（由库里的 `id_map` 驱动，不靠重算）。散文列 `message.body` 与 `turn_context.serialized_text` 里的旧 id 原样保留。

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

## Worker 机器接入

Worker 机器用源码装，仓库里不提交构建产物。它需要 `git`、`node` 与 `pnpm`：`pnpm` 只用来把仓库依赖装一次，运行期不用。

```bash
git clone --branch <tag> <仓库地址> ~/sprout-worker
cd ~/sprout-worker && pnpm install --frozen-lockfile
pnpm worker:build                      # 产出 dist/worker/main.js 与 dist/worker/runner.js
node ~/sprout-worker/dist/worker/main.js version
node ~/sprout-worker/dist/worker/main.js init --server https://sprout.example \
  --machine <machine-id> --ticket-file <一次性票据文件> --state-dir ~/sprout-worker-state
node ~/sprout-worker/dist/worker/main.js run --state-dir ~/sprout-worker-state
```

更新：`git -C ~/sprout-worker fetch --tags && git -C ~/sprout-worker checkout <新 tag>`，再跑一次 `pnpm install --frozen-lockfile && pnpm worker:build`。

依赖只在构建时用。`dist/worker/main.js` 与 `dist/worker/runner.js` 只 import node 内置模块，两个文件放同一目录就能运行，所以想搬到没有 `node_modules` 的地方拷这两个文件即可；`scripts/worker/package.sh <输出目录>` 会把它们连同 `VERSION` 一起打出来。`worker-artifact` 门禁每次都重新构建、在空目录里跑 `version`（确认运行期不依赖 `node_modules`）、检查 `init`/`run` 出现在 help 里、并对缺失参数报错，同时校验 `docs/deployment.md` 写的命令与 `package.json` 真实存在。

## 常驻：launchd

prod 交给 launchd 托管，`start.sh` 与 `stop.sh` 自动认这条路：

```bash
bash scripts/deploy/launchd.sh install prod     # 写 ~/Library/LaunchAgents/dev.sprout.prod.plist 并加载
bash scripts/deploy/launchd.sh status prod      # 看作业状态
bash scripts/deploy/launchd.sh uninstall prod   # 卸载并停止
```

`KeepAlive` 为真，进程崩了十秒后自动重起，登录后自动加载。plist 里的 `PATH` 固定成 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`，所以 node 必须在这几条路径里（Homebrew 装的就在）。日志写在 `$SPROUT_RUNTIME_ROOT/prod/logs/launchd.{out,err}.log`。

装了 launchd 之后 `stop.sh` 用 `launchctl bootout`（`KeepAlive` 下 `kill` 会被立刻重起），`start.sh` 用 `bootstrap` 或 `kickstart -k`，不再写 pid 文件。`promote.sh` 因此仍然是一句话完成升级。

plist 里记着它属于哪个运行根目录，`launchd_installed` 会核对这一项，所以临时运行根目录（selftest、rehearse）里的同名实例不会去碰真实的 prod 作业。

`promote.sh` 会先 `reset --hard` 再 `clean -fd` 部署目录，因为本地改动或残留的未跟踪文件都会挡住 checkout。所以不要手改 `$SPROUT_RUNTIME_ROOT/prod/app` 里的文件，那里只该有构建产物与依赖。

drill 不需要常驻，用 `drill.sh` 起、验完停。

## 请求日志与测量窗口

runtime 给每个 HTTP 请求往 stdout 写一行 `[request]`，字段是 requestId、method、path、fn、fnId、status、ms、bytes、complete。`path` 只含 pathname，不含 query 与 cookie。`/_serverFn/<hash>` 会按构建产物里的 `createServerRpc` 聚合表还原成函数名；dev 没有构建产物，只留 hash，这是预期退化。

这些行落在 `$SPROUT_RUNTIME_ROOT/prod/logs/launchd.out.log`（`start.sh` 直接起动时是 `logs/server.log`），没有轮转。按每行 150 到 200 字节估算，一个空闲标签页每 3 秒取一次 section 约 25 MB 每天，所以它默认关闭，只在测量窗口打开。

打开开关要写实例 env 文件 `$SPROUT_RUNTIME_ROOT/prod/env`（`SPROUT_REQUEST_LOG=on`），再 `bash scripts/deploy/launchd.sh uninstall prod` 与 `install prod` 让它生效。量完把那一行改回 `off` 或删掉，再重启一次并把旧日志清空。

```bash
node scripts/diagnostics/request-log.mjs "$SPROUT_RUNTIME_ROOT/prod/logs/launchd.out.log"
```

脚本按函数聚合 count、总字节、p50、p95、max 与 5xx 计数。`ms` 对 server function 是处理耗时，对流式 HTML 是产出加写完全文的耗时，两组不要直接比 p95。

## Worker 机器（执行环境）

两件事不要混。**Pi 会话**由实例自己托管：`SPROUT_PI_ENABLED` 默认 `true`，会话目录是实例 env 里的 `SPROUT_PI_DATA_DIR`。**Machine** 是一台提供执行环境的机器，分身通过它跑 shell 与文件操作，由一个常驻的 Worker 进程代表。

本机同时跑 prod 与它的 Worker 时，两者目录分开：

```bash
bash scripts/deploy/worker.sh prepare prod v0.1.4      # 克隆到 prod/worker/app 并构建
# 在 prod 页面里建一台 Machine，取一次性票据文件
bash scripts/deploy/worker.sh enroll prod <machine-id> <票据文件>
bash scripts/deploy/worker.sh install prod             # 交给 launchd，崩溃重起、登录自启
bash scripts/deploy/worker.sh status prod
```

`prepare` 用独立 clone，不用 worktree：`promote.sh` 会对部署目录做 `reset --hard` 与 `clean -fd`，worktree 又与开发 checkout 共用 `.git`，两条都会把 Worker 的代码卷进去。Worker 自己的身份、outbox 与日志在 `prod/worker/state` 与 `prod/worker/logs`。

prod 升级之后 Worker 要单独跟一次：`worker.sh prepare prod <新 tag>`，再 `uninstall` + `install` 让它换上新代码。升级前先 `worker.sh` 里的 `version` 看一眼 `protocol=`，两边协议版本必须一致。

## 账号

实例不预置账号。第一次打开 `/login` 切到「注册」，填名字、邮箱、密码，这个账号就是 Human（Project 创建者）。注册接口在部署后是开着的，谁走到这个地址谁都能注册；实例只在局域网内时这是可接受的，对外暴露前要先加限制。

忘记密码不发邮件，用脚本改：

```bash
bash scripts/deploy/reset-password.sh prod you@example.com
```

它借实例自己那份 `better-auth` 算哈希，直接写 `account.password`，所以和登录接口用的是同一套算法。

## 反向代理与 PWA

PWA 需要安全上下文，所以 prod 前面要有 HTTPS。用 Caddy 或 `tailscale serve` 终止 TLS，转发到 `127.0.0.1:3220`，并把 `APP_ORIGIN` 设成对外那个 https 地址。`APP_TRUSTED_ORIGINS` 用于同一进程经不同内网地址访问的情形。

## 未确认项

- 远端 Worker 的凭据存储形态，见上文。
- `SPROUT_CONTINUATION_ENABLED=false` 时是否还有未覆盖的对话接续入口。`deploy-continuation-off` 门禁覆盖运行时接线、调度器、投递路径与两个判定器边界。

## 验证

```bash
bash scripts/verify/deploy-continuation-off.sh  # 实例开关的关闭与打开对照
bash scripts/verify/deploy-leaks.sh     # 隐私数据不进仓库
bash scripts/verify/worker-artifact.sh  # 源码安装构建后运行期只要 node
bash scripts/deploy/selftest.sh         # 脚本链路自检
bash scripts/verify/deploy-selftest.sh  # 上面的门禁入口
```
