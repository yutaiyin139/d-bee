#!/usr/bin/env bash
# 只读调试：定位复验脚本 BAL 取值为空的原因（不吞 stderr）
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA -c "$1"; }

OWNER=$(PSQL_SU "SELECT owner_id FROM public.app_users WHERE ident_masked='186****4399' LIMIT 1;" 2>/dev/null | head -1)
echo "OWNER=[$OWNER] len=${#OWNER}"

echo "--- 原样输出（不吞 stderr）---"
PSQL_SU "SET request.jwt.claim.sub='$OWNER'; SELECT honey_balance();"
echo "--- exit=$? ---"

echo "--- 用 single statement + app.user_id ---"
PSQL_SU "SELECT set_config('app.user_id','$OWNER',false); SELECT honey_balance();"
