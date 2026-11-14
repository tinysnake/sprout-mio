#!/usr/bin/env bash
# 历史 gate。CR1 移除了 ��保留文件只为让归档计划中的命令引用可解析。
# 不要重新加入 suite plan。
echo "retired gate: Agent fanout was removed with the Crew migration (CR1)" >&2
exit 1
