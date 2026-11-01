#!/usr/bin/env python3
"""部署「视觉请求关闭深度思考」修复：只搬 lib/config.mjs + lib/llm.mjs 两个文件。

为什么不用 deploy/deploy-gateway.sh：
  那个脚本会用本地模板重渲染并覆盖 /etc/dbee/gateway.env，而本地 .env 缺
  IDENT_PEPPER / JWT_SECRET 等键 —— 覆盖等于全站锁死（见 apply-password-login-fix.sh
  头注释的 10-29 血泪教训）。本脚本 env 一个字节都不碰。

安全措施（每步失败即中止/回滚，绝不留半部署状态）：
  ① 上传前本地 node --check（Windows 侧语法校验）
  ② 上传后服务器再 node --check（ubuntu 身份可直接读暂存文件）
  ③ 记录 gateway.env sha256，部署后断言一致
  ④ 备份原文件到 $APP/.bak-<时间戳>/
  ⑤ install 保持 root:dbee 644
  ⑥ 重启后 healthz 探活，非 200 自动回滚并重启
  ⑦ 确认新代码就位：config.mjs 含 llmVisionEnableThinking、llm.mjs 含 enable_thinking

用法：python deploy/apply-llm-thinking-fix.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO, ".env")
FILES = ["lib/config.mjs", "lib/llm.mjs"]  # 相对 server/ 与 /opt/dbee-gateway/
LOCAL_DIR = os.path.join(REPO, "server")

# 服务器端安装脚本（sudo -n 已在探针中验证免密可用）
REMOTE_SCRIPT = r"""
set -euo pipefail
APP=/opt/dbee-gateway
ENV_FILE=/etc/dbee/gateway.env
STAGE="$HOME/dbee-llmfix"
TS=$(date +%Y%m%d-%H%M%S)
FILES="lib/config.mjs lib/llm.mjs"

echo "═══ ① 服务器侧语法校验（失败即中止，不碰任何文件）═══"
for f in $FILES; do
  node --check "$STAGE/$f" && echo "  OK $f"
done

echo
echo "═══ ② 记录 gateway.env 指纹（部署后须完全一致）═══"
ENV_BEFORE=$(sudo -n sha256sum "$ENV_FILE" | cut -c1-16)
echo "  env sha256(before) = $ENV_BEFORE"

echo
echo "═══ ③ 备份原文件 ═══"
sudo -n install -d -m 0750 -o root -g dbee "$APP/.bak-$TS"
for f in $FILES; do
  sudo -n cp -a "$APP/$f" "$APP/.bak-$TS/$(basename "$f")"
  echo "  已备份 $f -> .bak-$TS/$(basename "$f")"
done

echo
echo "═══ ④ 安装新文件（保持 root:dbee 644）═══"
for f in $FILES; do
  sudo -n install -m 0644 -o root -g dbee "$STAGE/$f" "$APP/$f"
  echo "  OK $f  $(sudo -n stat -c 'owner=%U:%G perm=%a size=%s' "$APP/$f")"
done

echo
echo "═══ ⑤ 确认新代码就位 ═══"
if ! sudo -n grep -q "llmVisionEnableThinking" "$APP/lib/config.mjs"; then
  echo "  !! config.mjs 未含 llmVisionEnableThinking —— 回滚"
  for f in $FILES; do sudo -n cp -a "$APP/.bak-$TS/$(basename "$f")" "$APP/$f"; done
  exit 1
fi
if ! sudo -n grep -q "enable_thinking" "$APP/lib/llm.mjs"; then
  echo "  !! llm.mjs 未含 enable_thinking —— 回滚"
  for f in $FILES; do sudo -n cp -a "$APP/.bak-$TS/$(basename "$f")" "$APP/$f"; done
  exit 1
fi
echo "  OK 两处新代码均已就位"

echo
echo "═══ ⑥ 重启网关 ═══"
sudo -n systemctl restart dbee-gateway
sleep 3
sudo -n systemctl is-active dbee-gateway || true

echo
echo "═══ ⑦ healthz 探活（失败自动回滚）═══"
HZ=$(curl -sS -m 10 -o /tmp/hz-llmfix.txt -w '%{http_code}' http://127.0.0.1:8080/.cloud/healthz || echo 000)
echo "  healthz -> HTTP $HZ"
head -c 300 /tmp/hz-llmfix.txt 2>/dev/null; echo
if [ "$HZ" != "200" ]; then
  echo "  !! 网关未起来 —— 回滚代码并重启"
  for f in $FILES; do sudo -n cp -a "$APP/.bak-$TS/$(basename "$f")" "$APP/$f"; done
  sudo -n systemctl restart dbee-gateway
  sleep 3
  echo "  回滚后 healthz -> HTTP $(curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/.cloud/healthz || echo 000)"
  sudo -n journalctl -u dbee-gateway --since "2 minutes ago" --no-pager | tail -20
  exit 1
fi

echo
echo "═══ ⑧ 断言 gateway.env 未被改动 ═══"
ENV_AFTER=$(sudo -n sha256sum "$ENV_FILE" | cut -c1-16)
echo "  env sha256(after)  = $ENV_AFTER"
if [ "$ENV_BEFORE" = "$ENV_AFTER" ]; then
  echo "  OK 一致 —— IDENT_PEPPER / JWT_SECRET / SMTP / SMS 全部原样保留"
else
  echo "  !! 不一致！env 被改动了，请立即检查 $ENV_FILE"
  exit 1
fi

echo
echo "═══ ⑨ 启动日志（确认无报错）═══"
sudo -n journalctl -u dbee-gateway --since "1 minutes ago" --no-pager | tail -12
echo
echo "DEPLOY_OK 备份在 $APP/.bak-$TS/（回滚：sudo cp -a 回去再 restart）"
"""


def load_env() -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(ENV_PATH):
        return out
    with open(ENV_PATH, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def main() -> int:
    # ⓪ 本地语法校验
    print("═══ ⓪ 本地语法校验 ═══")
    for f in FILES:
        p = os.path.join(LOCAL_DIR, *f.split("/"))
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  [x] {f} 语法错误:\n{r.stderr}")
            return 1
        print(f"  OK {f}")

    env = load_env()
    host = env.get("DBEE_HOST") or ""
    user = env.get("USER") or "ubuntu"
    pwd = env.get("SSH_PWD") or ""
    if not host or not pwd:
        print("[x] .env 缺 DBEE_HOST / USER / SSH_PWD")
        return 2

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n连接 {user}@{host} ...")
    cli.connect(host, username=user, password=pwd, timeout=25,
                banner_timeout=25, auth_timeout=25)
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    # 上传（SFTP，文本文件 LF 归一）
    print("\n═══ 上传两个文件到 ~/dbee-llmfix/ ═══")
    _, so, _ = cli.exec_command("mkdir -p ~/dbee-llmfix/lib && rm -f ~/dbee-llmfix/lib/*.mjs")
    so.channel.recv_exit_status()
    sftp = cli.open_sftp()
    for f in FILES:
        local = os.path.join(LOCAL_DIR, *f.split("/"))
        remote = f"~/dbee-llmfix/{f}"
        with open(local, encoding="utf-8") as fh:
            data = fh.read().replace("\r\n", "\n")
        with sftp.open(remote, "w") as out:
            out.write(data)
        print(f"  OK {f} ({len(data)} chars)")
    sftp.close()

    # 执行远端安装脚本（stdin 喂给 bash，不落盘）
    print("\n═══ 执行远端部署 ═══")
    _, so, se = cli.exec_command("bash -s", timeout=120)
    so.channel.sendall(REMOTE_SCRIPT.encode())
    so.channel.shutdown_write()
    out = so.read().decode("utf-8", "replace")
    err = se.read().decode("utf-8", "replace")
    print(out)
    if err.strip():
        print("[stderr]", err.strip()[:500])
    rc = so.channel.recv_exit_status()
    cli.close()

    if rc == 0 and "DEPLOY_OK" in out:
        print("✅ 部署成功：生产已关闭视觉请求的深度思考")
        print("   验证方式：拍照识别一单，journalctl -u dbee-gateway 里 [llm] 行应出现")
        print("   『耗时=xxxms』且 reasoning_tokens 归零/大幅下降。")
        return 0
    print(f"[x] 部署失败 rc={rc}（脚本已自动回滚，网关应保持旧版本可用）")
    return 1


if __name__ == "__main__":
    sys.exit(main())
