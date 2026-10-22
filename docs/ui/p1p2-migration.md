# I-P1/P2 UI 迁移记录

状态：迁移进行中，尚未通过技术验收，尚未获得 Human 体验确认。编排入口为 [开发总计划](../development-plan.md#i-p1p2-集成基础页面与持久对话)。本轮在 `251ddbb` 上实跑 46 项浏览器检查，其中真实业务 10 项 **9 通过 / 1 失败（pending）**，失败项为 `settings` 页 React 重复 key；已交回归 worker 修复，修复合入后只重跑该 10 项。

## 基线与范围

- 功能及规则基线：`edd198b`，继承已有 P1–P3 功能与部分交付限制。
- 设计参考：`design/archive/opendesign-p1p2/source.tar.gz`，完整性以 manifest 为准；已验证独立构建和 56 条原型测试。
- 设计规则：`docs/frontend-design.md`；代码约定：`docs/frontend-conventions.md`。
- 本轮迁移 UI 基础与 P1/P2，包含共享组件、应用导航、登录、Project 分发与创建、Agent、Members、Settings、DM 和已有 Info Hub。同步侧栏折叠、无独立 Project 详情、基本事实并入 Settings。
- 保留 P3 已有的消息、追加、停止、运行状态、profile 下一轮生效提示和宿主仓库入口；不新增 P3 未交付能力，不进入 P4–P7。
- 正式 URL 继续采用文件路由：`/projects`，`/projects/$projectId/chats` 及其详情，`/agents` 及其详情，Project settings；Members 正式路径统一到 `/projects/$projectId/members`，同轮更新调用方和验收，不保留旧 `/agents` 子路由别名。
- 本轮开始时 `.agents/` 与 `skills-lock.json` 是用户工作区未跟踪文件，不纳入迁移提交。

## 内部任务与责任

| 单元 | 内容                                                             | 依赖          | 状态                       |
| ---- | ---------------------------------------------------------------- | ------------- | -------------------------- |
| u1   | 共享基础组件、主题、字体、全局 base 和轻量开发演示入口           | 当前设计基线  | 已合入，基础复测通过       |
| u2   | 应用侧栏、Project 选择器、移动导航与 Project 入口分发            | u1 的公共接口 | 已提交，待集成验证         |
| u3   | 登录、Agent、Members、Settings 和 Project 创建呈现，保留真实操作 | u1、u2        | 已合入，单元与场景复测通过 |
| u4   | Chat 列表 / 详情 / inspector 分栏，保留运行与消息行为            | u1、u2        | 已合入，基础复测通过       |
| u5   | 共用正式组件的场景、机械约束门禁、截图与交互验证                 | u3、u4        | 实施中                     |
| u6   | 真实路径、持久性、隔离、P3 能力回归及独立技术验收                | u5            | 验收脚本已迁移，待真实联调 |

内部单元只用于分派与核对，不新增集成里程碑。实现者自检通过后由未参与实现的 agent 进行独立验收；技术结论与 Human 确认分开记录。

## 共享接口

基础组件保持既有 Button / Dialog 的公开调用可用，同轮适配所有调用方，不引入另一套基础库。

- `components/ui/input.tsx`、`textarea.tsx`、`select.tsx`：原生控件的统一视觉包装。
- `components/ui/field.tsx`：`Field({ label, htmlFor?, hint?, error?, children, className? })`，错误与说明可关联到控件。
- `components/ui/icon.tsx`：`Icon({ as, size?, ...svgProps })`，默认 16px / 1.5 stroke。
- `components/layout/page-frame.tsx`：`PageFrame({ title, description?, back?, actions?, children, testId? })`，back 为 link 节点。
- `components/layout/theme-toggle.tsx`：自包含主题切换按钮，使用统一主题状态。
- `lib/theme.ts`：主题偏好与初始化，浅暗状态在应用和开发场景之间一致。
- `components/layout/app-shell.tsx`：应用外壳及 `useAppShell()`，提供 `{ sidebarWidth: number, openProjectCreation: () => void }`；Chat 据此分配空间，创建入口调用稳定外壳中的表单。外壳通过 `onCreateProject` 接收动作，根据视口和 inspector 的 URL 状态处理自动 rail。

## Risk → Test

| 风险                                                     | 验证方式                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| 导航改组导致深链、刷新、前后退或 Project 上下文丢失      | 真实浏览器及更新后的路由矩阵                                             |
| 布局挤没列表、隐藏筛选继续生效、手机无法返回             | 390 / 901 / 1024 / 1199 / 1200 / 1440px 与边界两侧浏览器检查             |
| 表单改造破坏保存、失败保留草稿、重复提交或下一轮生效语义 | 真实表单操作与对应既有验收                                               |
| 新布局删除身份、持久性、隔离或 P3 功能                   | 原有 verify 行为断言与相关 P3 回归                                       |
| 演示变成另一份 UI，或 fixture 泄入产品                   | 共用组件场景核对、导入边界门禁与生产产物检查                             |
| 共享 token / 组件视觉漂移                                | 浅暗与宽窄屏截图、实际读图、对照归档和规则；不把假数据画面当真实业务验收 |

## 已形成的实现与验证契约

- `d9e80b9`：应用外壳、Project 分发、成员路由及第一版源码边界门禁；等待完整页面联调。
- `3ada504`、`0a64fd9`：共享控件、主题、PageFrame、dev-only gallery 与 Dialog 几何修正，已合入。主线程重跑单元测试、build 与 16 项真实浏览器检查均通过；已查看桌面浅色 Dialog、手机暗色 gallery 与 Dialog 截图。命令、测量值和六张图片的 SHA-256 见 [基础验证记录](evidence/p1p2/base-verification.json)。
- `2c8c3f3`：浏览器验收迁移到侧栏与 Settings；主线程重跑六项 JS 语法、三项 bash 语法及 f/l 文档门禁均通过，真实业务验证待页面组装。
- `83b362e`、`9e9d07f`：管理页呈现与场景已合入。主线程在独立 SQLite 和临时场景宿主重跑 147 个测试、build、typecheck、14 项场景检查及 10 项真实路径检查，均通过。首次临时宿主漏传 `scene` 导致超时，修正宿主后重新完整运行浏览器检查，未据首次结果判断产品。
- `e3c0821`：Chat 三栏、列表、消息输入、Info Hub 和按 Chat 隔离草稿已合入。主线程重跑相关 27 个测试、build、typecheck 均通过；完整持久性、隔离及 P3 回归仍待联调。
- 实际浏览器复现 Project 创建弹层在 1440→390px 消失；创建状态与 Dialog 已移至稳定的已登录外壳，复跑后弹层与输入草稿均保留，无 page error。关闭焦点按原触发点、Project 选择器、移动 Projects 控件依次恢复，完整焦点检查由响应式验收覆盖。
- 新建 DM 在导航前同步刷新父级 loader；Info Hub 摘要与输入区依据真实宿主状态呈现，避免宿主未启用时显示活动 run 数或“准备就绪”。对应真实流程继续复测。
- Project 级 Info Hub 保留在 Settings 的「关联信息」折叠区；Chat 级 Info Hub 由 `?info=1` 打开。验收通过可见控件展开，保留请求、身份、消息持久性和 P3 run 的原有断言。
- 新增 `scripts/verify/r-ui-layout.sh` 与 `scripts/browser/ui-layout-flow.mjs`，使用独立临时数据库和 production server 验证响应式与开发入口隔离；目前仅数据准备流程已实跑，完整布局结果待页面合入。
- 统一开发入口 `src/dev/ui/` 已接通，共用真实 AppShell、管理页与 Chat 呈现组件；移除单独的 Chat HTML / main / Shell 入口。组合检查覆盖路由对象一致、草稿隔离、模拟消息实际进入消息列表与 Info Hub 计数、模拟停止、跨断点焦点、浅暗/宽窄场景，并确认 fixture 操作没有调用应用 API。
- `251ddbb` 上本轮实跑同一组 46 项：其它 36 项（gallery 16、管理场景 14、组合场景 6）通过；真实业务 10 项为 **9 通过 / 1 失败，整体 pending**。失败项是真实业务流程最后的 `no_console_errors`，两条 React 重复 key 警告，只在 `/projects/$projectId/settings` 复现，首因与范围见 [最终验证记录](evidence/p1p2/final-verification.json)。已交回归 worker 修复，修复合入后只重跑该 10 项，不重复其它 36 项。此前的 46 项全过结论来自更早的独立运行，不作为当前结论。
- 响应式第二轮 28 项全通过；补上手机各面板占满宽度、等待返回列表实际可见，以及零 Project fixture 的诊断事件外键清理。随后新增手机返回和搜索触控尺寸检查，随完整回归再次验证。
- 手机空列表已做 DOM 红绿复验：恢复旧布局时，390px 视口中的列表仅为 300.625px，断言失败；恢复修复后为 390px，断言通过。永久响应式检查同时覆盖有消息列表与零 Project 创建后的空列表。
- 新截图保存到 `docs/ui/evidence/p1p2/`。既有浏览器流程接受 `SPROUT_UI_EVIDENCE_DIR`，本轮运行指向该目录，保留此前 P1/P3 截图。目录内的图片按阶段分三类记录在 [最终验证记录](evidence/p1p2/final-verification.json) 的 `images`、`regressionImages`、`retained` 三处：本轮 251ddbb 新跑的 46 项截图、回归脚本在 251ddbb 上产出的 R/P3 与断点图、以及原样保留但不计入最终版本的早期 foundation 与 `8f7cce2` 前后历史图。
- 导入门禁覆盖 TS 静态导入、导出、字面量动态导入和 CSS `@import`，包含 Vite `/src/` 路径；CSS 误导入 `src/dev` 的红测已验证失败，移除探针后恢复通过。基础合入后的源码边界、token 和主题偏好三组单测共 9 项通过；正式业务组件合入后继续核对。

## 阶段性结果

本轮在独立 worktree、基线 `251ddbb` 上完成一次可复核的记录，未修改 `src/`、`scripts/`、`tests/` 或总计划验收勾选。

- 环境：独立 SQLite `/tmp/ui-final-evidence/preview.sqlite`，`APP_ORIGIN=http://127.0.0.1:3261`，`SPROUT_PI_ENABLED=false`，`BETTER_AUTH_SECRET` 临时随机生成且未落盘记录。
- 46 项浏览器检查：基础 gallery 16 项通过，管理场景 14 项通过，组合场景 6 项通过，共 36 项已过；真实业务 10 项 9 过 1 失败，**标为 pending**。唯一失败项是真实流程末尾的 `no_console_errors`。修复合入后只重跑这 10 项。
- 失败首因：`src/routes/_authed/projects.$projectId.settings.tsx` 同一 Fragment 下 `ProjectBasicInfoForm`、`ProjectConfigForm`、`ProjectRepoPanel` 三个同级节点都以 `projectId` 作 key，值相同，React 判为重复 key。数据本身唯一，无 pageerror、无请求失败、无跨 Project 串号；该页其余断言全部通过。按任务边界只记录，未改产品代码与断言。
- 回归阶段：独立 worker 在 `251ddbb` 上跑 `bash scripts/verify.sh`，21 个脚本 `failed=0`，单测 158 项通过，`r-ui-layout` 29 项通过；该结论为 worker 执行通过，主线程本机复跑与最终判定仍待完成。
- 截图：生成截图不等于视觉验收。本轮图片的生成命令、代码 commit、`HEAD:src` 树 hash（`e61c23a`）、每张图的 sha256、场景、主题、视口与来源写在 [最终验证记录](evidence/p1p2/final-verification.json)。

## 仍待完成

- 技术验收：真实业务 10 项 pending，待重复 key 修复合入后只重跑该 10 项（其余 36 项不重复）；整轮回归由主线程本机复跑。当前不宣称技术通过。
- 真实业务证据：`final-real-*.png` 与 `images` 中来源为真实业务的 5 张图当前对应的是修复前状态，修复后重跑时需替换并更新 sha256。
- 视觉验收：需实际读图。本记录不描述未查看的图片，也不把截图存在当作视觉结论。
- Human 体验确认：未获得，根目录计划与总计划均不勾选。

后续补充逐项命令、最终绿色结果与 Human 确认。所有完成结论以实际核对结果为准。
