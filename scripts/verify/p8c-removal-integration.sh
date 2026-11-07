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

# 确认门必须真的拒绝：目标被移除后交接不得落地。日志里必须出现 refused (safe)，
# 任何形如 KNOWN-GAP 的提示都是同退，直接失败。
if ! grep -q '^p8c handoff target gate: refused (safe)' "$verification_dir/handoff.log"; then
  echo "FAIL p8c pending-handoff gate: 交接确认门没有拒绝已被移除的目标" >&2
  grep -n 'KNOWN-GAP' "$verification_dir/handoff.log" >&2 || true
  exit 1
fi
if grep -q '^KNOWN-GAP' "$verification_dir/handoff.log"; then
  echo "FAIL p8c pending-handoff gate: 租约落到了已移除的实例名下" >&2
  exit 1
fi

echo "PASS p8c forced removal integration"
