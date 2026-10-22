# I-P1/P2 UI 迁移记录

状态：迁移进行中，尚未通过技术验收，尚未获得 Human 体验确认。编排入口为 [开发总计划](../../development-plan.md#i-p1p2-集成基础页面与持久对话)。

## 基线与范围

- 功能及规则基线：`edd198b`，继承已有 P1–P3 功能与部分交付限制。
- 设计参考：`design/archive/opendesign-p1p2/source.tar.gz`，完整性以 manifest 为准；已验证独立构建和 56 条原型测试。
- 设计规则：`docs/frontend-design.md`；代码约定：`docs/frontend-conventions.md`。
- 本轮迁移 UI 基础与 P1/P2，包含共享组件、应用导航、登录、Project 分发与创建、Agent、Members、Settings、DM 和已有 Info Hub。同步侧栏折叠、无独立 Project 详情、基本事实并入 Settings。
- 保留 P3 已有的消息、追加、停止、运行状态、profile 下一轮生效提示和宿主仓库入口；不新增 P3 未交付能力，不进入 P4–P7。
- 正式 URL 继续采用文件路由：`/projects`，`/projects/$projectId/chats` 及其详情，`/agents` 及其详情，Project settings；Members 正式路径统一到 `/projects/$projectId/members`，同轮更新调用方和验收，不保留旧 `/agents` 子路由别名。
- 本轮开始时 `.agents/` 与 `skills-lock.json` 是用户工作区未跟踪文件，不纳入迁移提交。

## 内部任务与责任

| 单元 | 内容 | 依赖 | 状态 |
| --- | --- | --- | --- |
| u1 | 共享基础组件、主题、字体、全局 base 和轻量开发演示入口 | 当前设计基线 | 实施中 |
| u2 | 应用侧栏、Project 选择器、移动导航与 Project 入口分发 | u1 的公共接口 | 实施中 |
| u3 | 登录、Agent、Members、Settings 和 Project 创建呈现，保留真实操作 | u1、u2 | 待实施 |
| u4 | Chat 列表 / 详情 / inspector 分栏，保留运行与消息行为 | u1、u2 | 待实施 |
| u5 | 共用正式组件的场景、机械约束门禁、截图与交互验证 | u3、u4 | 待实施 |
| u6 | 真实路径、持久性、隔离、P3 能力回归及独立技术验收 | u5 | 待实施 |

内部单元只用于分派与核对，不新增集成里程碑。实现者自检通过后由未参与实现的 agent 进行独立验收；技术结论与 Human 确认分开记录。

## 共享接口

基础组件保持既有 Button / Dialog 的公开调用可用，同轮适配所有调用方，不引入另一套基础库。

- `components/ui/input.tsx`、`textarea.tsx`、`select.tsx`：原生控件的统一视觉包装。
- `components/ui/field.tsx`：`Field({ label, htmlFor?, hint?, error?, children, className? })`，错误与说明可关联到控件。
- `components/ui/icon.tsx`：`Icon({ as, size?, ...svgProps })`，默认 16px / 1.5 stroke。
- `components/layout/page-frame.tsx`：`PageFrame({ title, description?, back?, actions?, children, testId? })`，back 为 link 节点。
- `components/layout/theme-toggle.tsx`：自包含主题切换按钮，使用统一主题状态。
- `lib/theme.ts`：主题偏好与初始化，浅暗状态在应用和开发场景之间一致。
- `components/layout/app-shell.tsx`：应用外壳及 `useAppShell()`，提供 `{ sidebarWidth: number }` 供 Chat 布局分配空间；应用外壳根据视口和 inspector 的 URL 状态处理自动 rail。

## Risk → Test

| 风险 | 验证方式 |
| --- | --- |
| 导航改组导致深链、刷新、前后退或 Project 上下文丢失 | 真实浏览器及更新后的路由矩阵 |
| 布局挤没列表、隐藏筛选继续生效、手机无法返回 | 390 / 901 / 1024 / 1199 / 1200 / 1440px 与边界两侧浏览器检查 |
| 表单改造破坏保存、失败保留草稿、重复提交或下一轮生效语义 | 真实表单操作与对应既有验收 |
| 新布局删除身份、持久性、隔离或 P3 功能 | 原有 verify 行为断言与相关 P3 回归 |
| 演示变成另一份 UI，或 fixture 泄入产品 | 共用组件场景核对、导入边界门禁与生产产物检查 |
| 共享 token / 组件视觉漂移 | 浅暗与宽窄屏截图、实际读图、对照归档和规则；不把假数据画面当真实业务验收 |

本文件后续补充实现 commit、运行地址、命令、逐项结果、证据与未验证项。所有完成结论以实际核对结果为准。
