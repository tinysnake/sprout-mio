import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANUAL_GATES, RETIRED_GATES, SUITE_PLAN } from "./suite-plan.mjs";

export const PORTABLE_GROUPS = Object.freeze(["tooling", "base", "contracts", "docs", "tasks"]);
export const CONTAINER_GROUPS = Object.freeze([
  "api-c",
  "turns-b",
  "api-b",
  "browser-b",
  "api-a",
  "turns",
  "browser-a",
  "browser-c",
]);

export const CI_GROUPS = Object.freeze({
  "api-c": [
    "assistant-core",
    "bf-p6b-turn-context",
    "k-acceptance",
    "k2-cross-family-isolation",
    "ui-scenarios",
  ],
  "turns-b": ["ad-execution-log-ui", "an-p4d-authority", "as-p5b-task-pages"],
  "api-b": [
    "bf-p6b-agent-tool",
    "bf-p6c-lifecycle",
    "c-auth-rate-limit",
    "crew-delegation",
    "crew-resource",
    "i5-project-removal",
    "i6-chat-info",
    "j-info-hub",
    "p4a-machine-scenes",
    "p6c-member-removal",
    "p6c-participation-revocation",
    "p7-loop-collaboration",
    "p7-loop-restart",
    "p7-loop-runtime",
    "p7-service-baseline",
    "p7-storage-recovery",
    "p8c-removal-integration",
  ],
  "browser-b": [
    "ag-execution-wiring-ui",
    "am-execution-log-honesty",
    "e-project",
    "p8c-removal",
    "r-ui-layout",
    "rm2-attachments",
  ],
  "api-a": [
    "cron-core",
    "d-runtime",
    "drain-http",
    "h-project-agents",
    "i-chat",
    "i7-chat-scope",
    "webhook-core",
  ],
  turns: [
    "aq-p4d-pages",
    "m-error-mapping",
    "n-pi-session",
    "o-turn-semantics",
    "p-repo-entry",
    "q-info-hub-runs",
  ],
  "browser-a": ["bf-p6b-pages", "p7-client-states", "run-attention", "y-lease-ui"],
  "browser-c": [
    "as-p5a-chat-ui",
    "bf-p6b-info",
    "c-data-auth",
    "p6c-member-governance-ui",
    "p7-client-navigation",
    "p7-client-pwa",
    "rm3-html",
  ],
  // g-identity-data 跑 `pnpm check`（会调 stray-processes 的 lsof 路径），必须留在装了 lsof 的 job。
  tooling: ["b-tooling", "deploy-selftest", "worker-artifact", "g-identity-data"],
  base: ["a-base"],
  contracts: [
    "s-machine-contracts",
    "v-lease-contracts",
    "p8a-lease-escrow",
    "p8b-timeout",
    "p8b-timeout-integration",
    "v-mcp-contracts",
    "aa-execution-log-contracts",
    "ac-execution-recovery-log",
    "af-execution-cancel-authority",
    "ai-execution-accept-fixes",
    "ak-execution-accept-fixes-2",
    "al-execution-exit-custody",
  ],
  docs: ["f-docs", "l-docs", "l-docs-probes", "deploy-leaks"],
  tasks: ["ba-task-domain", "bc-task-start", "bd-task-migration", "be-task-info"],
});

export const LOCAL_GATES = Object.freeze({
  "assistant-browser":
    "真实已安装 Pi、生产原生助理确认与通知、下一轮 context receipt、桌面与手机；loopback fixture 零付费调用",
  "cron-browser":
    "真实已安装 Pi SDK、生产 wall-clock cron 与浏览器；loopback 模型 fixture，零付费调用",
  "webhook-browser": "真实已安装 Pi SDK、隔离生产 HTTP 与浏览器链路；本地模型 fixture，零付费调用",
  "chat-skills":
    "真实已安装 Pi SDK 的 scoped skills catalog、SQLite span、prompt/steer 投递与故障边界",
  "p7-loop-multiround": "真实 macOS Worker、真实 Pi SDK，同 run 多轮停止与产物历史",
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
  "p7-pi-inheritance": "真实已安装 Pi SDK 的默认 resource loader 与生产 runner",
  "bf-p6b-lifecycle": "真实 macOS Worker、已安装 Pi SDK 与生产 HTTP Info Hub 生命周期",
  "y-mcp-worker": "真实 Pi 版本探测",
  "z-lease-integration": "真实 Pi runner/model/tool 链路",
  "p8a-lease-integration": "真实 macOS Worker、已安装 Pi SDK 与生产 HTTP 的挂靠/撤销链路",
  "z2-mcp-integration": "真实 Pi MCP extension",
  "z3-mcp-acceptance": "内嵌真实 Pi MCP 验收及历史证据校验",
  "deploy-rehearse": "本机端口与 pnpm 构建：首次部署、升级、回滚演练",
});

export function validateGateTargets(root) {
  const actual = readdirSync(join(root, "scripts/verify"))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => name.slice(0, -3))
    .filter((name) => !RETIRED_GATES.includes(name))
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
