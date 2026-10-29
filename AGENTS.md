# AGENTS.md

## 项目规范入口

开始任务时，先读 [项目开发约定](docs/project-conventions.md)。再按下表读取本次任务涉及的文档；任务跨多个领域时合并读取，不预加载全部文档。动手前核对受影响的实现、业务契约与验收脚本。

| 遇到的任务                                                | 必读文档                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 确定当前阶段、分派任务、集成或记录完成状态                | [开发总计划](docs/development-plan.md)，再按任务进入功能计划或 UI 计划及对应章节      |
| 新增或调整能力、术语、身份、权限或生命周期                | [核心范围](docs/core-scope.md)及对应领域决策文档，见下表                              |
| 修改代码、共享契约、配置、数据库或迁移                    | [P1 开发约定](docs/p1/conventions.md)及对应章节的契约文档                             |
| 修改前端设计、组件、页面、样式或交互                      | [前端设计基线](docs/frontend-design.md)和[前端开发约定](docs/frontend-conventions.md) |
| 选择验证范围、编写 worker brief、执行验证或准备合并与交付 | [验证约定](docs/verification.md)                                                      |
| 启动真实页面评审、处理 Human 页面反馈或记录体验确认       | [Human Review](docs/human-review.md)及仓库的 `human-review` skill                     |
| 定位功能入口、选择操作路径或核对验收覆盖                  | [Feature map](docs/feature-map/README.md)，再读受影响的功能页                         |
| 调整项目规范或沉淀编排经验                                | [项目开发约定](docs/project-conventions.md#维护项目规范)，再读受影响领域的规范        |

## 领域文档

以下文档按任务领域读取；当前章节的具体契约从开发计划进入。

| 领域               | 文档                                                        |
| ------------------ | ----------------------------------------------------------- |
| 整体架构与运行边界 | [架构方向](docs/architecture-direction.md)                  |
| Web UI 与导航      | [Web UI 决策](docs/web-ui-decisions.md)                     |
| Agent 配置         | [Agent Profiles 决策](docs/agent-profiles-decisions.md)     |
| Project 配置       | [Project Profiles 决策](docs/project-profiles-decisions.md) |
| Machine 与执行环境 | [Machines 决策](docs/machines-decisions.md)                 |
| 通信               | [Communication 决策](docs/communication-decisions.md)       |
| Info Hub           | [Info Hub 决策](docs/info-hub-decisions.md)                 |
| Task               | [Tasks 决策](docs/tasks-decisions.md)                       |
