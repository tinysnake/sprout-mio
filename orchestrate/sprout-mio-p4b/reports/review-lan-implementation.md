# p4b-review-lan 实现报告

实现提交：`3ceacc9a3c01082d1864d4aa9f07588e5a3a2dc1`。
分支：`p4b/review-lan`；基线：`796b6f652320cd1329222efb36290b14cfefef70`。

本单元完成临时 P4b 体验环境的内网访问修复。实现仅修改 `scripts/dev/p4b-review-env2.mjs` 与 `scripts/dev/p4b-running-probe.mjs`；未修改 `src/`、迁移、总计划 checklist 或 `:3000` 服务。本报告是实现者验证记录，独立集成验收、coordinator 本机复跑与 Human 体验确认仍待执行。

## Host 与 origin

数据形状沿用单一 `origin` URL 字符串，新增的 `reviewHost` 只是 hostname 输入，不新增业务状态。

1. 优先读取并 trim `SPROUT_REVIEW_HOST`。
2. 未提供时，执行 `ipconfig getifaddr en0`，该探测有 2 秒超时。
3. 探测失败时回退 `127.0.0.1`，明确输出告警，提示设置浏览设备可达的 hostname。
4. hostname 不得携带凭据、端口、路径、query 或 fragment；端口继续从临时空闲端口分配，拒绝 3000。

端口探测及应用的 `HOST`、`NITRO_HOST` 都使用 `0.0.0.0`，选择明确的 IPv4 监听以覆盖当前 macOS 的内网 IPv4 与回环访问。`APP_ORIGIN`、注册和 Fn 请求、Worker init 的 `--server` / `--allow-http`、体验文档 URL 都沿用同一个 origin；HTTP 授权仍按完整 origin 授予。探测出的 hostname 加入 `NO_PROXY` / `no_proxy`。

第一次真实启动在 running probe 处失败：该脚本原有的 `url.hostname === "127.0.0.1"` 限制拒绝了内网地址。服务、三台 Worker 均已通过内网 origin 注册并报告 capability，之后初始化退出并自行清理。这是本次 origin 变化直接触及的脚本调用方，因此在本单元一并修改：probe 只允许 HTTP、明确的非 3000 端口，并要求 hostname 的所有解析地址都属于本机接口或回环地址。实测非本机 `203.0.113.1` 与保留端口 3000 都在登录前拒绝，exit 1；没有向 3000 发请求。

## 真实验证证据

使用本 worktree 的生产构建、真实 SQLite 隔离库、新账号、macOS arm64 Worker 与 Playwright Chromium。每次环境有独立状态目录、随机账号、secret、Worker 身份和数据库。未读取或打印 `.env`、票据、cookie 值或远程操作输出。

| 检查 | 自动探测启动 | 显式 host 覆盖启动 |
| --- | --- | --- |
| 启动参数 | 不设置 `SPROUT_REVIEW_HOST` | `SPROUT_REVIEW_HOST=10.0.0.13` |
| origin | `http://10.0.0.13:51469` | `http://10.0.0.13:52743` |
| 内网 `/` | HTTP 200 | HTTP 200 |
| 回环 `/` | HTTP 200 | HTTP 200 |
| Chromium 真实邮箱密码登录 | 通过 | 通过 |
| 租约页可见 | 通过 | 通过 |
| `/machines/<id>` 不带 projectId，root 与绑定设置可见 | 通过 | 通过 |
| 页面刷新后仍保持登录 | 通过 | 通过 |
| review-info origin / login.url / 全部 detailUrl 均为内网地址 | 通过 | 通过 |
| review-info 文件权限 | 0600 | 0600 |
| SIGTERM 后环境脚本退出 | 0 | 0 |

curl 实际命令形状为：

```sh
curl --noproxy '*' --max-time 10 -s -o /dev/null -w '%{http_code}\n' http://10.0.0.13:51469/
curl --noproxy '*' --max-time 10 -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:51469/
```

第二次改用 52743，结果相同。metadata 检查直接在内存中解析 `review-info-<port>.json`，只输出通过状态，未输出登录字段值。两次启动都完成真实 Worker capability 上报、真实 fencing 场景与 running probe。

Lavish 通过仓库真实应用适配器启动：`SPROUT_HUMAN_REVIEW_APP=http://10.0.0.13:51469 node scripts/human-review/cli.mjs --port 4418 --lavish-port 4419 --strict-ports --state-dir .verify/human-review/p4b-review-lan`。描述符中的预览入口使用 `10.0.0.13:4418`，appUrl 使用 `http://10.0.0.13:51469/login`；内网入口 HTTP 200。Chromium 真实打开预览，在应用 iframe 内看到登录页、完成真实密码登录，并成功进入 Machine 设置页。仅验证预览与访问，本轮没有开始收取 Human 反馈。

截图保存在 `/tmp/p4b-review-lan-shots/`，已实际打开查看：

- `run1-login.png`、`run1-lease.png`、`run1-settings.png`。
- `run2-login.png`、`run2-lease.png`、`run2-settings.png`。
- `run1-lavish.png`、`run1-lavish-authenticated.png`。

登录截图在填入凭据前保存；租约截图遮蔽远程操作区；设置页不包含远程操作输出。

本机诊断与执行收据在 `/tmp/p4b-review-lan-checks/`，包括 `browser1.log`、`browser2.log`、`lavish-browser.log`、三条 P4a 日志与退出码、`check.log`、`typecheck.log`。这些是状态证据，不含凭据或远程操作输出。测试过程中修正了临时浏览器验证脚本的定位及响应解析；最终两轮流程均 exit 0。

## 鉴权结论与安全边界

IP origin 没有破坏登录态。本机 Chromium 直接访问和 Lavish iframe 内登录均成功；cookie 保持 `HttpOnly`、`SameSite=Lax`，host 为 `10.0.0.13`。该预览与应用使用相同 IP 和 HTTP scheme，不同端口仍能保持登录。跨主机名分享时，应让预览与应用共同使用浏览设备可达、指向本机的 hostname，并设置 `SPROUT_REVIEW_HOST` 与适配器的应用 origin。

两轮真实 HTTP / Fn 反证均通过：

- 未登录访问受保护页面跳回登录；无 cookie 的 `/api/auth/get-session` 返回 null。
- 错误密码：401；未信任的 Origin：403；正确 Origin 与真实密码：200。
- 无 cookie 调用生产构建的 `getMachineFn`：传输 HTTP 200，领域结果 `ok:false`、`error.code:unauthorized`。没有把传输状态当成授权成功。

服务端仍使用 `APP_ORIGIN` / trusted origins，未放宽应用鉴权、cookie 或 host 策略；Worker 仍通过完整 `--allow-http <origin>` 授权连接。本单元没有新增或修改远程执行权限模型，也没有声称重新验收全部 P4b 授权代次反证。

该环境能以运行用户权限执行真实远程 shell、文件和进程操作，工作目录不是 OS 安全边界。监听 `0.0.0.0` 后，同一内网的设备可连接；HTTP 传输也不提供加密。这不是无风险的对外发布方式。`review-info.json` 的 instructions 已明确写入：临时私有体验环境、仅在评审期间运行、结束后向脚本发送 SIGTERM、不要在人多或不可信网络上开启、必须使用真实账号密码、凭据只保存在 0600 的 review-info 文件中且不得公开分享。回退 loopback 只改变生成的 URL，监听仍为全部 IPv4 接口。

## P4a 回归与工具检查

以下都已实际执行并读取产物：

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | exit 0，在分配的 worktree 执行 |
| `bash scripts/verify/s-machine-contracts.sh` | exit 0，隔离 SQLite 迁移与 6 项测试通过 |
| `bash scripts/verify/t-machine-worker.sh` | exit 0，真实 macOS Worker、逐 origin HTTP 授权、跨 owner / 旧代次等现有 HTTP 反证通过 |
| `BASE_URL=http://127.0.0.1:3138 bash scripts/verify/u-machine-ui.sh` | exit 0，真实 Chromium，P4a 导航、布局、主题及身份反证通过 |
| `pnpm exec vp check` | exit 0，0 errors、1 个既存 warning，见下文 |
| `pnpm typecheck` | exit 0 |
| 两个修改脚本的 `node --check` | exit 0 |
| `git diff --check` | exit 0 |

P4a 产物目录为 `.verify/t-machine-worker-6aLT9O/` 与 `.verify/p4a-machine-flow-xoaFGk/`。未执行全量 verify，按分工由 coordinator 本机复跑后集成；未启动 P4c。

既存范围外问题：首次直接执行 `pnpm exec vp check` 因派发时已存在、未跟踪的 `brief.md` 格式失败（exit 1，唯一格式错误为该文件）。未改写该文件；复跑时临时移到本机检查目录，使用 EXIT trap 原样移回，最终 exit 0。另有 `src/domain/mcp/exchange.ts:283` 的 `typescript(no-redundant-type-constituents)` warning，0 errors，不阻塞本单元，未修。poteto-mode 引用的 `cursor-team-kit` deslop/control-cli 技能在当前已安装目录未找到；本单元已人工检查 diff、范围及注释，没有派发 worker。

## 清理与未验证项

已向两套环境脚本及本单元 Lavish CLI 的 PID 发送 SIGTERM。环境脚本与预览 CLI 均 exit 0；两套环境记录的服务、Worker、远程探针 / survival 进程存活数均为 0，两套私有状态目录均已删除。51469、52743、4418、4419 均已确认无监听；本单元生成的端口专属凭据文件及当前 alias 也已删除。初次受 probe 限制的失败启动已自行清理。未结束或改动任何其他单元的服务，也未触碰 Human 的 3000 服务。

本轮证据来自本机通过内网 IP 发出的真实 HTTP 与 Chromium 请求。其他物理设备、跨机网络 / 防火墙路径、真机软键盘没有验证；Human 尚未明确体验确认。
