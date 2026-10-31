# P6a UI 实现报告

状态：页面组件与契约 fixture 门禁完成；**尚不能判定真实应用集成通过**。自动接续服务函数在本分支尚不存在，生产入口显示“当前状态未知”，未用 fixture 冒充真实调度。全量类型检查与 P5a/P5b 真实应用门禁有基线阻塞，详见下文。

分支：`p6a/ui`。提交标题：`feat(p6a): show automation state and human control on task and chat pages`。

## 页面结构与已选方案 A

输入为协调者选定的 [方案 A](../ui/design-a.html)、[语义矩阵与字段映射](p6a-ui-sketch-report.md)，以及后续交付的 [视觉评审](p6a-ui-vision-review.md)。这些输入位于主 checkout 的 `orchestrate/sprout-mio-p6/`；实现工作树原先没有该目录。

保留 A 的控制面板结构：独立自动接续卡片，顶部模式摘要与“会不会来”的说明，当前 Chat 范围，最近检查、结论与下次检查常显，暂停／恢复和停止入口，失败与退避说明。检查标识、逐接收者结论、投递标识、runId、revision/epoch 与 requestId 在原生 details 中按需展开。默认不展开诊断字段。

按真实契约调整了原型的停止语义。`stop` 命令带 `scope: chat`，停止本 Chat 自动检查；`stop_run` 命令另带具体 runId，仅停止选定 run。卡片明确说明暂停或停止自动检查不会停止当前 run。没有把 `mode=stopped` 渲染为 run 已停止，也没有新增 Task 状态。Human owner 仅展示提醒事实，没有自动接续 run 活动条或停止 run 控件。

实现复用现有 `Button`、`--muted-foreground`、`--destructive`、`rounded-container` 与边框 token，没有新增主题 token、shadow 或原型 CSS。

## 三条视觉必修项

以下三项来自 [P6a UI 视觉评审的“必须修才可用”](p6a-ui-vision-review.md)，本次仅落实这三项视觉修正：

1. **禁用停止入口可读性**：本卡片的“停止分身运行”以及禁用的停止自动接续按钮局部覆盖为 `disabled:opacity-100` / `data-disabled:opacity-100`，文字使用 `text-muted-foreground`。没有改全站 Button 默认态。浏览器门禁在三个视口均确认非运行态停止 run 按钮 disabled、计算不透明度至少 0.6（实际为 1），且文字计算色与中性摘要一致。已目视检查 768 非运行态和 390 暂停态截图。本次没有重新测量 WCAG 对比度数值，不沿用原型的 2.28:1 或声称新的实测比值。
2. **主动控制与异常分色**：enabled / paused / stopped 的模式标签使用中性色，暂停／停止不套 warning 琥珀色。判定失败、退避错误码与请求失败仍用既有 destructive 红色；投递未知明确写“不自动重投”，人工补发须显式确认可能重复处理。浏览器门禁核对 paused / stopped 标签与范围说明的中性计算色相同。
3. **768 布局错列**：范围说明是独立的整行块，不进入检查事实的双列 dl。增加 768 门禁，并在三个视口的全部八个状态验证该行宽度接近整个卡片内容区，不会挤到“周期检查”或其他右列。

## 文件与接入点

- `src/components/automation/automation-card.tsx`：完整冻结 `ChatAutomationView` 的受控展示；按原始字段显示调度、run、判定与投递事实。操作构造冻结 `ChatAutomationCommand`，带 projectId/chatId、expectedRevision、标准 `newId("req")`；stop、retry、reissue 与 stop_run 使用各自的明确标识。
- `src/components/automation/automation-page-data.ts`：页面读取数据与 command callback 的类型边界；denials 由上游提供，不在 UI 中根据身份重新计算权限。失败显示 reason/code 与上游 requestId。
- `src/components/automation/automation-panel.tsx`：有完整读取数据时展示卡片；缺少读取时明确显示状态未知与接线缺失，不伪造“已启用”“无 Task”或“未安排”。
- `src/components/automation/wake-provider-select.tsx`：Project 判定器选择、当前 policy 元数据及逐项不可用原因；未接入时选择与保存禁用。支持上游提供判定器可用性、denial 和保存 callback。仅展示 `small_brain` / `jev`，不自动 fallback，不在浏览器生成模型或阈值配置。
- Task 详情路由：在独立的 Chat / run / lease 事实区挂载自动接续入口。真实 ChatInfo 明确为 Human owner 时不展示 Task 的 Chat 活动 run 条。
- `chat-details.tsx` 与 `info-hub/chat-inspector.tsx`：挂载相同入口；均提供 `automation` / `onAutomationCommand` 可注入 props。
- Project settings：从真实 `getProjectFn` 返回对象读取可选 `wakePolicy`，显示当前值；未接入的配置写入明确禁用。

没有改动 `src/contracts/**`、DB schema、迁移或调度／领域服务。执行了 `pnpm exec tsr generate`；本次没有路由结构变更，生成命令单独移除 Start plugin 尾部声明的附带变化未纳入提交，保留既有生成物。

## 真实数据与 fixture 边界

当前 checkout 无自动接续 server functions，不能完成真实授权读取、Chat 控制写入或 Project policy 更新。

| 入口 / 数据 | 当前来源与行为 |
| --- | --- |
| Task / Chat / Inspector 自动接续 | 挂载共用组件入口，生产默认明确显示读取未接入、当前状态未知。没有自动使用 fixture。 |
| Project 当前判定器 | 来自已有真实 `getProjectFn` 的可选 `wakePolicy`。字段缺失时写“当前判定器配置未知”。 |
| 自动接续读取与操作 | 提供 `AutomationPageData` / `AutomationSubmit` 接口；尚未绑定真实函数。组件回调成功后由调用者提供返回的完整 view，不在组件内推算新状态。 |
| Project 判定器可用性与保存 | 未有真实服务；默认逐项不可用，保存禁用。真实数据可通过 props 接入。 |
| 八态浏览器展示 | `tests/fixtures/p6a-pages.ts` 的明确、冻结类型约束的读取 fixture，分别为 idle / scheduled / paused / stopped / failure / unknown / human / denied。 |
| 浏览器操作响应 | `p6a-pages-client.tsx` 中的显式 canned response。保留独立 run / delivery 事实，仅用于检验按钮和回读更新，不是调度实现。 |

后续集成者需将服务端授权查询结果注入这些入口；Task loader 需随 Chat 读取完整 automation view；Chat loader / wiring 将其传给两个 inspector；Project policy 服务提供可用性与更新接口。禁止从已有 Task 状态或 Info Hub 摘要拼造完整 view。现有 `ChatAutomationView` 没有 capabilities 字段，页面 denials 是独立适配数据，必须由服务授权结果提供。

fixture 仅通过冻结 TypeScript 类型约束，没有声称运行时 schema 校验通过。首次运行时引入冻结 schema 就触发下述基线循环；隔离的组件门禁因此只导入契约类型。真实服务返回值的运行时校验与完整页面集成仍需在基线修复后重跑。

## 实际验证

长任务通过后台进程启动，保存独立日志、PID 与退出码，按完成标志观察；没有把启动命令返回当作测试完成。下表为实际执行结果，不是计划。

| 命令 | 结果 | 范围与证据 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 | 工作树原先无 node_modules；未改 lockfile。 |
| `pnpm exec vp test tests/task-automation-view.test.ts` | exit 0，9 项通过 | 三事实独立、暂停保留活动 run、暂停／停止不会来、失败与退避、Human 无 run 条、denials reason/code、投递未知确认入口、读取未知、判定器不可用。最终日志 `/tmp/p6a-ui-unit.log`。 |
| `bash scripts/verify/p6a-pages.sh` | **exit 0，143 组断言通过** | 实际共用组件与产品 styles.css，1280 / 768 / 390；每视口八态。无横向滚动、独立范围行、关键文案、disabled、三条视觉必修项、暂停／恢复回读、停止确认取消、补发确认与 conflict 不假装成功。pageerror=0、console.error=0。日志 `/tmp/p6a-ui-pages.log`。 |
| 改动文件 `pnpm exec vp lint ...` | exit 0 | 页面、组件、测试和 fixture 的 type-aware lint。日志 `/tmp/p6a-ui-lint.log`。 |
| 改动文件 `pnpm exec vp fmt --check ...` | exit 0 | 同上。日志 `/tmp/p6a-ui-fmt.log`。 |
| `pnpm exec tsr generate` | exit 0 | 无新增路由；生成物无提交变化。 |
| `pnpm typecheck` | **exit 2，未通过** | 剩余两处均为未改动的 extension 文件，详见下节；没有本单元文件错误。日志 `/tmp/p6a-ui-typecheck.log`。 |
| `bash scripts/verify/as-p5b-task-pages.sh` | **exit 1，未通过** | 实际启动了 dev server；因契约循环，等候 ready 超时，未执行页面断言。日志 `/tmp/p6a-ui-p5b.log` 与 `.verify/as-p5b-task-pages/server.log`。 |
| `bash scripts/verify/as-p5a-chat-ui.sh` | **exit 1，未通过** | prepare 的真实应用 build / prerender 因相同契约循环失败，未进入浏览器断言。日志 `/tmp/p6a-ui-p5a.log` 与 `.verify/as-p5a-chat-ui/build.log`。 |

浏览器共有 24 张状态截图：`/tmp/sprout-p6a-pages-evidence/{1280,768,390}-{idle,scheduled,paused,stopped,failure,unknown,human,denied}.png`。这是 Chromium 组件 fixture 的截图，不是已接真实调度服务的 Task / Chat 页面验收。没有将脚本的 143 个 PASS 标签表述为 143 个独立产品场景或底层 assert 语句；部分标签包含多条相关断言。

此前还执行过 `vp test tests/task-automation-view.test.ts tests/task-view.test.ts`：当时两套都在契约初始化时失败、0 测试断言执行。移除组件 fixture 对无关运行时契约的引入后，新组件测试独立通过；既有 Task suite 的循环阻塞没有被修复，也没有计入通过。

## 基线阻塞与未验证项

1. **冻结契约循环初始化**：`agent.ts` 重新导出 `project.ts` 的 `fieldErrorsFrom`；`project.ts` 新引入 wake-evaluation；wake-evaluation 引入 task / chat / agent-run；task / chat 又引用尚未初始化的 agent / chat schema。按入口顺序分别出现 `taskRecordRefSchema.readonly()`、`chatKindSchema.optional()` 或 `agentProfileIdSchema` 未初始化异常。两条既有真实页面门禁在这一链路失败。由于 brief 明确禁止改冻结契约，本提交没有改它们或用 mock 让真实应用门禁显示通过。
2. **全量类型检查的两处既存错误**：`src/extension/remote-client.ts:88` 的联合类型新增项目级请求后不能无条件读 machineId；`src/extension/remote-tools.ts:19` 的工具描述表缺少 `sprout_chat_automation_get`。未在页面单元中越界修复。
3. **服务尚未接入**：未验证真实暂停／停止／恢复、判定器保存、调度重试、Host 送达与补发、持久化与权限竞争；浏览器控件交互仅验证冻结命令形状与显式 fixture 回读。
4. 未做 Human 对真实应用的操作验收、Firefox / Safari、暗色主题或完整 WCAG 审计。未声称方案 A 的静态视觉通过等于本次产品 Human 验收通过。

最终交付包含可运行的共用组件 fixture、组件测试、浏览器门禁与诚实的生产未接入状态。协调者需在领域服务与基线修复集成后绑定读取／操作，再重跑全量 typecheck、P5a/P5b 以及真实 P6a 页面验收。
