import { APP_VERSION } from "../contracts/version";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("P1 只建立入口，连接协议在 P4 实现，当前无连接能力。未实现连接、心跳或握手。");
} else if (args.length === 1 && args[0] === "--version") {
  console.log(`sprout-worker ${APP_VERSION} protocol=unimplemented`);
} else if (args.length === 1 && args[0] === "--help") {
  console.log("sprout-worker [--version | --help]\n连接协议未实现，当前无连接能力。");
} else {
  console.error("不支持的参数。运行 sprout-worker --help 查看用法。");
  process.exitCode = 1;
}
