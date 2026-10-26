#!/usr/bin/env bash
# 只读：核实 dbee 库真实表名、行数分布、最近写入时间（判断 Web 端是否在写自建库）
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ dbee 库全部表名 + 行数估计 ══════════"
SUDO -u postgres psql -d dbee -c "
SELECT relname AS table_name, n_live_tup AS approx_rows
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC, relname;" 2>/dev/null

echo
echo "══════════ 关键表的真实行数与最新写入时间 ══════════"
SUDO -u postgres psql -d dbee -c "
SELECT 'profiles' t, count(*) FROM profiles
UNION ALL SELECT 'app_users', count(*) FROM app_users;" 2>/dev/null

echo "--- 探测带时间戳的业务表（自动发现列名）---"
SUDO -u postgres psql -d dbee -tAc "
SELECT table_name || ' :: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN (SELECT relname FROM pg_stat_user_tables WHERE n_live_tup > 0)
GROUP BY table_name
ORDER BY table_name;" 2>/dev/null | head -30

echo
echo "══════════ 每日备份任务核实 ══════════"
SUDO crontab -l 2>/dev/null | grep -i "backup\|pg_dump\|dbee" | head -5
ls -d /etc/cron.d/*dbee* /var/backups/* 2>/dev/null | head -5
echo "--- 备份脚本位置 ---"
ls -l /usr/local/bin/*backup* /opt/dbee/*backup* 2>/dev/null | head -5
echo "--- systemd timer ---"
systemctl list-timers --all 2>/dev/null | grep -i "dbee\|backup" | head -5

echo
echo "══════════ 网关最近写入日志（证明 Web 端在用自建库）══════════"
SUDO journalctl -u dbee-gateway --since "-2 hours" --no-pager 2>/dev/null | grep -iE "POST|insert|auth|login" | tail -12
echo "--- 日志总行数（近2小时）---"
SUDO journalctl -u dbee-gateway --since "-2 hours" --no-pager 2>/dev/null | wc -l

echo
echo "══════════ 5432 公网可达性自测（从服务器看外部视角）══════════"
SUDO ss -ltn 2>/dev/null | grep 5432
echo "--- 腾讯云安全组无法从机内查，此处仅确认监听面 ---"

echo
echo "═══ 结束 ═══"
