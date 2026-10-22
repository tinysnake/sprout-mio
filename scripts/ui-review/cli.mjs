#!/usr/bin/env node
import { startReview } from "./review.mjs";

const args = process.argv.slice(2);
const positional = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
if (args.includes("--help")) {
  console.log(
    "用法: node scripts/ui-review/cli.mjs [入口路径或本机 / 内网 URL] [--port 4400] [--lavish-port 4401] [--strict-ports]\n" +
      "省略入口时从登录页开始；入口可以是 /projects 这样的路径，也可以是完整 URL。应用 origin 取自 SPROUT_REVIEW_APP、APP_ORIGIN 或仓库 env 文件，默认 http://localhost:3000。\n" +
      "默认端口被占时自动往后找一对空闲端口；--strict-ports 改为直接报错。\n" +
      "代理监听全部接口，可用局域网 / VPN 地址打开；Lavish 后端只在本机回环。\n" +
      "保持此前台命令运行；Ctrl+C 清理自有进程。此入口不监听反馈，需要反馈回流时用 ui-review 技能（它调用 pi-extension.mjs 注册的 ui_review 工具）。",
  );
} else {
  const option = (name, fallback) =>
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
  try {
    const review = await startReview({
      url: positional,
      port: option("--port", 4400),
      lavishPort: option("--lavish-port", 4401),
      autoPorts: !args.includes("--strict-ports"),
    });
    console.log(
      JSON.stringify(
        {
          url: review.url,
          appUrl: review.appUrl,
          ports: review.ports,
          sessionFile: review.file,
          descriptor: `${review.stateDir}/session.json`,
          listening: false,
        },
        null,
        2,
      ),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, async () => {
        await review.stop();
        process.exit(0);
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
