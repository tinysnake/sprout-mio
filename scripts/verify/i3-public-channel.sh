#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P5a Public Channel 门禁：真实 SQLite + 真实域入口（不 mock 领域层）。
# Risk → Test
# 新建 Project 不带频道，或重复调用造出第二个频道 → createProject 后断言恰一条 kind='public_channel'，
#   ensureProjectChannel 重复调用返回同一 id，绕过域层直插第二条被部分唯一索引拒绝。
# 频道成员是第二份真值、与 Project 成员漂移 → 加 Project 成员后 listChatMembers 立即出现，
#   频道没有任何 chat_member 行，视图来源是 project_member。
# 项目级移除后仍能参与频道 → 移除后频道成员同步消失，历史消息、instance 与 run 仍可读。
# 频道成员可以被单独增删 → addGroupMember/removeGroupMember 返回 channel_membership_managed，
#   文案指向 Project 成员同步，直接 INSERT chat_member 被触发器 public_channel_members_derived 拒绝。
# 两个 Project 的频道互相可见 → 跨 Project 的 getChat/listChatMembers/listChats 全部 not_found。
# Agent 在频道里发不出消息或判定与 DM 不同 → 当前成员在 DM 与频道都 ok，非成员在两处同一个 not_found。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-i3-public-channel.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/public-channel.sqlite"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/public-channel.ts
