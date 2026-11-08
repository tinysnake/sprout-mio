// 一部分门禁的真实先决条件是「本机装了托管 Pi SDK」（PI_CODING_AGENT_DIR 下的 bin/pi 或
// install/releases 任一形态，解析规则见 scripts/pi-host-skills.mjs 的 sdkRoot）。缺它的时候，
// 门禁跑不出任何结论：那既不是产品缺陷，也不是本机环境脏，而是这条门禁没条件执行。
//
// 约定：这类门禁在自己的脚本开头调用本模块的 CLI 形态；缺 SDK 时打印 SKIP 并以 77 退出。
// runner.mjs 把 77 记成 skipped：不计失败、不影响退出码，也不参与 spend.jsonl 的
// 「同一 HEAD 已有全绿全量」证据复用（见 lib/spend.mjs 的 greenFullRunOn）。
// CI 不需要本机 SDK：只在 CI 执行的门禁不带这条先决条件。
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const HOST_PI_SDK_EXIT = 77;

export function hostAgentDir(environment = process.env) {
  return environment.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
}

export async function probeHostPiSdk(environment = process.env) {
  const agentDir = hostAgentDir(environment);
  try {
    // 动态导入：runner.mjs 静态 import 了本模块，而验证测试会按那份静态 import 图复制 lib 模块；
    // sdkRoot 只在这个 CLI 形态真去探测时才有用，不必把它拖进那份图。
    const { sdkRoot } = await import("../../pi-host-skills.mjs");
    return { available: true, agentDir, root: sdkRoot(agentDir) };
  } catch (error) {
    return { available: false, agentDir, reason: error.message };
  }
}

export function skipLines(gate, probe) {
  return [
    `SKIP ${gate} 缺少宿主托管 Pi SDK：${probe.reason}`,
    `     PI_CODING_AGENT_DIR=${probe.agentDir}`,
    `     装上托管 Pi SDK 后本门禁会真正执行；跳过不产生通过结论。`,
    `     门禁脚本：scripts/verify/${gate}.sh（先决条件检查见 scripts/verify/lib/host-pi-sdk.mjs）`,
  ];
}

if (basename(process.argv[1] ?? "") === "host-pi-sdk.mjs") {
  const gate = process.argv[2];
  if (gate === undefined) {
    console.error("usage: node scripts/verify/lib/host-pi-sdk.mjs <gate-id>");
    process.exit(2);
  }
  const probe = await probeHostPiSdk();
  if (probe.available) process.exit(0);
  for (const line of skipLines(gate, probe)) console.log(line);
  process.exit(HOST_PI_SDK_EXIT);
}
