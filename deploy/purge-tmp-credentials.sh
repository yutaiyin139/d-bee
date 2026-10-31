#!/usr/bin/env bash
# 🔴 紧急清理：删除 /tmp 下含明文凭据的历史部署脚本残留。
# 只删 /tmp/dbee-*.sh 与本次探针产物，绝不动其他文件、绝不动 /etc 与家目录。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }

echo "═══ 清理前：列出 /tmp 下所有 dbee 相关脚本（确认目标）═══"
ls -la /tmp/dbee-*.sh /tmp/hz.txt /tmp/p1 /tmp/p2 2>/dev/null || echo "  <无>"

echo
echo "═══ 逐个 shred + 删除（先覆写再删，防磁盘残留恢复）═══"
for f in /tmp/dbee-*.sh; do
  [ -f "$f" ] || continue
  if SUDO shred -u -z -n 2 "$f" 2>/dev/null; then
    echo "  ✅ 已安全擦除 $f"
  elif rm -f "$f" 2>/dev/null || SUDO rm -f "$f"; then
    echo "  ✅ 已删除 $f（shred 不可用，退回 rm）"
  else
    echo "  ❌ 删除失败 $f"
  fi
done
for f in /tmp/hz.txt /tmp/p1 /tmp/p2; do
  [ -f "$f" ] && { rm -f "$f" 2>/dev/null && echo "  ✅ 已删除 $f"; }
done

echo
echo "═══ 清理后复查 ═══"
ls -la /tmp/dbee-*.sh 2>/dev/null && echo "  🔴 仍有残留" || echo "  ✅ /tmp 下已无 dbee-*.sh 残留"
echo
echo "═══ 全盘扫一遍还有没有别处残留明文凭据（只报文件名与命中键，不打印值）═══"
SUDO grep -rlE "SUDO_PWD='[^']+'|sshpass -p" /tmp /var/tmp /home/ubuntu /opt/dbee-gateway 2>/dev/null \
  | grep -vE '\.git/' | head -20 | sed 's/^/  命中: /' || echo "  ✅ 未发现其他残留"
echo
echo "═══ 附：这些脚本是否曾被提交进 git（本地仓库检索，只报命中数）═══"
cd /opt/dbee-gateway 2>/dev/null || cd /home/ubuntu 2>/dev/null || true
echo "  （git 历史检索在 Windows 侧本地仓库执行，此处跳过）"
echo "═══ 结束 ═══"
