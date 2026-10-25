#!/usr/bin/env bash
# 只读清点：/tmp 下含敏感内容的残留文件（不删除，仅列清单+判定）
# 注意：本脚本刻意不含任何会被 dbee-ssh.py 渲染的占位符于 echo 文本中。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }

echo "═══ /tmp 敏感残留清点 · $(date '+%F %T') ═══"
echo
echo "── A) dbee 部署脚本残留（渲染后含明文 sudo 密码）──"
printf '  %-34s %-6s %-14s %s\n' "文件" "权限" "属主" "mtime"
for f in /tmp/dbee-*.sh; do
  [ -e "$f" ] || { echo "  (无)"; break; }
  SUDO stat -c '  %-34n %-6a %-14U:%G %y' "$f" 2>/dev/null
done

echo
echo "── B) env / 配置类残留 ──"
for f in /tmp/gateway.env.new /tmp/gateway.env.in /tmp/*.env /tmp/dbee-nginx.conf /tmp/dbee-migration-manifest.tsv /tmp/*.sql; do
  [ -e "$f" ] || continue
  SUDO stat -c '  %-34n %-6a %-14U:%G %y' "$f" 2>/dev/null
done

echo
echo "── C) 世界可读判定（🔴 = 任意本地用户可读）──"
SUDO bash -c '
for f in /tmp/dbee-*.sh /tmp/gateway.env.new /tmp/*.env /tmp/*.sql /tmp/dbee-nginx.conf /tmp/dbee-migration-manifest.tsv; do
  [ -e "$f" ] || continue
  m=$(stat -c "%a" "$f")
  other=${m: -1}
  case "$other" in
    0|1|2|3) flag="✓ 仅属主可读" ;;
    *)       flag="🔴 其他用户可读" ;;
  esac
  printf "  %-34s mode=%s  %s\n" "$f" "$m" "$flag"
done'

echo
echo "── D) /tmp 总体情况 ──"
echo "  文件总数: $(ls -1 /tmp 2>/dev/null | wc -l)"
echo "  挂载选项（noexec/nosuid 可减缓利用）:"
mount | grep -E ' /tmp ' | sed 's/^/    /' || echo "    /tmp 未独立挂载（随根分区，无 noexec）"

echo
echo "── E) systemd 私有 tmp 目录（网关的 PrivateTmp 是否生效）──"
SUDO ls -d /tmp/systemd-private-*-dbee-gateway.service-* 2>/dev/null | sed 's/^/    /' || echo "    (无 → 网关未启用 PrivateTmp)"
SUDO grep -E "^(PrivateTmp|ProtectSystem|ProtectHome|NoNewPrivileges|User|Group)=" /etc/systemd/system/dbee-gateway.service 2>/dev/null | sed 's/^/    unit: /'

echo
echo "═══ 清点完成（未做任何删除）═══"
