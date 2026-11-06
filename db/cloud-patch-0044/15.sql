COMMENT ON FUNCTION public.redeem_by_code(text) IS
  '0044 · 兑换码核销：按码上 plan/months 发放（pro 顺延、lifetime 置顶不降级）。'
  '返回值恒为 ok/used/bad（刻意不用 JSON，见 0044 文件头兼容性说明）。';
