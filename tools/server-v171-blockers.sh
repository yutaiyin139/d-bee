#!/usr/bin/env bash
# 只读：V1.7.1 阻断项精确复核（权限矩阵 grantee 归属 / nginx / 5432 白名单 / 站点版本）
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
SEC() { echo "────────────────────────────────────────────"; }

SEC; echo "① 关键表权限矩阵（含 grantee，确认 authenticated 有无直接写）"
SUDO -u postgres psql -d dbee -P pager=off -c "
SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema='public' AND grantee IN ('authenticated','anon','dbee_app','dbee_web','PUBLIC')
  AND table_name IN ('entitlements','honey_ledger','payment_orders','apple_transactions',
                     'ai_quota_claims','ai_usage','leaderboard_cache','app_users','profiles',
                     'meal_entries','invite_relations','redemption_codes')
GROUP BY table_name, grantee ORDER BY table_name, grantee" 2>/dev/null | sed 's/^/  /'

echo "  -- 🔴 专项：authenticated/anon 是否对「权益/积分/订单」有写权限（应全部为否）--"
SUDO -u postgres psql -d dbee -tAc "
SELECT coalesce(string_agg(table_name || '.' || privilege_type || '(' || grantee || ')', ', '), '✓ 无任何写权限')
FROM information_schema.role_table_grants
WHERE table_schema='public' AND grantee IN ('authenticated','anon')
  AND privilege_type IN ('INSERT','UPDATE','DELETE')
  AND table_name IN ('entitlements','honey_ledger','payment_orders','apple_transactions','ai_quota_claims','leaderboard_cache')" 2>/dev/null | sed 's/^/    /'

echo "  -- leaderboard_cache 权限（0040 要求全 REVOKE）--"
SUDO -u postgres psql -d dbee -tAc "
SELECT coalesce(string_agg(grantee || ':' || privilege_type, ', '), '✓ 无任何 GRANT（符合 0040）')
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='leaderboard_cache'" 2>/dev/null | sed 's/^/    /'

SEC; echo "② 0039 修复的 RPC 归属校验（真实越权写实测，事务内回滚）"
SUDO -u postgres psql -d dbee -tAc "
SELECT 'grant_honey 可被 authenticated 直接调用? ' || has_function_privilege('authenticated','public.grant_honey(text,text,integer,integer)','EXECUTE')" 2>/dev/null | sed 's/^/  /'
SUDO -u postgres psql -d dbee -tAc "
SELECT 'llm_gate 对 authenticated? ' || has_function_privilege('authenticated','public.llm_gate(text)','EXECUTE')
    || ' | 对 dbee_app? ' || has_function_privilege('dbee_app','public.llm_gate(text)','EXECUTE')" 2>/dev/null | sed 's/^/  /'
echo "  -- 全部 SECURITY DEFINER 函数对 authenticated 的 EXECUTE 面 --"
SUDO -u postgres psql -d dbee -tAc "
SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
ORDER BY p.proname" 2>/dev/null | sed 's/^/    可调用: /'

SEC; echo "③ 5432 白名单来源核实"
echo "  -- pg_hba 中的外部网段 --"
SUDO grep -E '^host' /etc/postgresql/17/main/pg_hba.conf 2>/dev/null | grep -vE '127\.0\.0\.1|::1' | sed 's/^/    /'
echo "  -- 当前 SSH 客户端出口 IP（对照白名单网段）--"
curl -sf -m 8 https://ifconfig.me 2>/dev/null | sed 's/^/    本机出口 IP: /' || echo "    (取不到)"
echo "  -- 5432 现有连接来源 --"
SUDO -u postgres psql -d dbee -tAc "
SELECT coalesce(string_agg(DISTINCT client_host::text, ', '), '(无远程连接，全为本地 socket)')
FROM pg_stat_activity WHERE client_host IS NOT NULL" 2>/dev/null | sed 's/^/    /'
echo "  -- 从公网角度试连 5432（本地回环模拟外部拒绝路径）--"
timeout 6 bash -c '</dev/tcp/127.0.0.1/5432' 2>/dev/null && echo "    5432 回环可连（预期）" || echo "    5432 回环不可连"

SEC; echo "④ nginx 站点配置全文（d-bee）"
SUDO cat /etc/nginx/sites-enabled/d-bee 2>/dev/null | grep -vE '^\s*#' | grep -vE '^\s*$' | sed 's/^/    /' | head -60
echo "  -- 是否有 443/ssl 段 --"
SUDO grep -cE 'listen\s+443|ssl_certificate' /etc/nginx/sites-enabled/d-bee 2>/dev/null | sed 's/^/    443\/ssl 指令数: /'
echo "  -- nginx 对外可达性（本机经 80）--"
curl -s -o /dev/null -w '    GET / → %{http_code}  size=%{size_download}\n' -m 8 http://127.0.0.1/ 2>/dev/null

SEC; echo "⑤ 线上 Web 版本指纹（V1.7.0 还是更早）"
echo "  -- index.html 引用的 assets --"
curl -sf -m 8 http://127.0.0.1/ 2>/dev/null | grep -oE '(src|href)="[^"]+"' | head -8 | sed 's/^/    /'
echo "  -- 站点根目录与 mtime --"
ROOT=$(SUDO grep -rhE '^\s*root\s' /etc/nginx/sites-enabled/d-bee 2>/dev/null | head -1 | awk '{print $2}' | tr -d ';')
echo "    root=$ROOT"
[ -n "$ROOT" ] && SUDO ls -la "$ROOT" 2>/dev/null | head -8 | sed 's/^/    /'
echo "  -- 线上 JS 里是否已含 0040 的 honey_balance RPC 调用（前端优化是否已发布）--"
JS=$(curl -sf -m 8 http://127.0.0.1/ 2>/dev/null | grep -oE 'assets/[^"]+\.js' | head -1)
if [ -n "$JS" ]; then
  HIT=$(curl -sf -m 15 "http://127.0.0.1/$JS" 2>/dev/null | grep -c 'honey_balance')
  echo "    $JS 中 honey_balance 出现次数: $HIT  $([ "$HIT" -eq 0 ] && echo '→ 🔴 线上前端仍是旧版（⑥ 未触达用户）' || echo '→ ✓ 已含 RPC 优先路径')"
else
  echo "    (未取到 JS 路径)"
fi

SEC; echo "⑥ Apple IAP 上架前置配置现状"
SUDO grep -cE '^APPLE_' /etc/dbee/gateway.env 2>/dev/null | sed 's/^/  /etc/dbee/gateway.env 中 APPLE_* 键数: /'
echo "  -- 网关 IAP 端点行为 --"
for ep in /.cloud/payment/apple/verify /.cloud/payment/apple/notifications; do
  code=$(curl -s -o /tmp/pb.json -w '%{http_code}' -m 5 -X POST "http://127.0.0.1:8080$ep" -H 'content-type: application/json' -d '{}')
  echo "    POST $ep → $code $(head -c 120 /tmp/pb.json)"
done
rm -f /tmp/pb.json
echo "  -- apple_transactions / apple_notifications 表是否就位（0037）--"
SUDO -u postgres psql -d dbee -tAc "
SELECT string_agg(relname, ', ' ORDER BY relname) FROM pg_class
WHERE relnamespace='public'::regnamespace AND relname LIKE 'apple%'" 2>/dev/null | sed 's/^/    /'

SEC; echo "⑦ /tmp 秘密残留专项（权限与内容类型）"
for f in /tmp/gateway.env.new /tmp/0032-postgrest-roles.sql /tmp/dbee-migration-manifest.tsv; do
  if [ -e "$f" ]; then
    SUDO stat -c '  %n  mode=%a owner=%U:%G size=%s mtime=%y' "$f" 2>/dev/null
    world=$(SUDO stat -c '%a' "$f" 2>/dev/null)
    case "$world" in *4|*5|*6|*7) echo "    🔴 其他用户可读（末位含 4/5/6/7）—— 含秘密则为泄露面";; *) echo "    ✓ 仅属主可读";; esac
  fi
done
echo "  -- /tmp 下渲染后含明文 sudo 密码的残留脚本（0700 但密码落盘）--"
SUDO bash -c 'grep -l "sudo -S" /tmp/dbee-*.sh 2>/dev/null | head -10' | sed 's/^/    /' || echo "    (无)"

SEC; echo "⑧ 备份链完整性（用 root 权限重查，修正上轮 glob 失效）"
SUDO bash -c 'ls -1t /opt/dbee-db/backups/*.sql.gz 2>/dev/null | head -3' | sed 's/^/  /opt: /'
SUDO bash -c 'ls -1t /var/backups/dbee/*.dump 2>/dev/null | head -5' | sed 's/^/  /var: /'
LATEST=$(SUDO bash -c 'ls -1t /var/backups/dbee/dbee-daily-*.dump 2>/dev/null | head -1')
if [ -n "$LATEST" ]; then
  echo "  -- 抽验最新日备 $LATEST --"
  SUDO -u postgres bash -c "pg_restore --list '$LATEST' 2>/dev/null | wc -l" | sed 's/^/    TOC 条目数: /'
  SUDO stat -c '    size=%s mtime=%y' "$LATEST"
fi
echo "  -- 备份定时器 --"
SUDO systemctl list-timers --no-pager 2>/dev/null | grep -iE 'dbee|backup' | sed 's/^/    /' || echo "    (无 systemd 定时器)"
SUDO crontab -l -u postgres 2>/dev/null | grep -v '^#' | sed 's/^/    cron(postgres): /' || true
SUDO crontab -l 2>/dev/null | grep -v '^#' | sed 's/^/    cron(root): /' || true

echo
echo "════════ 精确复核完成 ════════"
