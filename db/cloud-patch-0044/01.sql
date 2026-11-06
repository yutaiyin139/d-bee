ALTER TABLE public.redeem_codes
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'lifetime';
