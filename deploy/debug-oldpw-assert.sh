#!/usr/bin/env bash
# 只读调试：为什么「旧密码失效」断言失败——打印原始输出而非猜测
set -uo pipefail
SUDO_PWD='__SUDO_PWD__'
SUDO() { echo "$SUDO_PWD" | sudo -S "$@"; }
PWFILE=/etc/dbee-admin-password

echo "=== A. psql 客户端是否存在 ==="
command -v psql || echo "(psql 不在 PATH)"
psql --version 2>&1 || true

echo
echo "=== B. 密码文件当前内容指纹 + 长度 ==="
FILE_PW=$(SUDO cat "$PWFILE")
echo "    长度: ${#FILE_PW}"
echo "    指纹: $(printf '%s' "$FILE_PW" | sha256sum | cut -c1-16)"
echo "    sudo密码指纹: $(printf '%s' "$SUDO_PWD" | sha256sum | cut -c1-16)"
echo "    两者相同? $([ "$FILE_PW" = "$SUDO_PWD" ] && echo YES-事故未修 || echo NO-已修)"

echo
echo "=== C. 用【当前文件密码】登录的原始输出 ==="
PGPASSWORD="$FILE_PW" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT 'LOGIN_OK_FILE_PW';" 2>&1 | head -5
echo "    退出码: ${PIPESTATUS[0]}"

echo
echo "=== D. 用【sudo 密码】登录的原始输出（期望失败）==="
PGPASSWORD="$SUDO_PWD" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT 'LOGIN_OK_SUDO_PW';" 2>&1 | head -5
echo "    退出码: ${PIPESTATUS[0]}"

echo
echo "=== E. 用【完全错误的密码】登录的原始输出（对照组，看真实错误措辞）==="
PGPASSWORD="definitely-wrong-pw-xyz" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT 1;" 2>&1 | head -5
echo "    退出码: ${PIPESTATUS[0]}"

echo
echo "=== F. 断言措辞匹配测试（对 E 的输出做 grep -c）==="
EOUT=$(PGPASSWORD="definitely-wrong-pw-xyz" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT 1;" 2>&1 || true)
echo "    grep 'password authentication failed' 计数: $(printf '%s' "$EOUT" | grep -c 'password authentication failed' || true)"
echo "    grep 'FATAL' 计数: $(printf '%s' "$EOUT" | grep -c 'FATAL' || true)"
echo "    grep 'fe_sendauth' 计数: $(printf '%s' "$EOUT" | grep -c 'fe_sendauth' || true)"

echo
echo "=== G. 服务端 locale（错误信息可能是中文导致 grep 不中）==="
SUDO -u postgres psql -d dbee -tAc "SHOW lc_messages;" 2>/dev/null

echo
echo "=== H. pg_authid 里 dbee_admin 的密码哈希前缀（确认已改）==="
SUDO -u postgres psql -d dbee -tAc "SELECT rolname, left(rolpassword, 20) AS hash_prefix, length(rolpassword) AS len FROM pg_authid WHERE rolname='dbee_admin';" 2>/dev/null

echo "═══ 结束 ═══"
