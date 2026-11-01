#!/usr/bin/env bash
# 隐私数据不进仓库：忽略规则、tracked 路径、文件内容、实例 env 的值，四层各查一遍。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fail() { printf 'FAIL deploy-leaks: %s\n' "$*" >&2; exit 1; }
probes=()

cleanup() { for probe in "${probes[@]}"; do rm -rf "$probe"; done; }
trap cleanup EXIT

probe_ignored() {
  local dir="$1"
  mkdir -p "$dir"
  local file="$dir/.deploy-leak-probe"
  : > "$file"
  probes+=("$file")
  git check-ignore -q "$file" || fail "$dir 没有被 .gitignore 忽略"
  rm -f "$file"
}

echo "CHECK ignore rules cover runtime artifacts"
for dir in data .verify orchestrate .pi .sprout-pi-sessions .sprout-pi-workspaces .audit; do
  probe_ignored "$dir"
done
for name in .env .env.local probe.sqlite probe.sqlite-wal probe.key; do
  : > "$name"
  probes+=("$name")
  git check-ignore -q "$name" || fail "$name 没有被 .gitignore 忽略"
  rm -f "$name"
done
git check-ignore -q .env.example && fail ".env.example 必须能被提交" || true
echo "PASS ignore rules"

echo "CHECK tracked paths"
tracked="$(git ls-files | grep -E '(^|/)(data|\.verify|orchestrate|\.pi|\.sprout-pi-sessions|\.sprout-pi-workspaces|\.audit)/|\.sqlite(-wal|-shm)?$|\.pem$|\.key$|\.plist$|(^|/)\.env(\.|$)' | grep -v '^\.env\.example$' || true)"
[[ -z "$tracked" ]] || fail "这些运行产物被跟踪了：$(printf '\n  %s' $tracked)"
echo "PASS tracked paths"

echo "CHECK tracked content for secret shapes"
content="$(git grep -nI -e '-----BEGIN [A-Z ]*PRIVATE KEY' -e '(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20,}' -e 'ghp_[A-Za-z0-9]{20,}' -e 'xox[bp]-[A-Za-z0-9-]{10,}' -- . || true)"
[[ -z "$content" ]] || fail "tracked 文件里出现密钥形状的字符串：$(printf '\n  %s' "$content" | cut -c1-200)"
echo "PASS tracked content"

echo "CHECK runtime env values never appear in tracked files"
root="${SPROUT_RUNTIME_ROOT:-$HOME/sprout-runtime}"
checked=0
if [[ -d "$root" ]]; then
  for env_file in "$root"/*/env; do
    [[ -f "$env_file" ]] || continue
    while IFS='=' read -r key value; do
      [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
      [[ ${#value} -ge 16 ]] || continue
      if git grep -qI -F -- "$value" -- .; then
        fail "$env_file 里 $key 的值出现在 tracked 文件里"
      fi
      checked=$((checked + 1))
    done < "$env_file"
  done
fi
echo "PASS runtime env values (checked ${checked})"

echo "PASS deploy-leaks: 运行产物与实例密钥都没有进入仓库"
