#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# I-P4d 页面门禁：真实生产包 + 真实 SQLite + 真实 Chromium 打开正式 Project settings 页。
# Risk → Test
# 只显示最新 active：active + fencing 仍在当前区并标「暂不可用」；detaching 离开当前区与新增使用
#   选择器、进入待处理；removed 只在已移出记录与历史里 → 同一页面读真实关系与租约事实。
# 待处理细节默认收起：收起状态只能看到状态、等待时长、Worker 在线事实与下一步；执行数与证据只在
#   展开后出现 → 断言收起时的可见文本不含这两项。
# 移出被说成已移出/空闲 → 对话框取消不写库（关系仍 active、无新收据）；确认后服务端返回 detaching，
#   页面保留该行到待处理并显示「移出尚未完成」。
# force 被说成执行已停止 → 只有 canForceReclaim=true 的待处理才有「强制收回」；force 后标「撤权未确认」，
#   除「无法确认远端执行已停止」外不得出现「执行已停止」这类肯定文案。
# 重新加入覆盖新关系 → 旧页面用过期 epoch 重新加入显示 conflict 且不写库；最新 removed 才成功。
# 历史区出现替 Agent 操作 → 只读历史能读到执行与租约收据，且没有标记已读／替 Agent 读日志／取消。
# 五秒刷新与断线被伪装成当前事实 → 服务端事实变化后页面自行更新；读取失败保留上次事实并标未确认。
# 反证：直接请求移出接口缺 confirm / confirm:false 一律 validation_failed 且无写；跨 Project／跨用户
#   读取、历史与移出都返回 not_found，页面不泄露他人 Machine。
mkdir -p .verify
# 私有库、会话 cookie 与截图留在 .verify 下，不写共享业务库。
verification_dir="$(mktemp -d .verify/p4d-pages-db.XXXXXX)"
# 证据留在稳定的 .verify/p4d-pages 下供报告引用；临时库目录在退出时清掉。
evidence_dir="${SPROUT_PAGES_EVIDENCE:-.verify/p4d-pages}"
mkdir -p "$evidence_dir"
trap 'rm -rf "$verification_dir"' EXIT
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
export DATABASE_URL="$verification_dir/pages.sqlite"
export SPROUT_PAGES_EVIDENCE="$evidence_dir"
export BASE_URL="http://127.0.0.1:${SPROUT_PAGES_PORT:-3142}"
export APP_ORIGIN="$BASE_URL"
export NODE_ENV=production
export SPROUT_PI_ENABLED=false
# 恢复宽限只影响服务端对失联执行的归约；这里不依赖它，保持产品默认。
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

# 生产包与迁移都显式准备：夹具与服务端必须看到同一张表结构。
node scripts/verify/prepare.mjs server
node --import tsx src/db/migrate.ts

node --import tsx tests/fixtures/p4d-pages.ts
printf 'PASS P4d pages: current/pending split, collapsed pending summary, detach dialog,\n'
printf '     force reclaim wording, rejoin epoch conflict, read-only history, 5s refresh,\n'
printf '     confirm-less detach refusal and cross-user isolation (evidence %s)\n' "$SPROUT_PAGES_EVIDENCE"
