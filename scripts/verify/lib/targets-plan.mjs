import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANUAL_GATES, SUITE_PLAN } from "./suite-plan.mjs";

export const CI_GROUPS = Object.freeze({
  base: ["a-base"],
  tooling: ["b-tooling"],
  docs: ["f-docs", "l-docs", "l-docs-probes"],
  contracts: [
    "s-machine-contracts",
    "v-lease-contracts",
    "v-mcp-contracts",
    "aa-execution-log-contracts",
    "ac-execution-recovery-log",
    "af-execution-cancel-authority",
    "ai-execution-accept-fixes",
    "ak-execution-accept-fixes-2",
    "al-execution-exit-custody",
  ],
  api: [
    "c-auth-rate-limit",
    "d-runtime",
    "drain-http",
    "e-project",
    "g-identity-data",
    "h-project-agents",
    "i-chat",
    "j-info-hub",
    "i2-group-chat",
    "i3-public-channel",
    "i4-agent-fanout",
    "i5-project-removal",
    "p6c-member-removal",
    "p6c-participation-revocation",
    "bf-p6c-lifecycle",
    "i6-chat-info",
    "i7-chat-scope",
    "an-p4d-authority",
  ],
  tasks: [
    "ba-task-domain",
    "bc-task-start",
    "bd-task-migration",
    "be-task-info",
    "p6a-routing",
    "p6a-scheduler",
    "p6a-control",
    "p6a-delivery",
    "p6a-integration",
    "bf-p6a-lifecycle",
    "p6a-wiring",
  ],
  turns: [
    "k2-cross-family-isolation",
    "m-error-mapping",
    "n-pi-session",
    "o-turn-semantics",
    "p-repo-entry",
    "q-info-hub-runs",
  ],
  browser: [
    "c-data-auth",
    "ad-execution-log-ui",
    "ag-execution-wiring-ui",
    "am-execution-log-honesty",
    "k-acceptance",
    "r-ui-layout",
    "y-lease-ui",
    "aq-p4d-pages",
    "as-p5a-chat-ui",
    "as-p5b-task-pages",
    "p6c-member-governance-ui",
    "p6a-pages",
    "bf-p6b-pages",
    "bf-p6b-info",
    "bf-p6b-turn-context",
    "bf-p6b-agent-tool",
  ],
});

export const LOCAL_GATES = Object.freeze({
  "a-base": "真实已安装 Pi CLI；其他 A 检查由 CI 执行",
  "b-tooling": "macOS/Pi 专属测试文件；其他 B 检查由 CI 执行",
  "ab-worker-long-command": "真实 macOS Worker、信号及长命令",
  "ah-execution-live-e2e": "真实 macOS Worker 生命周期",
  "aj-recovery-matrix": "真实 macOS Worker 恢复矩阵",
  "t-machine-worker": "真实 macOS 环境及 shell 探测",
  "ap-p4d-handoff-worker": "真实 macOS Worker、生产服务与 Agent HTTP 边界",
  "az-p5a-live-worker": "真实 macOS Worker 与真实模型的多人对话链路",
  "bb-task-live": "真实 macOS Worker、已安装 Pi SDK 与真实 HTTP Task 链路",
  "bs-p5b-lifecycle": "真实 macOS Worker、已安装 Pi SDK 与生产 HTTP 生命周期",
  "u-machine-ui": "真实 macOS Worker 的页面链路",
  "w-worker-remote": "真实 macOS Worker 远程执行及 lease force",
  "y2-mcp-http-worker": "真实 Worker 初始化及环境探测",
  "ae-remote-tools-cancel-log": "真实已安装 Pi SDK 的 remote tools",
  "x-remote-tools": "真实已安装 Pi SDK 的 remote tools",
  "x2-mcp-extension": "真实 Pi McpClient/DefaultResourceLoader",
  "x3-mcp-extension-surface": "真实 Pi extension 运行环境",
  "bf-p6b-lifecycle": "真实 macOS Worker、已安装 Pi SDK 与生产 HTTP Info Hub 生命周期",
  "y-mcp-worker": "真实 Pi 版本探测",
  "z-lease-integration": "真实 Pi runner/model/tool 链路",
  "z2-mcp-integration": "真实 Pi MCP extension",
  "z3-mcp-acceptance": "内嵌真实 Pi MCP 验收及历史证据校验",
});

export function validateGateTargets(root) {
  const actual = readdirSync(join(root, "scripts/verify"))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => name.slice(0, -3))
    .sort();
  const remote = Object.values(CI_GROUPS).flat();
  if (new Set(remote).size !== remote.length) throw new Error("Duplicate CI gate assignment");
  const covered = [...new Set([...remote, ...Object.keys(LOCAL_GATES), ...MANUAL_GATES])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(covered))
    throw new Error(
      "Verification gate inventory changed; classify every gate before running targets",
    );
  const shared = remote.filter((id) => Object.hasOwn(LOCAL_GATES, id)).sort();
  if (JSON.stringify(shared) !== JSON.stringify(["a-base", "b-tooling"]))
    throw new Error("Only explicitly split A/B gates may have two targets");
  // The plan says which gates need the isolated tree; lib/sandbox.mjs decides which gates it will
  // accept. Two modules own one fact, so read the whitelist as text and compare it here: a
  // sandbox:true gate the sandbox refuses must fail before any command spawns, not at spawn time.
  const whitelist = sandboxGates(root);
  const sandboxed = Object.entries(SUITE_PLAN)
    .filter(([, plan]) => plan.sandbox)
    .map(([id]) => id)
    .sort();
  const missing = sandboxed.filter((id) => !whitelist.includes(id));
  if (missing.length)
    throw new Error(
      `Suite plan sandboxes ${missing.join(",")} but lib/sandbox.mjs does not whitelist it`,
    );
  return { ci: remote, local: Object.keys(LOCAL_GATES), manual: [...MANUAL_GATES] };
}

export function sandboxGates(root) {
  const source = readFileSync(join(root, "scripts/verify/lib/sandbox.mjs"), "utf8");
  const block = source.match(/const gates = new Set\(\[([\s\S]*?)\]\);/);
  if (!block) throw new Error("Cannot read the verification sandbox gate whitelist");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}
