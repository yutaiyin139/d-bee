#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# probe-0044-parity.sh · 0044（兑换码三档）双库对齐核查 —— 只读，不改任何数据
# ═══════════════════════════════════════════════════════════════════════
# 用法：
#   python deploy/dbee-ssh.py run deploy/probe-0044-parity.sh
#   （SUDO 包装里的密码占位符由 dbee-ssh.py 在 render 阶段替换，不落盘）
#   ⚠️ 本文件**注释里也不能出现该占位符字面量**：dbee-ssh.py 的
#      assert_no_leaked_secret 会扫全文，凡占位符出现在非 sudo 调用行即拒绝上传
#      （防明文回显/落盘泄露）。2026-11-06 首版就因注释里写了它而被拦下 —— 护栏有效。
#
# 🔴 命名诚实性说明（0039 探针的教训）：
#   deploy/probe-0039-parity.sh 名字带 parity，但**只查自建库一侧**（三段标题全是
#   「自建库」），云库侧要人工另查 —— 容易让人误以为「跑完就对齐了」。
#   本脚本改为**显式两栏**：
#     §A 自建库：本脚本自动查（有 SSH + sudo）
#     §B 云库：本脚本**查不到**（无直连凭据，WorkBuddy 云库只能走 MCP），
#              故打印可直接粘贴到 MCP db_exec_sql 的只读 SQL，并要求人工回填。
#   只有 §A 与 §B 的指纹**逐项相同**才算对齐；单跑 §A 不构成对齐结论。
#
# 为什么必须双库对齐（0039 铁律）：
#   `redeem_by_code` 是权益函数。mini 端默认后端是云库
#   （mini/src/lib/backend.ts:15,47），主端 web/iOS/Android 走自建库。
#   两库不一致 = 同一张兑换码在两端行为不同（主端能兑月卡、mini 只发终身）。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }

# 🔴 本探针必须能在「0044 应用之前」也跑得通（2026-11-06 实测教训）：
#   首版 A1/A4 直接 SELECT plan / months 列，而这两列是 0044 才加的 ——
#   应用前查询直接报错，探针在最需要它的时候（打补丁前采集基线）反而不可用。
#   而 parity 探针的全部价值就在于「前 → 后」对比：只有先采到「不对齐」的基线，
#   打完补丁后再采一次显示「对齐」，才构成证据。故所有涉新列的查询都先探列是否存在。
HAS_PLAN_COL=$(SUDO -u postgres psql -d dbee -tA -c "
select count(*) from information_schema.columns
 where table_name='redeem_codes' and column_name='plan'" 2>/dev/null)
if [ "$HAS_PLAN_COL" = "1" ]; then
  LEGACY_SQL="(select (count(*) filter (where plan is distinct from 'lifetime'))::text
               from redeem_codes where used_by is null)"
  STATE="0044 已应用"
else
  LEGACY_SQL="'N/A(plan 列不存在)'"
  STATE="0044 未应用（仍是 0012 schema）"
fi

# 对齐指纹：八项特征，自建库与云库应逐项一致
FINGERPRINT_SQL="select
  'schema_plan_col='   || (select count(*)::text from information_schema.columns
                            where table_name='redeem_codes' and column_name='plan'),
  'schema_months_col=' || (select count(*)::text from information_schema.columns
                            where table_name='redeem_codes' and column_name='months'),
  'fn_result_type='    || (select coalesce(pg_get_function_result('public.redeem_by_code(text)'::regprocedure),'MISSING')),
  'fn_advisory_lock='  || (select coalesce((pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'advisory_xact_lock')::text,'MISSING')),
  'fn_make_interval='  || (select coalesce((pg_get_functiondef('public.redeem_by_code(text)'::regprocedure) ~ 'make_interval')::text,'MISSING')),
  'fn_def_len='        || (select coalesce(length(pg_get_functiondef('public.redeem_by_code(text)'::regprocedure))::text,'MISSING')),
  'force_rls='         || (select relforcerowsecurity::text from pg_class
                            where oid='public.redeem_codes'::regclass),
  'legacy_all_lifetime=' || $LEGACY_SQL"

echo "════════════════════════════════════════════════════════════"
echo " 0044 双库对齐核查 · 只读"
echo "════════════════════════════════════════════════════════════"

echo
echo "──── §A 自建库（dbee @ 生产服务器）────────────────────────"
echo "[A1] 对齐指纹（一行，逐项与 §B 比对）"
SUDO -u postgres psql -d dbee -tA -c "$FINGERPRINT_SQL" 2>/dev/null \
  || echo "  <查询失败：redeem_codes 或 redeem_by_code 不存在？>"

echo
echo "[A2] 档位列与约束定义"
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select column_name || ' : ' || data_type || ' : default=' || coalesce(column_default,'<none>')
  from information_schema.columns
 where table_name='redeem_codes' and column_name in ('plan','months')
 order by ordinal_position" 2>/dev/null
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select conname || ' -> ' || pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid='public.redeem_codes'::regclass and contype='c'
 order by conname" 2>/dev/null || echo "  <无 CHECK 约束>"

echo
echo "[A3] RLS 与隔离状态（force 必须 false，见 0044 (b) 段末）"
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select 'owner=' || pg_get_userbyid(relowner) || '  rls=' || relrowsecurity
    || '  force=' || relforcerowsecurity
  from pg_class where oid='public.redeem_codes'::regclass" 2>/dev/null
echo -n "  authenticated/anon/PUBLIC 的表权限行数（期望 0）= "
SUDO -u postgres psql -d dbee -tA -c "
select count(*) from information_schema.role_table_grants
 where table_name='redeem_codes' and grantee in ('authenticated','anon','PUBLIC')" 2>/dev/null
echo -n "  函数属主能否读到码（期望 = 库存总数，非 0）= "
SUDO -u postgres psql -d dbee -tA -c "select count(*) from redeem_codes" 2>/dev/null

echo
echo "[A4] 库存盘点（不打印码明文）"
if [ "$HAS_PLAN_COL" = "1" ]; then
  SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select coalesce(plan,'<null>') || ' / ' || coalesce(months::text,'NULL') || ' 月'
    || ' : 总数=' || count(*) || ' 已用=' || count(used_by)
  from redeem_codes group by plan, months order by 1" 2>/dev/null
else
  SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select '（plan 列尚未存在，按 0012 schema 全部视为 lifetime）'
    || ' : 总数=' || count(*) || ' 已用=' || count(used_by)
  from redeem_codes" 2>/dev/null
fi

echo
echo "[A5] 迁移登记状态"
SUDO -u postgres psql -d dbee -tA -F' | ' -c "
select version || ' | ' || name || ' | ' || status || ' | ' || coalesce(applied_at::text,'')
  from schema_migrations where version in ('0043','0044') order by version" 2>/dev/null \
  || echo "  <无 schema_migrations 表>"

echo
echo "──── §B 云库（WorkBuddy，只能走 MCP）──────────────────────"
echo "自建库当前状态：$STATE"
cat <<'MCPSQL'
本脚本**无法**直连云库（无直连凭据，WorkBuddy 云库只能走 MCP）。
请分两步采集，再把结果与 §A[A1] 那一行**逐项比对**。

── B1 先判云库有没有 plan 列（只用 information_schema，永远可跑）──

  select 'schema_plan_col=' || count(*)::text
    from information_schema.columns
   where table_name='redeem_codes' and column_name='plan';

── B2 再采指纹。🔴 按 B1 的结果二选一，不要照抄同一份 ──

【B1 = 1（云库已打 0044）】用这份完整版：

  select
    'schema_plan_col='   || (select count(*)::text from information_schema.columns
                              where table_name='redeem_codes' and column_name='plan'),
    'schema_months_col=' || (select count(*)::text from information_schema.columns
                              where table_name='redeem_codes' and column_name='months'),
    'fn_result_type='    || (select coalesce(pg_get_function_result(
                                'public.redeem_by_code(text)'::regprocedure),'MISSING')),
    'fn_advisory_lock='  || (select coalesce((pg_get_functiondef(
                                'public.redeem_by_code(text)'::regprocedure)
                                ~ 'advisory_xact_lock')::text,'MISSING')),
    'fn_make_interval='  || (select coalesce((pg_get_functiondef(
                                'public.redeem_by_code(text)'::regprocedure)
                                ~ 'make_interval')::text,'MISSING')),
    'fn_def_len='        || (select coalesce(length(pg_get_functiondef(
                                'public.redeem_by_code(text)'::regprocedure))::text,'MISSING')),
    'force_rls='         || (select relforcerowsecurity::text from pg_class
                              where oid='public.redeem_codes'::regclass),
    'legacy_all_lifetime=' || (select (count(*) filter (
                                where plan is distinct from 'lifetime'))::text
                              from redeem_codes where used_by is null);

【B1 = 0（云库还没打 0044）】把**最后一项**换成字面量再跑：

    'legacy_all_lifetime=N/A(plan 列不存在)';

  为什么必须换：PG 是**整条语句先解析**，引用不存在的列在解析期就报错，
  用 CASE / WHERE 守卫都救不了（这正是 §A 首版失败的原因）。

── 判定口径（对齐 = 八项逐项相同）──────────────────────
  schema_plan_col=1        schema_months_col=1     -> 0044 的列已补
  fn_result_type=text                              -> 返回值未被改成 JSON（前端兼容关键）
  fn_advisory_lock=true    fn_make_interval=true   -> 函数体是 0044 版而非 0012 版
  fn_def_len=<与 §A 相同>                          -> 函数体同源强指标
  force_rls=false                                  -> 未误加 FORCE（见 0044 (b) 段末）
  legacy_all_lifetime=0                            -> 存量码全部回填为 lifetime
  （B1=0 时该项为 N/A，属**未对齐**的正常表现，不是错误）

若 fn_def_len 与 §A 不同，说明两库函数体已分叉，须用
db/cloud-patch-0044/*.sql 按序（01→15）补齐后重跑本探针。
MCPSQL

echo
echo "════════════════════════════════════════════════════════════"
echo " §A 已自动采集完毕；§B 需人工经 MCP 采集后比对，未比对前不得宣称「双库对齐」"
echo "════════════════════════════════════════════════════════════"
