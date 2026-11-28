"""发布「微信账号绑定手机号」。

只做两件事：
  · 执行 db/migrations/0060-bind-wechat-phone.sql
  · 替换 /opt/dbee-gateway/lib/{identity,auth,app}.mjs 并重启网关

不跑 deploy-gateway.sh，不改 gateway.env，不上传小程序，不打开售卖开关。

用法：
  python deploy/apply-0060-bind-phone.py --from <本地.env> --apply
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_NAME = "0060-bind-wechat-phone.sql"
SQL_LOCAL = os.path.join(REPO, "db", "migrations", SQL_NAME)
LIB_LOCAL = os.path.join(REPO, "server", "lib")
LIB_REMOTE = "/opt/dbee-gateway/lib"
FILES = ("identity.mjs", "auth.mjs", "app.mjs")
ENV_FILE = "/etc/dbee/gateway.env"
APPLY = "--apply" in sys.argv

MARKERS = {
    "identity.mjs": "findAccountForIdent",
    "auth.mjs": "async bindPhone",
    "app.mjs": "/bind-phone",
}


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
    src = arg_value("--from") or os.path.join(REPO, ".env")
    if not os.path.isfile(src) or not os.path.isfile(SQL_LOCAL):
        print("[x] 缺少凭据文件或迁移")
        return 2
    digests: dict[str, str] = {}
    for name in FILES:
        path = os.path.join(LIB_LOCAL, name)
        body = open(path, encoding="utf-8").read()
        if MARKERS[name] not in body:
            print(f"[x] {name} 缺少绑定手机号代码")
            return 2
        check = subprocess.run(
            ["node", "--check", path],
            capture_output=True,
            text=True,
        )
        if check.returncode != 0:
            print(f"[x] {name} 语法检查失败")
            err = (check.stderr or "").strip().splitlines()
            if err:
                print(err[-1][:200])
            return 2
        digests[name] = sha256_file(path)

    dot = load_dotenv(src)
    host = (dot.get("IP") or dot.get("DBEE_HOST") or "").strip()
    user = (dot.get("USER") or dot.get("DBEE_SSH_USER") or "ubuntu").strip()
    if user == "dbee_app":
        user = "ubuntu"
    pwd = (dot.get("SSH_PWD") or "").strip()
    if not host or not pwd:
        print("[x] 凭据文件缺主机或 SSH_PWD")
        return 2

    print("═══ ⓪ 本地 ═══")
    print(f"  模式 = {'APPLY' if APPLY else 'DRY-RUN'}")
    print(f"  SQL = {SQL_NAME}")
    for name in FILES:
        print(f"  {name} sha256={digests[name][:16]}")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    except Exception as e:
        print(f"[x] SSH 连接失败：{type(e).__name__}")
        return 1

    def sh(cmd: str, timeout: int = 90) -> tuple[int, str, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        return o.channel.recv_exit_status(), o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")

    try:
        rc, env_before, _ = sh(f"sudo -n sha256sum {ENV_FILE}")
        env_before = env_before.split()[0] if env_before.split() else ""
        if rc != 0 or len(env_before) != 64:
            print("[x] 读不到 gateway.env 指纹，中止")
            return 3
        if not APPLY:
            print("DRY-RUN 结束，生产未改。")
            return 0

        print("═══ ① 迁移 ═══")
        remote_dir = "/tmp/dbee-mig-0060"
        sh(f"rm -rf '{remote_dir}' && mkdir -p '{remote_dir}' && chmod 700 '{remote_dir}'")
        sftp = cli.open_sftp()
        sftp.put(SQL_LOCAL, f"{remote_dir}/{SQL_NAME}")
        sftp.close()
        rc, out, err = sh(
            f"sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -f - < '{remote_dir}/{SQL_NAME}'"
        )
        if rc != 0:
            print("[x] 迁移失败，网关文件未改")
            tail = (err or out).strip().splitlines()
            if tail:
                print(tail[-1][:240])
            sh(f"rm -rf '{remote_dir}'")
            return 3
        rc, out, err = sh(
            "sudo -n -u postgres psql -d dbee -v ON_ERROR_STOP=1 -tA <<'SQL'\n"
            "SELECT 'MIG=' || count(*) FROM schema_migrations WHERE version = '0060';\n"
            "SELECT 'COLS=' || count(*) FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='app_users' "
            "AND column_name IN ('bound_phone_hash','bound_phone_masked');\n"
            "SELECT 'AUTH_EXEC=' || has_function_privilege('authenticated', "
            "'public.bind_wechat_phone(text,text,text)', 'EXECUTE');\n"
            "SELECT 'APP_EXEC=' || has_function_privilege('dbee_app', "
            "'public.bind_wechat_phone(text,text,text)', 'EXECUTE');\n"
            "SQL"
        )
        print(out.strip())
        if err.strip():
            print(err.strip().splitlines()[-1][:200])
        text = out
        if "MIG=1" not in text or "COLS=2" not in text or "AUTH_EXEC=f" not in text or "APP_EXEC=t" not in text:
            print("[x] 迁移验收未通过，网关文件未改")
            sh(f"rm -rf '{remote_dir}'")
            return 3
        sh(f"rm -rf '{remote_dir}'")

        print("═══ ② 网关文件 ═══")
        ts = time.strftime("%Y%m%d-%H%M%S")
        bak = f"/opt/dbee-gateway/.bak-bind-phone-{ts}"
        rc, home, _ = sh("echo $HOME")
        home = home.strip() or "/home/ubuntu"
        stage = f"{home}/dbee-bind-phone"
        sh(f"rm -rf '{stage}' && mkdir -p '{stage}' && chmod 700 '{stage}'")
        sftp = cli.open_sftp()
        for name in FILES:
            sftp.put(os.path.join(LIB_LOCAL, name), f"{stage}/{name}")
        sftp.close()
        rc, out, _ = sh("sha256sum " + " ".join(f"'{stage}/{name}'" for name in FILES))
        for name in FILES:
            if digests[name] not in out:
                print(f"[x] {name} 上传摘要不符，生产未改")
                sh(f"rm -rf '{stage}'")
                return 3

        install = (
            f"sudo -n install -d -m 0750 -o root -g dbee {bak} && "
            + " && ".join(
                f"sudo -n cp -a {LIB_REMOTE}/{name} {bak}/{name}" for name in FILES
            )
            + " && "
            + " && ".join(
                f"sudo -n install -m 0644 -o root -g dbee '{stage}/{name}' {LIB_REMOTE}/{name}"
                for name in FILES
            )
        )
        rc, out, err = sh(install)
        if rc != 0:
            print("[x] 安装失败，尝试从备份还原")
            print((err or out).strip().splitlines()[-1][:200] if (err or out).strip() else "")
            sh(
                " && ".join(
                    f"sudo -n cp -a {bak}/{name} {LIB_REMOTE}/{name}" for name in FILES
                )
            )
            sh(f"rm -rf '{stage}'")
            return 3
        rc, env_after, _ = sh(f"sudo -n sha256sum {ENV_FILE}")
        env_after = env_after.split()[0] if env_after.split() else ""
        if env_after != env_before:
            print("[x] gateway.env 指纹变了，还原网关文件")
            sh(
                " && ".join(
                    f"sudo -n cp -a {bak}/{name} {LIB_REMOTE}/{name}" for name in FILES
                )
            )
            sh(f"rm -rf '{stage}'")
            return 3

        print("═══ ③ 重启 ═══")
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
            print("[x] 网关没起来，回滚三个文件")
            sh(
                " && ".join(
                    f"sudo -n cp -a {bak}/{name} {LIB_REMOTE}/{name}" for name in FILES
                )
            )
            sh("sudo -n systemctl restart dbee-gateway && sleep 8", timeout=120)
            sh(f"rm -rf '{stage}'")
            return 1

        _rc, code, _ = sh(
            "curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "
            "http://127.0.0.1:8080/.cloud/auth/v1/bind-phone "
            "-H 'content-type: application/json' -d '{}'"
        )
        print(f"  未带密钥的绑定接口 {code.strip()}")
        if code.strip() != "401":
            print("[x] 绑定接口没有按预期拒绝，回滚")
            sh(
                " && ".join(
                    f"sudo -n cp -a {bak}/{name} {LIB_REMOTE}/{name}" for name in FILES
                )
            )
            sh("sudo -n systemctl restart dbee-gateway && sleep 8", timeout=120)
            sh(f"rm -rf '{stage}'")
            return 1
        rc, env_final, _ = sh(f"sudo -n sha256sum {ENV_FILE}")
        env_final = env_final.split()[0] if env_final.split() else ""
        if env_final != env_before:
            print("[x] 重启后 gateway.env 指纹变了")
            return 3
        sh(f"rm -rf '{stage}'")
        print(f"完成。备份在 {bak}/")
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
