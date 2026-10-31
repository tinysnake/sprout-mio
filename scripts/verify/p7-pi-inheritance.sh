#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Risk → Test
# 「继承边界」只写在文档里 → 真实已安装 Pi SDK + 生产 runner 的 open 协议导出实际工具面与
#   extension/资源清单，默认配置逐条对账（四个基础工具 + Sprout 工具，无 codemode /
#   tool_search / mcp__ / 宿主 extension 工具）。
# 开关打开后偷偷把 extensions/themes/context files 也搬进来 → 打开状态的断言要求只有宿主
#   skills 与 prompt templates 进入，themes/contextFiles 仍为空。
# 隔离只在代码里成立 → 两个 Project 的受控目录各自在 cwd 内、项目自己的 AGENTS.md 与
#   .pi/skills 都不进 loader，宿主 agentDir 前后哈希一致。
# 代价靠嘴说 → 关闭/打开各 ≥3 次首轮 open→ready 实测，中位数进证据。
# 不花钱 → model-fixture 本机回环目录，证据里 paidModelCalls 必须为 0。
if [[ -n "${P7_DIR:-}" ]]; then
  dir="$P7_DIR"
else
  rand="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
  dir="$PWD/.verify/p7-pi-inheritance-$rand"
fi
mkdir -p "$dir"
export P7_DIR="$dir"
export P7_EVIDENCE="${P7_EVIDENCE:-$P7_DIR/evidence.json}"
export PI_TELEMETRY=0
unset SPROUT_PI_INHERIT_HOST_RESOURCES || true

trap 'printf "FAIL Pi inheritance boundary (p7)\n" >&2' ERR
pnpm exec tsx tests/fixtures/p7-inheritance.ts
node --input-type=module - "$P7_EVIDENCE" <<'NODE'
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const evidencePath = process.argv[2];
assert(existsSync(evidencePath), "证据文件必须存在");
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const markers = evidence.markers;
const runs = evidence.runs;
assert(Array.isArray(runs) && runs.length >= 7, "至少 7 次真实 open");

// ---- B1 默认工具面：逐条对账，不是只数数量
const off = runs.filter((run) => run.inheritHostResources === false);
const on = runs.filter((run) => run.inheritHostResources === true);
assert(off.length >= 4, "默认关闭至少 4 次（3 次耗时 + 1 次隔离）");
assert(on.length >= 3, "打开开关至少 3 次");
for (const run of runs) {
  const label = run.label;
  assert.equal(run.extensions.join(","), "sprout-extension", `${label}: 只加载 Sprout extension`);
  for (const base of ["bash", "edit", "read", "write"])
    assert(run.tools.includes(base), `${label}: 基础工具 ${base} 在工具面`);
  for (const name of run.tools)
    assert(
      ["bash", "edit", "read", "write"].includes(name) || name.startsWith("sprout_"),
      `${label}: 工具面出现非基础、非 Sprout 工具 ${name}`,
    );
  for (const forbidden of ["codemode", "tool_search", markers.hostExtensionTool])
    assert(!run.tools.includes(forbidden), `${label}: 工具面不含 ${forbidden}`);
  assert(run.tools.every((name) => !name.startsWith("mcp__")), `${label}: 工具面不含 mcp__ 工具`);
  assert(run.registeredTools.every((name) => !name.startsWith("mcp__")), `${label}: registry 无 mcp__`);
  assert(
    run.registeredTools.every(
      (name) => run.tools.includes(name) || name === "sprout_status",
    ),
    `${label}: registry 里没有工具面之外的宿主工具`,
  );
  assert(run.sessionFileUnderSessionDirectory === true, `${label}: session 文件落在会话目录`);
}
assert.deepEqual([...off[0].tools], [...on[0].tools], "开关不改变工具面");
console.log(
  `PASS 工具面 ${off[0].tools.length} 个（${off[0].tools.join(", ")}），registry ${off[0].registeredTools.length} 个，宿主工具与 mcp__/codemode/tool_search 均未出现`,
);

// ---- B2 默认不继承，且与 Project 隔离
for (const run of off) {
  assert.equal(run.resources.inheritHostResources, false, `${run.label}: 开关记录为关闭`);
  for (const field of ["skills", "prompts", "themes", "contextFiles", "skillPaths", "promptPaths"])
    assert.deepEqual(run.resources[field], [], `${run.label}: ${field} 为空`);
  assert.equal(run.resources.agentDirName, ".sprout-pi", `${run.label}: loader 用受控目录`);
  assert(run.resources.agentDirUnderRunCwd === true, `${run.label}: 受控目录在分身 cwd 内`);
  assert(
    run.resources.agentDirEqualsHostAgentDir === false,
    `${run.label}: 受控目录不是宿主 agentDir`,
  );
  assert(
    run.resources.agentDirUnderHostAgentDir === false,
    `${run.label}: 受控目录不在宿主 agentDir 下`,
  );
  assert(
    run.resources.hostAgentDirRelative.startsWith("..") === false,
    `${run.label}: 宿主目录是夹具私有目录`,
  );
}
const projectA = off.find((run) => run.project === "a");
const projectB = off.find((run) => run.project === "b");
assert(projectA && projectB, "A/B 两个 Project 都有默认关闭的会话");
assert.notEqual(
  projectA.resources.agentDirRelative,
  projectB.resources.agentDirRelative,
  "两个 Project 的受控目录不同",
);
assert(projectA.resources.agentDirRelative.startsWith("project-a/"), "A 的受控目录在 A 的 cwd");
assert(projectB.resources.agentDirRelative.startsWith("project-b/"), "B 的受控目录在 B 的 cwd");
assert.deepEqual(projectA.tools, projectB.tools, "两个 Project 的工具面相同");
assert.equal(
  projectA.systemPromptChars,
  projectB.systemPromptChars,
  "两个 Project 的系统提示长度相同（cwd 内容未进提示）",
);
console.log(
  `PASS 默认不继承：${["skills", "prompts", "themes", "contextFiles"].join("/")} 为空，A/B 受控目录 ${projectA.resources.agentDirRelative} 与 ${projectB.resources.agentDirRelative}`,
);

// ---- B3 打开开关只搬 skills + prompt templates
for (const run of on) {
  assert.equal(run.resources.inheritHostResources, true, `${run.label}: 开关记录为打开`);
  assert.deepEqual(run.resources.skills, [markers.hostSkill], `${run.label}: 宿主技能进入`);
  assert.deepEqual(run.resources.prompts, [markers.hostPrompt], `${run.label}: 宿主 prompt 进入`);
  assert.deepEqual(run.resources.themes, [], `${run.label}: 主题仍不加载`);
  assert.deepEqual(run.resources.contextFiles, [], `${run.label}: context file 仍不加载`);
  assert(!run.resources.skills.includes(markers.projectA), `${run.label}: cwd 技能不进入`);
  assert.equal(run.resources.skillPaths.length, 1, `${run.label}: 只多一个技能根`);
  assert(run.resources.skillPaths[0].endsWith("/skills"), `${run.label}: 技能根是宿主 skills`);
  assert.equal(run.resources.promptPaths.length, 1, `${run.label}: 只多一个 prompt 根`);
  assert(
    run.resources.promptPaths[0].endsWith("/prompts"),
    `${run.label}: prompt 根是宿主 prompts`,
  );
  assert.equal(run.resources.agentDirName, ".sprout-pi", `${run.label}: 仍用受控目录`);
  assert(
    run.systemPromptChars > off[0].systemPromptChars,
    `${run.label}: 技能文本进入模型看到的系统提示`,
  );
}
console.log(
  `PASS 开关打开：skills=[${markers.hostSkill}]、prompts=[${markers.hostPrompt}]，themes/contextFiles 仍为空，系统提示 ${off[0].systemPromptChars}→${on[0].systemPromptChars} 字符，工具面不变`,
);

// ---- B4 宿主目录不被写入
assert.equal(evidence.hostTree.unchanged, true, "宿主 agentDir 前后一致");
assert.equal(evidence.hostTree.before.digest, evidence.hostTree.after.digest, "宿主目录哈希一致");
assert.equal(evidence.hostTree.before.files, evidence.hostTree.after.files, "宿主目录文件数一致");
assert(evidence.hostTree.before.files >= 8, "宿主目录里确实有 markers 与 Pi 配置");
console.log(
  `PASS 宿主 agentDir ${evidence.hostTree.before.files} 个文件运行前后哈希一致，未被 loader 或 runner 写入`,
);

// ---- B5 首轮代价：关闭与打开各 ≥3 次
const { latency } = evidence;
assert(latency && Array.isArray(latency.offMs) && Array.isArray(latency.onMs), "耗时样本存在");
assert(latency.offMs.length >= 3 && latency.onMs.length >= 3, "两侧各至少 3 次耗时样本");
assert(Number.isFinite(latency.offMedianMs) && Number.isFinite(latency.onMedianMs), "中位数存在");
assert(Number.isInteger(evidence.metadata?.paidModelCalls), "付费调用计数存在");
assert.equal(evidence.metadata.paidModelCalls, 0, "paid-model-calls=0");
console.log(
  `PASS 首轮 open→ready 中位数：关闭 ${Math.round(latency.offMedianMs)}ms（${latency.offMs.join("/")}），打开 ${Math.round(latency.onMedianMs)}ms（${latency.onMs.join("/")}），paid-model-calls=0（${evidence.metadata.paidModelCallsBasis}）`,
);
console.log(
  `PASS 失败次数：关闭 ${latency.offMs.length} 次 + 打开 ${latency.onMs.length} 次全部拿到 ready，0 次失败（任何一次 open 失败会让夹具先红，不会进证据）`,
);

// ---- B6 真实会话确实跑过一轮（工具面可执行、session 文件落盘）
const turn = runs.find((run) => run.turn);
assert(turn, "有一个会话跑过真实一轮");
assert.equal(turn.turn.stopReason, "stop", "真实一轮 stop_reason=stop");
assert.equal(turn.sessionFileExists, true, "真实一轮后 session 文件已落盘");
console.log(
  `PASS 真实会话一轮：${turn.label} stop_reason=${turn.turn.stopReason}，${turn.turn.turnMs}ms，session 文件已落盘`,
);

console.log(
  `PASS registry 观察：sprout_status declared=${evidence.sproutStatus.declared} registered=${evidence.sproutStatus.registered}（allowlist 未列它时 Pi 在创建 session 就丢弃）`,
);
NODE
printf 'PASS Pi inheritance boundary verification\n'
