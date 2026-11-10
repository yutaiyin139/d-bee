#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# issue-test-codes.sh · 一条命令：应用 0048（若未应用）→ 发测试兑换码 → 打印明文
# ═══════════════════════════════════════════════════════════════════════
# 为什么需要它：发码工具 gen-redeem-codes.mjs 有硬前置（库内无 code_hash 列即
#   RAISE EXCEPTION「0048 未应用」），而当前生产水位 0045 → 直接发码必然失败。
#   本脚本把「应用 0048 + 核验 + 发码」串成一步，省得手工记两条命令的顺序。
#
# 🔴 为什么必须显式 --yes 才动：应用 0048 是**不可逆生产 DDL**（加列 + 重写核销函数）。
#   裸跑本脚本只会打印计划、什么都不做。
#
# 🔴 0048 在当前状态下风险已消除（2026-11-10 实测）：
#   · 0048 最大风险是「回填 hash 后 SET code=NULL 会丢失存量码明文」；
#     但 3 张存量码已于同日吊销（DELETE），线上实测 total=0 → 无数据可丢。
#   · 明文副本已归档 release/REVOKED-legacy-hardcoded-codes-20261110.txt。
#   · 已 dry-run（BEGIN...ROLLBACK）：psql exit=0，末尾正确 ROLLBACK，
#     独立复核水位仍 0045、code_hash 仍不存在 → 库未被改动。
#   · 0048 幂等（ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE），重复执行安全。
#   · 对外契约不变（RPC 签名 + 返回值仍 ok/used/bad），前端零改动。
#
# 🔴 关于「日卡」：兑换码体系**没有**日卡档位，发不出来。铁证 0044:79-96 ——
#   `months integer` + CHECK `months > 0`，核销用 make_interval(months => ...)，
#   最小粒度 = 1 个月；months=0 被 CHECK 拒、小数被 Number.isInteger 拒。
#   全仓零「兑换码天数」概念（payment_products / 0046 / 0047 亦全是 months 累加模型）。
#   ⚠️ 注意 --expires-days 1 **不是**日卡：那是「码必须在 1 天内兑换」的窗口，
#      兑换后时长仍由 months 决定。
#   「Pro 1 天」在系统里的正规路径是积分兑换 redeem_honey('pro1Day')（100 蜜糖，
#   src/lib/invite.ts:53），不是兑换码。
#   → 故本脚本默认发「月卡(pro/1) + 年卡(pro/12)」两张：两档都是 pro、都会自然到期，
#     且连着兑换可验「pro 顺延」分支（1 + 12 = 13 个月）。
#   🔴 刻意**不**拿 lifetime 顶替「日卡」：本脚本诞生当天刚处理完「3 张 lifetime 码
#     公开泄露」事故。lifetime 的风险是**无界**的 —— --expires-days 只限制「可兑换窗口」，
#     不限制「兑换后的会员时长」；一张忘了清理的 lifetime 测试码 = 永久免费会员。
#     年卡则最坏 12 个月自动到期，负债有界。要测 lifetime 分支（置顶不降级）请显式说明。
#
# 用法：
#   bash deploy/issue-test-codes.sh            # 只打印计划，不动生产（安全）
#   bash deploy/issue-test-codes.sh --yes      # 真正执行
#
# 可选环境变量：
#   TEST_NOTE=xxx      批次备注（默认「测试码-<日期>」，对账唯一线索）
#   TEST_EXPIRES=N     码有效期天数（默认 7 —— 测试码应短命自动过期，别留长期活口）
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || cygpath -m "$(cd "$(dirname "$0")/.." && pwd)")"
cd "$DIR" || { echo "✗ 无法进入仓库根目录: $DIR"; exit 1; }

NOTE="${TEST_NOTE:-测试码-$(date '+%Y%m%d')}"
EXPIRES="${TEST_EXPIRES:-7}"
# 发哪些档位：默认只发「月卡」（2026-11-10 用户明确「给我一个月卡码用来测试；日卡取消」）。
# 需要多档时用 TEST_TIERS 覆盖，空格分隔的 months 值，例：
#   TEST_TIERS="1 12" bash deploy/issue-test-codes.sh --yes   # 月卡 + 年卡
TIERS="${TEST_TIERS:-1}"
DO_IT=0
[ "${1:-}" = "--yes" ] && DO_IT=1

# 凭据只从 .env 读（不进命令行、不进 shell history）
if [ ! -f .env ]; then echo "✗ 找不到 .env（需 DBEE_HOST / USER / SSH_PWD）"; exit 2; fi
set -a; . ./.env; set +a
export DBEE_USER="${USER:-$DBEE_USER}" DBEE_PWD="${SSH_PWD:-$DBEE_PWD}"
[ -n "${DBEE_HOST:-}" ] || { echo "✗ .env 缺 DBEE_HOST"; exit 2; }
[ -n "${DBEE_USER:-}" ] || { echo "✗ .env 缺 USER"; exit 2; }
[ -n "${DBEE_PWD:-}" ] || { echo "✗ .env 缺 SSH_PWD"; exit 2; }

TIER_DESC=""
for m in $TIERS; do
  case "$m" in 1) TIER_DESC="$TIER_DESC 月卡(pro/1)";; 12) TIER_DESC="$TIER_DESC 年卡(pro/12)";;
                *) TIER_DESC="$TIER_DESC pro/${m}月";; esac
done

echo "─── D-Bee 测试兑换码发放 ───"
echo "批次备注 : $NOTE"
echo "码有效期 : $EXPIRES 天（测试码刻意短命，过期自动失效 = 自带止损）"
echo "本次档位 :$TIER_DESC  （各 1 张）"
echo "计划     : ① 应用 0048（若未应用） ② 核验 ③ 发码并打印明文"
echo "⚠ 日卡   : 兑换码体系无此档位（months 整数 + CHECK>0，最小 1 个月），发不出来"
echo "⚠ 终身   : 刻意不发 —— 当天刚处理完 3 张 lifetime 码公开泄露事故；"
echo "           --expires-days 只限「可兑换窗口」不限「会员时长」，lifetime 负债无界"
echo

if [ "$DO_IT" -ne 1 ]; then
  echo "【dry 模式】未加 --yes，不动生产库。确认无误后执行："
  echo "  bash deploy/issue-test-codes.sh --yes"
  exit 0
fi

echo "==> ① 应用 0048（幂等；已应用则 CREATE OR REPLACE 无害重放）"
bash deploy/sync-mirror.sh 0048-redeem-code-hardening.sql || {
  echo "✗ 0048 应用失败 —— 中止，不发码（发码工具的前置检查也会拦住）"; exit 1; }

echo
echo "==> ② 核验 0048 已生效（水位应含 0048、code_hash 列应为 true）"
python deploy/dbee-ssh.py run deploy/diag-redeem-readiness.sh 2>&1 | sed -n '1,20p'

echo
echo "==> ③ 发测试码（--print 让明文直接可见便于测试）"
FAIL=0
for m in $TIERS; do
  # months 必须是 1..1200 的整数（与 0044 CHECK + 发码工具校验一致），
  # 否则会被拒；提前拦一下，免得跑到一半才失败。
  case "$m" in
    ''|*[!0-9]*) echo "✗ TEST_TIERS 含非整数档位 '$m'（months 必须是整数月数）"; FAIL=1; continue;;
  esac
  if [ "$m" -lt 1 ] || [ "$m" -gt 1200 ]; then
    echo "✗ 档位 '$m' 越界（months 必须 1..1200）"; FAIL=1; continue
  fi
  case "$m" in 1) LABEL="月卡";; 12) LABEL="年卡";; *) LABEL="${m}月";; esac
  echo
  echo "---- $LABEL (pro / $m 个月) ----"
  node tools/gen-redeem-codes.mjs --plan pro --months "$m" --count 1 \
       --note "$NOTE-$LABEL" --expires-days "$EXPIRES" --print || FAIL=1
done
[ "$FAIL" -ne 0 ] && { echo; echo "✗ 有档位发放失败，见上方输出"; exit 1; }

cat <<'TAIL'

────────────────────────────────────────────────────────
✅ 测试码已发放。明文同时落在 release/redeem-codes-*.txt（gitignored）。

🔴 测试完请清理，别让测试码留成活口：
   ① 按批次作废（推荐，一条 SQL 清掉本次所有未用码）：
      DELETE FROM redeem_codes WHERE note LIKE '测试码-%' AND used_by IS NULL;
   ② 若测试时已兑换，记得把测试账号权益复位：
      UPDATE entitlements SET plan='free', pro_until=NULL, source=NULL
       WHERE owner_id='<测试账号>';
      DELETE FROM redeem_attempts WHERE owner_id='<测试账号>';

📌 兑换入口：Web / Android / 小程序付费墙底部的兑换码输入框。
   iOS 端刻意无入口（Apple 3.1.1 反规避）。
   返回值 ok=成功 / used=已被用过 / bad=码错、已过期或被限流。
TAIL
exit 0
