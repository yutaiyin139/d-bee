#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# migration-audit.sh · 迁移状态三类探针（服务器端执行）
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/run-migration-audit.sh 经 deploy/dbee-ssh.py run 调用。
# __SUDO_PWD__ 会被 dbee-ssh.py 替换成 SSH 密码（勿把密码写进本文件）。
#
# ⚠️ 全程只读：只 SELECT / 查系统目录。唯一的写动作是「可利用性探针」在
#    BEGIN…ROLLBACK 事务内做一次越权 INSERT 尝试，且 owner_id 用的是
#    全 0 合成值（不对应任何真实用户），事务必然回滚 —— 库里不会留下痕迹。
#
# 为什么需要这个脚本（2026-10-23 审计的教训）：
#   0016/0026/0027 三个迁移从未生效、0015 只生效一半，而没有任何机制发现它。
#   根因是「迁移状态」只存在于文件注释和 README 表格里 —— 两者都是**意图**，
#   而库里的是**事实**。本脚本直接查事实，并区分三类不同性质的问题：
#
#     ① 存在性（表/列/函数/策略/索引/约束在不在）
#        —— 查 pg_class / information_schema / pg_proc / pg_policies /
#           pg_indexes / pg_constraint。
#        ⚠️ 局限：函数是 CREATE OR REPLACE 覆盖式的，「函数在」≠「是最新版」。
#           0017/0024/0025/0026/0027 全都改的是函数体，光查存在性一律误报「已生效」。
#     ② 版本性（函数体里有没有该有的那段逻辑）
#        —— 用 pg_get_functiondef() 抓真实函数体，grep 特征串。
#           这是唯一能识别「覆盖式迁移只应用了一半」的手段。
#     ③ 可利用性（权限位 + 事务内真实越权写）
#        —— has_table_privilege() 比对「设计应有的权限矩阵」，
#           再用 BEGIN…SET ROLE authenticated…ROLLBACK 做一次真实写入尝试。
#           0015 的漏洞只有这一类探针能抓到：RLS 策略「在」、权限「有」，
#           但组合起来就是能白嫖终身会员。
#
# 退出码：全部通过 = 0；任一 ✗ = 1（部署后可直接串在流水线里当门禁）。
#
# 可选清单比对：若 /tmp/dbee-migration-manifest.tsv 存在
#   （由 run-migration-audit.sh 从本地 db/migrations/*.sql 现算并上传，
#     格式 version<TAB>name<TAB>sha256），则与库内 schema_migrations.checksum
#   比对，报「已应用的迁移文件被改动过」。文件不存在则跳过该项（不报错）。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail   # 刻意不加 -e：审计要「尽量多报」，单项失败不该中断整体

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA "$@"; }
MANIFEST=/tmp/dbee-migration-manifest.tsv

FAIL=0
fail() { FAIL=$((FAIL + 1)); }
# chk <描述> <SQL 返回 0/1 或数值> <期望值>
chk() {
  local desc="$1" sql="$2" want="${3:-1}" got
  got="$(PSQL_SU -c "$sql" 2>/dev/null | head -1)"
  if [ "$got" = "$want" ]; then
    echo "  ✓ $desc"
  else
    echo "  ✗ $desc  （实测=${got:-<取不到>}，期望=$want）"
    fail
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo " dbee · 迁移状态三类探针   $(date '+%F %T %Z')"
echo "═══════════════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────────────
echo
echo "── A) 迁移追踪表 schema_migrations（0034）──"
# ─────────────────────────────────────────────────────────────────────
HAS_SM="$(PSQL_SU -c "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations';" 2>/dev/null | head -1)"
if [ "${HAS_SM:-0}" != "1" ]; then
  echo "  ✗ public.schema_migrations 不存在 —— 0034 未应用。"
  echo "    迁移状态仍只存在于文件注释里（这正是 0016/0026/0027 静默失效的根因）。"
  echo "    修法：sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/0034-schema-migrations.sql"
  fail
else
  echo "  ✓ public.schema_migrations 存在"
  echo "  状态分布："
  PSQL_SU -F' = ' -c "SELECT status, count(*) FROM public.schema_migrations GROUP BY status ORDER BY status;" 2>/dev/null | sed 's/^/    /'
  echo "  非 applied 明细（superseded=内容被后续迁移接管；void=永久作废）："
  PSQL_SU -F' | ' -c "SELECT version, name, status FROM public.schema_migrations WHERE status <> 'applied' ORDER BY version;" 2>/dev/null | sed 's/^/    /'

  # 清单比对（可选）
  if [ -r "$MANIFEST" ]; then
    echo "  本地文件 vs 库内 checksum（$MANIFEST）："
    # TSV 直接用 shell 读，不走 SQL 解析（pg_read_file 对 /tmp 权限挑剔，
    # 且 TSV 解析用 awk/read 比在 SQL 里 split_part 更直白、更不易错）
    while IFS=$'\t' read -r v n sha; do
      [ -z "${v:-}" ] && continue
      db_sha="$(PSQL_SU -c "SELECT coalesce(checksum,'<null>') FROM public.schema_migrations WHERE version='$v' AND name='$n';" 2>/dev/null | head -1)"
      if [ -z "$db_sha" ]; then
        echo "    ✗ $v-$n：库内无记录（迁移未登记，可能是忘了应用或忘了入表）"; fail
      elif [ "$db_sha" = "$sha" ]; then
        echo "    ✓ $v-$n"
      elif [ "$db_sha" = "<null>" ]; then
        echo "    · $v-$n：库内 checksum 为 NULL（自指迁移，跳过比对）"
      else
        echo "    ✗ $v-$n：已应用的迁移文件被改动过！"; echo "        本地=$sha"; echo "        库内=$db_sha"; fail
      fi
    done < "$MANIFEST"
  else
    echo "  · 未见 $MANIFEST，跳过 checksum 比对（经 run-migration-audit.sh 调用时会自动上传）"
  fi
fi

# ─────────────────────────────────────────────────────────────────────
echo
echo "── B) 探针① 存在性（表/列/函数/策略/索引/约束）──"
# ─────────────────────────────────────────────────────────────────────
TBL() { echo "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='$1';"; }
COL() { echo "SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name='$2';"; }
FN()  { echo "SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$1';"; }
POL() { echo "SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='$1' AND policyname='$2';"; }
IDX() { echo "SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname='$1';"; }
CON() { echo "SELECT count(*)::int FROM pg_constraint WHERE conname='$1';"; }

echo " [0001] 索引 + anon 撤权"
chk "meal_entries_owner_id_log_date_idx"  "$(IDX meal_entries_owner_id_log_date_idx)"
chk "water_logs_owner_id_log_date_idx"    "$(IDX water_logs_owner_id_log_date_idx)"
chk "exercise_logs_owner_id_log_date_idx" "$(IDX exercise_logs_owner_id_log_date_idx)"
chk "anon 持有 0 个表权限" "SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='anon' AND table_schema='public';" 0

echo " [0002] auth.uid() 兼容层"
chk "auth.uid() 函数" "SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='auth' AND p.proname='uid';"

echo " [0003] AI 配额原子化"
chk "consume_ai_quota" "$(FN consume_ai_quota)"
chk "release_ai_quota" "$(FN release_ai_quota)"

echo " [0004] 微量营养素 + recipes"
# 🔴 表名更正（2026-10-23）：0004 迁移原文是 ALTER TABLE public.meal_entries
#   ADD COLUMN sodium_mg/fiber_g/added_sugar_g —— 三列在 meal_entries 上，
#   不在 profiles 上。早前探针写错表名导致恒 0 误报。
chk "meal_entries.sodium_mg"     "$(COL meal_entries sodium_mg)"
chk "meal_entries.fiber_g"       "$(COL meal_entries fiber_g)"
chk "meal_entries.added_sugar_g" "$(COL meal_entries added_sugar_g)"
chk "recipes 表"             "$(TBL recipes)"
chk "recipes_select_own 策略" "$(POL recipes recipes_select_own)"

echo " [0005] 会员档位"
chk "entitlements.source" "$(COL entitlements source)"

echo " [0006] quota_bonus"
chk "quota_bonus 表"        "$(TBL quota_bonus)"
chk "grant_photo_bonus"     "$(FN grant_photo_bonus)"
chk "quota_bonus_own 策略"  "$(POL quota_bonus quota_bonus_own)"

echo " [0007] 拍照配额"
chk "consume_photo_quota" "$(FN consume_photo_quota)"
chk "get_photo_quota"     "$(FN get_photo_quota)"

echo " [0008] 徽章/蜜糖/邀请码表"
chk "badges 表"       "$(TBL badges)"
chk "honey_ledger 表" "$(TBL honey_ledger)"
chk "invite_links 表" "$(TBL invite_links)"

echo " [0009] 邀请闭环"
chk "count_invitees"        "$(FN count_invitees)"
chk "settle_invite_checkin" "$(FN settle_invite_checkin)"
chk "bind_invite"           "$(FN bind_invite)"

echo " [0010] 徽章统计"
chk "badge_stats" "$(FN badge_stats)"

echo " [0011] 蜜糖退款/过期"
chk "expire_stale_honey"          "$(FN expire_stale_honey)"
chk "refund_checkin_honey_by_date" "$(FN refund_checkin_honey_by_date)"

echo " [0012] 兑换码 + 邀请节流"
chk "redeem_codes 表"    "$(TBL redeem_codes)"
chk "invite_attempts 表" "$(TBL invite_attempts)"
chk "redeem_by_code"     "$(FN redeem_by_code)"
chk "invite_throttled"   "$(FN invite_throttled)"

echo " [0013] 蜜糖安全加固"
chk "grant_honey"  "$(FN grant_honey)"
chk "redeem_honey" "$(FN redeem_honey)"
chk "unlock_badge" "$(FN unlock_badge)"
chk "refund_checkin_water_by_date"    "$(FN refund_checkin_water_by_date)"
chk "refund_checkin_exercise_by_date" "$(FN refund_checkin_exercise_by_date)"

echo " [0014] 配额令牌"
chk "release_photo_quota" "$(FN release_photo_quota)"
chk "ai_quota_claims 表"  "$(TBL ai_quota_claims)"

echo " [0016] 10 条边界 CHECK（🔴 审计实测：一条都没有）"
for c in profiles_age_check profiles_height_check profiles_current_weight_check \
         profiles_start_weight_check profiles_target_weight_check \
         meal_entries_grams_check meal_entries_calories_check \
         water_logs_amount_check \
         exercise_logs_minutes_check exercise_logs_calories_check; do
  chk "$c" "$(CON "$c")"
done

echo " [0018] 拍照计数"
chk "get_today_photo_count" "$(FN get_today_photo_count)"

echo " [0019] 邀请唯一索引"
chk "profiles_invited_once（部分唯一）" "SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname='profiles_invited_once' AND indexdef LIKE '%invited_by IS NOT NULL%';"

echo " [0020a] PIPL 同意"
chk "profiles.ai_consented" "$(COL profiles ai_consented)"

echo " [0021] 支付"
chk "payment_orders 表"    "$(TBL payment_orders)"
chk "payment_products 表"  "$(TBL payment_products)"
chk "create_payment_order" "$(FN create_payment_order)"
chk "verify_payment_order" "$(FN verify_payment_order)"
chk "3 档商品数据" "SELECT count(*)::int FROM public.payment_products;" 3

echo " [0022] 健康数据连接"
chk "profiles.health_connected"     "$(COL profiles health_connected)"
chk "profiles.health_connected_at"  "$(COL profiles health_connected_at)"

echo " [0023] 步数目标"
chk "profiles.step_goal" "$(COL profiles step_goal)"

echo " [0028] 排行榜"
chk "leaderboard"         "$(FN leaderboard)"
chk "_lb_compute_streak"  "$(FN _lb_compute_streak)"
chk "_lb_mask_name"       "$(FN _lb_mask_name)"

echo " [0030] 全量镜像规模"
chk "public 表 ≥18" "SELECT (count(*) >= 18)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r';"
chk "public 函数 ≥26" "SELECT (count(*) >= 26)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';"
chk "RLS 策略 ≥24" "SELECT (count(*) >= 24)::int FROM pg_policies WHERE schemaname='public';"

echo " [0031] 身份表"
chk "app_users 表"            "$(TBL app_users)"
# 约束实名带表名前缀（PG 对列级匿名 CHECK 的默认命名 = <表>_<列>_check；
# masked_is_masked 是 0031 里显式命名的 CONSTRAINT app_users_masked_is_masked）。
# 早前探针写短名导致恒 0 误报。
chk "app_users_ident_kind_check"  "$(CON app_users_ident_kind_check)"
chk "app_users_masked_is_masked"  "$(CON app_users_masked_is_masked)"
chk "app_users FORCE RLS" "SELECT relforcerowsecurity::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='app_users';"

echo " [0032] PostgREST 角色"
chk "dbee_web 可登录"  "SELECT rolcanlogin::int FROM pg_roles WHERE rolname='dbee_web';"
chk "dbee_web NOINHERIT" "SELECT (NOT rolinherit)::int FROM pg_roles WHERE rolname='dbee_web';"

echo " [0033] 收回 BYPASSRLS + 精确 policy"
chk "dbee_app NOBYPASSRLS" "SELECT (NOT rolbypassrls)::int FROM pg_roles WHERE rolname='dbee_app';"
chk "gateway_ident_access 策略" "$(POL app_users gateway_ident_access)"

echo " [0029] pg_net（应为 void：扩展不可用）"
chk "pg_net 扩展不存在（预期 0，故 0029 永久作废）" "SELECT count(*)::int FROM pg_extension WHERE extname='pg_net';" 0

echo " [0035] 安全与完整性补齐（P0-1）"
chk "quota_bonus_newbie_retire_log 备份表" "$(TBL quota_bonus_newbie_retire_log)"
chk "作废备份表对 authenticated 不可见（预期 0）" "SELECT has_table_privilege('authenticated','public.quota_bonus_newbie_retire_log','SELECT')::int;" 0
# 刻意不把 quota_bonus_newbie_retire_log 加进 D 段的期望矩阵：
#   它对 authenticated 本就零权限，矩阵里没有可校验的差异；
#   而矩阵的 WHERE 会把「表不存在」也报成失败，导致 0035 未应用的库误报安全问题。
#   故只在这里做存在性检查，权限正确性由上面的 has_table_privilege=0 断言。

# ─────────────────────────────────────────────────────────────────────
echo
echo "── C) 探针② 版本性（函数体特征串，识别覆盖式迁移的半成品）──"
# ─────────────────────────────────────────────────────────────────────
# 为什么必须有这一类：函数是 CREATE OR REPLACE 覆盖式的。
# 只查「函数在不在」会把 0017/0024/0025/0026/0027 全部误报为已生效 ——
# 审计实测正是如此：bind_invite 在，但没有 daily_limit 分支（0027 从未应用）。
BODY() { echo "SELECT (position('$2' in pg_get_functiondef(p.oid)) > 0)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$1';"; }

echo " [0017] bind_invite 重复绑定防护"
chk "函数体含 'already'" "$(BODY bind_invite already)"

echo " [0020b] badge_stats 减重修复"
chk "函数体含 weight_lost" "$(BODY badge_stats weight_lost)"

echo " [0024] redeem_honey ref_id 修复"
chk "函数体含 redeem ref_id" "$(BODY redeem_honey redeem)"

echo " [0025] AI1SCAN 每日限 2 次"
chk "函数体含 '>= 2' 限制" "$(BODY redeem_honey '>= 2')"

echo " [0026] 新手奖励改蜜糖（🔴 审计实测：函数体无 newbie 分支）"
chk "grant_honey 含 newbie 分支" "$(BODY grant_honey newbie)"
chk "grant_honey 含 150 额度" "$(BODY grant_honey '150')"
chk "存量 source='newbie' 的未过期 bonus 已作废（期望 0 行）" \
  "SELECT count(*)::int FROM public.quota_bonus WHERE source='newbie' AND amount > consumed AND expires_at > now();" 0

echo " [0027] 邀请码单日频次限制（🔴 审计实测：函数体无 daily_limit）"
chk "bind_invite 含 daily_limit 分支" "$(BODY bind_invite daily_limit)"
chk "bind_invite 含单日计数逻辑" "$(BODY bind_invite v_daily_binds)"

# ─────────────────────────────────────────────────────────────────────
echo
echo "── D) 探针③ 可利用性 A：权限矩阵比对（设计应有 vs 库内实际）──"
# ─────────────────────────────────────────────────────────────────────
# 期望矩阵与 db/gen-full-mirror-sql.py 的 TABLE_GRANTS 同源（唯一真相）。
# 🔴 审计实测：全库 25 个 authenticated 写权限 = 19 个设计允许 + 6 个违规残留，
#    违规的 6 个正好落在 entitlements / ai_usage 上 —— 0015 只做了一半。
#    根因是 GRANT 的追加语义：0015 只发了 REVOKE 给部分表，
#    而镜像 0030 又把宽权限 GRANT 了回去，两者叠加后没人发现。
PSQL_SU -F' | ' -c "
WITH want(tbl, sel, ins, upd, del) AS (VALUES
  ('profiles',        true,  true,  true,  true),
  ('meal_entries',    true,  true,  true,  true),
  ('weight_logs',     true,  true,  true,  true),
  ('water_logs',      true,  true,  true,  true),
  ('exercise_logs',   true,  true,  true,  true),
  ('recipes',         true,  true,  true,  true),
  ('invite_links',    true,  true,  false, false),
  ('entitlements',    true,  false, false, false),
  ('ai_usage',        true,  false, false, false),
  ('badges',          true,  false, false, false),
  ('honey_ledger',    true,  false, false, false),
  ('quota_bonus',     false, false, false, false),
  ('payment_orders',  false, false, false, false),
  ('payment_products',false, false, false, false),
  ('redeem_codes',    false, false, false, false),
  ('invite_attempts', false, false, false, false),
  ('ai_quota_claims', false, false, false, false),
  ('app_users',       false, false, false, false),
  ('schema_migrations',false, false, false, false)
),
live AS (
  SELECT c.relname AS tbl,
         has_table_privilege('authenticated', c.oid, 'SELECT') AS sel,
         has_table_privilege('authenticated', c.oid, 'INSERT') AS ins,
         has_table_privilege('authenticated', c.oid, 'UPDATE') AS upd,
         has_table_privilege('authenticated', c.oid, 'DELETE') AS del
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
)
SELECT w.tbl AS 表,
       CASE WHEN l.tbl IS NULL THEN '表不存在'
            WHEN (w.sel,w.ins,w.upd,w.del) = (l.sel,l.ins,l.upd,l.del) THEN '一致'
            ELSE format('越权/缺权: 期望 S%s I%s U%s D%s，实际 S%s I%s U%s D%s',
                        CASE WHEN w.sel THEN 'Y' ELSE 'n' END, CASE WHEN w.ins THEN 'Y' ELSE 'n' END,
                        CASE WHEN w.upd THEN 'Y' ELSE 'n' END, CASE WHEN w.del THEN 'Y' ELSE 'n' END,
                        CASE WHEN l.sel THEN 'Y' ELSE 'n' END, CASE WHEN l.ins THEN 'Y' ELSE 'n' END,
                        CASE WHEN l.upd THEN 'Y' ELSE 'n' END, CASE WHEN l.del THEN 'Y' ELSE 'n' END)
       END AS 结论
FROM want w LEFT JOIN live l USING (tbl)
WHERE w.tbl NOT IN (SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r')
   OR (l.sel,l.ins,l.upd,l.del) IS DISTINCT FROM (w.sel,w.ins,w.upd,w.del)
ORDER BY w.tbl;" 2>/dev/null > /tmp/_priv_diff.txt || true
if [ -s /tmp/_priv_diff.txt ]; then
  echo "  ✗ 权限矩阵与设计不一致："
  sed 's/^/      /' /tmp/_priv_diff.txt
  fail
else
  echo "  ✓ authenticated 的表权限与设计矩阵完全一致（无越权、无缺权）"
fi
rm -f /tmp/_priv_diff.txt

# 反向检查：库里存在、但**不在期望矩阵内**的 public 表。
#   为什么必须有这一半：上面的 LEFT JOIN 只遍历 want 清单，
#   将来新增一张表而忘了登记进矩阵，它会完全逃过检查 ——
#   若建表时顺手 GRANT 给了 authenticated（PG 默认还会授 PUBLIC），
#   那正是 0015 那类漏洞重演的入口。故这里把「矩阵外且带权限」的表揪出来。
PSQL_SU -F' | ' -c "
WITH want(tbl) AS (VALUES
  ('profiles'),('meal_entries'),('weight_logs'),('water_logs'),('exercise_logs'),
  ('recipes'),('invite_links'),('entitlements'),('ai_usage'),('badges'),
  ('honey_ledger'),('quota_bonus'),('payment_orders'),('payment_products'),
  ('redeem_codes'),('invite_attempts'),('ai_quota_claims'),('app_users'),
  ('schema_migrations')
),
live AS (
  SELECT c.relname AS tbl,
         has_table_privilege('authenticated', c.oid, 'SELECT') AS sel,
         has_table_privilege('authenticated', c.oid, 'INSERT') AS ins,
         has_table_privilege('authenticated', c.oid, 'UPDATE') AS upd,
         has_table_privilege('authenticated', c.oid, 'DELETE') AS del
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
)
SELECT l.tbl AS 未登记表,
       format('authenticated 持有 S%s I%s U%s D%s',
              CASE WHEN l.sel THEN 'Y' ELSE 'n' END, CASE WHEN l.ins THEN 'Y' ELSE 'n' END,
              CASE WHEN l.upd THEN 'Y' ELSE 'n' END, CASE WHEN l.del THEN 'Y' ELSE 'n' END) AS 权限
FROM live l LEFT JOIN want w USING (tbl)
WHERE w.tbl IS NULL AND (l.sel OR l.ins OR l.upd OR l.del)
ORDER BY l.tbl;" 2>/dev/null > /tmp/_priv_unknown.txt || true
if [ -s /tmp/_priv_unknown.txt ]; then
  echo "  ✗ 发现「不在期望矩阵内、却对 authenticated 开放权限」的表（新表未登记？）："
  sed 's/^/      /' /tmp/_priv_unknown.txt
  echo "    修法：确认该表应有的权限后，把它加进本脚本的 want 矩阵与"
  echo "          db/gen-full-mirror-sql.py 的 TABLE_GRANTS（两处需一致）。"
  fail
else
  echo "  ✓ 无「矩阵外却带权限」的表（新增表都已登记）"
fi
rm -f /tmp/_priv_unknown.txt

# ─────────────────────────────────────────────────────────────────────
echo
echo "── E) 探针③ 可利用性 B：事务内真实越权写（BEGIN…ROLLBACK）──"
# ─────────────────────────────────────────────────────────────────────
# 为什么权限位对了还要再实测一次：权限位是「静态声明」，
# RLS + SECURITY DEFINER + 角色继承组合起来的**实际效果**只有真写一次才知道。
# 审计时正是这一步抓到了 entitlements 可被 UPDATE 成 lifetime（白嫖终身会员）。
#
# 安全设计（三重保险，缺一不可）：
#   ① owner_id 用全 0 合成值 —— 不对应任何真实用户，即使误提交也不影响真人数据；
#   ② INSERT 的 plan 值是探针专用的 'lifetime'，且整段在 BEGIN…ROLLBACK 内；
#   ③ 结果只取 count，不回显任何真实行内容。
# 只跑一次，输出先存进变量再既展示又判定 —— 早前写成「跑一次打印 + 再跑一次
# grep」，等于对生产库做两遍越权探测，且两遍结果可能不一致（时序竞争）。
# ⚠️ SQL 必须走临时文件 + psql -f，不能用 heredoc 直灌：
#   PSQL_SU 内部是 `echo "$PWD" | sudo -S ...`，管道会**接管 stdin**，
#   heredoc 根本到不了 psql（实测症状：探针零输出，被误判为「连接异常」）。
PROBE_SQL="$(mktemp /tmp/dbee-probe-XXXXXX.sql)"
trap 'rm -f "$PROBE_SQL"' EXIT
cat > "$PROBE_SQL" <<'SQL'
BEGIN;
CREATE TEMP TABLE _probe(seq int, name text, verdict text) ON COMMIT DROP;
DO $$
DECLARE
  v_uid  text := '0000000000000000000';   -- 合成探针身份，非真实用户
  v_rows integer;
  v_id   bigint;
BEGIN
  -- 探针 1：authenticated 能否 INSERT entitlements（凭空造会员记录）
  BEGIN
    EXECUTE 'SET ROLE authenticated';
    PERFORM set_config('app.user_id', v_uid, false);
    EXECUTE 'INSERT INTO public.entitlements (owner_id, plan) VALUES ($1, ''lifetime'') RETURNING id'
      INTO v_id USING v_uid;
    INSERT INTO _probe VALUES (1, 'entitlements INSERT', 'ALLOWED 越权：已插入 1 行（回滚）');
  EXCEPTION
    WHEN insufficient_privilege THEN
      INSERT INTO _probe VALUES (1, 'entitlements INSERT', 'DENIED 安全：无 INSERT 权限');
    WHEN others THEN
      -- RLS 的 WITH CHECK 拦截也落在这里（row-level security violation）
      INSERT INTO _probe VALUES (1, 'entitlements INSERT', 'BLOCKED: ' || SQLERRM);
  END;

  -- 探针 2：authenticated 能否 UPDATE entitlements.plan —— 审计实测的真实攻击
  --   （把自己的 free 改成 lifetime = 白嫖终身会员）。
  --   ⚠️ 必须用 ROW_COUNT 判定：UPDATE 匹配 0 行时**不抛异常**，
  --     只看「有没有异常」会把「有权限但无行可改」误报成安全。
  --   ⚠️ 0 行命中**仍是漏洞**：RLS 策略 owner_id = auth.uid() 只挡跨用户改行，
  --     不挡改自己那行；探针用合成 uid 天然没有行，真实用户改自己的一定命中。
  --     故这里 0 行也判 ALLOWED（权限存在即漏洞），不因「没改到东西」而放过。
  --   🔴 SET ROLE 必须在本探针块内自带（2026-10-23 修复）：
  --     PL/pgSQL 的 BEGIN...EXCEPTION 子块 = 隐式 savepoint，探针 1 的 INSERT
  --     触发 42501 被捕获时，子事务回滚会把块内的 SET ROLE authenticated 一并
  --     撤销 → current_user 退回 postgres。若探针 2 不自带 SET ROLE，就会以
  --     超级用户身份 UPDATE（当然成功）→ 把「安全的库」误报成「越权漏洞」。
  BEGIN
    EXECUTE 'SET ROLE authenticated';
    PERFORM set_config('app.user_id', v_uid, false);
    EXECUTE 'UPDATE public.entitlements SET plan = ''lifetime'', updated_at = now() WHERE owner_id = $1'
      USING v_uid;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      INSERT INTO _probe VALUES (2, 'entitlements UPDATE plan=lifetime', 'ALLOWED 越权：改写 ' || v_rows || ' 行（已回滚）');
    ELSE
      INSERT INTO _probe VALUES (2, 'entitlements UPDATE plan=lifetime', 'ALLOWED 越权：持有 UPDATE 权限（本次 0 行命中，仅因探针用合成身份无行可改）');
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- ⚠️ 42501 有两种来源且无法在此区分：① 无 UPDATE 表权限（0035 的目标）
      --    ② RLS WITH CHECK 拦截。两者都算「挡住了」，具体是哪种看 D 段权限矩阵。
      INSERT INTO _probe VALUES (2, 'entitlements UPDATE plan=lifetime', 'DENIED 42501：无表权限或 RLS 拦截（细分见 D 段）');
    WHEN others THEN
      INSERT INTO _probe VALUES (2, 'entitlements UPDATE plan=lifetime', 'BLOCKED: ' || SQLERRM);
  END;

  -- 探针 3：authenticated 能否 UPDATE ai_usage（刷 AI 免费额度）
  --   同上：0 行命中仍判 ALLOWED；SET ROLE 同样必须块内自带（原因见探针 2）。
  BEGIN
    EXECUTE 'SET ROLE authenticated';
    PERFORM set_config('app.user_id', v_uid, false);
    EXECUTE 'UPDATE public.ai_usage SET count = 0 WHERE owner_id = $1' USING v_uid;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      INSERT INTO _probe VALUES (3, 'ai_usage UPDATE count=0', 'ALLOWED 越权：改写 ' || v_rows || ' 行（已回滚）');
    ELSE
      INSERT INTO _probe VALUES (3, 'ai_usage UPDATE count=0', 'ALLOWED 越权：持有 UPDATE 权限（本次 0 行命中，仅因探针用合成身份无行可改）');
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN
      INSERT INTO _probe VALUES (3, 'ai_usage UPDATE count=0', 'DENIED 42501：无表权限或 RLS 拦截（细分见 D 段）');
    WHEN others THEN
      INSERT INTO _probe VALUES (3, 'ai_usage UPDATE count=0', 'BLOCKED: ' || SQLERRM);
  END;

  EXECUTE 'RESET ROLE';
  PERFORM set_config('app.user_id', '', false);
END $$;
SELECT name || ' -> ' || verdict FROM _probe ORDER BY seq;
ROLLBACK;
SQL
# postgres 读不了 ubuntu 的 0600 临时文件（SFTP 上传同坑），先放开读权限再 -f 执行
chmod 644 "$PROBE_SQL"
PROBE_OUT="$(PSQL_SU -f "$PROBE_SQL" 2>/dev/null)"
rm -f "$PROBE_SQL"
echo "$PROBE_OUT" | sed 's/^/  /'
# 判定口径：ALLOWED = 越权（必修）；DENIED/BLOCKED = 安全。
#   注意 BLOCKED（RLS 拦截）虽也算挡住，但 0015 的设计目标是「根本没有写权限」，
#   权限位不匹配已在 D 段单独报出，此处不重复计失败，避免一个根因报两次。
if echo "$PROBE_OUT" | grep -q 'ALLOWED'; then
  echo "  ✗ 实测确认存在越权写入路径 —— REVOKE 未生效（0015 只做了一半）"
  fail
elif [ -z "$PROBE_OUT" ]; then
  echo "  ✗ 探针无输出（连接或权限异常），无法判定 —— 需人工复核"
  fail
else
  echo "  ✓ 事务内实测：authenticated 无法写 entitlements / ai_usage（越权路径已封）"
fi

# ─────────────────────────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo " 审计通过：0 项异常（三类探针全绿）"
else
  echo " 审计发现 $FAIL 项异常 —— 逐条见上方 ✗ 标记"
  echo " 提示：0016/0026/0027 的补齐项在 0035-security-and-integrity.sql；"
  echo "       0015 的权限残留在 0035 的 REVOKE ALL + 精确 GRANT 段。"
fi
echo "═══════════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
