#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-probe-werun2-readonly.sh · 微信运动生产部署面【纯只读】补充取证
#
# 修正 server-probe-werun-readonly.sh 的一处假阴性：
#   🔴 gateway.env 真实路径 = /etc/dbee/gateway.env（取自 deploy/
#      apply-llm-feature-walls.py:60 ENV_FILE），不是 /opt/dbee-gateway/。
#      上一轮按错误路径判定「未配置」= 假阴性，本轮改为从 systemd unit 的
#      EnvironmentFile 动态解析，避免再猜。
# 另补：auth.mjs 是否**真的导出** exchangeWechatCode（werun.mjs 硬依赖）。
#      只 grep 函数名会假阳性 —— 生产版可能只是内部函数（规划文档 D12）。
#      判定口径：必须在 return { ... } 导出块内出现，才算可被 deps.auth 调用。
# 另补：0053 迁移缺失的精确状态（schema_migrations 全量 + 列/约束/注释）。
# 🔴 零写入：只 ls/grep/sha256sum/systemctl cat/SELECT。绝不 restart/reload/deploy。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

GW=/opt/dbee-gateway
LIB=$GW/lib

echo "【1】systemd EnvironmentFile 动态解析（不再猜路径）"
ENVF=$(SUDO systemctl cat dbee-gateway 2>&1 | grep -oP '^EnvironmentFile=\K.*' | head -1 | tr -d '-')
echo "  EnvironmentFile = ${ENVF:-<未找到>}"
SUDO systemctl cat dbee-gateway 2>&1 | grep -E '^(ExecStart|WorkingDirectory|User)=' | sed 's/^/  /'

echo ""
echo "【2】WECHAT_MINI_SECRETS 是否已配置（只判有无，绝不打印值）"
if [ -n "${ENVF:-}" ] && SUDO test -f "$ENVF"; then
  echo "  文件存在: $ENVF"
  SUDO stat -c '  mtime=%y size=%s' "$ENVF" 2>&1 | sed 's/^/  /'
  echo "  sha256（部署前后必须不变的基线）:"
  SUDO sha256sum "$ENVF" 2>&1 | sed 's/^/    /'
  # 只输出「有无 + 值长度」，绝不输出值本身
  SUDO awk -F= '/^WECHAT_MINI_SECRETS=/{print "  ✅ WECHAT_MINI_SECRETS 已配置，值长度=" length($2) " 字符"}' "$ENVF" 2>&1 | sed 's/^/  /'
  N=$(SUDO grep -c '^WECHAT_MINI_SECRETS=..' "$ENVF" 2>&1)
  echo "  非空命中数: ${N:-0}"
  echo "  该文件中与微信相关的键名（只列键，不列值）:"
  SUDO grep -oE '^[A-Z_]*WECHAT[A-Z_]*=' "$ENVF" 2>&1 | sed 's/^/    /'
else
  echo "  🔴 EnvironmentFile 未找到或文件不存在"
fi

echo ""
echo "【3】auth.mjs 是否【真的导出】exchangeWechatCode（硬依赖判定）"
echo "  全部命中行:"
SUDO grep -n 'exchangeWechatCode' "$LIB/auth.mjs" 2>&1 | sed 's/^/    /'
echo "  return 导出块定位（判定它是否在导出面里）:"
# 导出块特征：return { ... } 内以「键名,」或「键名:」形式出现
SUDO awk '/^  return \{/{f=1} f&&/exchangeWechatCode/{print "    ✅ 在 return 导出块内: " NR": "$0} /^  \}/{if(f)f=0}' "$LIB/auth.mjs" 2>&1
echo "  （若上面无 ✅ 行 → 生产 auth.mjs 只是内部函数、未导出 → werun.mjs 会在运行时抛 TypeError）"

echo ""
echo "【4】0053 迁移精确状态（health_vendor 列 / 约束 / 注释）"
echo "  schema_migrations 全量（按 version 排序）:"
PSQL_SU "SELECT version FROM public.schema_migrations ORDER BY version;" 2>&1 | tr '\n' ' ' | sed 's/^/    /'
echo ""
PSQL_SU "SELECT '0053 是否登记=' || count(*) FROM public.schema_migrations WHERE version='0053';" 2>&1 | sed 's/^/  /'
PSQL_SU "SELECT 'health_vendor 列数=' || count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='health_vendor';" 2>&1 | sed 's/^/  /'
PSQL_SU "SELECT 'check 约束数=' || count(*) FROM pg_constraint WHERE conname='profiles_health_vendor_check';" 2>&1 | sed 's/^/  /'
echo "  🔴 对照：0054/0055 已登记但 0053 未登记 → 迁移序列存在跳号（本轮发现）"

echo ""
echo "【5】profiles 表现有 health 相关列（判定旧包写什么）"
PSQL_SU "SELECT column_name || ' ' || data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name LIKE '%health%' ORDER BY column_name;" 2>&1 | sed 's/^/    /'

echo ""
echo "【6】网关 lib 文件数与 mtime 分布（判定最后一次部署时点）"
echo "  lib .mjs 文件数: $(SUDO ls -1 "$LIB"/*.mjs 2>/dev/null | wc -l)"
SUDO ls -la --time-style=long-iso "$LIB"/*.mjs 2>&1 | awk '{print "    "$6" "$7" "$9}'

echo ""
echo "【只读补充取证完成 · 零写入】"
