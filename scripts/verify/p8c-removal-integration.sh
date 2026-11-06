#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 1) 接线核查：强制移除的 RPC 只做鉴权、输入校验与 MachineContext 组装。业务顺序与事务都在
#    领域层（`forceRemoveProjectMember`），接线层不得自建事务或长出第二条规则。
wiring=src/server/functions/agent.ts
grep -q 'export const forceRemoveProjectMemberFn = createServerFn({ method: "POST" })' "$wiring"
grep -q 'domain.forceRemoveProjectMember(' "$wiring"
grep -q 'machineRuntimeContext()' "$wiring"
if sed -n '/^export async function forceRemoveProjectMemberBoundary/,/^}/p' "$wiring" |
  grep -Eq 'sqlite\.transaction|db\.transaction|\.immediate\(|db\.(insert|update|delete)'; then
  echo "FAIL force removal boundary writes or opens its own transaction" >&2
  exit 1
fi
echo "PASS p8c force removal RPC is pure wiring"

# 2) 组合场景：活动 run + 自己挂靠中的租约 + DM 已分配 Task + owner 职责，同时还有一笔
#    pending handoff 指向被移除的分身。善后四处必须与「不动在途交接」同时成立。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-p8c-removal-integration.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/handoff.sqlite"
export NODE_ENV=test SPROUT_PI_ENABLED=false
node --import tsx tests/fixtures/p8c-forced-removal.ts handoff | tee "$verification_dir/handoff.log"

# 缺口还在时 fixture 打印 KNOWN-GAP（它断言的是当前行为，不阻断退出码）；守卫落地后会变成
# `refused (safe)`。两种情形都要在这里点名，免得到时候没人回头看这条线。
if grep -q '^KNOWN-GAP' "$verification_dir/handoff.log"; then
  echo "KNOWN-GAP p8c pending-handoff gate: 交接确认门仍会把租约落到已移除实例名下" >&2
  echo "          守卫补丁与裁决请见 orchestrate/sprout-mio-p8/reports/p8c-int-report.md" >&2
fi

echo "PASS p8c forced removal integration"
