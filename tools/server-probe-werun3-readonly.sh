#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-probe-werun3-readonly.sh · auth.mjs 导出面【精确】只读判定
#
# 🔴 纠正 server-probe-werun2-readonly.sh【3】的假阳性：
#    那段 awk 用 /^  return \{/{f=1} 开标志后，遇 /^  \}/ 才关，但生产 auth.mjs
#    的 return 块内含嵌套 } 与注释，f 未正确复位 → 把注释行(:544)与函数体内
#    调用行(:569) 误判成「在 return 导出块内」= 假阳性。
#    （正是本项目护栏纪律「断言须在 stripComments() 后做」要防的那类错误。）
#
# 本轮改用【三重独立口径】交叉判定，任一为假即判未导出：
#   口径A：剥掉注释行后，是否存在「exchangeWechatCode,」或「exchangeWechatCode:」
#          形式的导出条目（对象字面量简写/显式键）
#   口径B：export 语句里是否出现该名
#   口径C：与本地 HEAD 版对比 —— 本地应能命中（证明判定方法本身有效，防假阴性）
# 🔴 零写入：只 grep/awk/sed/sha256sum。绝不 restart/reload/deploy。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
LIB=/opt/dbee-gateway/lib

echo "【A】剥注释后找导出条目（口径A）"
echo "  生产 auth.mjs："
SUDO sed -e 's://.*::' -e 's:/\*.*\*/::g' "$LIB/auth.mjs" 2>&1 \
  | grep -nE '^\s*exchangeWechatCode\s*[,:]|^\s*exchangeWechatCode\s*$' \
  | sed 's/^/    /'
echo "    （无输出 = 未在导出对象里）"
echo "  剥注释后 exchangeWechatCode 剩余命中行（应只剩函数定义 + 内部调用）："
SUDO sed -e 's://.*::' -e 's:/\*.*\*/::g' "$LIB/auth.mjs" 2>&1 \
  | grep -n 'exchangeWechatCode' | sed 's/^/    /'

echo ""
echo "【B】export 语句判定（口径B）"
echo "  生产 auth.mjs 全部 export 行："
SUDO grep -n '^export\|^\s*export ' "$LIB/auth.mjs" 2>&1 | sed 's/^/    /'
echo "  其中含 exchangeWechatCode 的 export："
SUDO grep -n '^export.*exchangeWechatCode' "$LIB/auth.mjs" 2>&1 | sed 's/^/    /'
echo "    （无输出 = 未通过 export 导出）"

echo ""
echo "【C】生产 auth.mjs 的 return 导出块【完整】内容（人工可核）"
echo "  定位 return { 的行号："
SUDO grep -n 'return {' "$LIB/auth.mjs" 2>&1 | tail -5 | sed 's/^/    /'
echo "  最后一个 return { 起的 40 行（导出面全貌）："
LAST=$(SUDO grep -n 'return {' "$LIB/auth.mjs" 2>&1 | tail -1 | cut -d: -f1)
if [ -n "${LAST:-}" ]; then
  SUDO sed -n "${LAST},$((LAST+40))p" "$LIB/auth.mjs" 2>&1 | sed 's/^/    /'
fi

echo ""
echo "【D】指纹（与本地 HEAD 对比用）"
SUDO sha256sum "$LIB/auth.mjs" 2>&1 | sed 's/^/  生产 auth.mjs: /'
SUDO stat -c '  mtime=%y size=%s' "$LIB/auth.mjs" 2>&1 | sed 's/^/  /'
echo "  生产 app.mjs 内 werun 相关（应 0）："
echo "    grep -c werun = $(SUDO grep -c 'werun' "$LIB/app.mjs" 2>&1)"
echo "  生产 lib 是否存在 werun.mjs："
SUDO test -f "$LIB/werun.mjs" && echo "    存在" || echo "    🔴 不存在"

echo ""
echo "【只读精确判定完成 · 零写入】"
