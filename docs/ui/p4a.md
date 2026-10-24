# UI-P4a Machine 连接与绑定（演示交付）

状态：本文保留共用呈现组件与演示交付记录。正式路由、真实 server functions、安装指令和 Info Hub 的当前接入见 [p4a-integration.md](p4a-integration.md)。历史记录不是章节技术验收或 Human 体验确认。

## Shell 能力：方案 B「一行摘要」

本轮按 Human 已选定的 B 实现：默认显示 `✓ zsh · ✓ bash · ✓ sh`，同行显示 `平台 darwin arm64`。路径、版本、自检结果和检查时间进入详情弹层。`machine-shell-summary.tsx` 直接读取 `MachineDetail["capability"]`，真实详情与演示通过 `MachineDetailPanel` 共用该组件，不改能力快照契约。

触发元素为 Base UI `Popover.Trigger` 渲染的 button，`aria-expanded` 跟随状态；详情采用有标题与描述的 dialog 语义。悬停和键盘聚焦展开，点击或触控点击切换，Enter / Space 可操作，Escape 或焦点移出收起。使用 Portal 和视口边界定位，沿用现有 semantic token 与浅暗主题。

状态规则：当前快照的成功项显示绿色 `✓`；失败项显示红色 `✗`，详情保留原始失败原因；unknown 显示红色 `? unknown`，详情明确“不猜调用语法”；无快照显示 `? 尚未探测` 和未知平台；有快照但 shell 列表为空显示 `? 未报告 shell`。旧快照的成功项使用中性色，并明确标记“旧代次”，原有“不能当作现在可用”的连接说明保留，弹层也重复这一限制。

演示新增第一台 Machine 的 Shell 状态选择器，包含全部通过、部分失败、全部失败、unknown、无快照与空列表；旧代次继续使用原有断线 Machine 夹具。`p4a-machine-scenes.mjs` 新增 DOM 可见性、摘要文本、`aria-expanded`、键盘聚焦 / Enter / Space / Escape / 移焦、触控点击及 1440 / 390 浅暗主题的布局断言；保留既有权限、票据、持久性、旧代次和导航断言。`p4a-machine-flow.mjs` 在真实 pending / active 详情增加摘要初始收起、hover 展开及 Escape 收起检查。

可复现命令：`pnpm check`、`pnpm typecheck`、`pnpm test`、`pnpm worker:build`、`pnpm build`；启动 3077 演示 dev 后运行 `node scripts/browser/p4a-machine-scenes.mjs`；production 构建后连续两次运行 `BASE_URL=http://127.0.0.1:3340 bash scripts/verify/u-machine-ui.sh`。本轮实跑退出码、截图和交互值见 `/tmp/sprout-p4a-shell-compact-report.md`。

截图位于 `.verify/p4a-machine-scenes/shell-summary-{1440,390}-{light,dark}.png` 与 `shell-details-{1440,390}-{light,dark}.png`，状态图为 `shell-state-{partial,failed,unknown,missing,empty,stale}.png`，DOM 证据为 `shell-summary-evidence.json`。已实际读图确认两种宽度与浅暗主题的一行摘要、390 无横向滚动、详情未被容器裁切。触控验证使用 Chromium 模拟，真机触控与屏幕阅读器未验证。方案 B 的 Human 选择已确认，本轮实现的 Human 体验确认仍待 Human 明确给出。

## Round-1：详情优先级与安装文案

- 待配对时，「配对与安装」是 `PageFrame` 中首个 `SettingsSection`，宽屏横跨既有两栏；内部票据操作先于安装说明，900px 起并排，窄屏按同一 DOM 顺序排列。连接、root 与绑定随后呈现。
- 已配对时，连接、root 与绑定恢复为主要内容，配对与安装回到既有次栏；窄屏排在主要内容之后。安装命令保留，续签沿用服务端支持的待配对入口，不向已配对身份新增续签能力。
- 首次配对仅保留构建、隐藏输入票据和十分钟有效期等必要说明。已配对时提示直接运行 `run`，移除首次配对前置说明。
- HTTP / HTTPS 尾注默认隐藏，问号打开共享 `Dialog`。说明 `--server http://127.0.0.1:3330` 的本机配置，并明确「默认只接受 loopback HTTP；非 loopback 地址必须使用 HTTPS」「当前 Worker 没有 --allow-http 配置项，也不支持通过配置放开非 loopback HTTP」。不宣称新增协议能力。
- 真实页和演示页均复用 `MachineDetailPanel` / `MachineEnrollmentPanel` / `MachineInstallInstructions`。演示中选择「待配对的 MacBook」检查置顶，选择「工作室 Mac mini」检查降级，两者均可打开协议说明。场景脚本保留 29 项，真实流程保留 14 组，呈现断言并入相关组，覆盖 390 / 899 / 900 / 1199 / 1200 / 1440px 与浅暗主题。
- 位置证据与八张截图：`.verify/p4a-machine-scenes/priority-positions.json`、`priority-{pending,active}-{1440,390}-{light,dark}.png`。执行结果以本轮 `/tmp/sprout-p4a-detail-priority-report.md` 为准；Human 体验确认待 Human 明确给出。

## 基线

- 分支 `p4a/ui`，基线 `0a331031be49149a6dbbd6c786128c26695f045a`（共享契约与六表迁移）。
- 契约来源：`src/contracts/machine.ts`（Human 投影与输入）、`docs/p4a/contracts.md`。未复制第二套业务 DTO，未修改 schema、Worker 协议、领域授权、正式路由、`app-shell`、routeTree 或总计划 checklist。
- 演示依赖 `src/dev/scenes/machine/fixtures.ts`；正式组件不导入任何 dev 模块（`tests/frontend-boundaries.test.ts` 覆盖）。

## 组件与 props

| 文件                                                      | 职责                                                                                                | 主要 props                                                                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/machine/machine-view.ts`                  | 契约到展示模型的纯映射：连接/配对/观察文案、时间格式、安装命令                                      | 无组件                                                                                                                                                                      |
| `src/components/machine/machine-list.tsx`                 | Machines 列表与空态                                                                                 | `machines: MachineDetail[]`、`href(machineId)`、`renderLink`、`selectedId`、`emptyText`                                                                                     |
| `src/components/machine/machine-detail.tsx`               | 详情页：连接与配对事实、Shell 能力、Project 绑定、配对/安装侧栏                                     | `detail`、`back`、`enrollment`、`bindingProject`、`projectNames`、`onRenewEnrollment`、`onSaveBinding`、`onBindingSaved`、`onEnrollmentCreated`、`installOrigin`、`actions` |
| `src/components/machine/machine-create-dialog.tsx`        | 新建 Machine 表单（label、pending、防重、字段错误、失败保留输入）                                   | `open`、`onOpenChange`、`submit(values) => MachineResult<MachineEnrollment>`、`onCreated`、`trigger`                                                                        |
| `src/components/machine/machine-enrollment-panel.tsx`     | 配对状态、短期票据（默认隐藏）、续签（仅 pending）、网络异常呈现、安装说明                          | `machineId`、`enrollmentStatus`、`enrollment`、`onRenew(machineId) => MachineResult<MachineEnrollment>`、`installOrigin`                                                    |
| `src/components/machine/machine-binding-form.tsx`         | 加入 Project、说明与工作目录、共享 schema 校验、`expectedRevision` 冲突处理、失败保留输入           | `machineId`、`project`、`binding`、`submit(SaveProjectMachineBindingInput)`、`onSaved`                                                                                      |
| `src/components/machine/machine-install-instructions.tsx` | `init --server <origin> --machine <id> --state-dir <dir>` 与 `run --state-dir <dir>`；票据不进 argv | `machineId`、`origin`                                                                                                                                                       |

导航接口：列表用 `href` + 可选 `renderLink`，正式容器可以换成 TanStack `Link`，演示用 memory route 承接。组件不读取全局 `currentProject`，当前 Project 与返回目标都由调用方传入。

## 演示与运行

```bash
BETTER_AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  npx vp dev --host 127.0.0.1 --port 3077
# 列表：http://127.0.0.1:3077/__dev/ui/?scene=machines
node scripts/browser/p4a-machine-scenes.mjs
```

票据与续签状态按 `machineId` 归属：`machineId` 改变时清空票据、错误与 pending；迟到的续签结果只在发起它的 Machine 仍是当前 Machine 时写入。配对状态从待配对变为已配对时不再显示旧票据。绑定表单以 `Machine × Project` 为同步主键，revision 未变的重复读取不会覆盖正在编辑的草稿；说明可留空，长度规则复用 `saveProjectMachineBindingInput`，绑定表单不再编辑目录。Machine root 编辑区复用 `saveMachineRootDirectoryInput`，以当前 rootRevision 保存；冲突刷新事实并保留草稿后允许重试。

演示覆盖：在线/连接中/断线（stale、closed）、配对待用/已配对、无能力快照、旧代次能力与旧目录观察、绑定 revision、root revision、root 修改警告、root 清空、失败保留与冲突重试、空态、创建失败、续签失败、绑定保存失败、Project 切换。所有模拟操作在 `src/dev/scenes/machine/index.tsx` 内，面板明确标注“演示数据与本地模拟操作”，不冒充服务成功（无假 requestId，使用固定 `DEMO_REQUEST_ID` 的演示结果仅用于展示错误块）。

## 验证

| 项             | 命令                                          | 结果                                                                            |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| 格式与静态检查 | `pnpm check`                                  | 0 error，2 条既存 warning（其中一条 `scripts/ui-review/review.mjs` 为基线自带） |
| 类型           | `pnpm typecheck`                              | 通过                                                                            |
| 单元测试       | `npx vp test run tests/machine-view.test.ts`  | 6/6                                                                             |
| 全量测试       | `pnpm test`                                   | 见 `/tmp/sprout-p4a-ui-report.md`                                               |
| 浏览器         | `node scripts/browser/p4a-machine-scenes.mjs` | 19/19 PASS                                                                      |

浏览器脚本断言：列表状态文案不出现“空闲/已释放”；详情分离配对与连接；Shell 能力来自 `CapabilitySnapshot`；安装命令不含 `--ticket`，票据默认隐藏且长度 43；空说明可保存且显示“（无说明）”，修改 root 后旧 root revision 的目录观察不再标记“当前可达”；绑定保存后显示 description revision，root 保存成功声明仍需等待 Worker 观察；新增 root 失败草稿与冲突后重试、清空 root 和两个 Project 派生路径不同两项检查；保存/创建失败保留输入；续签抛网络错误时显示安全错误、pending 恢复且异常细节不外泄；续签后切到另一台 Machine 不出现前一台的票据；待配对转已配对后旧票据消失；active 无续签；390 浅色与暗色均无横向溢出，滚动展示绑定与安装区，长命令可滚动到末尾，演示控制不再固定覆盖底栏；纯演示没有 `/api/` 或 `/_server` 请求；既有 Agents 场景仍可用。

## 截图（`.verify/p4a-machine-scenes/`）

- `machines-list-1440-light.png`、`machines-list-1440-dark.png`、`machines-list-390-light.png`、`machines-list-390-dark.png`
- `machine-detail-1440-light.png`、`machine-detail-1440-dark.png`、`machine-detail-390-light.png`、`machine-detail-390-dark.png`
- `machine-detail-390-light-binding.png`、`machine-detail-390-light-install.png`、`machine-detail-390-dark-binding.png`、`machine-detail-390-dark-install.png`（滚动后的绑定与安装区）
- `machine-detail-offline-1440-light.png`（旧代次能力、旧目录观察）
- `machine-binding-error-1440-light.png`、`machine-create-error-1440-light.png`

截图待 coordinator 视觉核对；本单元只确认其生成时的实际页面状态。

## 续签请求的生命周期归属

- 一次续签归属「组件身份寿命 + 单次请求」，卡在 `machine-enrollment-panel.tsx` 的 `inFlight` 所有权 token 上；只比 `machineId` 会让 A→B→A 后的旧 A 请求重新拿到同名身份。
- 身份变化（`machineId` 改变）、组件卸载都会撤回旧请求的所有权：旧结果既不写入票据，也不清掉新身份的 pending 或错误。
- `enrollment` prop 以「内容」比较（MachineId + 到期 + 票据），同一身份的等价刷新不重放、不清掉已续签的一次性票据，也不打断进行中的请求。
- 展示层：`src/dev/scenes/machine/index.tsx` 的 `/machines/lifecycle` 探针挂真实 `MachineEnrollmentPanel`，由页面决定身份切换与请求结算顺序；`scripts/browser/p4a-machine-scenes.mjs` 用它做真实浏览器反证，不使用源码镜像测试。

## 票据的 render 归属

`MachineEnrollmentPanel` 每次 render 仅在 `enrollmentStatus === "pending"` 且 `current.detail.machine.id === machineId` 时使用票据。身份切换后的首次 DOM 提交也受此条件约束。传入其他 Machine 的 `enrollment` 不显示票据。effect 继续同步本地状态，请求 token 继续处理 A→B→A、卸载与迟到结果；同身份的等价刷新行为保留。

`/machines/lifecycle` 用 `React.Profiler.onRender` 在提交阶段读取正式组件的 DOM，只记录 MachineId、是否存在明文节点、归属是否正确。新增两项浏览器断言覆盖 A 展开后切 B 的每次提交、错配 enrollment prop 与合法票据展开隐藏，原 23 项断言保留。探针使用完全虚构的 43 字符票据，不输出票据值，截图前先隐藏票据。提交阶段证据不证明浏览器已 paint。

基线 `4f2766e32684560f76f86f0ed916220d49933772` 的独立真实组件探针在 3088 红测退出 1，B 首次提交有明文节点；修正后同探针退出 0。日志分别为 `/tmp/p4a-ticket-render-red.log` 与 `/tmp/p4a-ticket-render-green.log`。本次验证与限制见 `/tmp/sprout-p4a-ui-ticket-render-report.md`。

## 给集成线的接入说明

1. 列表：`listMachines()` → `MachineList`；`href` 接正式 `/machines/$machineId`，`renderLink` 传路由器 `Link`。入口从占位变为链接时只需改 `app-shell` 的 Machines 项与受影响定位断言。
2. 详情：`getMachine({ machineId, projectId })` → `MachineDetailPanel`；`back` 传返回列表的链接，`bindingProject` 由 URL 的 Project 上下文提供，`projectNames` 用于显示绑定所属 Project 名。
3. 创建：`createMachine({ name })` → `MachineCreateDialog.submit`；成功后用返回的 `MachineEnrollment` 打开详情并在 `MachineEnrollmentPanel` 展示票据。
4. 续签：`renewMachineEnrollment({ machineId })` → `onRenewEnrollment`；仅 pending 渲染入口，active 由组件自动隐藏。
5. 绑定：`saveProjectMachineBinding(input)` → `onSaveBinding`，只提交 Project 归属、说明与 description revision；`expectedRevision` 由组件从已有绑定取得，冲突按 `conflict` 展示并保留输入；成功后 `router.invalidate()` 重新读取本页。Project settings 页内复用该表单与 Fn，详情深链语义保留。
6. Root：`saveMachineRootDirectory(input)` → `onSaveRoot`，编辑状态属于详情页；`onRootRefresh` 在保存与冲突后刷新服务端事实。null 清空 root，不探测路径。展示路径只通过 `projectWorkingPath(root, projectId)` 派生，目录观察 revision 对应 rootRevision。
7. 安装说明：把 `installOrigin` 换成实际服务 origin；安装包与获取方式待功能线交付后补充文案，当前不虚构下载地址。
8. Project settings 的 Machine 区域由集成单元决定放置位置，组件本身不依赖页面骨架。

## 限制与待确认

- 历史演示阶段没有连接真实 `createMachine` / `renewMachineEnrollment` / `saveProjectMachineBinding`。当前已交付真实功能与正式接入，验证范围见 [正式接入记录](p4a-integration.md)。
- Worker 单文件产物与隐藏输入交互已交付，当前安装命令见 [Worker 指南](../p4a/worker.md)。
- 未执行真实 macOS Worker、跨机 TLS 或真机软键盘验证；无真机不宣称软键盘通过。
- Project settings 的 Machines 区域已按 Human 要求就地完成绑定，选择与保存均保留当前 URL；详情页 Project 上下文入口仍可用。
- 断线、连接中、旧能力的文案沿用设计基线状态语义；若 Human 希望更简的措辞，属于体验调整，未在本单元自行定稿。
