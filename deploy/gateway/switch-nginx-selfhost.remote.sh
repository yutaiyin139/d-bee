#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 服务器端：把 nginx 的 /.cloud/ 上游从「WorkBuddy 云端」切到「本机自托管网关」
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/switch-nginx-selfhost.sh 经 dbee-ssh.py run 调用。
# 占位符（sudo 密码标记）/ __WEBAPP_KEY__ / __SMS_MASTER_CODE__ / __SERVER_NAME__ 由调用方替换。
# 注意：注释里不要写出 sudo 密码标记本身，否则渲染后密码会落盘到远端脚本。
#
# 流程：备份云端配置 → 装自托管配置 → nginx -t → reload → 全链路 E2E 验证 → 失败给回滚命令。
# ⚠️ 只在 nginx -t 通过后才 reload；E2E 失败会**保留**自托管配置并明确给出回滚命令
#    （不自动回滚：切换失败往往需要人先看日志判断，自动回滚反而掩盖现场）。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }

TARGET=/etc/nginx/sites-available/d-bee
NEWCONF=/tmp/dbee-nginx-selfhost.conf
CLOUD_BAK=/etc/nginx/sites-available/d-bee.cloud.bak
KEY="__WEBAPP_KEY__"
MASTER="__SMS_MASTER_CODE__"
BASE="http://127.0.0.1"
A="$BASE/.cloud/auth/v1"

echo "═══ nginx 切换到自托管网关 ═══"

# ── 0) 前置：网关与 PostgREST 必须都在线 ──────────────────────────────
for svc in dbee-gateway postgrest; do
  ST="$(systemctl is-active "$svc" 2>/dev/null || echo none)"
  if [ "$ST" != "active" ]; then
    echo "!! 服务 $svc 不是 active（当前 $ST）—— 切换后该链路会 502，拒绝继续"
    exit 1
  fi
done
echo "  ✓ dbee-gateway 与 postgrest 均 active"
if [ ! -f "$NEWCONF" ]; then echo "!! 缺少 $NEWCONF"; exit 1; fi

# ── 1) 备份现有配置（云端版），供一键回滚 ──────────────────────────────
if SUDO test -f "$TARGET"; then
  # 只在还没有 .cloud.bak 时备份：避免「切到自托管后再次运行本脚本」
  # 会把自托管版覆盖进 .cloud.bak，丢掉真正的云端回滚点。
  if SUDO test -f "$CLOUD_BAK"; then
    echo "  云端备份已存在（$CLOUD_BAK），保留不动"
  else
    SUDO cp -a "$TARGET" "$CLOUD_BAK"
    echo "  ✓ 已备份云端配置 → $CLOUD_BAK"
  fi
fi

# ── 2) 安装自托管配置 ─────────────────────────────────────────────────
SUDO install -m 0644 -o root -g root "$NEWCONF" "$TARGET"
rm -f "$NEWCONF"
echo "  已安装自托管配置到 $TARGET"
echo "    server_name: $(SUDO grep -E '^\s*server_name' "$TARGET" | head -1 | tr -s ' ')"
echo "    上游: $(SUDO grep -E 'proxy_pass http://dbee_gateway' "$TARGET" | head -1 | tr -s ' ')"

# 移除默认站点，避免抢 80
if [ -e /etc/nginx/sites-enabled/default ]; then
  SUDO rm -f /etc/nginx/sites-enabled/default
  echo "  已移除 sites-enabled/default"
fi
SUDO ln -sfn "$TARGET" /etc/nginx/sites-enabled/d-bee

# ── 3) 语法检查（通过才 reload）──────────────────────────────────────
echo "  nginx -t:"
if ! SUDO nginx -t 2>&1 | sed 's/^/    /'; then
  echo "!! nginx 配置语法错误，已保留旧运行态（未 reload）。回滚：见文末"
  exit 1
fi
SUDO systemctl reload nginx
sleep 1
echo "  nginx: $(systemctl is-active nginx)（已平滑 reload）"

# ── 4) 全链路 E2E 验证（经 nginx 80 端口，与真实前端同路径）────────────
echo
echo "═══ 全链路 E2E（经 nginx）═══"
FAIL=0
ok(){ echo "  ✓ $1"; }
bad(){ echo "  ✗ $1"; FAIL=1; }
jq_get(){ grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"?[^\",}]*\"?" | head -1 | sed -E "s/\"$1\"[[:space:]]*:[[:space:]]*\"?([^\"]*)\"?.*/\1/"; }

# 4.0 healthz（免鉴权）
HZ="$(curl -s -m 10 -H "x-wb-webapp-access-key: $KEY" "$BASE/.cloud/healthz")"
echo "$HZ" | grep -q '"ok":true' && ok "healthz 经 nginx 200" || bad "healthz 失败: $HZ"

# 用一个每次运行唯一的测试号，避免与频率限制/已有账号冲突
PHONE="139$(date +%s | tail -c 9)"
echo "  （测试手机号已随机化，用后不保留）"

# 4.1 发码
V="$(curl -s -m 10 -H "content-type: application/json" -H "x-wb-webapp-access-key: $KEY" \
     -d "{\"phone_number\":\"$PHONE\",\"target\":\"ANY\"}" "$A/verification")"
VID="$(echo "$V" | jq_get verification_id)"
echo "$VID" | grep -q '^ver_' && ok "发码 → verification_id" || bad "发码失败: $V"

# 4.2 从 journald 读真实验证码（log 模式：验证码打进日志，这是正常登录路径，不依赖万能码）
sleep 1
CODE="$(SUDO journalctl -u dbee-gateway --no-pager -n 40 2>/dev/null \
  | grep -oE "验证码 : [0-9]{6}" | tail -1 | grep -oE '[0-9]{6}')"
if [ -n "$CODE" ]; then
  ok "从日志读到真实验证码（正常 OTP 路径可用）"
else
  # 读不到就退回万能码（log 模式刻意保留的后门，仅测试用）
  CODE="$MASTER"; echo "  （日志未取到码，退回万能码验证链路）"
fi

# 4.3 验码
VT="$(curl -s -m 10 -H "content-type: application/json" -H "x-wb-webapp-access-key: $KEY" \
      -d "{\"verification_id\":\"$VID\",\"verification_code\":\"$CODE\"}" "$A/verification/verify" | jq_get verification_token)"
echo "$VT" | grep -q '^vt_' && ok "验码 → verification_token" || bad "验码失败（VID=$VID CODE 已取）"

# 4.4 注册/登录（signup 对新号建号并返回会话）
SESS="$(curl -s -m 10 -H "content-type: application/json" -H "x-wb-webapp-access-key: $KEY" \
        -d "{\"verification_token\":\"$VT\",\"phone_number\":\"$PHONE\"}" "$A/signup")"
TOKEN="$(echo "$SESS" | jq_get access_token)"
SUB="$(echo "$SESS" | jq_get sub)"
echo "$TOKEN" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' \
  && ok "signup → access_token（JWT 三段式）" || bad "signup 失败: $SESS"
echo "     sub(owner_id)=${SUB:-<空>}"

# 4.5 user/me（会话回读）
ME="$(curl -s -m 10 -H "x-wb-webapp-access-key: $KEY" -H "authorization: Bearer $TOKEN" "$A/user/me")"
echo "$ME" | grep -q '"sub"' && ok "user/me 回读会话" || bad "user/me 失败: $ME"

# 4.6 🔴 数据面：带 JWT 读 profiles（验证 nginx→网关→PostgREST→PG→RLS 全链路）
#    新用户 profiles 应为空数组（RLS 按 sub 过滤，看不到别人的），关键是 **200 而非 401/403/502**
DP_CODE="$(curl -s -o /tmp/dp.json -w '%{http_code}' -m 10 \
  -H "x-wb-webapp-access-key: $KEY" -H "authorization: Bearer $TOKEN" -H "accept: application/json" \
  "$BASE/.cloud/database/rest/profiles?select=owner_id&limit=1")"
echo "     数据面 GET profiles → HTTP $DP_CODE  body=$(head -c 120 /tmp/dp.json)"
case "$DP_CODE" in
  200) ok "数据面通（nginx→网关→PostgREST→PG）" ;;
  401) bad "数据面 401：JWT 验签失败（网关与 PostgREST 的 jwt-secret 不一致？）" ;;
  502) bad "数据面 502：网关连不到 PostgREST（:3001 没起？）" ;;
  *)   bad "数据面非预期 $DP_CODE" ;;
esac
rm -f /tmp/dp.json

# 4.7 无 token 读数据面应被拒（PostgREST 未设 anon-role）
ANON_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
  -H "x-wb-webapp-access-key: $KEY" "$BASE/.cloud/database/rest/profiles?select=owner_id&limit=1")"
echo "     无 JWT 读 profiles → HTTP $ANON_CODE"
[ "$ANON_CODE" = "401" ] && ok "匿名访问被拒" || bad "匿名竟返回 $ANON_CODE（期望 401）"

# 4.8 静态首页仍正常（前端零改动的确认）
IDX="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/")"
[ "$IDX" = "200" ] && ok "静态首页 200" || bad "首页异常 $IDX"

echo
if [ "$FAIL" = "0" ]; then
  echo "════ ✅ 切换成功，全链路验证通过 ════"
  echo "  现在前端所有 /.cloud/** 请求都走本机自托管栈，不再依赖 WorkBuddy 云端。"
else
  echo "════ 🔴 切换后有验证失败项（见上 ✗）════"
  echo "  自托管配置已生效但链路未全通。先排查，若需立即回滚到云端："
  echo "    sudo cp $CLOUD_BAK $TARGET && sudo nginx -t && sudo systemctl reload nginx"
fi
exit $FAIL
