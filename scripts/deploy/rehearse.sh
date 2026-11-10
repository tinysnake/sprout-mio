#!/usr/bin/env bash
# 在临时运行根目录里把部署链路演一遍：首次部署、升级、回滚，全部用本地裸远端。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO_ROOT="$PWD"
source scripts/deploy/lib.sh

work="$(mktemp -d "${TMPDIR:-/tmp}/sprout-deploy-rehearse.XXXXXX")"
trap 'bash "$REPO_ROOT/scripts/deploy/stop.sh" prod >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

export SPROUT_RUNTIME_ROOT="$work/runtime"
export SPROUT_PORT_PROD=3322
export SPROUT_DEPLOY_REMOTE="$work/remote.git"

assert_port_free "$(port_for prod)"
# 演练远端从空裸库开始：直接克隆工作仓库会把它的 main 和标签带进来，
# 之后推送自造的 main/tag 会因与仓库历史分叉或标签重名而失败。
git init --quiet --bare --initial-branch=main "$SPROUT_DEPLOY_REMOTE"
git clone --quiet --shared . "$work/src"
git -C "$work/src" remote set-url origin "$SPROUT_DEPLOY_REMOTE"
git -C "$work/src" checkout --quiet -B main
git -C "$work/src" tag -l | while read -r tag; do git -C "$work/src" tag -d "$tag" >/dev/null; done
printf 'rehearsal\n' > "$work/src/REHEARSAL.md"
git -C "$work/src" add REHEARSAL.md
git -C "$work/src" -c user.name=rehearse -c user.email=rehearse@example.test commit --quiet -m "rehearsal a"
git -C "$work/src" tag deploy-a
printf 'rehearsal two\n' >> "$work/src/REHEARSAL.md"
git -C "$work/src" -c user.name=rehearse -c user.email=rehearse@example.test commit --quiet -am "rehearsal b"
git -C "$work/src" tag deploy-b
git -C "$work/src" push --quiet origin refs/heads/main refs/tags/deploy-a refs/tags/deploy-b
echo "PASS 本地远端就绪（deploy-a / deploy-b）"

bash scripts/deploy/init-instance.sh prod >/dev/null
echo "PASS 实例初始化"

bash scripts/deploy/promote.sh deploy-a >/dev/null
app="$(instance_dir prod)/app"
[[ "$(git -C "$app" describe --tags --abbrev=0)" == deploy-a ]] || fail "首次部署没有停在 deploy-a"
echo "PASS 首次部署 deploy-a"

bash scripts/deploy/promote.sh deploy-b >/dev/null
[[ "$(git -C "$app" describe --tags --abbrev=0)" == deploy-b ]] || fail "升级没有停在 deploy-b"
echo "PASS 升级到 deploy-b"

bash scripts/deploy/rollback.sh >/dev/null
[[ "$(git -C "$app" describe --tags --abbrev=0)" == deploy-a ]] || fail "回滚没有回到 deploy-a"
bash scripts/deploy/verify.sh prod >/dev/null || fail "回滚后校验失败"
echo "PASS 回滚到 deploy-a 并通过校验"

backups="$(ls "$(backup_dir prod)"/sprout-*.sqlite 2>/dev/null | wc -l | tr -d ' ')"
(( backups >= 3 )) || fail "备份份数不对：$backups"
echo "PASS 部署与回滚各留备份（$backups 份）"

echo "PASS deploy rehearse：首次部署、升级、回滚三条路径都走通"
