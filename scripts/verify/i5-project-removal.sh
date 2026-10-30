#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P5a 项目级移除门禁：真实 SQLite + 真实域入口（不 mock 领域层）。
# Risk → Test
# 移除所有者后群组悬空 owner → 该 Agent 是群 owner 时移除被拒（conflict），
#   project_member、群 owner、普通群成员行与诊断事件全部不变。
# 移除有活跃 run 的 Agent 留下无人接的输入 → 有 queued/running run 时整次移除被拒（d10 拒绝优先），
#   run 仍 queued、pending 输入仍 pending、成员行仍在，且不写 project_member.removed 事件。
# 移除后普通群成员列表还留着这个人（视图 group 分支读 chat_member）→ 无在途时移除成功，
#   普通群 chat_member 行物理消失，DM 成员行保留（d14）。
# pending 输入一直挂着 → 未下发的输入转 cancelled/membership_revoked，delivered 输入不被改写（d11）。
# 重复移除报错或留副作用 → 第二次移除成功且所有表快照不变；拼错 profile id 仍是 not_found。
# 移除后历史读不到或还能发言 → 群/DM/频道的历史消息、instance、run、输入（含取消事实）仍可读，
#   以它身份发言在三个对话里一律 not_found 且不落消息行。
# 频道成员不随移除消失 → 频道成员列表精确等于移除前的集合减去该 Agent（端到端断言）。
# 移除后旧 DM 仍接受 Human 消息（A02）→ DM 归档，Human 发言在写入前得到 conflict，
#   不落消息、不排队必败 run；重新加入 Project 后既有 DM 取消归档并恢复可用。
# 项目级移除成为越权入口 → 非创建者调用返回 not_found 且不产生副作用。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-i5-project-removal.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/project-removal.sqlite"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/project-removal.ts
