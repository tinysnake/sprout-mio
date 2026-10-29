#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Risk → Test
# 正式页面的读取与取消只是 fixture 回放 → 真实生产包 + 真实服务 + 私有 SQLite + 真实 Chromium；
#   执行、日志帧与取消都由领域调用写入（requestExecution / exchangeWorker / 人类取消 Fn），不直接 INSERT；
#   浏览器 serverFn 请求按生产包里的函数 id 计数，证明请求真的到了服务端。
# 不完整日志被当成空或成功 → partial 与 gap 都断言「不完整」，gap 单独点名缺口；none 只写「尚无日志」。
# 断线让位点前进或伪装在线 → 浏览器 offline 后断言读取失败、位点文本不变、两条离线说明都出现。
# 取消被显示成已停止 → 取消后执行状态仍是 dispatched，data-stopped=false；刷新后取消事实仍在。
# unknown 上给出重跑入口 → 断言 unknown 卡片有「本页不提供重跑」且没有重跑按钮。
# unknown 不再是「连接一换就写」→ 服务端按恢复宽限归约：宽限内仍 dispatched（生产读取入口取证），
#   宽限过后才 unknown，页面随后读到同一事实。SPROUT_WORKER_RECOVERY_GRACE_MS 只把这段等待压到
#   可测长度，是私有验收开关；产品默认值仍是 src/server/lease.ts 的 30000。
# 跨用户能借页面读日志或取消 → 第二个真实账号直接打两个 serverFn 与打开同一 URL，都是 not_found 错误。
# Chat inspector 假装能读能取消 → dense 只读，断言按钮为 0、只读说明写明去 Machine 详情页。
mkdir -p .verify
# 私有库与截图留在 .verify 下，报告要引用证据路径；不写共享业务库。
verification_dir="$(mktemp -d .verify/p4c-wiring-ui.XXXXXX)"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
export DATABASE_URL="$verification_dir/wiring.sqlite"
export SPROUT_WIRING_EVIDENCE="$verification_dir/evidence"
export BASE_URL="http://127.0.0.1:${SPROUT_EXECUTION_WIRING_PORT:-3141}"
export APP_ORIGIN="$BASE_URL"
export NODE_ENV=production
export SPROUT_PI_ENABLED=false
# 只缩短恢复宽限等待；不改变服务端归约出口与 unknown 的判定条件。
export SPROUT_WORKER_RECOVERY_GRACE_MS=2000
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

node scripts/verify/prepare.mjs server

node --import tsx tests/fixtures/execution-wiring-ui.ts
printf 'PASS execution wiring machine log/cancel, settings read, inspector read-only, cross-user refusal (evidence %s)\n' "$SPROUT_WIRING_EVIDENCE"
