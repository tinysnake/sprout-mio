import { resolveAppUrl, startReview } from "./review.mjs";

/**
 * UI review 只暴露一个 agent 工具 `ui_review`，由 `.agents/skills/ui-review` 驱动。
 * 端口默认自动挑一对空闲的，不要求人类处理端口或输入 URL。
 */
export default function (pi) {
  let review;
  let watching = false;

  const stop = async () => {
    const current = review;
    review = undefined;
    watching = false;
    await current?.stop();
  };

  const start = async (entry = "", ctx) => {
    if (review) throw new Error('已有 review 在运行；先 ui_review({ action: "stop" })');
    const current = await startReview({
      url: await resolveAppUrl(entry),
      port: Number(process.env.SPROUT_REVIEW_PORT || 4400),
      lavishPort: Number(process.env.SPROUT_REVIEW_LAVISH_PORT || 4401),
      autoPorts: true,
      stateDir: process.env.SPROUT_REVIEW_STATE_DIR,
      onStatus: (message) => {
        watching = false;
        ctx?.ui.notify(`UI review 监听停止：${message}`, "error");
      },
    });
    review = current;
    watching = true;
    void current
      .watch(async (feedback, receipt) => {
        const { next_step: _nextStep, ...content } = feedback;
        pi.sendUserMessage(
          `来自当前 Sprout UI review 的反馈。预览：${current.appUrl}\n完整收据：${receipt}\n` +
            "请读取反馈及图片附件，结合 DOM Capture 定位在 Sprout 仓库中处理；review.html 只是 Lavish 会话锚点。" +
            "修复后完成相应验证，再使用 session.json 中的环境配置执行 lavish-axi reply，将结果回写 Lavish。" +
            "用户结束会话时不要自行重开；browser_disconnected 时停止等待并询问是否恢复。\n\n" +
            JSON.stringify(content, null, 2),
          { deliverAs: "followUp", expandPromptTemplates: false },
        );
      })
      .finally(() => {
        if (review === current) watching = false;
      });
    return current;
  };

  pi.registerTool({
    name: "ui_review",
    label: "UI review",
    description:
      "Sprout 的 UI review 预览：真实应用加载在 Lavish 里，反馈会回到当前 session。action=start 启动（省略 entry 从 /login 开始，端口被占自动换空闲端口）；status 查看预览与监听状态；stop 停止并释放端口；reply 把处理结果回写 Lavish。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "stop", "reply"] },
        entry: {
          type: "string",
          description:
            "start 时的入口：以 / 开头的应用路径（如 /projects）或本机 / 内网 URL；省略则从 /login 开始",
        },
        message: {
          type: "string",
          description: "reply 时回写给 Lavish 的文字（须说明改了什么、怎么验证的）",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fail = (text) => ({ content: [{ type: "text", text }], isError: true });
      try {
        switch (params?.action) {
          case "start": {
            const current = await start(params.entry || "", ctx);
            const { port, lavishPort, adjusted } = current.ports;
            return {
              content: [
                {
                  type: "text",
                  text:
                    `UI review 已启动。\n预览：${current.url}\n应用入口：${current.appUrl}\n` +
                    `端口：review ${port} / Lavish ${lavishPort}${adjusted ? "（默认端口被占，已自动改用）" : ""}\n` +
                    `反馈会作为消息回到当前 session；结束时调用 action="stop"。`,
                },
              ],
              details: current.ports,
            };
          }
          case "status":
            return {
              content: [
                {
                  type: "text",
                  text: review
                    ? `预览：${review.url}\n应用入口：${review.appUrl}\n端口：review ${review.ports.port} / Lavish ${review.ports.lavishPort}\n反馈监听：${watching ? "运行中" : "已停止"}`
                    : "当前 session 没有运行中的 UI review。",
                },
              ],
              details: review ? { ...review.ports, url: review.url } : {},
            };
          case "stop": {
            if (!review) return { content: [{ type: "text", text: "没有运行中的 UI review。" }] };
            const url = review.url;
            await stop();
            return { content: [{ type: "text", text: `UI review 已停止，端口已释放：${url}` }] };
          }
          case "reply": {
            if (!review) return fail('没有运行中的 UI review；先 action="start"。');
            if (!params.message?.trim()) return fail("reply 需要 message 文字。");
            await review.reply(params.message);
            return { content: [{ type: "text", text: "Lavish 已接受回复。" }] };
          }
          default:
            return fail(`未知 action：${params?.action}`);
        }
      } catch (error) {
        return fail(error.message);
      }
    },
  });

  pi.on("session_shutdown", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
}
