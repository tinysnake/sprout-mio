#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P8a 挂靠与领取的验收门禁（契约 + 域层）。
# 真实 SQLite、真实 Project/Group/DM/Public Channel 与真实分身身份；
# 私有库、会话与命令正文都留在 mktemp 目录里。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-p8a-lease-escrow.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"

# 1) 0040/0041 迁移 + 直接 SQL 反证：escrowed 授权态、挂靠目标的范围约束、
#    每台机器唯一一条活跃挂靠、领取收据的代次与封闭字段。
DATABASE_URL="$verification_dir/contracts.sqlite" node --import tsx src/db/migrate.ts
DATABASE_URL="$verification_dir/contracts.sqlite" \
  pnpm exec vp test run tests/lease-contracts.test.ts

# 2) 租约视图契约：新增的 escrow 字段与既有 LeaseView 的兼容形态。
DATABASE_URL="$verification_dir/lease-view.sqlite" \
  pnpm exec vp test run tests/lease-view.test.ts

# 3) 域层：host 范围、Group 内 Public Channel、跨 Project 拒绝、DM 拒绝、
#    重复领取、旧代次被拒、挂靠后原持有者被拒、挂靠不改变进程状态。
DATABASE_URL="$verification_dir/domain.sqlite" \
  pnpm exec vp test run tests/p8a-escrow-domain.test.ts

printf 'PASS P8a lease escrow and claim: 0040/0041 migration, SQL refusals, escrowed authorization,\n'
printf '     one-live-escrow uniqueness, group/public-channel claim scope, cross-project and DM refusal,\n'
printf '     stale generation, deposed holder, and unchanged process state\n'
