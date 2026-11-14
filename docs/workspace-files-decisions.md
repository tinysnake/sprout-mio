# 工作区文件浏览：决策记录

状态：已实现并通过真实浏览器走查；本文记录已确认的交互方向与执行者选择，供后续改动对照。界面呈现见 [Web UI 决策](web-ui-decisions.md#chat-里的文件浏览)；验证以 [功能地图](feature-map/workspace-files.md) 为入口。

## 用户要什么

在 Chat 窗口里查看 Agent 工作区里的文件：右侧栏一棵树，点文件默认在内嵌区域预览，支持 markdown、csv、html、图片、视频、音频、pdf 与常见代码；需要全文时用「新标签页打开」，文件行上也有同样的入口。不允许读到工作区以外的文件，符号链接解析到工作区外同样拒绝。

## Human 确认的方向

- **形状 B**：文件树留在右侧栏，预览占用中间栏，中栏顶部是「聊天 | 文件名」页签；换文件不丢失聊天上下文，窄屏退化为侧栏内预览。
- **树用现成组件**：control-ui 的 `tree`（vendored 到 `src/components/ui/tree.tsx`），不手写树。
- **格式一律交给现成库**：markdown 用仓库已有的 react-markdown 管线，代码高亮用 shiki，csv 用 papaparse，html 与 pdf 交给浏览器。

## 执行者选择（可改）

1. **不需要租约。** 读文件是项目成员的读权限，不是远端副作用；`requestExecution` 里的 `liveLease` 只围栏远端操作。因此「看文件」不会生成 Execution 记录，也不要求 Agent 正在运行。
2. **两个 route handler，不用 server fn。** `GET /api/workspace/tree` 回单层条目，`GET /api/workspace/file` 回字节流。前者要按目录懒加载，后者要 `Range`（视频拖动）、`Content-Disposition` 与沙箱 CSP，这些都不是 JSON 结果能表达的。
3. **根解析：工作副本优先。** 有 Project 工作副本（`getProjectRepoState(projectId).checkout.path`）就用它，否则用该 Chat 实例的工作区（`piInstanceWorkspacePath(instanceId)`，即 `$SPROUT_PI_DATA_DIR/<instanceId>/workspace`）。同一 Project 的多个 Chat 默认看到同一份工作副本；从没 clone 过的 Project 才落在实例工作区。
4. **围栏用 realpath 判两次。** 先按字面量挡住绝对路径、`.`、`..`、反斜杠与 NUL，再 `realpath` 后要求结果仍是根本身或以 `根/` 开头 —— 这一步才挡得住符号链接。打开文件用 `O_NOFOLLOW` 并比对 `dev`/`ino`，避免判定与打开之间被换走。目录条目里符号链接解析失败或落到根外时整条不出现，而不是显示成一个点不开的名字。
5. **HTML 与 SVG 一律带 `sandbox` CSP。** 工作区里的 HTML 可能带脚本，直接给同源渲染等于把它当应用的一部分执行；响应头加 `sandbox` 后浏览器用独立源渲染，脚本拿不到 cookie 与同源接口。
6. **图片、音视频的字节先 fetch 成 blob。** dev server 把 `Sec-Fetch-Dest: image|video|audio` 的请求交给静态资源中间件、不进应用路由（回 `Cannot GET`），而 `fetch` 的 `Sec-Fetch-Dest` 是 `empty`。消息附件早就是这个做法，这里沿用，dev 与生产行为一致。
7. **不做的**：搜索、编辑保存、上传、按 gitignore 过滤、目录打包下载、文件变化实时刷新。树是打开时的快照，需要刷新由用户重开面板。

## 上限

| 对象 | 上限 | 超限表现 |
| --- | --- | --- |
| 单层条目 | 2000 | 返回 `truncated`，界面提示「目录过大」 |
| 单个文件 | 64 MiB | 拒绝读取 |
| 文本预览 | 2 MiB | 读到上限为止，界面提示已截断 |
| csv 预览 | 200 行 / 30 列 | 表格下方说明只显示前一部分 |

## 后果与限制

- 视频按整段载入内存（受 64 MiB 上限约束），没有走分段流式播放。
- `.git` 目录不进树，也不可读；其他隐藏目录照常显示。
- 没有 watcher，Agent 在预览期间改了文件不会自动刷新。
- 工作区不存在（从未启动实例、工作副本已删）时树返回 `not_found`，界面给「重新加载工作区」，不创建空目录。
