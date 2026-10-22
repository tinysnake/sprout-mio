#!/usr/bin/env node
import { startReview } from "./review.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || !args[0]) {
  console.log(
    "用法: node scripts/ui-review/cli.mjs <本地 Sprout URL> [--port 4400] [--lavish-port 4401]\n保持此前台命令运行；Ctrl+C 清理自有进程。此入口不监听反馈，Pi 中请加载 pi-extension.mjs 并使用 /ui-review。",
  );
} else {
  const option = (name, fallback) =>
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
  try {
    const review = await startReview({
      url: args[0],
      port: option("--port", 4400),
      lavishPort: option("--lavish-port", 4401),
    });
    console.log(
      JSON.stringify(
        {
          url: review.url,
          appUrl: review.appUrl,
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
