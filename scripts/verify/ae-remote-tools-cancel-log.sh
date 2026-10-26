#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Risk → Test
# 取消 / 日志工具没进入真实 tools/list → 真实 Pi host runner 加载真实 extension，
#   以 session 的活动工具名（模型实际看到的 tools/list）为准，并从契约推导工具名，不写死数量。
# 缺 machineId 仍能构造请求（隐式默认 Machine）→ 真实注册的 schema 对缺参数调用返回 validation_failed，
#   并断言这些拒绝没有产生任何 HTTP 调用。
# 超界参数被下层吞掉 → termWaitMs > 10000、limitBytes > 65536 与 limitBytes = 0 都被拒。
# 取消/日志结果被降级成成功或空 → 真实 HTTP transport 返回 delivered / failed / truncated / gap / none，
#   逐条断言呈现语义；跨 execution 的日志响应判为 unknown（不可冒充本次结果）。
# 服务端取消与日志业务实现属 p4c-execution，不在本脚本范围；macOS Worker 真实进程同样不在。
rand="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
dir=".verify/ae-remote-tools-cancel-log-$rand"
mkdir -p "$dir"
export SPROUT_REMOTE_TOOLS_EVIDENCE="$PWD/$dir/evidence.json"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true

trap 'printf "FAIL remote tools cancel/log (ae)\n" >&2' ERR
node --import tsx tests/fixtures/remote-tools-cancel-log-live.mjs
node --input-type=module - "$SPROUT_REMOTE_TOOLS_EVIDENCE" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const evidence = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(evidence.newToolsInToolsList.cancel, true);
assert.equal(evidence.newToolsInToolsList.log, true);
for (const label of [
  "cancel_without_machine",
  "cancel_term_wait_too_long",
  "cancel_without_generation",
  "log_without_machine",
  "log_limit_too_large",
  "log_limit_zero",
])
  assert.equal(evidence.rejectedParameters[label], "validation_failed", `${label} must be rejected`);
// 反证：取消送达不得被呈现为已停止，取消失败必须报错。
assert.equal(evidence.presentation.delivered.stopped, false);
assert.equal(evidence.presentation.delivered.isError, false);
assert.match(evidence.presentation.delivered.message, /不表示进程已停/);
assert.equal(evidence.presentation.failed.isError, true);
assert.equal(evidence.presentation.failed.stopped, false);
// 反证：不完整日志不得显示为空，也不得只凭 frames 判空。
assert.equal(evidence.presentation.truncated.incomplete, true);
assert.equal(evidence.presentation.gap.incomplete, true);
assert.equal(evidence.presentation.empty.logState, "none");
assert.equal(evidence.presentation.empty.incomplete, false);
// 反证：别的 execution 的日志响应不能被当作本次结果。
assert.equal(evidence.presentation.impostor.outcome, "unknown");
assert.equal(evidence.presentation.impostor.reason, "invalid_response");
assert.equal(evidence.requestTypes.filter((type) => type === "execution_cancel").length, 2);
assert.equal(evidence.requestTypes.filter((type) => type === "execution_log_read").length, 4);
console.log(
  `PASS 反证：delivered 不显示为已停；failed 报错；truncated/gap 不完整；none 才是空；跨执行响应为 unknown`,
);
NODE
printf 'PASS remote tools cancel/log verification (evidence %s)\n' "$SPROUT_REMOTE_TOOLS_EVIDENCE"
