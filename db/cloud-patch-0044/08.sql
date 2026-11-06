ALTER TABLE public.redeem_codes
  ADD CONSTRAINT redeem_codes_months_chk CHECK (
    (plan = 'lifetime' AND months IS NULL)
    OR (plan = 'pro' AND months IS NOT NULL AND months > 0 AND months <= 1200)
  );
