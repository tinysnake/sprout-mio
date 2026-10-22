# UI review 验证截图

对应 [工具实现与复跑步骤](../review-workflow.md)，环境、结果和源码 / 截图 hash 见 [manifest.json](manifest.json)。这些材料验证开发工具，不是 I-P1/P2 UI migrate 的交付或 Human 确认。

- [sprout-element.png](sprout-element.png)：真实 Sprout 构建快照的登录页。DOM Capture 在跨源 frame 内选中了邮箱输入框；该元素没有 ID，Copy ID 不可用，DOM path 已复制。截图已实际查看，高亮、选择面板和右侧反馈区可见。
- [sprout-authenticated.png](sprout-authenticated.png)：同一隔离实例注册、导航、前后退和刷新后，仍可读取默认 Agent Amenda。右侧没有监听器提示是预期状态：该次产品检查只启动了预览，反馈监听另由 Pi SDK 组合测试验证。此快照仍是迁移前页面，不能用它判断正在迁移的布局。
- [feedback-received.png](feedback-received.png)：左侧为明确标记的工具测试 fixture。右侧显示 DOM Capture 定位、图片附件和回复；真实 Pi SDK session 收到了同一批反馈。已实际查看截图，长 URL 正常换行，回复后没有残留 Working 状态。

浏览器窗口为 1600 × 1000，Sprout / fixture frame 的实际视口为 1240 × 944。全部采用隔离 Chromium profile；产品检查采用独立 SQLite 和虚构测试账号，没有使用 Human 的登录数据。

两次 red → green 核对：

1. 在临时副本恢复旧 sandbox 条件，同一登录保持断言失败；正式可信应用适配通过。
2. poll 带 `--owner` 时，新增“reply 后 Working 消失”断言失败；移除 external listener 身份后，同一断言通过。

最终组合检查还确认端口冲突不接管既有实例，停止 review 后自有代理和 Lavish 的端口均释放。测试期间的服务已停止，截图不表示当前 Pi session 正在持续监听。Human 常用浏览器的扩展重载和亲自体验仍待完成。
