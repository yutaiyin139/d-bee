#!/usr/bin/env bash
# 只读：确认「网关 + PostgREST 都走回环」，即 5432 收回 localhost 不会打断任何服务。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }
ENVF=/etc/dbee/gateway.env

echo "═══ 1) 网关连库地址 ═══"
SUDO grep -nE '^(DBEE_HOST|DBEE_PORT|DBEE_DB|DBEE_USER|DBEE_SSL|POSTGREST_URL)=' "$ENVF" 2>/dev/null \
  | sed -E 's/^(DBEE_USER=).*/\1<不显示>/' | sed 's/^/  /'

echo
echo "═══ 2) PostgREST 连库地址 ═══"
for f in /etc/dbee/postgrest.config /etc/postgrest/config /opt/postgrest/config; do
  [ -f "$f" ] && { echo "  文件: $f"; SUDO grep -nE '^(db-uri|server-port|admin-server-port)' "$f" | sed -E 's#://[^@]*@#://<user:pwd>@#' | sed 's/^/    /'; }
done
SUDO find /etc /opt -maxdepth 3 -name '*postgrest*' -type f 2>/dev/null | head -5 | sed 's/^/  发现: /'

echo
echo "═══ 3) 当前谁连着 5432（客户端地址分布）═══"
SUDO ss -tnp state established 2>/dev/null | grep ':5432' | awk '{print $4, $5}' | sort | uniq -c | sort -rn | head -10 | sed 's/^/  /'
echo "  —— 上面若只出现 127.0.0.1:xxxxx 则说明无外部连接"

echo
echo "═══ 4) PG 侧按客户端 IP 统计活跃连接 ═══"
SUDO -u postgres psql -d dbee -A -F' | ' -c "select client_addr, usename, count(*) from pg_stat_activity where backend_type='client backend' group by 1,2 order by 3 desc" 2>/dev/null | sed 's/^/  /'

echo
echo "═══ 5) pg_hba 里的非回环白名单条目（收回回环后这些将失效）═══"
PGHBA=$(SUDO -u postgres psql -tAc "show hba_file" 2>/dev/null | tr -d ' ')
echo "  hba_file = $PGHBA"
SUDO grep -vE '^\s*(#|$)' "$PGHBA" 2>/dev/null | grep -vE '127\.0\.0\.1/32|::1/128|local ' | sed 's/^/  🔸 /' || echo "  <无非回环条目>"

echo
echo "═══ 6) 备份脚本是否从外部连库（install-backup / dbee-backup）═══"
SUDO grep -nE 'psql|pg_dump|PGHOST|-h ' /usr/local/bin/dbee-backup.sh /opt/dbee/backup*.sh /etc/cron.d/* 2>/dev/null | head -8 | sed 's/^/  /' || echo "  <未找到备份脚本，稍后单独确认>"
SUDO crontab -l -u ubuntu 2>/dev/null | head -5 | sed 's/^/  cron(ubuntu): /'
SUDO crontab -l 2>/dev/null | head -5 | sed 's/^/  cron(root): /'
echo "═══ 结束（只读）═══"
