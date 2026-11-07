#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P8b 集成线验收：①「阻塞式申请遇阻等待」真的接到 Agent 工具链（extension 侧 lease_get 循环，
# 不新造 remote call type）；②超时提醒 / 2 小时升级 / 到点自决走真实链路——真 SQLite、真 runtime、
# 真 process-scoped grant、真 HTTP 网关（remoteAgentResponse）、真 PiSessionProcess、真
# registerRemoteTools + createRemoteClient，并由生产驱动路径 createContinuationScheduler.advance()
# 触发 sweep，而不是直接调 sweepLeaseEscrowTimeouts。
# 时限压缩：Project 级 wake_policy.leaseTimeouts 把默认 30 分钟 / 2 小时压到 4 秒 / 60 秒——
# 改的是产品本来就支持的同一个配置、产品代码读的是同一常量（LEASE_TIMEOUT_DEFAULT_MS /
# LEASE_ESCALATION_DEFAULT_MS 只在 Project 未覆盖时生效），不是测试替身。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-p8b-timeout-int.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"

# 1) 工具接线：sprout_lease_wait 的入参 schema、注册顺序（与 remoteToolInputSchemas 键一致）、
#    到点返回失败 + 原因而不是把 pending 当失败、identity 锁、读失败原样映射。
pnpm exec vp test run tests/remote-tools.test.ts

# 2) 真实链路：等待期间只发只读 lease_get、持有者完全不可见、不抢占不释放；Agent owner 超时
#    真的造出 queued run 并在提醒里说明处理什么；人类 owner 只提醒一次、零唤醒、零自动接续；
#    T10 关闭自动接续的 chat 照样提醒与升级；再过升级时限升级 Human 并暂停 owner 自动尝试；
#    超时绝不释放租约。
DATABASE_URL="$verification_dir/integration.sqlite" \
  pnpm exec vp test run tests/p8b-timeout-integration.test.ts

printf 'PASS P8b tool wiring + real-chain timeout acceptance: sprout_lease_wait over the existing\n'
printf '     lease_get channel (failure with reason at deadline, never pending-as-failure), holder\n'
printf '     invisible and lease untouched while waiting, agent-owner wake run vs human-owner\n'
printf '     chat-only reminder, remind-once, T10 reminder/escalation with continuation off, 2h\n'
printf '     escalation with paused owner attempts, and lease never released by timeout\n'
