#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P5a 对话权限范围门禁：真实 SQLite + 真实领域入口（不 mock 领域层）。
# Risk → Test（验收 A03/A04/N04 与裁定 d30）
# 旧标题写入路径绕过 Agent 治理边界（A03）→ 能力表必须显式列出 title_change，
#   Agent 执行身份 updateChatTitle/clearChatTitle 返回 forbidden 且标题不变；Human 同名操作照旧成功。
# Agent 的 Chat 读写没绑定 run 所在 Project（A04）→ 同一 Human 的 A/B 两个 Project，
#   A 的真实 running run 对 B 的群与频道 getChat/getInstance/listMessages/listChats/sendMessage 全部 not_found，
#   消息行数不变；同一 Project 里的另一个对话同样不在范围里。上界：自己的对话可读可写，Human 读取不变。
# 领域 sendMessage 不验证 run（N04）→ 不存在的 run、instance 不匹配的 run、已结束的 run 三种身份都被拒且不落消息行。
# 显式移出后运行身份仍能读（A04）→ 项目级移除之后，那次运行对群/instance/消息/发言一律 not_found，
#   Human 仍读得到移出者的历史消息。
# Project 驱动的成员变化不推进治理版本（N02/d30）→ 删除群成员行的项目级移除让受影响群 +1，
#   未受影响的群不动；移除前读到的 expectedRevision 做治理写入返回 conflict，当前版本可以正常写入；
#   重复移除不再推进。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-i7-chat-scope.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/chat-scope.sqlite"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/chat-scope.ts
