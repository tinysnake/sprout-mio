#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startReview } from "./review.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      port: { type: "string", default: "4400" },
      "lavish-port": { type: "string", default: "4401" },
      "state-dir": { type: "string" },
      "strict-ports": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "用法: node scripts/human-review/cli.mjs [入口路径或本机 / 内网 URL] [--port 4400] [--lavish-port 4401] [--state-dir <目录>] [--strict-ports]\n" +
        "省略入口时优先用应用的开发生登录（/dev-login），应用没开就从 /login 开始；应用 origin 取自 SPROUT_HUMAN_REVIEW_APP、APP_ORIGIN 或仓库 env，默认 http://localhost:3000。\n" +
        "端口被占时自动后移；--strict-ports 改为报错。代理监听全部接口，Lavish 后端仅监听本机回环。\n" +
        "启动后输出 JSON 描述符并保持运行；Ctrl+C 或 SIGTERM 清理自有服务。\n" +
        "按描述符的 lavishBin、file 和 env 运行原生 lavish-axi poll / reply；CLI 不监听反馈，也不注册 Pi 工具。",
    );
  } else {
    if (positionals.length > 1) throw new Error("最多接受一个应用入口");
    let review;
    let stopping = false;
    const stop = async () => {
      stopping = true;
      await review?.stop();
    };
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
    review = await startReview({
      url: positionals[0],
      port: Number(values.port),
      lavishPort: Number(values["lavish-port"]),
      autoPorts: !values["strict-ports"],
      stateDir: values["state-dir"],
    });
    if (stopping) await review.stop();
    else {
      const { stop: _stop, ...descriptor } = review;
      console.log(JSON.stringify(descriptor));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
