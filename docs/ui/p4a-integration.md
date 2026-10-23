# P4a 正式 Machine 接入

基线为 `2a56c81`。正式入口为 `/machines`、`/machines/$machineId` 与 Project settings 的 Machines 区域。共用呈现组件和演示记录见 [p4a.md](p4a.md)。本记录不代表独立技术验收或 Human 体验确认。

## 数据与状态归属

列表和详情 loader 只读取 `MachineDetail`。创建与续签使用独立的 `MachineEnrollment` 操作结果。Machines 父路由通过 `MachineEnrollmentProvider` 持有当前有效的操作结果，兄弟路由切换不丢失这份短期状态。详情路由将 `setEnrollment` 作为 `onEnrollmentCreated` 传给面板，续签成功结果由面板在确认请求仍属于当前详情身份后写回同一 Context，替换已失效的创建票据。发布权属于仍在原身份寿命内的请求：请求 token 未撤回，且当前 `machineId` 仍等于发起时的值；组件卸载或 `machineId` 变更后，迟到成功结果直接丢弃，不写父 Context，不改动另一身份展示的票据。失败或异常保留仍合法的结果。票据不进入 loader、URL、history、浏览器存储或日志。离开 Machines 路由或重新加载页面后可重新续签 pending 身份。active 身份不显示票据或续签入口。

`?projectId=` 表达 Project 来源。详情刷新、返回入口和前进后退均从该 URL 读取目标。没有来源时返回 Machines。AppShell 的 Project 选择器也读取这个上下文。绑定表单沿用 Machine × Project 身份和服务端 revision，重复读取相同 revision 保留未保存草稿。

## 真实操作

正式路由直接导入 Machine RPC 模块中的创建、续签、列表、详情和绑定函数，均以 `{ data: input }` 调用，列表输入为 `{}`。Project 的绑定集合由 Info Hub 查询提供，不重复请求同一集合。生产浏览器验证另调用 `listProjectMachinesFn`，核对全部六个 RPC 仍可调用。

Project settings 提供本人 Machine 选择与加入或编辑入口。绑定提交 description、directory 和当前 expectedRevision。空目录保存为 null。目录保存只记录意图，Worker 另行回报探测结果。页面直接使用服务端 capability.current 和 observation.current，不附加 online 条件。断线表示通信事实，不表示空闲、释放或租约。

列表、详情与 Project settings 使用显式刷新读取最新连接和目录观察，不提供事件流或自动实时承诺。刷新保留组件实例及未保存草稿。

安装说明使用 [实际 Worker 交付指南](../p4a/worker.md) 的构建、复制和 `node "$HOME/.local/share/sprout-worker/main.mjs" init/run` 命令。实测为 macOS arm64、Node v26.11.1。没有 PATH 别名、下载地址或其他 Node 版本实测承诺。

## Info Hub 当前形状

`ProjectInfoHub.machines` 为当前 Project 可见的 `MachineDetail[]`，包含实际连接、能力、绑定意图和目录观察。`leases` 独立为 `{ available: false, reason }`。`LEASES_UNAVAILABLE_REASON` 只解释租约未实现，旧 `MACHINES_UNAVAILABLE_REASON` 已删除。Info Hub 边界从现有 `machineRuntimeContext()` 获取 bootId 与 ManagedRuntime 的 Effect Clock 时间。

迁移调用方包括 domain、server function、Project settings、共用 `ProjectMachinesPanel`、management fixtures 和场景、Info Hub 与 run 测试，以及 q、j、k 和 management 浏览器脚本。原 Machine 整体不可用断言改为实际集合和 lease 未实现断言。原 run、requestId、未登录、跨用户与持久性断言保留。测试子进程启动并关闭真实 runtime，以满足 Machine 查询上下文，不引入测试时钟替代品。

`vite.config.ts` 已删除临时 client-entry 发现 hook，保留 Worker 依赖打包设置。正式路由的真实导入负责 RPC 可达性。

## 验证与证据

运行 `pnpm check`、`pnpm typecheck`、`pnpm test`、`pnpm worker:build`、`pnpm build`，再运行 `bash scripts/verify/u-machine-ui.sh`。浏览器脚本使用独立 production 服务、SQLite、Chromium 和复制到系统临时目录的 Worker，默认端口 3120。不要让该端口与其他服务重叠。

脚本从真实注册和 Machines Link 开始，创建并读取隐藏票据，续签后返回列表并重开同一 Machine，断言旧创建票据不复活、当前续签票据与 SQLite 哈希一致且在同次 React 会话保留，再用重开后读取的有效票据执行实际 init/run。其余检查比较页面、RPC 与 SQLite，验证两个 Project 的独立目录、刷新、返回、深链、前进后退、Worker 停止和重连、目录 revision 与失败观察。异常补充验证字段错误关联、防重复与失败草稿。另一个 Chromium context 验证未登录和第二账号隔离。浅暗主题覆盖 390、899、900、901、1024、1199、1200、1440。末尾再用两台待配对 Machine 验证续签请求在途时切到第二台，迟到结果落地后第二台的创建票据仍在且服务端仍为待配对，回到第一台看到的是续签后的新票据。截图时票据隐藏。

每次运行生成独立 `.verify/p4a-machine-flow-*`，公开结果和截图可供 coordinator 读取。数据库与 Worker identity 含私密认证材料，不作为公开证据复制。精确命令、退出码、截图绝对路径和实现 head 见 `/tmp/sprout-p4a-integration-report.md`。

截图仍待 coordinator 视觉核对。跨机网络、TLS 部署、真机软键盘与物理断电未验证。P4b、Task、移除和跨 Human 分享不在本单元。
