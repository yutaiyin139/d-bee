ALTER TABLE public.redeem_codes
  ADD CONSTRAINT redeem_codes_plan_chk CHECK (plan IN ('pro', 'lifetime'));
