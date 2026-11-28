"""只替换生产网关的 apppay.mjs，修正支付宝 orderStr 的空格编码。

不跑 deploy-gateway.sh，不改 gateway.env。
"""
from __future__ import annotations

import hashlib
import os
import sys
import time

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = os.path.join(REPO, "server", "lib", "apppay.mjs")
REMOTE = "/opt/dbee-gateway/lib/apppay.mjs"
ENV_FILE = "/etc/dbee/gateway.env"
APPLY = "--apply" in sys.argv


def arg_value(flag: str) -> str:
    if flag not in sys.argv:
        return ""
    i = sys.argv.index(flag)
    if i + 1 >= len(sys.argv):
        return ""
    return sys.argv[i + 1]


def load_dotenv(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()


def main() -> int:
    src = arg_value("--from")
    if not src or not os.path.isfile(src) or not os.path.isfile(LOCAL):
        print("[x] 缺少凭据文件或本地 apppay.mjs")
        return 2
    body = open(LOCAL, encoding="utf-8").read()
    if "export function alipayEncode" not in body or "includeSignType: true" not in body:
        print("[x] 本地 apppay.mjs 没有订单串修复")
        return 2
    digest = sha256_file(LOCAL)
    dot = load_dotenv(src)
    host = dot.get("DBEE_HOST", "")
    user = dot.get("DBEE_SSH_USER") or "ubuntu"
    pwd = dot.get("SSH_PWD", "")
    if not host or not pwd:
        print("[x] 缺连接信息")
        return 2

    print("═══ ⓪ 本地 ═══")
    print(f"  模式 = {'APPLY' if APPLY else 'DRY-RUN'}")
    print(f"  apppay.mjs sha256={digest[:16]} bytes={os.path.getsize(LOCAL)}")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    except Exception as e:
        print(f"[x] SSH 连接失败：{type(e).__name__}")
        return 1

    def sh(cmd: str, timeout: int = 60) -> tuple[int, str, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        return o.channel.recv_exit_status(), o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")

    try:
        rc, out, err = sh(f"sudo -n sha256sum {ENV_FILE} {REMOTE}")
        print(out.strip())
        env_before = ""
        for line in out.splitlines():
            if ENV_FILE in line:
                env_before = line.split()[0]
        if len(env_before) != 64:
            print("[x] 读不到 gateway.env 指纹，中止")
            return 3
        if not APPLY:
            print("DRY-RUN 结束，生产文件未改。")
            return 0

        ts = time.strftime("%Y%m%d-%H%M%S")
        bak = f"/opt/dbee-gateway/.bak-apppay-orderstr-{ts}"
        rc, home, _ = sh("echo $HOME")
        home = home.strip()
        stage = f"{home}/dbee-apppay-orderstr"
        sh(f"rm -rf '{stage}' && mkdir -p '{stage}' && chmod 700 '{stage}'")
        sftp = cli.open_sftp()
        sftp.put(LOCAL, f"{stage}/apppay.mjs")
        sftp.close()
        rc, out, err = sh(f"sha256sum '{stage}/apppay.mjs'")
        if digest not in out:
            print("[x] 上传后摘要不符，生产未改")
            sh(f"rm -rf '{stage}'")
            return 3

        print("═══ 安装 ═══")
        rc, out, err = sh(
            f"sudo -n install -d -m 0750 -o root -g dbee {bak} && "
            f"sudo -n cp -a {REMOTE} {bak}/apppay.mjs && "
            f"sudo -n install -m 0644 -o root -g dbee '{stage}/apppay.mjs' {REMOTE} && "
            f"sudo -n sha256sum {REMOTE} {ENV_FILE}"
        )
        if rc != 0 or digest not in out:
            print("[x] 安装失败")
            print(err[:200])
            sh(f"rm -rf '{stage}'")
            return 3
        env_after = ""
        for line in out.splitlines():
            if ENV_FILE in line:
                env_after = line.split()[0]
        if env_after != env_before:
            print("[x] gateway.env 指纹变了，回滚")
            sh(f"sudo -n cp -a {bak}/apppay.mjs {REMOTE}")
            sh(f"rm -rf '{stage}'")
            return 3
        print("  文件已替换，gateway.env 未变")

        print("═══ 重启 ═══")
        sh("sudo -n systemctl restart dbee-gateway && sleep 8", timeout=120)
        hz = ""
        for attempt in range(1, 4):
            _rc, hz, _err = sh(
                "curl -sS -m 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/.cloud/healthz || echo 000",
                timeout=40,
            )
            print(f"  healthz 第 {attempt} 次 {hz.strip()}")
            if hz.strip() == "200":
                break
            sh("sleep 8")
        if hz.strip() != "200":
            print("[x] 网关没起来，回滚")
            sh(f"sudo -n cp -a {bak}/apppay.mjs {REMOTE}")
            sh("sudo -n systemctl restart dbee-gateway && sleep 8", timeout=120)
            sh(f"rm -rf '{stage}'")
            return 1
        rc, out, _ = sh("sudo -n grep -c alipayEncode /opt/dbee-gateway/lib/apppay.mjs")
        print(f"  alipayEncode 命中 {out.strip()}")
        sh(f"rm -rf '{stage}'")
        print(f"备份在 {bak}/apppay.mjs")
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
