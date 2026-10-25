#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Risk → Test
# MCP 图片块被降级成 JSON 文本 → 真实 server-everything 的 get-tiny-image 经真实 Pi 工具面执行。
# `list_changed` 后新工具到不了模型工具面、refresh() 静默返回 ok → 三种 allowlist 形状实测
#   工具面 + 真实 refresh() 的可见失败断言。
# 断言写死成「能」或「不能」 → 夹具要求两种结论同时存在，脚本按 evidence 核对。
# 证据只写块类型、字节长度、工具名与数量：不含 base64 内容、不含工具输出正文、不含 secret。
rand="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
dir=".verify/x3-mcp-extension-surface-$rand"
mkdir -p "$dir"
export X3_EVIDENCE="$PWD/$dir/evidence.json"
export X3_DIR="$PWD/$dir"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true

trap 'printf "FAIL MCP extension surface (x3)\n" >&2' ERR
pnpm exec tsx tests/fixtures/mcp-extension-surface.ts
node --input-type=module - "$X3_EVIDENCE" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const evidence = JSON.parse(readFileSync(process.argv[2], "utf8"));

// ---- B1 图片不降级
assert(evidence.image.blockTypes.includes("image"), "content 里出现 image 块");
assert.notEqual(evidence.image.blockTypes[0], undefined);
assert.equal(evidence.image.mimeType, "image/png", "mimeType 原样");
assert(evidence.image.base64Length > 100, "base64 非空");
assert.equal(evidence.image.matchesServerBytes, true, "base64 与真实 server 返回值逐字节相同");
assert(
  evidence.image.structuredContentInDetails !== null,
  "structuredContent 仍在 details",
);
assert.equal(
  evidence.image.structuredContentMatchesServer,
  true,
  "details.structuredContent 与真实 server 返回值一致",
);
console.log(
  `PASS 真实 get-tiny-image 经 Pi 工具面：块类型=${JSON.stringify(evidence.image.blockTypes)}，${evidence.image.mimeType} base64 ${evidence.image.base64Length} 字节原样，structuredContent=${JSON.stringify(evidence.image.structuredContentInDetails)}`,
);

// ---- B2 工具面结论必须与实测一致
const byScenario = new Map(evidence.surface.map((entry) => [entry.scenario, entry]));
const runner = byScenario.get("runner allowlist (no mcp__ entry)");
assert(runner, "测到了 runner 的 allowlist 形状");
assert.equal(
  runner.lateToolDeclared,
  false,
  "runner 的精确名 allowlist 下运行中新增的 MCP 工具不进入模型工具面（B2 根因）",
);
for (const label of ["allowlist naming mcp__*", "no tools option"]) {
  const entry = byScenario.get(label);
  assert(entry, `测到了 ${label}`);
  assert.equal(
    entry.lateToolDeclared,
    true,
    `${label} 下运行中新增的 MCP 工具确实进入模型工具面`,
  );
}
console.log(
  `PASS Pi 1.4.0 ${evidence.sdkVersion} 运行期 registerTool 会进 registry；是否声明给模型取决于 tools allowlist：${evidence.surface.map((e) => `${e.scenario}→${e.lateToolDeclared ? "进入" : "未进入"}`).join("；")}`,
);

// ---- 生产 runner 的 allowlist 带上修复
assert.equal(
  evidence.runnerAllowlistHasMcpStar,
  true,
  "scripts/pi-host-runner.mjs 的 tools allowlist 含 mcp__*（B2 根因的修复点）",
);
console.log("PASS 生产 runner 的 tools allowlist 含 mcp__*，与上面测到的激活规则一致");

// ---- list_changed 真的到达模型工具面（B2 的正面结论）
assert.equal(
  evidence.listChanged.newToolDeclared,
  true,
  "真实 list_changed 后新工具进入 Pi 的模型工具面",
);
assert.equal(
  evidence.listChanged.newToolCallable,
  true,
  "新工具在模型工具面里可调用",
);
assert.equal(evidence.listChanged.callText, "called:added-1", "调用真的到了 server");
assert.equal(
  evidence.listChanged.stillDeclaredAfterExplicitRefresh,
  true,
  "再来一次显式 refresh 仍复用连接，新工具不丢",
);
console.log(
  `PASS 真实 list_changed → 连接复用 → 模型工具面：${evidence.listChanged.declaredBefore}→${evidence.listChanged.declaredAfter} 个 mcp__ 工具，调用返回 ${JSON.stringify(evidence.listChanged.callText)}`,
);

// ---- refresh() 的可见失败
assert.equal(
  evidence.refreshOnBlockedSurface.outcome,
  "failed",
  "目录已变但工具面本轮不生效时必须报 failed，不能假装 ok",
);
assert(
  evidence.refreshOnBlockedSurface.registeredNotDeclared > 0,
  "确实有工具注册成功却没进模型工具面",
);
assert.equal(
  evidence.refreshOnBlockedSurface.diagnosticPresent,
  true,
  "默认 onError 必须把失败写进诊断（sprout_status 可读）",
);
console.log(
  `PASS refresh() 可见失败：${evidence.refreshOnBlockedSurface.registeredNotDeclared} 个工具已注册未声明，outcome=failed，诊断非空`,
);
NODE
printf 'PASS MCP extension surface verification (evidence %s)\n' "$X3_EVIDENCE"
