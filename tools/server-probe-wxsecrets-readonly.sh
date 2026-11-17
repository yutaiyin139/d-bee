#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# server-probe-wxsecrets-readonly.sh · 微信小程序密钥可用性【纯只读】判定
#
# 背景：上一轮探到 WECHAT_MINI_SECRETS 值长度仅 18 字符。而 config.mjs:398
#   parseWechatSecrets() 的格式要求是「appid=secret[,appid=secret…]」，
#   🔴 微信 appid 本身就正好 18 字符（wx + 16）→ 若该值不含 '='，
#   eq<=0 会被 continue 跳过 → 解析出【空 Map】→ werun 解密拿不到 AppSecret
#   → 即便把 werun.mjs 部署上去，同步仍会失败。这是必须先排掉的隐藏前置。
#
# 判定口径（🔴 绝不打印任何 secret 值，只输出结构特征）：
#   ① WECHAT_MINI_SECRETS 是否含 '='、有几段、各段 appid 前缀(wx)与 secret 长度
#   ② WECHAT_APPID / WECHAT_SECRET 兜底键是否存在且非空（parseWechatSecrets:410-412）
#   ③ 用 node 在服务器上【真跑一次 parseWechatSecrets】，输出解析出的 appid 个数
#      与 secret 长度分布 —— 这是唯一能证「解析结果非空」的口径（静态 grep 会假绿）
# 🔴 零写入：只 grep/awk/node -e 读。绝不 restart/reload/deploy/改 env。
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }
ENVF=/etc/dbee/gateway.env
LIB=/opt/dbee-gateway/lib

echo "【1】键存在性与结构特征（不打印 secret 值）"
SUDO awk -F= '
  /^WECHAT_MINI_SECRETS=/ {
    v=$2
    printf "  WECHAT_MINI_SECRETS: 存在, 总长=%d\n", length(v)
    n=split(v, segs, ",")
    printf "  逗号分段数=%d\n", n
    hasEq = index(v, "=")
    printf "  是否含 \"=\": %s\n", (hasEq>0 ? "是（位置 " hasEq "）" : "🔴 否 → parseWechatSecrets 会全部 continue 跳过")
    for (i=1; i<=n; i++) {
      s=segs[i]
      e=index(s, "=")
      if (e<=0) { printf "    段%d: 🔴 无 \"=\"（长度 %d，前2字符 %s…）→ 被跳过\n", i, length(s), substr(s,1,2); continue }
      ap=substr(s,1,e-1); se=substr(s,e+1)
      printf "    段%d: appid前缀=%s appid长=%d secret长=%d\n", i, substr(ap,1,2), length(ap), length(se)
    }
  }
  /^WECHAT_APPID=/  { printf "  WECHAT_APPID: 存在, 长度=%d, 前缀=%s\n", length($2), substr($2,1,2) }
  /^WECHAT_SECRET=/ { printf "  WECHAT_SECRET: 存在, 长度=%d\n", length($2) }
' "$ENVF" 2>&1

echo ""
echo "【2】真跑 parseWechatSecrets（唯一能证解析结果非空的口径）"
SUDO env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_PATH="$LIB" bash -c '
  set -a; . /etc/dbee/gateway.env 2>/dev/null; set +a
  cd /opt/dbee-gateway
  node --input-type=module -e "
    import { parseWechatSecrets } from \"/opt/dbee-gateway/lib/config.mjs\";
    const m = parseWechatSecrets(process.env);
    console.log(\"  解析出 appid 个数 =\", m.size);
    for (const [k,v] of m) console.log(\"    appid=\" + k.slice(0,4) + \"***(\" + k.length + \"字符)  secret长度=\" + v.length);
    if (m.size === 0) console.log(\"  🔴 空 Map → werun 解密必然失败（无 AppSecret 换 session_key）\");
    else console.log(\"  ✅ 非空 → werun 解密具备密钥条件\");
  " 2>&1 | sed "s/^/  /"
' 2>&1 | tail -12

echo ""
echo "【3】兜底：小程序登录（login-wechat）当前是否正常——同一密钥的既有消费者"
echo "  说明：login-wechat 已在生产存在（本轮探到 401 invalid_api_key 而非 404），"
echo "        若它能正常登录，则说明密钥解析必然非空（它走同一个 wechatMiniSecrets）。"
SUDO journalctl -u dbee-gateway -n 2000 --no-pager 2>&1 \
  | grep -iE 'wechat|login-wechat|mini' | grep -viE 'secret|key=' | tail -8 | sed 's/^/  /'
echo "  （上面若为空 = 近期无微信登录日志，不影响【2】的结论）"

echo ""
echo "【4】env 指纹（部署前后必须不变的基线）"
SUDO sha256sum "$ENVF" 2>&1 | sed 's/^/  /'
SUDO stat -c '  mtime=%y size=%s' "$ENVF" 2>&1 | sed 's/^/  /'

echo ""
echo "【只读密钥判定完成 · 零写入 · 未打印任何 secret】"
