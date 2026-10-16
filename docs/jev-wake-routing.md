# Jev 作为唤醒判定器

状态：官方文档核对与技术设计建议。尚未调用付费 API，也未验证真实协作场景效果。

## 已确认的产品边界

- Jev 指 TypeSafe 的 System One 模型，官方文档：https://docs.typesafe.ai/introduction 。
- 每个 Project 选择小脑或 Jev；一次判定只走所选路径，不级联。
- Group 和 Public Channel 中的人类消息与 Agent 普通回复均可参与上下文判定。
- 一次判定可以唤醒多名 Agents，也可以无人需要回应。
- Public Channel 的候选范围是项目中的全部 Agents；Group 的候选范围为其参与者。
- 不设置固定自动接续轮数上限，人类可暂停自动唤醒或停止运行。

## 官方文档支持的能力

- `state` 接受字符串、JSON 对象或数组，可以包含聊天记录、当前状态和其他判定材料。
- 一次请求可以包含多个 typed questions，各问题针对同一 state 并行、独立求值。
- `Choice` 每个问题选择一个选项，各选项概率总和为 1，不直接表达多个 Agents 各自都应回应的独立概率。
- `Noul` 适合 yes/no 判定，返回回答为 yes 的概率，范围为 0–1。它不另行返回 confidence 字段。
- HTTP 入口为 `POST https://api.typesafe.ai/v1/systemone`；输入包含 `state`、`model`、`questions`，通过 Bearer API key 认证。
- 文档也提供 JavaScript SDK；是否采用 SDK 或直接 HTTP 属于实现选择。

## 建议的唤醒映射

将一次唤醒判定映射为一个请求，其中每个候选分身对应一个 Noul 问题：

> 根据当前对话、任务状态和该 Agent 的职责，这个分身现在是否需要发言或继续工作？

建议 state 包含有界的最近对话、当前 Group 的目标与协作说明、相关 Task 摘要，以及候选 Agents 的人设和当前工作状态。具体裁剪与组装方式在实现时确定。

需要把候选 Agent 的描述写进 state 或该问题的 instructions；官方说明 question id 不发送给模型，不能只靠问题 key 表达人设和身份。

Sprout 根据返回的各候选概率及阈值生成最终唤醒集合。每个候选独立判定，因此可以选择零个、一个或多个分身。阈值用实际对话样本校准，不将文档示例值直接当作产品常量。

判定发生在 Sprout 的消息路由层，不需要占用开发 Machine 或唤醒一个工作 Agent 才能完成。Jev 判定只决定消息交给谁，不产生或转移 Machine 租约。

低确定性或请求失败时的呈现与重试行为尚待设计；本轮已决定不自动回退到小脑。

## 成本与效果的实际边界

查阅时 Models 页列出的 Jev 1.13 / 1.14 价格为每百万输入 tokens 0.042 美元，输出 tokens 免费。以 10,000 个计费输入 tokens 为例，约为 0.00042 美元。实际请求 token 数、价格和延迟以接入时的服务及返回用量为准；候选问题本身也会增加输入。

官方文档说明默认上下文上限为每请求 64k、每问题 32k。第一版应使用与当前判定相关的有界上下文，不需要开启长上下文扩展。

官方说明 Jev 主要以英语训练，接受包括中文在内的其他语言，但效果并不相同。应使用实际中文协作消息验证该设计，尤其是无需回复、多 Agent 同时参与、交接、工作中的补充要求，以及结束讨论等场景。

建议固定实际验证过的 model id，并记录回答所用版本；模型 alias 可能随服务更新改变。以上为技术建议，不修改既定的 Project 可选判定器产品行为。

## 来源

- Introduction：https://docs.typesafe.ai/introduction
- State：https://docs.typesafe.ai/concepts/state
- Noul：https://docs.typesafe.ai/primitives/noul
- Choice：https://docs.typesafe.ai/primitives/choice
- Models / pricing / language support：https://docs.typesafe.ai/models
- API：https://docs.typesafe.ai/api
- 并行问题：https://docs.typesafe.ai/patterns/fan-out
