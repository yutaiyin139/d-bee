#!/usr/bin/env bash
# 只读巡检：查线上数据面真实状态（nginx 上游 / 网关 / PostgREST / PG / 各端来源）
# ⚠️ 本脚本**不做任何修改**，只读取与打印。
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ 1. nginx 站点配置：/.cloud/ 上游指向谁 ══════════"
for f in /etc/nginx/sites-enabled/*; do
  [ -f "$f" ] || continue
  echo "--- $f ---"
  SUDO grep -nE "server_name|location /|proxy_pass|upstream|proxy_buffering" "$f" | head -40
done

echo
echo "══════════ 2. upstream 定义 ══════════"
SUDO grep -rnE "upstream |server .*:443|server 127.0.0.1" /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null | head -20

echo
echo "══════════ 3. systemd 服务状态 ══════════"
for svc in dbee-gateway dbee-postgrest postgresql nginx; do
  printf '%-20s ' "$svc:"
  systemctl is-active "$svc" 2>/dev/null || echo "(查询失败)"
done

echo
echo "══════════ 4. 网关进程与监听端口 ══════════"
SUDO ss -ltnp 2>/dev/null | grep -E "8080|3001|5432|:80 |:443" | head -12

echo
echo "══════════ 5. 网关配置：连的是哪个库 ══════════"
SUDO cat /etc/dbee/gateway.env 2>/dev/null | grep -vE "SECRET|PWD|PASSWORD|KEY|MASTER_CODE|TOKEN" | head -25
echo "--- 敏感项是否存在（只显键名，不显值）---"
SUDO cat /etc/dbee/gateway.env 2>/dev/null | grep -oE "^[A-Z_]+=" | head -25

echo
echo "══════════ 6. PostgREST 配置 ══════════"
SUDO cat /etc/dbee/postgrest.env 2>/dev/null | grep -vE "SECRET|JWT|PASSWORD|PWD" | head -15

echo
echo "══════════ 7. 本机 PG 库与表 ══════════"
SUDO -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY 1;" 2>/dev/null
echo "--- dbee 库表数与函数数 ---"
SUDO -u postgres psql -d dbee -tAc "SELECT 'tables='||count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null
SUDO -u postgres psql -d dbee -tAc "SELECT 'functions='||count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';" 2>/dev/null
echo "--- 关键业务表行数 ---"
SUDO -u postgres psql -d dbee -tAc "SELECT 'app_users='||count(*) FROM app_users;" 2>/dev/null
SUDO -u postgres psql -d dbee -tAc "SELECT 'profiles='||count(*) FROM profiles;" 2>/dev/null
SUDO -u postgres psql -d dbee -tAc "SELECT 'meal_logs='||count(*) FROM meal_logs;" 2>/dev/null
SUDO -u postgres psql -d dbee -tAc "SELECT 'checkins='||count(*) FROM checkins;" 2>/dev/null

echo
echo "══════════ 8. PG 监听地址与远程访问（5432 是否对外）══════════"
SUDO grep -E "^listen_addresses|^port" /etc/postgresql/*/main/postgresql.conf 2>/dev/null
SUDO grep -vE "^#|^$" /etc/postgresql/*/main/pg_hba.conf 2>/dev/null | head -12

echo
echo "══════════ 9. 防火墙状态 ══════════"
SUDO ufw status verbose 2>/dev/null | head -20

echo
echo "══════════ 10. 网关端到端自检（本机回环）══════════"
curl -s --max-time 10 http://127.0.0.1:8080/.cloud/healthz; echo
echo "--- PostgREST 本机 ---"
curl -s --max-time 10 -o /dev/null -w "postgrest http_code=%{http_code}\n" http://127.0.0.1:3001/

echo
echo "══════════ 11. 迁移记录（最近 8 条）══════════"
SUDO -u postgres psql -d dbee -tAc "SELECT id||' | '||applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 8;" 2>/dev/null || echo "(无 schema_migrations 表)"

echo
echo "══════════ 12. 备份情况 ══════════"
ls -lt /var/backups/dbee/ 2>/dev/null | head -6 || echo "(无 /var/backups/dbee)"

echo
echo "═══ 巡检结束 ═══"
