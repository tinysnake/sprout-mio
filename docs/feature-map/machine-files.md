# Machine 文件

Agent 在远端机器上跑，产出的文件留在那台机器的项目工作目录里。这个能力让人在应用里直接浏览这些文件：树的条目、字节流与格式分流都复用本机工作区的做法，权限判据换成「机器绑定 + 项目成员 + 机器在线」。边界与取舍见[Machine 文件浏览决策](../machine-files-decisions.md)。

## Sub-features

- `channel` 浏览命令与结果搭在同一台 worker 的交换帧上（每帧最多 8 条），不新开端口、不占租约、不写执行表。
- `tree` 单层懒加载列目录：目录优先、跳过 `.git`、出界符号链接整条不出现、超过 2000 条标记截断。
- `file` 字节流按 512 KiB 分块取回并在 server 拼成流；支持 Range（视频拖动、PDF 翻页），越界 416，单次请求上限 64 MiB 超出 413。
- `fence` 拒绝绝对路径、`..`、反斜杠、NUL；worker 用 `realpath` 与 `O_NOFOLLOW` 双重核对，边界是 Project 自己的工作目录。
- `no-lease` 没有租约、没有 run、没有 instance 时也能读；查看中途释放租约不会中断分块请求。
- `availability` 未绑定的机器、离线机器、根目录未观测各有明确错误，不退化成空树。
- `entry` Chat 右栏的记录里，每台租约那一行都有「浏览文件」；入口不随租约状态隐藏，因为读不需要租约。
- `source` 右栏文件树在「Chat 工作区」与「机器」之间切换，`?machine=` 记在 URL 里，一键回本机工作区。
- `viewer` 机器文件的「新标签页打开」指向 `/projects/$projectId/machines/$machineId/files`，与本机预览同一套渲染器。

## How to get to it (user POV)

1. 打开这个 Chat 的右栏「信息」页签，找到「Machine 租约」这一块；租约按最近一次申请或释放排序，刚用过的那台在最上面。
2. 点那一行的「浏览文件」，右栏切到「文件」页签，树顶部写「机器：<名字>」，列出的是那台机器上本 Project 的工作目录。
3. 点文件，中栏出现「聊天 | 文件名」页签与预览；点行尾或页签栏的 ↗ 在新标签页里看同一份内容。
4. 树顶部的回转按钮回到 Chat 自己的工作区；`?machine=` 从 URL 里消失。

也可以直接用两个只读接口验证：
`GET /api/machine/tree?projectId=…&machineId=…&path=` 与 `GET /api/machine/file?projectId=…&machineId=…&path=…`（可带 `Range`）。

## Driving it with scripts

| 操作         | 稳定定位                                          | 可观察结果                                                              |
| ------------ | ------------------------------------------------- | ----------------------------------------------------------------------- |
| 列目录       | `GET /api/machine/tree?projectId&machineId&path=` | `data.root` 为 `machine`，`entries` 是条目、`truncated` 是布尔          |
| 读文件       | `GET /api/machine/file?projectId&machineId&path=` | `200`，头部与本机工作区一致（含 `accept-ranges`）                       |
| 取一段       | 同上加 `Range: bytes=0-1023`                      | `206` 且带 `content-range`                                              |
| 越界区间     | `Range: bytes=99999999-`                          | `416` 且带 `content-range: bytes */总量`                                |
| 超大请求     | 整份文件超过 64 MiB 且不带 `Range`                | `413`                                                                   |
| 出界路径     | `path=../../etc/passwd`                           | `400 validation_failed`                                                 |
| 离线机器     | 同目录请求，机器连接已关闭                        | `409 conflict`，消息「机器不在线」                                      |
| 未绑定机器   | 用另一个 Project 调同一台机器                     | `404 not_found`                                                         |
| 进入机器树   | `?info=1&pane=files&machine=<machineId>`          | 树顶部「机器：<名字>」，条目来自那台机器                                |
| 打开机器文件 | 同上加 `file=<path>`                              | 中栏「聊天 \| <文件名>」页签与预览                                      |
| 机器新标签页 | `[data-testid="preview-open-new-tab"]` 的 href    | `/projects/<prj>/machines/<mch>/files?path=…`，页面 `machine-file-page` |
| 回到工作区   | `[data-testid="workspace-source-clear"]`          | `machine` 参数消失，树换成 Chat 工作区                                  |

- 走查脚本：`node scripts/browser/machine-files-flow.mjs`（`BASE_URL`、`DATABASE_URL`、`SPROUT_PI_DATA_DIR` 三个环境变量；7 条断言覆盖租约行入口、`?machine=` 切换、标题写出机器名、离线给 409 与「机器不在线」、回转按钮回到工作区、无页面异常）。
- 单元门禁：`npx vp test run tests/machine-browse-fence.test.ts tests/machine-browse-route.test.ts tests/workspace-source.test.ts`（后者钉住两种来源的 URL 拼法与租约排序）。前者覆盖路径与围栏，后者用真实 runtime 与 sqlite 覆盖「提交 → 下发 → worker 读盘 → 结果归并 → 字节流」，并钉住「没有租约也能读」。
