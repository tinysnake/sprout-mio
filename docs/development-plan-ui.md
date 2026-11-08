# UI 开发专项计划

> **当前编排从[开发总计划](development-plan.md)开始。** 一期 UI 执行记录已归档。首版界面随自动化与助理功能单元交付，webhook 配置与来源展示已实现并完成浏览器技术验证，Human 体验尚未确认。

P4–P7 的带版本 Human 确认保留在各章 summary。P7 已确认除 PWA 装机外的一期客户端体验；安装、独立窗口与离线体验延后到部署及 HTTPS 就绪后评审，原 UI-P7 第 3 条保持未勾。当前状态及其证据见[总计划](development-plan.md#一期交付状态)。

[一期 UI 计划快照](archive/phase-one/development-plan-ui.md)保留设计、演示前端与交付清单。快照内的等待与暂停安排属于历史执行记录，不触发新一轮设计或页面评审。设计稿、验收与 Human 反馈证据保持原位，见[一期归档索引](archive/phase-one/README.md)。

## 首版界面单元

界面服务于[首版推进顺序](development-plan.md#首版推进顺序)，复用已有 Project、Agent 配置及 DM 页面，不新增独立助理聊天系统。

- [ ] Project 内的自动化入口，提供 webhook / cron 列表、配置、启停、试运行、触发记录及工作 Chat 跳转。首期每条规则只配置一个消息动作。Webhook 部分已完成；cron 尚未实现。
- [ ] 消息中明确展示系统来源与关联规则，Human 手动消息保持可区分。来源标记与 Group 指定 Agent / owner 配置已实现；消息内直接展示关联规则的入口尚未实现。触发历史提供原 Chat 跳转。
- [ ] 助理 profile 的模型、effort 与能力配置，以及 Project 内的普通助理 DM。
- [ ] 具体目标和操作的提案展示、明确确认、已提交与失效状态，以及 watch 的查看和取消。
- [ ] 飞书身份与助理 DM 绑定的选择、切换、解绑和异常状态。绑定失效不自动切换目标，重连不自动补发历史。

新页面形状遵循[页面设计约定](project-conventions.md#页面设计与实现的分工)，具体组件与样式在实施前读取前端基线和开发约定。页面交付按[Human Review](human-review.md)在真实应用中验证，技术检查与 Human 确认分别记录。

## 旧章节链接

以下锚点保留供旧链接访问，均转到一期归档中的原章节。

- <a id="沿用功能章节安排交付"></a>[沿用功能章节安排交付](archive/phase-one/development-plan-ui.md#沿用功能章节安排交付)
- <a id="先追赶已有功能"></a>[先追赶已有功能](archive/phase-one/development-plan-ui.md#先追赶已有功能)
- <a id="在仓库中设计演示与迭代"></a>[在仓库中设计、演示与迭代](archive/phase-one/development-plan-ui.md#在仓库中设计演示与迭代)
- <a id="页面预览与-dom-capture-体验和反馈"></a>[页面预览与 DOM Capture 体验和反馈](archive/phase-one/development-plan-ui.md#页面预览与-dom-capture-体验和反馈)
- <a id="当前原型迁入仓库的顺序"></a>[当前原型迁入仓库的顺序](archive/phase-one/development-plan-ui.md#当前原型迁入仓库的顺序)
- <a id="保持已确认的体验方向"></a>[保持已确认的体验方向](archive/phase-one/development-plan-ui.md#保持已确认的体验方向)
- <a id="交付演示前端与章节材料"></a>[交付演示前端与章节材料](archive/phase-one/development-plan-ui.md#交付演示前端与章节材料)
- <a id="ui-基础-建立设计语言与共享布局"></a>[UI 基础 建立设计语言与共享布局](archive/phase-one/development-plan-ui.md#ui-基础-建立设计语言与共享布局)
- <a id="ui-p1p2-追赶基础页面与持久对话"></a>[UI-P1/P2 追赶基础页面与持久对话](archive/phase-one/development-plan-ui.md#ui-p1p2-追赶基础页面与持久对话)
- <a id="ui-p3-追赶真实对话与宿主仓库入口"></a>[UI-P3 追赶真实对话与宿主仓库入口](archive/phase-one/development-plan-ui.md#ui-p3-追赶真实对话与宿主仓库入口)
- <a id="ui-p4a-展示-machine-连接与绑定"></a>[UI-P4a 展示 Machine 连接与绑定](archive/phase-one/development-plan-ui.md#ui-p4a-展示-machine-连接与绑定)
- <a id="ui-p4b-展示分身持租与远端操作"></a>[UI-P4b 展示分身持租与远端操作](archive/phase-one/development-plan-ui.md#ui-p4b-展示分身持租与远端操作)
- <a id="ui-p4c-展示长命令与不确定结果"></a>[UI-P4c 展示长命令与不确定结果](archive/phase-one/development-plan-ui.md#ui-p4c-展示长命令与不确定结果)
- <a id="ui-p4d-完成交接收回与移除交互"></a>[UI-P4d 完成交接收回与移除交互](archive/phase-one/development-plan-ui.md#ui-p4d-完成交接收回与移除交互)
- <a id="ui-p5a-完成多人-chat"></a>[UI-P5a 完成多人 Chat](archive/phase-one/development-plan-ui.md#ui-p5a-完成多人-chat)
- <a id="ui-p5b-完成-task-总览与生命周期"></a>[UI-P5b 完成 Task 总览与生命周期](archive/phase-one/development-plan-ui.md#ui-p5b-完成-task-总览与生命周期)
- <a id="ui-p6a-完成对话接续与人类控制呈现"></a>[UI-P6a 完成对话接续与人类控制呈现](archive/phase-one/development-plan-ui.md#ui-p6a-完成对话接续与人类控制呈现)
- <a id="ui-p6b-完成-info-hub-全部一期视角呈现"></a>[UI-P6b 完成 Info Hub 全部一期视角呈现](archive/phase-one/development-plan-ui.md#ui-p6b-完成-info-hub-全部一期视角呈现)
- <a id="ui-p6c-完成成员治理与重新加入呈现"></a>[UI-P6c 完成成员治理与重新加入呈现](archive/phase-one/development-plan-ui.md#ui-p6c-完成成员治理与重新加入呈现)
- <a id="ui-p7-完成客户端与一期体验验收"></a>[UI-P7 完成客户端与一期体验验收](archive/phase-one/development-plan-ui.md#ui-p7-完成客户端与一期体验验收)
- <a id="按章节检查完成证据"></a>[按章节检查完成证据](archive/phase-one/development-plan-ui.md#按章节检查完成证据)
