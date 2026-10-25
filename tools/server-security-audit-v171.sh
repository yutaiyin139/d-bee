#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 生产安全体检（只读）：V1.7.1 正式发布前的阻断项排查
# ═══════════════════════════════════════════════════════════════════════
# 覆盖：① 公网端口暴露面 ② SMS 万能码 ③ PG 监听与认证 ④ 防火墙
#       ⑤ 密钥泄露痕迹 ⑥ 服务矩阵 ⑦ nginx 配置 ⑧ HTTPS/证书
#       ⑨ RLS/权限现状 ⑩ 备份可用性
# 全程只读，不做任何写操作、不改配置、不重启服务。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
SEC() { echo "────────────────────────────────────────────"; }

echo "════════ D-Bee 生产安全体检 · $(date '+%F %T') ════════"

SEC; echo "① 公网监听端口暴露面（0.0.0.0 / :: 才是真暴露）"
SUDO ss -tlnp 2>/dev/null | awk 'NR==1 || /0\.0\.0\.0:|:::|\*:/ {print}' | sed 's/^/  /'
echo "  -- 逐个判定 --"
for p in 22 80 443 3000 3001 5432 8080; do
  line=$(SUDO ss -tlnp 2>/dev/null | grep -E ":$p\s" | head -1)
  if [ -z "$line" ]; then echo "  :$p  未监听"; continue; fi
  if echo "$line" | grep -qE '0\.0\.0\.0:'"$p"'|:::'"$p"'\s|\*:'"$p"; then
    echo "  🔴 :$p  对公网暴露  ($(echo "$line" | grep -oE 'users:\(\("[^"]+"' | head -1))"
  else
    echo "  ✓ :$p  仅回环/内网"
  fi
done

SEC; echo "② SMS 万能码与短信通道（🔴 生产启用万能码 = 任意账号可被登录）"
SUDO grep -E '^(SMS_PROVIDER|SMS_MASTER_CODE|SMS_SIGN_NAME|OTP_MAX_ATTEMPTS|OTP_TTL_SEC|OTP_IP_HOUR_LIMIT|OTP_RESEND_SEC)=' /etc/dbee/gateway.env 2>/dev/null \
  | sed -E 's/(SMS_MASTER_CODE=)(.{2}).*/\1\2***(已配，长度见下)/' | sed 's/^/  /'
MC=$(SUDO grep -E '^SMS_MASTER_CODE=' /etc/dbee/gateway.env 2>/dev/null | cut -d= -f2-)
echo "  SMS_MASTER_CODE 长度=${#MC}  ${MC:+🔴 已配置万能码}"
SUDO grep -E '^SMS_PROVIDER=' /etc/dbee/gateway.env 2>/dev/null | sed 's/^/  /'
echo "  -- 启动日志中的万能码告警 --"
SUDO journalctl -u dbee-gateway --no-pager -n 300 2>/dev/null | grep -iE "万能码|SMS_PROVIDER|master" | tail -3 | sed 's/^/  /'

SEC; echo "③ PostgreSQL 监听地址与认证方式"
PGCONF=$(SUDO -u postgres psql -tAc "SHOW config_file" 2>/dev/null)
echo "  config_file=$PGCONF"
SUDO -u postgres psql -tAc "SHOW listen_addresses" 2>/dev/null | sed 's/^/  listen_addresses=/'
echo "  -- pg_hba.conf 非注释行 --"
SUDO grep -vE '^\s*#|^\s*$' "$PGCONF" 2>/dev/null >/dev/null
HBADIR=$(dirname "$PGCONF" 2>/dev/null)
SUDO grep -vE '^\s*#|^\s*$' "$HBADIR/pg_hba.conf" 2>/dev/null | sed 's/^/    /'
echo "  -- 数据库角色危险属性 --"
SUDO -u postgres psql -tAc "
SELECT rolname || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls || ' createdb=' || rolcreatedb || ' login=' || rolcanlogin
FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' ORDER BY rolname" 2>/dev/null | sed 's/^/    /'

SEC; echo "④ 防火墙状态"
SUDO ufw status verbose 2>/dev/null | sed 's/^/  /' || echo "  ufw 不可用"
echo "  -- iptables INPUT 链 --"
SUDO iptables -L INPUT -n --line-numbers 2>/dev/null | head -12 | sed 's/^/    /'

SEC; echo "⑤ 密钥泄露痕迹扫描（部署目录/日志/历史临时文件）"
echo "  -- /opt/dbee-gateway 内是否混入 env/secret 文件 --"
SUDO find /opt/dbee-gateway -maxdepth 2 \( -name '*.env*' -o -name '*secret*' \) 2>/dev/null | sed 's/^/    /' || true
echo "  -- /tmp 残留（含秘密的渲染产物/迁移文件）--"
ls -la /tmp/ 2>/dev/null | grep -iE 'gateway|env|secret|dbee|\.sql' | sed 's/^/    /' || echo "    ✓ 无残留"
echo "  -- journald 是否记录过验证码/密钥明文（最近 500 行）--"
VC=$(SUDO journalctl -u dbee-gateway --no-pager -n 500 2>/dev/null | grep -cE '验证码 : [0-9]{6}')
echo "    日志中出现明文验证码次数: $VC  $([ "$VC" -gt 0 ] && echo '🔴 log 模式必然留痕，切短信后消失')"
echo "  -- env 文件权限 --"
SUDO stat -c '%a %U:%G %n' /etc/dbee/gateway.env /etc/dbee/gateway.env.bak 2>/dev/null | sed 's/^/    /'

SEC; echo "⑥ 服务矩阵与健康状态"
for s in dbee-gateway postgrest nginx postgresql; do
  st=$(SUDO systemctl is-active "$s" 2>/dev/null || echo "?")
  en=$(SUDO systemctl is-enabled "$s" 2>/dev/null || echo "?")
  echo "  $s: active=$st enabled=$en"
done
echo "  -- 网关 healthz --"
curl -sf -m 5 http://127.0.0.1:8080/.cloud/healthz | head -c 300 | sed 's/^/  /'; echo
echo "  -- PostgREST 直连 --"
curl -s -o /dev/null -w '  PostgREST :3001 → HTTP %{http_code}\n' -m 5 http://127.0.0.1:3001/ 2>/dev/null

SEC; echo "⑦ nginx 站点与上游"
ls /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^/  enabled: /'
echo "  -- server_name / listen / proxy_pass 摘要 --"
SUDO grep -rhE '^\s*(server_name|listen|proxy_pass|root|ssl_certificate)\s' /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^\s*/    /' | sort -u | head -30

SEC; echo "⑧ HTTPS 与证书"
echo "  -- 本机 80/443 探测 --"
curl -s -o /dev/null -w '    http://127.0.0.1/  → %{http_code}\n' -m 5 http://127.0.0.1/ 2>/dev/null
curl -sk -o /dev/null -w '    https://127.0.0.1/ → %{http_code}\n' -m 5 https://127.0.0.1/ 2>/dev/null || echo "    https 未监听或握手失败"
echo "  -- 证书清单与到期 --"
SUDO find /etc/letsencrypt/live -name 'fullchain.pem' 2>/dev/null | while read -r c; do
  exp=$(SUDO openssl x509 -enddate -noout -in "$c" 2>/dev/null | cut -d= -f2)
  echo "    $c  到期: $exp"
done
echo "  -- certbot 定时器 --"
SUDO systemctl list-timers 2>/dev/null | grep -i certbot | sed 's/^/    /' || echo "    (无 certbot 定时器)"

SEC; echo "⑨ RLS 与表权限现状（0033/0035/0039 收紧效果）"
SUDO -u postgres psql -d dbee -tAc "
SELECT relname || ' rls=' || relrowsecurity || ' forcerls=' || relforcerls
FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
ORDER BY relname" 2>/dev/null | sed 's/^/  /'
echo "  -- 关键表的写权限矩阵（authenticated 应无直接写）--"
SUDO -u postgres psql -d dbee -tAc "
SELECT table_name || ': ' || string_agg(privilege_type, ',' ORDER BY privilege_type)
FROM information_schema.role_table_grants
WHERE grantee IN ('authenticated','anon','dbee_app')
  AND table_schema='public'
  AND table_name IN ('entitlements','honey_ledger','payment_orders','apple_transactions','ai_quota_claims','leaderboard_cache','app_users','profiles')
GROUP BY table_name, grantee ORDER BY table_name" 2>/dev/null | sed 's/^/    /'

SEC; echo "⑩ 备份可用性与磁盘"
echo "  -- 备份清单（最近 8 份）--"
SUDO ls -lht /opt/dbee-db/backups/ 2>/dev/null | head -9 | sed 's/^/    /'
SUDO ls -lht /var/backups/dbee/ 2>/dev/null | head -6 | sed 's/^/    /'
echo "  -- 最新备份完整性抽验 --"
LATEST=$(SUDO ls -1t /opt/dbee-db/backups/*.sql.gz 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  SZ=$(SUDO stat -c%s "$LATEST" 2>/dev/null)
  if SUDO bash -c "gunzip -t '$LATEST'" 2>/dev/null; then
    echo "    ✓ $LATEST (${SZ}B) gunzip -t 通过"
  else
    echo "    🔴 $LATEST (${SZ}B) 归档损坏"
  fi
else
  echo "    🔴 无备份文件"
fi
echo "  -- 磁盘 --"
df -h / /var /opt 2>/dev/null | sed 's/^/    /'

SEC; echo "⑪ 迁移与函数最终态"
SUDO -u postgres psql -d dbee -tAc "
SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations" 2>/dev/null | sed 's/^/  已登记迁移: /'
SUDO -u postgres psql -d dbee -tAc "
SELECT 'public 函数总数=' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'" 2>/dev/null | sed 's/^/  /'
echo "  -- SECURITY DEFINER 函数的属主与 search_path（防提权）--"
SUDO -u postgres psql -d dbee -tAc "
SELECT p.proname || ' owner=' || r.rolname || ' sp=' || coalesce(array_to_string(p.proconfig,'|'),'<未设>')
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
WHERE n.nspname='public' AND p.prosecdef
ORDER BY (p.proconfig IS NULL) DESC, p.proname" 2>/dev/null | sed 's/^/    /'

echo
echo "════════ 体检完成 ════════"
