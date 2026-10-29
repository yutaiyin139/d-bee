#!/usr/bin/env bash
# 只读：部署前核对服务器上网关代码与仓库是否一致（防「服务器有热修未回流」被覆盖）。
# 同时记录当前文件属主/权限，供后续 install 时保持一致。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }
APP=/opt/dbee-gateway

echo "══════════ 1) 目标文件现状（属主/权限/大小/sha256 前16位） ══════════"
for f in lib/auth.mjs lib/identity.mjs lib/http.mjs lib/otp.mjs; do
  if SUDO test -f "$APP/$f"; then
    SUDO stat -c '  %n  owner=%U:%G  perm=%a  size=%s' "$APP/$f"
    echo "    sha256: $(SUDO sha256sum "$APP/$f" | cut -c1-16)"
  else
    echo "  !! $APP/$f 不存在"
  fi
done

echo
echo "══════════ 2) 服务器 signIn 当前是否已支持密码登录 ══════════"
if SUDO grep -q "signInWithPassword" "$APP/lib/auth.mjs" 2>/dev/null; then
  echo "  已包含 signInWithPassword（说明此前已部署过，本次为更新）"
else
  echo "  未包含 signInWithPassword（确认是本次要修的缺陷版本）"
fi
echo "  verifyPassword 是否被 import: $(SUDO grep -c 'verifyPassword' "$APP/lib/auth.mjs" 2>/dev/null) 处"

echo
echo "══════════ 3) 网关服务状态与代码目录整体情况 ══════════"
SUDO systemctl is-active dbee-gateway
echo "  lib/ 下 .mjs 文件数: $(SUDO find "$APP/lib" -maxdepth 1 -name '*.mjs' | wc -l)"
echo "  APP 目录属主: $(SUDO stat -c '%U:%G %a' "$APP")"

echo
echo "══════════ 4) 是否有未回流的热修（对比 mtime 是否晚于上次部署） ══════════"
SUDO ls -la --time-style=long-iso "$APP/lib/" | head -20
echo "══════════ 结束（未修改任何文件） ══════════"
