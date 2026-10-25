#!/usr/bin/env bash
# 清理本次实测在服务器 /tmp 留下的迁移文件（一次性）
set -uo pipefail
rm -f /tmp/dbee-mig/0039-rpc-trust-boundary.sql /tmp/dbee-mig/0040-honey-balance-and-leaderboard-cache.sql
rmdir /tmp/dbee-mig 2>/dev/null || true
rm -f /tmp/_apply_out.txt /tmp/_apply_out2.txt /tmp/_mig_out.txt /tmp/_mig_out2.txt 2>/dev/null || true
echo "✓ /tmp 迁移文件已清理"
ls -la /tmp/dbee-mig 2>/dev/null || echo "  /tmp/dbee-mig 已不存在"
# 顺带确认备份仍在（回滚保险）
ls -la /var/backups/dbee/backup-before-0039-0040-*.dump 2>/dev/null | tail -2
