#!/usr/bin/env bash
# 只读：核实线上网关的认证相关配置（决定演示账户能否在自建库注册/登录）。
# 只打印「是否设置」与少量非敏感值，绝不打印密码/密钥/万能码明文。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S "$@" 2>/dev/null; }

echo "══════════ 1) 网关 systemd unit 与 EnvironmentFile 路径 ══════════"
SUDO systemctl cat dbee-gateway 2>/dev/null | grep -E '^(EnvironmentFile|ExecStart|WorkingDirectory)=' | sed 's#\(EnvironmentFile=\).*#\1(见下)#'
ENVF=$(SUDO systemctl cat dbee-gateway 2>/dev/null | grep -oP '^EnvironmentFile=\K.*' | head -1)
echo "EnvironmentFile = ${ENVF:-<未找到>}"

echo
echo "══════════ 2) 该 env 文件里认证相关键（只显示是否设置） ══════════"
if [ -n "$ENVF" ]; then
  for k in EMAIL_PROVIDER SMTP_HOST SMTP_USER SMTP_PASS SMS_MASTER_CODE DEMO_PHONE DEMO_CODE IDENT_PEPPER JWT_SECRET PUBLISHABLE_KEY RATE_LIMIT_PER_MIN OTP_IP_HOUR_LIMIT; do
    line=$(SUDO grep -E "^${k}=" "$ENVF" 2>/dev/null | head -1)
    if [ -z "$line" ]; then
      echo "  $k = <未设置>"
    elif [ "$k" = "EMAIL_PROVIDER" ]; then
      echo "  $k = ${line#*=}   ← 非敏感，直接显示"
    else
      v="${line#*=}"
      echo "  $k = 已设置（长度 ${#v}）"
    fi
  done
fi

echo
echo "══════════ 3) 网关健康检查 ══════════"
curl -sS -m 10 -o /tmp/hz.txt -w "  /.cloud/healthz -> HTTP %{http_code}\n" "http://127.0.0.1:8080/.cloud/healthz" 2>/dev/null || echo "  healthz 请求失败"
head -c 300 /tmp/hz.txt 2>/dev/null; echo

echo
echo "══════════ 4) 网关近期 auth 日志（找 signin 失败痕迹） ══════════"
SUDO journalctl -u dbee-gateway --since "2 hours ago" --no-pager 2>/dev/null | grep -iE "signin|缺少 verification|登录成功|发码" | tail -12
echo "══════════ 结束（未修改任何数据） ══════════"
