#!/usr/bin/env bash
# 清理 2026-11-10 发码事故留下的孤儿行（有 code_hash、无明文、不可兑换、不可追溯）。
# 用后即删。
#
# 🔴 为什么删它是安全的（三条独立理由）：
#   1) 该行 code IS NULL 且 code_hash 非空 —— 0048 起库内只存哈希，而这张码的
#      **明文从未落盘**（旧工具在 INSERT 后才写文件，误判失败即 return），
#      全世界没有任何人/任何文件知道它对应的码 → 不可能被兑换，删掉不损失任何权益。
#   2) used_by IS NULL —— 从未产生过会员权益，删除不会让任何用户掉档。
#   3) 0048 已让 expires_at 生效，该行本来也会在 2026-11-17 自动过期失效。
#
# 🔴 删除条件刻意做成「四重与」而不是 note LIKE，防止误伤同批次的正常码：
#   id 精确 + used_by IS NULL + code IS NULL + note 全等。
#   实测这四条在生产上命中且仅命中 1 行（diag: all_four=1）。
#
# 🔴🔴 两个必须记住的实现坑（第一版就是这么静默失败的）：
#   A) **`psql -c` 里放多条 SQL（含分号分隔的 DELETE; SELECT;）会绕过 psql 的
#      脚本处理器 → `:'var'` 不做插值 → 服务端收到字面 `:'idv'` 直接语法错误**。
#      需要插值时：要么 -c 里只放**一条**语句，要么像本脚本这样走 `-f` + heredoc
#      （与 tools/gen-redeem-codes.mjs 同一手法，该手法已验证可用）。
#   B) **sudo 的 2>/dev/null 会吞掉 psql 报错**，于是「什么都没打印」看起来像
#      成功空操作。变更类语句一律不抑制 stderr，并显式检查退出码。
#   另：id 列真实类型是 **bigint**（不是 int），别按 int 传。
set -uo pipefail
DB=dbee
# 🔴 刻意**不给默认值**：本脚本首跑的目标行 id=4 已被清理，若留 4 作默认值，
#   将来有人复用时 id=4 可能已是另一张正常码 → 误删。必须显式传参，
#   且四重条件仍会兜底（只删「未使用 + 无明文 + note 全等」的行）。
#   用法：TARGET_ID=7 TARGET_NOTE='测试码-xxx-月卡' bash deploy/clean-orphan-test-code.sh
TARGET_ID="${TARGET_ID:?必须显式传 TARGET_ID（不给默认值，防复用旧 id 误删他行）}"
TARGET_NOTE="${TARGET_NOTE:?必须显式传 TARGET_NOTE（与 id 双条件，防误删）}"
case "$TARGET_ID" in
  ''|*[!0-9]*) echo "✗ TARGET_ID 必须是纯数字（id 列为 bigint）：收到 '$TARGET_ID'"; exit 2;;
esac
SQLPATH="/tmp/clean-orphan-$$.sql"

# 只读查询可以抑制 stderr（噪音大）；变更语句用 SUDO_V 保留 stderr。
SUDO()   { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }
SUDO_V() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }

trap 'rm -f "$SQLPATH"' EXIT

echo "=== BEFORE ==="
SUDO -u postgres psql -d $DB -tA -F' | ' -c "
select 'total='||count(*),
       'unused='||count(*) filter (where used_by is null),
       'orphan_like='||count(*) filter (where used_by is null and code is null)
from redeem_codes"

echo
echo "=== 生成 SQL（-f 通道，保证 :'var' 会被插值）==="
cat > "$SQLPATH" <<'CLEAN_ORPHAN_EOF'
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM public.redeem_codes
 WHERE id = :'idv'::bigint
   AND used_by IS NULL
   AND code IS NULL
   AND note = :'notev';
COMMIT;
SELECT 'CLEAN_OK rows_now=' || count(*) FROM public.redeem_codes;
CLEAN_ORPHAN_EOF
sed -i "s/\r$//" "$SQLPATH" 2>/dev/null || true

# 本脚本整体由 dbee-ssh.py run 送到服务器执行，所以上面的 heredoc 是在**远端**
# /tmp 生成 SQL 文件（$$ 为远端 bash 的 PID），随即 psql -f 就地执行，trap 负责清理。
SUDO_V -u postgres psql -d $DB -tA \
  -v idv="$TARGET_ID" -v notev="$TARGET_NOTE" -f "$SQLPATH"
RC=$?
echo "=== psql exit=$RC ==="
if [ $RC -ne 0 ]; then echo "✗ 清理失败（见上方真实报错，未被吞掉）"; exit $RC; fi

echo
echo "=== AFTER（total 应为 0）==="
SUDO -u postgres psql -d $DB -tA -F' | ' -c "
select 'total='||count(*), 'unused='||count(*) filter (where used_by is null) from redeem_codes"

echo
echo "=== 剩余行清单（应为空）==="
SUDO -u postgres psql -d $DB -tA -F' | ' -c "
select 'id='||id, 'plan='||plan, 'months='||coalesce(months::text,'NULL'), 'note='||coalesce(note,'<null>')
from redeem_codes order by id"
echo "(以上无 id= 行 = 表已清空)"
rm -f "$SQLPATH"
exit 0
