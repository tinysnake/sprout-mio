# UI-P4a Machine 连接与绑定（演示交付）

状态：UI 呈现与可操作演示已交付，真实路由与 server function 接入留给 I-P4a 集成单元。本记录不是技术验收，也不是 Human 体验确认。视觉读图核验由 coordinator 执行，本单元只保存截图并声明其内容。

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

票据与续签状态按 `machineId` 归属：`machineId` 改变时清空票据、错误与 pending；迟到的续签结果只在发起它的 Machine 仍是当前 Machine 时写入。配对状态从待配对变为已配对时不再显示旧票据。绑定表单以 `Machine × Project` 为同步主键，revision 未变的重复读取不会覆盖正在编辑的草稿；说明可留空，长度与目录规则直接复用 `saveProjectMachineBindingInput`。

演示覆盖：在线/连接中/断线（stale、closed）、配对待用/已配对、无能力快照、旧代次能力与旧目录观察、绑定 revision、空态、创建失败、续签失败、绑定保存失败、Project 切换。所有模拟操作在 `src/dev/scenes/machine/index.tsx` 内，面板明确标注“演示数据与本地模拟操作”，不冒充服务成功（无假 requestId，使用固定 `DEMO_REQUEST_ID` 的演示结果仅用于展示错误块）。

## 验证

| 项             | 命令                                          | 结果                                                                            |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| 格式与静态检查 | `pnpm check`                                  | 0 error，2 条既存 warning（其中一条 `scripts/ui-review/review.mjs` 为基线自带） |
| 类型           | `pnpm typecheck`                              | 通过                                                                            |
| 单元测试       | `npx vp test run tests/machine-view.test.ts`  | 6/6                                                                             |
| 全量测试       | `pnpm test`                                   | 见 `/tmp/sprout-p4a-ui-report.md`                                               |
| 浏览器         | `node scripts/browser/p4a-machine-scenes.mjs` | 19/19 PASS                                                                      |

浏览器脚本断言：列表状态文案不出现“空闲/已释放”；详情分离配对与连接；Shell 能力来自 `CapabilitySnapshot`；安装命令不含 `--ticket`，票据默认隐藏且长度 43；空说明可保存且显示“（无说明）”，保存后旧 revision 的目录观察不再标记“当前可达”；绑定保存后显示 revision 且声明“不代表 Worker 已验证该目录可达”；保存/创建失败保留输入；续签抛网络错误时显示安全错误、pending 恢复且异常细节不外泄；续签后切到另一台 Machine 不出现前一台的票据；待配对转已配对后旧票据消失；active 无续签；390 浅色与暗色均无横向溢出，滚动展示绑定与安装区，长命令可滚动到末尾，演示控制不再固定覆盖底栏；纯演示没有 `/api/` 或 `/_server` 请求；既有 Agents 场景仍可用。

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
5. 绑定：`saveProjectMachineBinding(input)` → `onSaveBinding`，`expectedRevision` 由组件从已有绑定取得，冲突按 `conflict` 展示并保留输入；成功后建议 `router.invalidate()` 重新读取 detail。
6. 安装说明：把 `installOrigin` 换成实际服务 origin；安装包与获取方式待功能线交付后补充文案，当前不虚构下载地址。
7. Project settings 的 Machine 区域由集成单元决定放置位置，组件本身不依赖页面骨架。

## 限制与待确认

- 真实 `createMachine` / `renewMachineEnrollment` / `saveProjectMachineBinding` 尚不存在；演示回调不是服务实现，未验证真实授权、冲突与持久化。
- Worker 安装包、`init` 的实际交互方式（隐藏输入还是 `--ticket-file`）以功能线交付为准；本单元只固定契约中的参数形状。
- 未执行真实 macOS Worker、跨机 TLS 或真机软键盘验证；无真机不宣称软键盘通过。
- Project settings 内 Machine 区域的位置与命名（“Machines” 还是“连接的 Machine”）未由设计基线指定，留给集成线与 Human 确认。
- 断线、连接中、旧能力的文案沿用设计基线状态语义；若 Human 希望更简的措辞，属于体验调整，未在本单元自行定稿。
