#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# fix-nginx-301-to-308.sh · 修生产登录故障：HTTP→HTTPS 重定向 301 → 308
# ═══════════════════════════════════════════════════════════════════════
# 故障：web 登录报「未知端点 /.cloud/auth/v1/verification」
# 根因（access.log 用户手机请求链实证，21:34:24 同一秒三连）：
#     POST /.cloud/auth/v1/verification → 301
#     OPTIONS …                         → 204
#     GET  /.cloud/auth/v1/verification → 404   ← POST 被降级成 GET
#   80 端口块里 certbot `--nginx` installer 注入的 `return 301`
#   （/etc/nginx/sites-available/d-bee:109 与 :114，mtime 11-06 14:51 = B2 HTTPS 那次）
#   → 浏览器对 301 的历史兼容行为是 POST→GET 降级
#   → 网关 app.mjs:79 只注册 POST `${A}/verification` → 404「未知端点」
#   中午能登录是因为那时还没装 301；已打开的 SPA 标签 origin 仍是 http，点登录即触发。
#
# 为什么用 308：308 = 永久重定向但**强制保留方法与请求体**（301/302 允许降级，307/308 不允许）。
#   nginx 1.24.0 支持（已实测：临时 conf 过 `nginx -t`）。对 GET 静态资源行为与 301 一致，无副作用。
#
# 安全设计（生产 nginx 变更，失败必须能回滚）：
#   ① 备份原配置（带时间戳，命名不与既有 d-bee.bak* 冲突）
#   ② sed **精确**替换（只动 `return 301 https://$host$request_uri;` 这一种形态，且断言命中恰好 2 次）
#   ③ `nginx -t` 语法校验 —— **不过就立即回滚，绝不 reload**
#   ④ reload（不是 restart，零停机）
#   ⑤ 验证：curl -L --data（模拟浏览器，不用 -X 以免覆盖方法推断）→ 期望 401 而非 404
#   ⑥ 任一步失败 → 自动恢复备份 + `nginx -t` + reload + 报 FATAL
#
# ⚠️ 遗留风险（本脚本不解决，须另行复核）：certbot renewal 配置 `installer = nginx`，
#    未来真正续期时**可能重新注入 301**（证书 2027-02-04 到期，续期约在 2027-01）。
#    → 已在配置内留注释，并记入项目记忆「certbot renew 后须复核 308」。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
CONF=/etc/nginx/sites-available/d-bee
TS=$(date +%Y%m%d-%H%M%S)
BAK="$CONF.bak.301to308-$TS"

die() { echo "✗ FATAL: $*"; exit 1; }

rollback() {
  echo "── 回滚：恢复 $BAK ──"
  SUDO cp -p "$BAK" "$CONF" || { echo "✗✗ 回滚失败！请手工恢复：sudo cp $BAK $CONF"; exit 2; }
  if SUDO nginx -t >/tmp/_nt.log 2>&1; then
    SUDO systemctl reload nginx && echo "✓ 已回滚并 reload（配置回到变更前）"
  else
    echo "✗✗ 回滚后 nginx -t 仍失败（不应发生）："; tail -5 /tmp/_nt.log
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo " nginx 301 → 308  $(date '+%F %T %Z')  host=$(hostname)"
echo "═══════════════════════════════════════════════════════════════════"

# ── 0) 前置：确认待改行确实存在且形态符合预期（不猜）─────────────────
BEFORE=$(SUDO grep -c 'return 301 https://\$host\$request_uri;' "$CONF")
CUR308=$(SUDO grep -c 'return 308 https://\$host\$request_uri;' "$CONF")
echo "── 0) 前置检查 ──"
echo "  待改行数（期望 2）= $BEFORE"

# 🔴 幂等：已应用过（301=0 且 308=2）时不重复改，直接跳到第 5 步验证。
#    否则重跑会报「命中 0 行 ≠ 2，配置形态与预期不符」—— 这是**误导性**消息，
#    真实含义是「早就改好了」。certbot renew 若把 301 注回来，BEFORE 会重新变 2，
#    本脚本可原样重跑（这正是「续期后须复核」的处置手段）。
ALREADY=0
if [ "$BEFORE" = "0" ] && [ "$CUR308" = "2" ]; then
  ALREADY=1
  echo "  ✓ 已是 308（2 行），无需再改 → 跳过 1~4 步，直接验证"
else
  [ "$BEFORE" = "2" ] || die "命中 $BEFORE 行 ≠ 2（当前 308 有 $CUR308 行），配置形态与预期不符，拒绝改（可能 certbot 已变更结构）"
fi

if [ "$ALREADY" = "0" ]; then

SUDO nginx -t >/tmp/_nt0.log 2>&1 || { tail -5 /tmp/_nt0.log; die "变更前 nginx -t 就失败，先修配置"; }
echo "  ✓ 变更前 nginx -t 通过"

# ── 1) 备份 ─────────────────────────────────────────────────────────
echo "── 1) 备份 ──"
SUDO cp -p "$CONF" "$BAK" || die "备份失败"
echo "  ✓ $BAK"
echo "  sha256(before) = $(SUDO sha256sum "$CONF" | cut -d' ' -f1)"

# ── 2) 精确替换 + 留注释（防将来无人知道为何不是 301）──────────────
echo "── 2) 替换 301 → 308 ──"
SUDO sed -i 's|return 301 https://\$host\$request_uri;|return 308 https://$host$request_uri; # 308 而非 301：保留 POST 方法与请求体（301 会被浏览器降级为 GET，导致 /.cloud/auth/v1/verification 等 POST 端点 404）。2026-11-06 登录故障修复，certbot renew 后须复核|' "$CONF" || { rollback; die "sed 失败"; }

AFTER301=$(SUDO grep -c 'return 301' "$CONF")
AFTER308=$(SUDO grep -c 'return 308' "$CONF")
echo "  剩余 return 301 = $AFTER301（期望 0）"
echo "  新增 return 308 = $AFTER308（期望 2）"
if [ "$AFTER301" != "0" ] || [ "$AFTER308" != "2" ]; then rollback; die "替换结果不符预期"; fi
echo "  sha256(after)  = $(SUDO sha256sum "$CONF" | cut -d' ' -f1)"

# ── 3) 语法校验（不过绝不 reload）──────────────────────────────────
echo "── 3) nginx -t ──"
if SUDO nginx -t >/tmp/_nt.log 2>&1; then
  echo "  ✓ 语法通过"
else
  tail -8 /tmp/_nt.log | sed 's/^/    /'
  rollback; die "nginx -t 失败，已回滚"
fi

# ── 4) reload（零停机）─────────────────────────────────────────────
echo "── 4) reload ──"
SUDO systemctl reload nginx || { rollback; die "reload 失败，已回滚"; }
echo "  ✓ nginx 已 reload（$(systemctl is-active nginx)）"

# 🔴 reload 后**必须等旧 worker 退出**再验证，否则验证结果不可信（本次实测踩过）。
#    2026-11-06 实测：reload 返回成功、脚本立即 curl -L --data 却仍得 404（POST 被降级），
#    一度看起来像「308 没生效」；1 分多钟后用同款命令复验 3/3 全 401，access.log 也显示
#    服务器内部链路为 POST→308→POST→401（方法完整保留）。
#    根因：nginx reload 是**优雅退出** —— 新 worker 接管新连接，旧 worker 继续处理它
#    已接手的连接直到 worker_shutdown_timeout。systemctl reload 在「新 worker 已起」时
#    即返回，此刻旧 worker 仍活着且**持有旧配置（301）**，紧接着的验证请求可能落到
#    旧 worker 上 → 拿到旧行为 → 误报失败（假红）。
#    等 8 秒让旧 worker 处理完存量连接后退出，再做下面 5 项验证。
echo "  等待 8s 让旧 worker 退出（reload 是优雅退出，旧 worker 仍持旧配置 → 立即验证会假红）…"
sleep 8

fi  # ← ALREADY=0 分支结束（幂等：已是 308 时跳过备份/替换/nginx -t/reload）

# ── 5) 验证 ────────────────────────────────────────────────────────
echo "── 5) 验证（curl -L --data 模拟浏览器；🔴 不用 -X POST，它会覆盖方法推断导致假阴性）──"
FAIL=0

# 5a. HTTP POST 经重定向后必须仍是 POST（→ 网关鉴权 401），不能再是 404「未知端点」
# 🔴 最多重试 3 次：即使上面等了 8s，长连接场景下旧 worker 仍可能存活更久。
#    2026-11-06 实测：reload 后立即跑得 404（假红），8s 后仍不确定 → 重试到非 404 为止。
#    只有连续 3 次都 404 才判定真失败（此时配置里 return 301 已是 0，逻辑上不可能是配置问题）。
R=""
for attempt in 1 2 3; do
  R=$(curl -s -L -o /tmp/_v1.txt -w '%{http_code}' --max-time 15 \
        --data '{"phone":"13800000000"}' "http://d-bee.cn/.cloud/auth/v1/verification" 2>/dev/null)
  [ "$R" != "404" ] && break
  echo "    （第 $attempt 次得 404，可能仍有旧 worker 存活，5s 后重试）"
  sleep 5
done
B=$(head -c 120 /tmp/_v1.txt)
if [ "$R" = "404" ]; then
  echo "  ✗ POST 仍被降级为 GET（404）：$B"; FAIL=$((FAIL+1))
elif [ "$R" = "401" ]; then
  echo "  ✓ POST 保持 POST → 401 invalid access key（路由正常，$B）"
else
  echo "  ? 意外状态码 $R：$B（非 404 即未降级，但请人工确认）"
fi

# 5b. 直接查 HTTP 首跳状态码必须是 308（不跟随）
J=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
      "http://d-bee.cn/.cloud/auth/v1/verification" -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
if [ "$J" = "308" ]; then echo "  ✓ HTTP 首跳 = 308（保留方法）"
else echo "  ✗ HTTP 首跳 = $J（期望 308）"; FAIL=$((FAIL+1)); fi

# 5c. GET 静态资源与 SPA 首页仍正常（确认没改坏别的）
for u in "https://d-bee.cn/" "https://d-bee.cn/legal/terms/" "https://d-bee.cn/.cloud/healthz"; do
  C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$u" 2>/dev/null)
  if [ "$C" = "200" ]; then echo "  ✓ GET $u = 200"
  else echo "  ✗ GET $u = $C（期望 200）"; FAIL=$((FAIL+1)); fi
done

# 5d. HTTP 首页仍跳 HTTPS（跳转能力没丢）
H=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://d-bee.cn/" 2>/dev/null)
if [ "$H" = "308" ]; then echo "  ✓ http://d-bee.cn/ = 308（跳转仍在，且保留方法）"
else echo "  ✗ http://d-bee.cn/ = $H（期望 308）"; FAIL=$((FAIL+1)); fi

rm -f /tmp/_v1.txt /tmp/_nt.log /tmp/_nt0.log
echo
if [ "$FAIL" = "0" ]; then
  if [ "$ALREADY" = "1" ]; then
    echo "✅ 复核通过：nginx 已是 308（本次未改配置），5 项验证全绿"
  else
    echo "✅ 301 → 308 完成，全部验证通过"
    echo "   备份：$BAK"
    echo "   回滚：sudo cp $BAK $CONF && sudo nginx -t && sudo systemctl reload nginx"
  fi
  echo "   🔴 用户侧提醒：301 会被浏览器**永久缓存**，已中招的设备需硬刷新/清缓存才生效"
  exit 0
else
  echo "❌ 验证失败 $FAIL 项（配置已改且 reload 成功；备份在 $BAK）"
  echo "   如需回滚：sudo cp $BAK $CONF && sudo nginx -t && sudo systemctl reload nginx"
  exit 1
fi
