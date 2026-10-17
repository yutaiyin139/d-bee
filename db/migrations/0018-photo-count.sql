-- ═══════════════════════════════════════════════════════════════
-- 0018 · 云端「当日成功拍照次数」计数
--
-- 背景（2026-10-17）：
--   拍照次数阶梯提示（第1-3次免费 / 第4-5次积分兑换 / 第6次起Pro）需要
--   「当日成功拍照次数」作为唯一真相源。原先用本地 kv 计数，跨设备/清缓存
--   会归零，且可被 devtools 绕过，不足以作为阶梯判断的可靠依据。
--
-- 设计：复用 0014 引入的 ai_quota_claims 预占流水表。
--   「成功拍照」= 占用额度后未退还（released_at IS NULL）；
--   「失败/重复」= 调用 release_photo_quota 后 released_at 非 NULL。
--   因此：
--     当日成功拍照次数 = COUNT(*) FROM ai_quota_claims
--       WHERE owner_id = auth.uid()
--         AND usage_date = 今天(Asia/Shanghai)
--         AND released_at IS NULL
--
-- 语义精确吻合现有 token 机制，无需新建表、不引入新的一致性维护成本。
--
-- 安全性：
--   - SECURITY DEFINER + 全程 auth.uid() 过滤，只能查自己的计数
--   - ai_quota_claims 表已 REVOKE ALL FROM authenticated（0014），客户端无法直读
--   - 只读、无副作用
--
-- 执行方式：genie-baas db_exec_sql mode=migrate
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_today_photo_count()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT count(*)::integer
    FROM ai_quota_claims
   WHERE owner_id = auth.uid()
     AND usage_date = (now() AT TIME ZONE 'Asia/Shanghai')::date
     AND released_at IS NULL
$fn$;

REVOKE ALL ON FUNCTION public.get_today_photo_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_today_photo_count() TO authenticated;
