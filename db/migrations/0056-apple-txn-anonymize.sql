-- ═══════════════════════════════════════════════════════════════════════
-- 0056 · Apple 交易行「删号匿名化保留」：堵住 transaction_id 幂等键被释放的资损
-- ═══════════════════════════════════════════════════════════════════════
-- 漏洞（0045 作者已在 :34-40 自陈「⚠️ 已知权衡」，本迁移就是把它兑掉）：
--   0045 的 delete_own_account() 把 `apple_transactions` 放在 v_tables 里一并
--   DELETE。而 apple_transactions.transaction_id 是 UNIQUE（0037:58）—— 它是
--   全服「一笔 Apple 交易只核销一次」的**唯一幂等键**：
--     · settle_apple_purchase() 的第一闸就是 `WHERE transaction_id = p_transaction_id`
--       （0037:147），命中即 duplicate / txn_taken_by_other，不再发权益；
--     · 行被删掉 = 幂等键被释放 = 该收据重新变成「从未核销过」。
--   Apple 的 verifyReceipt 对历史收据永远返回 status=0（合法），网关
--   （server/lib/iap.mjs）验签必然通过 → 删号用户（或任何拿到这张旧收据的人）
--   可用**同一张已核销过的收据**对新账号再次核销，白拿一次会员权益。
--   删号即开闸 = 可无限次「删号→重注册→重放旧收据」= 直接资损。
--
-- 修法（0045:38 自己给的方向：「保留交易行 + owner_id 匿名化」）：
--   删号时**不删** apple_transactions 的行，只把 owner_id 覆写成匿名占位值
--   `'anon:' || md5(原 owner_id)`。transaction_id / original_transaction_id /
--   product_id / 金额时间等对账字段**一律不动** —— 幂等键必须原值保留，
--   改了等于没修。
--
-- 为什么占位值取 `'anon:' || md5(owner_id)` 而不是 NULL / 固定哨兵 / 带盐哈希：
--   · 不能置 NULL：0037:60 `owner_id text NOT NULL`（列约束，改约束=动已落地迁移）。
--   · 必须带前缀 `anon:`：真实 owner_id 只有两种形态 —— 19 位纯数字串
--     （server/lib/identity.mjs:112 newOwnerId()）与 `'wx:'||openid`
--     （0043:18），二者都不含冒号开头的 `anon:` → 占位值与任何真实 owner_id
--     **不可能冲突**，且下游可用前缀一眼识别「这是匿名行」。
--   · 不用固定哨兵 `__deleted__`：所有删号用户共用一个值会让
--     `WHERE owner_id = …` 类对账查询把不同人的交易行混成一坨，且丢失
--     「同一个人的多笔交易仍属同一匿名主体」这一最小可用信息。
--   · 用 md5 而非 HMAC/带盐：① md5() 是 PG 内置（0014:82、0030:703 已在用），
--     无需 pgcrypto；② 单向不可逆，满足 PIPL 第 47 条「删除后不可反推身份」；
--     ③ 本表 FORCE RLS + 无 policy + REVOKE 到 dbee_app/authenticated/anon
--     （0037:102-109），除 postgres 属主的 SECDEF 函数外**谁都读不到这一列**，
--     加盐防的是「拿到该列的人离线穷举」，而拿不到列的人本就不存在这个面；
--     ④ 🔴 刻意不复用 IDENT_PEPPER：pepper 是 app_users 身份哈希的密钥，
--     把它引进 DB 函数意味着要在库里存一份秘密（或改网关传参），
--     扩大红线键的暴露面，收益为零（见 ③）。
--
-- 连带影响（必须一起改，否则修出新漏洞）：
--   settle_apple_purchase() 的 webhook 分支（0037:168-178）在 p_owner_id 为 NULL 时
--   按 original_transaction_id **反查 owner**（0037:171）。匿名化后这一查会查到
--   `'anon:xxxx'` 并当成合法 owner 继续往下走 → INSERT 新交易行 + 给一个
--   app_users 里已不存在的幽灵 owner 写 entitlements = **孤儿权益行**，
--   比修复前（返回 owner_unresolved、只留痕不发权益）更糟。
--   故本迁移同时 CREATE OR REPLACE settle_apple_purchase()，在反查里加
--   `AND owner_id NOT LIKE 'anon:%'` → 删号后的续订通知回到 owner_unresolved
--   只留痕，与 0037 原语义一致。
--   客户端 verify 分支（p_owner_id 非 NULL）**不受影响且正是修复生效点**：
--   幂等第一闸先于 owner 比较执行（0037:147-156），命中匿名行后
--   `v_existing.owner_id('anon:…') <> p_owner_id(新账号)` → 返回
--   txn_taken_by_other（网关 iap.mjs:374 回 409），重放被拒。
--
-- 🔴 为什么用 CREATE OR REPLACE 覆盖，而不是改 0045/0037：
--   0045 与 0037 都已 applied 到生产，是**不可变历史记录**（改历史迁移=灾难）。
--   PL/pgSQL 函数体无法局部 patch，只能整段替换 → 本迁移把两个函数的完整新版
--   写出来，其余语句（身份取 auth.uid()、p_confirm 闸门、SECURITY DEFINER、
--   search_path、删 app_users、REVOKE/GRANT、NOTIFY pgrst）**逐字保留**，
--   tools/four-end-consistency.test.ts 护栏 9 逐条断言它们。
--
-- 🔴 维护纪律（延续 0045:41-44）：v_tables 仍是「含 owner_id 列的业务表」快照，
--   但**从 17 张降为 16 张** —— apple_transactions 由「删」改为「匿名化保留」。
--   今后新增含 owner_id 的表仍须同步该数组，否则删号留下孤儿个人信息；
--   护栏 9 的 EXPECTED_TABLES 已同步为 16 张基线。
--   ⚠️ 已知待办（不在本迁移范围，仅登记）：0046 的 xpay_transactions 与
--   0047 的 app_payment_transactions 同样含 owner_id 且**不在** v_tables 里
--   （二者建于 0045 之后），其 out_trade_no UNIQUE 幂等键存在同类风险；
--   二者均属 Android/小程序通道，需另立迁移评估，本迁移只处理 Apple IAP。
--
-- 幂等：CREATE OR REPLACE FUNCTION + 追踪表 UPSERT，可重复执行（0037/0045 同款）。
--   函数体内不含任何数据回填，重跑不改数据。
-- 执行：sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0056-apple-txn-anonymize.sql
--   🔴 绝不跑 deploy/deploy-gateway.sh（缺 IDENT_PEPPER → 全站身份永久失效）。
--   本迁移纯 SQL，不碰网关、不 restart、不 reload nginx。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ① 新版 delete_own_account：v_tables 去掉 apple_transactions + 匿名化 ──
--    与 0045:49-105 的差异只有三处（下方均标 🔴 0056）：
--      · v_tables 17 → 16 张（移除 'apple_transactions'）
--      · FOREACH 删表之后、删 app_users 之前，插入匿名化 UPDATE
--      · 返回值新增 anonymized_txn_rows（deleted_rows 仍只计真正被删的行）
CREATE OR REPLACE FUNCTION public.delete_own_account(p_confirm text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- 含 owner_id 的业务表全集（护栏 9 守护；新增表必须同步）
  -- 🔴 0056：apple_transactions 已移出本数组 —— 它改为「匿名化保留」，
  --   删除会释放 transaction_id UNIQUE 幂等键（见文件头「漏洞」段）。
  v_tables text[] := ARRAY[
    'ai_quota_claims', 'ai_usage', 'badges',
    'entitlements', 'exercise_logs', 'honey_ledger', 'invite_attempts',
    'invite_links', 'meal_entries', 'payment_orders', 'profiles',
    'quota_bonus', 'quota_bonus_newbie_retire_log', 'recipes',
    'water_logs', 'weight_logs'
  ];
  v_owner  text;
  v_tbl    text;
  v_n      integer;
  v_total  integer := 0;
  v_anon   integer := 0;   -- 🔴 0056：被匿名化（未删除）的交易行数
  v_ident  boolean := false;
BEGIN
  -- ① 身份：只认 PostgREST 由已验签 JWT 注入的 claims，绝不接受调用方传参
  v_owner := auth.uid();
  IF v_owner IS NULL OR btrim(v_owner) = '' THEN
    RAISE EXCEPTION 'unauthenticated: 删号需要有效的登录会话'
      USING ERRCODE = '42501';
  END IF;

  -- ② 服务端二次确认：前端两步确认 UI 不是安全边界
  IF p_confirm IS DISTINCT FROM 'DELETE_MY_ACCOUNT' THEN
    RAISE EXCEPTION 'invalid_confirmation: 删号确认令牌不正确'
      USING ERRCODE = '22023';
  END IF;

  -- ③ 逐表删除业务数据。表名来自硬编码数组（非外部输入），%I 再转义一层；
  --    owner_id 用 USING 参数化，杜绝拼接注入。任一表失败 → 整个事务回滚。
  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('DELETE FROM public.%I WHERE owner_id = $1', v_tbl) USING v_owner;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
  END LOOP;

  -- ④′ 🔴 0056：Apple 交易行【匿名化保留】而非删除
  --   目的：保住 transaction_id UNIQUE 幂等键（防删号后用旧收据对新账号重放核销），
  --   同时切断与真实身份的关联（PIPL 第 47 条删除权）。owner_id 无外键（全库实测
  --   零 REFERENCES），md5() 是 PG 内置单向哈希、不可逆；能读到本表的只有 SECDEF
  --   函数（RLS FORCE + REVOKE dbee_app），故不加盐不构成实际反查风险。
  --   🔴 计数从 deleted_rows 分离为 anonymized_txn_rows —— 这些行【没有】被删除，
  --     混进 deleted_rows 会让验收数字说谎。
  --   🔴 顺序不可颠倒：必须在下面删 app_users 之前、且与其同处一个事务，
  --     否则「身份已删但幂等键也已释放」的窗口仍然存在。
  UPDATE public.apple_transactions
     SET owner_id = 'anon:' || md5(v_owner)
   WHERE owner_id = v_owner;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_anon := v_n;

  -- ④ 最后删身份行：删掉后该手机号/邮箱可重新注册，且旧 JWT 的 sub 不再对应任何用户。
  --    只有 SECURITY DEFINER(属主 postgres) 能越过 FORCE RLS + 无 DELETE 授权的限制。
  DELETE FROM public.app_users WHERE owner_id = v_owner;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_ident := v_n > 0;

  -- ⑤ 不回传 owner_id（避免响应里泄漏身份标识），只回可验收的计数
  RETURN jsonb_build_object(
    'ok', true,
    'deleted_rows', v_total,
    'anonymized_txn_rows', v_anon,
    'identity_removed', v_ident
  );
END;
$fn$;

COMMENT ON FUNCTION public.delete_own_account(text) IS
  '0045 建 / 0056 改：按 auth.uid() 事务删除 16 张业务表 + app_users 身份行；'
  'apple_transactions 不删，改为 owner_id = ''anon:''||md5(原值) 匿名化保留，'
  '以保住 transaction_id UNIQUE 幂等键（防旧收据重放核销）。'
  '需 p_confirm=DELETE_MY_ACCOUNT；仅 authenticated 可调用；SECDEF(postgres) 越过 FORCE RLS。'
  '新增含 owner_id 的表必须同步函数内 v_tables（护栏 9 拦截）。';

-- ── 授权：PG 默认把新函数 EXECUTE 给 PUBLIC，必须显式收回 ──────────────
--    （CREATE OR REPLACE 会保留原有授权，这里再写一遍是 0045 的既定纪律：
--     确保任何环境重复执行后权限口径都一致。）
REVOKE ALL ON FUNCTION public.delete_own_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_own_account(text) TO authenticated;

-- PostgREST schema cache 立即看到新函数，不必等自动 reload 轮询
NOTIFY pgrst, 'reload schema';

-- ── ② 新版 settle_apple_purchase：webhook owner 反查排除匿名行 ─────────
--    与 0037:119-276 的差异**只有一行**（下方标 🔴 0056）：反查 owner 时加
--    `AND owner_id NOT LIKE 'anon:%'`。其余逐字保留 —— 尤其幂等第一闸
--    （0037:147-166）必须原样，它正是本修复的生效机制。
CREATE OR REPLACE FUNCTION public.settle_apple_purchase(
  p_owner_id          text,   -- 客户端路径=JWT sub；webhook 路径传 NULL（内部反查）
  p_order_no          text,   -- 可空；'restore-…' 前缀=恢复购买
  p_product_id        text,   -- Apple 报文 product_id（非客户端自报）
  p_transaction_id    text,
  p_original_txn_id   text,
  p_expires_ms        text,   -- Apple expires_date_ms 字符串；可空（买断）
  p_purchase_ms       text,   -- Apple purchase_date_ms 字符串；可空
  p_environment       text,
  p_receipt_sha256    text    -- 收据摘要；webhook 路径可空
)
RETURNS json
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner     text;
  v_prod      payment_products%ROWTYPE;
  v_existing  apple_transactions%ROWTYPE;
  v_ent_id    bigint;
  v_ent_plan  text;
  v_ent_until timestamptz;
  v_expires   timestamptz;
  v_purchased timestamptz;
  v_order     payment_orders%ROWTYPE;
BEGIN
  -- ── 幂等第一闸：这笔交易是否已核销过 ──
  -- 🔴 0056 后本闸是**唯一**的重放防线：删号不再释放 transaction_id，
  --   旧收据重放到新账号会命中匿名行 → 下方 owner 不符 → txn_taken_by_other(409)。
  SELECT * INTO v_existing FROM apple_transactions
   WHERE transaction_id = p_transaction_id;

  IF FOUND THEN
    -- webhook 续订通知会带**新** transaction_id，走不到这里；
    -- 走到这里的是「同一交易重复提交」（客户端重试 / 恢复购买重放）。
    IF p_owner_id IS NOT NULL AND v_existing.owner_id <> p_owner_id THEN
      -- 换账号重放他人收据：拒绝（网关据此回 409 并 warn 留痕）
      -- 0056 后也覆盖「本人删号重注册后重放自己的旧收据」：
      -- 匿名占位值 'anon:…' 必不等于新账号 owner_id → 同样拒绝。
      RETURN json_build_object('error', 'txn_taken_by_other');
    END IF;
    -- 同 owner 重复核销：幂等返回成功 + 当前权益（不重复顺延！）
    SELECT id, plan, pro_until INTO v_ent_id, v_ent_plan, v_ent_until
      FROM entitlements WHERE owner_id = v_existing.owner_id;
    RETURN json_build_object(
      'settled', true, 'duplicate', true,
      'owner_id', v_existing.owner_id,
      'plan', COALESCE(v_ent_plan, 'free'),
      'pro_until', v_ent_until
    );
  END IF;

  -- ── owner 解析：webhook 路径（p_owner_id NULL）按订阅归组反查 ──
  v_owner := p_owner_id;
  IF v_owner IS NULL THEN
    SELECT owner_id INTO v_owner FROM apple_transactions
     WHERE original_transaction_id = p_original_txn_id
       AND owner_id NOT LIKE 'anon:%'   -- 🔴 0056：已删号用户的匿名行不能作为续订归属
     ORDER BY settled_at ASC LIMIT 1;
    IF v_owner IS NULL THEN
      -- 用户从未在客户端核销过这笔订阅（或已删号）→ 无人可发，只留痕
      -- （网关落 apple_notifications：processed=false, error='owner_unresolved'）
      RETURN json_build_object('error', 'owner_unresolved');
    END IF;
  END IF;

  -- ── 商品映射：payment_products 是唯一事实源 ──
  SELECT * INTO v_prod FROM payment_products
   WHERE product_id = p_product_id AND active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('error', 'unknown_product');
  END IF;

  -- ── 时间解析（Apple 报文是毫秒字符串）──
  IF p_expires_ms IS NOT NULL AND p_expires_ms ~ '^\d+$' THEN
    v_expires := to_timestamp(p_expires_ms::bigint / 1000.0);
  END IF;
  IF p_purchase_ms IS NOT NULL AND p_purchase_ms ~ '^\d+$' THEN
    v_purchased := to_timestamp(p_purchase_ms::bigint / 1000.0);
  END IF;

  -- ── 记录交易（先于权益写：UNIQUE 冲突 = 并发重复核销，整个事务回滚）──
  INSERT INTO apple_transactions
    (transaction_id, original_transaction_id, owner_id, product_id, plan,
     order_no, expires_at, purchased_at, environment, receipt_sha256)
  VALUES
    (p_transaction_id, COALESCE(p_original_txn_id, p_transaction_id), v_owner,
     p_product_id, v_prod.plan, p_order_no, v_expires, v_purchased,
     p_environment, p_receipt_sha256);

  -- ── 权益落库（与 0029 同款语义，但订阅到期以 Apple expires 为权威）──
  SELECT id, plan, pro_until INTO v_ent_id, v_ent_plan, v_ent_until
    FROM entitlements WHERE owner_id = v_owner;

  IF v_prod.plan = 'lifetime' THEN
    -- 买断：直接覆盖为 lifetime（已有 lifetime 则幂等无操作）
    INSERT INTO entitlements (owner_id, plan, pro_until, source)
    VALUES (v_owner, 'lifetime', NULL, 'apple')
    ON CONFLICT (owner_id) DO UPDATE
      SET plan = 'lifetime', pro_until = NULL, source = 'apple', updated_at = now();
  ELSE
    -- pro 订阅：
    --   · 有 expires（自动续期商品的常态）→ pro_until = GREATEST(现值, Apple 到期)
    --     GREATEST 保证：乱序到达的旧续订通知不会把更晚的到期时间拉回去。
    --   · 无 expires（理论上不出现，防御分支）→ 按 months 顺延（0029 旧语义）。
    IF v_expires IS NOT NULL THEN
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (v_owner, 'pro', v_expires, 'apple')
      ON CONFLICT (owner_id) DO UPDATE
        SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
            pro_until = CASE
              WHEN entitlements.plan = 'lifetime' THEN NULL  -- 买断不降级
              ELSE GREATEST(COALESCE(entitlements.pro_until, now()), v_expires)
            END,
            source = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.source ELSE 'apple' END,
            updated_at = now();
    ELSE
      INSERT INTO entitlements (owner_id, plan, pro_until, source)
      VALUES (v_owner, 'pro',
              now() + make_interval(months => COALESCE(v_prod.months, 1)), 'apple')
      ON CONFLICT (owner_id) DO UPDATE
        SET plan = CASE WHEN entitlements.plan = 'lifetime' THEN 'lifetime' ELSE 'pro' END,
            pro_until = CASE
              WHEN entitlements.plan = 'lifetime' THEN NULL
              WHEN entitlements.plan = 'pro' AND entitlements.pro_until > now()
                THEN entitlements.pro_until + make_interval(months => COALESCE(v_prod.months, 1))
              ELSE now() + make_interval(months => COALESCE(v_prod.months, 1))
            END,
            source = CASE WHEN entitlements.plan = 'lifetime' THEN entitlements.source ELSE 'apple' END,
            updated_at = now();
    END IF;
  END IF;

  -- ── 订单核销（仅客户端购买路径；owner 与商品都对得上才动订单）──
  IF p_order_no IS NOT NULL AND left(p_order_no, 8) <> 'restore-' THEN
    SELECT * INTO v_order FROM payment_orders WHERE order_no = p_order_no;
    IF FOUND
       AND v_order.owner_id = v_owner
       AND v_order.product_id = p_product_id
       AND v_order.status = 'pending' THEN
      UPDATE payment_orders
         SET status = 'paid',
             provider_txn_id = p_transaction_id,
             -- 只存摘要（见 0037 文件头「为什么收据只存摘要」）
             receipt_payload = 'sha256:' || COALESCE(p_receipt_sha256, ''),
             updated_at = now()
       WHERE id = v_order.id;
    END IF;
    -- owner/商品不符或订单不存在：不动订单（留 pending 供人工对账），
    -- 权益已按 Apple 报文如实发放 —— 收据真实性由网关验签背书。
  END IF;

  SELECT plan, pro_until INTO v_ent_plan, v_ent_until
    FROM entitlements WHERE owner_id = v_owner;

  RETURN json_build_object(
    'settled', true, 'duplicate', false,
    'owner_id', v_owner,
    'plan', COALESCE(v_ent_plan, 'free'),
    'pro_until', v_ent_until
  );
END;
$$;

-- ── ③ settle 函数授权：与 0037:360-377 同口径（CREATE OR REPLACE 保留原授权，
--       这里重述以确保任何环境重复执行后一致）─────────────────────────────
REVOKE ALL ON FUNCTION public.settle_apple_purchase(text,text,text,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated, dbee_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbee_web') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.settle_apple_purchase(text,text,text,text,text,text,text,text,text) FROM dbee_web';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.settle_apple_purchase(text,text,text,text,text,text,text,text,text) TO dbee_app;

-- 注意：**不**对 settle_apple_purchase 做 PostgREST reload 之外的额外动作。
--   该函数只授 dbee_app，PostgREST(dbee_web) 看不见它；上面 NOTIFY 是给
--   delete_own_account（前端 RPC）用的。

-- ── ④ 登记迁移追踪表（0034 纪律；DO 块兼容未应用 0034 的环境）──────────
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0056: public.schema_migrations 不存在（0034 未应用），跳过追踪表更新';
    RETURN;
  END IF;
  INSERT INTO public.schema_migrations (version, name, status, applied_by, note)
  VALUES ('0056', 'apple-txn-anonymize', 'applied', 'self',
          'P1 资损修复：delete_own_account 不再删 apple_transactions（v_tables 17→16），'
          '改为 owner_id=''anon:''||md5(原值) 匿名化保留 → transaction_id UNIQUE 幂等键不释放，'
          '堵死「删号→重注册→旧收据重放核销」；settle_apple_purchase 的 webhook owner 反查'
          '加 owner_id NOT LIKE ''anon:%''，防给幽灵 owner 发孤儿权益')
  ON CONFLICT (version, name) DO UPDATE SET
    status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证（只读，可重复执行）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) 函数体已生效（v_tables 只剩 16 张，且含匿名化 UPDATE）：
--    SELECT pg_get_functiondef('public.delete_own_account(text)'::regprocedure)
--      LIKE '%''apple_transactions''%' AS still_in_vtables,        -- 期望 f
--           pg_get_functiondef('public.delete_own_account(text)'::regprocedure)
--      LIKE '%''anon:'' || md5(v_owner)%' AS anonymizes;            -- 期望 t
-- 2) 16 张业务表字面量齐（护栏 9 同源清单）：
--    SELECT count(*)::int FROM unnest(ARRAY['ai_quota_claims','ai_usage','badges',
--      'entitlements','exercise_logs','honey_ledger','invite_attempts','invite_links',
--      'meal_entries','payment_orders','profiles','quota_bonus',
--      'quota_bonus_newbie_retire_log','recipes','water_logs','weight_logs']) AS t
--     WHERE pg_get_functiondef('public.delete_own_account(text)'::regprocedure)
--           LIKE '%''' || t || '''%';                              -- 期望 16
-- 3) settle 反查已排除匿名行：
--    SELECT pg_get_functiondef('public.settle_apple_purchase(text,text,text,text,text,text,text,text,text)'::regprocedure)
--      LIKE '%owner_id NOT LIKE ''anon:%''%';                       -- 期望 t
-- 4) 权限口径未变（delete_own_account 仅 authenticated；settle 仅 dbee_app）：
--    SELECT grantee, privilege_type FROM information_schema.routine_privileges
--     WHERE routine_name IN ('delete_own_account','settle_apple_purchase');
-- 5) 端到端幂等验收（临时账号，绝不碰审核演示账户；范式见 tools/server-apply-0045.sh ⑥）：
--    a. 造 TEST- 账号 + 插一行 apple_transactions(transaction_id='txn-0056-test', owner_id=TEST)
--    b. 调 delete_own_account RPC → 期望 identity_removed=true、anonymized_txn_rows=1
--    c. SELECT owner_id FROM apple_transactions WHERE transaction_id='txn-0056-test'
--       → 期望 'anon:'||md5(原 owner_id)，行仍在、transaction_id 未变
--    d. 以 dbee_app 调 settle_apple_purchase(新 owner, …, 'txn-0056-test', …)
--       → 期望 {"error":"txn_taken_by_other"}（幂等键未被释放 = 修复生效）
--    e. 以 dbee_app 调 settle_apple_purchase(NULL, …, 新 txn, orig='txn-0056-test', …)
--       → 期望 {"error":"owner_unresolved"}（不给幽灵 owner 发权益）
--    f. 清理：DELETE FROM apple_transactions WHERE transaction_id LIKE 'txn-0056-test%';
-- ═══════════════════════════════════════════════════════════════════════
-- 回滚（本迁移只覆盖两个函数，无表结构/数据变更）
-- ═══════════════════════════════════════════════════════════════════════
-- 备份（执行本迁移前）：
--   sudo -u postgres pg_dump -d dbee -F c -f /var/backups/dbee/backup-before-0056.dump
-- 精确回滚 = 用 0045 与 0037 的原文重放两个函数（它们都是 CREATE OR REPLACE，
--   重放即恢复旧版；旧版权限口径与本迁移一致，无需额外 GRANT/REVOKE）：
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0045-account-deletion.sql
--   sudo -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f db/migrations/0037-apple-iap-settlement.sql
--   DELETE FROM public.schema_migrations WHERE version='0056';
--   ⚠️ 回滚会**重新打开**本文件头描述的资损口子，仅在 0056 本身有缺陷时才做。
--   ⚠️ 已被匿名化的行不会因回滚而复原（md5 不可逆）—— 那些 owner 已删号，
--      无恢复需求；其 transaction_id 仍留在表里，只是幂等语义回到 0045 的口径。
-- ═══════════════════════════════════════════════════════════════════════
