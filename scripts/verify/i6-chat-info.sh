#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P5a 会话读模型门禁：真实 SQLite + 真实领域入口（不 mock 领域层）。
# Risk → Test
# 群里多个 Agent 各一条 run → 会话读模型返回每个 instance 及其自己的活跃 run，不串到别人。
# 频道成员可被直接调整 / 频道被当成 DM → 成员等于 Project 成员，未唤醒时无分身，标题取固定文案。
# 多 Agent 改造把 DM 读模型带偏 → DM 的 ChatDetail 与 getChatInfo 字段集合写死断言（改造前形状）。
# Info Hub run 列表无法按会话聚合 → 会话聚合给出会话、标题、去重 Agent 数与状态分布；
#   同一 Agent 的多条 run 只计 1 个 Agent；频道不被当成 DM 关联。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-i6-chat-info.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/chat-info.sqlite"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/chat-info.ts
