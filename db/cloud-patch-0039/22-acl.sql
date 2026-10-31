-- 云库补丁 0039 · ACL 收口（合并 14 条 REVOKE/GRANT 为单个 DO 块）
--
-- 为什么单独合并：MCP db_exec_sql 单次不支持多语句，逐条要 14 次调用；
-- DO 块本身是「一条语句」，内部可 EXECUTE 多次，故 1 次调用搞定。
--
-- 实测发现（2026-10-31）：云库 consume_photo_quota 的 proacl 含 `=X/...`
-- 即 **PUBLIC 可执行**（anon 角色也能调），其余 6 个函数只有 authenticated。
-- 这里对全部 7 个函数统一 REVOKE ALL FROM PUBLIC, anon 再精确 GRANT，
-- 顺带把那个多余的 PUBLIC 授权收掉。
DO $$
DECLARE
  fns text[] := ARRAY[
    'public.grant_honey(text,text,integer,integer)',
    'public.grant_photo_bonus(text,text,integer,integer)',
    'public.consume_ai_quota(date,text,integer,integer)',
    'public.consume_photo_quota(date,integer)',
    'public.get_photo_quota(integer)',
    'public.redeem_honey(text)',
    'public.settle_invite_checkin()'
  ];
  f text;
BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;
