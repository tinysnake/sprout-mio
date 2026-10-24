---
name: lavish
description: 生成并展示便于人类查看的 HTML artifact，用于计划、对比、图解、报告或原型。需要对 artifact 收取反馈时使用 Lavish 原生评审流程；真实 Sprout 应用的评审使用 human-review。
license: MIT
metadata:
  author: Kun Chen (kunchenguid)
  argument-hint: <what the artifact should show>
---

# Lavish

将适合可视化的内容写成 HTML artifact，并通过 lavish-axi 展示。

## 执行

1. **获取当前指南。** 读取 `npx -y lavish-axi --help` 与 `npx -y lavish-axi design`；按内容选择 `playbook <id>`。命令语法、设计规则与反馈状态以该 CLI 的当前输出为准。
2. **生成 artifact。** 将 HTML 保存在仓库的 `.verify/` 下，使用相对资源并完成浏览器检查。按 CLI 指南打开，向用户提供返回的会话链接。
3. **按任务交付。** 仅展示结果时，交付链接和必要说明。用户要求持续评审时，在当前工作回合执行原生 `poll`；完整保存并读取反馈输出和图片，修改后按 CLI 指南验证、回写，再继续等待。`reply --help` 提供只回写后退出的方式。
4. **结束评审。** 按 CLI 返回状态处理最终反馈或断连，尊重人类结束的会话。

## 真实应用

Sprout 的路由、登录态与交互页面使用 [human-review](../human-review/SKILL.md)。它补充真实应用嵌入，poll / reply 仍由 Lavish 提供。

真实应用适配器使用其描述符记录的 `lavishBin` 与 `env`；原生 artifact 可以按当前 CLI 指南使用 npx。两种会话各自使用对应的文件、环境与监听，避免重复 poll。

## 输入

$ARGUMENTS
