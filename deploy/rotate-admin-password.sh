#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# rotate-admin-password.sh · 轮转 dbee_admin 密码（修复 2026-10-26 泄露事故）
# ═══════════════════════════════════════════════════════════════════════
# 事故：setup-admin-role.sh 第一版用 `echo "$ADMIN_PW" | SUDO tee "$PWFILE"`
#   写密码文件。SUDO 函数体是 `echo "<sudo密码>" | sudo -S "$@"`，其内部的
#   echo 抢占了管道 stdin → sudo -S 把管理员随机密码当成自己的密码读走，
#   tee 实际写入的是 sudo 密码；最终 /etc/dbee-admin-password 与 ALTER ROLE
#   设置的都是**服务器 sudo 密码本身**，并在 stdout 回显。
#   教训已固化进 setup-admin-role.sh 的注释与写法（改用 sudo bash -c 重定向）。
#
# 本脚本做三件事：
#   ① 生成真随机密码，用 sudo bash -c + umask 077 写入（不经管道 stdin）
#   ② ALTER ROLE 重设密码
#   ③ 断言新密码 ≠ sudo 密码、能用新密码真实登录、旧密码已失效、只读属性未变
# 幂等：可重复执行（每次生成新密码）。
#
# 密码纪律：sudo 密码经 SUDO_PWD 变量承载（守卫白名单形态），下文一律用
#   "$SUDO_PWD" 变量引用做指纹/失效比对，绝不在其他行写密码明文。
# 输出：最后回显新密码一次，调用方须立即存入本地 .env 的 DBEE_ADMIN_PWD
#   （.env 已 gitignore）。服务器侧唯一副本是 /etc/dbee-admin-password。
set -euo pipefail
SUDO_PWD='__SUDO_PWD__'
SUDO() { echo "$SUDO_PWD" | sudo -S "$@"; }

PWFILE=/etc/dbee-admin-password

echo "=== ① 记录旧值指纹（不回显明文，只比 sha256 前 12 位）==="
OLD_FP=$(SUDO bash -c "sha256sum '$PWFILE' 2>/dev/null | cut -c1-12" || echo "(无旧文件)")
SUDO_FP=$(printf '%s' "$SUDO_PWD" | sha256sum | cut -c1-12)
echo "    旧文件指纹: $OLD_FP"
echo "    sudo密码指纹: $SUDO_FP"
if [ "$OLD_FP" = "$SUDO_FP" ]; then
  echo "    !! 确认事故：旧文件内容 == sudo 密码，必须轮转"
fi

echo "=== ② 生成真随机密码并安全写入 ==="
NEW_PW=$(openssl rand -base64 32 | tr -d '/+=\n' | cut -c1-28)
# 关键：不用管道喂 sudo（会被内部 echo 抢占 stdin），改 sudo bash -c 内重定向
SUDO bash -c "umask 077; printf '%s\n' '$NEW_PW' > '$PWFILE'; chown root:root '$PWFILE'; chmod 600 '$PWFILE'"
echo "    已写入 $PWFILE"

echo "=== ③ 校验文件内容正确（不是 sudo 密码）==="
FILE_PW=$(SUDO cat "$PWFILE")
FAIL=0
[ "$FILE_PW" = "$NEW_PW" ] && echo "  ✓ 文件内容 == 新生成密码" || { echo "  ✗ 文件内容不符"; FAIL=1; }
[ "$FILE_PW" != "$SUDO_PWD" ] && echo "  ✓ 文件内容 ≠ sudo 密码" || { echo "  ✗ 仍是 sudo 密码"; FAIL=1; }
NEW_FP=$(printf '%s' "$FILE_PW" | sha256sum | cut -c1-12)
[ "$NEW_FP" != "$SUDO_FP" ] && echo "  ✓ 指纹比对通过（$NEW_FP ≠ $SUDO_FP）" || { echo "  ✗ 指纹相同"; FAIL=1; }

echo "=== ④ ALTER ROLE 重设数据库密码 ==="
SUDO -u postgres psql -d dbee -qAc "ALTER ROLE dbee_admin PASSWORD '$FILE_PW';"
echo "    已重设"

echo "=== ⑤ 用新密码真实登录验证（本机）==="
A=$(PGPASSWORD="$FILE_PW" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT count(*) FROM profiles;" 2>/dev/null || echo ERR)
B=$(SUDO -u postgres psql -d dbee -tAc "SELECT count(*) FROM profiles;")
[ "$A" = "$B" ] && echo "  ✓ 新密码可登录且 BYPASSRLS 生效（profiles=$A）" || { echo "  ✗ 新密码登录失败或行数不符（$A vs $B）"; FAIL=1; }

echo "=== ⑥ 旧密码（= sudo 密码）应已失效 ==="
# ⚠️ 不能用 `grep -c` 比对固定次数：psql 会把同一条认证失败**打印两遍**
#   （error: 前缀行 + 裸 FATAL 行），实测计数恒为 2（2026-10-26 踩坑）。
#   改用 grep -q 只判「是否出现失败措辞」，与出现次数解耦。
C=$(PGPASSWORD="$SUDO_PWD" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT 1;" 2>&1 || true)
if printf '%s' "$C" | grep -q "password authentication failed"; then
  echo "  ✓ 旧密码已被拒绝"
else
  echo "  ✗ 旧密码可能仍可用，立即排查。原始输出："; printf '%s\n' "$C" | head -4; FAIL=1
fi

echo "=== ⑦ 只读属性复核（轮转不该改变权限）==="
D=$(SUDO -u postgres psql -d dbee -tAc "SELECT rolcanlogin||'/'||rolbypassrls||'/'||rolsuper||'/'||rolconnlimit FROM pg_roles WHERE rolname='dbee_admin';")
[ "$D" = "true/true/false/5" ] && echo "  ✓ 角色属性正确（$D）" || { echo "  ✗ 角色属性异常（$D）"; FAIL=1; }
EOUT=$(PGPASSWORD="$FILE_PW" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "INSERT INTO profiles(owner_id) VALUES ('__probe__');" 2>&1 || true)
if printf '%s' "$EOUT" | grep -q "permission denied"; then
  echo "  ✓ 写权限仍被拒（只读未破）"
else
  echo "  ✗ 写断言失败。原始输出："; printf '%s\n' "$EOUT" | head -4; FAIL=1
fi

echo
if [ "$FAIL" = 0 ]; then
  echo "=== 全部通过。新连接信息（密码仅此一次回显，请存入本地 .env 的 DBEE_ADMIN_PWD）==="
  echo "    Host=150.158.51.106  Port=5432  DB=dbee  User=dbee_admin"
  echo "    Password=$FILE_PW"
  echo
  echo "⚠️ 善后提醒：sudo 密码曾在 stdout 回显过，虽未写进任何仓库文件，"
  echo "   仍建议择机修改服务器 ubuntu 用户密码（改后须同步更新本地 .env 的 PWD）。"
else
  echo "!! 有断言失败，请检查上方 ✗ 项"
  exit 1
fi
