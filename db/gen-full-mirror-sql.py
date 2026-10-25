#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 WorkBuddy 云数据库实时导出的全量数据，生成「自托管完整镜像」SQL。

与 gen-mirror-sql.py 的区别：
  - 覆盖全部 17 张表（原脚本只有 7 张核心表）
  - 含 21 个 SECURITY DEFINER 业务函数完整 DDL
  - 含 24 条 RLS 策略 + 表/函数 GRANT 权限
  - 数据来自 2026-10-20 21:00 云库实时快照（含 10-18 之后的增量）

用法：
  python db/gen-full-mirror-sql.py                  # 结构 + 全量数据（含真实用户数据，勿提交 git）
  python db/gen-full-mirror-sql.py --schema-only    # 仅结构（17 表/27 函数/24 策略/GRANT，0 行数据，可提交 git）
输出：
  db/migrations/0030-full-selfhost-mirror.sql       （含数据，已 gitignore）
  db/migrations/0030-schema.sql                     （--schema-only 产物，入库）

为什么分两个文件：含数据的镜像里有真实用户健康档案（年龄/身高体重/饮食记录，含未成年人），
按 PIPL 最小必要原则不进版本库；结构文件保留全部工程成果（表/函数/策略/权限），
数据由本地 db/backups/full-export/*.json（同样 gitignore）重新生成。

执行方式（服务器）：
  sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f /opt/dbee-db/0030-full-selfhost-mirror.sql

幂等：建表 IF NOT EXISTS、函数 CREATE OR REPLACE、策略先 DROP 再建、
数据 INSERT ON CONFLICT DO NOTHING、序列 setval 同步。

2026-10-23 修复（迁移审计 P0-3，见 docs/数据库迁移审计与实施计划.md）：
  ① GRANT 是追加语义——旧版只 GRANT 从不 REVOKE，目标库残留的历史宽权限
     （entitlements/ai_usage 写权限）在镜像执行后依旧保留。现在表权限与函数
     EXECUTE 均先无条件 REVOKE ALL 再按白名单精确 GRANT（照抄 0033 范式）。
     函数侧全量 REVOKE 还顺带堵住 PG 默认授 PUBLIC 的坑（0014 已废弃的
     release_ai_quota、_lb_* 内部辅助函数不再对 anon/authenticated 可执行）。
  ② 旧版完全不抓 pg_constraint——镜像出的新库缺 0016 的 10 条边界 CHECK。
     现在按 CHECK_CONSTRAINTS 字典（0016 权威定义）DROP IF EXISTS + ADD 输出。
  ③ COLUMNS/UNIQUE_CONSTRAINTS/TABLE_GRANTS 仍是硬编码字典（离线生成器的
     固有限制，本地无库可连）；字典头部已标注抓取日期与重抓方式，
     迁移状态核对交给 tools/migration-audit.sh（P0-4）做在线探针。
"""

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent

# --schema-only：只出结构，不写任何用户数据行（该产物可安全入库）
SCHEMA_ONLY = '--schema-only' in sys.argv[1:]
OUT = HERE / 'migrations' / ('0030-schema.sql' if SCHEMA_ONLY else '0030-full-selfhost-mirror.sql')

# ── 云库实时抓取的列结构（information_schema.columns，2026-10-20）──────────
# table -> list of (col, type, default, nullable)
COLUMNS = {
    'profiles': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('nickname', 'text', None, True), ('gender', 'text', None, True),
        ('age', 'integer', None, True), ('height_cm', 'numeric', None, True),
        ('start_weight_kg', 'numeric', None, True), ('current_weight_kg', 'numeric', None, True),
        ('target_weight_kg', 'numeric', None, True), ('activity_level', 'text', None, True),
        ('goal', 'text', None, True), ('weekly_rate_kg', 'numeric', None, True),
        ('daily_calorie_target', 'integer', None, True), ('protein_target_g', 'integer', None, True),
        ('carb_target_g', 'integer', None, True), ('fat_target_g', 'integer', None, True),
        ('barriers', 'text', None, True), ('plan_summary', 'text', None, True),
        ('onboarded', 'boolean', 'false', False), ('created_at', 'timestamptz', 'now()', False),
        ('updated_at', 'timestamptz', 'now()', False), ('invited_by', 'text', None, True),
        ('invite_code', 'text', None, True), ('invited_at', 'timestamptz', None, True),
        ('health_connected_at', 'timestamptz', None, True), ('health_connected', 'boolean', None, True),
        ('step_goal', 'integer', None, True), ('ai_consented', 'boolean', None, True),
    ],
    'meal_entries': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('log_date', 'date', None, False), ('meal_type', 'text', None, False),
        ('food_name', 'text', None, False), ('quantity_text', 'text', None, True),
        ('grams', 'numeric', None, True), ('calories', 'numeric', None, False),
        ('protein_g', 'numeric', '0', True), ('carb_g', 'numeric', '0', True),
        ('fat_g', 'numeric', '0', True), ('source', 'text', "'manual'::text", False),
        ('image_url', 'text', None, True), ('ai_note', 'text', None, True),
        ('health_score', 'integer', None, True), ('created_at', 'timestamptz', 'now()', False),
        ('sodium_mg', 'numeric', None, True), ('fiber_g', 'numeric', None, True),
        ('added_sugar_g', 'numeric', None, True),
    ],
    'weight_logs': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('log_date', 'date', None, False), ('weight_kg', 'numeric', None, False),
        ('note', 'text', None, True), ('created_at', 'timestamptz', 'now()', False),
    ],
    'water_logs': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('log_date', 'date', None, False), ('amount_ml', 'integer', None, False),
        ('created_at', 'timestamptz', 'now()', False),
    ],
    'exercise_logs': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('log_date', 'date', None, False), ('name', 'text', None, False),
        ('minutes', 'integer', None, False), ('calories', 'numeric', '0', False),
        ('created_at', 'timestamptz', 'now()', False),
    ],
    'entitlements': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('plan', 'text', "'free'::text", False), ('pro_until', 'timestamptz', None, True),
        ('redeemed_code', 'text', None, True), ('created_at', 'timestamptz', 'now()', False),
        ('updated_at', 'timestamptz', 'now()', False), ('source', 'text', None, True),
    ],
    'ai_usage': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('usage_date', 'date', None, False), ('feature', 'text', "'scan'::text", False),
        ('count', 'integer', '0', False), ('created_at', 'timestamptz', 'now()', False),
    ],
    'badges': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('badge_key', 'text', None, False), ('unlocked_at', 'timestamptz', 'now()', False),
    ],
    'honey_ledger': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('amount', 'integer', None, False), ('reason', 'text', None, False),
        ('ref_id', 'text', None, True), ('expires_at', 'timestamptz', None, True),
        ('created_at', 'timestamptz', 'now()', False),
    ],
    'invite_links': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('code', 'text', None, False), ('created_at', 'timestamptz', 'now()', False),
    ],
    'invite_attempts': [
        ('id', 'bigint', None, False), ('owner_id', 'text', None, False),
        ('code', 'text', None, False), ('ok', 'boolean', None, False),
        ('created_at', 'timestamptz', 'now()', False),
    ],
    'payment_products': [
        ('id', 'bigint', None, False), ('product_id', 'text', None, False),
        ('plan', 'text', None, False), ('months', 'integer', None, True),
        ('amount_cents', 'integer', None, False), ('currency', 'text', "'CNY'::text", False),
        ('active', 'boolean', 'true', False), ('created_at', 'timestamptz', 'now()', False),
        ('updated_at', 'timestamptz', 'now()', False),
    ],
    'payment_orders': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('order_no', 'text', None, False), ('provider', 'text', None, False),
        ('product_id', 'text', None, False), ('plan', 'text', None, False),
        ('months', 'integer', None, True), ('amount_cents', 'integer', None, False),
        ('currency', 'text', "'CNY'::text", False), ('status', 'text', "'pending'::text", False),
        ('provider_txn_id', 'text', None, True), ('receipt_payload', 'text', None, True),
        ('created_at', 'timestamptz', 'now()', False), ('updated_at', 'timestamptz', 'now()', False),
    ],
    'quota_bonus': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('source', 'text', None, False), ('grant_key', 'text', None, False),
        ('amount', 'integer', '0', False), ('consumed', 'integer', '0', False),
        ('expires_at', 'timestamptz', None, False), ('created_at', 'timestamptz', 'now()', False),
    ],
    'recipes': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('name', 'text', None, False), ('items', 'jsonb', "'[]'::jsonb", False),
        ('created_at', 'timestamptz', 'now()', False), ('updated_at', 'timestamptz', 'now()', False),
    ],
    'redeem_codes': [
        ('id', 'bigint', None, False), ('code', 'text', None, False),
        ('note', 'text', None, True), ('used_by', 'text', None, True),
        ('used_at', 'timestamptz', None, True), ('created_at', 'timestamptz', 'now()', False),
    ],
    'ai_quota_claims': [
        ('id', 'bigint', None, False), ('owner_id', 'text', 'auth.uid()', False),
        ('token', 'text', None, False), ('feature', 'text', None, False),
        ('usage_date', 'date', None, False), ('bonus_id', 'bigint', None, True),
        ('amount', 'integer', '1', False), ('created_at', 'timestamptz', 'now()', False),
        ('released_at', 'timestamptz', None, True),
    ],
}

# 唯一约束：table -> list of (constraint_name, [cols])
# ⚠️ 硬编码来源：2026-10-20 云库 pg_constraint 抓取。若库结构演进，
#    用 db/capture-live-schema.sql 在服务器上重新抓取后回填（见该文件说明）。
UNIQUE_CONSTRAINTS = {
    'profiles': [('profiles_owner_id_key', ['owner_id'])],
    'ai_usage': [('ai_usage_owner_id_usage_date_feature_key', ['owner_id', 'usage_date', 'feature'])],
    'badges': [('badges_owner_id_badge_key_key', ['owner_id', 'badge_key'])],
    'entitlements': [('entitlements_owner_id_key', ['owner_id'])],
    'invite_links': [('invite_links_code_key', ['code']), ('invite_links_owner_id_key', ['owner_id'])],
    'payment_orders': [('payment_orders_order_no_key', ['order_no'])],
    'payment_products': [('payment_products_product_id_key', ['product_id'])],
    'quota_bonus': [('quota_bonus_owner_id_source_grant_key_key', ['owner_id', 'source', 'grant_key'])],
    'redeem_codes': [('redeem_codes_code_key', ['code'])],
    'weight_logs': [('weight_logs_owner_id_log_date_key', ['owner_id', 'log_date'])],
    'ai_quota_claims': [('ai_quota_claims_token_key', ['token'])],
}

# CHECK 约束（边界校验，来源 0016-input-bounds.sql）：table -> list of (name, expr)
# 🔴 修复点②：旧生成器完全不抓 pg_constraint，镜像出的新库缺这 10 条边界 CHECK，
#    前端校验一旦被 devtools 绕过，脏数据（负热量/身高 999cm）可直接入库。
#    现按 0016 权威定义补齐，用 DROP IF EXISTS + ADD 保证幂等（重复执行无害）。
CHECK_CONSTRAINTS = {
    'profiles': [
        ('profiles_age_check',            'age IS NULL OR (age >= 1 AND age <= 120)'),
        ('profiles_height_check',         'height_cm IS NULL OR (height_cm >= 100 AND height_cm <= 250)'),
        ('profiles_current_weight_check', 'current_weight_kg IS NULL OR (current_weight_kg >= 20 AND current_weight_kg <= 300)'),
        ('profiles_start_weight_check',   'start_weight_kg IS NULL OR (start_weight_kg >= 20 AND start_weight_kg <= 300)'),
        ('profiles_target_weight_check',  'target_weight_kg IS NULL OR (target_weight_kg >= 20 AND target_weight_kg <= 300)'),
    ],
    'meal_entries': [
        ('meal_entries_grams_check',    'grams IS NULL OR (grams >= 0 AND grams <= 5000)'),
        ('meal_entries_calories_check', 'calories >= 0 AND calories <= 10000'),
    ],
    'water_logs': [
        ('water_logs_amount_check', 'amount_ml >= 0 AND amount_ml <= 5000'),
    ],
    'exercise_logs': [
        ('exercise_logs_minutes_check',  'minutes >= 0 AND minutes <= 600'),
        ('exercise_logs_calories_check', 'calories >= 0 AND calories <= 5000'),
    ],
}

# 额外索引（非 PK/UNIQUE，来自 pg_indexes）
EXTRA_INDEXES = [
    "CREATE INDEX IF NOT EXISTS meal_entries_owner_id_log_date_idx ON public.meal_entries (owner_id, log_date);",
    "CREATE INDEX IF NOT EXISTS water_logs_owner_id_log_date_idx ON public.water_logs (owner_id, log_date);",
    "CREATE INDEX IF NOT EXISTS exercise_logs_owner_id_log_date_idx ON public.exercise_logs (owner_id, log_date);",
    "CREATE INDEX IF NOT EXISTS ai_quota_claims_owner_created ON public.ai_quota_claims (owner_id, created_at);",
    "CREATE INDEX IF NOT EXISTS honey_ledger_owner_date ON public.honey_ledger (owner_id, created_at);",
    "CREATE UNIQUE INDEX IF NOT EXISTS honey_ledger_once ON public.honey_ledger (owner_id, reason, ref_id) WHERE (ref_id IS NOT NULL);",
    "CREATE INDEX IF NOT EXISTS invite_attempts_owner_id_created_at_idx ON public.invite_attempts (owner_id, created_at);",
    "CREATE UNIQUE INDEX IF NOT EXISTS profiles_invited_once ON public.profiles (owner_id) WHERE (invited_by IS NOT NULL);",
]

# RLS 策略：table -> list of (policyname, cmd, using, with_check)
POLICIES = {
    'profiles': [
        ('profiles_select_own', 'SELECT', '(owner_id = auth.uid())', None),
        ('profiles_insert_own', 'INSERT', None, '(owner_id = auth.uid())'),
        ('profiles_update_own', 'UPDATE', '(owner_id = auth.uid())', '(owner_id = auth.uid())'),
        ('profiles_delete_own', 'DELETE', '(owner_id = auth.uid())', None),
    ],
    'meal_entries': [
        ('meal_entries_select_own', 'SELECT', '(owner_id = auth.uid())', None),
        ('meal_entries_insert_own', 'INSERT', None, '(owner_id = auth.uid())'),
        ('meal_entries_update_own', 'UPDATE', '(owner_id = auth.uid())', '(owner_id = auth.uid())'),
        ('meal_entries_delete_own', 'DELETE', '(owner_id = auth.uid())', None),
    ],
    'weight_logs': [
        ('weight_logs_select_own', 'SELECT', '(owner_id = auth.uid())', None),
        ('weight_logs_insert_own', 'INSERT', None, '(owner_id = auth.uid())'),
        ('weight_logs_update_own', 'UPDATE', '(owner_id = auth.uid())', '(owner_id = auth.uid())'),
        ('weight_logs_delete_own', 'DELETE', '(owner_id = auth.uid())', None),
    ],
    'water_logs': [('water_logs_own', 'ALL', '(owner_id = auth.uid())', '(owner_id = auth.uid())')],
    'exercise_logs': [('exercise_logs_own', 'ALL', '(owner_id = auth.uid())', '(owner_id = auth.uid())')],
    'entitlements': [('entitlements_own', 'ALL', '(owner_id = auth.uid())', '(owner_id = auth.uid())')],
    'ai_usage': [('ai_usage_own', 'ALL', '(owner_id = auth.uid())', '(owner_id = auth.uid())')],
    'badges': [('badges_own', 'ALL', '(owner_id = auth.uid())', '(owner_id = auth.uid())')],
    'honey_ledger': [('honey_ledger_own', 'ALL', '(owner_id = auth.uid())', '(owner_id = auth.uid())')],
    'invite_links': [('invite_links_own', 'ALL', '(owner_id = auth.uid())', '(owner_id = auth.uid())')],
    'quota_bonus': [('quota_bonus_own', 'ALL', '(owner_id = auth.uid())', '(owner_id = auth.uid())')],
    'recipes': [
        ('recipes_select_own', 'SELECT', '(owner_id = auth.uid())', None),
        ('recipes_insert_own', 'INSERT', None, '(owner_id = auth.uid())'),
        ('recipes_update_own', 'UPDATE', '(owner_id = auth.uid())', '(owner_id = auth.uid())'),
        ('recipes_delete_own', 'DELETE', '(owner_id = auth.uid())', None),
    ],
}

# 表级 GRANT（authenticated 角色，来自 role_table_grants）
# 🔴 修复点①：GRANT 是【追加】语义——旧生成器只 GRANT 从不 REVOKE，
#    目标库若残留历史宽权限（如 entitlements/ai_usage 的写权限），镜像执行后
#    依旧保留 = 越权白嫖终身会员的攻击链原样复活（见 0033/0034 审计）。
#    build_all() 现在先 REVOKE ALL 再按本表精确 GRANT，把本字典作为唯一真相。
TABLE_GRANTS = {
    # table -> grant 列表（authenticated 应当持有的【全部】权限，多一不可）
    'profiles': 'SELECT, INSERT, UPDATE, DELETE',
    'meal_entries': 'SELECT, INSERT, UPDATE, DELETE',
    'weight_logs': 'SELECT, INSERT, UPDATE, DELETE',
    'water_logs': 'SELECT, INSERT, UPDATE, DELETE',
    'exercise_logs': 'SELECT, INSERT, UPDATE, DELETE',
    'entitlements': 'SELECT',
    'ai_usage': 'SELECT',
    'badges': 'SELECT',
    'honey_ledger': 'SELECT',
    'invite_links': 'SELECT, INSERT',
    'recipes': 'SELECT, INSERT, UPDATE, DELETE',
}

# 函数 EXECUTE 授权（authenticated 角色）
# 🔴 刻意不在清单内（0039 口径，与 tools/migration-audit.sh D 段一致）：
#   · llm_gate(text)         —— 仅授 dbee_app（LLM 网关专用权益闸门），authenticated 不可执行
#   · settle_apple_purchase 等 0037 IAP 函数 —— 仅授 dbee_app
#   · release_ai_quota / _lb_compute_streak / _lb_mask_name —— 废弃或内部辅助
# 🔴 0039/0040 的新对象（llm_gate、honey_balance()、leaderboard_cache 表）不入本基线镜像：
#   本镜像 = functions.sql（2026-10-20 云库 0030 快照）的忠实重建，属「建库基线」；
#   0039/0040 是叠加在基线之上的【增量迁移】，各自带 CREATE OR REPLACE / 建表 + GRANT，
#   由 psql 顺序执行（见各迁移头部执行方式）。故此处不重复登记，避免与增量迁移双重授权。
#   leaderboard() 仍在清单内——0040 用 CREATE OR REPLACE 覆盖其函数体，签名与授权不变。
FUNCTION_GRANTS = [
    'badge_stats', 'bind_invite', 'consume_ai_quota', 'consume_photo_quota',
    'count_invitees', 'create_payment_order', 'expire_stale_honey', 'get_inviter_by_code',
    'get_photo_quota', 'get_today_photo_count', 'grant_honey', 'grant_photo_bonus',
    'invite_throttled', 'leaderboard', 'redeem_by_code', 'redeem_honey',
    'refund_checkin_exercise_by_date', 'refund_checkin_honey_by_date',
    'refund_checkin_water_by_date', 'release_photo_quota', 'settle_invite_checkin',
    'unlock_badge', 'verify_payment_order',
]

# 函数完整 DDL（pg_get_functiondef，2026-10-20 云库实时）
FUNCTIONS = open(HERE / '..' / 'functions.sql', encoding='utf-8').read() if (HERE / '..' / 'functions.sql').exists() else None


def col_def(name, typ, default, nullable):
    """生成列定义，owner_id 默认 auth.uid()，GENERATED ALWAYS AS IDENTITY 的 id。"""
    if name == 'id':
        return f"  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
    parts = [f"  {name} {typ}"]
    if default is not None:
        parts.append(f"DEFAULT {default}")
    if not nullable:
        parts.append("NOT NULL")
    return ' '.join(parts)


def build_table(table):
    cols = COLUMNS[table]
    lines = [f"CREATE TABLE IF NOT EXISTS public.{table} ("]
    col_lines = []
    for (name, typ, default, nullable) in cols:
        col_lines.append(col_def(name, typ, default, nullable))
    # 唯一约束
    for (cname, ccols) in UNIQUE_CONSTRAINTS.get(table, []):
        col_lines.append(f"  CONSTRAINT {cname} UNIQUE ({', '.join(ccols)})")
    lines.append(',\n'.join(col_lines))
    lines.append(");")
    return '\n'.join(lines)


def build_policy_sql():
    out = []
    for table, pols in POLICIES.items():
        out.append(f"-- {table}")
        for (pname, cmd, using, wcheck) in pols:
            out.append(f"DROP POLICY IF EXISTS {pname} ON public.{table};")
            if cmd == 'ALL':
                out.append(f"CREATE POLICY {pname} ON public.{table} FOR ALL USING {using} WITH CHECK {wcheck};")
            else:
                if using and wcheck:
                    out.append(f"CREATE POLICY {pname} ON public.{table} FOR {cmd} USING {using} WITH CHECK {wcheck};")
                elif using:
                    out.append(f"CREATE POLICY {pname} ON public.{table} FOR {cmd} USING {using};")
                else:
                    out.append(f"CREATE POLICY {pname} ON public.{table} FOR {cmd} WITH CHECK {wcheck};")
    return '\n'.join(out)


def build_check_constraint_sql():
    """🔴 修复点②：输出 0016 的 10 条边界 CHECK。
    用 DROP IF EXISTS + ADD，幂等且能纠正历史上被误改的约束表达式。
    注意：ADD CONSTRAINT 会校验存量行，越界数据会导致失败——
    这正是期望行为（脏数据必须先清洗，见 0034/审计）。"""
    out = ["-- 边界 CHECK 约束（0016 权威定义，修复点②：旧生成器漏抓 pg_constraint）"]
    for table, checks in CHECK_CONSTRAINTS.items():
        out.append(f"-- {table}")
        for (cname, expr) in checks:
            out.append(f"ALTER TABLE public.{table} DROP CONSTRAINT IF EXISTS {cname};")
            out.append(f"ALTER TABLE public.{table} ADD CONSTRAINT {cname} CHECK ({expr});")
    return '\n'.join(out)


# 数据文件（每表一个 json，放在 db/backups/full-export/ 下）
DATA_DIR = HERE / 'backups' / 'full-export'
ALL_TABLES = list(COLUMNS.keys())


def data_block(table):
    f = DATA_DIR / f'{table}.json'
    if not f.exists():
        return f"\n-- {table}：无数据文件，跳过\n"
    rows = json.loads(f.read_text(encoding='utf-8'))
    if not rows:
        return f"\n-- {table}：0 行，跳过\n"
    payload = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
    assert '$j$' not in payload, '数据中出现了与 dollar-quoting 冲突的 $j$'
    return (
        f"\n-- {table}：{len(rows)} 行\n"
        f"INSERT INTO public.{table}\n"
        f"OVERRIDING SYSTEM VALUE\n"
        f"SELECT * FROM jsonb_populate_recordset(null::public.{table}, $j${payload}$j$::jsonb)\n"
        f"ON CONFLICT DO NOTHING;\n"
    )


def build_functions():
    """函数 DDL 从 functions.sql 读（云库 pg_get_functiondef 原样导出）。"""
    f = HERE / 'functions.sql'
    if not f.exists():
        return "-- 缺 functions.sql（函数 DDL）"
    return f.read_text(encoding='utf-8')


# 序列 setval
SERIAL_TABLES = list(COLUMNS.keys())
setvals = '\n'.join(
    f"SELECT setval(pg_get_serial_sequence('public.{t}', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM public.{t};"
    for t in SERIAL_TABLES
)


HEADER = """-- ════════════════════════════════════════════════════════════════════════════
-- 0030 · 自托管完整镜像：17 张表 + 业务函数 + RLS + 权限 + 全量数据
-- ════════════════════════════════════════════════════════════════════════════
-- 数据来源：WorkBuddy 云数据库实时导出（2026-10-20 21:00，含 10-18 后增量）
-- 目标环境：150.158.51.106 · dbee 库 · PostgreSQL 17.11
-- 执行方式：sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f <本文件>
-- 幂等：可重复执行。
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ① auth.uid() 兼容层
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  v      text;
  claims text;
BEGIN
  v := nullif(current_setting('app.user_id', true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  v := nullif(current_setting('request.jwt.claim.sub', true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  claims := nullif(current_setting('request.jwt.claims', true), '');
  IF claims IS NOT NULL THEN
    BEGIN
      RETURN claims::jsonb ->> 'sub';
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
  END IF;
  RETURN NULL;
END;
$$;

-- ② 角色
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

"""


def build_all():
    parts = [HEADER]
    # 表结构
    for t in ALL_TABLES:
        parts.append(build_table(t))
        parts.append('')
    # 补列：旧镜像（0002）建过的表会被 IF NOT EXISTS 跳过，缺新列时用 ALTER 补齐。
    # 不带 NOT NULL（旧表可能有存量行，缺省值的 NOT NULL 列会失败），仅补类型与默认值。
    parts.append('-- 补列（兼容 0002 旧结构）')
    for t in ALL_TABLES:
        for (name, typ, default, _nullable) in COLUMNS[t]:
            if name == 'id':
                continue
            ddl = f"ALTER TABLE public.{t} ADD COLUMN IF NOT EXISTS {name} {typ}"
            if default is not None:
                ddl += f" DEFAULT {default}"
            parts.append(ddl + ';')
    parts.append('')
    # 索引
    parts.append('-- 索引')
    parts.append('\n'.join(EXTRA_INDEXES))
    parts.append('')
    # RLS
    parts.append('-- 行级安全')
    for t in ALL_TABLES:
        parts.append(f"ALTER TABLE public.{t} ENABLE ROW LEVEL SECURITY;")
    parts.append('')
    parts.append(build_policy_sql())
    parts.append('')
    # 🔴 修复点②：边界 CHECK 约束（旧生成器完全漏抓）
    parts.append(build_check_constraint_sql())
    parts.append('')
    # GRANT 表
    parts.append('-- 表权限（authenticated）')
    parts.append('GRANT USAGE ON SCHEMA public TO authenticated;')
    parts.append('GRANT USAGE ON SCHEMA auth TO authenticated, anon;')
    parts.append('GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;')
    # 🔴 修复点①：先无条件 REVOKE，再按 TABLE_GRANTS 精确 GRANT。
    #    GRANT 是追加语义，不先 REVOKE 就无法纠正目标库残留的历史宽权限
    #    （entitlements/ai_usage 的 UPDATE 越权即由此而来，见 0033/0034）。
    parts.append('-- 先清空 authenticated 的表权限，再精确授予（修复点①：GRANT 追加语义）')
    parts.append('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;')
    for t, g in TABLE_GRANTS.items():
        parts.append(f'GRANT {g} ON public.{t} TO authenticated;')
    parts.append('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;')
    parts.append('')
    parts.append('COMMIT;')
    parts.append('')
    # 函数
    parts.append('-- ════════════ 业务函数（SECURITY DEFINER）════════════')
    parts.append('BEGIN;')
    parts.append(build_functions())
    parts.append('')
    # 🔴 修复点①（函数侧）：PG 默认把所有新函数的 EXECUTE 授给 PUBLIC。
    #    functions.sql 本身不含任何 GRANT/REVOKE，若不先全量收回，
    #    新镜像库里 release_ai_quota（0014 已废弃、明令 REVOKE）与 _lb_* 内部
    #    辅助函数会对 anon/authenticated 默认可执行 = 废弃路径复活。
    parts.append('-- 先收回全部函数 EXECUTE（PG 默认授 PUBLIC），再精确授予')
    parts.append('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;')
    for fn in FUNCTION_GRANTS:
        parts.append(f'GRANT EXECUTE ON FUNCTION public.{fn} TO authenticated;')
    parts.append('COMMIT;')
    parts.append('')
    # 数据
    if SCHEMA_ONLY:
        parts.append('-- ════════════ 全量数据 ═══════════')
        parts.append('-- 本文件由 --schema-only 生成，不含任何用户数据行（PIPL 最小必要）。')
        parts.append('-- 需要带数据的完整镜像请执行：python db/gen-full-mirror-sql.py')
        parts.append('-- （数据源 db/backups/full-export/*.json 不入库，见 .gitignore）')
        return '\n'.join(parts)
    parts.append('-- ════════════ 全量数据 ═══════════')
    parts.append('BEGIN;')
    for t in ALL_TABLES:
        parts.append(data_block(t))
    parts.append(setvals)
    parts.append('COMMIT;')
    return '\n'.join(parts)


OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(build_all(), encoding='utf-8')
print(f'已生成 {OUT}')
print(f'  文件大小 {OUT.stat().st_size} 字节')
