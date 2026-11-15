# Machine 文件

Agent 在远端机器上跑，产出的文件留在那台机器的项目工作目录里。这个能力让人在应用里直接浏览这些文件：树的条目、字节流与格式分流都复用本机工作区的做法，权限判据换成「机器绑定 + 项目成员 + 机器在线」。边界与取舍见[Machine 文件浏览决策](../machine-files-decisions.md)。

## Sub-features

- `channel` 浏览命令与结果搭在同一台 worker 的交换帧上（每帧最多 8 条），不新开端口、不占租约、不写执行表。
- `tree` 单层懒加载列目录：目录优先、跳过 `.git`、出界符号链接整条不出现、超过 2000 条标记截断。
- `file` 字节流按 512 KiB 分块取回并在 server 拼成流；支持 Range（视频拖动、PDF 翻页），越界 416，单次请求上限 64 MiB 超出 413。
- `fence` 拒绝绝对路径、`..`、反斜杠、NUL；worker 用 `realpath` 与 `O_NOFOLLOW` 双重核对，边界是 Project 自己的工作目录。
- `no-lease` 没有租约、没有 run、没有 instance 时也能读；查看中途释放租约不会中断分块请求。
- `availability` 未绑定的机器、离线机器、根目录未观测各有明确错误，不退化成空树。

## How to get to it (user POV)

前端入口由后续工单接入（从「这个 Chat 用过的机器」与租约列表进入，点某台机器的「浏览文件」）。当前可直接用两个只读接口验证：
`GET /api/machine/tree?projectId=…&machineId=…&path=` 与 `GET /api/machine/file?projectId=…&machineId=…&path=…`（可带 `Range`）。

## Driving it with scripts

| 操作       | 稳定定位                                          | 可观察结果                                                     |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------- |
| 列目录     | `GET /api/machine/tree?projectId&machineId&path=` | `data.root` 为 `machine`，`entries` 是条目、`truncated` 是布尔 |
| 读文件     | `GET /api/machine/file?projectId&machineId&path=` | `200`，头部与本机工作区一致（含 `accept-ranges`）              |
| 取一段     | 同上加 `Range: bytes=0-1023`                      | `206` 且带 `content-range`                                     |
| 越界区间   | `Range: bytes=99999999-`                          | `416` 且带 `content-range: bytes */总量`                       |
| 超大请求   | 整份文件超过 64 MiB 且不带 `Range`                | `413`                                                          |
| 出界路径   | `path=../../etc/passwd`                           | `400 validation_failed`                                        |
| 离线机器   | 同目录请求，机器连接已关闭                        | `409 conflict`，消息「机器不在线」                             |
| 未绑定机器 | 用另一个 Project 调同一台机器                     | `404 not_found`                                                |

- 单元门禁：`npx vp test run tests/machine-browse-fence.test.ts tests/machine-browse-route.test.ts`。前者覆盖路径与围栏，后者用真实 runtime 与 sqlite 覆盖「提交 → 下发 → worker 读盘 → 结果归并 → 字节流」，并钉住「没有租约也能读」。
