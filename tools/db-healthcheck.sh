#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 服务器本机镜像库 dbee · 纯只读体检
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/dbee-ssh.py run 调用，__SUDO_PWD__ 会被替换成 SSH 密码。
# ⚠️ 全程只读：只 SELECT / 查系统目录 / systemctl status，绝不 INSERT/UPDATE/
#    DDL/改配置。可安全在任意时刻重复执行。
# 用途：回答「本地（服务器本机镜像）数据库可用了吗」——逐项核对服务、连通、
#       结构完整度、RLS、角色、数据量，给出可/不可用的明确结论。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail   # 刻意不加 -e：体检要「尽量多报」，单项失败不该中断整体

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }

# dbee_app 的连接串。密码**不硬编码**（避免把秘密再抄一份进 git）：
# 运行时从服务器上的 /opt/dbee-db/CREDENTIALS.txt（root:ubuntu 640）读取，
# 或用环境变量 DBEE_APP_PWD 覆盖。读不到就留空 —— 那样连接会如实失败并报 ✗，
# 正好暴露「密码失配」这类问题，而不是被一个写死的旧密码掩盖。
APP_PWD="${DBEE_APP_PWD:-}"
if [ -z "$APP_PWD" ] && [ -r /opt/dbee-db/CREDENTIALS.txt ]; then
  APP_PWD="$(grep -iE '^password' /opt/dbee-db/CREDENTIALS.txt | head -1 | awk '{print $2}')"
fi
PSQL_APP="PGPASSWORD='$APP_PWD' psql -h 127.0.0.1 -U dbee_app -d dbee -tA"
# postgres 超级用户（查系统目录 / 需要绕过 RLS 看真实行数时用）
PSQL_SU() { SUDO -u postgres psql -d dbee -tA "$@"; }

echo "═══════════════════════════════════════════"
echo " dbee 本机镜像库 · 只读体检  $(date '+%F %T %Z')"
echo "═══════════════════════════════════════════"

# ── 1) PostgreSQL 服务状态 ────────────────────────────────────────────
echo
echo "── 1) PostgreSQL 服务 ──"
PGUNIT="$(systemctl list-units --type=service --all --no-legend 2>/dev/null | grep -oE 'postgresql@[0-9]+-main\.service' | head -1)"
PGUNIT="${PGUNIT:-postgresql.service}"
STATE="$(systemctl is-active "$PGUNIT" 2>/dev/null || echo unknown)"
ENABLED="$(systemctl is-enabled "$PGUNIT" 2>/dev/null || echo unknown)"
echo "  单元: $PGUNIT   active=$STATE   enabled=$ENABLED"
VER="$(PSQL_SU -c 'SHOW server_version;' 2>/dev/null | head -1)"
echo "  版本: ${VER:-<取不到>}"
LISTEN="$(SUDO ss -tlnp 2>/dev/null | grep ':5432' | head -1 || echo '')"
echo "  监听: ${LISTEN:-<未见 5432>}"

# ── 2) 库连通性（两种角色分别试）────────────────────────────────────
echo
echo "── 2) 连通性 ──"
if eval "$PSQL_APP -c 'SELECT 1' >/dev/null 2>&1"; then
  echo "  ✓ dbee_app 可连（TCP + scram，与应用/网关一致）"
else
  echo "  ✗ dbee_app 连不上（检查密码 / pg_hba / 服务）"
fi
SU_CUR="$(PSQL_SU -c 'SELECT current_user;' 2>/dev/null | head -1)"
if [ -n "$SU_CUR" ]; then echo "  ✓ postgres 超级用户可连（current_user=$SU_CUR）"; else echo "  ✗ postgres 连不上"; fi

# ── 3) 结构完整度：表清单 + 每张表行数（超级用户绕过 RLS 看真实量）──────
echo
echo "── 3) 业务表与行数（真实值，绕 RLS）──"
PSQL_SU -F' | ' -c "
  SELECT c.relname AS 表, 
         (xpath('/row/cnt/text()',
            query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint AS 行数
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
  ORDER BY c.relname;" 2>/dev/null || echo "  <行数统计失败>"

# ── 4) RLS 是否全开（安全基线）──────────────────────────────────────
echo
echo "── 4) RLS 状态 ──"
PSQL_SU -F' | ' -c "
  SELECT c.relname AS 表, c.relrowsecurity AS rls开, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
  ORDER BY c.relname;" 2>/dev/null || echo "  <RLS 查询失败>"

# ── 5) 角色清单（关键：dbee_web 是否已由 0032 建出）───────────────────
echo
echo "── 5) 角色 ──"
PSQL_SU -F' | ' -c "
  SELECT rolname, rolcanlogin AS 可登录, rolinherit AS 继承, rolsuper AS 超级
  FROM pg_roles
  WHERE rolname IN ('dbee_app','dbee_gateway','dbee_web','anon','authenticated')
  ORDER BY rolname;" 2>/dev/null || echo "  <角色查询失败>"

# ── 6) 迁移落点探针：几个代表性对象是否存在 ─────────────────────────
echo
echo "── 6) 关键对象存在性（推断迁移进度）──"
check_obj() {  # $1=描述  $2=SQL(返回 0/1)
  local r; r="$(PSQL_SU -c "$2" 2>/dev/null | head -1)"
  echo "  $([ "$r" = "1" ] && echo '✓' || echo '✗') $1"
}
check_obj "app_users 表（0031 身份表）"        "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='app_users';"
check_obj "consume_ai_quota 函数（0003）"      "SELECT count(*)::int FROM pg_proc WHERE proname='consume_ai_quota';"
check_obj "auth.uid() 函数（0030 镜像）"       "SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='auth' AND p.proname='uid';"
check_obj "payment_orders 表（0021）"          "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='payment_orders';"
check_obj "leaderboard 相关（0028）"           "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE '%leaderboard%';"
check_obj "dbee_web 角色（0032，PostgREST）"   "SELECT count(*)::int FROM pg_roles WHERE rolname='dbee_web';"

# ── 7) 磁盘余量（PG 数据目录所在分区）──────────────────────────────
echo
echo "── 7) 磁盘 ──"
PGDATA_DIR="$(PSQL_SU -c 'SHOW data_directory;' 2>/dev/null | head -1)"
df -h "${PGDATA_DIR:-/var/lib/postgresql}" 2>/dev/null | tail -1 | awk '{print "  "$6": 已用 "$3" / 共 "$2" ("$5" 使用率)"}'

echo
echo "═══════════════════════════════════════════"
echo " 体检完成（未做任何写操作）"
echo "═══════════════════════════════════════════"
