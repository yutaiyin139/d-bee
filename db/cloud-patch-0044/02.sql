ALTER TABLE public.redeem_codes
  ADD COLUMN IF NOT EXISTS months integer;
