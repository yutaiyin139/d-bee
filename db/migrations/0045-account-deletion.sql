-- ═══════════════════════════════════════════════════════════════════════
-- 0045 · App 内真删号（Apple Guideline 5.1.1(v) / PIPL 第 47 条删除权）
-- ═══════════════════════════════════════════════════════════════════════
-- 背景（2026-11-07 实测）：
--   `src/pages/ProfileScreen.tsx` 的「注销账号」此前是**降级实现** —— 只清空 4 张
--   记录表 + 登出 + 让用户「联系客服」。云库时期 SDK 无 deleteUser，尚可解释；
--   但切到自建 PG 后，网关同样**没有**任何删号端点，且 0031 明确写了
--   「刻意不给 DELETE：身份记录只应软失效」。生产实测 app_users 是
--   FORCE ROW LEVEL SECURITY + ACL `dbee_app=arw/postgres`（无 d），
--   即网关连接角色物理上删不掉身份行。Apple 5.1.1(v) 要求「支持账号创建的 App
--   必须在 App 内提供账号删除」，转客服通常不满足 → 提审风险。
--
-- 🔴 为什么用 PostgREST RPC 而不是新增网关端点：
--   ① 项目已有成熟范式：20+ 个 SECURITY DEFINER RPC（0039/0040/0044）由前端
--      经 `/.cloud/database/rest/rpc/<fn>` 直接调用，PostgREST 注入
--      `request.jwt.claims` → `auth.uid()` 拿到调用者身份。
--   ② 生产网关跑的是 10-29 旧代码（实测 /opt/dbee-gateway/lib/app.mjs 无
--      login-wechat，进程 11-02 启动）。改网关就得整套 lib 同步 + restart，
--      而 `deploy-gateway.sh` 有 IDENT_PEPPER 重置地雷，风险远大于收益。
--      走 RPC **完全不碰网关**：零代码部署、零重启、零 nginx reload。
--   ③ 删号必须是事务内跨 18 张表的原子操作；放在数据库函数里比放在 Node 端
--      逐条 DELETE（网络往返 18 次、中途失败留半成品）正确得多。
--
-- 权限模型（三层）：
--   · 函数 SECURITY DEFINER，属主 = postgres（超管 + 表属主），故能删
--     FORCE RLS 且 REVOKE 掉 DELETE 的 app_users，也能删其余 17 张业务表。
--   · 函数**不接受 owner_id 参数**，只信 PostgREST 验签后注入的 auth.uid()。
--     调用者无法指定删谁 → 不存在「传别人的 id 删别人」的越权面。
--   · REVOKE PUBLIC/anon EXECUTE（PG 默认给 PUBLIC），只授 authenticated。
--     未登录调用直接被 PostgREST 挡在函数外（404/401），不会进函数体。
--   · p_confirm 是服务端二次闸门：不信任前端的确认 UI，防 SDK 误调/请求回放
--     造成不可逆删除。值不对一律抛异常、一行不删。
--
-- ⚠️ 已知权衡（如实记录，非遗漏）：
--   apple_transactions 行一并删除 → 该用户历史 Apple 交易号（transaction_id
--   UNIQUE 幂等键）被释放，理论上其本人可用旧收据对新账号重新核销一次。
--   当前 `APPLE_*` env 全缺、付费协议未 Active、IAP 未启用，风险为 0；
--   若首发启用 IAP，应评估改为「保留交易行 + owner_id 匿名化」。
--   之所以现在选择删除：PIPL 删除权优先，且保留 owner_id 会留下身份关联。
--
-- 🔴 维护纪律：`v_tables` 是本库**含 owner_id 列的全部业务表**快照
--   （2026-11-07 生产 information_schema 实测 18 张，含 app_users；此处列 17 张业务表，
--   app_users 单独在函数末尾删）。**新增任何含 owner_id 的表必须同步此数组**，
--   否则会留下孤儿个人信息；`tools/four-end-consistency.test.ts` 护栏 9 会拦截。
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_own_account(p_confirm text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- 含 owner_id 的业务表全集（护栏 9 守护；新增表必须同步）
  v_tables text[] := ARRAY[
    'ai_quota_claims', 'ai_usage', 'apple_transactions', 'badges',
    'entitlements', 'exercise_logs', 'honey_ledger', 'invite_attempts',
    'invite_links', 'meal_entries', 'payment_orders', 'profiles',
    'quota_bonus', 'quota_bonus_newbie_retire_log', 'recipes',
    'water_logs', 'weight_logs'
  ];
  v_owner  text;
  v_tbl    text;
  v_n      integer;
  v_total  integer := 0;
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

  -- ④ 最后删身份行：删掉后该手机号/邮箱可重新注册，且旧 JWT 的 sub 不再对应任何用户。
  --    只有 SECURITY DEFINER(属主 postgres) 能越过 FORCE RLS + 无 DELETE 授权的限制。
  DELETE FROM public.app_users WHERE owner_id = v_owner;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_ident := v_n > 0;

  -- ⑤ 不回传 owner_id（避免响应里泄漏身份标识），只回可验收的计数
  RETURN jsonb_build_object(
    'ok', true,
    'deleted_rows', v_total,
    'identity_removed', v_ident
  );
END;
$fn$;

COMMENT ON FUNCTION public.delete_own_account(text) IS
  '0045 App 内真删号：按 auth.uid() 事务删除 17 张业务表 + app_users 身份行；'
  '需 p_confirm=DELETE_MY_ACCOUNT；仅 authenticated 可调用；SECDEF(postgres) 越过 FORCE RLS。'
  '新增含 owner_id 的表必须同步函数内 v_tables（护栏 9 拦截）。';

-- ── 授权：PG 默认把新函数 EXECUTE 给 PUBLIC，必须显式收回 ──────────────
REVOKE ALL ON FUNCTION public.delete_own_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_own_account(text) TO authenticated;

-- PostgREST schema cache 立即看到新函数，不必等自动 reload 轮询
NOTIFY pgrst, 'reload schema';

-- ── 登记迁移追踪表（0034 纪律）────────────────────────────────────────
INSERT INTO public.schema_migrations
       (version, name, status, applied_by, note)
VALUES ('0045','account-deletion','applied','self',
        'App 内真删号 RPC(SECDEF)：auth.uid() 事务删 17 业务表 + app_users；'
        'p_confirm 服务端二次闸门；REVOKE PUBLIC/anon，仅 authenticated 可调用；'
        'Apple 5.1.1(v) / PIPL 第 47 条')
ON CONFLICT (version, name) DO UPDATE SET
  status = EXCLUDED.status, applied_by = EXCLUDED.applied_by, note = EXCLUDED.note;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 验证（只读，可重复执行）
-- ═══════════════════════════════════════════════════════════════════════
-- 1) 函数存在且是 SECDEF、属主 postgres：
--    SELECT prosecdef, proowner::regrole, pg_get_function_result(oid)
--      FROM pg_proc WHERE oid='public.delete_own_account(text)'::regprocedure;
--    期望：t | postgres | jsonb
-- 2) 权限只剩 authenticated（不应有 PUBLIC/anon 行）：
--    SELECT grantee, privilege_type FROM information_schema.routine_privileges
--     WHERE routine_name='delete_own_account';
-- 3) 表清单覆盖（应与生产实测一致，18 张含 owner_id，其中 app_users 单独删）：
--    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='owner_id' AND NOT a.attisdropped
--     WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1;
-- 4) 未登录调用应被挡（anon 无 EXECUTE）：
--    curl -X POST https://d-bee.cn/.cloud/database/rest/rpc/delete_own_account \
--      -H 'content-type: application/json' -d '{"p_confirm":"DELETE_MY_ACCOUNT"}'
-- 5) 端到端功能验收见 tools/server-apply-0045.sh 的 ⑥ 段（临时账号，绝不碰审核演示账户）。
-- ═══════════════════════════════════════════════════════════════════════
