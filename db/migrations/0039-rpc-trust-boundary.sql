-- ═══════════════════════════════════════════════════════════════════════
-- 0039 · RPC 信任边界收紧 + 结算/兑换原子性 + 网关权益闸门
-- ═══════════════════════════════════════════════════════════════════════
-- 起因（2026-10-25 全仓安全审查，P0 修复第一批）：
--
--   🔴 P0-A `grant_honey` 信任客户端入参 —— 只校验「金额在白名单里」，
--      **不校验业务事实**。任何登录用户可直接 RPC：
--        SELECT grant_honey('checkin_meal', '2026-10-25', 5);
--      没记一餐也照样拿分；`streak_milestone` 的 ref_id 是客户端拼的
--      `<N>d-<date>`，改日期后缀即可绕过 UNIQUE 重复领里程碑积分。
--      → 修复：函数体内**逐 reason 验证库内事实**（当日确有饮食/饮水达标/
--        运动记录；里程碑用 _lb_compute_streak 实算连续天数 == N 且日期 == 今天）。
--
--   🔴 P0-B `grant_photo_bonus` 的 `honey` 分支不扣积分 —— 客户端传
--      source='honey' + 随机 grant_key 可**无限凭空制造识别额度**；
--      `newbie` 分支已被 0026 改发积分替代、0035 作废存量，客户端调用属遗留。
--      → 修复：客户端仅允许 `streak7`，且 grant_key 日期必须真实存在
--        「以该日结尾的 7 连续打卡」事实；`honey` 额度只能经 redeem_honey
--        内部 INSERT 产生（它有扣积分），`newbie` 一律拒绝。
--
--   🔴 P0-C `consume_ai_quota` / `consume_photo_quota` 的 `p_limit` /
--      `p_base_limit` 客户端可控 —— 传 limit=999999 即无限用；
--      且 consume_ai_quota 首次 INSERT 分支**完全没有上限判断**。
--      → 修复：签名保持不变（前端/PostgREST 零改动），但入参上限**一律忽略**，
--        限额由库内常量决定（scan=3，与 packages/shared FREE_DAILY_AI 同源）；
--        未知 feature 直接拒绝。amount 恒为 1。
--
--   🟠 P1-D `redeem_honey` 先查余额后写，无锁 —— 并发双击可双花积分。
--      → 修复：函数入口加用户级 advisory xact lock。
--
--   🟠 P1-E `settle_invite_checkin` 积分靠 ON CONFLICT 幂等，但
--      **Pro 顺延段每次调用都执行** —— 反复调用可无限 +7 天 Pro。
--      → 修复：advisory lock + 「受邀人积分首次插入成功」作为唯一放行凭据，
--        首次之后直接返回 true（幂等成功），不再触碰 entitlements。
--
--   🟢 新增 `llm_gate(p_feature)` —— LLM 网关的服务端权益闸门（仅授 dbee_app，
--      **不授 authenticated**，客户端不可直调）。网关在处理 chat/completions 前
--      以用户身份调用：Pro/lifetime 直接放行；scan 用途要求当日已有额度占用
--      记录（前端流程是先 consume 后调 LLM，正常流量必然 used>=1 或有 bonus；
--      used=0 且 bonus=0 = 绕过前端额度直打网关，拒绝）。
--      非 scan 用途放行，日调用总量由网关 usageLimiter（200/日）兜底。
--
-- ─── 兼容性说明 ──────────────────────────────────────────────────────
--   · 全部函数**签名不变**：PostgREST schema cache、前端 api.ts、mini api.ts
--     的 RPC 调用参数照旧，只是服务端不再信任其中的金额/上限参数。
--   · 正常前端流程（先记餐/打卡，再 grant；先 consume，再调 LLM）行为不变。
--   · grant_honey 的 p_ttl_days 收紧到 [1,365]，防超长有效期。
--   · 事实验证窗口：打卡类 ref_id 允许 今天/昨天（跨零点补偿），
--     streak7 grant_key 允许 今天~前2天（时区+晚触发容差）。
--
-- 执行方式：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0039-rpc-trust-boundary.sql
-- 幂等：可重复执行（全部 CREATE OR REPLACE + DO 块守卫 + 追踪表 UPSERT）。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- (a) grant_honey：库内事实验证版
-- ═══════════════════════════════════════════════════════════════════════
-- 基线 = 0035(c)（含 newbie 150 分支），叠加事实验证。
CREATE OR REPLACE FUNCTION public.grant_honey(
  p_reason text,
  p_ref_id text,
  p_amount integer,
  p_ttl_days integer DEFAULT 365
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid     text := auth.uid();
  v_today   date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_ref_date date;
  v_expect  integer;
  v_target  numeric;
  v_total   numeric;
  v_n       integer;
  v_streak  integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_ref_id IS NULL OR btrim(p_ref_id) = '' THEN RETURN false; END IF;

  IF p_reason = 'newbie' THEN
    -- 固定业务键 + 固定金额；事实 = 已完善身体数据（身高体重均已填）
    IF p_ref_id <> 'newbie' OR p_amount <> 150 THEN RETURN false; END IF;
    PERFORM 1 FROM profiles
      WHERE owner_id = v_uid AND height_cm IS NOT NULL AND current_weight_kg IS NOT NULL;
    IF NOT FOUND THEN RETURN false; END IF;

  ELSIF p_reason IN ('checkin_meal', 'checkin_water', 'checkin_exercise') THEN
    -- 金额固定（5/2/2，与 packages/shared 的 CHECKIN_* 同源）
    v_expect := CASE p_reason WHEN 'checkin_meal' THEN 5 ELSE 2 END;
    IF p_amount <> v_expect THEN RETURN false; END IF;
    -- ref_id 必须是日期，且只允许 今天/昨天（前端只在「今天」结算，昨天为跨零点容差）
    BEGIN
      v_ref_date := p_ref_id::date;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    IF v_ref_date > v_today OR v_ref_date < v_today - 1 THEN RETURN false; END IF;
    -- 库内事实验证（与 refund_checkin_*_by_date 的口径完全一致）
    IF p_reason = 'checkin_meal' THEN
      PERFORM 1 FROM meal_entries WHERE owner_id = v_uid AND log_date = v_ref_date LIMIT 1;
      IF NOT FOUND THEN RETURN false; END IF;
    ELSIF p_reason = 'checkin_water' THEN
      SELECT COALESCE(SUM(amount_ml), 0) INTO v_total
        FROM water_logs WHERE owner_id = v_uid AND log_date = v_ref_date;
      SELECT COALESCE(current_weight_kg, 60) * 35 INTO v_target
        FROM profiles WHERE owner_id = v_uid;
      v_target := COALESCE(v_target, 2100);
      IF v_total < v_target THEN RETURN false; END IF;
    ELSE  -- checkin_exercise
      PERFORM 1 FROM exercise_logs WHERE owner_id = v_uid AND log_date = v_ref_date LIMIT 1;
      IF NOT FOUND THEN RETURN false; END IF;
    END IF;

  ELSIF p_reason = 'streak_milestone' THEN
    -- ref_id 格式 '<N>d-<YYYY-MM-DD>'（与前端 Dashboard.tsx 拼法一致）
    IF p_ref_id !~ '^[0-9]+d-[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
    BEGIN
      v_n := split_part(p_ref_id, 'd-', 1)::integer;
      v_ref_date := split_part(p_ref_id, 'd-', 2)::date;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    -- 只允许「今天」结算（前端也仅在 activeToday 时调用）
    IF v_ref_date <> v_today THEN RETURN false; END IF;
    -- 金额必须等于里程碑表值（与 src/lib/invite.ts STREAK_HONEY 同源）
    v_expect := CASE v_n WHEN 3 THEN 15 WHEN 7 THEN 40 WHEN 14 THEN 80
                         WHEN 21 THEN 120 WHEN 30 THEN 200 WHEN 60 THEN 400
                         WHEN 100 THEN 800 ELSE 0 END;
    IF v_expect = 0 OR p_amount <> v_expect THEN RETURN false; END IF;
    -- 事实：库内实算的当前连续打卡天数 == N（_lb_compute_streak 与 leaderboard 共用）
    SELECT public._lb_compute_streak(
             (SELECT array_agg(DISTINCT log_date::text ORDER BY log_date::text)
                FROM meal_entries WHERE owner_id = v_uid),
             v_today)
      INTO v_streak;
    IF COALESCE(v_streak, 0) <> v_n THEN RETURN false; END IF;

  ELSE
    RETURN false;  -- 未知 reason 一律拒绝
  END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, p_amount, p_reason, p_ref_id,
          now() + make_interval(days => LEAST(GREATEST(COALESCE(p_ttl_days, 365), 1), 365)))
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.grant_honey(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_honey(text, text, integer, integer) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (b) grant_photo_bonus：仅保留 streak7 + 库内 7 连续事实验证
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.grant_photo_bonus(
  p_source text,
  p_grant_key text,
  p_amount integer,
  p_ttl_days integer DEFAULT 7
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid      text := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_key_date date;
  v_cnt      integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  IF p_grant_key IS NULL OR btrim(p_grant_key) = '' THEN RETURN false; END IF;

  -- 🔴 只允许 streak7：
  --   · 'honey' 来源必须经 redeem_honey（扣积分后内部 INSERT quota_bonus），
  --     对客户端开放 = 凭空造识别额度（P0-B）。
  --   · 'newbie' 已被 0026 改为发 150 积分、0035 作废存量，不再对客户端开放。
  IF p_source IS DISTINCT FROM 'streak7' THEN RETURN false; END IF;
  -- 金额固定 2 次（packages/shared STREAK_BONUS_AMOUNT），TTL 1~7 天
  IF p_amount <> 2 THEN RETURN false; END IF;
  IF COALESCE(p_ttl_days, 7) NOT BETWEEN 1 AND 7 THEN RETURN false; END IF;

  -- grant_key = 连续段第 7k 天的日期（前端 streak.ts streak7Date 的拼法）
  BEGIN
    v_key_date := p_grant_key::date;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF v_key_date > v_today OR v_key_date < v_today - 2 THEN RETURN false; END IF;

  -- 事实：以 v_key_date 结尾的最近 7 天每天都有饮食记录
  SELECT count(DISTINCT log_date) INTO v_cnt
    FROM meal_entries
   WHERE owner_id = v_uid AND log_date <= v_key_date AND log_date > v_key_date - 7;
  IF COALESCE(v_cnt, 0) < 7 THEN RETURN false; END IF;

  INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
  VALUES (v_uid, p_source, p_grant_key, p_amount, 0,
          now() + make_interval(days => COALESCE(p_ttl_days, 7)))
  ON CONFLICT (owner_id, source, grant_key) DO NOTHING;
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.grant_photo_bonus(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_photo_bonus(text, text, integer, integer) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (c) consume_ai_quota：限额库内化，p_limit/p_amount 不再被信任
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.consume_ai_quota(
  p_usage_date date,
  p_feature text,
  p_limit integer,
  p_amount integer DEFAULT 1
)
RETURNS TABLE(allowed boolean, used integer, remaining integer)
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date  date := p_usage_date;
  v_limit integer;
  v_count integer;
  v_inserted boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN
    RETURN QUERY SELECT false, 0, 0; RETURN;
  END IF;
  -- 🔴 限额白名单（库内唯一真相，与 packages/shared FREE_DAILY_AI=3 同源）。
  --   入参 p_limit / p_amount 一律忽略：客户端可控的限额等于没有限额。
  IF p_feature = 'scan' THEN
    v_limit := 3;
  ELSE
    RETURN QUERY SELECT false, 0, 0; RETURN;
  END IF;

  IF v_date IS NULL THEN v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;

  -- 首次插入也要受上限约束（旧版此分支无判断，limit=1 都能被穿）
  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, p_feature, 1)
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN
    RETURN QUERY SELECT true, 1, v_limit - 1; RETURN;
  END IF;
  UPDATE ai_usage SET count = ai_usage.count + 1
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date
     AND ai_usage.feature = p_feature AND ai_usage.count + 1 <= v_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a
     WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = p_feature;
    RETURN QUERY SELECT false, COALESCE(v_count, v_limit), 0; RETURN;
  END IF;
  RETURN QUERY SELECT true, v_count, GREATEST(v_limit - v_count, 0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.consume_ai_quota(date, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(date, text, integer, integer) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (d) consume_photo_quota / get_photo_quota：基础限额库内化（=3）
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.consume_photo_quota(p_usage_date date, p_base_limit integer DEFAULT 3)
RETURNS TABLE(allowed boolean, used integer, remaining integer, token text)
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_date  date := p_usage_date;
  v_limit integer := 3;   -- 🔴 库内常量，入参 p_base_limit 一律忽略
  v_bonus_id bigint;
  v_base_used integer;
  v_token text;
  v_inserted boolean;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN
    RETURN QUERY SELECT false, 0, 0, NULL::text; RETURN;
  END IF;
  IF v_date IS NULL THEN v_date := v_today;
  ELSIF v_date > v_today + 1 OR v_date < v_today - 1 THEN v_date := v_today; END IF;

  -- 优先扣最早过期的奖励额度（FOR UPDATE 防并发双花同一 bonus 行）
  SELECT id INTO v_bonus_id FROM quota_bonus
   WHERE owner_id = auth.uid() AND amount > consumed AND expires_at > now()
   ORDER BY expires_at ASC LIMIT 1 FOR UPDATE;
  IF v_bonus_id IS NOT NULL THEN
    UPDATE quota_bonus SET consumed = consumed + 1 WHERE id = v_bonus_id;
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
    VALUES (auth.uid(), v_token, 'scan', v_date, v_bonus_id, 1);
    SELECT COALESCE(SUM(count), 0) INTO v_base_used FROM ai_usage
     WHERE owner_id = auth.uid() AND usage_date = v_date AND feature = 'scan';
    RETURN QUERY SELECT true, v_base_used, GREATEST(v_limit - v_base_used, 0), v_token; RETURN;
  END IF;

  INSERT INTO ai_usage (owner_id, usage_date, feature, count)
  VALUES (auth.uid(), v_date, 'scan', 1)
  ON CONFLICT (owner_id, usage_date, feature) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN
    v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
    INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
    VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
    RETURN QUERY SELECT true, 1, v_limit - 1, v_token; RETURN;
  END IF;

  UPDATE ai_usage SET count = ai_usage.count + 1
   WHERE ai_usage.owner_id = auth.uid() AND ai_usage.usage_date = v_date
     AND ai_usage.feature = 'scan' AND ai_usage.count + 1 <= v_limit
  RETURNING ai_usage.count INTO v_count;
  IF v_count IS NULL THEN
    SELECT a.count INTO v_count FROM ai_usage a
     WHERE a.owner_id = auth.uid() AND a.usage_date = v_date AND a.feature = 'scan';
    RETURN QUERY SELECT false, COALESCE(v_count, v_limit), 0, NULL::text; RETURN;
  END IF;
  v_token := md5(random()::text || clock_timestamp()::text || auth.uid());
  INSERT INTO ai_quota_claims (owner_id, token, feature, usage_date, bonus_id, amount)
  VALUES (auth.uid(), v_token, 'scan', v_date, NULL, 1);
  RETURN QUERY SELECT true, v_count, GREATEST(v_limit - v_count, 0), v_token;
END;
$fn$;

REVOKE ALL ON FUNCTION public.consume_photo_quota(date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_photo_quota(date, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_photo_quota(p_base_limit integer DEFAULT 3)
RETURNS TABLE(base_remaining integer, bonus_remaining integer, total_remaining integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_limit integer := 3;   -- 🔴 同上：入参不再被信任
  v_base_used integer;
  v_bonus integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = '' THEN RETURN QUERY SELECT 0, 0, 0; RETURN; END IF;
  SELECT COALESCE(SUM(count), 0) INTO v_base_used FROM ai_usage
   WHERE owner_id = auth.uid() AND usage_date = v_today AND feature = 'scan';
  SELECT COALESCE(SUM(amount - consumed), 0) INTO v_bonus FROM quota_bonus
   WHERE owner_id = auth.uid() AND amount > consumed AND expires_at > now();
  base_remaining := GREATEST(v_limit - v_base_used, 0);
  bonus_remaining := GREATEST(v_bonus, 0);
  total_remaining := base_remaining + bonus_remaining;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_photo_quota(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_photo_quota(integer) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (e) redeem_honey：用户级 advisory lock 防并发双花
-- ═══════════════════════════════════════════════════════════════════════
-- 基线 = 0025（ai1Scan 每日限兑 2 次）。业务逻辑不变，只加锁。
CREATE OR REPLACE FUNCTION public.redeem_honey(p_kind text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_cost integer;
  v_days integer;
  v_uid text := auth.uid();
  v_balance integer;
  v_ent bigint;
  v_plan text;
  v_until timestamptz;
  v_today text;
  v_ai_today integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  -- 🔴 用户级事务锁：并发双击/双设备同时兑换时串行化，
  --   否则「先查余额后扣分」存在竞态，可双花。
  PERFORM pg_advisory_xact_lock(hashtextextended('dbee:redeem_honey:' || v_uid, 0));

  IF p_kind = 'pro1Day' THEN v_cost := 100; v_days := 1;
  ELSIF p_kind = 'pro30Day' THEN v_cost := 2600; v_days := 30;
  ELSIF p_kind = 'ai1Scan' THEN v_cost := 50; v_days := 0;
  ELSE RETURN false; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_balance FROM honey_ledger
   WHERE owner_id = v_uid AND (expires_at IS NULL OR expires_at > now());
  IF v_balance < v_cost THEN RETURN false; END IF;

  IF p_kind = 'ai1Scan' THEN
    v_today := to_char((now() AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD');
    SELECT count(*) INTO v_ai_today FROM honey_ledger
     WHERE owner_id = v_uid AND reason = 'redeem' AND ref_id LIKE 'ai-' || v_today || '%' AND amount < 0;
    IF v_ai_today >= 2 THEN RETURN false; END IF;
    INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
    VALUES (v_uid, -v_cost, 'redeem', 'ai-' || v_today || '-' || to_char(clock_timestamp(), 'HH24MISSMS'), NULL);
    INSERT INTO quota_bonus (owner_id, source, grant_key, amount, consumed, expires_at)
    VALUES (v_uid, 'honey', 'redeem-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 1, 0,
            now() + make_interval(days => 7));
    RETURN true;
  END IF;

  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until FROM entitlements WHERE owner_id = v_uid;
  IF v_plan = 'lifetime' THEN RETURN false; END IF;
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, -v_cost, 'redeem', NULL, NULL);
  IF v_ent IS NULL THEN
    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_uid, 'pro', now() + make_interval(days => v_days), 'honey');
  ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
    UPDATE entitlements SET pro_until = v_until + make_interval(days => v_days), updated_at = now() WHERE id = v_ent;
  ELSE
    UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => v_days), updated_at = now() WHERE id = v_ent;
  END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.redeem_honey(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_honey(text) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (f) settle_invite_checkin：Pro 顺延只随「首次结算」执行一次
-- ═══════════════════════════════════════════════════════════════════════
-- 基线 = 0030（月度返佣 3000 上限）。缺陷：积分靠 UNIQUE 幂等，
--   但 Pro +7 天段**每次调用都执行** → 反复调用无限续 Pro。
CREATE OR REPLACE FUNCTION public.settle_invite_checkin()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_inviter text;
  v_bind_date date;
  v_logged_days integer;
  v_ent bigint;
  v_plan text;
  v_until timestamptz;
  v_month_honey integer;
  v_first boolean := false;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN false; END IF;
  -- 🔴 用户级事务锁：并发调用串行化（锁粒度小，事务短）
  PERFORM pg_advisory_xact_lock(hashtextextended('dbee:settle_invite:' || v_uid, 0));

  SELECT invited_by, COALESCE(invited_at::date, created_at::date)
    INTO v_inviter, v_bind_date FROM profiles WHERE owner_id = v_uid;
  IF v_inviter IS NULL THEN RETURN false; END IF;

  -- 事实：受邀后 7 个自然日内累计 ≥5 天有饮食记录
  SELECT count(DISTINCT log_date) INTO v_logged_days FROM meal_entries
   WHERE owner_id = v_uid AND log_date >= v_bind_date AND log_date <= v_bind_date + interval '6 days';
  IF v_logged_days < 5 THEN RETURN false; END IF;

  -- 月度返佣上限（邀请人侧，0013/0017 口径）
  SELECT COALESCE(SUM(amount), 0) INTO v_month_honey FROM honey_ledger
   WHERE owner_id = v_inviter AND reason IN ('inviter_register', 'inviter_checkin')
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  IF v_month_honey + 250 > 3000 THEN RETURN false; END IF;

  -- 🔴 首次插入成功 = 唯一放行凭据。UNIQUE(owner_id, reason, ref_id) 部分索引兜底；
  --   非首次直接幂等返回 true，**不再执行 Pro 顺延**。
  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_uid, 200, 'invitee_checkin', 'settle-' || v_inviter, now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING
  RETURNING true INTO v_first;
  IF NOT COALESCE(v_first, false) THEN RETURN true; END IF;

  INSERT INTO honey_ledger (owner_id, amount, reason, ref_id, expires_at)
  VALUES (v_inviter, 250, 'inviter_checkin', 'settle-' || v_uid, now() + make_interval(days => 365))
  ON CONFLICT DO NOTHING;

  -- 新人 Pro 7 天（仅首次结算）
  SELECT id, plan, pro_until INTO v_ent, v_plan, v_until FROM entitlements WHERE owner_id = v_uid;
  IF v_plan IS DISTINCT FROM 'lifetime' THEN
    IF v_ent IS NULL THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (v_uid, 'pro', now() + make_interval(days => 7), 'invite');
    ELSIF v_plan = 'pro' AND v_until IS NOT NULL AND v_until > now() THEN
      UPDATE entitlements SET pro_until = v_until + make_interval(days => 7), updated_at = now() WHERE id = v_ent;
    ELSE
      UPDATE entitlements SET plan = 'pro', pro_until = now() + make_interval(days => 7), updated_at = now() WHERE id = v_ent;
    END IF;
  END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.settle_invite_checkin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_invite_checkin() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- (g) llm_gate：LLM 网关专用权益闸门（仅 dbee_app，客户端不可调）
-- ═══════════════════════════════════════════════════════════════════════
-- 网关在转发 chat/completions 前，以 dbee_app 身份 + 事务内注入 app.user_id 调用。
-- 返回 json：{allowed, pro, reason?, claim_id?}
--
-- 判定口径（p_feature='scan' = 视觉识别请求）：
--   · Pro/lifetime → 放行（不消耗 claim）；
--   · 免费用户 → **原子核销一条当日额度占用记录**（ai_quota_claims）：
--     前端两端（src/pages/LogSheet.tsx、mini/src/pages/scan/scan.tsx）的流程
--     都是「先 consume_photo_quota 占用（产生 claim）→ 再调 LLM」。
--     闸门把 claim 标记 llm_used_at = 一次调用消耗一条 —— 若只查存在性，
--     consume 一次就能无限次打 LLM，额度形同虚设。
--     识别失败时前端 releasePhotoQuota(token) 照常退还（release 只看
--     released_at，与 llm_used_at 互不干扰）。
--   · 无可核销 claim → 拒绝（绕过前端额度直打网关，或当日额度已用尽）。
--   · 包装识别（条码兜底）不占额度、无 claim，由网关侧独立的
--     「视觉兜底日限额」（LLM_PACKAGE_DAILY_CAP，默认 8 次/日，内存计数）
--     放行，见 server/lib/llm.mjs（quota_not_claimed → 兜底通道）。
--
-- 并发安全：FOR UPDATE SKIP LOCKED —— 同用户双开页面同时识别时，
--   各自核销不同 claim，不会双花同一条；无空闲 claim 时立即返回而非等锁。

-- 一次性核销标记列（NULL = 尚未被 LLM 网关使用）
ALTER TABLE public.ai_quota_claims ADD COLUMN IF NOT EXISTS llm_used_at timestamptz;
COMMENT ON COLUMN public.ai_quota_claims.llm_used_at IS
  '0039 · LLM 网关核销时刻。llm_gate(scan) 一次调用消耗一条未释放未核销的 claim。';

CREATE OR REPLACE FUNCTION public.llm_gate(p_feature text)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid      text := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_pro      boolean;
  v_claim_id bigint;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN json_build_object('allowed', false, 'reason', 'unauthenticated');
  END IF;

  SELECT COALESCE(plan = 'lifetime' OR (plan = 'pro' AND pro_until IS NOT NULL AND pro_until > now()), false)
    INTO v_pro FROM entitlements WHERE owner_id = v_uid;
  IF COALESCE(v_pro, false) THEN
    RETURN json_build_object('allowed', true, 'pro', true);
  END IF;

  IF COALESCE(p_feature, '') = 'scan' THEN
    UPDATE ai_quota_claims SET llm_used_at = now()
     WHERE id = (
       SELECT id FROM ai_quota_claims
        WHERE owner_id = v_uid AND usage_date = v_today
          AND released_at IS NULL AND llm_used_at IS NULL
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id INTO v_claim_id;
    IF v_claim_id IS NOT NULL THEN
      RETURN json_build_object('allowed', true, 'pro', false, 'claim_id', v_claim_id);
    END IF;
    RETURN json_build_object('allowed', false, 'pro', false, 'reason', 'quota_not_claimed');
  END IF;

  -- 非 scan 用途（coach/plan/report/nutrition 文本）：无业务额度，
  -- 日总量由网关 usageLimiter（默认 200/日）兜底。
  RETURN json_build_object('allowed', true, 'pro', false);
END;
$fn$;

-- 🔴 只授网关角色。authenticated/anon 一律不可执行（防客户端直调探测权益口径）。
REVOKE ALL ON FUNCTION public.llm_gate(text) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_app') THEN
    GRANT EXECUTE ON FUNCTION public.llm_gate(text) TO dbee_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.llm_gate(text) FROM dbee_web';
  END IF;
END $$;

COMMENT ON FUNCTION public.llm_gate(text) IS
  '0039 · LLM 网关服务端权益闸门。仅 dbee_app 可执行；scan 用途要求当日已有额度占用。';

-- ═══════════════════════════════════════════════════════════════════════
-- (h) 迁移追踪表登记 + PostgREST 重载
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0039: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0039', 'rpc-trust-boundary', 'applied', 'self',
          '(a) grant_honey 库内事实验证 (b) grant_photo_bonus 仅 streak7+事实验证 '
          '(c)(d) consume_ai/photo_quota、get_photo_quota 限额库内化(=3) '
          '(e) redeem_honey advisory lock (f) settle_invite_checkin 首次插入判定 '
          '(g) llm_gate 网关权益闸门(仅 dbee_app)')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 执行后自检（只读，可逐条粘贴）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) grant_honey 已含事实验证（返回 t）：
--    SELECT position('meal_entries' IN pg_get_functiondef('public.grant_honey(text,text,integer,integer)'::regprocedure)) > 0;
-- 2) grant_photo_bonus 已拒绝 honey 来源（返回 t）：
--    SELECT position('streak7' IN pg_get_functiondef('public.grant_photo_bonus(text,text,integer,integer)'::regprocedure)) > 0;
-- 3) consume_ai_quota 限额库内化（返回 t，函数体不再引用 p_limit 作上限）：
--    SELECT position('v_limit := 3' IN pg_get_functiondef('public.consume_ai_quota(date,text,integer,integer)'::regprocedure)) > 0;
-- 4) redeem_honey 已加锁（返回 t）：
--    SELECT position('pg_advisory_xact_lock' IN pg_get_functiondef('public.redeem_honey(text)'::regprocedure)) > 0;
-- 5) settle_invite_checkin 首次判定（返回 t）：
--    SELECT position('v_first' IN pg_get_functiondef('public.settle_invite_checkin()'::regprocedure)) > 0;
-- 6) llm_gate 存在且 authenticated 不可执行（期望 t / f）：
--    SELECT to_regprocedure('public.llm_gate(text)') IS NOT NULL,
--           has_function_privilege('authenticated','public.llm_gate(text)','EXECUTE');
-- 7) 越权实测（BEGIN…ROLLBACK，期望全部 false/拒绝）：
--    BEGIN;
--    SELECT set_config('request.jwt.claims','{"sub":"probe-user","role":"authenticated"}',true);
--    SET LOCAL ROLE authenticated;
--    -- 没记一餐却想领打卡分 → 期望 f
--    SELECT public.grant_honey('checkin_meal', to_char(now(),'YYYY-MM-DD'), 5);
--    -- 凭空造识别额度 → 期望 f
--    SELECT public.grant_photo_bonus('honey', 'x' || random(), 1, 7);
--    -- 超大 limit → 期望 allowed=f（feature 未知）或按 3 封顶
--    SELECT * FROM public.consume_ai_quota(NULL, 'coach', 999999, 1);
--    ROLLBACK;
-- ═══════════════════════════════════════════════════════════════════════
-- 回滚
-- ═══════════════════════════════════════════════════════════════════════
-- 先备份：sudo -u postgres pg_dump -d dbee -F c -f /opt/dbee-db/backup-before-0039.dump
-- 回滚 = 重放旧版定义：
--   · grant_honey      ← 0035-security-and-integrity.sql (c) 段
--   · grant_photo_bonus / consume_ai_quota / consume_photo_quota /
--     get_photo_quota / redeem_honey / settle_invite_checkin ← 0030-schema.sql
--   · DROP FUNCTION public.llm_gate(text);
--   · DELETE FROM public.schema_migrations WHERE version='0039';
--   · NOTIFY pgrst, 'reload schema';
