#!/usr/bin/env bash
# 只读：确认生产实际生效的视觉模型 ID 与 provider
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }

echo "═══ 1) 生产 env 的 LLM 模型键（非秘密，可显示）═══"
SUDO grep -E '^(LLM_MODEL_TEXT|LLM_MODEL_VISION|LLM_VISION_MODEL|LLM_VISION_BASE_URL|LLM_BASE_URL)=' /etc/dbee/gateway.env

echo
echo "═══ 2) 网关日志中实际调用的视觉模型（最近 200 行）═══"
SUDO journalctl -u dbee-gateway --no-pager -n 200 2>/dev/null | grep -oE 'model=[a-z0-9._-]+' | sort | uniq -c | sort -rn

echo
echo "═══ 3) LLM_VISION_BASE_URL 的 host（确认 provider）═══"
SUDO grep -E '^LLM_VISION_BASE_URL=' /etc/dbee/gateway.env | sed -E 's#(https?://[^/]+).*#\1#'

echo "═══ 完成 ═══"
