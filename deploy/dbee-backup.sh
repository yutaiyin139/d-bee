#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# dbee-backup.sh · dbee 库每日备份（部署到 /usr/local/bin，root cron 调度）
# ═══════════════════════════════════════════════════════════════════════
# 设计要点：
#   ① pg_dump -Fc 自定义压缩格式：支持 pg_restore 并行恢复 / 选择性恢复单表，
#      比 plain SQL 小 5~10 倍（当前库 9.2 MB → dump 约 119 KB）。
#   ② 备份后立即验证：pg_restore --list 能读出 TOC = 归档未损坏；
#      再记录 sha256 供异机副本比对。**没验证过可恢复的备份不算备份。**
#   ③ 保留策略（滚动清理）：日备×7 + 周备(每周日)×4 + 月备(每月1日)×6。
#      文件名自带 daily/weekly/monthly 标记，清理按标记分组数数即可。
#   ④ 失败告警：任何一步失败 → syslog + 退出码非 0（cron MAILTO 可接邮件）。
#   ⑤ 全程只读数据库；唯一写入是备份目录。
#
# 安装（deploy/install-backup.sh 会自动做）：
#   /usr/local/bin/dbee-backup.sh          本脚本
#   /etc/cron.d/dbee-backup                每日 03:30
#   /var/backups/dbee/                     备份目录（750 root:postgres）
#
# 手动执行：sudo /usr/local/bin/dbee-backup.sh
set -euo pipefail

BACKUP_DIR=/var/backups/dbee
DB=dbee
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=6
LOG_TAG=dbee-backup

log() { logger -t "$LOG_TAG" "$*"; echo "[$(date '+%F %T')] $*"; }
die() { log "FATAL: $*"; exit 1; }

mkdir -p "$BACKUP_DIR"
# postgres 用户（pg_dump 的执行身份）必须对目录可写，否则 -f 落盘失败。
# 750 root:postgres 只给组 r-x 是不够的 —— 实测 pg_dump 直接报错退出。
chown root:postgres "$BACKUP_DIR" 2>/dev/null || true
chmod 770 "$BACKUP_DIR"

TS=$(date +%Y%m%d-%H%M%S)
DOW=$(date +%u)   # 1=周一 … 7=周日
DOM=$(date +%d)   # 01..31

# 一天可能同时命中 daily/weekly/monthly；取最高级别命名，避免同一份数据存三遍
KIND=daily
[ "$DOW" = "7" ] && KIND=weekly
[ "$DOM" = "01" ] && KIND=monthly

DEST="$BACKUP_DIR/dbee-$KIND-$TS.dump"
SUMS="$BACKUP_DIR/SHA256SUMS"

# ── 1) dump ─────────────────────────────────────────────────────────
log "开始备份 $DB -> $DEST"
sudo -u postgres pg_dump -d "$DB" -Fc -f "$DEST" || die "pg_dump 失败"
chmod 640 "$DEST"
chown root:postgres "$DEST" 2>/dev/null || true
SIZE=$(stat -c %s "$DEST")
[ "$SIZE" -gt 10240 ] || die "备份文件异常过小（${SIZE}B），疑似空库/失败"

# ── 2) 验证归档可读（TOC 条目数） ────────────────────────────────────
TOC=$(sudo -u postgres pg_restore --list "$DEST" 2>/dev/null | grep -c '^' || true)
[ "$TOC" -gt 100 ] || die "归档 TOC 仅 $TOC 条，疑似损坏"
log "归档验证通过：TOC $TOC 条目，大小 $((SIZE/1024)) KB"

# ── 3) 记录 sha256（异机副本比对用） ─────────────────────────────────
echo "$(sha256sum "$DEST" | awk '{print $1}')  $(basename "$DEST")  # $TS $KIND toc=$TOC size=$SIZE" >> "$SUMS"
chmod 640 "$SUMS"

# ── 4) 滚动清理 ─────────────────────────────────────────────────────
prune() {  # prune <kind> <keep>
  local kind="$1" keep="$2" n=0
  # 按文件名时间戳倒序（文件名含 TS，字典序即时间序），保留前 keep 个
  while IFS= read -r f; do
    n=$((n+1))
    if [ "$n" -gt "$keep" ]; then
      log "清理过期 $kind 备份: $(basename "$f")"
      rm -f "$f"
    fi
  done < <(ls -1r "$BACKUP_DIR"/dbee-"$kind"-*.dump 2>/dev/null)
}
prune daily   "$KEEP_DAILY"
prune weekly  "$KEEP_WEEKLY"
prune monthly "$KEEP_MONTHLY"
# SHA256SUMS 里已删文件的行也顺手清掉（保留文件存在的行）
if [ -f "$SUMS" ]; then
  TMP=$(mktemp)
  while read -r _hash fname _rest; do
    [ -f "$BACKUP_DIR/$fname" ] && echo "$_hash  $fname  $_rest" >> "$TMP" || true
  done < "$SUMS"
  mv "$TMP" "$SUMS"; chmod 640 "$SUMS"
fi

log "备份完成：$DEST（TOC=$TOC，$((SIZE/1024)) KB），当前存量：$(ls -1 "$BACKUP_DIR"/dbee-*.dump | wc -l) 份"
