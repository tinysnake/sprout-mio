# 工作区文件

用户在 Chat 里查看 Agent 工作区里的文件：右侧栏的树、中间栏的预览与「新标签页打开」。交互方向与安全边界见[工作区文件浏览决策](../workspace-files-decisions.md)。

## Sub-features

- `tree-pane` 右侧栏切到「文件」页签后显示树，只列当前工作区的条目，`.git` 不出现。
- `tree-lazy` 目录按需加载；折叠再展开不重新请求；加载失败可重试，根失败可重新加载工作区。
- `preview-inline` 点文件在中栏预览，markdown / 代码 / csv / html / pdf / 图片 / 音视频各有渲染器，其余类型给下载入口。
- `open-new-tab` 树行与预览页都有「新标签页打开」，指向同一份字节。
- `root-switch` 有 Project 工作副本时树头写「Project 工作副本」，否则写「Chat 工作区」。
- `fence` 绝对路径、`..`、反斜杠、出界符号链接一律拒绝；`.git` 读不到。
- `no-lease` 查看不需要租约，不产生 Execution 记录；没有运行中的 Agent 也能看。

## How to get to it (user POV)

- 打开 Chat `/projects/$projectId/chats/$chatId`，点右上角信息入口展开右侧栏，切到「文件」。
- 深链 `?info=1&pane=files` 直接打开文件页签，`&file=docs/README.md` 直接打开某个文件的预览。
- 点文件行或目录展开；点行右侧的箭号图标在新标签页打开。

## Driving it with Playwright and verify scripts

前置条件：一个 Project、一个加入项目的 Agent、一条 DM，以及该 Chat 实例工作区里的样例文件（可以用 `inspector-instance-id` 拼出 `$SPROUT_PI_DATA_DIR/<instanceId>/workspace`）。

| 操作 | 稳定定位 | 可观察结果 |
| --- | --- | --- |
| 切到文件页签 | `side-pane-tab-files`、`workspace-panel` | 右栏出现树，根标题是工作副本或 Chat 工作区 |
| 展开目录并点文件 | `workspace-tree-entry[data-workspace-path]` | 中栏出现 `workspace-preview-pane`，底部路径与点中的条目一致 |
| 看 markdown | `workspace-preview-pane h1` | 标题与 GFM 表格按 markdown 渲染 |
| 看代码 | `workspace-preview-pane .workspace-code .shiki` | shiki 产物出现，说明高亮生效而非纯文本兜底 |
| 看 CSV | `workspace-preview-pane table tbody tr` | 首行作表头，数据行数与文件一致 |
| 看 HTML | `iframe[title="HTML 预览"]` | 内联脚本在沙箱里跑，页内可读到 `<h1>` |
| 看图片 | `workspace-preview-pane img` | `src` 是 `blob:`，`naturalWidth > 0` |
| 新标签页打开 | `preview-open-new-tab`、`workspace-open-new-tab` | 直接 GET 该 `href` 得到同名字节与正确 `content-type` |
| 越界请求 | `GET /api/workspace/file?...&path=../../etc/passwd` | `400 validation_failed`，不回内容 |
| 切回信息页签 | `side-pane-tab-info`、`chat-inspector` | URL 的 chat 路径不变，聊天没有被卸载 |

- 完整走查：`node scripts/browser/workspace-files-flow.mjs`。需要 `BASE_URL` 与 `SPROUT_PI_DATA_DIR` 与目标 dev server 一致；脚本自己注册会话、建 Project、建 Agent、加成员、开 DM、造样例文件，最后打印 `PASS/FAIL` 与 `N/N passed`，截图写 `EVIDENCE_DIR`（默认 `/tmp/sprout-workspace-evidence`）。
- 单元门禁：`npx vp test run tests/workspace-fence.test.ts tests/workspace-root.test.ts`。前者覆盖围栏与 Range，后者用真实 runtime 与 sqlite 覆盖根解析（含「没有租约也能列目录」）。

## Gotchas

- dev server 把 `Sec-Fetch-Dest: image|video|audio` 的请求交给静态资源中间件，`<img src="/api/...">` 会得到 `Cannot GET`；媒体字节必须先 `fetch` 成 blob，不能直接给元素 `src`。
- 数据目录不要放在仓库里：Vite 会 watch 到，写文件触发页面重载，走查会出现莫名其妙的失败。把 `DATABASE_URL`、`SPROUT_PI_DATA_DIR`、`SPROUT_REPO_DIR` 放到仓库外的临时目录。
- dev server 缺 `SPROUT_APP_ORIGIN` 时登录被 better-auth 拒绝（页面提示「请求来源不受信任」）；端口与 `APP_ORIGIN` 必须一致。
- 新 Project 没有 Agent 成员，Chats 页会提示「还没有 Agent 成员」，必须先建 Agent 并加入项目，才点得到 `dm-start`。
- 树的根失败与空目录是两种状态，别把 `not_found` 当成「目录为空」。
