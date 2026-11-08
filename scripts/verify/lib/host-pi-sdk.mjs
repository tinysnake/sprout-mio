// 一部分门禁的真实先决条件是「本机装了托管 Pi SDK」（PI_CODING_AGENT_DIR 下的 bin/pi 或
// install/releases 任一形态，解析规则见 scripts/pi-host-skills.mjs 的 sdkRoot）。缺它的时候，
// 门禁跑不出任何结论：那既不是产品缺陷，也不是本机环境脏，而是这条门禁没条件执行。
// 少数门禁还要同一份托管安装里的 native MCP 模块（`@earendil-works/pi-mcp`，解析规则见
// src/extension/mcp-load.ts 的 piMcpRoot 与 tests/fixtures/mcp-worker-live.ts），列入
// MCP_MODULE_GATES 的门禁会先探 SDK、再探该模块。
//
// 约定：这类门禁在自己的脚本开头调用本模块的 CLI 形态；缺 SDK 时打印 SKIP 并以 77 退出。
// runner.mjs 把 77 记成 skipped：不计失败、不影响退出码，也不参与 spend.jsonl 的
// 「同一 HEAD 已有全绿全量」证据复用（见 lib/spend.mjs 的 greenFullRunOn）。
// CI 不需要本机 SDK：只在 CI 执行的门禁不带这条先决条件。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
    return { available: true, label: "宿主托管 Pi SDK", agentDir, root: sdkRoot(agentDir) };
  } catch (error) {
    return { available: false, label: "宿主托管 Pi SDK", agentDir, reason: error.message };
  }
}

/** 除 SDK 本体，还要求同一份托管安装里的 native MCP 模块的门禁。 */
export const MCP_MODULE_GATES = new Set([
  "x2-mcp-extension",
  "y-mcp-worker",
  "z2-mcp-integration",
  "z3-mcp-acceptance",
]);

export async function probeHostPiMcpModule(environment = process.env) {
  const label = "宿主托管 Pi SDK 的 native MCP 模块";
  const override = environment.PI_MCP_MODULE;
  if (override !== undefined && override !== "") {
    return existsSync(join(override, "dist", "index.js"))
      ? { available: true, label, agentDir: hostAgentDir(environment), root: override }
      : {
          available: false,
          label,
          agentDir: hostAgentDir(environment),
          reason: `PI_MCP_MODULE 指向的目录没有 dist/index.js：${override}`,
        };
  }
  const sdk = await probeHostPiSdk(environment);
  if (!sdk.available) return { ...sdk, label };
  // @earendil-works/pi-mcp 与 @earendil-works/pi-coding-agent 是同一个 node_modules 下的同级包。
  const root = join(dirname(sdk.root), "pi-mcp");
  return existsSync(join(root, "dist", "index.js"))
    ? { available: true, label, agentDir: sdk.agentDir, root }
    : {
        available: false,
        label,
        agentDir: sdk.agentDir,
        reason: `找不到 ${root}/dist/index.js，请在 PI_CODING_AGENT_DIR 对应目录安装托管 Pi`,
      };
}

export function skipLines(gate, probe) {
  return [
    `SKIP ${gate} 缺少${probe.label ?? "宿主托管 Pi SDK"}：${probe.reason}`,
    `     PI_CODING_AGENT_DIR=${probe.agentDir}`,
    `     装上托管 Pi SDK 后本门禁会真正执行；跳过不产生通过结论。`,
    `     门禁脚本：scripts/verify/${gate}.sh（先决条件检查见 scripts/verify/lib/host-pi-sdk.mjs）`,
  ];
}

if (basename(process.argv[1] ?? "") === "host-pi-sdk.mjs") {
  const gate = process.argv[2];
  if (gate === undefined) {
    console.error(
      "usage: node scripts/verify/lib/host-pi-sdk.mjs <gate-id>（MCP_MODULE_GATES 里的门禁会额外要求 pi-mcp 模块）",
    );
    process.exit(2);
  }
  const probe = MCP_MODULE_GATES.has(gate) ? await probeHostPiMcpModule() : await probeHostPiSdk();
  if (probe.available) process.exit(0);
  for (const line of skipLines(gate, probe)) console.log(line);
  process.exit(HOST_PI_SDK_EXIT);
}
