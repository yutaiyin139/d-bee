#!/usr/bin/env bash
# 只读：自建库最近写入时间 / 迁移版本 / 备份配置 —— 判断数据分叉程度
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ 1. 自建库各表最新写入时间（Web 端是否真在写）══════════"
SUDO -u postgres psql -d dbee -c "
SELECT 'meal_entries' t, max(created_at) latest, count(*) n FROM meal_entries
UNION ALL SELECT 'water_logs', max(created_at), count(*) FROM water_logs
UNION ALL SELECT 'exercise_logs', max(created_at), count(*) FROM exercise_logs
UNION ALL SELECT 'ai_usage', max(created_at), count(*) FROM ai_usage
UNION ALL SELECT 'honey_ledger', max(created_at), count(*) FROM honey_ledger
UNION ALL SELECT 'app_users', max(last_login_at), count(*) FROM app_users
UNION ALL SELECT 'profiles', max(updated_at), count(*) FROM profiles
ORDER BY latest DESC NULLS LAST;" 2>/dev/null

echo
echo "══════════ 2. 迁移版本清单（最新 12 条）══════════"
SUDO -u postgres psql -d dbee -c "
SELECT version, name, status, applied_at
FROM schema_migrations ORDER BY applied_at DESC LIMIT 12;" 2>/dev/null

echo
echo "══════════ 3. 备份 cron 配置与产物 ══════════"
SUDO cat /etc/cron.d/dbee-backup 2>/dev/null | grep -v "^#" | head -5
echo "--- 备份脚本关键参数 ---"
SUDO grep -nE "BACKUP_DIR|RETAIN|pg_dump|sha256|--format" /usr/local/bin/dbee-backup.sh 2>/dev/null | head -10
echo "--- 实际备份产物（含目录搜索）---"
SUDO find / -maxdepth 4 -name "*.dump" -o -maxdepth 4 -name "*dbee*.sql" 2>/dev/null | head -8
SUDO ls -lt /var/backups/dbee* /home/ubuntu/backups/* /opt/dbee/backup/* 2>/dev/null | head -10

echo
echo "══════════ 4. PostgREST 为何 systemd inactive 但进程在跑 ══════════"
SUDO ps -o pid,etime,cmd -p 3285473 2>/dev/null | head -3
echo "--- 是否有其他 unit 名 ---"
systemctl list-units --type=service --all 2>/dev/null | grep -iE "postgrest|dbee" | head -6

echo
echo "══════════ 5. 网关 LLM 配置指向（自托管 LLM 代理是否在用）══════════"
SUDO grep -E "^LLM_BASE_URL|^LLM_MODEL|^SMS_PROVIDER|^POSTGREST_URL|^DBEE_HOST|^DBEE_DB|^DBEE_SSL" /etc/dbee/gateway.env 2>/dev/null

echo
echo "══════════ 6. 云服务器出口能否访问 Apple 验签域名（IAP 前置）══════════"
curl -s -o /dev/null -w "apple verifyReceipt: %{http_code} (%{time_total}s)\n" --max-time 12 https://buy.itunes.apple.com/verifyReceipt 2>&1 || echo "不可达"
curl -s -o /dev/null -w "apple sandbox: %{http_code}\n" --max-time 12 https://sandbox.itunes.apple.com/verifyReceipt 2>&1 || echo "不可达"

echo
echo "══════════ 7. 云库是否仍可达（三端还依赖它）══════════"
curl -s -o /dev/null -w "cloud endpoint: %{http_code}\n" --max-time 12 https://zilv-mifeng.app.workbuddy.host/ 2>&1

echo
echo "═══ 结束 ═══"
