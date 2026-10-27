---
name: human-review
description: 人类评审 Sprout 真实页面：启动可操作的应用预览，收取文字与截图反馈，修改验证后回写，或结束评审。用户要求亲自看页面、提界面反馈或继续处理当前评审时使用。
---

# Human review

通过 CLI 预览真实应用，使用 Lavish 原生 poll / reply 完成反馈闭环。应用适配器与 Pi 工具无关。

## 启动

1. **确定入口。** 根据用户描述与 `src/routes` 选择路径；参数路由使用已有数据。未指定页面时省略入口：应用提供 [开发登录](../../../docs/human-review.md#开发登录) 时自动用 `/dev-login`，否则从 `/login` 开始。远程评审不必让人类手输账号密码；需要指定落地页时直接传 `/dev-login?to=/projects` 这样的入口。确认应用正在运行；origin 的解析与局域网访问见 [运行说明](../../../docs/human-review.md#应用入口与访问)。
2. **启动独立预览。** 在仓库根目录执行，具体页面可作为 CLI 的位置参数：

   ```bash
   mkdir -p .verify/human-review
   review_dir=$(mktemp -d "$PWD/.verify/human-review/run.XXXXXX")
   nohup node scripts/human-review/cli.mjs --state-dir "$review_dir" > "$review_dir/cli.log" 2>&1 &
   printf '%s\n' "$review_dir"
   ```

   读取返回目录中的 `session.json`；尚未生成时检查 `cli.log`，确认就绪或明确的启动错误。记录描述符中的 `pid`、`url`、`file`、`lavishBin`、`env`。参数从 `node scripts/human-review/cli.mjs --help` 获取。

3. **交付预览链接。** 使用描述符中的 `url`，说明左侧是真实应用，右侧可以发送 DOM Capture 定位、截图和文字。顶部可选择设备预设、自定义宽高、旋转与显示比例，见 [尺寸切换](../../../docs/human-review.md#尺寸切换)。用户只要求展示页面时，到此交付；需要反馈闭环时继续等待。

## 反馈闭环

1. **等待并保存反馈。** 使用描述符里的 `lavishBin`、`file` 和全部 `env` 执行原生 `poll`，stdout 完整保存到本次目录的独立 `.toon` 收据，再读取全文。命令示例与宿主等待上限的处理见 [poll / reply](../../../docs/human-review.md#poll--reply)。poll 在当前工作回合前台执行，反馈由这次调用返回。
2. **判断状态。** `feedback`：处理所有反馈；`waiting`：继续等待；`ended`：结束；`browser_disconnected`：停止等待，向用户确认恢复还是结束。`session_ended` 为真时先处理同批最终反馈，再结束。
3. **修改与验证。** 读取反馈附带的图片文件，结合 DOM Capture 的 ID、DOM path、内外 URL 定位。修改 Sprout 源码，按项目规则验证。`review.html` 是会话锚点，真实页面仍由应用提供。
4. **回写。** 会话仍开放时，在同一描述符环境下执行原生 `reply --agent-reply`，写清改动、验证结果和待人类确认项；以 CLI 成功退出为送达依据，然后回到 poll。若本批已由人类结束，在当前对话交付最终处理结果并清理预览。

同一会话保持一个 poll。使用适配器报告的 Lavish 可执行文件与环境，确保反馈和回写进入当前预览。

## 结束

用户结束、最终反馈处理完毕或决定退出时，按描述符 PID 向自有 CLI 发送 SIGTERM；等待 CLI 退出并确认两个端口释放，完成标准与异常处理见 [停止与排障](../../../docs/human-review.md#停止与排障)。已由人类结束的会话保持结束。

若目标是生成 HTML 计划、报告或对比页面，使用 [lavish](../lavish/SKILL.md)；它使用原生 artifact 流程。
