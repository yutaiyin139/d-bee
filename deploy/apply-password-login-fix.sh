#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 只部署「密码登录修复」的两个代码文件，**绝不动 /etc/dbee/gateway.env**。
#
# 为什么不用 deploy/deploy-gateway.sh：
#   那个脚本会用本地模板重渲染并 install 覆盖 gateway.env。而本地 .env 缺
#   IDENT_PEPPER / JWT_SECRET / EMAIL_SMTP_* / DBEE_PROD / SMS_PROVIDER
#   （10-29 实测全部「本地缺失」）。一旦覆盖：
#     · IDENT_PEPPER 丢失 → app_users.ident_hash 全部无法重算 → 所有账户
#       永久查不到人（含验证码登录），等于全站锁死且无法恢复；
#     · JWT_SECRET 变更 → 所有已发 access_token 立即失效；
#     · SMTP 凭据丢失 → 邮箱验证码发不出去。
#   本脚本只搬两个 .mjs，env 一个字节都不碰，风险面收敛到「代码有 bug」。
#
# 安全措施（每步都失败即中止，绝不留半部署状态）：
#   ① 部署前 node --check 语法校验（避免语法错误把网关起不来）
#   ② 备份原文件到带时间戳的 .bak（可回滚）
#   ③ 用 sudo install 保持 root:dbee 644（与既有权限一致）
#   ④ 重启后 healthz 探活，失败自动回滚
#   ⑤ 断言 gateway.env 的 sha256 前后一致（证明真的没碰它）
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail
SUDO_PWD='__SUDO_PWD__'
SUDO() { echo "$SUDO_PWD" | sudo -S "$@"; }

APP=/opt/dbee-gateway
ENV_FILE=/etc/dbee/gateway.env
# ⚠️ putfile 会把上传文件 chmod 成 0600 且属主为 SSH 用户（ubuntu），
#    这里用 ubuntu 家目录暂存，语法校验直接以 ubuntu 身份 node --check 即可读。
STAGE="$HOME/dbee-pwfix"
TS=$(date +%Y%m%d-%H%M%S)
FILES="lib/auth.mjs lib/identity.mjs"

echo "═══ ⓪ 暂存文件核对 ═══"
mkdir -p "$STAGE/lib"
for f in $FILES; do
  [ -f "$STAGE/$f" ] || { echo "  !! 缺少 $STAGE/$f（请先 putfile 上传）"; exit 1; }
  echo "  ✓ $STAGE/$f  size=$(stat -c%s "$STAGE/$f")"
done

echo
echo "═══ ① 语法校验（失败即中止，不碰任何文件）═══"
for f in $FILES; do
  node --check "$STAGE/$f" && echo "  ✓ $f 语法 OK"
done

echo
echo "═══ ② 记录 gateway.env 指纹（部署后须完全一致）═══"
ENV_BEFORE=$(SUDO sha256sum "$ENV_FILE" | cut -c1-16)
echo "  env sha256(before) = $ENV_BEFORE"

echo
echo "═══ ③ 备份原文件 ═══"
SUDO install -d -m 0750 -o root -g dbee "$APP/.bak-$TS"
for f in $FILES; do
  SUDO cp -a "$APP/$f" "$APP/.bak-$TS/$(basename "$f")"
  echo "  已备份 $f -> $APP/.bak-$TS/$(basename "$f")"
done

echo
echo "═══ ④ 安装新文件（保持 root:dbee 644）═══"
for f in $FILES; do
  SUDO install -m 0644 -o root -g dbee "$STAGE/$f" "$APP/$f"
  echo "  ✓ $f  $(SUDO stat -c 'owner=%U:%G perm=%a size=%s' "$APP/$f")"
done

echo
echo "═══ ⑤ 确认新代码已就位 ═══"
if SUDO grep -q "signInWithPassword" "$APP/lib/auth.mjs"; then
  echo "  ✓ auth.mjs 含 signInWithPassword"
else
  echo "  !! auth.mjs 未含 signInWithPassword —— 回滚"
  for f in $FILES; do SUDO cp -a "$APP/.bak-$TS/$(basename "$f")" "$APP/$f"; done
  exit 1
fi
echo "  verifyPassword import 数: $(SUDO grep -c 'verifyPassword' "$APP/lib/auth.mjs")"

echo
echo "═══ ⑥ 重启网关 ═══"
SUDO systemctl restart dbee-gateway
sleep 3
SUDO systemctl is-active dbee-gateway || true

echo
echo "═══ ⑦ healthz 探活（失败自动回滚）═══"
HZ=$(curl -sS -m 10 -o /tmp/hz2.txt -w '%{http_code}' "http://127.0.0.1:8080/.cloud/healthz" || echo "000")
echo "  healthz -> HTTP $HZ"
cat /tmp/hz2.txt 2>/dev/null | head -c 300; echo
if [ "$HZ" != "200" ]; then
  echo "  !! 网关未起来 —— 回滚代码并重启"
  for f in $FILES; do SUDO cp -a "$APP/.bak-$TS/$(basename "$f")" "$APP/$f"; done
  SUDO systemctl restart dbee-gateway
  sleep 3
  echo "  回滚后 healthz -> HTTP $(curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/.cloud/healthz || echo 000)"
  SUDO journalctl -u dbee-gateway --since "2 minutes ago" --no-pager | tail -20
  exit 1
fi

echo
echo "═══ ⑧ 断言 gateway.env 未被改动 ═══"
ENV_AFTER=$(SUDO sha256sum "$ENV_FILE" | cut -c1-16)
echo "  env sha256(after)  = $ENV_AFTER"
if [ "$ENV_BEFORE" = "$ENV_AFTER" ]; then
  echo "  ✓ 一致 —— IDENT_PEPPER / JWT_SECRET / SMTP 全部原样保留"
else
  echo "  🔴 不一致！env 被改动了，请立即检查 $ENV_FILE 与 ${ENV_FILE}.bak"
  exit 1
fi

echo
echo "═══ ⑨ 启动日志（确认无报错）═══"
SUDO journalctl -u dbee-gateway --since "1 minutes ago" --no-pager | tail -12
echo
echo "✅ 部署完成。备份在 $APP/.bak-$TS/（如需回滚：cp -a 回去再 restart）"
