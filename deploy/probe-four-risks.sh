#!/usr/bin/env bash
# 只读探针：逐项实证四项安全风险（不修改任何配置/数据）。
# 纪律：绝不打印密码/密钥/万能码明文，只报「是否设置 + 长度 + sha256 前 8 位」。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

mask() {  # mask <值> -> 长度+指纹，空值报 <未设置>
  local v="${1-}"
  if [ -z "$v" ]; then echo "<未设置>"; else
    printf 'len=%d sha8=%s' "${#v}" "$(printf '%s' "$v" | sha256sum | cut -c1-8)"
  fi
}

echo "══════════ A) 网关 env 实况（万能码 / 生产模式 / 短信通道）══════════"
ENVF=$(SUDO systemctl cat dbee-gateway 2>/dev/null | grep -oP '^EnvironmentFile=\K.*' | head -1)
echo "EnvironmentFile = ${ENVF:-<未找到>}"
for k in SMS_PROVIDER DBEE_PROD SMS_MASTER_CODE DEMO_PHONE DEMO_CODE IDENT_PEPPER JWT_SECRET \
         SMS_SIGN_NAME SMS_ALIYUN_ACCESS_KEY_ID APPLE_ALLOWED_ENVS APPLE_BUNDLE_ID SHARED_SECRET \
         CORS_ALLOWED_ORIGINS LLM_API_KEY LLM_VISION_API_KEY SMTP_PASS EMAIL_PROVIDER; do
  line=$(SUDO grep -E "^${k}=" "$ENVF" 2>/dev/null | head -1)
  if [ -z "$line" ]; then echo "  $k = <未设置（走代码默认值）>"
  elif [ "$k" = "SMS_PROVIDER" ] || [ "$k" = "DBEE_PROD" ] || [ "$k" = "EMAIL_PROVIDER" ] \
    || [ "$k" = "SMS_SIGN_NAME" ] || [ "$k" = "APPLE_ALLOWED_ENVS" ] || [ "$k" = "APPLE_BUNDLE_ID" ] \
    || [ "$k" = "CORS_ALLOWED_ORIGINS" ]; then
    echo "  $k = ${line#*=}   ← 非敏感"
  else
    echo "  $k = $(mask "${line#*=}")"
  fi
done

echo
echo "── A2) 运行中进程的实际环境（systemd 可能覆盖 env 文件）──"
GW_PID=$(pgrep -f 'server/index.mjs|dbee-gateway' | head -1)
echo "  网关 PID = ${GW_PID:-<未找到>}"
if [ -n "$GW_PID" ]; then
  SUDO tr '\0' '\n' < /proc/"$GW_PID"/environ 2>/dev/null | grep -E '^(SMS_PROVIDER|DBEE_PROD|SMS_MASTER_CODE|DEMO_PHONE)=' \
    | sed -E 's/^(SMS_MASTER_CODE=).*/\1<已设置，值不显示>/; s/^(DEMO_PHONE=).*/\1<已设置>/'
fi

echo
echo "── A3) 万能码是否真的可用（看网关近 7 天有没有打出明文验证码）──"
SUDO journalctl -u dbee-gateway --since "7 days ago" --no-pager 2>/dev/null \
  | grep -icE 'verification code|验证码[:：]|code=' | sed 's/^/  明文验证码日志条数 = /'
echo "  （>0 说明当前仍是 log 模式在打码；aliyun/tencent 模式只打掩码）"

echo
echo "══════════ B) 5432 是否对公网开放 ══════════"
echo "── B1) 监听套接字 ──"
SUDO ss -lntp 2>/dev/null | grep -E ':5432|:3001|:8080|:80 |:443 ' | sed 's/^/  /'
echo "── B2) postgresql.conf listen_addresses / port ──"
PGCONF=$(SUDO -u postgres psql -tAc "show config_file" 2>/dev/null | tr -d ' ')
echo "  config_file = ${PGCONF:-<取不到>}"
[ -n "$PGCONF" ] && SUDO grep -nE '^\s*(listen_addresses|port)\s*=' "$PGCONF" | sed 's/^/  /'
echo "── B3) pg_hba.conf 生效行（非注释）──"
PGHBA=$(SUDO -u postgres psql -tAc "show hba_file" 2>/dev/null | tr -d ' ')
[ -n "$PGHBA" ] && SUDO grep -vE '^\s*(#|$)' "$PGHBA" | sed 's/^/  /'
echo "── B4) 防火墙 ──"
SUDO ufw status verbose 2>/dev/null | sed 's/^/  /' || echo "  ufw 未安装/未启用"
echo "  iptables INPUT 链前 12 条："
SUDO iptables -L INPUT -n --line-numbers 2>/dev/null | head -12 | sed 's/^/  /'
echo "── B5) 腾讯云安全组无法从机内看，改用外部实测（见下方 C5）──"
echo "── B6) 网关/PostgREST 连库地址（决定能否安全收回回环）──"
SUDO grep -hoE '(postgres(ql)?://[^ "'"'"']*|DBEE_DB_HOST=[^ ]*|db-uri=[^ ]*)' "$ENVF" 2>/dev/null | sed -E 's#://[^@]*@#://<user:pwd>@#g' | sed 's/^/  /'
SUDO grep -rhoE 'db-uri\s*=\s*"?[^ "]+' /etc/dbee/ 2>/dev/null | sed -E 's#://[^@]*@#://<user:pwd>@#g' | sed 's/^/  /'
SUDO systemctl cat dbee-postgrest 2>/dev/null | grep -E 'Environment|ExecStart' | sed -E 's#://[^@]*@#://<user:pwd>@#g' | sed 's/^/  /'

echo
echo "══════════ C) 双后端：线上 nginx 到底把流量送去哪 ══════════"
echo "── C1) 启用的站点文件 ──"
ls -l /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^/  /'
echo "── C2) 生效配置里的 upstream / proxy_pass / Origin 改写 ──"
for f in /etc/nginx/sites-enabled/*; do
  [ -f "$f" ] || continue
  echo "  ── $f ──"
  SUDO grep -nE 'upstream|server .*:443|proxy_pass|proxy_set_header (Origin|Referer|Host)|server_name|listen' "$f" 2>/dev/null | sed 's/^/    /'
done
echo "── C3) 是否还残留指向 WorkBuddy 云的 upstream ──"
SUDO grep -rn 'workbuddy\.host' /etc/nginx/ 2>/dev/null | sed 's/^/  /' || echo "  <无：nginx 已全自托管>"
echo "── C4) 本机实测 /.cloud 走的是哪一头（对比自建网关与云端响应）──"
echo -n "  127.0.0.1:8080/.cloud/healthz -> "; curl -sS -m 8 -o /tmp/p1 -w 'HTTP %{http_code}\n' http://127.0.0.1:8080/.cloud/healthz 2>/dev/null || echo fail
echo -n "  http://127.0.0.1/.cloud/healthz  -> "; curl -sS -m 8 -o /tmp/p2 -w 'HTTP %{http_code}\n' http://127.0.0.1/.cloud/healthz 2>/dev/null || echo fail
echo "  两者响应体是否一致：$(cmp -s /tmp/p1 /tmp/p2 && echo '一致（nginx 已指向自建网关）' || echo '不一致（nginx 仍转发到云端！）')"
echo "  p1=$(head -c 120 /tmp/p1 2>/dev/null)"
echo "  p2=$(head -c 120 /tmp/p2 2>/dev/null)"
echo "── C5) 5432 外部可达性实测（从服务器自己连公网 IP，等价于外部视角的一半）──"
PUBIP=$(curl -sS -m 8 https://ifconfig.me 2>/dev/null || echo 150.158.51.106)
echo "  公网 IP = $PUBIP"
timeout 6 bash -c "echo > /dev/tcp/$PUBIP/5432" 2>/dev/null && echo "  🔴 $PUBIP:5432 可连通" || echo "  ✅ $PUBIP:5432 不可连通（本机视角）"
timeout 6 bash -c "echo > /dev/tcp/127.0.0.1/5432" 2>/dev/null && echo "  127.0.0.1:5432 可连通（正常）" || echo "  127.0.0.1:5432 不可连通"

echo
echo "══════════ D) 历史密钥残留面 ══════════"
echo "── D1) /tmp 下是否残留部署脚本（可能含明文密码）──"
ls -la /tmp/dbee-*.sh /tmp/*.env /tmp/hz.txt 2>/dev/null | sed 's/^/  /' || echo "  <无残留>"
echo "── D2) 这些残留文件里是否含明文密码/密钥（只报命中键名，不打印值）──"
for f in /tmp/dbee-*.sh /tmp/*.env; do
  [ -f "$f" ] || continue
  hits=$(SUDO grep -ohE '(SSH_PWD|DBEE_PWD|SUDO_PWD|JWT_SECRET|IDENT_PEPPER|SMS_MASTER_CODE|LLM_API_KEY|SMTP_PASS)=' "$f" 2>/dev/null | sort -u | tr '\n' ' ')
  echo "  $f -> ${hits:-<无命中>}"
done
echo "── D3) shell 历史里是否有密码痕迹（只报条数）──"
for h in /home/ubuntu/.bash_history /root/.bash_history; do
  [ -f "$h" ] && echo "  $h: $(SUDO grep -icE 'sshpass|-p [A-Za-z0-9]|password' "$h" 2>/dev/null) 条可疑"
done
echo "── D4) 网关日志里是否打出过密钥（只报条数）──"
SUDO journalctl -u dbee-gateway --since "14 days ago" --no-pager 2>/dev/null \
  | grep -icE 'IDENT_PEPPER|JWT_SECRET|LLM_API_KEY|access_key' | sed 's/^/  命中条数 = /'
echo "── D5) env 文件与备份的权限（防止其他用户读到）──"
SUDO ls -l "$ENVF" /etc/dbee/ 2>/dev/null | sed 's/^/  /'
SUDO find /etc/dbee /home/ubuntu -maxdepth 2 -name '*.bak' -o -maxdepth 2 -name 'gateway.env*' 2>/dev/null | head -10 | sed 's/^/  /'

echo
echo "══════════ E) 数据库角色与 BYPASSRLS 现状（0039 闸门是否真生效）══════════"
SUDO -u postgres psql -d dbee -tAc "select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname not like 'pg\_%' order by 1" 2>/dev/null | sed 's/^/  /'
echo "── E2) 涉权益表的写权限（应为 r 只读）──"
SUDO -u postgres psql -d dbee -tAc "select table_name, privilege_type from information_schema.role_table_grants where grantee in ('authenticated','anon') and table_name in ('honey_ledger','entitlements','ai_usage','badges') order by 1,2" 2>/dev/null | sed 's/^/  /'
echo "══════════ 结束（全程只读，未修改任何配置）══════════"
