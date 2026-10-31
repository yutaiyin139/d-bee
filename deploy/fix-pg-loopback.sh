#!/usr/bin/env bash
# 修复：PostgreSQL 5432 对公网开放 → 收回回环（listen_addresses = 'localhost'）。
#
# 安全性论证（2026-10-31 只读探针实测）：
#   · 网关     DBEE_HOST=127.0.0.1（gateway.env:40）
#   · PostgREST db-uri postgres://dbee_web:...@127.0.0.1:5432/dbee（config.template:22）
#   · 备份     /usr/local/bin/dbee-backup.sh 用 sudo -u postgres pg_dump（unix socket）
#   · 当前活跃连接全为 127.0.0.1（pg_stat_activity 实测）
#   → 收回回环不影响任何在跑的服务；pg_hba 的 114.x 家宽白名单条目随之失效（保留不删，
#     将来走 SSH 隧道时连的是 127.0.0.1 条目）。
#
# 回滚守卫：restart 后 30 秒内逐项验证（本地 psql / 网关 healthz 含 db.ok / PostgREST），
# 任一失败 → 恢复备份 conf → 再 restart → 报错退出。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }

CONF=/etc/postgresql/17/main/postgresql.conf
BAK="${CONF}.bak-$(date +%Y%m%d-%H%M%S)"

echo "═══ 1) 备份 postgresql.conf ═══"
SUDO cp -a "$CONF" "$BAK" && echo "  ✅ $BAK"

echo "═══ 2) 当前值 ═══"
SUDO grep -nE "^\s*listen_addresses" "$CONF" | sed 's/^/  /'

echo "═══ 3) 修改 listen_addresses = 'localhost' ═══"
# 只改未被注释的那一行；改完立即回显 diff
SUDO sed -i "s/^\s*listen_addresses\s*=\s*'\*'/listen_addresses = 'localhost'/" "$CONF"
NEW=$(SUDO grep -E "^\s*listen_addresses" "$CONF")
echo "  改后: $NEW"
if ! echo "$NEW" | grep -q "'localhost'"; then
  echo "  🔴 替换未生效，回滚备份并退出"
  SUDO cp -a "$BAK" "$CONF"
  exit 1
fi

echo "═══ 4) 重启 PostgreSQL（listen_addresses 只能启动时生效）═══"
SUDO systemctl restart postgresql
sleep 3
ACTIVE=$(systemctl is-active postgresql)
echo "  postgresql: $ACTIVE"

echo "═══ 5) 验证（30 秒窗口）═══"
fail() { echo "  🔴 验证失败: $1 —— 自动回滚"; SUDO cp -a "$BAK" "$CONF"; SUDO systemctl restart postgresql; sleep 3; echo "  已回滚到 $BAK，postgresql=$(systemctl is-active postgresql)"; exit 1; }

[ "$ACTIVE" = "active" ] || fail "postgresql 未 active"

SUDO -u postgres psql -d dbee -tAc "select 1" >/dev/null 2>&1 || fail "本地 psql 连不上"
echo "  ✅ 本地 psql（unix socket）正常"

HZ=$(curl -sS -m 10 http://127.0.0.1:8080/.cloud/healthz 2>/dev/null)
echo "  healthz: ${HZ:0:120}"
echo "$HZ" | grep -q '"db":{"ok":true' || fail "网关连库失败（db.ok != true）"
echo "  ✅ 网关 → PG 正常"

PG_CODE=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/ 2>/dev/null || echo 000)
echo "  PostgREST root -> HTTP $PG_CODE"
[ "$PG_CODE" = "200" ] || [ "$PG_CODE" = "401" ] || fail "PostgREST 无响应（HTTP $PG_CODE）"
echo "  ✅ PostgREST → PG 正常"

echo "═══ 6) 监听复查 ═══"
SUDO ss -lntp 2>/dev/null | grep ':5432' | sed 's/^/  /'
if SUDO ss -lntp 2>/dev/null | grep ':5432' | grep -qE '0\.0\.0\.0:5432|\[::\]:5432'; then
  fail "5432 仍在监听全部接口"
fi
echo "  ✅ 5432 只监听回环"

echo "═══ 7) 网关服务状态复查（连接池是否自愈）═══"
sleep 2
GW=$(systemctl is-active dbee-gateway 2>/dev/null); PR=$(systemctl is-active postgrest 2>/dev/null)
echo "  dbee-gateway=$GW postgrest=$PR"
[ "$GW" = "active" ] || echo "  ⚠️ 网关非 active，检查 journalctl -u dbee-gateway"
[ "$PR" = "active" ] || echo "  ⚠️ postgrest 非 active，检查 journalctl -u postgrest"

echo "═══ 完成：5432 已收回回环。pgAdmin 远程直连从此失效，改用 SSH 隧道：═══"
echo "    ssh -L 15432:127.0.0.1:5432 ubuntu@150.158.51.106   （然后 pgAdmin 连 127.0.0.1:15432）"
