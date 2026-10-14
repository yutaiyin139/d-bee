# 在服务器上执行：为站点域名申请 Let's Encrypt 证书并开启 HTTPS。
# 占位符 __DOMAIN__ / __EMAIL__ / __SUDO_PWD__ 由 deploy/dbee-ssh.py 替换。
#
# 由 deploy/deploy.sh 的 https 模式调用：
#   DBEE_HOST=… DBEE_USER=… DBEE_PWD=… DBEE_DOMAIN=dbee.example.com \
#   DBEE_CERT_EMAIL=you@example.com bash deploy/deploy.sh https
#
# ⚠️ 前置条件（缺一不可）：
#   1. 域名 A 记录已解析到本服务器公网 IP，且已生效（dig +short 域名 能返回本机 IP）
#   2. 80 端口能从公网访问（certbot 默认用 HTTP-01 校验）
#   3. 中国大陆服务器必须先完成 ICP 备案，否则 80 会被腾讯云拦截、校验必然失败
set -e

DOMAIN="__DOMAIN__"
EMAIL="__EMAIL__"

if [ -z "$DOMAIN" ]; then
  echo "!! DOMAIN 为空，未渲染出域名，终止"
  exit 1
fi

echo "=== 0) 前置检查：$DOMAIN ==="
echo -n "    域名解析: "; getent hosts "$DOMAIN" | awk '{print $1}' | paste -sd' ' - || echo "(解析失败)"
echo -n "    本机公网IP: "; curl -s -m 10 https://api.ipify.org || echo "(取不到)"
echo -n "    80 端口本地监听: "; (ss -lntp 2>/dev/null | grep -q ':80 ' && echo yes) || echo no
echo "    （若「域名解析」不含本机公网IP，certbot 一定会失败，请先修 DNS）"
echo

echo "=== 1) 安装 certbot ==="
if command -v certbot >/dev/null 2>&1; then
  echo "    已安装: $(certbot --version 2>&1)"
else
  export DEBIAN_FRONTEND=noninteractive
  echo "__SUDO_PWD__" | sudo -S -p '' apt-get update -qq
  echo "__SUDO_PWD__" | sudo -S -p '' apt-get install -y -qq certbot python3-certbot-nginx
  echo "    安装完成: $(certbot --version 2>&1)"
fi

echo "=== 2) 申请证书并自动改写 nginx 配置 ==="
if [ -n "$EMAIL" ]; then
  MAIL_ARGS="-m $EMAIL --agree-tos --no-eff-email"
else
  MAIL_ARGS="--register-unsafely-without-email --agree-tos"
fi
# --redirect：自动把 80 的请求 301 到 443；-n 非交互
echo "__SUDO_PWD__" | sudo -S -p '' certbot --nginx -d "$DOMAIN" $MAIL_ARGS -n --redirect 2>&1 | tail -20

echo "=== 3) 复检 ==="
echo "__SUDO_PWD__" | sudo -S -p '' nginx -t 2>&1 | tail -2
echo "__SUDO_PWD__" | sudo -S -p '' systemctl reload nginx
echo "    nginx: $(systemctl is-active nginx)"
echo "    证书到期: $(echo "__SUDO_PWD__" | sudo -S -p '' certbot certificates 2>/dev/null | grep -E 'Expiry Date' | head -1)"

echo
echo "=== 4) 端到端自测 ==="
for u in "https://$DOMAIN/" "http://$DOMAIN/"; do
  printf "    %-40s -> %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$u" || echo 'curl失败')"
done

echo
echo "=== 5) 自动续期已由 certbot 的 systemd timer 接管 ==="
echo "    $(systemctl list-timers 2>/dev/null | grep -i certbot | head -1 || echo '（未发现 timer，可手动 certbot renew --dry-run 验证）')"
