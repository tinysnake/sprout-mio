#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P5a 扇出门禁：真实 SQLite + 真实领域入口 + 真实 host 轮询（不 mock 领域层）。
# Risk → Test
# 一条人类消息只能开一条 run（fanout 缺席）→ 群里点名 owner 与被点名 Agent，断言两条 run、
#   两条 agent_run_input，且各自挂在被唤醒 Agent 的 instance 上。
# 同一 instance 并发开第二条 run → 已有活跃 run 时新输入挂到同一条 run，run 行数不变。
# 两条 run 互相看到对方的输入 → A 的 run 读不到 B 的输入，反之亦然（输入按 run_id 隔离）。
# 频道按成员广播 → 频道里点名只唤醒一个 run，无点名的消息不开任何 run（d18，绝不广播）。
# DM 行为被扇出改动 → DM 一条消息一条 run，活跃 run 复用同一条，逐条不变。
# 跨 chat 的 assistant_message_id 只在代码里成立 → 直接 UPDATE 绑别的 chat 的消息被 0024 复合外键拒绝。
# 一个会话多 run 时 host 漏跑或重复跑 → 真实 queuedRunWork + 真实轮询把同 chat 的两条 run 各拾起一次。
# Agent 移出 Project 后还能在老 DM 发言（d19）→ 视图仍列出该成员，但 sendMessage 拒绝。
# run 正常完成后晚到输入滞留（A01）→ 真实 executeRun + 受控 Pi 进程适配器在 prompt 返回前插一条
#   人类消息，完成后该输入必须在下一轮的 run 上，且下一轮能把它投递出去。
# 同一条消息重复投递（N01）→ 活跃 run 上重投不抛主键错误，终态 run 之后重投不再开第二条 run。
# 受控适配器不启动模型子进程，所以必须关掉真实宿主（SPROUT_PI_ENABLED=false）并自备 auth secret
# （startRuntime 会加载 lib/auth 校验 BETTER_AUTH_SECRET）。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-i4-agent-fanout.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/agent-fanout.sqlite"
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export SPROUT_PI_DATA_DIR="$verification_dir/pi"
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/agent-fanout.ts
