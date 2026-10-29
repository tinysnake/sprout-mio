# Human review

真实 Sprout 应用由仓库适配器嵌入 Lavish；反馈与回写使用 Lavish 原生 CLI。入口是 [human-review skill](../.agents/skills/human-review/SKILL.md)，运行时不注册 Pi tool、slash command 或消息投递扩展。

章节收尾时的最终评审也走这条路径：集成完成后由 Human 看真实页面再给结论，顺序与方案选择的分工见[页面设计与实现的分工](project-conventions.md#页面设计与实现的分工)。

## 启动

应用需要已经启动。前台手动体验：

```bash
node scripts/human-review/cli.mjs /projects
```

CLI 输出一行 JSON 后保持运行，Ctrl+C 或 SIGTERM 会关闭自有代理与 Lavish 后端。需要 agent 边修改边评审时，由 skill 启动后台预览进程，使用独立状态目录；反馈 poll 仍在 agent 当前工作回合前台执行。

`node scripts/human-review/cli.mjs --help` 提供全部参数。端口默认从 4400 / 4401 开始，遇到占用自动后移；`--strict-ports` 要求冲突时失败，保留已有实例。

描述符同时输出到 stdout 和 `<stateDir>/session.json`，包含：

- `pid`：拥有预览服务的 CLI 进程。
- `url` / `appUrl`：评审链接与真实应用入口。
- `ports`：实际代理端口、Lavish 端口及是否自动调整。
- `file`：`review.html` 会话锚点的绝对路径。
- `lavishBin` / `env`：此实例的 Lavish 可执行文件与完整 CLI 环境。

状态文件是启动收据；服务是否仍在运行需检查进程与端口。

## 应用入口与访问

位置参数接受 `/path` 或本机 / 内网 HTTP URL。省略入口时先探应用是否提供 [开发登录](#开发登录)，提供就用 `/dev-login`，否则用 `/login`。应用 origin 依次取 `SPROUT_HUMAN_REVIEW_APP`、`APP_ORIGIN`、仓库 `.env.local` / `.env` 的 `APP_ORIGIN`，最后使用 `http://localhost:3000`。带参数的路由需选择已有数据；未登录时重定向到登录页属于正常应用行为。

可信预览接受回环、私有网段、CGNAT、`.local` 与相应本地 IPv6 地址，拒绝公网域名、URL 凭据和非 HTTP 协议。代理监听全部接口，Lavish 后端仅监听回环。请求 Host 与 Origin 仍需通过检查。

通过局域网 / VPN 体验时，入口使用浏览设备也能访问的应用 hostname。例如：

```bash
node scripts/human-review/cli.mjs http://192.168.1.10:3000/login
```

预览与应用沿用相同 hostname，保持 cookie 的站点条件。用 localhost 启动后再把预览链接的 hostname 改成局域网地址，会让远端设备的 iframe 指向其自身 localhost。

## 开发登录

远程评审时手输长账号密码很麻烦。dev server 提供 `/dev-login`：用固定开发账号建会话，把会话 cookie 写在 303 响应里，浏览器一次往返就带着登录态落地，不需要知道或输入账号密码。

- 只在 dev server 生效。构建期 `import.meta.env.DEV` 为真才开放，生产构建（`pnpm build` / `pnpm start` 的产物）与验收库的 `/dev-login` 一律 404。
- 默认开启，可用 `DEV_LOGIN_ENABLED=false` 关掉（例如把 dev server 暴露在不信任的网络里）。
- 账号由 `DEV_LOGIN_EMAIL`（默认 `dev@sprout.test`）、`DEV_LOGIN_NAME`（默认「开发评审」）、`DEV_LOGIN_PASSWORD`（默认 `sprout-dev-login`）决定。首次访问自动建号，并沿用注册钩子播种默认 Project 与 Agent；已有账号只把密码对齐到配置值。想换身份就改邮箱，不要复用人类自己注册的邮箱。
- 目标页面用 `?to=` 指定，只接受站内绝对路径（`/projects`、`/projects/prj_…/chats`），其他一律回到 `/`。
- 登录页在 dev server 上多出一个「用开发账号直接进入」的入口，点击等同打开 `/dev-login?to=/`；生产构建不渲染它。
- 会话是正常的 better-auth session，登出、`getSession`、限流与身份判定都走原有路径，没有旁路鉴权。

```bash
# 直接打开
open http://192.168.1.10:3000/dev-login?to=/projects
# 评审默认入口（省略位置参数时自动优先选它）
node scripts/human-review/cli.mjs
```

## 尺寸切换

预览顶部提供视口工具栏，宽高单位为 CSS px：

- **跟随窗口**：应用填满当前预览区域。
- **设备预设**：手机 360×800、390×844、430×932；平板 768×1024、1024×1366；桌面 1280×800、1440×900、1920×1080。
- **布局边界**：900 / 901 与 1199 / 1200px，分别检查项目两个布局边界的两侧。
- **自定义与旋转**：宽高各支持 240–3840px，点击“应用”生效，“旋转”交换宽高。
- **显示比例**：“适合可用空间”按比例缩小大视口，“100%”保留原始显示大小，超出部分在预览区滚动。

缩放只改变显示比例，iframe 的真实 `innerWidth` / `innerHeight` 与媒体查询仍使用选定尺寸。工具栏显示实际宽高和缩放百分比。尺寸切换保留当前路由、登录态和未提交的输入，当前标签页刷新后保留尺寸与显示方式。

此功能用于响应式布局检查；浏览器内核、DPR、触控与系统键盘等行为仍由当前设备提供。

## poll / reply

先读取本次 `session.json`。每次执行 Lavish 命令都填入它的 `env`、`lavishBin` 和 `file`，避免落到默认 Lavish 实例。以下以默认端口、示意状态目录和 PATH 中同一版本的可执行文件说明命令形式；实际值以描述符为准：

```bash
LAVISH_AXI_HOST=127.0.0.1 LAVISH_AXI_PORT=4401 \
LAVISH_AXI_STATE_DIR="$PWD/.verify/human-review/example/lavish" \
lavish-axi poll "$PWD/.verify/human-review/example/review.html" \
  --timeout-ms 45000 > .verify/human-review/example/feedback-001.toon
```

原生 poll 会等待反馈，队列保留尚未收取的内容。stdout 是完整 TOON 收据，包含文字、DOM 定位、原图文件路径与 session 状态；先保存再阅读全文，实际读取附件图片。每批使用新的收据文件，避免覆盖已消费的反馈。

正常使用可以省略 `--timeout-ms`，保持原生长轮询；宿主单次工具调用不能持续等待时，使用上述有界等待，给命令预留退出时间。收到 `waiting` 后继续执行下一次 poll。被宿主中断时先检查本次收据：反馈可能已经被消费并写入文件；完整处理后再等待下一批。

同一会话只运行一个 poll。保持 poll 附着在当前工作回合，反馈由命令返回；后台预览进程本身不代表 agent 正在监听。结束 agent 回合后，没有 Pi 扩展替它主动注入消息。

修改真实应用源码并验证后，使用相同环境回写：

```bash
LAVISH_AXI_HOST=127.0.0.1 LAVISH_AXI_PORT=4401 \
LAVISH_AXI_STATE_DIR="$PWD/.verify/human-review/example/lavish" \
lavish-axi reply "$PWD/.verify/human-review/example/review.html" \
  --agent-reply '已修改……；已验证……；请确认……。'
```

reply 成功退出表示服务已接受回复。需要继续评审时再次 poll。`feedback` 处理本批全部反馈；`session_ended` 为真时处理最终反馈后清理；`ended` 停止等待。`browser_disconnected` 保留可恢复会话，向用户确认恢复还是结束，得到决定后执行。

## 适配边界

Lavish 当前的原生入口是本地 HTML artifact，sandbox 不提供真实应用所需的完整登录与存储环境。`scripts/human-review/review.mjs` 集中维护可信本地应用适配：替换 iframe，保持应用 URL，绕过应用中不存在的 artifact snapshot SDK 等待，并提供独立代理与后端生命周期。

`browser.js` 管理视口切换和显示缩放，`browser.css` 集中维护预览布局并沿用 Lavish chrome 的语义颜色。需要 artifact SDK 的标注、快照、导出和 revision 控件保持隐藏，元素定位使用 DOM Capture 与截图。原始 artifact 路径继续保留 Lavish 的 sandbox。

适配器固定支持 `lavish-axi@0.1.90`，运行时检查版本与补丁目标结构。升级时先检查真实应用接入并重跑验收；[lavish skill](../.agents/skills/lavish/SKILL.md) 的原生 HTML artifact 流程可按其 CLI 获取最新指南。

## 停止与排障

读取描述符中的 PID，确认仍是本次 CLI，然后发送 SIGTERM：

```bash
ps -p <PID> -o pid=,command=
kill -TERM <PID>
```

退出后检查描述符中的两个端口已释放。手动前台运行使用 Ctrl+C。Pi 的退出、切换或 fork 不再代管预览进程；agent 结束评审前负责停止自己启动的 CLI。

- **启动未就绪**：检查本次目录的 `cli.log`；启动失败时适配器会清理已建立的服务。先确认旧进程状态，再决定是否重新启动。
- **端口占用**：默认自动避开；严格模式使用 `lsof -nP -iTCP:<端口> -sTCP:LISTEN` 确认归属，或另选端口。
- **没有反馈**：确认当前有 poll 在前台运行且使用描述符环境；检查返回的状态和已有收据。UI 上的预览可用与 agent 正在等待是两个状态。
- **异常退出**：SIGTERM / SIGINT 走正常清理。CLI 被 SIGKILL 或宿主崩溃时无法保证清理后端；结合描述符的独立状态目录和进程命令确认归属，再处理遗留进程。状态文件保留供诊断。

## 验证与证据

```bash
node scripts/human-review/verify.mjs \
  --dom-capture /path/to/dom-capture/extension
```

可通过 `--port`、`--host` 和 `--evidence` 选择本轮环境。验收使用真实 CLI、Lavish、Chromium 与 DOM Capture 扩展，验证：

- CLI 描述符与独立状态目录、冲突拒绝接管、Host / Origin 检查及原始 artifact 隔离。
- 登录 cookie、localStorage、刷新与历史导航保持，应用 URL 不受 artifact 参数污染。
- 设备预设与边界两侧的真实媒体查询、自定义与非法输入、旋转、缩放、窄宿主布局和刷新后的尺寸保持；切换期间路由、页面实例与草稿保持。
- 缩放后的跨源 iframe 中，Copy ID / Copy DOM path 保留内外 URL。
- 无监听时反馈排队，原生 poll 完整收取文字与截图，截图像素保持，原生 reply 可见。
- Send & End 最终反馈与用户结束状态、浏览器脚本错误、SIGTERM 正常退出与双端口释放。

本轮 CLI 与视口切换验收已通过，收据、截图和结果可通过 `--evidence` 指定；视口验收保存在 `.verify/human-review-viewport-evidence/`，截图已实际查看。额外在独立 dev 实例的真实 Sprout 登录页验证了 390×844、768×1024、1440×900 与 1920×1080，并确认输入在切换后保持。Human 对新工具栏的体验确认待实际使用后记录。实际 Sprout HMR、断连 grace period 和 SIGKILL 后的人工恢复未在本轮单独验收。

之前的 Pi 自动消息桥与其验收属于历史实现，冻结证据见 [历史工具证据](ui/review-evidence/README.md)。
