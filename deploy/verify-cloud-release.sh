#!/usr/bin/env bash
# 云库彻底释放验收（纯只读）。
#
# 用途：在用户本人于 WorkBuddy 云开发环境控制台停用/删除实例之后，一键判定
#       ① 云库数据面是否真的不再响应 ② 自建库是否仍健康 ③ 四端产物是否零云库域名。
# 判据与风险说明见 docs/云库彻底释放执行单-2026-11-12.md §4。
#
# 🔴 本脚本不写、不删、不改任何文件，不触碰生产配置，不做任何停用动作。
# 用法（Git Bash）：bash deploy/verify-cloud-release.sh
# 可选：WB_PUBLISHABLE_KEY=<公开 key> bash deploy/verify-cloud-release.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

# VERIFY_CLOUD_HOST 仅供脚本自检（验证「已停」分支不会误报），正式验收不要设置。
CLOUD="${VERIFY_CLOUD_HOST:-https://zilv-mifeng.app.workbuddy.host}"
SELF="https://d-bee.cn"
# publishableKey 是公开的应用标识（前端产物里本就携带），非机密；脚本不会回显它。
KEY="${WB_PUBLISHABLE_KEY:-wbpk_w6iIU6TqTyHvJxESPTxBTy_545Abmwi5Euln5uauP5Dp18ZpMvH2P4E}"

PASS=0
FAIL=0
WARN=0
ok()   { printf '  [PASS] %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  [FAIL] %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  [WARN] %s\n' "$*"; WARN=$((WARN+1)); }

PROBE_CODE=""
PROBE_BODY=""
probe() {
  local url="$1" key="$2" out
  if [ -n "$key" ]; then
    out="$(curl -s --max-time 15 -w $'\n%{http_code}' -H "x-wb-webapp-access-key: $key" "$url" 2>/dev/null)"
  else
    out="$(curl -s --max-time 15 -w $'\n%{http_code}' "$url" 2>/dev/null)"
  fi
  PROBE_CODE="${out##*$'\n'}"
  PROBE_BODY="${out%$'\n'*}"
}

# login-wechat 只接受 POST，用 GET 探测会得到 404（路由存在但方法不匹配）→ 必须用 POST。
probe_post() {
  local url="$1" out
  out="$(curl -s --max-time 15 -X POST -H 'Content-Type: application/json' -d '{}' \
        -w $'\n%{http_code}' "$url" 2>/dev/null)"
  PROBE_CODE="${out##*$'\n'}"
  PROBE_BODY="${out%$'\n'*}"
}

echo "=============================================================="
echo " D-Bee 云库释放验收 · $(date '+%Y-%m-%d %H:%M:%S %z')"
echo " 纯只读：不写文件 / 不删除 / 不改配置"
echo "=============================================================="

# ---------------------------------------------------------------- ① 云库数据面
echo
echo "① 云库数据面是否仍在响应"
DB_PATH="/.cloud/database/rest/v1/profiles?select=id&limit=1"
probe "${CLOUD}${DB_PATH}" "$KEY"
C_CODE="$PROBE_CODE"
C_BODY="$PROBE_BODY"
probe "${CLOUD}${DB_PATH}" ""
N_CODE="$PROBE_CODE"
N_BODY="$PROBE_BODY"

printf '  带公开 key : HTTP %s | %s\n' "$C_CODE" "$(printf '%s' "$C_BODY" | head -c 120)"
printf '  无 key     : HTTP %s | %s\n' "$N_CODE" "$(printf '%s' "$N_BODY" | head -c 120)"

if printf '%s' "$C_BODY" | grep -q 'DATABASE_42501'; then
  bad "云库数据库仍在真实响应（DATABASE_42501）→ 实例尚未停用，数据面还活着"
elif [ "$C_CODE" = "000" ] || [ -z "$C_CODE" ]; then
  ok "云库域名已无法连接（DNS/连接失败）→ 实例已释放"
elif printf '%s' "$C_CODE" | grep -qE '^(404|410|403|5[0-9][0-9])$'; then
  ok "云库数据面已不可达（HTTP $C_CODE）→ 实例已停用"
else
  warn "带 key 响应 HTTP $C_CODE 且无 DATABASE_42501：数据库层已停，但平台网关仍应答"
  warn "请在控制台确认实例状态为「已停用/已删除」；仅凭本条不能判定完全释放"
fi

if printf '%s' "$N_BODY" | grep -q 'invalid_client'; then
  warn "无 key 仍返回 invalid_client（平台网关层），这不代表数据库还活着"
else
  ok "无 key 响应已不再返回 invalid_client"
fi

# ---------------------------------------------------------------- ② 自建库健康
echo
echo "② 自建库 d-bee.cn 是否仍健康"
probe "${SELF}/.cloud/healthz" ""
if [ "$PROBE_CODE" = "200" ] && printf '%s' "$PROBE_BODY" | grep -q '"db"'; then
  ok "healthz 200 且返回 db 状态（$(printf '%s' "$PROBE_BODY" | head -c 100)）"
else
  bad "healthz 异常：HTTP ${PROBE_CODE:-000} | $(printf '%s' "$PROBE_BODY" | head -c 100)"
fi

probe "${SELF}/" ""
if [ "$PROBE_CODE" = "200" ]; then
  ok "线上 Web 首页 200"
else
  bad "线上 Web 首页 HTTP ${PROBE_CODE:-000}"
fi

probe_post "${SELF}/.cloud/auth/v1/login-wechat"
if [ "$PROBE_CODE" = "404" ] || [ "$PROBE_CODE" = "405" ] || [ "$PROBE_CODE" = "000" ]; then
  bad "自建网关 login-wechat 路由不存在（POST HTTP $PROBE_CODE）"
else
  ok "自建网关 login-wechat 路由在位（POST HTTP $PROBE_CODE，空 body 非 200 属预期）"
fi

# ---------------------------------------------------------------- ③ 四端产物
echo
echo "③ 四端产物是否零云库域名（含 unicode_escape 解码）"
SCAN="$(python - <<'PY'
import io, os, re
roots = ['mini/dist', 'dist', 'android/app/src/main/assets/public', 'ios/App/App/public']
known = 'ios/App/App/public'   # 11-04 老壳内产物，已评估，见执行单 §5 B
kws = ('zilv-mifeng.app', 'workbuddy.host')
# 只解码 \uXXXX，避免 unicode_escape 对正则/路径反斜杠产生误判与告警
unesc = lambda s: re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), s)
for d in roots:
    if not os.path.isdir(d):
        print('  [WARN] %-42s 目录不存在' % d)
        continue
    fs = [os.path.join(r, f) for r, _, xs in os.walk(d) for f in xs]
    bad = []
    for p in fs:
        try:
            dec = unesc(io.open(p, encoding='utf-8', errors='replace').read())
        except Exception:
            continue
        if any(k in dec for k in kws):
            bad.append(p)
    tag = '[KNOWN]' if d == known else '[FAIL]'
    if bad:
        extra = '（已知项：endpoint 实际走 d-bee.cn，需 Mac 重打包）' if tag == '[KNOWN]' else ''
        print('  %s %-42s %d/%d 文件含云库域名%s' % (tag, d, len(bad), len(fs), extra))
        for p in bad:
            print('          ', p)
    else:
        print('  [PASS] %-42s %d 文件，零云库域名' % (d, len(fs)))
PY
)"
printf '%s\n' "$SCAN"
if printf '%s\n' "$SCAN" | grep -q '\[FAIL\]'; then
  bad "仍有产物携带云库域名（详见上方清单）"
else
  ok "mini / Web / Android 产物零云库域名"
fi
if printf '%s\n' "$SCAN" | grep -q '\[KNOWN\]'; then
  warn "iOS 壳内 11-04 老产物仍带云库字面量，属已知评估项（执行单 §5 B），不阻塞本次释放"
fi

# ---------------------------------------------------------------- 汇总
echo
echo "=============================================================="
printf ' 汇总：PASS=%d  FAIL=%d  WARN=%d\n' "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -eq 0 ]; then
  echo " 结论：✅ 云库数据面已停、自建库健康、mini/Web/Android 产物零云库域名"
  if [ "$WARN" -gt 0 ]; then
    echo " 注意：上方 $WARN 条 WARN 需人工复核（含 iOS 老产物与平台网关应答），未计入阻塞项。"
  fi
  echo " 提醒：线上 mini 包是否已换成 selfhost 版，须在微信公众平台「版本管理」确认，"
  echo "       本脚本无法探测微信服务器上的小程序包（铁律 #13）。"
else
  echo " 结论：❌ 存在未通过项，按上方 [FAIL] 逐条处理"
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ] || exit 1
