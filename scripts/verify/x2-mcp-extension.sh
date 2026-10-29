#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Risk → Test
# 依赖运行时的扩展入口（Pi MCP 深导入、handler 安装顺序、帧编码）写错 → 真实 Pi 加载真实代码。
# 四个新 call 绕过既有认证/租约/事务边界 → 真实 HTTP /api/remote/agent + 真实 SQLite 隔离库。
# 有界 hold 在 drain 期间拖长排空 → 真实 gateway 上测量 draining 时的响应时间。
# 端到端 tools/list 必须同时满足真实帧往返与 z2 预期工具名集合。
# 证据只写工具名、数量与错误码：不含 secret、IPC 帧内容或 MCP 工具输出。
rand="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
dir=".verify/x2-mcp-extension-$rand"
mkdir -p "$dir"
export DATABASE_URL="$dir/x2.sqlite"
# 生产网关比对 `config.APP_ORIGIN`，而 config 在 import 时冻结：端口必须先选定。
port="$(node --input-type=module -e 'const {createServer}=await import("node:net");const s=createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));console.log(s.address().port);await new Promise(r=>s.close(r));')"
export APP_ORIGIN="http://127.0.0.1:$port"
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export X2_EVIDENCE="$PWD/$dir/evidence.json"
export X2_DIR="$PWD/$dir"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true

trap 'printf "FAIL MCP extension (x2)\n" >&2' ERR
if pnpm exec tsx tests/fixtures/mcp-extension-live.ts > "$dir/probe.log" 2>&1; then
  cat "$dir/probe.log"
else
  probe_status=$?
  cat "$dir/probe.log"
  printf "FAIL MCP extension (x2)\n" >&2
  exit "$probe_status"
fi
node --input-type=module - "$X2_EVIDENCE" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const evidence = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert(evidence.piMcpExports.includes("McpClient"), "real pi-mcp exports probed");
assert(evidence.piMcpExports.includes("parseJsonRpcMessage"), "parseJsonRpcMessage exported");
assert.equal(evidence.handlerOrder.at(-1), "connect", "handlers registered before connect");
assert(evidence.hostDrainsInTime, "mcp_session_exchange returns fast while draining");
assert.equal(evidence.catalogOnlyExplicitRegistrations, true, "catalog is explicit-only");
console.log(
  `PASS real Pi loaded the extension; pi-mcp ${evidence.piMcpVersion} exports=${evidence.piMcpExports.length}; handlers before connect; drain hold < 100 ms`,
);
console.log(
  `PASS catalog over real HTTP: ${evidence.catalogRegistrations} explicit registration(s), no implicit mcp.json scan`,
);
assert.equal(evidence.toolsListMatchesExpected, true, "tools/list must match the expected tool names from z2");
assert.equal(evidence.endToEndToolsList, "pass", "end-to-end tools/list must have frames and the expected tool names");
console.log(
  `PASS end-to-end tools/list through the Sprout channel: ${evidence.toolCount} tools; names match z2`,
);
if (evidence.realServerToolsList === "pass") {
  console.log(
    `PASS real @modelcontextprotocol/server-everything@2.0.1 tools/list over the relay codec: ${evidence.realServerToolCount} tools (Machine-side dispatcher is a script stand-in, not r1-worker)`,
  );
}
NODE
printf 'PASS MCP extension verification (evidence %s)\n' "$X2_EVIDENCE"
