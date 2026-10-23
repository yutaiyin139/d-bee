#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# install-backup.sh · 服务器端：安装 dbee 每日备份（由本地经 dbee-ssh.py run 执行）
# ═══════════════════════════════════════════════════════════════════════
# 前置：deploy/dbee-backup.sh 已上传到 /tmp/dbee-backup.sh
# 做四件事：
#   ① 安装脚本到 /usr/local/bin/dbee-backup.sh
#   ② 写 /etc/cron.d/dbee-backup（每日 03:30，root 身份）
#   ③ 立即手动跑一次首备（验证全链路）
#   ④ 恢复演练：把备份恢复到临时库 dbee_restore_test，比对行数后删库
#      —— 备份的第一性验证是「能恢复」，不是「文件存在」。
set -e
SUDO_PWD='__SUDO_PWD__'
S() { echo "$SUDO_PWD" | sudo -S "$@" 2>/dev/null; }

echo "== ① 安装备份脚本 =="
S install -m 750 -o root -g root /tmp/dbee-backup.sh /usr/local/bin/dbee-backup.sh
ls -la /usr/local/bin/dbee-backup.sh

echo "== ② 写 cron（每日 03:30） =="
S mkdir -p /var/backups/dbee
S chown root:postgres /var/backups/dbee
S chmod 770 /var/backups/dbee
# 🔴 不能写 `S tee ... <<EOF`：S() 内部是 echo 密码 | sudo，管道会把 heredoc
#   顶掉，密码本体反而被写进文件（已实测踩过）。改为先落临时文件再 cp。
CRON_TMP=$(mktemp /tmp/dbee-cron-XXXXXX)
cat > "$CRON_TMP" <<'CRON'
# dbee 库每日备份（03:30，脚本自带滚动清理：日×7 周×4 月×6）
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * root /usr/local/bin/dbee-backup.sh >> /var/log/dbee-backup.log 2>&1
CRON
S cp "$CRON_TMP" /etc/cron.d/dbee-backup
S chmod 644 /etc/cron.d/dbee-backup
rm -f "$CRON_TMP"
echo "   cron 内容（应无密码）:"
S grep -c "30 3" /etc/cron.d/dbee-backup
S grep -v "^#" /etc/cron.d/dbee-backup | head -5
S systemctl is-active cron

echo "== ③ 首备（手动触发一次） =="
S /usr/local/bin/dbee-backup.sh

echo "== ④ 恢复演练：恢复到临时库并比对行数 =="
# 备份目录是 770 root:postgres，ubuntu 本人无读权限 → 列目录也必须走 sudo
LATEST=$(S ls -1r /var/backups/dbee/ | grep '^dbee-.*\.dump$' | head -1)
[ -n "$LATEST" ] || { echo "   ✗ 找不到备份文件"; exit 1; }
LATEST=/var/backups/dbee/$LATEST
echo "   用最新备份: $LATEST"
S -u postgres dropdb --if-exists dbee_restore_test
S -u postgres createdb dbee_restore_test
S -u postgres pg_restore -d dbee_restore_test --no-owner --no-privileges "$LATEST" 2>/dev/null || echo "   (pg_restore 有个别告警，继续比对)"
echo "   == 行数比对（原库 vs 恢复库） =="
for t in profiles meal_entries water_logs honey_ledger ai_usage ai_quota_claims app_users; do
  A=$(S -u postgres psql -d dbee -tA -c "SELECT count(*) FROM public.$t;")
  B=$(S -u postgres psql -d dbee_restore_test -tA -c "SELECT count(*) FROM public.$t;")
  if [ "$A" = "$B" ]; then echo "   ✓ $t: $A = $B"; else echo "   ✗ $t: 原=$A 恢复=$B"; fi
done
S -u postgres dropdb dbee_restore_test
echo "   演练库已删除"

echo "== 备份体系就绪 =="
S ls -la /var/backups/dbee/
S tail -3 /var/log/dbee-backup.log 2>/dev/null || true
