#!/usr/bin/env bash
set -uo pipefail
export SPROUT_PI_ENABLED=false

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
# 固定路径的验收库保留旧迁移账本，重生成迁移后需从空库复跑。
rm -f .verify/*/verification.sqlite
failed=0
count=0
for script in scripts/verify/*.sh; do
  [ -f "$script" ] || continue
  count=$((count + 1))
  if bash "$script"; then
    printf 'PASS %s\n' "$script"
  else
    printf 'FAIL %s\n' "$script"
    failed=$((failed + 1))
  fi
done
if [ "$count" -eq 0 ]; then
  printf 'FAIL no verification scripts found\n'
  exit 1
fi
printf 'Verification scripts=%s failed=%s\n' "$count" "$failed"
exit "$((failed != 0))"
