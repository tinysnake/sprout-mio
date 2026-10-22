# Sprout UI review：Lavish 与 DOM Capture

这是 [UI 专项计划](../development-plan-ui.md#使用-lavish-与-dom-capture-体验和反馈) 的开发工具实现，服务于当前 I-P1/P2 迁移与后续 UI 反馈。产品组件、路由和数据仍由 Sprout 仓库维护；这份记录不构成 UI migrate 的章节验收。

## 启动

前提是 Sprout 已在本机运行，以及 `lavish-axi --version` 为 `0.1.90`。适配器对这一版本的页面结构做精确检查，版本或结构不匹配时停止启动，不修改全局安装。首次安装可运行 `npm install -g lavish-axi@0.1.90`。

尚未配置自动发现时，在仓库根目录启动带扩展的 Pi：

```bash
pi --extension ./scripts/ui-review/pi-extension.mjs
```

在该 Pi session 内执行：

```text
/ui-review http://localhost:3000/login
```

打开命令返回的 review URL。默认 review 端口为 `4400`，独立 Lavish 后端为 `4401`。预览与应用沿用同一个 hostname，避免把 `localhost` 与 `127.0.0.1` 混用而改变 cookie 的站点条件；应用本身继续使用原来的 origin。

## 内网访问（LAN / VPN）

review 代理固定监听全部接口（`0.0.0.0`），Lavish 后端仍只监听本机回环并由代理转发，所以只需让浏览器访问代理端口。要让其他设备可用：

- 应用同样监听全部接口（`pnpm dev`、`pnpm start`）。把常用地址设为 `APP_ORIGIN`（如 `http://10.0.0.13:3200`），其他内网 / VPN 地址放进 `APP_TRUSTED_ORIGINS`（如 `http://10.144.144.*:3200`）；只接受回环与内网模式。
- 传给 `/ui-review` 的 URL 必须是浏览器实际打开的那个地址：review URL 的 hostname 取自它，iframe 也直接加载它。例如 `/ui-review http://10.0.0.13:3000/login`；用 `localhost` 启动后从手机打开 `http://10.0.0.13:4400/...` 时，iframe 会指向手机自己的 localhost 而失败。
- 代理接受回环、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、CGNAT(`100.64/10`，含 Tailscale)、IPv6 ULA/链路本地与 `.local` 主机名，公网域名被拒；同时要求 `Origin` 与请求自身的 `Host` 同源。
- 该代理没有额外鉴权，也没有「只监听回环」的开关，只应在可信内网使用；需要限制来源时在系统防火墙或前置代理上做，改动工具本身要同时更新本节的验证。

DOM Capture 扩展需要在 review 站点与目标 frame 的该站点上授权；换用内网地址后要重新授权。

若希望普通 Pi 启动或 `/reload` 时自动发现扩展，可在忽略的 `.pi/extensions/sprout-ui-review.js` 中放入：

```js
export { default } from "../../scripts/ui-review/pi-extension.mjs";
```

该本机入口已在本次工作区建立；这里直接启动普通 Pi 即可，当前运行中的 Pi 需 `/reload` 才会加载。自动发现与显式 `--extension` 二选一，避免重复注册。扩展只注册 `/ui-review`，不会在加载时启动服务。其他机器可以选择显式 `--extension`，无需复制本机配置。

相关命令：

```text
/ui-review status
/ui-review reply 已修正此处间距，并验证保存与刷新；请复查。
/ui-review stop
```

`reply` 收到 Lavish 接受回执后才报告成功。agent 也可读取 `.verify/ui-review/4400/session.json` 中的 `file` 和 `env`，按这些环境变量调用 `lavish-axi reply`；不要使用另一个默认 Lavish 实例的状态目录。

端口冲突时不会接管既有进程。启动 Pi 前通过 `SPROUT_REVIEW_PORT`、`SPROUT_REVIEW_LAVISH_PORT` 设置两个空闲端口，必要时用 `SPROUT_REVIEW_STATE_DIR` 指定独立状态目录。应用、review、Lavish 三个端口必须不同。

只需预览、不连接 agent 时可以运行：

```bash
node scripts/ui-review/cli.mjs http://localhost:3000/login
```

该命令保持前台运行，返回 URL，但不监听反馈。Ctrl+C 会清理它启动的 Lavish 与代理，不停止 Sprout。

## 体验与反馈

1. 在 Chrome 的扩展管理页重载已扩展 Copy ID / Copy DOM path 的 DOM Capture，并刷新 review 页面。为 review 与 Sprout 所在站点授权；iframe 选择需要目标 frame 的站点权限。标准上游版本不包含本次新增的两个复制按钮。
2. 在左侧使用真实 Sprout，右侧保留 Conversation。顶部尺寸是应用 frame 的实际视口，随窗口和面板变化更新。验收断点按该尺寸判断，记录对应场景、应用版本和主题。
3. 开启 DOM Capture，选中目标，必要时切换父子层级。复制 ID 或 DOM path，贴入 Conversation，补充当前表现、期望结果与复现步骤。跨源 frame 的路径保留内层 URL 和外层 Page；没有 ID 的元素使用 DOM path。
4. 可直接粘贴自行截取、标注好的图片，或者使用 Lavish 自有的图片附件入口；无需先选元素。输入是纯文本加图片附件，支持原样粘贴 Markdown。
5. Send to Agent 后，Pi 收到文字、定位和图片本地路径。agent 阅读截图，在仓库中修正并验证，再回复 Lavish；Human 在更新后的页面复查。HMR 沿用应用自己的行为；菜单中的“重新打开初始页面”会回到启动时传入的 URL。

当前 live-app 模式隐藏 Lavish 自有 Annotate、DOM snapshot、HTML 导出与发布入口；元素定位使用 DOM Capture，图像使用附件。没有注入 Lavish artifact SDK，也不把应用当作可导出的静态 HTML。需要单独运行组件场景时，直接把场景的本地 URL 传给相同入口。

## 反馈如何回到 Pi

Pi extension 持有 Lavish server 和 poll 子进程。`poll` 没有普通等待超时；它退出并返回反馈后，扩展先把完整解码结果写入状态目录的 `feedback-*.json`，再通过 `pi.sendUserMessage(..., { deliverAs: "followUp" })` 送回拥有该监听器的 Pi session。忙碌时遵循 Pi 的 follow-up 队列行为。

扩展传给 agent 的内容明确指向 Sprout 仓库；`review.html` 只是会话锚点，不是要修改的产品页面。完整收据保留图片路径和 Lavish 原始指引，正常反馈消息不沿用其中“修改 HTML artifact”的指令。

普通反馈后继续等待。`Send & End` 的最后一条反馈仍送达一次，随后停止 poll，不自行重开用户结束的会话。`browser_disconnected` 也停止等待，并将状态交给 agent 询问用户。poll 失败时显示通知和停止状态，不伪装成仍在监听。状态目录保留收据，可以在进程异常后手动核对未处理反馈。

`/ui-review stop`、Pi session 关闭、切换或 fork 前，会停止自有子进程和连接。扩展不会结束其他 agent 的任务或共享 Lavish 服务。当前文档不表示某个正在运行的 Pi session 已启用监听，以 `/ui-review status` 和实际收取结果为准。

## 验证与证据

主要回归使用真实 Lavish、隔离 Chromium profile、实际 DOM Capture 扩展与本地 HTTP fixture；fixture 明确标为工具测试场景，不能替代产品业务验收。

```bash
node scripts/ui-review/verify.mjs \
  --dom-capture /path/to/dom-capture/extension \
  --pi-sdk /path/to/node_modules/@earendil-works/pi-coding-agent
```

`--pi-sdk` 指向当前 Pi 安装的 package 目录。它加载本扩展，创建实际 Pi SDK session，在该 session 的 input hook 接收反馈后结束测试，不调用模型。省略该参数时只验证受管理 poll 回调，不宣称已验证 Pi 唤醒。

默认验证 `localhost`；可用 `--host 127.0.0.1`、`--port 4430` 和 `--evidence <目录>` 更改本地测试环境。测试复制 DOM Capture 到临时目录，仅为临时副本授予相应本地站点权限，不修改用户安装的扩展。

| 风险                                | 本次检查                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| sandbox / origin 破坏应用登录与存储 | 跨端口 cookie、localStorage、登录后刷新与 frame 前后退；恢复旧 sandbox 条件时同一登录断言失败，正式适配通过 |
| 可信应用适配影响普通 artifact 隔离  | 普通 artifact 响应仍带 sandbox CSP；不匹配的 Origin 被拒绝                                                  |
| URL 与视口被反馈工具改变            | 应用 URL 不追加 artifact 参数；显示 frame 的实际 innerWidth / innerHeight                                   |
| iframe 中的元素无法定位             | 实际扩展选取跨源 frame 的元素，复制原始 ID 及含内外 URL 的 DOM path                                         |
| 反馈或截图在传递中缺失              | 浏览器剪贴板粘贴、发送、CLI poll、落盘收据；文字逐字一致，PNG 允许重编码但像素一致                          |
| agent 空闲时收不到反馈或不能回复    | 实际 Pi SDK session 的 input hook 收到反馈；reply 后 Conversation 显示回复并结束 Working 状态               |
| 最后一条反馈随结束而丢失            | Send & End 反馈包含 `session_ended=true` 与 `ended_by=user`                                                 |

自动结果、收据与截图默认保存在 `.verify/ui-review-evidence/`，服务状态位于 `.verify/ui-review/<端口>/` 或指定临时目录。这些是本地可再生材料；选定截图保存在 [review-evidence](review-evidence/) 供仓库追溯。视觉检查必须实际读图，不能只验证文件存在。

读图还发现了 external listener 的状态差异：poll 携带 `--owner` 时，回复后仍显示 Working。新增浏览器断言复现失败，改用普通 agent listener 后通过。

还需区分以下边界：

- 真实 Sprout 检查使用已有构建快照、独立 SQLite 与测试账号，验证注册、登录保持、导航和 DOM Capture 定位；不表示其他 agent 正在迁移的页面已通过验收。
- Pi 自动检查验证了空闲 session 的实际输入派发；忙碌时的 follow-up 排队依据当前 Pi API，未模拟完整模型执行、修复和重载过程。
- Human 常用浏览器里的扩展重载与亲自体验仍待完成。独立 Chromium 的通过不能代替 Human 确认。
- 浏览器完全断开后的 grace period、实际 HMR 和 Pi 被强杀后的清理恢复未在本轮单独验收。浏览器或操作系统阻止 cookie / clipboard 时保留实际报错，不放宽产品认证规则。
