#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Risk → Test
# MCP 图片块被降级成 JSON 文本 → 真实 server-everything 的 get-tiny-image 经真实 Pi 工具面执行。
# `list_changed` 后新工具到不了模型工具面、refresh() 静默返回 ok → 三种 allowlist 形状实测
#   工具面 + 真实 refresh() 的可见失败断言。
# 断言写死成「能」或「不能」 → 夹具要求两种结论同时存在，脚本按 evidence 核对。
# 「相同」被探针布尔冒充 → 探针只写有界原始观察值，base64 严格相等与 structuredContent
#   深度相等由 z3 自己从原始值算出。
# 证据只写块类型、字节长度、工具名与数量：不含 base64 内容、不含工具输出正文、不含 secret。
# 原始观察值走单独的 0600 文件，由 z3 指定路径，不打印、不发布。
if [[ -n "${X3_DIR:-}" ]]; then
  dir="$X3_DIR"
else
  rand="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
  dir="$PWD/.verify/x3-mcp-extension-surface-$rand"
fi
mkdir -p "$dir"
export X3_DIR="$dir"
export X3_EVIDENCE="${X3_EVIDENCE:-$X3_DIR/evidence.json}"
export X3_RAW="${X3_RAW:-$X3_DIR/observations.json}"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true

trap 'printf "FAIL MCP extension surface (x3)\n" >&2' ERR
pnpm exec tsx tests/fixtures/mcp-extension-surface.ts
node --input-type=module - "$X3_EVIDENCE" "$X3_RAW" <<'NODE'
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
const evidence = JSON.parse(readFileSync(process.argv[2], "utf8"));
const observationsPath = process.argv[3];

// ---- B1 图片不降级
// 这里断言形状与规模；“与 server 相同”由 z3 从原始观察值自己算，本脚本不签发那个结论。
assert(evidence.image.blockTypes.includes("image"), "content 里出现 image 块");
assert.notEqual(evidence.image.blockTypes[0], undefined);
assert.equal(evidence.image.mimeType, "image/png", "mimeType 原样");
assert(evidence.image.base64Length > 100, "base64 非空");
assert.equal(evidence.image.structuredContentPresent, true, "structuredContent 仍在 details");
assert(
  Array.isArray(evidence.image.structuredContentKeys) && evidence.image.structuredContentKeys.length > 0,
  "structuredContent 非空",
);
// 单独跑 x3 时也要在原始观察值缺失时立刻失败，但只报事实、不打印内容。
assert(existsSync(observationsPath), "原始观察值产物必须存在");
const observations = JSON.parse(readFileSync(observationsPath, "utf8"));
assert.equal(
  Buffer.byteLength(observations.piImageBase64, "utf8"),
  evidence.image.base64Length,
  "原始观察值的长度与已发布长度一致",
);
assert.equal(
  observations.piImageMimeType,
  evidence.image.mimeType,
  "原始观察值的 mimeType 与已发布值一致",
);
console.log(
  `PASS 真实 get-tiny-image 经 Pi 工具面：块类型=${JSON.stringify(evidence.image.blockTypes)}，${evidence.image.mimeType} base64 长度=${evidence.image.base64Length}，原始观察值已落盘待门禁重算；structuredContent 键=${JSON.stringify(evidence.image.structuredContentKeys)}`,
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
printf 'PASS MCP extension surface verification\n'
