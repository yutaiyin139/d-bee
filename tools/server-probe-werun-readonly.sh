#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-probe-werun-readonly.sh · 微信运动（WX-1）生产部署面【纯只读】取证
#
# 目的：判定「mini 端按提示设置后仍无法同步微信运动」的服务端断点。
# 🔴 本脚本零写入：只 ls / grep / sha256sum / SELECT，不 restart、不 reload、
#    不 deploy、不改任何文件。绝不触碰 deploy-gateway.sh（全站锁死级地雷）。
# 由 dbee-ssh.py run 调用（sudo 密码占位符由执行器注入）。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

GW=/opt/dbee-gateway
LIB=$GW/lib

echo "【1】网关 lib 目录清单（判定 werun.mjs 是否在场）"
SUDO ls -la --time-style=long-iso "$LIB" 2>&1 | sed 's/^/  /'

echo ""
echo "【2】werun.mjs 在场性（存在才可能注册路由）"
if SUDO test -f "$LIB/werun.mjs"; then
  echo "  ✅ werun.mjs 存在"
  SUDO sha256sum "$LIB/werun.mjs" 2>&1 | sed 's/^/  /'
else
  echo "  🔴 werun.mjs 不存在 → 服务端解密能力完全缺失"
fi

echo ""
echo "【3】app.mjs 是否注册 werun 路由（import + router.on 两处）"
if SUDO test -f "$LIB/app.mjs"; then
  echo "  app.mjs sha256 / mtime:"
  SUDO sha256sum "$LIB/app.mjs" 2>&1 | sed 's/^/    /'
  SUDO stat -c '    mtime=%y size=%s' "$LIB/app.mjs" 2>&1 | sed 's/^/    /'
  echo "  grep werun 命中数: $(SUDO grep -c 'werun' "$LIB/app.mjs" 2>&1)"
  SUDO grep -n 'werun' "$LIB/app.mjs" 2>&1 | sed 's/^/    /'
else
  echo "  🔴 app.mjs 不存在"
fi

echo ""
echo "【4】auth.mjs 是否导出 exchangeWechatCode（werun.mjs 的硬依赖）"
if SUDO test -f "$LIB/auth.mjs"; then
  SUDO stat -c '  auth.mjs mtime=%y size=%s' "$LIB/auth.mjs" 2>&1 | sed 's/^/  /'
  echo "  exchangeWechatCode 命中数: $(SUDO grep -c 'exchangeWechatCode' "$LIB/auth.mjs" 2>&1)"
  echo "  return 块内导出命中（判定是否真导出）:"
  SUDO grep -n 'exchangeWechatCode' "$LIB/auth.mjs" 2>&1 | sed 's/^/    /'
else
  echo "  🔴 auth.mjs 不存在"
fi

echo ""
echo "【5】网关服务状态（只读，不 restart）"
SUDO systemctl is-active dbee-gateway 2>&1 | sed 's/^/  is-active: /'
SUDO systemctl show dbee-gateway -p NRestarts -p ActiveEnterTimestamp 2>&1 | sed 's/^/  /'

echo ""
echo "【6】0053-health-vendor 迁移是否已应用（health_vendor 列 = 防跨端串台）"
PSQL_SU "SELECT coalesce(string_agg(version, ', ' ORDER BY version), '(none)') FROM public.schema_migrations WHERE version LIKE '005%';" 2>&1 | sed 's/^/  已应用 005x: /'
PSQL_SU "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';" 2>&1 | sed 's/^/  profiles.health_vendor 列存在(1=是): /'

echo ""
echo "【7】config.mjs 是否已解析 wechatMiniSecrets（werun 解密所需，0 新增 env）"
if SUDO test -f "$LIB/config.mjs"; then
  SUDO stat -c '  config.mjs mtime=%y' "$LIB/config.mjs" 2>&1 | sed 's/^/  /'
  echo "  wechatMiniSecrets 命中数: $(SUDO grep -c 'wechatMiniSecrets' "$LIB/config.mjs" 2>&1)"
fi
echo "  gateway.env 中 WECHAT_MINI_SECRETS 是否已配置（只判有无，不打印值）"
if SUDO test -f "$GW/gateway.env"; then
  SUDO grep -q '^WECHAT_MINI_SECRETS=..' "$GW/gateway.env" 2>&1 && echo "  ✅ 已配置" || echo "  🔴 未配置或为空"
  echo "  gateway.env sha256（部署前后必须不变的基线）:"
  SUDO sha256sum "$GW/gateway.env" 2>&1 | sed 's/^/    /'
else
  echo "  🔴 gateway.env 不存在"
fi

echo ""
echo "【8】网关日志中 werun 相关记录（近 500 行，判定是否曾被调用）"
SUDO journalctl -u dbee-gateway -n 500 --no-pager 2>&1 | grep -i 'werun' | tail -10 | sed 's/^/  /'
echo "  （空 = 从未有 werun 请求到达网关，或网关无此路由）"

echo ""
echo "【只读取证完成 · 零写入】"
