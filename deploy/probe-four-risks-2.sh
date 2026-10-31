#!/usr/bin/env bash
# 只读补充探针：A) 网关 env 实况  B) 5432 监听  D) 日志密钥命中详情
# 纪律：绝不打印密码/密钥/万能码明文，只报「是否设置 + 长度 + sha256 前 8 位」。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }
mask() { local v="${1-}"; if [ -z "$v" ]; then echo "<未设置>"; else
  printf 'len=%d sha8=%s' "${#v}" "$(printf '%s' "$v" | sha256sum | cut -c1-8)"; fi; }

echo "══════════ A) 网关 env 实况 ══════════"
ENVF=$(SUDO systemctl cat dbee-gateway 2>/dev/null | grep -oP '^EnvironmentFile=\K.*' | head -1)
echo "EnvironmentFile = ${ENVF:-<未找到>}"
echo "systemd unit 关键行："
SUDO systemctl cat dbee-gateway 2>/dev/null | grep -E '^(ExecStart|WorkingDirectory|User|Group|Environment)=' | sed 's/^/  /'
echo
for k in SMS_PROVIDER DBEE_PROD SMS_MASTER_CODE DEMO_PHONE DEMO_CODE IDENT_PEPPER JWT_SECRET \
         SMS_SIGN_NAME APPLE_ALLOWED_ENVS APPLE_BUNDLE_ID SHARED_SECRET APPLE_SANDBOX \
         CORS_ALLOWED_ORIGINS LLM_API_KEY LLM_VISION_API_KEY SMTP_PASS EMAIL_PROVIDER \
         DBEE_DB_HOST DBEE_DB_PORT DATABASE_URL PGHOST; do
  line=$(SUDO grep -E "^${k}=" "$ENVF" 2>/dev/null | head -1)
  if [ -z "$line" ]; then echo "  $k = <未设置（走代码默认值）>"; continue; fi
  v="${line#*=}"
  case "$k" in
    SMS_PROVIDER|DBEE_PROD|EMAIL_PROVIDER|SMS_SIGN_NAME|APPLE_ALLOWED_ENVS|APPLE_BUNDLE_ID|APPLE_SANDBOX|CORS_ALLOWED_ORIGINS|DBEE_DB_HOST|DBEE_DB_PORT)
      echo "  $k = ${v}   ← 非敏感" ;;
    *) echo "  $k = $(mask "$v")" ;;
  esac
done

echo
echo "── A2) env 文件里所有键名（不显示值，核对是否有多余万能码/旧凭据残留）──"
SUDO grep -oE '^[A-Z_][A-Z0-9_]*=' "$ENVF" 2>/dev/null | tr -d '=' | tr '\n' ' '; echo

echo
echo "── A3) 万能码是否真可用（静态判定，不发真实短信）──"
PROV=$(SUDO grep -E '^SMS_PROVIDER=' "$ENVF" 2>/dev/null | head -1 | cut -d= -f2-)
MC=$(SUDO grep -E '^SMS_MASTER_CODE=' "$ENVF" 2>/dev/null | head -1 | cut -d= -f2-)
echo "  SMS_PROVIDER = ${PROV:-<未设置→代码默认 log>}"
echo "  SMS_MASTER_CODE = $(mask "$MC")"
if [ "${PROV:-log}" = "log" ] && [ -n "$MC" ]; then
  echo "  🔴 判定：log 模式 + 万能码存在 → app.mjs:39 会把 masterCode 传入 OtpStore → 任何人可用该码登录任意号"
elif [ -n "$MC" ]; then
  echo "  🟡 判定：provider=${PROV}（非 log）→ app.mjs:39 传空串，万能码失效；但 env 里残留该行，且 config.validate() 会拒绝启动 → 需确认网关是否真在跑"
else
  echo "  ✅ 判定：env 无 SMS_MASTER_CODE 行 → 万能码通路不存在"
fi
echo "  网关是否在跑 + 启动时 validate 是否通过："
SUDO systemctl is-active dbee-gateway 2>/dev/null | sed 's/^/    is-active = /'
SUDO journalctl -u dbee-gateway --since "3 days ago" --no-pager 2>/dev/null \
  | grep -iE '配置校验|validate|拒绝启动|problems|listening|已启动' | tail -6 | cut -c1-200 | sed 's/^/    /'
echo "  近期日志是否打出过验证码明文（log 模式才会打）："
SUDO journalctl -u dbee-gateway --since "3 days ago" --no-pager 2>/dev/null \
  | grep -iE '验证码|sms.*code' | tail -5 | sed -E 's/[0-9]{6}/<6位掩码>/g' | cut -c1-180 | sed 's/^/    /' || echo "    <无>"

echo
echo "══════════ B) 5432 监听与连库地址 ══════════"
echo "── B1) 全部监听端口 ──"
SUDO ss -lntp 2>/dev/null | sed 's/^/  /'
echo "── B2) postgresql.conf listen_addresses ──"
SUDO -u postgres psql -tAc "show listen_addresses" 2>/dev/null | sed 's/^/  listen_addresses = /'
SUDO -u postgres psql -tAc "show port" 2>/dev/null | sed 's/^/  port = /'
PGCONF=$(SUDO -u postgres psql -tAc "show config_file" 2>/dev/null | tr -d ' ')
echo "  config_file = $PGCONF"
SUDO grep -nE '^\s*#?\s*listen_addresses' "$PGCONF" 2>/dev/null | sed 's/^/  /'
echo "── B3) 网关实际连库地址（从 healthz 与 systemd 环境推断）──"
SUDO grep -nE '^(DBEE_DB|DATABASE_URL|PG)' "$ENVF" 2>/dev/null | sed -E 's#(://[^:]*:)[^@]*@#\1<pwd>@#' | sed 's/^/  /'
echo "  PostgREST 配置："
SUDO cat /etc/dbee/postgrest.conf 2>/dev/null | sed -E 's#(://[^:]*:)[^@]*@#\1<pwd>@#' | sed 's/^/  /' || echo "  <无 /etc/dbee/postgrest.conf>"
SUDO systemctl cat dbee-postgrest 2>/dev/null | grep -E 'Environment|ExecStart' | sed -E 's#(://[^:]*:)[^@]*@#\1<pwd>@#' | sed 's/^/  /'

echo
echo "══════════ D) 日志密钥命中详情（掩码后显示）══════════"
SUDO journalctl -u dbee-gateway --since "14 days ago" --no-pager 2>/dev/null \
  | grep -inE 'IDENT_PEPPER|JWT_SECRET|LLM_API_KEY|access_key' | tail -10 \
  | sed -E 's/(=|: ?)([A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+/\1\2<已掩码>/g' | cut -c1-220 | sed 's/^/  /'

echo
echo "══════════ F) /tmp 残留脚本里的明文密码（掩码显示，确认泄露面）══════════"
for f in /tmp/dbee-31a15d53.sh /tmp/dbee-aee2a82d.sh /tmp/dbee-04fba397.sh; do
  [ -f "$f" ] || continue
  echo "  ── $f ──"
  SUDO grep -nE 'SUDO_PWD=|sudo -S' "$f" 2>/dev/null | head -4 \
    | sed -E "s/(SUDO_PWD=['\"]?)[^'\"]+/\1<明文密码已在此文件中，值不显示>/" | cut -c1-160 | sed 's/^/    /'
done
echo "══════════ 结束（全程只读）══════════"
