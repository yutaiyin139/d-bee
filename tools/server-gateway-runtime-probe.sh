#!/usr/bin/env bash
# 只读：验证生产网关运行时行为（Apple 端点是否存在、Qwen 版特征、路由清单）
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
LIB=/opt/dbee-gateway/lib

echo "═══ 1) Apple 支付端点运行时探测（无凭据，只看路由存在性）═══"
for ep in /.cloud/payment/apple/verify /.cloud/payment/apple/notifications; do
  code=$(curl -s -o /tmp/probe-body.json -w '%{http_code}' -m 5 -X POST "http://127.0.0.1:8080$ep" -H 'content-type: application/json' -d '{}')
  echo "  POST $ep → HTTP $code  body=$(head -c 200 /tmp/probe-body.json)"
done
rm -f /tmp/probe-body.json

echo
echo "═══ 2) LLM 端点无鉴权探测（应 401）═══"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "http://127.0.0.1:8080/.cloud/llm/chat/completions" -H 'content-type: application/json' -d '{"model":"deepseek-chat","messages":[]}')
echo "  POST /.cloud/llm/chat/completions (无 token) → HTTP $code"

echo
echo "═══ 3) 服务器 config.mjs / llm.mjs 版本指纹 ═══"
echo "-- Qwen 双 provider 特征（63c0a71，2026-10-24 19:09）--"
grep -cE 'qwen|QWEN|dashscope|provider' "$LIB/config.mjs" | xargs echo "  config.mjs qwen/provider 关键词行数:"
grep -oE 'LLM_[A-Z_]+' "$LIB/config.mjs" | sort -u | head -20 | sed 's/^/    /'
echo "-- llm.mjs 模型目录 --"
grep -nE "id: '|vision" "$LIB/llm.mjs" | head -12 | sed 's/^/    /'

echo
echo "═══ 4) 服务器 app.mjs 路由注册清单 ═══"
grep -nE "router\.on\(" "$LIB/app.mjs" | sed 's/^/    /'

echo
echo "═══ 5) /etc/dbee/gateway.env 键名清单（只列键，不显值）═══"
SUDO grep -oE '^[A-Z_]+' /etc/dbee/gateway.env | sort | sed 's/^/    /'
echo "  -- APPLE_* / LLM_GATE / TRUSTED_PROXY 是否配置 --"
SUDO grep -cE '^APPLE_' /etc/dbee/gateway.env | xargs echo "    APPLE_* 键数:"
SUDO grep -cE '^(LLM_GATE_ENABLED|TRUSTED_PROXY_IPS|APPLE_ALLOWED_ENVS)' /etc/dbee/gateway.env | xargs echo "    0039 新键数:"

echo
echo "═══ 6) PostgREST schema 缓存新鲜度（0039/0040 函数是否已暴露）═══"
SUDO -u postgres psql -d dbee -tAc "
SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('llm_gate','honey_balance','grant_honey','redeem_honey','settle_invite_checkin','consume_photo_quota')
ORDER BY 1"

echo
echo "═══ 完成 ═══"
