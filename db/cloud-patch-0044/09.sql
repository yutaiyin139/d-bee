CREATE INDEX IF NOT EXISTS redeem_codes_unused_idx
  ON public.redeem_codes (plan, created_at) WHERE used_by IS NULL;
