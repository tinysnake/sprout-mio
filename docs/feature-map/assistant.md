# 原生个人助理

Human 在 Agents 创建 purpose 为 Assistant 的独立 profile，配置自己的 model、effort 和 persona，再加入 Project 并打开普通 DM。

- 在 DM 请求观察 Human 当前有权访问的 Project、Chat 或 run。
- 助理提出固定目标与正文的工作提案，Human 在 DM 确认一次才提交。
- 助理提出关注 Chat 的建议，Human 激活后按关注周期收到 Chat 消息与工作活动汇总；无内容不通知。可调整周期，助理也可通过工具直接取消关注。输入框上方只显示待确认提案，标题栏始终显示正在关注的数量，列表标明 DM / Group / 公共频道、Project 与周期。可拒绝待确认关注，已处理的确认不复活。窗口由独立、无工具的模型生成语义摘要，原始事实可展开；旧记录不自动重算。
- 点击通知中的 run 链接进入目标 Chat 的实际 run 记录。
- 通知持久保存在同一 DM，下一次助理实际模型请求通过原生 context capture 取得它们。

实现入口：`src/domain/assistant.ts`、`src/domain/assistant-interest.ts`、`src/domain/assistant-observer.ts`、`src/server/assistant-scheduler.ts`、`src/components/chat/assistant-panel.tsx`。受限工具与协议见 `src/contracts/assistant.ts`、`src/extension/assistant-tools.ts`。

验证：

```sh
bash scripts/verify/assistant-core.sh
bash scripts/verify/assistant-browser.sh
```

Browser 使用 production app、真实已安装 Pi 和 loopback 模型，保存 `.verify/assistant-<timestamp>` 证据，零付费调用。具体边界见[原生助理契约](../assistant-core.md)。Human UI 体验仍未确认。Feishu、语音及外部 channel 不属于此单元。
