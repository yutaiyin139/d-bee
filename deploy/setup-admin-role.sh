#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# setup-admin-role.sh · 在服务器上创建 dbee_admin 只读排查角色（配套 0041）
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/dbee-ssh.py run 执行（SUDO 密码占位符已由执行器替换）。
# 步骤：① 迁移文件须已由调用方上传到 /tmp/0041-admin-readonly-role.sql
#       ② 随机生成密码（已有 /etc/dbee-admin-password 则复用，幂等）
#       ③ psql 应用迁移 ④ ALTER ROLE 设密码 ⑤ pg_hba 追加办公网段放行
#       ⑥ reload ⑦ 全套验证断言 ⑧ 最后打印密码一次（供调用方存 .env）
# 安全：密码只落 /etc/dbee-admin-password（0600 root）与本次 stdout；
#       绝不出现在仓库任何文件中。pg_hba 只加与 dbee_app 相同的既有办公网段。
set -euo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@"; }

MIG=/tmp/0041-admin-readonly-role.sql
PWFILE=/etc/dbee-admin-password
HBA=$(SUDO -u postgres psql -tAc "SHOW hba_file;" 2>/dev/null | tr -d ' ')
# 与 pg_hba 既有 dbee_app 行完全相同的办公网段（不新增暴露面）
CIDR1="114.254.3.0/24"
CIDR2="114.246.239.129/32"

echo "=== ① 检查迁移文件 ==="
[ -f "$MIG" ] || { echo "!! 缺少 $MIG（调用方须先 putfile 上传）"; exit 1; }

echo "=== ② 密码（已有则复用，保证幂等重跑不改密码）==="
if SUDO test -f "$PWFILE"; then
  echo "    复用既有密码文件 $PWFILE"
else
  ADMIN_PW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
  # ⚠️ 绝不能写 `echo "$ADMIN_PW" | SUDO tee "$PWFILE"`：SUDO 函数内部的
  # `echo 密码 |` 接管 stdin，tee 写进文件的是 **sudo 密码**（2026-10-26 实测事故，
  # 已由 rotate-admin-password.sh 轮转修复）。统一用 sudo bash -c 重定向写。
  SUDO bash -c "umask 077; printf '%s\n' '$ADMIN_PW' > '$PWFILE'; chown root:root '$PWFILE'; chmod 600 '$PWFILE'"
  echo "    已生成新密码 -> $PWFILE (0600 root)"
fi
ADMIN_PW=$(SUDO cat "$PWFILE")

echo "=== ③ 应用迁移 0041 ==="
# /tmp 原件是 putfile 落的 0600 ubuntu 属主，postgres 读不了；
# 必须 cp 到 /opt/dbee-db 后执行**副本**（历史踩坑：psql -f 误指 /tmp 原件 → Permission denied）
SUDO mkdir -p /opt/dbee-db
SUDO cp "$MIG" /opt/dbee-db/0041-admin-readonly-role.sql
SUDO chmod 644 /opt/dbee-db/0041-admin-readonly-role.sql
SUDO -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/0041-admin-readonly-role.sql

echo "=== ④ 设置角色密码 ==="
SUDO -u postgres psql -d dbee -qAc "ALTER ROLE dbee_admin PASSWORD '$ADMIN_PW';"
echo "    密码已设置（不回显）"

echo "=== ⑤ pg_hba 追加放行（幂等：已存在则跳过）==="
SUDO cp "$HBA" "${HBA}.bak-$(date +%Y%m%d%H%M%S)"
# 清理历史事故行：上一版脚本 `echo line | SUDO tee -a` 中 SUDO 内部的密码 echo
# 接管了 stdin，可能把非 pg_hba 格式的行（含敏感串）误写入。
# 合法 pg_hba 行必以 local/host/hostssl/hostnossl 开头，其余一律剔除。
SUDO bash -c "grep -E '^(local|host|hostssl|hostnossl)([[:space:]]|$)' '$HBA' > '${HBA}.clean' && mv '${HBA}.clean' '$HBA' && chmod 640 '$HBA' && chown root:postgres '$HBA'"
for CIDR in "$CIDR1" "$CIDR2"; do
  if SUDO grep -q "dbee_admin.*$CIDR" "$HBA"; then
    echo "    已有: $CIDR（跳过）"
  else
    # ⚠️ 不能写 `echo line | SUDO tee -a`：SUDO 函数内部的 `echo 密码 |` 会接管
    # stdin，tee 收到的是密码而非要追加的行（已实测踩坑）。
    # 改用 sudo bash -c 重定向追加。
    LINE="host    dbee            dbee_admin        ${CIDR}            scram-sha-256"
    SUDO bash -c "printf '%s\n' '$LINE' >> '$HBA'"
    echo "    追加: $CIDR"
  fi
done

echo "=== ⑥ reload（不 restart，连接不断）==="
SUDO -u postgres psql -qAc "SELECT pg_reload_conf();"

echo "=== ⑦ 验证断言 ==="
FAIL=0
assert() { # assert <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1（期望 $2 实际 $3）"; FAIL=1; fi
}

A1=$(SUDO -u postgres psql -d dbee -tAc "
  SELECT rolcanlogin||'/'||rolbypassrls||'/'||rolsuper||'/'||rolconnlimit
  FROM pg_roles WHERE rolname='dbee_admin';")
# 布尔经文本拼接输出 true/false 全称（非 t/f，已实测）
assert "角色属性 login/bypassrls/super/connlimit" "true/true/false/5" "$A1"

A2=$(PGPASSWORD="$ADMIN_PW" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT count(*) FROM profiles;" 2>/dev/null || echo ERR)
A2S=$(SUDO -u postgres psql -d dbee -tAc "SELECT count(*) FROM profiles;")
assert "dbee_admin 本机登录可见 profiles 全量（BYPASSRLS 生效）" "$A2S" "$A2"

# ⚠️ 拒绝类断言用 grep -q（存在性），不用 grep -c 比次数：
#   psql 可能把同一错误打印多遍，计数比对会误报（rotate 脚本已实测踩坑）。
A3=$(PGPASSWORD="$ADMIN_PW" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "INSERT INTO profiles(owner_id) VALUES ('__probe__');" 2>&1 || true)
if printf '%s' "$A3" | grep -q "permission denied"; then echo "  ✓ 写断言：INSERT 被拒（permission denied）"; else echo "  ✗ 写断言：INSERT 未被拒"; printf '%s\n' "$A3" | head -3; FAIL=1; fi

A4=$(PGPASSWORD="$ADMIN_PW" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT grant_honey('x','y',1,1);" 2>&1 || true)
if printf '%s' "$A4" | grep -q "permission denied"; then echo "  ✓ 写断言：SECURITY DEFINER 函数 grant_honey 不可执行"; else echo "  ✗ 写断言：grant_honey 竟然可执行"; printf '%s\n' "$A4" | head -3; FAIL=1; fi

A5=$(PGPASSWORD="$ADMIN_PW" psql -h 127.0.0.1 -U dbee_admin -d dbee -tAc "SELECT count(*) FROM app_users;" 2>/dev/null || echo ERR)
assert "强制 RLS 表 app_users 也可见（3 行）" "3" "$A5"

A6=$(SUDO grep -c "dbee_admin" "$HBA" || true)   # grep -c 计数为 0 时退出码 1，须 || true 防 set -e 中断
assert "pg_hba 含 2 条 dbee_admin 放行" "2" "$A6"

echo "--- pg_hba 最终 dbee 相关行（确认无格式污染）---"
SUDO grep -nE "dbee|^(local|host)" "$HBA" | tail -12
echo "--- pg_hba 非标准格式行残留检查（应为 0，>0 说明历史 tee-stdin 事故行仍在）---"
SUDO bash -c "grep -cvE '^(local|host|hostssl|hostnossl)([[:space:]]|\$)' '$HBA' || true"

echo
if [ "$FAIL" = 0 ]; then
  echo "=== ⑧ 全部通过。连接信息（密码仅此一次回显，请立即存入本地 .env）==="
  echo "    Host=150.158.51.106 Port=5432 DB=dbee User=dbee_admin"
  echo "    Password=$ADMIN_PW"
else
  echo "!! 有断言失败，请检查上方 ✗ 项（回滚段见迁移文件尾部）"
  exit 1
fi
