# Machine 文件浏览决策

Agent 在远端机器上跑，产出的截图、文档与代码留在那台机器的项目工作目录里。人要审核这些产物，就得在应用里直接看到它们，而不是 SSH 上去 `ls`。这份文档记录「远端文件只读浏览」的边界与取舍，本机工作区的对应规则在[工作区文件浏览决策](workspace-files-decisions.md)。

## 读权限与租约分离

租约围的是远端**副作用**：谁有资格在这台机器上跑命令、写文件，以及同一时刻只允许一个持有者。审核发生在 agent 干完之后，那时租约已经释放；如果读也要租约，最常见的使用场景会直接不可用。

所以判据是三条，与租约无关：机器已绑定到本 Project、当前用户是该 Project 成员、机器在线且项目工作目录可观测。相应地：

- 读不产生 `remote_execution` 记录，也不出现在租约视图里。
- 查看中途释放租约不会让下一次 Range 请求失败——PDF 与视频是分块请求的，这条必须成立，否则播放器会停在半截。
- 审核时不存在活租约，也不要求有 run 或 instance 在场。

代价是：`machine_lease` 里没有行的机器也能被浏览。这是有意为之，但入口仍然从「这个 Chat 用过的机器」和租约列表进入，避免变成一台机器一台机器地去翻。

## 为什么浏览不复用 `remote_execution`

现有远端通道的三条结构约束决定了它做不了这件事：

- 每条执行都要活租约（`src/server/remote.ts` 的 `liveLease`），且只能由持有租约的 agent 实例提交（`src/server/lease.ts` 的 `assertAgentContext`）。
- `remote_execution` 表要求 `holderInstanceId`、`runId`、`chatId`、`authorizationGeneration` 非空，没有「无持有者的读」这一行。
- 现有操作里没有列目录；`file_read` 返回 UTF-8 字符串且单次上限 256 KiB，传不了二进制。

于是浏览走同一台 worker 的交换帧，但用自己的一小段协议：`browse` 命令与 `browse` 结果，一次交换最多 8 条，`dir_list` 与 `file_chunk` 两种操作。它仍然复用同一条已认证的出站连接，不新开端口、不新增传输，也不触碰租约与执行表。

## 围栏放在 worker

工作目录不是安全边界，这一点对远端同样成立。协议只接受根目录内的相对路径，并且：

- server 先拒一次绝对路径、`..`、反斜杠与 NUL，让明显非法的请求不必占用一次往返。
- worker 用 `realpath` 解析目标，确认仍在边界内；打开文件用 `O_NOFOLLOW`，打开后再比对 `dev`/`ino`，防止解析与打开之间被换掉。
- 边界取 **Project 自己的工作目录**（`projectWorkingPath(root, projectId)`，即机器根目录加上 Project 的目录名），不是整台机器的根目录。两个 Project 共用一个根时，彼此看不到对方的产物。这比「读机器上所有文件」更严格，本功能的用途也只需要项目工作目录。
- 出界的符号链接在列表里整条不出现，直接读取则 `forbidden`。

## 分块与上限

- 单块原始 512 KiB：base64 之后约 683 KiB，仍能放进一个约 1 MiB 的交换帧，不会把同一帧里的执行事实挤掉。
- 单次 HTTP 请求最多 64 MiB；超过直接 413，让调用方改用 Range。文件更大不等于不能看——播放器与 PDF 阅读器本来就是按 Range 取的。
- Range 不可满足时 416，并带 `content-range: bytes */总量`，这样浏览器能自己纠正。
- 等待 worker 回应的上限 5 秒；待办请求 30 秒过期，进程内最多 300 条。过期即失败，不无限等待。

## 入口与预览

- 入口就是租约列表：每条租约一行「浏览文件」，按 `changedAt` 倒序（申请与释放都算一次变化）。人最近用过的机器排在最前，不需要先想「哪台有我要看的东西」。
- 入口不因租约状态隐藏：释放之后正是审核的时候，隐藏入口等于把这个功能从主用例里摘掉。
- 右栏的文件树与中栏预览是本机工作区那一套，只把来源换成机器：`?info=1&pane=files&machine=<id>` 记来源，`?file=` 记当前文件。切回本机不留痕迹，URL 里没有 `machine` 就是本机。
- 「新标签页打开」指向应用自己的整页预览 `/projects/$projectId/machines/$machineId/files`，与本机预览同一个渲染器；直接指向字节接口会让 markdown 与 csv 露出源码。
- 刷新、前进后退、把链接发给同事，都回到同一台机器上的同一个文件；机器离线时页面给「机器不在线」，不缓存过期内容。

## 不做

- 不做编辑、上传、重命名与搜索。
- 不做审计持久化：待办只在进程内，重启后未完成的浏览请求自然失效。要追责时看的是执行与租约记录，浏览不产生它们。
- 不做「产物声明」：agent 主动标注「这是要人看的结果」是后续阶段的事，现在由人自己从目录里找。
- 不做服务端缓存：每次请求都真的去读远端磁盘，避免看到过期内容。

## 相关

- 契约：`src/contracts/machine-browse.ts`。
- worker 侧围栏与读盘：`src/worker/browse.ts`。
- server 侧待办、结果归并与字节流：`src/server/machine-browse.ts`。
- 路由：`src/routes/api/machine/tree.ts`、`src/routes/api/machine/file.ts`。
- 前端入口与定位表：[feature map](feature-map/machine-files.md)。
