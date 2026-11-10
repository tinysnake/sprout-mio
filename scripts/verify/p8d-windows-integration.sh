#!/usr/bin/env bash
# P8d 集成线：真实 Windows 上的端到端验收。
#
# 与 p8d-windows-worker.sh 的分工：那个验平台适配（探测、runner、进程树终止），
# 这个走生产路径 RemoteDispatcher，把功能线与 UI 线自测出的结论当主张逐条重验：
# 三种 shell 的真实能力与诚实性、跨平台文件操作、进程枚举与 taskkill /T /F、
# Session 0 与桌面会话的区分（本机无桌面会话时如实标未验证）、取消语义、
# 重连去重、runner 被杀后的未观测退出与重启恢复。
#
# 需要一台可 ssh 的 Windows 主机：默认别名 e8，可用 P8D_WINDOWS_HOST 覆盖。
# 连不上、不是 Windows、或本机没有 Windows 时明确失败（退出码 1），不静默跳过——
# 这是 MANUAL 门禁，不进全量套件。通过 ssh 触发时 sshd 落在 Session 0，
# 脚本据此传入期望 SessionId；在桌面会话里直接跑时把 P8D_EXPECT_WINDOWS_SESSION 设为空。
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

host="${P8D_WINDOWS_HOST:-e8}"
expect_session="${P8D_EXPECT_WINDOWS_SESSION-0}"

fail() {
  printf 'FAIL p8d-windows-integration %s\n' "$*" >&2
  exit 1
}

# macOS 没有 timeout：用 SSH 自己的保活探测把「现代待机」这类假连通变成明确失败
# （ping 通、TCP 握手成功，但 SSH 等不到 banner / 命令一个字节不回）。
ssh_windows() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 \
    -o ServerAliveInterval=5 -o ServerAliveCountMax=6 "$host" "$@"
}
ssh_windows_long() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 \
    -o ServerAliveInterval=10 -o ServerAliveCountMax=60 "$host" "$@"
}

# 缺 Windows 时明确失败，绝不静默通过。
if ! probe="$(ssh_windows 'cmd /c echo sprout-p8d-int-probe' 2>&1 | LC_ALL=C tr -d '\r')"; then
  fail "需要真实 Windows 主机：ssh ${host} 不可用（${probe}）；设置 P8D_WINDOWS_HOST 后重试"
fi
case "$probe" in
  *sprout-p8d-int-probe*) ;;
  *) fail "ssh $host 未返回预期标记，可能处于现代待机或命令被吞：$probe" ;;
esac
platform_line="$(ssh_windows 'node -p "[process.platform, process.arch, process.version].join(String.fromCharCode(32))"' | LC_ALL=C tr -d '\r')"
case "$platform_line" in
  win32\ *) ;;
  *) fail "ssh $host 不是 Windows：node 报告 $platform_line" ;;
esac
session_line="$(ssh_windows 'cmd /c query user 2>&1' 2>/dev/null | iconv -f GBK -t UTF-8 2>/dev/null | tr -d '\r' || true)"
printf 'P8d 集成验收主机 %s：node %s\n' "$host" "$platform_line"
printf 'P8d 桌面登录：%s\n' "$(printf '%s' "$session_line" | head -2 | tr '\n' ' ')"

remote_temp="$(ssh_windows 'cmd /c echo %TEMP%' | LC_ALL=C tr -d '\r')"
[ -n "$remote_temp" ] || fail "无法读取 Windows %TEMP%"
remote_dir="${remote_temp}\\sprout-p8d-int-$$"
remote_path="${remote_dir//\\//}"

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "cmd /c rmdir /s /q \"$remote_dir\"" >/dev/null 2>&1 ||
    true
}
trap cleanup EXIT

source "$(dirname "${BASH_SOURCE[0]}")/lib/ensure-worker-artifact.sh"
ensure_worker_artifact

pnpm exec vp pack tests/fixtures/p8d-windows-integration.ts \
  -d "$work/payload" --no-config --platform node --format esm --logLevel warn >/dev/null
cp dist/worker/runner.js "$work/payload/runner.js"
mkdir -p "$work/payload/node_modules"
# 只把 harness 运行时需要的外部依赖带过去；runner.js 与 harness 本身都是单文件产物。
zod_dir="$(cd node_modules/zod && pwd -P)"
cp -R "$zod_dir" "$work/payload/node_modules/zod"

tar -C "$work/payload" -czf "$work/payload.tgz" .
ssh_windows "cmd /c mkdir \"$remote_dir\"" >/dev/null || fail "无法在 Windows 上创建 $remote_dir"
ssh_windows "tar -xzf - -C \"$remote_path\"" <"$work/payload.tgz"

run_log="$work/run.log"
if [ -n "$expect_session" ]; then
  set +e
  ssh_windows_long "node \"$remote_path/p8d-windows-integration.mjs\" $expect_session" \
    >"$run_log" 2>&1
  status=$?
  set -e
else
  set +e
  ssh_windows_long "node \"$remote_path/p8d-windows-integration.mjs\"" >"$run_log" 2>&1
  status=$?
  set -e
fi

LC_ALL=C tr -d '\r' <"$run_log" | tee "$work/windows-output.txt"
if [ "$status" -ne 0 ]; then
  fail "Windows 侧退出码 ${status}（原始输出见上）"
fi
grep -q '^P8D_WINDOWS_INTEGRATION_OK ' "$work/windows-output.txt" ||
  fail "Windows 侧没有给出 P8D_WINDOWS_INTEGRATION_OK 结论行"
printf 'PASS p8d-windows-integration\n'
