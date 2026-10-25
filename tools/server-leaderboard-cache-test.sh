#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-leaderboard-cache-test.sh · 生产库 leaderboard() 缓存命中实测
# ═══════════════════════════════════════════════════════════════════════
# 由 deploy/dbee-ssh.py run 调用。对库的写入仅限 leaderboard_cache（该表
# 本来就是运行时缓存，函数正常被调用时也会写入）；测试结束删除缓存行，
# 恢复到迁移刚应用完的初始状态。不碰任何业务表。
#
# 验证点：
#   1) 首调（缓存空）→ 全量重算 + 写缓存（computed_at 落盘）
#   2) 二调（2 秒后）→ 命中缓存：computed_at 不变，返回结构一致
#   3) my 部分实时：返回的 my.streak 与库内直算 _lb_compute_streak 一致
#   4) 未登录 → error=not_authenticated，且不会用缓存掩盖鉴权
#   5) authenticated 直查缓存表 → permission denied
#   6) 缓存行清理（测试后 DELETE，恢复初始状态）
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
PSQL_SU() { SUDO -u postgres psql -d dbee -tA "$@"; }
Q()  { PSQL_SU -c "$1" 2>/dev/null | head -1; }
QL() { PSQL_SU -c "$1" 2>/dev/null | tail -1; }

FAIL=0
c() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1（实测=${2:-<空>}，期望=$3）"; FAIL=$((FAIL+1)); fi; }

echo "═══════════════════════════════════════════════════════════════════"
echo " leaderboard() 缓存实测  $(date '+%F %T %Z')"
echo "═══════════════════════════════════════════════════════════════════"

# 取一个有饮食记录的真实用户（只读其 owner_id，昵称已脱敏后才会出现在返回里）
UID_T=$(Q "SELECT owner_id FROM public.meal_entries GROUP BY owner_id ORDER BY count(*) DESC LIMIT 1;")
[ -n "$UID_T" ] || { echo "✗ meal_entries 无数据，无法实测"; exit 1; }
echo "样本用户：owner=<${UID_T:0:6}…>"

# 初始状态：缓存应为空（刚应用完 0040 或上次测试已清理）
Q "DELETE FROM public.leaderboard_cache WHERE id=1;" >/dev/null

echo "── 1) 首调：全量重算 + 写缓存 ──"
R1=$(QL "SELECT set_config('request.jwt.claims','{\"sub\":\"$UID_T\",\"role\":\"authenticated\"}',false); SELECT public.leaderboard();")
T1=$(Q "SELECT computed_at FROM public.leaderboard_cache WHERE id=1;")
[ -n "$T1" ] && echo "  ✓ 缓存已写入（computed_at=$T1）" || { echo "  ✗ 缓存表为空（VOLATILE 写入未生效）"; FAIL=$((FAIL+1)); }
echo "$R1" | grep -q '"my"' && echo "  ✓ 返回结构含 my" || { echo "  ✗ 返回结构异常: ${R1:0:120}"; FAIL=$((FAIL+1)); }

echo "── 2) 二调（2 秒后）：应命中缓存 ──"
sleep 2
R2=$(QL "SELECT set_config('request.jwt.claims','{\"sub\":\"$UID_T\",\"role\":\"authenticated\"}',false); SELECT public.leaderboard();")
T2=$(Q "SELECT computed_at FROM public.leaderboard_cache WHERE id=1;")
c "computed_at 不变（命中缓存，未重算）" "$T2" "$T1"
c "两次返回的公共榜单部分一致" "$(echo "$R1" | grep -o '"self_discipline":\[[^]]*\]')" "$(echo "$R2" | grep -o '"self_discipline":\[[^]]*\]')"

echo "── 3) my 部分实时性：与库内直算对拍 ──"
# json_build_object 输出键值间带空格（"streak" : 0），正则需容忍
MY_STREAK=$(echo "$R2" | grep -o '"my"[^}]*}' | grep -oE '"streak"[ ]*:[ ]*[0-9]+' | grep -oE '[0-9]+$')
DB_STREAK=$(Q "SELECT public._lb_compute_streak(
    (SELECT array_agg(DISTINCT log_date::text ORDER BY log_date::text)
       FROM public.meal_entries WHERE owner_id='$UID_T'),
    (now() AT TIME ZONE 'Asia/Shanghai')::date);")
c "my.streak == 库内直算 _lb_compute_streak" "${MY_STREAK:-<空>}" "${DB_STREAK:-<空>}"

echo "── 4) 未登录调用 ──"
R3=$(QL "SELECT set_config('request.jwt.claims','',false); SELECT public.leaderboard();")
case "$R3" in *not_authenticated*) echo "  ✓ 空身份 → error=not_authenticated" ;; *) echo "  ✗ 空身份未拒绝（返回 ${R3:0:120}）"; FAIL=$((FAIL+1)) ;; esac

echo "── 5) authenticated 直查缓存表 ──"
R4=$(PSQL_SU -c "BEGIN; SET LOCAL ROLE authenticated; SELECT count(*) FROM public.leaderboard_cache; ROLLBACK;" 2>&1 | tail -1)
case "$R4" in *[Pp]ermission\ denied*) echo "  ✓ permission denied" ;; *) echo "  ✗ 缓存表可被 authenticated 直查（$R4）"; FAIL=$((FAIL+1)) ;; esac

echo "── 6) 清理缓存行（恢复初始状态）──"
Q "DELETE FROM public.leaderboard_cache WHERE id=1;" >/dev/null
c "缓存行已删除" "$(Q "SELECT count(*)::int FROM public.leaderboard_cache;")" "0"

echo
if [ "$FAIL" = "0" ]; then
  echo "✅ leaderboard() 缓存实测全过（命中/实时my/鉴权/隔离/清理）"
  exit 0
else
  echo "❌ 失败 $FAIL 项"
  exit 1
fi
