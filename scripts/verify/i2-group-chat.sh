#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P5a Group 治理门禁：真实 SQLite + 真实领域入口（不 mock 领域层）。
# Risk → Test
# Human 不能建群或指定 Agent owner → 建群后 chat.kind/owner/成员逐条断言，治理版本从 0 起。
# Agent 能改成员或换 owner → add/remove/owner 三个命令都以 Agent 行动者调用，断言 forbidden 且行数与版本零变动。
# Human 指定 Agent owner 后群组冻结（d6 的能力死锁）→ 由 project.created_by 的人类加成员、换 owner 成功。
# 治理写入无并发保护 → 过期 governance_revision 换 owner/加成员返回 conflict，所有者与版本不变。
# 移除成员留下活跃 run 的悬空输入（d10）→ 有活跃 run 时移除返回 conflict 且 pending 输入仍 pending；
#   无活跃 run 时移除成功，pending 输入转 cancelled/membership_revoked，delivered 语义不混用（d11）。
# 向 Public Channel 直接加成员 → 数据库触发器 public_channel_members_derived 拒绝，
#   领域层返回 channel_membership_managed；chat_member 只剩 insert 与身份不可变触发器（d12）。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-i2-group-chat.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/group-chat.sqlite"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/group-chat.ts
