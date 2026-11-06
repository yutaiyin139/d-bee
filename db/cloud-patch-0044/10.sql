CREATE OR REPLACE FUNCTION public.redeem_by_code(p_code text)
RETURNS text
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid    text := auth.uid();
  v_norm   text;
  v_row    redeem_codes%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN RETURN 'bad'; END IF;

  -- 🔴 用户级事务锁：串行化同一用户的并发兑换。
  --   必需理由见文件头 —— pro 顺延是读-改-写，无锁会丢一次顺延（少给用户一个月）。
  --   键前缀与 redeem_honey 区分（'dbee:redeem_code:'），两把锁互不阻塞。
  PERFORM pg_advisory_xact_lock(hashtextextended('dbee:redeem_code:' || v_uid, 0));

  v_norm := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  IF v_norm = '' THEN RETURN 'bad'; END IF;

  SELECT * INTO v_row FROM redeem_codes WHERE code = v_norm;
  IF NOT FOUND THEN RETURN 'bad'; END IF;
  IF v_row.used_by IS NOT NULL THEN RETURN 'used'; END IF;

  -- 🔴 档位合法性校验必须在「标记使用」之前：
  --   否则 months 被手工改坏的码会先被烧掉再发放失败，码永久作废且用户一无所获。
  --   约束已挡掉绝大多数组合，这里是防御性双保险（约束可被超级用户绕过/历史脏数据）。
  IF v_row.plan = 'lifetime' THEN
    IF v_row.months IS NOT NULL THEN RETURN 'bad'; END IF;
  ELSIF v_row.plan = 'pro' THEN
    IF v_row.months IS NULL OR v_row.months <= 0 OR v_row.months > 1200 THEN
      RETURN 'bad';
    END IF;
  ELSE
    RETURN 'bad';   -- 未知档位：宁可不发，绝不猜
  END IF;

  -- 原子标记使用（条件更新防并发重复兑换 —— 单码维度的保护，与上面的用户锁互补）
  UPDATE redeem_codes
     SET used_by = v_uid, used_at = now()
   WHERE id = v_row.id AND used_by IS NULL;
  IF NOT FOUND THEN RETURN 'used'; END IF;

  -- 权益写入不需要先 SELECT：下面的 ON CONFLICT DO UPDATE 里 `entitlements.*`
  -- 即冲突行的现值（PG 语义），CASE 直接在库内判定，省一次往返也无竞态窗口。
  IF v_row.plan = 'lifetime' THEN
    -- 终身买断：直接置顶（与 0012 原行为一致；0037:210-213 apple 侧同语义）
    INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
    VALUES (v_uid, 'lifetime', NULL, v_norm, 'redeem')
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = 'lifetime',
          pro_until = NULL,
          redeemed_code = v_norm,
          source = 'redeem',
          updated_at = now();
  ELSE
    -- pro 限时档：沿用 0037:235-242 的 CASE 三分支语义（0037:226 的 GREATEST 用于
    --   「Apple 通知自带到期时间」的场景；本函数到期时间由库内 now()+months 现算，
    --   不存在乱序旧值，故用 CASE 而非 GREATEST，语义等价且更直白）：
    --   · 已是 lifetime → 不降级（买断优先级最高，source 也保留，同 0037:228）
    --   · pro 且未过期 → 在现有到期日基础上**顺延**（用户不该因提前续费而亏）
    --   · 其他（free / pro 已过期 / 无记录）→ 从当下起算
    --   「pro_until > now()」判断保证过期值不会成为顺延基点（等价于取 max(现值, now())）。
    INSERT INTO entitlements (owner_id, plan, pro_until, redeemed_code, source)
    VALUES (v_uid, 'pro',
            now() + make_interval(months => v_row.months), v_norm, 'redeem')
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
          pro_until = CASE
            WHEN entitlements.plan = 'lifetime' THEN NULL                       -- 买断不降级
            WHEN entitlements.plan = 'pro' AND entitlements.pro_until > now()
              THEN entitlements.pro_until + make_interval(months => v_row.months)  -- 未过期 → 顺延
            ELSE now() + make_interval(months => v_row.months)                  -- 已过期/免费 → 重新起算
          END,
          -- redeemed_code 与 source 同语义 =「当前权益由谁发放」。
          -- lifetime 用户兑 pro 码时权益**未被改变**，故两者都保留原值，否则会留下
          -- 「source=apple 但 code 是兑换码」的矛盾记录（兑换事实已由
          -- redeem_codes.used_by/used_at 存证，不靠这里）。同 0037:228 口径。
          redeemed_code = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.redeemed_code ELSE v_norm END,
          source = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.source ELSE 'redeem' END,
          updated_at = now();
  END IF;

  RETURN 'ok';
END;
$fn$;
