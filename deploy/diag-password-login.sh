#!/usr/bin/env bash
# 只读诊断：Web 自建库能否支撑「邮箱 + 密码」登录（审核演示账户用）。
# 背景：server/lib/auth.mjs 的 signIn 只认 verification_token，从未调用
#       identity.mjs 已实现的 verifyPassword()；findUserByIdent 的 SELECT
#       也没取 password_hash。本脚本核实数据侧现状，为修复定范围。
# 不改任何数据。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ 1) app_users 表是否有 password_hash 列 ══════════"
SUDO -u postgres psql -d dbee -tAc "
SELECT column_name || ' :: ' || data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='app_users'
ORDER BY ordinal_position;"

echo
echo "══════════ 2) 用户总数 / 按标识类型分布 / 设过密码的人数 ══════════"
SUDO -u postgres psql -d dbee -c "
SELECT
  count(*)                                            AS total_users,
  count(*) FILTER (WHERE ident_kind='email')          AS email_users,
  count(*) FILTER (WHERE ident_kind='phone')          AS phone_users,
  count(*) FILTER (WHERE password_hash IS NOT NULL)   AS with_password
FROM public.app_users;"

echo
echo "══════════ 3) 演示账户 dbeesupport@163.com 是否在自建库 ══════════"
SUDO -u postgres psql -d dbee -c "
SELECT owner_id, ident_kind, ident_masked,
       (password_hash IS NOT NULL) AS has_password,
       created_at, last_login_at
FROM public.app_users
WHERE ident_masked LIKE '%dbeesupport%' OR ident_masked LIKE '%ee***@163.com%';"

echo
echo "══════════ 4) 网关当前 env 是否配了演示账户 / 万能码 ══════════"
for f in /etc/dbee/gateway.env /opt/dbee/.env /home/ubuntu/dbee/.env /var/www/d-bee/.env; do
  [ -f "$f" ] && echo "--- $f ---" && SUDO grep -oE '^(DEMO_PHONE|DEMO_CODE|SMS_MASTER_CODE)=' "$f" 2>/dev/null
done
SUDO systemctl cat dbee-gateway 2>/dev/null | grep -oE '^(EnvironmentFile|Environment)=' | head -5

echo
echo "══════════ 5) 网关进程实际生效的 DEMO_* 变量（只看是否设置，不打印值） ══════════"
PID=$(pgrep -f "gateway|server/index.mjs|node.*server" | head -1)
if [ -n "$PID" ]; then
  echo "gateway pid = $PID"
  SUDO cat "/proc/$PID/environ" 2>/dev/null | tr '\0' '\n' \
    | grep -oE '^(DEMO_PHONE|DEMO_CODE|SMS_MASTER_CODE)=' | sed 's/=$/ = 已设置/'
else
  echo "未找到网关进程"
fi
echo "══════════ 诊断结束（未修改任何数据） ══════════"
