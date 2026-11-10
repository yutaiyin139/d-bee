#!/usr/bin/env bash
# 只读验证：确认刚发的月卡测试码在生产库里**可用且形状正确**，且不烧码。
#
# 🔴 为什么不直接调 redeem_by_code() 验证：那会真的核销掉这张码（used_by 被写），
#   用户就没得测了。改用「非破坏性等价验证」：把明文码传进服务器，在库内现算
#   encode(digest(code,'sha256'),'hex') 与 code_hash 比对 —— 这正是
#   redeem_by_code 的第一步匹配逻辑，所以「匹配成功」= 用户输入这个码必然命中该行。
#   输出只有布尔值/形状摘要，**码明文与哈希都不落日志**。
#
# 🔴 码怎么进来：dbee-ssh.py 无 stdin/env 透传，render_text 只认它自己的占位符表，
#   所以由调用方在**本地临时副本**里做一次替换（副本写在 gitignore 的 release/，用后即删）。
#   本文件在 git 里永远只留占位符，不含任何真实码。
#
# 🔴🔴 替换纪律（第一版就是这么自己绊倒的）：占位符在本文件里**只能出现一次**，
#   就在下面 CODE= 那一行。曾经它同时出现在注释与 `case` 的模式里，
#   sed 把 case 的模式也换成了真码 → $CODE 命中自己的守卫 → 误报「未替换」。
#   故守卫改为**按码的形状校验**（16 位 Crockford base32），不再拿占位符字面量比对。
# 用后即删。
set -uo pipefail
DB=dbee

CODE="__VERIFY_CODE_TOKEN__"
if ! printf '%s' "$CODE" | grep -Eq '^[0-9A-Z]{16}$'; then
  echo "✗ 码未正确注入（形状不是 16 位 0-9A-Z），拒绝执行 —— 避免拿占位符字面量去查库造成误判"
  exit 2
fi

# 只读，可抑制 stderr；-f heredoc 通道保证 :'codev' 会被插值（-c 多语句不会！）
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }
SQLPATH="/tmp/verify-code-$$.sql"
trap 'rm -f "$SQLPATH"' EXIT

cat > "$SQLPATH" <<'VERIFY_EOF'
\set ON_ERROR_STOP on
SELECT 'hash_match_rows=' || count(*)
  FROM public.redeem_codes
 WHERE code_hash = encode(digest(:'codev', 'sha256'), 'hex');

SELECT 'row_shape: plan=' || plan
       || ' months=' || coalesce(months::text,'NULL')
       || ' used=' || (CASE WHEN used_by IS NULL THEN 'no' ELSE 'YES' END)
       || ' expires=' || coalesce(to_char(expires_at,'YYYY-MM-DD HH24:MI'),'never')
       || ' expired_now=' || (CASE WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'YES' ELSE 'no' END)
       || ' days_left=' || coalesce(floor(extract(epoch FROM (expires_at - now()))/86400)::text,'inf')
       || ' note=' || coalesce(note,'<null>')
  FROM public.redeem_codes
 WHERE code_hash = encode(digest(:'codev', 'sha256'), 'hex');
VERIFY_EOF
sed -i "s/\r$//" "$SQLPATH" 2>/dev/null || true

echo "=== 非破坏性验证（码明文/哈希均不输出）==="
SUDO -u postgres psql -d $DB -tA -v codev="$CODE" -f "$SQLPATH"
RC=$?
echo "=== psql exit=$RC ==="

echo
echo "=== 库存汇总（plaintext_leftover 必须为 0，否则说明有码明文漏进库里）==="
SUDO -u postgres psql -d $DB -tA -F' | ' -c "
select 'total='||count(*),
       'unused='||count(*) filter (where used_by is null),
       'plaintext_leftover='||count(*) filter (where code is not null)
from redeem_codes"

echo
echo "=== 核销函数契约仍在（0048 后应返回 text）==="
SUDO -u postgres psql -d $DB -tA -c "
select 'redeem_by_code_returns=' || t.typname
from pg_proc p join pg_type t on t.oid = p.prorettype
where p.proname = 'redeem_by_code'"
rm -f "$SQLPATH"
exit 0
