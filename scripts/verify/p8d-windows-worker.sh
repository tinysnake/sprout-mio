#!/usr/bin/env bash
# P8d：真实 Windows Worker 端到端（能力探测、三种 shell 执行、进程树终止、未观测退出）。
#
# 需要一台可 ssh 的 Windows 主机：默认别名 e8，可用 P8D_WINDOWS_HOST 覆盖。
# 连不上就明确失败（退出码 1），不静默跳过——这是 manual gate，不进全量套件。
# 通过 ssh 触发时 sshd 落在 Session 0，脚本据此传入期望 SessionId；
# 在桌面会话里直接跑时设 P8D_EXPECT_WINDOWS_SESSION= 为空即可不校验具体 SessionId。
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

host="${P8D_WINDOWS_HOST:-e8}"
expect_session="${P8D_EXPECT_WINDOWS_SESSION-0}"

fail() {
  printf 'FAIL p8d-windows-worker %s\n' "$*" >&2
  exit 1
}

ssh_windows() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$@"
}

# 缺 Windows 时明确跳过并报错，绝不静默通过。
if ! probe="$(ssh_windows 'cmd /c echo sprout-p8d-probe' 2>&1 | LC_ALL=C tr -d '\r')"; then
  fail "需要真实 Windows 主机：ssh $host 不可用（$probe）；设置 P8D_WINDOWS_HOST 后重试"
fi
case "$probe" in
  *sprout-p8d-probe*) ;;
  *) fail "ssh $host 未返回预期标记：$probe" ;;
esac
platform_line="$(ssh_windows 'node -p "[process.platform, process.arch, process.version].join(String.fromCharCode(32))"' | LC_ALL=C tr -d '\r')"
case "$platform_line" in
  win32\ *) ;;
  *) fail "ssh $host 不是 Windows：node 报告 $platform_line" ;;
esac
printf 'P8d Windows 主机 %s：node %s\n' "$host" "$platform_line"

remote_temp="$(ssh_windows 'cmd /c echo %TEMP%' | LC_ALL=C tr -d '\r')"
[ -n "$remote_temp" ] || fail "无法读取 Windows %TEMP%"
remote_dir="${remote_temp}\\sprout-p8d-$$"
remote_path="${remote_dir//\\//}"

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "cmd /c rmdir /s /q \"$remote_dir\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

source "$(dirname "${BASH_SOURCE[0]}")/lib/ensure-worker-artifact.sh"
ensure_worker_artifact

pnpm exec vp pack tests/fixtures/p8d-windows-worker.ts \
  -d "$work/payload" --no-config --platform node --format esm --logLevel warn >/dev/null
cp dist/worker/runner.js "$work/payload/runner.js"
mkdir -p "$work/payload/node_modules"
# 只把 harness 运行时需要的外部依赖带过去；runner.js 与 harness 本身都是单文件产物。
zod_dir="$(cd node_modules/zod && pwd -P)"
cp -R "$zod_dir" "$work/payload/node_modules/zod"

tar -C "$work/payload" -czf "$work/payload.tgz" .
ssh_windows "cmd /c mkdir \"$remote_dir\"" >/dev/null
ssh_windows "tar -xzf - -C \"$remote_path\"" <"$work/payload.tgz"

if [ -n "$expect_session" ]; then
  ssh_windows "node \"$remote_path/p8d-windows-worker.mjs\" \"$remote_path/runner.js\" $expect_session"
else
  ssh_windows "node \"$remote_path/p8d-windows-worker.mjs\" \"$remote_path/runner.js\""
fi
