import { startReview } from "./review.mjs";

export default function (pi) {
  let review;
  let watching = false;
  const stop = async () => {
    const current = review;
    review = undefined;
    watching = false;
    await current?.stop();
  };
  pi.registerCommand("ui-review", {
    description:
      "启动 Sprout + Lavish 并将反馈送回此 Pi session；参数 URL、status、reply <文字> 或 stop",
    handler: async (args, ctx) => {
      const input = args.trim();
      try {
        if (input === "stop") {
          await stop();
          ctx.ui.notify("UI review 已停止", "info");
          return;
        }
        if (input === "status") {
          ctx.ui.notify(
            review
              ? `${review.url}\n反馈监听：${watching ? "poll 运行中" : "已停止"}`
              : "没有运行中的 UI review",
            "info",
          );
          return;
        }
        if (input.startsWith("reply ")) {
          if (!review) throw new Error("请先启动 UI review");
          await review.reply(input.slice(6));
          ctx.ui.notify("Lavish 已接受回复", "info");
          return;
        }
        if (!input)
          throw new Error(
            "用法：/ui-review http://localhost:3000/login；或 status / reply <文字> / stop",
          );
        if (review) throw new Error("已有 review；先使用 /ui-review stop，再启动其他预览");
        review = await startReview({
          url: input,
          port: Number(process.env.SPROUT_REVIEW_PORT || 4400),
          lavishPort: Number(process.env.SPROUT_REVIEW_LAVISH_PORT || 4401),
          stateDir: process.env.SPROUT_REVIEW_STATE_DIR,
          onStatus: (message) => {
            watching = false;
            ctx.ui.notify(`UI review 监听停止：${message}`, "error");
          },
        });
        const current = review;
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
        ctx.ui.notify(`UI review：${current.url}\n已启动受本 Pi session 管理的反馈 poll`, "info");
      } catch (error) {
        ctx.ui.notify(error.message, "error");
      }
    },
  });
  pi.on("session_shutdown", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
}
