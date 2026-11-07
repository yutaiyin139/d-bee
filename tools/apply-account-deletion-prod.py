"""本地驱动：把 0045 真删号迁移应用到生产，并跑生产端到端验收。

用法（在项目根执行）：
    python tools/apply-account-deletion-prod.py

纪律：
  · 凭据只从项目根 .env 读取，绝不打印、绝不写进任何上传文件。
  · 服务器上的 JWT_SECRET / WB_PUBLISHABLE_KEY 由 node 在服务器本机读取，
    写进 chmod 600 的临时文件，shell 读完立刻删除（见 server-apply-0045.sh）。
  · 绝不碰 /opt/dbee-gateway（IDENT_PEPPER 地雷），不 restart 服务、不 reload nginx。
  · 可重复运行：0045 已登记 applied 时走幂等分支，仍会完整跑一遍端到端验收。
  · 本脚本只上传 + 执行 + 汇总，全部断言都在服务器端脚本里。
"""
import os
import re
import sys
import paramiko

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env():
    env = {}
    with open(os.path.join(ROOT, ".env"), encoding="utf-8", errors="ignore") as f:
        for line in f:
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.strip())
            if m:
                env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env


def main():
    env = load_env()
    host = env.get("DBEE_HOST") or env.get("IP")
    user = env.get("USER")
    pwd = env.get("SSH_PWD")
    if not (host and user and pwd):
        print("✗ .env 缺 DBEE_HOST/USER/SSH_PWD")
        return 2

    sql_path = os.path.join(ROOT, "db", "migrations", "0045-account-deletion.sql")
    sh_path = os.path.join(ROOT, "tools", "server-apply-0045.sh")
    for p in (sql_path, sh_path):
        if not os.path.isfile(p):
            print(f"✗ 缺文件 {p}")
            return 2

    # 上传内容统一 LF（服务器端脚本会用 grep -qU $'\r' 拒绝 CRLF）
    payloads = {}
    for name, path in (("0045-account-deletion.sql", sql_path), ("server-apply-0045.sh", sh_path)):
        with open(path, "rb") as f:
            data = f.read().replace(b"\r\n", b"\n")
        payloads[name] = data
        if b"\r" in data:
            print(f"✗ {name} 含 CR 字符，拒绝上传")
            return 2

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(host, username=user, password=pwd, timeout=30)
    try:
        # 🔴 目录必须 755、SQL 必须 644：服务器端脚本里的 psql 是以 postgres 身份
        # 执行的（sudo -n -u postgres），若沿用 700/600 的 ubuntu 属主权限，
        # postgres 读不到 /tmp/dbee-mig/0045-*.sql → 应用必然失败。
        _, out, _ = cli.exec_command("mkdir -p /tmp/dbee-mig && chmod 755 /tmp/dbee-mig && echo ok", timeout=30)
        if out.read().decode().strip() != "ok":
            print("✗ 无法创建 /tmp/dbee-mig")
            return 2

        sftp = cli.open_sftp()
        for name, data in payloads.items():
            remote = f"/tmp/dbee-mig/{name}"
            with sftp.open(remote, "wb") as fh:
                fh.write(data)
            # 两个上传文件都不含任何密钥（只有 DDL 与脚本源码）；.cred 才是 600
            sftp.chmod(remote, 0o644)
        sftp.close()
        print("✓ 已上传 0045 SQL + 服务器端验收脚本（LF，权限 644）\n")

        cmd = "cd /tmp/dbee-mig && bash server-apply-0045.sh"
        _, out, err = cli.exec_command(cmd, timeout=420)
        text = out.read().decode("utf-8", errors="replace")
        etext = err.read().decode("utf-8", errors="replace")
        code = out.channel.recv_exit_status()
        # 🔴 只打印脚本自己的输出；脚本设计上不回显任何凭据。
        # 万一将来有人误加了 echo $TOKEN，这里兜底过滤明显的 JWT / publishableKey 形态。
        text = re.sub(r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}", "<jwt-redacted>", text)
        text = re.sub(r"wbpk_[A-Za-z0-9_]{10,}", "<access-key-redacted>", text)
        print(text.strip())
        if etext.strip():
            print("\n[stderr 摘要]", etext.strip()[:400])
        print(f"\n远端退出码: {code}")
        if code == 0 and "FAIL=0" in text:
            print("✅ 0045 生产应用 + 实测全部通过")
            return 0
        print("❌ 0045 未全部通过（见上方 ✗ 行）")
        return 1
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
