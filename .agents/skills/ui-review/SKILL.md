---
name: ui-review
description: 启动 / 结束 Sprout 的 UI review：真实应用加载在 Lavish 预览里，人类在里面标注或截图后，反馈以消息回到当前 session，你改代码再回写。当用户说「review 一下这个页面」「开 ui review」「看看某个页面的 UI」「我需要提界面反馈」时使用。
---

# Sprout UI review

预览真实应用（不是静态 HTML），对话框里的人类反馈会作为消息回到这个 Pi session。
工具入口只有一个：`ui_review`，由 `.pi/extensions/sprout-ui-review.js` 注册。

## 什么时候用

- 用户需要**亲自看**真实界面并提反馈（视觉评审、样式调整、交互走查）。
- 用户说 `/ui-review ...` 这类老写法时，也按这里的流程做，不要让他自己找端口或拼 URL。
- 不适合：只是让你描述设计、生成 HTML 报告（那用 `lavish` 技能）。

## 启动

1. **定入口**，不需要问用户要 URL：
   - 用户描述了具体页面就自己判断：读 `src/routes`（TanStack Router 文件即路由）和组件，选最贴近的那一页的路径，如 `/projects`、`/agents`、`/projects/$projectId/settings`（带参数的路由要用户给的值或选已有数据）。
   - 说不清或只是泛泛看 UI，省略 `entry`，从 `/login` 开始。
2. 调用 `ui_review({ action: "start", entry })`。端口不用管：默认 4400/4401 被占（包括上次遗留的僵死实例）时会自动往后找一对空闲端口，返回值里写明实际用了哪个。
3. 把**预览 URL**告诉用户（一行就够），让他打开；提醒「左侧应用、右侧对话，选元素或截图后发送」。
4. 如果工具不存在（扩展没加载），告诉用户重启 Pi 或确认 `.pi/extensions/sprout-ui-review.js` 存在后 `/reload`；**不要**自己用 curl 或手拼端口绕过。

启动前提：应用正在跑（`pnpm dev`，默认 `http://localhost:3000`，实际 origin 取自 `APP_ORIGIN` / 仓库 env）。深链需要登录，未登录时应用会先重定向到 `/login`，这是正常行为。

## 收到反馈后

反馈会以 `来自当前 Sprout UI review 的反馈。` 开头的用户消息到达，带预览地址和「完整收据」JSON 路径。

1. 读收据文件，拿到文字、DOM Capture 定位（ID / DOM path / 内层外层的 URL）和图片本地路径；看图必须真的读图。
2. 在 Sprout 仓库里定位并修复，按项目要求完成验证（构建通过不算浏览器验证）。
3. 回写结果：`ui_review({ action: "reply", message: "..." })`，写清改了什么、怎么验证的、还需要人类看哪里。
4. 用户说结束、或会话已由人类 `Send & End`，就 `ui_review({ action: "stop" })` 释放端口；不要自行重开用户已结束的会话。

## 其他 action

- `status`：当前 session 是否有 review、端口、反馈监听是否还在跑。
- `stop`：停止 Lavish 和代理，释放端口。
- `reply`：把处理结果回写到 Lavish 对话。

## 排障

- **端口报占用**：正常路径下工具已自动避开；只有显式传端口或用 `cli.mjs --strict-ports` 时才会失败。真要清理遗留进程：`pgrep -fl "lavish-axi server"` 看是谁，`lsof -nP -iTCP:<端口> -sTCP:LISTEN` 确认 PID，只杀确认属于本工具的 `lavish-axi`，别动别人的进程。
- **反馈没回来**：`status` 看监听状态；收据文件在 `.verify/ui-review/<端口>/feedback-*.json`，进程异常后人工核对不会丢。
- **只想给人看、不要 agent 参与**：`node scripts/ui-review/cli.mjs [入口]`，前台运行，Ctrl+C 清理，不监听反馈。
- 细节与验证范围见 `docs/ui/review-workflow.md`。
