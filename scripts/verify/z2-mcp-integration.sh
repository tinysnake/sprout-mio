#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .verify
integration_dir="$(mktemp -d .verify/z2-mcp-integration-XXXXXX)"
export DATABASE_URL="$PWD/$integration_dir/private.sqlite"
port="$(node --input-type=module -e 'import {createServer} from "node:net";const s=createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));console.log(s.address().port);await new Promise(r=>s.close(r));')"
export APP_ORIGIN="http://127.0.0.1:$port"
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node --input-type=module -e 'import {randomBytes} from "node:crypto";console.log(randomBytes(32).toString("hex"))')"
export X2_EVIDENCE="$PWD/$integration_dir/evidence.json"
export X2_DIR="$PWD/$integration_dir"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
node --import tsx tests/fixtures/mcp-extension-live.ts
node --input-type=module - "$X2_EVIDENCE" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const evidence = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(evidence.endToEndToolsList, "pass");
// 工具数从实际 listTools 结果推导，不写死常量：pinned server 升级或多出来的工具不会变成过期断言。
assert.equal(evidence.toolCount, evidence.rawToolNames.length);
assert.equal(evidence.nativePiVersion, "1.4.0", "locked Pi version, probed from package.json");
// Expected names are assertions; evidence.rawToolNames is the actual native listTools result.
const expectedEverythingTools = [
  "echo", "get-annotated-message", "get-env", "get-header-params", "get-resource-links",
  "get-resource-reference", "get-roots-list", "get-structured-content", "get-sum",
  "get-tiny-image", "gzip-file-as-resource", "toggle-simulated-logging",
  "toggle-subscriber-updates", "trigger-elicitation-request", "trigger-list-changed",
  "trigger-log-messages", "trigger-long-running-operation", "trigger-multi-step-elicitation",
  "trigger-resource-update", "trigger-sampling-request",
].sort();
assert.deepEqual(evidence.rawToolNames, expectedEverythingTools);
assert(evidence.realFrameWakes.some(t => t.holdEntered && t.newFrameCommitted && t.frames > 0 && t.elapsedMs < t.requestedHoldMs));
assert(evidence.workerDispatcherClientFrames > 0);
assert(evidence.workerDispatcherServerFrames > 0);
assert(evidence.attached.attached_at !== null);
assert(evidence.wakeControls.trials.find(t => t.mode === "with_remote_wake").elapsedMs < 1800);
assert(evidence.wakeControls.trials.find(t => t.mode === "without_remote_wake").elapsedMs >= 1800);
assert(evidence.wakeControls.trials.find(t => t.mode === "outer_rollback").frames === 0);
assert(!readFileSync("tests/fixtures/mcp-extension-live.ts", "utf8").includes("INSERT INTO mcp_frame"));
console.log(`PASS integration: ${evidence.toolCount} tools through real Worker dispatcher; wake controls and rollback passed`);
NODE
printf 'PASS MCP integration evidence %s\n' "$X2_EVIDENCE"
