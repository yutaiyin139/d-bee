#!/usr/bin/env bash
# 上传 D-Bee 小程序新版本到微信后台（生成「开发版」，不影响线上正式版）。
#
# 🔴 前置（只能用户本人在 GUI 完成，脚本无法代做）：
#   微信开发者工具 → 设置 → 安全设置 → **服务端口：开启**，且工具已登录对应小程序账号。
#   否则 CLI 报 `IDE service port disabled`。另一条通道是 miniprogram-ci + 上传密钥，
#   本项目未配置密钥（需公众平台下载 private.key 并配 IP 白名单），故未接入本脚本。
#
# 用法（Git Bash）：
#   bash deploy/upload-mini.sh 1.0.1 "云库彻底废弃：四端统一自托管 d-bee.cn"
#   版本号必须 **大于微信公众平台「版本管理」里当前的线上/开发版版本**，以该页为准。
#
# 上传只是第 1 步；之后仍需：设为体验版 → 真机全链路验收 → 提交审核 → 发布。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MINI="$ROOT/mini"
CLI="/c/Program Files (x86)/Tencent/微信web开发者工具/cli.bat"
VERSION="${1:-}"
DESC="${2:-云库彻底废弃：四端统一自托管 d-bee.cn}"

fail() { echo "❌ $*" >&2; exit 1; }

[ -n "$VERSION" ] || fail "缺少版本号。用法：bash deploy/upload-mini.sh <版本号> [备注]；版本号须大于公众平台「版本管理」当前版本。"
[ -f "$CLI" ] || fail "未找到微信开发者工具 CLI：$CLI"
[ -f "$MINI/dist/common.js" ] || fail "mini/dist/ 未构建，先跑：cd mini && npm run build:weapp"

# 🔴 发版前护栏：产物必须零云端域名、且确实指向自建库（铁律 #13：本地绿≠线上绿）
HITS="$(grep -rl 'workbuddy.host\|zilv-mifeng.app\|www.workbuddy.cn' "$MINI/dist/" 2>/dev/null | wc -l)"
[ "$HITS" -eq 0 ] || fail "产物里仍有 $HITS 个文件含云端/平台域名，禁止上传。先排查构建配置。"
grep -rq 'd-bee.cn' "$MINI/dist/" || fail "产物里找不到 d-bee.cn，endpoint 可能被改错，禁止上传。"

echo "=== 前置检查通过：产物零云端域名、endpoint = d-bee.cn ==="
echo "=== 校验开发者工具登录态 ==="
"$CLI" islogin 2>&1 | tail -5 || true

echo "=== 上传：版本 $VERSION ==="
"$CLI" upload --project "$MINI" --version "$VERSION" --desc "$DESC"

echo
echo "=== 上传完成后的剩余步骤（本脚本不做，避免越权发版）==="
echo "1. 微信公众平台 → 版本管理 → 把刚上传的版本【设为体验版】"
echo "2. 真机全链路：微信登录 → 记一餐 → 蜂蜜余额 → 排行榜 → 兑换码 → 账号注销(0045)"
echo "   🔴 验收要点：不再报 url not in domain list；数据落在自建 PG（healthz 指向 dbee）"
echo "3. 真机通过后，再【提交审核 → 发布】；备案审核期间能否提交审核须在公众平台确认"
echo "4. 线上全量切到新版、T+7 观察无异常后，才停用云库实例（不可逆）"
