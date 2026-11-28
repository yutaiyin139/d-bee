"""本地驱动：把 0056（Apple 幂等键匿名化）应用到生产，并跑生产事务内行为探针。

═══ 为什么需要这个脚本（以及为什么不用 Docker）═══════════════════════════
0056 修的是 P1 资损：0045 的 delete_own_account() 把 apple_transactions 一并
DELETE，而该表 transaction_id UNIQUE 是全服 IAP 核销的唯一幂等键 → 删号即释放
幂等键 → 旧收据可对新账号重放核销终身会员（成本 0，可无限重复）。

「重放被拒」是**运行时行为**，静态读代码/护栏文本断言都证明不了（plpgsql 函数体
延迟解析），必须在一个真实 PG 上调用函数才能证。四条路里只有一条走得通：

  A. 本机 Docker 起 postgres:17   → ❌ wsl.exe 被本机安全策略列入程序黑名单，
                                       Docker Desktop(WSL2 后端)守护进程起不来，
                                       com.docker.service=Stopped、无命名管道。
  B. embedded-postgres 本地二进制 → ❌ PG 18.7 ≠ 生产 17.11，有版本偏差；且该环境
                                       在本机真实文件系统中不存在（沙箱视图差异），
                                       实测无法复现 → 结论不可信。
  C. 本机装原生 PG                → ❌ 无 psql/pg_ctl/postgres，Program Files 无 PG。
  D. 生产 PG 17.11 上跑单事务探针 → ✅ 版本零偏差，就是本脚本。

═══════════════════════════════════════════════════════════════════════════
安全性（本脚本自身不做任何数据库写操作，全部断言在服务器端脚本里）：
  · 凭据只从项目根 .env 读取，绝不打印、绝不写进任何上传文件。
  · 上传的两个文件都不含密钥（只有 DDL 与脚本源码），LF 化 + 权限 644。
  · 服务器端探针全程一个 BEGIN…ROLLBACK 事务，正常路径下一行都不落库；
    合成数据一律 TEST-0056- 前缀，绝不碰审核账户 dbeesupport@163.com、
    绝不碰任何 19 位数字形态的真实 owner_id；另有 trap 兜底按前缀清理。
  · 绝不碰 /opt/dbee-gateway（IDENT_PEPPER 地雷）：0056 只 CREATE OR REPLACE
    两个 DB 函数，签名与返回结构未变 → 不 restart 服务、不 reload nginx、
    不需要 JWT_SECRET。
  · 应用前有专用备份：pg_dump -Fc + pg_restore --list 验 TOC ≥100 项，
    验不过直接 FATAL 退出（没验过 TOC 的备份不算备份）。
  · 可重复运行：0056 已登记 applied 时走幂等分支，仍完整跑断言与探针。

用法（在项目根执行）：
    python tools/apply-apple-txn-anonymize-prod.py            # 备份 → 应用 → 验收
    python tools/apply-apple-txn-anonymize-prod.py --check    # 🔴 只读预检，不备份不应用

退出码：0 = 全部断言通过；1 = 有失败项；2 = 前置条件不满足（未连数据库）。
"""
import os
import re
import sys

import paramiko

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SQL_NAME = "0056-apple-txn-anonymize.sql"
SH_NAME = "server-apply-0056.sh"
REMOTE_DIR = "/tmp/dbee-mig"


def arg_value(flag):
    if flag not in sys.argv:
        return ""
    i = sys.argv.index(flag)
    if i + 1 >= len(sys.argv):
        return ""
    return sys.argv[i + 1]


def load_env():
    env = {}
    path = arg_value("--from") or os.path.join(ROOT, ".env")
    if not os.path.isfile(path):
        return env
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.strip())
            if m:
                env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env


def redact(text):
    """兜底过滤：万一将来有人误加 echo，这里拦掉明显的凭据形态。"""
    text = re.sub(r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}",
                  "<jwt-redacted>", text)
    text = re.sub(r"wbpk_[A-Za-z0-9_]{10,}", "<access-key-redacted>", text)
    text = re.sub(r"\b[0-9a-f]{32}\b", "<32hex-redacted>", text)
    return text


def main():
    check_only = "--check" in sys.argv[1:]

    env = load_env()
    host = env.get("DBEE_HOST") or env.get("IP")
    user = env.get("DBEE_SSH_USER") or env.get("USER") or "ubuntu"
    pwd = env.get("SSH_PWD")
    if not (host and user and pwd):
        print("✗ .env 缺 DBEE_HOST/USER/SSH_PWD，无法连接生产")
        return 2

    sql_path = os.path.join(ROOT, "db", "migrations", SQL_NAME)
    sh_path = os.path.join(ROOT, "tools", SH_NAME)
    for p in (sql_path, sh_path):
        if not os.path.isfile(p):
            print(f"✗ 缺文件 {p}")
            return 2

    # 上传内容统一 LF（服务器端脚本会用 grep -qU $'\r' 拒绝 CRLF）
    payloads = {}
    for name, path in ((SQL_NAME, sql_path), (SH_NAME, sh_path)):
        with open(path, "rb") as f:
            data = f.read().replace(b"\r\n", b"\n")
        if b"\r" in data:
            print(f"✗ {name} 含 CR 字符，拒绝上传")
            return 2
        payloads[name] = data

    print("· 目标：生产库 dbee")
    print(f"· 上传：{SQL_NAME}（{len(payloads[SQL_NAME])} B）、"
          f"{SH_NAME}（{len(payloads[SH_NAME])} B）")
    if check_only:
        print("· 模式：--check 只读预检（不备份、不应用、不写库）")
    else:
        print("· 模式：备份 → 应用 0056 → 结构/权限断言 → 事务内探针 → 回滚复查")
    print()

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(host, username=user, password=pwd, timeout=30,
                banner_timeout=30, auth_timeout=30)
    try:
        # 🔴 目录必须 755、文件必须 644：服务器端脚本里的 psql 以 postgres 身份执行
        # （sudo -n -u postgres），若沿用 700/600 的 ubuntu 属主权限，postgres 读不到
        # /tmp/dbee-mig/0056-*.sql → 应用必然失败（0045 首轮踩过这个坑）。
        _, out, _ = cli.exec_command(
            f"mkdir -p {REMOTE_DIR} && chmod 755 {REMOTE_DIR} && echo ok", timeout=30)
        if out.read().decode().strip() != "ok":
            print(f"✗ 无法创建 {REMOTE_DIR}")
            return 2

        sftp = cli.open_sftp()
        for name, data in payloads.items():
            remote = f"{REMOTE_DIR}/{name}"
            with sftp.open(remote, "wb") as fh:
                fh.write(data)
            sftp.chmod(remote, 0o644)
        sftp.close()
        print("✓ 已上传（LF，权限 644）\n")

        if check_only:
            # 只读预检：验证连通性、psql/sudo 可用、生产 PG 版本、0056 当前登记状态。
            # 全部是 SELECT / 查系统目录，不做任何写操作。
            cmd = (
                "cd " + REMOTE_DIR + " && "
                "echo '── 只读预检 ──' && "
                "echo -n 'PG 版本: ' && sudo -n -u postgres psql -d dbee -tA "
                "-c \"SELECT version();\" 2>&1 | head -1 && "
                "echo -n '0056 登记状态: ' && sudo -n -u postgres psql -d dbee -tA "
                "-c \"SELECT coalesce(status,'<未登记>') FROM public.schema_migrations "
                "WHERE version='0056';\" 2>&1 | head -1 && "
                "echo -n '备份目录可写: ' && (sudo -n mkdir -p /var/backups/dbee && echo yes || echo NO) && "
                "echo -n '当前函数是否已含匿名化: ' && sudo -n -u postgres psql -d dbee -tA "
                "-c \"SELECT (strpos(pg_get_functiondef('public.delete_own_account(text)'::regprocedure),"
                "'anon:')>0)::int;\" 2>&1 | head -1 && "
                "echo -n 'healthz: ' && curl -sS --max-time 15 https://d-bee.cn/.cloud/healthz 2>&1 | head -c 120"
            )
        else:
            cmd = f"cd {REMOTE_DIR} && MIG_DIR={REMOTE_DIR} bash {SH_NAME}"

        _, out, err = cli.exec_command(cmd, timeout=600)
        text = out.read().decode("utf-8", errors="replace")
        etext = err.read().decode("utf-8", errors="replace")
        code = out.channel.recv_exit_status()

        print(redact(text).strip())
        if etext.strip():
            print("\n[stderr 摘要]", redact(etext).strip()[:600])
        print(f"\n远端退出码: {code}")

        if check_only:
            return 0 if code == 0 else 1

        if code == 0 and "FAIL=0" in text:
            print("✅ 0056 生产应用 + 事务内实测全部通过")
            print("   ⚠️ 覆盖范围见 server-apply-0056.sh 文件头「❌ 它没有验证」节：")
            print("      不含真实 Apple 收据链路、不含 PostgREST/JWT 传输链路、不测并发。")
            return 0
        print("❌ 0056 未全部通过（见上方 ✗ 行）")
        print("   排查顺序：① 备份是否生成且 TOC≥100 ② 应用阶段是否报错 "
              "③ 探针事务是否正常 ROLLBACK ④ ⑦ 段行数是否与基线一致")
        return 1
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
